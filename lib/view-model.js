/**
 * DSH Doctor · 面板视图模型（Host 侧）
 *
 * 面板 `lib/client.js` 是塞进页面里的单文件 React 组件：它不能 import 任何项目模块，
 * 只能读 Host 注入的一份 JSON 快照。所以「把报告整理成 5 个页面能直接渲染的数据」
 * 必须在这里算好 —— 本模块就是那一层。
 *
 * 约束（刻意的）：
 *   - 纯函数：零 I/O、零依赖、不读文件、不联网、不看 process.env。
 *   - 零第三方依赖，也不 import `node:` 内置（一个都不需要）。
 *   - 对垃圾输入（undefined / null / 字符串 / 数字 / 数组 / 缺字段的对象）**不抛异常**，
 *     一律返回结构完整的视图模型 —— 面板宁可显示「没有数据」，也不能白屏。
 *   - 字段名一律照抄源码字面值，不猜：见每条注释里的 `文件:行`。
 *
 * 为什么 import 的是 `./diag.js` 而不是 `./render.js`：
 *   分组中文名只有一份真源 —— `lib/diag.js` 的 `CATEGORY_LABELS`（lib/diag.js:37-47）。
 *   `lib/render.js` 自己也是 `import { CATEGORY_LABELS } from './diag.js'`（lib/render.js:8），
 *   但它没有把这个映射再导出（只导出 statusIcon/statusLabel/summaryLine/worstCheck/
 *   renderMarkdown/renderJson）。所以这里直接 import 同一个真源，而不是抄一份中文字面量。
 *   本文件**没有**第二份分组中文名。
 *
 * 状态词表归一（重要）：
 *   报告里 `results[].status` 的真实取值是 `'pass' | 'issue' | 'unknown'`
 *   （lib/diag.js:26、lib/diag.js:33-34），不是面板契约里的 ok/warn/fail。
 *   面板契约要的是 `'ok'|'warn'|'fail'|'unknown'|'skip'`，所以在这里做一次归一：
 *     pass → ok ／ issue + severity=error → fail ／ issue + 其它 severity → warn ／ unknown → unknown
 *   （判据与 lib/diag.js 的 `summarize()` 完全一致：error 才算 fail，其余 issue 算 warn。）
 *   已经是面板词表的报告原样通过，所以合成报告和真报告都能用同一份视图模型。
 */

import { CATEGORIES, CATEGORY_LABELS } from './diag.js'
import { coverageSnapshot } from './coverage.js'
import { bundleSourceLines } from './bundle-sources.js'
import { EXECUTION_STATES, EXECUTION_LABELS } from './plan-status.js'

/* ------------------------------- 常量与词表 ------------------------------- */

/** 面板固定 5 个页签、固定顺序（与契约逐字一致）。 */
const TAB_ORDER = ['overview', 'environment', 'plugins', 'issues', 'logs']

const TAB_LABELS = {
  overview: '概览',
  environment: '环境',
  plugins: '插件',
  issues: '问题',
  logs: '日志',
}

/**
 * 旧分组名 → 新诊断类别。与 `lib/index.js:21-26` 的 LEGACY_GROUP_ALIAS 同一张表
 * （index.js 是插件入口，有副作用，不能在这里 import，所以照抄这条单向映射）。
 * 目的：老报告 / 老提示词里的 `install|env|profile|web` 也能落到正确的中文分组上。
 */
const CATEGORY_ALIAS = {
  install: 'environment',
  env: 'environment',
  profile: 'configuration',
  web: 'connectivity',
}

/** 状态归一表。`issue` 单独处理（要看 severity），见 normalizeStatus()。 */
const STATUS_ALIAS = {
  pass: 'ok',
  passed: 'ok',
  ok: 'ok',
  warn: 'warn',
  warning: 'warn',
  fail: 'fail',
  failed: 'fail',
  error: 'fail',
  unknown: 'unknown',
  info: 'info',
  skip: 'skip',
  skipped: 'skip',
}

