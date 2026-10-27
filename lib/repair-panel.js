/**
 * Owner-only repair panel transport.
 *
 * Why this file exists: the panel side of the repair loop is the only place a browser can ask
 * the Host to *write*. Everything here is therefore built around one fence and one receipt:
 *
 *   1. Connection owns Host/Origin verification and credential signature (`connection.admit`).
 *      This module adds no second authentication scheme and no anonymous or standalone Web route.
 *   2. Admission alone is not enough: an independent API peer is also "authenticated", so the
 *      panel additionally requires `admission.peer.id === connection.browserPeer.id`.
 *   3. A same-origin fetch is not enough: a custom fixed header (`x-dsh-doctor-ui: 1`) plus a
 *      JSON content type means a cross-site form or `<img>`/`<script>` style request cannot reach
 *      the handler. The origin *scheme* is deliberately not pinned to http(s) — the Desktop
 *      `dsh-app` shell issues same-origin requests from a non-http origin.
 *   4. A click is not an authorization: only a `prepared && executable` plan gets a one-use,
 *      owner-bound, plan-bound token (32 random bytes, 5 min). The token is consumed
 *      synchronously before the first `await`, so a double click, a replay, an expired token, a
 *      replayed preview token or a plan that changed since preview all end with zero writes.
 *   5. Rollback shares one status gate with the Agent consent wrapper: `started` (the audit
 *      receipt written *before* any user data is touched), `noop`, `restored` and any unknown
 *      status get no token and never reach the executor. The gate is imported from
 *      `repair-consent.js` (single source) and it is evaluated twice — when the token is
 *      issued and again on the freshly read history after the token is consumed.
 *
 * Raw material never crosses back into the browser: `changes.content`, full config text, raw
 * execution records and stacks are filtered here, and every failure is a fixed sentence.
 */

import { createHash, randomBytes } from 'node:crypto'

import { ROLLBACKABLE_STATUSES } from './repair-consent.js'
import { describeRepairOutcome } from './repair-outcome.js'

export const REPAIR_PANEL_PATH = '/api/dsh-doctor/repair'

const MAX_BODY_BYTES = 16 * 1024
const TOKEN_TTL_MS = 5 * 60 * 1000
const MAX_TOKENS = 40
const MAX_TEXT = 2000
const MAX_CHANGES = 40

const ACTIONS = Object.freeze(['list', 'prepare', 'preview', 'apply', 'history', 'rollback-preview', 'rollback'])

/** Exactly the client-supplied fields each action may carry; anything else is rejected. */
const FIELDS = Object.freeze({
  list: Object.freeze([]),
  prepare: Object.freeze(['offerId', 'proxyUrl']),
  preview: Object.freeze(['planId']),
  apply: Object.freeze(['planId', 'confirmationToken']),
  history: Object.freeze([]),
  'rollback-preview': Object.freeze(['recordId']),
  rollback: Object.freeze(['recordId', 'confirmationToken']),
})

const KINDS = Object.freeze(['proxy-env', 'strip-bom', 'secret-cleanup', 'plugin-enable'])

/** Fixed wording only: no stack, no path, no raw error message ever reaches the browser. */
const ERROR = Object.freeze({
  method: '只接受 POST 请求。',
  aborted: '请求已取消。',
  unauthenticated: '请求未通过浏览器认证。',
  notOwner: '只有本机浏览器所有者可以操作修复面板。',
  notUi: '缺少修复面板请求头。',
  notJson: '请求体必须是 application/json。',
  tooLarge: '请求体超过 16KiB 上限。',
  badBody: '请求体读取失败。',
  badJson: '请求体不是合法 JSON 对象。',
  unknownAction: '未知的修复面板动作。',
  extraField: '请求包含未支持的字段。',
  badOffer: '修复项不受支持。',
  badProxyUrl: '代理地址无效，需形如 http://127.0.0.1:PORT。',
  badPlan: '缺少计划 id。',
  badRecord: '缺少执行记录 id。',
  tokenMissing: '缺少一次性确认令牌，请先预览。',
  tokenMismatch: '确认令牌与当前操作不匹配。',
  tokenExpired: '确认令牌已过期，请重新预览。',
  noPlan: '找不到该修复计划，请重新列出或准备。',
  noRecord: '找不到该执行记录。',
  planChanged: '计划已变化，请重新预览后再确认。',
  recordChanged: '执行记录已变化，请重新预览回滚。',
  notExecutable: '该计划当前不可执行。',
  alreadyRestored: '该记录已回滚，无需重复操作。',
  notRollbackable: '该执行记录当前没有可回滚的写入，无需回滚。',
  refused: '操作未执行，文件未修改。',
  failed: '修复面板操作失败，请稍后重试。',
  // 刷新失败只说「回执已结束、数据是旧的、去核对记录」，绝不宣称写或没写：
  // failed/noop 的记录可能一笔都没落盘，applied 的记录可能已经落盘。
  refreshStale: '请求已结束，但结果刷新失败：请重新取数并核对执行记录，不要凭这条回执判断文件是否已改动。',
})

