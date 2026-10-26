/**
 * DSH Doctor · 修复动作的真实用户确认包装（Consent）
 *
 * 为什么还要单独一层：`repair-controller` 只认 `confirm === id`，那是「别忘了确认」的机器
 * 令牌，不是「有人同意」。Agent 可以在工具参数里自己把 confirm 填成 planId，所以 apply /
 * rollback 必须再过一道只由真实人回答的 ask。本模块是**纯注入包装**：不 import 任何 Runtime
 * 服务、不注册工具、不碰文件；`ask` 由 lead 在 index.js 接到 inspect 过的
 * `ctx.userQuestions.ask`，这条链与自动放行的工具审批策略独立。
 *
 * 纪律（每一条都有对应测试）：
 *   1. 只读动作（list / prepare / preview / history）原样转发，一次都不提问。
 *   2. 写动作（apply / rollback）先在本地核对 id 与 confirm 完全一致，再取真实公共预览；
 *      只有 apply 的 `prepared === true && executable === true`、rollback 的「有写入可回滚」
 *      （= 导出的 `ROLLBACKABLE_STATUSES` / `isRollbackableStatus`，面板复用同一份）
 *      才 ask。不可执行计划 / 已回滚记录 / 空动作一律不提问，也**绝不**调用写动作。
 *   3. 缺 ask、signal 已 abort、ask 返回非严格 `true`（含 'yes' / 1 / {} 这类「看着像同意」）、
 *      ask 抛异常、回答后才发现 abort —— 全部零写入。
 *   4. `args` 里的 `approved` / `userConfirmed` / `consent` / `ask: true` 之类一律不代表同意：
 *      读都不读，转发前删除，避免把「模型自述的授权」当成人话。
 *   5. 提问**不占** repair-controller 的写队列：先 preview（一次只读队列操作），释放后再 await
 *      ask，回答后才发写动作。否则面板取数与 ask 互等会死锁。等待期间计划变化由执行器重验
 *      （validatePreparedPlan + 底层 hash 校验），本包装不绕过、不缓存结论。
 *   6. 每次新的 apply / rollback 都重新真实提问，没有「本次会话已同意」的缓存。
 *   7. 传给 ask 的 preview 是**白名单摘要**：不含 `changes[].content`、不含 `meta`、不含原始
 *      执行记录里的备份路径/文件表，只保留人能核对的最小字段。
 *   8. 自身产出的结果只有固定 status（refused / cancelled / failed，另加 noop 透传）与固定
 *      中文文案；不回传未净化异常消息、不回传 stack、不回传 raw plan content。
 */

/** 模块自身版本，跟随契约变更；与插件 package.json 版本无关。 */
export const CONSENT_VERSION = '1.0.0'

/** 只读动作：原样转发，不提问。 */
export const READ_ONLY_ACTIONS = Object.freeze(['list', 'prepare', 'preview', 'history'])
/** 写动作：必须过真实用户确认。 */
export const CONSENT_ACTIONS = Object.freeze(['apply', 'rollback'])

/** 本包装自己产出的固定状态集合。`noop` 只用于「记录已完成回滚」的透传说明。 */
export const CONSENT_STATUSES = Object.freeze(['refused', 'cancelled', 'failed', 'noop'])

/**
 * 声称「已同意」的字段名（大小写不敏感）。它们从来不是授权，只是某些调用方顺手塞进来的
 * 自述；既不能代替问话，也不该原样带到执行器里。
 */
export const CONSENT_CLAIM_KEYS = Object.freeze([
  'approved', 'userapproved', 'userconfirmed', 'confirmed', 'consent', 'consented',
  'consenttoken', 'autoapprove', 'autoconfirmed', 'yes', 'always', 'skipconsent', 'assumeconsent',
])

/**
 * rollback 允许提问的记录状态：有写入（或写入失败）才值得回滚。
 *
 * 这是全仓**唯一**一份回滚状态白名单。面板传输层（`lib/repair-panel.js`）直接 import
 * 本常量与下面的谓词，不再自己维护第二份数组：两套门（面板发令牌 / 工具发提问）必须对
 * 同一个 status 给出同一个判定，否则 `started`（写入前的审计回执）会被面板当成可回滚。
 * `restored` 不在白名单里，它是「已完成回滚」，由调用方按 no-op 表达。
 */