/** 排序权重：fail > warn > unknown > skip > ok（契约要求，也是人看问题的顺序）。 */
const STATUS_RANK = { fail: 0, warn: 1, unknown: 2, skip: 3, info: 4, ok: 5 }

/** 同状态再按严重级排（lib/diag.js:33 `SEVERITIES = ['info','warning','error']`）。 */
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 }

/** 问题页只收这三种状态；`skip` 是「没测」，不是问题。 */
const PROBLEM_STATUS = new Set(['fail', 'warn', 'unknown'])

/**
 * 日志来源类型的中文名。**源码里没有这张表**：`LOG_KINDS = ['session','crash','pnpm',
 * 'market','gateway','diagnostic','temp']`（lib/logs.js:23）只有机器名，lib/ 里 grep
 * 不到任何 kind 的中文映射。契约又要求 `sources[].label` 是 string，所以在本地补一份，
 * 拿不到就退回 kind 本身 —— 这是本文件唯一一处「源码没有、我补的文案」。
 */
const LOG_KIND_LABELS = {
  session: '会话',
  crash: '崩溃',
  pnpm: 'pnpm 安装',
  market: '插件市场',
  gateway: '网关',
  diagnostic: '诊断',
  temp: '临时目录',
}

/** 分类缺失时的兜底桶（报告里 category 为空才会用到）。 */
const FALLBACK_CATEGORY = 'other'

/** `other` 桶没有源码中文名（它不在 CATEGORY_LABELS 里），补一个，否则面板会显示英文 id。 */
const FALLBACK_CATEGORY_LABEL = '其它'

const ENVIRONMENT_SECTIONS = ['environment', 'runtime', 'configuration', 'connectivity']

const DEFAULT_LIMITS = { limitIssues: 60, limitClusters: 20, limitEvidence: 6 }

/** 单条证据/建议的字符上限（契约：每条最多 400 字符）。 */
const MAX_LIST_TEXT = 400

/** 补丁不匹配最多列这么多条，避免一条规则把整页刷满。 */
const MAX_MISMATCHES = 20

