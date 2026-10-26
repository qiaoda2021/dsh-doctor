/** One Host operation shared by the tool and command. Raw plan content stays in memory. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, relative, join, sep, isAbsolute } from 'node:path'
import { describePlanExecution } from './plan-status.js'

const PREPARED_TTL = 15 * 60 * 1000
const ACTIVE_WINDOW = 10 * 60 * 1000
const hash = (value) => createHash('sha256').update(value).digest('hex')
const idOf = (plan) => String(plan?.planId ?? plan?.id ?? '')
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }

/** Deliberately never include changes.content, JSON patches, env text, or secret samples. */
export function publicPlan(plan, executability = {}) {
  const id = idOf(plan)
  const state = describePlanExecution(plan, executability)
  return {
    id, title: String(plan?.title ?? id), risk: plan?.risk ?? 'high',
    ...state,
    executable: state.executionState === 'executable',
    prepared: plan?.meta?.prepared === true,
    restartRequired: plan?.meta?.restartRequired === true,
    changes: (Array.isArray(plan?.changes) ? plan.changes : []).filter((change) => change && typeof change === 'object').map((change) => ({
      operation: change.operation ?? change.kind, path: change.path ?? change.target,
      summary: change.summary ?? change.description,
      bytes: change.content === undefined ? undefined : Buffer.byteLength(typeof change.content === 'string' ? change.content : JSON.stringify(change.content)),
    })),
    coverage: plan?.coverage,
    deferred: Array.isArray(plan?.deferred) ? plan.deferred.length : undefined,
    previewCommand: `/doctor repair preview ${id}`,
    applyCommand: `/doctor repair apply ${id} --yes`,
  }
}

function previewText(plan, exec) {
  const safe = publicPlan(plan, exec)
  const lines = [`计划 ${safe.id} · ${safe.title} · 风险 ${safe.risk}`, `执行状态：${safe.executionLabel}`, `可执行：${safe.executable ? '是' : '否'}${safe.blockedReasons.length ? `（${safe.blockedReasons.join('；')}）` : ''}`]
  for (const change of safe.changes) lines.push(`· [${change.operation}] ${change.path ?? '(未指定)'}${change.bytes === undefined ? '' : ` · ${change.bytes} B（正文隐藏）`}`)
  if (safe.coverage) lines.push(`扫描覆盖：${JSON.stringify(safe.coverage)}`)
  if (safe.deferred) lines.push(`活动文件延后：${safe.deferred} 个；延后不等于已清理`)
  if (safe.restartRequired) lines.push('配置写入后，下次启动生效；当前进程的网络状态尚未验证。')
  lines.push(`预览：${safe.previewCommand}`)
  if (safe.executable) lines.push(`确认执行：${safe.applyCommand}`)
  else if (safe.executionState === 'read-only') lines.push('本计划只有核对建议，没有文件执行动作。')
  return lines.join('\n')
}