/**
 * 只有这些终态算成功。`failed` 与任何未知状态都不是成功：旧版 `ok: status !== 'refused'`
 * 会把 `status:"failed"` 的写结果报成 `ok:true`，读 `body.ok` 的调用方会被反向解读。
 * `status` 原样透传，UI 仍按 status 上色（client 的 repairTone 只看 status），分类不变。
 */
const OK_STATUSES = Object.freeze(['applied', 'restored', 'partial', 'noop'])

const RESPONSE_HEADERS = Object.freeze({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })

const headerOf = (headers, name) => {
  if (typeof headers?.get === 'function') return headers.get(name) ?? undefined
  if (headers && typeof headers === 'object') {
    const value = headers[name] ?? headers[name.toLowerCase()]
    return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

const trimText = (value, max) => (typeof value === 'string' ? value.replace(/\u0000/g, '').slice(0, max) : undefined)
const wholeNumber = (value) => (Number.isInteger(value) ? value : undefined)

const digest = (parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex')

/** Controller text is the only free-form string allowed out; drop stack frames and cap length. */
function safeText(value) {
  if (typeof value !== 'string') return undefined
  const lines = value
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s+\S+\s+\(?.*:\d+:\d+/.test(line))
    .filter((line) => !/\b(?:stack|trace)\b\s*:/i.test(line))
  const text = lines.join('\n').replace(/\u0000/g, '').trim().slice(0, MAX_TEXT)
  return text || undefined
}

function publicCoverage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  for (const [key, item] of Object.entries(value).slice(0, 12)) {
    if (typeof item === 'boolean' || typeof item === 'number') out[key] = item
    else if (typeof item === 'string') out[key] = trimText(item, 200)
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Whitelisted plan view. `changes.content`, JSON patches and prepared file bodies are dropped:
 * the browser only needs to know which file, which operation and how many bytes — never the text.
 */
function publicPlan(plan) {
  if (!plan || typeof plan !== 'object') return undefined
  const id = trimText(plan.id, 120) || trimText(plan.planId, 120)
  if (!id) return undefined
  const changes = (Array.isArray(plan.changes) ? plan.changes : [])
    .filter((change) => change && typeof change === 'object')
    .slice(0, MAX_CHANGES)
    .map((change) => {
      const bytes = change.content === undefined
        ? undefined
        : Buffer.byteLength(typeof change.content === 'string' ? change.content : JSON.stringify(change.content))
      return {
        operation: trimText(change.operation ?? change.kind, 40),
        path: trimText(change.path ?? change.target, 260),
        summary: trimText(change.summary ?? change.description, 240),
        bytes: wholeNumber(change.bytes) ?? wholeNumber(bytes),
      }
    })
  const blocked = (Array.isArray(plan.blockedReasons) ? plan.blockedReasons : [])
    .map((reason) => trimText(String(reason), 200))
    .filter(Boolean)
    .slice(0, 8)
  return {
    id,
    title: trimText(plan.title, 200) || id,
    risk: trimText(plan.risk, 40),
    executionState: trimText(plan.executionState, 60),
    executionLabel: trimText(plan.executionLabel, 120),
    executable: plan.executable === true,
    prepared: plan.prepared === true || plan?.meta?.prepared === true,
    restartRequired: plan.restartRequired === true || plan?.meta?.restartRequired === true,
    blockedReasons: blocked,
    changes,
    coverage: publicCoverage(plan.coverage),
    deferred: Array.isArray(plan.deferred) ? plan.deferred.length : wholeNumber(plan.deferred),
    refusal: trimText(plan.refusal, 200),
  }
}

/** Whitelisted execution-record view: no `home`, no `coverage` object, no raw result rows. */
function publicRecord(record) {
  if (!record || typeof record !== 'object') return undefined
  const recordId = trimText(record.recordId, 120)
  if (!recordId) return undefined
  const backupDir = trimText(record.backup?.dir ?? record.backupRoot, 260)
  const verification = record.verification && typeof record.verification === 'object'
    ? {
        status: trimText(record.verification.status, 40),
        checked: wholeNumber(record.verification.checked),
        remaining: wholeNumber(record.verification.remaining),
        complete: typeof record.verification.complete === 'boolean' ? record.verification.complete : undefined,
        browser: record.verification.browser === 'unknown' ? 'unknown' : undefined,
      }
    : undefined
  // 只暴露一个布尔：UI 需要知道「这条记录已经回滚过」，但 `detail`（含备份路径）、
  // `available`（内部可达性）与备份文件表都不出浏览器。`performed:true` 只用来提示，
  // **不能**据此把一条可能只回滚了一部分的记录改写成 `status:'restored'`：
  // 记录状态的历史语义属于执行器（lib/repair-exec.js），面板只读不写。
  const rollback = record.rollback && typeof record.rollback === 'object' && !Array.isArray(record.rollback)
    ? { performed: record.rollback.performed === true }
    : undefined
  const safe = {
    recordId,
    application: ['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(record.application) ? record.application : undefined,
    restartRequired: typeof record.restartRequired === 'boolean' ? record.restartRequired : undefined,
    planId: trimText(record.planId, 120),
    status: trimText(record.status, 40),
    kind: trimText(record.kind, 40),
    finishedAt: trimText(record.finishedAt, 40),
    backup: backupDir ? { dir: backupDir } : undefined,
    verification: verification && Object.values(verification).some((item) => item !== undefined) ? verification : undefined,
    rollback,
  }
  return { ...safe, presentation: describeRepairOutcome({ status: safe.status, record: safe }) }
}

/**
 * 回滚状态门。与 Agent 侧 consent 用**同一份** `ROLLBACKABLE_STATUSES`（从
 * `repair-consent.js` 导入），所以两条边的判定不可能漂移：
 *
 *   - `applied` / `partial` / `failed`：可能写过用户文件 → 允许取令牌、允许问人；
 *   - `restored`：已完成回滚 → 固定 no-op 文案，不发票；
 *   - `started`（写入前的审计回执）/ `noop` / 任何未知状态：没有可回滚的写入 → 不发票、不调执行器。
 */
function rollbackGate(record) {
  const status = typeof record?.status === 'string' ? record.status : ''
  if (status === 'restored') return ERROR.alreadyRestored
  if (!ROLLBACKABLE_STATUSES.includes(status)) return ERROR.notRollbackable
  return undefined
}

/** A token is valid only for the exact view the user confirmed; any visible drift invalidates it. */
function planFingerprint(plan) {
  return digest([
    'plan',
    plan.id,
    plan.title ?? '',
    plan.risk ?? '',
    plan.executionState ?? '',
    String(plan.executable),
    String(plan.prepared),
    String(plan.restartRequired),
    (plan.blockedReasons ?? []).join(';'),
    (plan.changes ?? []).map((change) => `${change.operation ?? ''}|${change.path ?? ''}|${change.bytes ?? ''}`).join(';'),
    String(plan.deferred ?? ''),
  ]).slice(0, 32)
}

function recordFingerprint(record) {
  return digest(['record', JSON.stringify(record)]).slice(0, 32)
}

/**
 * Register the repair panel on Connection's authenticated Fetch fence.
 * Returns a disposer (clears live tokens first), or `undefined` when the host cannot offer the
 * owner fence — failing closed beats half- authenticated write access.
 */
export function registerRepairPanel(connection, options = {}) {
  const {
    runRepair,
    getActions,
    onChanged,
    now = Date.now,
    randomToken = () => randomBytes(32).toString('hex'),
  } = options ?? {}

  if (typeof connection?.fetch?.register !== 'function') return undefined
  if (typeof connection.admit !== 'function' || !connection.browserPeer) return undefined
  if (typeof runRepair !== 'function') throw new TypeError('修复面板需要 runRepair')
  if (typeof getActions !== 'function') throw new TypeError('修复面板需要 getActions')

  /** token -> { owner, action, id, fingerprint, expiresAt }. Process-local, never persisted. */
  const tokens = new Map()

  function revoke(owner, action, id) {
    for (const [token, entry] of tokens) {
      if (entry.owner === owner && entry.action === action && entry.id === id) tokens.delete(token)
    }
  }

  function issue(owner, action, id, fingerprint) {
    // Issuing a new token for the same visible plan retires the previous one: one live receipt.
    revoke(owner, action, id)
    while (tokens.size >= MAX_TOKENS) {
      const oldest = tokens.keys().next().value
      if (oldest === undefined) break
      tokens.delete(oldest)
    }
    const token = String(randomToken())
    const expiresAt = Number(now()) + TOKEN_TTL_MS
    tokens.set(token, { owner, action, id, fingerprint, expiresAt })
    return { token, expiresAt: new Date(expiresAt).toISOString(), action, id }
  }

  /**
   * Single-use claim. Deletion happens synchronously, before any `await`, so two concurrent
   * clicks can never both turn into a write; a mismatch still burns the token.
   */
  function consume(token, owner, action, id) {
    const entry = tokens.get(token)
    if (!entry) return { error: ERROR.tokenMissing }
    tokens.delete(token)
    if (entry.owner !== owner || entry.action !== action || entry.id !== id) return { error: ERROR.tokenMismatch }
    if (Number(now()) > entry.expiresAt) return { error: ERROR.tokenExpired }
    return { entry }
  }

  const reply = (status, body) => Response.json(body, { status, headers: RESPONSE_HEADERS })
  const refused = (action, error, extra) => reply(200, { action, ok: false, status: 'refused', error, ...(extra ?? {}) })

  async function offers() {
    const list = await getActions()
    const rows = Array.isArray(list) ? list : Array.isArray(list?.actions) ? list.actions : []
    return rows.filter((row) => row && typeof row === 'object')
  }

  async function findRecord(recordId) {
    const result = await runRepair('history', {})
    const rows = Array.isArray(result?.records) ? result.records : []
    return rows.find((row) => String(row?.recordId ?? '') === recordId)
  }

  /**
   * Shared tail of apply/rollback. `onChanged` runs only after a real mutation attempt.
   *
   * `changed` is deliberately conservative: anything but `refused` may have touched user files
   * (`failed` can fail after a partial write), so it is a hint, never a certainty. When the
   * refresh itself fails we say exactly that — the request ended, the panel data is stale, go
   * read the records — and never claim that a `failed`/`noop` run wrote (or did not write) files.
   */
  async function finishMutation(action, result) {
    const status = typeof result?.status === 'string' ? result.status : 'refused'
    const changed = status !== 'refused'
    let refreshFailed = false
    if (changed && typeof onChanged === 'function') {
      try {
        await onChanged()
      } catch {
        refreshFailed = true
      }
    }
    const text = [
      safeText(result?.text),
      refreshFailed ? ERROR.refreshStale : undefined,
    ].filter(Boolean).join('\n')
    return reply(200, {
      action,
      // `failed` and unknown statuses are not success; the status string itself is passed
      // through untouched so the UI keeps colouring by status exactly as before.
      ok: OK_STATUSES.includes(status),
      status,
      changed,
      record: publicRecord(result?.record),
      presentation: describeRepairOutcome({ ...result, status, refreshFailed }),
      text: text || undefined,
      refreshFailed: changed ? refreshFailed : undefined,
      error: status === 'refused' ? ERROR.refused : undefined,
    })
  }

  function planPayload(action, result, owner) {
    const plan = publicPlan(result?.plan)
    const text = safeText(result?.text)
    if (!plan) return refused(action, ERROR.noPlan, { text })
    const rejected = result?.status === 'refused'
    const status = typeof result?.status === 'string' ? result.status : plan.prepared ? 'prepared' : 'draft'
    // Only a prepared *and* executable plan is worth a receipt; everything else stays a preview.
    const canApply = !rejected && plan.prepared === true && plan.executable === true
    const confirmation = canApply ? issue(owner, 'apply', plan.id, planFingerprint(plan)) : undefined
    return reply(200, { action, ok: true, status, plan, text, canApply, confirmation })
  }

  async function readBody(request) {
    const raw = await request.text()
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { tooLarge: true }
    if (!raw.trim()) return { error: ERROR.badJson }
    try {
      return { body: JSON.parse(raw) }
    } catch {
      return { error: ERROR.badJson }
    }
  }

  async function handle(request) {
    // Defense in depth: real Connection dispatch filters methods first, so an authenticated GET
    // falls through to 404 and never reaches this branch.
    if (request?.method !== 'POST') return reply(405, { ok: false, error: ERROR.method })
    if (request.signal?.aborted) return reply(499, { ok: false, error: ERROR.aborted })

    const headers = request.headers
    // Connection keeps its Host/Origin boundary; the owner fence below is the panel's addition.
    let admission
    try {
      admission = connection.admit({ headers })
    } catch {
      return reply(401, { ok: false, error: ERROR.unauthenticated })
    }
    if (!admission || admission.rejection) {
      return reply(admission?.rejection === 403 ? 403 : 401, { ok: false, error: ERROR.unauthenticated })
    }
    const owner = connection.browserPeer?.id
    if (typeof owner !== 'string' || !owner || admission.peer?.id !== owner) {
      // An independent API peer is authenticated but is not the browser owner.
      return reply(403, { ok: false, error: ERROR.notOwner })
    }
    if (String(headerOf(headers, 'x-dsh-doctor-ui') ?? '') !== '1') return reply(403, { ok: false, error: ERROR.notUi })
    if (!/^application\/json\b/i.test(String(headerOf(headers, 'content-type') ?? ''))) {
      return reply(415, { ok: false, error: ERROR.notJson })
    }
    const declared = Number(headerOf(headers, 'content-length'))
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return reply(413, { ok: false, error: ERROR.tooLarge })

    let parsed
    try {
      parsed = await readBody(request)
    } catch {
      return reply(400, { ok: false, error: ERROR.badBody })
    }
    if (parsed.tooLarge) return reply(413, { ok: false, error: ERROR.tooLarge })
    if (parsed.error) return reply(400, { ok: false, error: parsed.error })

    const body = parsed.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { ok: false, error: ERROR.badJson })
    const action = body.action
    if (typeof action !== 'string' || !ACTIONS.includes(action)) return reply(400, { ok: false, error: ERROR.unknownAction })
    // Strict field whitelist: `confirm`, `approved`, `userConfirmed` and friends are never
    // read as authorization, and an unknown field is a protocol error rather than a hint.
    const allowed = FIELDS[action]
    if (Object.keys(body).some((key) => key !== 'action' && !allowed.includes(key))) {
      return reply(400, { ok: false, error: ERROR.extraField })
    }

    try {
      if (action === 'list') {
        const result = await runRepair('list', {})
        const rows = Array.isArray(result?.summaries) ? result.summaries : Array.isArray(result?.plans) ? result.plans : []
        const plans = rows.map(publicPlan).filter(Boolean)
        return reply(200, { action, ok: true, plans, text: safeText(result?.text) })
      }

      if (action === 'history') {
        const result = await runRepair('history', {})
        const rows = Array.isArray(result?.records) ? result.records : []
        return reply(200, { action, ok: true, records: rows.map(publicRecord).filter(Boolean), text: safeText(result?.text) })
      }

      if (action === 'prepare') {
        const offerId = typeof body.offerId === 'string' ? body.offerId.trim() : ''
        if (!offerId || offerId.length > 120) return reply(400, { action, ok: false, error: ERROR.badOffer })
        const offer = (await offers()).find((row) => String(row.id) === offerId)
        const kind = offer?.prepareArgs?.kind
        if (!offer || !KINDS.includes(kind)) return reply(400, { action, ok: false, error: ERROR.badOffer })
        // kind and target come from the trusted offer only; a client-supplied target is never read.
        const args = { kind }
        if (kind === 'strip-bom' || kind === 'plugin-enable') {
          const target = typeof offer.prepareArgs?.target === 'string' ? offer.prepareArgs.target : ''
          if (!target) return reply(400, { action, ok: false, error: ERROR.badOffer })
          args.target = target
        }
        if (body.proxyUrl !== undefined) {
          if (kind !== 'proxy-env') return reply(400, { action, ok: false, error: ERROR.extraField })
          const proxyUrl = typeof body.proxyUrl === 'string' ? body.proxyUrl.trim() : ''
          if (!/^https?:\/\/\S+$/i.test(proxyUrl) || proxyUrl.length > 2048) {
            return reply(400, { action, ok: false, error: ERROR.badProxyUrl })
          }
          args.proxyUrl = proxyUrl
        } else if (kind === 'proxy-env') {
          return reply(400, { action, ok: false, error: ERROR.badProxyUrl })
        }
        return planPayload(action, await runRepair('prepare', args), owner)
      }

      if (action === 'preview') {
        const planId = typeof body.planId === 'string' ? body.planId.trim() : ''
        if (!planId) return reply(400, { action, ok: false, error: ERROR.badPlan })
        return planPayload(action, await runRepair('preview', { planId }), owner)
      }

      if (action === 'apply') {
        const planId = typeof body.planId === 'string' ? body.planId.trim() : ''
        if (!planId) return reply(400, { action, ok: false, error: ERROR.badPlan })
        const token = typeof body.confirmationToken === 'string' ? body.confirmationToken.trim() : ''
        if (!token) return refused(action, ERROR.tokenMissing)
        // Synchronous claim, before the first await: replay/double click cannot both proceed.
        const claim = consume(token, owner, 'apply', planId)
        if (claim.error) return refused(action, claim.error)
        const current = publicPlan((await runRepair('preview', { planId }))?.plan)
        if (!current) return refused(action, ERROR.noPlan)
        if (planFingerprint(current) !== claim.entry.fingerprint) return refused(action, ERROR.planChanged, { plan: current })
        if (current.prepared !== true || current.executable !== true) return refused(action, ERROR.notExecutable, { plan: current })
        // The existing controller re-checks the prepared files immediately before writing.
        return finishMutation(action, await runRepair('apply', { planId, confirm: planId }))
      }

      if (action === 'rollback-preview') {
        const recordId = typeof body.recordId === 'string' ? body.recordId.trim() : ''
        if (!recordId) return reply(400, { action, ok: false, error: ERROR.badRecord })
        const found = publicRecord(await findRecord(recordId))
        if (!found) return refused(action, ERROR.noRecord)
        // Gate #1 (issue time): the same whitelist the Agent-side consent wrapper refuses on.
        const blocked = rollbackGate(found)
        if (blocked) return refused(action, blocked, { record: found })
        const confirmation = issue(owner, 'rollback', found.recordId, recordFingerprint(found))
        return reply(200, { action, ok: true, record: found, confirmation })
      }

      // action === 'rollback'
      const recordId = typeof body.recordId === 'string' ? body.recordId.trim() : ''
      if (!recordId) return reply(400, { action, ok: false, error: ERROR.badRecord })
      const token = typeof body.confirmationToken === 'string' ? body.confirmationToken.trim() : ''
      if (!token) return refused(action, ERROR.tokenMissing)
      const claim = consume(token, owner, 'rollback', recordId)
      if (claim.error) return refused(action, claim.error)
      const found = publicRecord(await findRecord(recordId))
      if (!found) return refused(action, ERROR.noRecord)
      // Gate #2 (spend time): a token obtained while the record was `applied` must not survive a
      // re-read that now says `started` / `noop` / `restored` / anything unknown. Same predicate,
      // fresh history — a token is a receipt for one visible state, not a standing permission.
      const blocked = rollbackGate(found)
      if (blocked) return refused(action, blocked, { record: found })
      if (recordFingerprint(found) !== claim.entry.fingerprint) return refused(action, ERROR.recordChanged, { record: found })
      // Same single executor as the tool and command; the panel never writes by itself.
      return finishMutation(action, await runRepair('rollback', { recordId, confirm: recordId }))
    } catch {
      // No stack, no raw message: a fixed sentence and a 500 the client can retry.
      return reply(500, { action, ok: false, error: ERROR.failed })
    }
  }

  const disposer = connection.fetch.register({
    path: REPAIR_PANEL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handle,
  })

  return () => {
    tokens.clear()
    return typeof disposer === 'function' ? disposer() : undefined
  }
}