export const ROLLBACKABLE_STATUSES = Object.freeze(['applied', 'partial', 'failed'])

/** 同一份白名单的谓词形式；consent 与面板都必须用这一个判断，不许另写数组或另写正则。 */
export const isRollbackableStatus = (status) => ROLLBACKABLE_STATUSES.includes(status)

/** 固定文案表，唯一真源；改一个字就是改契约，需要同步测试里的逐字断言。 */
const TEXT = {
  noExecutor: '修复执行器不可用，本次未执行。',
  unknownAction: (action) => `未识别的修复动作：${action || '(空)'}；本次未执行。`,
  missingPlanId: '缺少 planId：先 list 或 prepare 拿到计划 id，本次未执行。',
  missingRecordId: '缺少 recordId：先 history 拿到执行记录 id，本次未执行。',
  planConfirmMismatch: (id) => `执行尚未确认：apply 的 confirm 必须与 planId 完全一致（${id}），本次未执行。`,
  recordConfirmMismatch: (id) => `回滚尚未确认：rollback 的 confirm 必须与 recordId 完全一致（${id}），本次未执行。`,
  noAsk: (action, id) => `缺少确认通道：${action} ${id} 需要真实用户答复，本次未执行。`,
  aborted: (action, id) => `已取消：${action} ${id} 在本次确认前已被中止，未执行。`,
  previewFailed: '读取计划预览失败，本次未执行。',
  planMissing: (id) => `找不到计划 ${id} 的预览：先 list 或 prepare，本次未执行。`,
  planMismatch: '预览返回的计划与请求的 id 不一致，本次未执行。',
  planNotPrepared: (id) => `计划 ${id} 还不是已准备快照：先 prepare，本次未提问、未执行。`,
  planNotExecutable: (id, label, reasons) =>
    `计划 ${id} 未通过执行校验（${label || '不可执行'}）${reasons.length ? `：${reasons.join('；')}` : ''}；本次未提问、未执行。`,
  historyFailed: '读取执行记录失败，本次未执行。',
  recordMissing: (id) => `找不到执行记录 ${id}：先 history 确认，本次未执行。`,
  recordSettled: (id) => `执行记录 ${id} 已完成回滚，无需重复操作；本次未提问、未执行。`,
  recordNotRollbackable: (id, status) => `执行记录 ${id} 当前状态（${status || '未知'}）没有可回滚的写入；本次未提问、未执行。`,
  askFailed: (action, id) => `确认请求异常：${action} ${id} 未执行。`,
  declined: (action, id) => `已取消：用户未同意 ${action} ${id}，本次未执行。`,
  writeFailed: (action, id) => `修复动作失败：${action} ${id} 未完成。`,
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const textOf = (value) => (typeof value === 'string' ? value : '')
const isAbortError = (error) => String(error?.name ?? '') === 'AbortError'

function refuse(action, status, text) {
  return { action, status, text }
}

/**
 * 提问前把参数拷一份：等待期间调用方（或工具参数对象）被改，写动作也只能用这份快照。
 * 工具参数是纯 JSON，先按 JSON 深拷；极端情况（循环引用/含函数/getter 抛错）退回标量浅拷，
 * 决不让一次拷贝失败把请求变成「用可变引用执行」。
 */
function cloneArgs(args) {
  if (!isRecord(args)) return {}
  try {
    const cloned = JSON.parse(JSON.stringify(args))
    if (isRecord(cloned)) return cloned
  } catch { /* 落到标量浅拷 */ }
  const copy = {}
  for (const key of Object.keys(args)) {
    const value = args[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') copy[key] = value
  }
  return copy
}

/** 删掉「自称已同意」的字段：它们不构成授权，也不该被带到执行器。 */
function withoutConsentClaims(args) {
  const copy = { ...args }
  for (const key of Object.keys(copy)) {
    if (CONSENT_CLAIM_KEYS.includes(key.toLowerCase())) delete copy[key]
  }
  return copy
}

function stringsOf(value) {
  return (Array.isArray(value) ? value : []).filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
}

/** apply 的公共预览白名单：只要人能核对的字段，不要正文。 */
function publicPlanSummary(plan) {
  const changes = (Array.isArray(plan.changes) ? plan.changes : []).filter(isRecord).map((change) => ({
    operation: textOf(change.operation),
    path: textOf(change.path) || undefined,
    summary: textOf(change.summary) || undefined,
    bytes: typeof change.bytes === 'number' && Number.isFinite(change.bytes) ? change.bytes : undefined,
  }))
  return {
    id: textOf(plan.id),
    title: textOf(plan.title) || textOf(plan.id),
    risk: textOf(plan.risk) || 'high',
    executionState: textOf(plan.executionState),
    executionLabel: textOf(plan.executionLabel),
    executable: plan.executable === true,
    prepared: plan.prepared === true,
    restartRequired: plan.restartRequired === true,
    blockedReasons: stringsOf(plan.blockedReasons),
    changes,
  }
}

/** rollback 的记录摘要白名单：只留能对上「回滚哪一条」的标量，不带备份路径/文件表。 */
function publicRecordSummary(record) {
  return {
    recordId: textOf(record.recordId),
    planId: textOf(record.planId),
    status: textOf(record.status),
    title: textOf(record.title) || undefined,
    finishedAt: textOf(record.finishedAt) || undefined,
  }
}

async function askOnce(ask, action, id, preview, signal) {
  if (typeof ask !== 'function') return { ok: false, reason: 'missing' }
  try {
    // ask 等待期间不持有任何队列/锁：写动作在本函数返回之后才发。
    const answer = await ask({ action, id, preview, signal })
    return { ok: answer === true, reason: answer === true ? 'accepted' : 'declined', aborted: signal?.aborted === true }
  } catch (error) {
    return { ok: false, reason: isAbortError(error) ? 'aborted' : 'error' }
  }
}

async function applyWithConsent(runRepair, snapshot, signal, ask) {
  const action = 'apply'
  const planId = textOf(snapshot.planId)
  if (!planId) return refuse(action, 'refused', TEXT.missingPlanId)
  if (textOf(snapshot.confirm) !== planId) return refuse(action, 'refused', TEXT.planConfirmMismatch(planId))
  if (typeof ask !== 'function') return refuse(action, 'refused', TEXT.noAsk(action, planId))
  if (signal?.aborted === true) return refuse(action, 'cancelled', TEXT.aborted(action, planId))

  let preview
  try {
    preview = await runRepair('preview', { planId })
  } catch {
    return refuse(action, 'failed', TEXT.previewFailed)
  }
  const plan = isRecord(preview?.plan) ? preview.plan : undefined
  if (!plan) return refuse(action, 'refused', TEXT.planMissing(planId))
  const summary = publicPlanSummary(plan)
  if (summary.id !== planId) return refuse(action, 'refused', TEXT.planMismatch)
  if (summary.prepared !== true) return refuse(action, 'refused', TEXT.planNotPrepared(planId))
  if (summary.executable !== true) return refuse(action, 'refused', TEXT.planNotExecutable(planId, summary.executionLabel, summary.blockedReasons))

  const asked = await askOnce(ask, action, planId, summary, signal)
  if (asked.reason === 'missing') return refuse(action, 'refused', TEXT.noAsk(action, planId))
  if (asked.reason === 'error') return refuse(action, 'failed', TEXT.askFailed(action, planId))
  if (asked.reason === 'aborted') return refuse(action, 'cancelled', TEXT.aborted(action, planId))
  if (asked.ok !== true) return refuse(action, 'cancelled', TEXT.declined(action, planId))
  // 回答与 abort 可能同时到达：只要信号已 abort，就不许写。
  if (signal?.aborted === true) return refuse(action, 'cancelled', TEXT.aborted(action, planId))

  // 只认提问前的快照：等待期间的任何改动都进不来；confirm 仍是同一个动作 id。
  const writeArgs = { ...snapshot, planId, confirm: planId }
  try {
    return await runRepair('apply', writeArgs)
  } catch {
    return refuse(action, 'failed', TEXT.writeFailed(action, planId))
  }
}

async function rollbackWithConsent(runRepair, snapshot, signal, ask) {
  const action = 'rollback'
  const recordId = textOf(snapshot.recordId)
  if (!recordId) return refuse(action, 'refused', TEXT.missingRecordId)
  if (textOf(snapshot.confirm) !== recordId) return refuse(action, 'refused', TEXT.recordConfirmMismatch(recordId))
  if (typeof ask !== 'function') return refuse(action, 'refused', TEXT.noAsk(action, recordId))
  if (signal?.aborted === true) return refuse(action, 'cancelled', TEXT.aborted(action, recordId))

  let history
  try {
    history = await runRepair('history', {})
  } catch {
    return refuse(action, 'failed', TEXT.historyFailed)
  }
  const rows = Array.isArray(history?.records) ? history.records : []
  const record = rows.find((row) => isRecord(row) && textOf(row.recordId) === recordId)
  if (!record) return refuse(action, 'refused', TEXT.recordMissing(recordId))
  const summary = publicRecordSummary(record)
  const status = summary.status
  if (status === 'restored') return refuse(action, 'noop', TEXT.recordSettled(recordId))
  if (!isRollbackableStatus(status)) return refuse(action, 'refused', TEXT.recordNotRollbackable(recordId, status))

  const asked = await askOnce(ask, action, recordId, summary, signal)
  if (asked.reason === 'missing') return refuse(action, 'refused', TEXT.noAsk(action, recordId))
  if (asked.reason === 'error') return refuse(action, 'failed', TEXT.askFailed(action, recordId))
  if (asked.reason === 'aborted') return refuse(action, 'cancelled', TEXT.aborted(action, recordId))
  if (asked.ok !== true) return refuse(action, 'cancelled', TEXT.declined(action, recordId))
  if (signal?.aborted === true) return refuse(action, 'cancelled', TEXT.aborted(action, recordId))

  const writeArgs = { ...snapshot, recordId, confirm: recordId }
  try {
    return await runRepair('rollback', writeArgs)
  } catch {
    return refuse(action, 'failed', TEXT.writeFailed(action, recordId))
  }
}

/**
 * 真实用户确认包装。
 *
 * @param {(action: string, args: object) => Promise<any>} runRepair 已有的主控入口（repair-controller.run）
 * @param {string} action 六个动作之一：list / prepare / preview / history / apply / rollback
 * @param {object} args 工具参数（不信任其中的任何「已同意」字段）
 * @param {{ask?: (request: {action: string, id: string, preview: object, signal?: AbortSignal}) => Promise<unknown>, signal?: AbortSignal}} [options]
 *   `ask` 由 lead 接线到 `ctx.userQuestions.ask`（真实人答复）；只有严格 `true` 才算同意。
 * @returns {Promise<any>} 只读动作原样返回执行器结果；写动作返回执行器结果，或固定 refuse/cancel/fail 结果
 */
export async function runRepairWithConsent(runRepair, action, args, { ask, signal } = {}) {
  const name = textOf(action).trim()
  if (typeof runRepair !== 'function') return refuse(name, 'failed', TEXT.noExecutor)
  const request = isRecord(args) ? args : {}

  // 只读动作：原样转发（同一份参数、同一个执行器），一次都不提问。
  if (READ_ONLY_ACTIONS.includes(name)) return runRepair(name, request)
  if (!CONSENT_ACTIONS.includes(name)) return refuse(name, 'refused', TEXT.unknownAction(name))

  // 写动作：先按快照核对 id，再走提问；快照之后的任何改动都影响不到这次执行。
  const snapshot = withoutConsentClaims(cloneArgs(request))
  return name === 'apply'
    ? applyWithConsent(runRepair, snapshot, signal, ask)
    : rollbackWithConsent(runRepair, snapshot, signal, ask)
}