async function guardedDirectory(home, dir, create = false) {
  const root = resolve(home)
  const target = resolve(dir)
  if (!inside(root, target)) throw new Error('审计路径超出 home')
  let cursor = root
  for (const part of ['', ...relative(root, target).split(sep).filter(Boolean)]) {
    if (part) cursor = join(cursor, part)
    try { const stat = await lstat(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('审计目录含链接或非目录') }
    catch (error) { if (error.code !== 'ENOENT') throw error; if (!create) return false; await mkdir(cursor, { mode: 0o700 }) }
  }
  return true
}

export function createRepairController({ refresh, runtime, loadModule, now = Date.now }) {
  const cache = new Map()
  let queue = Promise.resolve()
  let executor
  function remember(plan) {
    const id = idOf(plan)
    if (!id) throw new Error('修复计划缺少 id')
    if (!cache.has(id) || plan?.meta?.prepared === true) cache.set(id, { plan, at: now() })
    while (cache.size > 40) cache.delete(cache.keys().next().value)
    return plan
  }
  async function modules() {
    const mod = await loadModule('repair-exec')
    if (!mod) throw new Error('修复执行模块缺失')
    executor = mod
    return mod
  }
  function executable(mod, plan) {
    if (plan?.meta?.kind === 'secret-cleanup') {
      const hasChanges = Array.isArray(plan.changes) && plan.changes.length > 0
      const completeNoop = Array.isArray(plan.changes) && !hasChanges && plan.coverage?.complete === true && !(plan.deferred?.length > 0)
      return { executable: hasChanges, reasons: hasChanges || completeNoop ? [] : ['没有可处理文件（请检查覆盖报告与活动延后）'] }
    }
    try { const out = mod.summarizePlan(plan, runtime()); return { executable: out.executable === true, reasons: out.blockedReasons ?? [] } }
    catch { return { executable: false, reasons: ['计划格式校验失败'] } }
  }
  async function records(options) {
    const dir = join(options.home, 'doctor', 'cleanup-records')
    if (!await guardedDirectory(options.home, dir)) return []
    const rows = []
    for (const name of (await readdir(dir)).filter((name) => /^cleanup-[a-f0-9-]+\.json$/.test(name)).slice(-100)) {
      const path = join(dir, name)
      if ((await lstat(path)).isSymbolicLink()) continue
      try { const row = JSON.parse(await readFile(path, 'utf8')); if (`${row.recordId}.json` === name) rows.push(row) } catch { /* corrupt record is not executable */ }
    }
    return rows.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))
  }
  async function saveRecord(record, options, replace = false) {
    const dir = join(options.home, 'doctor', 'cleanup-records')
    await guardedDirectory(options.home, dir, true)
    const path = join(dir, `${record.recordId}.json`)
    if (replace) { const st = await lstat(path); if (st.isSymbolicLink() || !st.isFile()) throw new Error('审计文件类型异常') }
    await writeFile(path, JSON.stringify(record, null, 2), { flag: replace ? 'w' : 'wx', mode: 0o600 })
  }

  async function operation(action = 'list', args = {}) {
    const options = runtime()
    const mod = await modules()
    if (action === 'prepare') {
      let plan
      if (args.kind === 'secret-cleanup') {
        const cleaner = await loadModule('repair-secrets')
        if (!cleaner?.planCleanup) throw new Error('日志清理模块缺失')
        plan = await cleaner.planCleanup({ ...options, activeWindowMs: ACTIVE_WINDOW })
        const id = `plan-cleanup-${hash(JSON.stringify({ changes: plan.changes, coverage: plan.coverage, deferred: plan.deferred })).slice(0, 12)}`
        plan = { ...plan, id, planId: id, meta: { prepared: true, kind: 'secret-cleanup', activeWindowMs: ACTIVE_WINDOW } }
      } else {
        const config = await loadModule('config-repair')
        if (!config) throw new Error('配置修复模块缺失')
        if (args.kind === 'proxy-env') plan = await config.prepareProxyPlan({ ...options, proxyUrl: args.proxyUrl })
        else if (args.kind === 'strip-bom') plan = await config.prepareBomPlan({ ...options, target: args.target })
        else throw new Error('prepare.kind 可用 proxy-env / strip-bom / secret-cleanup')
      }
      remember(plan)
      const exec = executable(mod, plan)
      return { action, status: 'prepared', plan: publicPlan(plan, exec), text: `计划已准备，尚未修改文件。\n${previewText(plan, exec)}` }
    }
    if (action === 'history') {
      const rows = [...await mod.listExecutions(options), ...await records(options)].sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt))).slice(0, 10)
      return { action, records: rows, text: rows.length ? rows.map((r) => `· ${r.recordId} — ${r.status} · ${r.planId}`).join('\n') : '还没有执行记录。' }
    }
    if (action === 'rollback') {
      const id = String(args.recordId ?? '')
      if (!id || args.confirm !== id) return { action, status: 'refused', text: '回滚尚未确认：confirm 须与 recordId 完全一致。' }
      const special = (await records(options)).find((r) => r.recordId === id)
      if (special) {
        if (special.status === 'restored') return { action, status: 'restored', text: `回滚 ${id} 已完成，无需重复操作。` }
        if (special.home !== resolve(options.home)) throw new Error('执行记录不属于当前 home')
        const cleaner = await loadModule('repair-secrets')
        const result = await cleaner.rollbackFrom(special.backupRoot, { ...options, activeWindowMs: ACTIVE_WINDOW })
        const failed = result.complete !== true || Boolean(result.error) || result.files?.some((f) => !f.restored)
        special.status = failed ? 'failed' : 'restored'
        special.finishedAt = new Date(now()).toISOString()
        await saveRecord(special, options, true)
        const active = (result.files ?? []).filter((file) => file.skipped === 'active-session').length
        const changed = (result.files ?? []).filter((file) => file.skipped === 'changed-since-write').length
        const detail = [
          `回滚 ${id}：${special.status} · 已还原 ${result.restored ?? 0} 个文件；备份含原始凭据，仅保留本地。`,
          active ? `活动窗口保护：${active} 个文件最近10分钟有写入（含本次清理）；本次保留这些文件，待空闲后重试。` : '',
          changed ? `写后内容已变化：${changed} 个文件保留当前内容，不覆盖后续写入。` : '',
          result.error ? `回滚预检：${result.error}` : '',
        ].filter(Boolean).join('\n')
        return { action, status: special.status, rollback: result, text: detail }
      }
      const record = (await mod.listExecutions(options)).find((r) => r.recordId === id)
      if (!record) return { action, status: 'refused', text: '找不到执行记录。' }
      const result = await mod.rollbackExecution(record, { ...options, confirmToken: id })
      // The executor returns per-file ok/performed, not a status field.
      const status = result.files?.some((file) => file.ok === false) ? 'failed' : result.files?.length ? 'restored' : 'noop'
      return { action, status, rollback: result, text: `回滚 ${id}：${status}${result.detail ? ` — ${result.detail}` : ''}` }
    }
    const report = await refresh({ force: args.force === true })
    for (const plan of report?.plans ?? []) remember(plan)
    if (action === 'list') {
      const plans = [...cache.values()].filter(({ plan, at }) => !plan?.meta?.prepared || now() - at < PREPARED_TTL).map(({ plan }) => publicPlan(plan, executable(mod, plan)))
      return { action, plans: plans.map((p) => p.id), summaries: plans, text: [plans.length ? '修复计划（草案与已准备计划分开标记）：' : '当前没有修复计划。', ...plans.map((p) => `· ${p.id} — ${p.title} · ${p.prepared ? '已准备' : '草案'} · ${p.executionLabel}${p.blockedReasons.length ? `：${p.blockedReasons.join('；')}` : ''}`), '准备真实动作：action=prepare + kind=proxy-env（传 proxyUrl）/ strip-bom（传 target）/ secret-cleanup；prepare 只读。'].join('\n') }
    }
    const entry = cache.get(String(args.planId ?? ''))
    if (!entry) return { action, status: 'refused', text: '找不到计划；先 list 或 prepare。' }
    const { plan, at } = entry
    const exec = executable(mod, plan)
    if (action === 'preview') return { action, plan: publicPlan(plan, exec), text: previewText(plan, exec) }
    if (action !== 'apply') return { action, status: 'refused', text: '未知操作，可用 list / prepare / preview / apply / rollback / history。' }
    const id = idOf(plan)
    if (!id || args.confirm !== id) return { action, status: 'refused', text: `执行尚未确认：confirm 须等于 ${id}。\n${previewText(plan, exec)}` }
    if (plan?.meta?.prepared && now() - at >= PREPARED_TTL) return { action, status: 'refused', text: '准备计划已超过15分钟，请重新 prepare 并确认新计划。' }
    if (!exec.executable) return { action, status: 'refused', text: previewText(plan, exec) }
    if (plan?.meta?.kind === 'secret-cleanup') {
      const cleaner = await loadModule('repair-secrets')
      // Persist a receipt BEFORE any user data is rewritten; audit failures must stop the operation.
      const receipt = { recordId: `cleanup-${randomUUID()}`, planId: id, home: resolve(options.home), backupRoot: plan.backupRoot, status: 'started', finishedAt: new Date(now()).toISOString() }
      await saveRecord(receipt, options)
      const result = await cleaner.applyCleanup(plan, { ...options, activeWindowMs: ACTIVE_WINDOW, confirm: true })
      const paths = (result.results ?? []).filter((r) => !r.skipped).map((r) => r.path)
      const verification = await cleaner.verifyClean({ ...options, paths })
      const partial = (result.results ?? []).some((r) => r.error || r.skipped || r.rolledBack) || plan.deferred?.length > 0 || plan.coverage?.complete === false || verification.complete !== true || result.verification?.complete !== true
      receipt.status = verification.remaining > 0 ? 'failed' : partial ? 'partial' : result.applied ? 'applied' : 'noop'
      receipt.backupRoot = result.backupRoot
      receipt.finishedAt = new Date(now()).toISOString()
      receipt.coverage = plan.coverage
      receipt.verification = { remaining: verification.remaining, checked: verification.checked, complete: verification.complete !== false }
      await saveRecord(receipt, options, true)
      cache.delete(id)
      return { action, status: receipt.status, record: receipt, text: `执行 ${receipt.recordId}：${receipt.status} · 写入 ${result.wrote ?? 0} 个文件 · 延后 ${plan.deferred?.length ?? 0} 个\n复检：检查 ${verification.checked ?? 0} 个，剩余 ${verification.remaining ?? 0} 处；覆盖${partial ? '未完整，不代表全部清净' : '完整'}。\n备份：${receipt.backupRoot}（含原始凭据，仅本地保留）` }
    }
    if (plan?.meta?.prepared) {
      const config = await loadModule('config-repair')
      const check = await config.validatePreparedPlan(plan, options)
      if (!check.ok) return { action, status: 'refused', text: `计划已经失效：${check.reasons.join('；')}；请重新 prepare。` }
    }
    const record = await mod.executePlan(plan, { ...options, confirmToken: id })
    if (record.status === 'applied') cache.delete(id)
    const text = [`执行 ${record.recordId} · ${record.status} · 计划 ${id}`, `备份：${record.backup?.dir ?? '无'}`, `复检：${record.verification?.status ?? '未执行'}`, ...((record.verification?.checks ?? []).map((c) => `· [${c.status}] ${c.id ?? ''} ${c.detail ?? ''}`))]
    if (record.rollback) text.push(`回滚：${record.rollback.performed ? '已执行' : record.rollback.available ? '可用' : '无'}`)
    if (plan?.meta?.restartRequired) text.push('仅验证磁盘配置；下次启动生效，未验证当前进程网络。')
    return { action, status: record.status, record, text: text.join('\n') }
  }

  // The tool and the command share this queue; an in-flight write cannot race a rollback.
  function run(action, args = {}) {
    const next = queue.then(() => operation(action, args)).then((result) => JSON.parse(JSON.stringify(result)))
    queue = next.catch(() => {})
    return next
  }
  function snapshotPlans(plans = []) {
    for (const plan of plans) remember(plan)
    return [...cache.values()]
      .filter(({ plan, at }) => !plan?.meta?.prepared || now() - at < PREPARED_TTL)
      .map(({ plan }) => publicPlan(plan, executor ? executable(executor, plan) : { checked: false, reasons: ['请先在对话里预览校验'] }))
  }
  return { run, snapshotPlans }
}