/* --------------------------------- 小工具 --------------------------------- */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asObject(value) {
  return isObject(value) ? value : {}
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** 只认非空字符串；其余（含数字、undefined）一律 null，调用方给默认值。 */
function textOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 取第一个可用的非空字符串。 */
function pickText(...values) {
  for (const value of values) {
    const text = textOf(value)
    if (text !== null) return text
  }
  return null
}

function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** 按字符（code unit）截断，省略号也算在预算里：结果长度 ≤ max。 */
function clipText(value, max = MAX_LIST_TEXT) {
  if (typeof value !== 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return ''
  }
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** 列表型字段：丢掉空项、逐条截断、整体截到 limit 条。 */
function clipList(value, limit) {
  const out = []
  for (const item of asArray(value)) {
    const text = clipText(item)
    if (text.length === 0) continue
    out.push(clipText(text, MAX_LIST_TEXT))
    if (out.length >= limit) break
  }
  return out
}

/** 字节数格式化（B/KB/MB，1 位小数；与面板 formatBytes 风格一致）。 */
export function humanBytes(value) {
  const n = numOf(value) ?? numOf(Number(value)) ?? 0
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${Math.max(0, Math.round(n))} B`
}

/** 目录路径取最后一段（profile 名兜底用，不依赖 node:path）。 */
function lastSegment(value) {
  const text = textOf(value)
  if (!text) return null
  const parts = text.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : null
}

/* ------------------------------ 状态与分类归一 ------------------------------ */

function normalizeSeverity(value) {
  return value === 'error' || value === 'warning' || value === 'info' ? value : null
}

/**
 * 归一成面板词表：ok / warn / fail / unknown / skip。
 * `issue` 的判据照抄 `summarize()`（lib/diag.js）：severity=error → fail，其余 → warn。
 */
function normalizeStatus(value, severity) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'issue') return severity === 'error' ? 'fail' : 'warn'
  return STATUS_ALIAS[raw] ?? 'unknown'
}

/** 状态缺省时反推严重级：fail → error，ok → info，其余 → warning。 */
function defaultSeverity(status) {
  if (status === 'fail') return 'error'
  if (status === 'ok') return 'info'
  return 'warning'
}

function normalizeCategory(value) {
  const raw = textOf(value)
  if (!raw) return FALLBACK_CATEGORY
  return CATEGORY_ALIAS[raw] ?? raw
}

/** 分组中文名：先看报告自带 groups[].title，再查唯一真源 CATEGORY_LABELS。 */
function categoryLabel(id, titles) {
  const fromReport = titles instanceof Map ? textOf(titles.get(id)) : null
  if (fromReport) return fromReport
  const known = textOf(CATEGORY_LABELS[id])
  if (known) return known
  return String(id) === FALLBACK_CATEGORY ? FALLBACK_CATEGORY_LABEL : String(id)
}

/* -------------------------------- 计数聚合 -------------------------------- */

function emptyCounts() {
  return { ok: 0, info: 0, warn: 0, fail: 0, unknown: 0, skip: 0, total: 0 }
}

function addTo(counts, status) {
  if (counts[status] !== undefined) counts[status] += 1
  counts.total += 1
  return counts
}

function tally(statuses) {
  const counts = emptyCounts()
  for (const status of statuses) addTo(counts, status)
  return counts
}

/**
 * 全局计数：报告有 `summary` 就用它（契约要求），否则从 results 现算。
 *
 * 这里有一处**有意的归一**：真报告的 `summary` 来自 `summarize()`，词表是
 * `{ ok, warn, fail, skip, total, score }`（lib/diag.js，没有 `unknown` 键），
 * 「未测」记在 `skip` 里；而 results 里同一条是 `status:'unknown'`。
 * 若把 summary.skip 直接当 skip，就会出现「分组里 3 个未知、总览里 3 个跳过」的自相矛盾。
 * 所以：summary 同时有 unknown 和 skip 时都保留；只有 skip（真报告）时把它算进 unknown，
 * skip 记 0 —— 这样 counts 与分组计数永远对得上，面板显示的也是「未知」而不是「跳过」。
 */
function mergeCounts(summary, counted) {
  const has = (key) => typeof summary[key] === 'number' && Number.isFinite(summary[key])
  const anySummary = ['ok', 'info', 'warn', 'fail', 'unknown', 'skip', 'total'].some(has)
  // Complete entries are authoritative for presentation counts, including explicit information.
  if (counted.total > 0 || !anySummary) return counted

  const ok = has('ok') ? summary.ok : 0
  const warn = has('warn') ? summary.warn : 0
  const fail = has('fail') ? summary.fail : 0
  const unknownRaw = has('unknown') ? summary.unknown : undefined
  const skipRaw = has('skip') ? summary.skip : undefined
  const unknown = unknownRaw !== undefined ? unknownRaw : (skipRaw ?? 0)
  const skip = unknownRaw === undefined ? 0 : (skipRaw ?? 0)
  const info = has('info') ? summary.info : 0
  const total = has('total') ? summary.total : ok + info + warn + fail + unknown + skip
  return { ok, info, warn, fail, unknown, skip, total }
}

/** 分组得分：与 summarize() 同一公式（ok + warn×0.6）/ 判定数；没有判定项给 null。 */
function scoreOf(counts) {
  const judged = counts.ok + counts.warn + counts.fail
  if (judged <= 0) return null
  return Math.round(((counts.ok + counts.warn * 0.6) / judged) * 100)
}

/* --------------------------------- 单条结果 -------------------------------- */

/**
 * 产出一条面板用的 Issue。字段集合是契约，一个都不能少、名字不能变：
 * `{ id, category, label, severity, status, title, summary, evidence, recommendations, checkedAt }`
 */
function toIssue(raw, limits, titles) {
  const category = normalizeCategory(raw.category)
  const normalized = normalizeStatus(raw.status, normalizeSeverity(raw.severity))
  const informationOnly = asObject(raw.data).informationOnly === true && ['unknown', 'skip'].includes(normalized) && (!raw.severity || raw.severity === 'info')
  const status = informationOnly ? 'info' : normalized
  const severity = informationOnly ? 'info' : normalizeSeverity(raw.severity) ?? defaultSeverity(normalized)
  return {
    id: textOf(raw.id) ?? '',
    category,
    label: categoryLabel(category, titles),
    severity,
    status,
    title: textOf(raw.title) ?? textOf(raw.id) ?? categoryLabel(category, titles),
    summary: textOf(raw.summary) ?? '',
    evidence: clipList(raw.evidence, limits.limitEvidence),
    recommendations: clipList(raw.recommendations, limits.limitEvidence),
    checkedAt: textOf(raw.checkedAt),
  }
}

function compareProblems(a, b) {
  const byStatus = (STATUS_RANK[a.issue.status] ?? 9) - (STATUS_RANK[b.issue.status] ?? 9)
  if (byStatus !== 0) return byStatus
  const bySeverity = (SEVERITY_RANK[a.issue.severity] ?? 9) - (SEVERITY_RANK[b.issue.severity] ?? 9)
  if (bySeverity !== 0) return bySeverity
  return a.index - b.index
}

/* ---------------------------------- 各页面 ---------------------------------- */

function buildTabs(ctx) {
  const pluginCounts = ctx.pluginCounts
  const pluginBadge = pluginCounts.fail > 0 ? pluginCounts.fail : pluginCounts.warn > 0 ? pluginCounts.warn : null
  const badges = {
    overview: null,
    environment: null,
    plugins: pluginBadge,
    issues: ctx.problems.length,
    logs: ctx.logs ? ctx.logs.clusters.length : null,
  }
  return TAB_ORDER.map((id) => ({ id, label: TAB_LABELS[id], badge: badges[id] }))
}

function buildOverview(ctx) {
  const { counts, limits, problems, all, titles } = ctx
  const top = problems.slice(0, 3).map((entry) => entry.issue)

  const ids = CATEGORIES.slice()
  for (const id of all.map((entry) => entry.issue.category)) {
    if (!ids.includes(id)) ids.push(id)
  }
  const groups = ids.map((id) => {
    const statuses = all.filter((entry) => entry.issue.category === id).map((entry) => entry.issue.status)
    const groupCounts = tally(statuses)
    return { id, label: categoryLabel(id, titles), counts: groupCounts, score: scoreOf(groupCounts) }
  })

  const facts = [
    { label: 'DSH', value: ctx.runtime.dsh ?? '(未知)' },
    { label: 'Node', value: ctx.runtime.node ?? '(未知)' },
    { label: '系统', value: ctx.runtime.os ?? '(未知)' },
  ]
  if (ctx.runtime.profile) facts.push({ label: 'Profile', value: ctx.runtime.profile })
  facts.push({ label: '得分', value: ctx.score === null ? '(无)' : `${ctx.score}/100` })
  facts.push({ label: '耗时', value: ctx.durationMs === null ? '(未知)' : `${ctx.durationMs}ms` })

  return {
    headline: `${counts.total} 项检查：${counts.ok} 通过 · ${counts.warn} 提醒 · ${counts.fail} 失败`,
    facts: facts.slice(0, limits.limitFacts),
    top,
    groups,
  }
}

function buildEnvironment(ctx) {
  const sections = []
  for (const id of ENVIRONMENT_SECTIONS) {
    const entries = ctx.all.filter((entry) => entry.issue.category === id)
    if (entries.length === 0) continue
    sections.push({
      group: id,
      label: categoryLabel(id, ctx.titles),
      rows: entries.map((entry) => ({
        label: entry.issue.title,
        value: entry.issue.summary,
        status: entry.issue.status,
        hint: entry.issue.recommendations[0] ?? entry.issue.evidence[0] ?? null,
      })),
    })
  }
  return { sections }
}

/**
 * 插件页。
 * 主源是事实快照 `facts.configuration.plugins`（lib/facts.js:584-595，每项
 * `{ name, version, dir, declaredPatch, patchExists, compat }`）；拿不到再退回
 * `DSH-PLG-001` 的 `data.packages`（lib/rules.js:294，形如 `name@version` 的字符串数组）。
 */
function buildPlugins(ctx) {
  const configuration = asObject(ctx.facts.configuration)
  const rawPlugins = asArray(configuration.plugins).filter(isObject)
  const hostProvided = new Set(asArray(configuration.hostProvided).filter((name) => typeof name === 'string'))

  const installed = []
  if (rawPlugins.length > 0) {
    for (const plugin of rawPlugins) {
      const name = textOf(plugin.name) ?? '(未命名)'
      const version = textOf(plugin.version)
      const compat = asObject(plugin.compat)
      const compatBad = compat.declared === true && compat.ok === false
      const patchBroken = plugin.patchExists === false && Boolean(plugin.declaredPatch) === true
      const notes = []
      const providedBy = asArray(plugin.providedBy).filter((id) => typeof id === 'string')
      if (providedBy.length) notes.push(`providedBy=${providedBy.join(' / ')}；操作来源 bundle，不单独卸载`)
      if (compat.declared === true && textOf(compat.range)) notes.push(`声明 ${compat.range}`)
      else if (compat.declared === false) notes.push('未填写市场兼容资料，不代表加载失败')
      if (patchBroken) notes.push(`补丁缺失 ${plugin.declaredPatch}`)
      installed.push({
        name,
        version,
        source: hostProvided.has(name) ? 'host' : 'profile',
        link: textOf(plugin.dir),
        status: patchBroken ? 'fail' : compatBad || compat.declared === false ? 'info' : 'ok',
        note: notes.length ? notes.join(' · ') : null,
      })
    }
  } else {
    // 退回规则结果：DSH-PLG-001 通过时 data.packages = ['name@version', ...]
    const result = asArray(ctx.rawResults).find((item) => item.id === 'DSH-PLG-001')
    const packages = asArray(isObject(result) ? asObject(result.data).packages : [])
    for (const item of packages) {
      const spec = textOf(item)
      if (!spec) continue
      const at = spec.lastIndexOf('@')
      const name = at > 0 ? spec.slice(0, at) : spec
      const version = at > 0 ? spec.slice(at + 1) : null
      installed.push({
        name,
        version: version === '?' ? null : version,
        source: 'profile',
        link: null,
        status: result && result.status === 'issue' ? 'warn' : 'ok',
        note: null,
      })
    }
  }

  // 补丁行数：facts.configuration.patchRowCount（lib/facts.js:621），退回 patchRows.length
  const patchRows = Array.isArray(configuration.patchRows) ? configuration.patchRows.length : null
  const rows = numOf(configuration.patchRowCount) ?? patchRows

  const mismatches = []
  const seen = new Set()
  const pushMismatch = (name, reason) => {
    const key = `${name}\u0000${reason}`
    if (seen.has(key) || mismatches.length >= MAX_MISMATCHES) return
    seen.add(key)
    mismatches.push({ name, reason })
  }
  for (const item of asArray(configuration.missingPackages).filter(isObject)) {
    const name = textOf(item.name) ?? '(未命名)'
    pushMismatch(name, `补丁行 ${textOf(item.id) ?? '(未知)'} 引用的包在 profile 里找不到`)
  }
  for (const item of asArray(configuration.lockDrift).filter(isObject)) {
    const name = textOf(item.name) ?? '(未命名)'
    pushMismatch(name, `package.json 写 ${textOf(item.spec) ?? '(未知)'}，lockfile 里没有`)
  }
  for (const result of asArray(ctx.rawResults)) {
    if (result?.id !== 'DSH-PLG-002') continue
    for (const name of asArray(asObject(result.data).broken)) {
      pushMismatch(textOf(name) ?? '(未命名)', 'bundle 补丁文件缺失')
    }
    for (const line of asArray(result.evidence)) {
      const text = textOf(line)
      if (text) pushMismatch(text.split('→')[0].trim() || '(未命名)', text)
    }
  }

  const pluginCount = numOf(configuration.pluginCount)
  const missingPackages = Array.isArray(configuration.missingPackages) ? configuration.missingPackages.length : null
  const disabled = Array.isArray(configuration.patchRows)
    ? configuration.patchRows.filter((row) => isObject(row) && row.disabled === true).length
    : null

  return {
    installed,
    sources: bundleSourceLines(ctx.bundleSources),
    information: ctx.all.filter((entry) => entry.issue.category === 'plugins' && entry.issue.status === 'info').map((entry) => entry.issue),
    patch: { rows, mismatches },
    summary: {
      installed: pluginCount ?? (installed.length > 0 ? installed.length : null),
      missing: missingPackages,
      disabled,
    },
  }
}

function buildIssues(ctx) {
  const { limits, problems, all, titles } = ctx
  const total = problems.length
  const shown = problems.slice(0, limits.limitIssues).map((entry) => entry.issue)
  const truncated = total - shown.length

  const byCategory = new Map()
  for (const issue of shown) {
    if (!byCategory.has(issue.category)) byCategory.set(issue.category, [])
    byCategory.get(issue.category).push(issue)
  }

  const groups = []
  // 顺序跟 CATEGORIES（也就是 render.js 的分组顺序）走，剩下的按出现顺序追加
  const order = CATEGORIES.slice()
  for (const id of byCategory.keys()) if (!order.includes(id)) order.push(id)
  for (const id of order) {
    const items = byCategory.get(id)
    if (!items || items.length === 0) continue
    const statuses = all.filter((entry) => entry.issue.category === id).map((entry) => entry.issue.status)
    groups.push({ category: id, label: categoryLabel(id, titles), counts: tally(statuses), items })
  }

  return { groups, total, truncated }
}

function buildLogs(ctx, limits) {
  const logs = ctx.logs
  if (!logs) {
    return {
      sources: [],
      clusters: [],
      leaks: { total: 0, unique: 0, byType: [] },
      window: { hours: null, startedAt: null, outsideCount: null },
      available: false,
    }
  }

  const sources = asArray(logs.sources).map((source) => {
    const item = asObject(source)
    const kind = textOf(item.kind) ?? ''
    return {
      kind,
      label: textOf(LOG_KIND_LABELS[kind]) ?? textOf(kind) ?? '(未知)',
      // logs.js 的 source 没有行数字段（lib/logs.js:565-575 只有 size）——没有就给 null，不编
      lines: numOf(item.lines),
      // 真源字段是 `size`；`bytes` 只是面板侧的名字
      bytes: numOf(item.bytes) ?? numOf(item.size),
      path: textOf(item.path),
    }
  })

  const clusters = asArray(logs.clusters)
    .map((cluster) => {
      const item = asObject(cluster)
      return {
        signature: textOf(item.signature) ?? '',
        level: pickText(item.level, item.severity) ?? 'info',
        count: numOf(item.count) ?? 0,
        lastAt: pickText(item.lastAt, item.lastSeenAt),
        sample: textOf(item.sample) ?? '',
      }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limits.limitClusters)

  const leaksRaw = asObject(logs.leaks)
  const byType = []
  if (Array.isArray(leaksRaw.byType)) {
    for (const item of leaksRaw.byType) {
      if (!isObject(item)) continue
      byType.push({ type: textOf(item.type) ?? 'unknown', count: numOf(item.count) ?? 0 })
    }
  } else if (isObject(leaksRaw.byType)) {
    for (const [type, count] of Object.entries(leaksRaw.byType)) {
      byType.push({ type, count: numOf(count) ?? 0 })
    }
  }
  byType.sort((a, b) => b.count - a.count)

  const windowRaw = asObject(logs.window)
  const startedAt = pickText(windowRaw.startedAt, logs.windowStart)
  const endedAt = pickText(windowRaw.endedAt, logs.windowEnd, logs.collectedAt)
  let hours = numOf(windowRaw.hours)
  if (hours === null && startedAt && endedAt) {
    const span = Date.parse(endedAt) - Date.parse(startedAt)
    if (Number.isFinite(span) && span >= 0) hours = Math.round((span / 3600000) * 10) / 10
  }
  const outside = Array.isArray(logs.clustersOutsideWindow) ? logs.clustersOutsideWindow.length : null

  return {
    sources,
    clusters,
    leaks: {
      total: numOf(leaksRaw.total) ?? 0,
      unique: numOf(leaksRaw.unique) ?? 0,
      byType,
    },
    window: {
      hours,
      startedAt,
      outsideCount: numOf(windowRaw.outsideCount) ?? outside,
    },
    available: true,
  }
}

/* ------------------------------ 诊断与修复草案 ------------------------------ */

/**
 * 逐项补齐契约字段。真报告的 diagnosis（lib/inference.js:1382-1397）里
 * 没有 `reason` / `nextStep`，对应的是 `summary` / `nextChecks[]`，这里做一次映射：
 * 面板写 `reason`、`nextStep`，源码写 `summary`、`nextChecks`，谁也没错，接一下就好。
 */
function toDiagnosis(raw) {
  const item = asObject(raw)
  const givenId = textOf(item.id)
  const givenHyp = textOf(item.hypothesisId)
  const hypothesisId = givenHyp ?? (givenId && givenId.startsWith('hyp-') ? givenId.slice(4) : null) ?? 'unknown'
  const nextChecks = asArray(item.nextChecks).map((line) => textOf(line)).filter((line) => line !== null)
  return {
    ...item,
    id: givenId ?? (hypothesisId === 'unknown' ? 'unknown' : `hyp-${hypothesisId}`),
    hypothesisId,
    title: textOf(item.title) ?? hypothesisId,
    confidence: numOf(item.confidence),
    reason: pickText(item.reason, item.summary) ?? '',
    nextStep: pickText(item.nextStep, nextChecks[0]) ?? '',
    repairHint: textOf(item.repairHint),
  }
}

/** 修复草案瘦身：`changes` 是数组（lib/repair-plan.js:284），面板只要条数。 */
function toPlan(raw) {
  const item = asObject(raw)
  const changes = Array.isArray(item.changes) ? item.changes.length : numOf(item.changes) ?? 0
  // Transport the controller's verdict; never infer executable from risk or change count.
  const executionState = EXECUTION_STATES.includes(item.executionState) ? item.executionState : 'unchecked'
  const blockedReasons = executionState === 'read-only' ? [] : [...new Set(asArray(item.blockedReasons).filter((reason) => typeof reason === 'string' && reason.trim()).map((reason) => reason.trim()))]
  if (!EXECUTION_STATES.includes(item.executionState) && !blockedReasons.length) blockedReasons.push('请先在对话里预览校验')
  return {
    executionState,
    executionLabel: EXECUTION_LABELS[executionState],
    blockedReasons,
    id: textOf(item.id) ?? '',
    title: textOf(item.title) ?? '',
    risk: textOf(item.risk) ?? 'unknown',
    changes,
    // 契约字段叫 reversible，真源字段叫 rollbackAvailable（lib/repair-plan.js:285）
    reversible: item.reversible === true || item.rollbackAvailable === true,
    previewCommand: `/doctor repair preview ${textOf(item.id) ?? ''}`,
    applyCommand: `/doctor repair apply ${textOf(item.id) ?? ''} --yes`,
    prepared: item.prepared === true || item.meta?.prepared === true,
  }
}

/* --------------------------------- 主函数 --------------------------------- */

function build(report, options) {
  const source = asObject(report)
  const opts = asObject(options)
  const limits = {
    limitIssues: positiveInt(opts.limitIssues, DEFAULT_LIMITS.limitIssues),
    limitClusters: positiveInt(opts.limitClusters, DEFAULT_LIMITS.limitClusters),
    limitEvidence: positiveInt(opts.limitEvidence, DEFAULT_LIMITS.limitEvidence),
    limitFacts: 6,
  }

  const facts = asObject(source.facts)
  const env = asObject(source.env)
  const summary = asObject(source.summary)
  const suppliedResults = asArray(source.results).filter(isObject)
  const rawResults = suppliedResults.length ? suppliedResults : asArray(source.checks).filter(isObject).map((item) => ({
    ...item, category: item.category ?? item.group, summary: item.summary ?? item.detail,
    severity: item.severity ?? (item.status === 'fail' ? 'error' : item.status === 'warn' ? 'warning' : 'info'),
    recommendations: item.recommendations ?? (item.hint ? [item.hint] : []),
  }))

  const titles = new Map()
  for (const group of asArray(source.groups)) {
    if (!isObject(group)) continue
    const id = textOf(group.id)
    const title = textOf(group.title)
    if (id && title) titles.set(id, title)
  }

  const all = rawResults.map((raw, index) => {
    const issue = toIssue(raw, limits, titles)
    return { issue, index }
  })
  const problems = all.filter((entry) => PROBLEM_STATUS.has(entry.issue.status)).sort(compareProblems)

  const counts = mergeCounts(summary, tally(all.map((entry) => entry.issue.status)))
  const pluginCounts = tally(all.filter((entry) => entry.issue.category === 'plugins').map((entry) => entry.issue.status))

  const runtime = {
    dsh: pickText(env.dshVersion, asObject(facts.install).dshVersion),
    node: pickText(env.node, env.nodeVersion, asObject(facts.runtime).node),
    os:
      pickText(env.platform) ??
      (() => {
        const rt = asObject(facts.runtime)
        const platform = textOf(rt.platform)
        if (!platform) return null
        const arch = textOf(rt.arch)
        return arch ? `${platform}/${arch}` : platform
      })(),
    profile: pickText(env.profile, asObject(facts.configuration).profile, lastSegment(env.profileDir)),
  }

  // 日志：真报告只在 facts.logs（lib/facts.js:746），report.logs 只是兼容旧快照
  const logsRaw = isObject(source.logs) ? source.logs : isObject(facts.logs) ? facts.logs : null

  const ctx = {
    all,
    counts,
    facts,
    bundleSources: source.bundleSources ?? facts.configuration?.bundleSources,
    limits,
    pluginCounts,
    problems,
    rawResults,
    runtime,
    titles,
    logs: logsRaw,
    score: numOf(summary.score),
    durationMs: numOf(source.durationMs) ?? numOf(facts.durationMs),
  }

  const status = counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : counts.ok > 0 ? 'ok' : 'unknown'

  return {
    version: textOf(source.version),
    generatedAt: textOf(source.generatedAt),
    score: ctx.score,
    counts,
    status,
    coverage: source.coverage ?? coverageSnapshot(),
    runtime,
    tabs: buildTabs(ctx),
    pages: {
      overview: buildOverview(ctx),
      environment: buildEnvironment(ctx),
      plugins: buildPlugins(ctx),
      issues: buildIssues(ctx),
      logs: buildLogs(ctx, limits),
    },
    diagnoses: asArray(source.diagnoses).map(toDiagnosis),
    plans: asArray(source.plans).map(toPlan),
    exports: [],
  }
}

/**
 * 把一份 `runDoctor()` 报告整理成面板可直接渲染的视图模型。
 *
 * @param {unknown} report 报告对象（或任何东西——垃圾输入也返回结构完整的空模型）
 * @param {{ limitIssues?: number, limitClusters?: number, limitEvidence?: number }} [options]
 * @returns {object} 视图模型，字段见文件头契约
 */
export function buildViewModel(report, options = {}) {
  try {
    return build(report, options)
  } catch {
    // 最后一道保险：视图模型的任何 bug 都不该把面板变成白屏 / 让注入整体失败
    return build({}, {})
  }
}

export default { buildViewModel, humanBytes }
