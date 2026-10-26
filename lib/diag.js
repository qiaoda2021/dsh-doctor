/**
 * 统一诊断结果结构。
 *
 * 设计文档《DSH Doctor 详细设计计划》第五节要求：所有检测器返回同一种结构，规则引擎负责
 * 综合分析，界面负责展示，这样以后加检测项不用重写界面。这里就是那个结构：
 *
 *   DiagnosticResult = {
 *     id, category, severity, status, summary,
 *     evidence: string[], recommendations: string[], checkedAt,
 *     title?, possibleCauses?, nextChecks?, confidence?, data?
 *   }
 *
 * - severity: 'info' | 'warning' | 'error'
 * - status:   'pass' | 'issue' | 'unknown'
 *
 * `unknown` 是刻意保留的第三态：文档强调「不要因为找不到某个包就认定它需要重装」，
 * 检测不到 ≠ 有问题，也 ≠ 没问题。凡是证据不足的判断一律落到 unknown，而不是勉强给 pass。
 */

/** 诊断类别（设计文档里的模块名 + 本机实测需要的补充类别）。 */
export const CATEGORIES = [
  'environment',
  'runtime',
  'configuration',
  'plugins',
  'connectivity',
  'logs',
  'data',
  'security',
  'workspace',
]

export const SEVERITIES = ['info', 'warning', 'error']
export const STATUSES = ['pass', 'issue', 'unknown']

/** 对外展示用的中文标签（面板与 markdown 共用）。 */
export const CATEGORY_LABELS = {
  environment: '运行环境',
  runtime: '运行时',
  configuration: '配置',
  plugins: '插件',
  connectivity: '连接',
  logs: '日志',
  data: '数据',
  security: '凭据安全',
  workspace: '工作区',
}

export const SEVERITY_LABELS = {
  error: '错误',
  warning: '警告',
  info: '信息',
}

const ICONS = { pass: '✅', issue: '⚠️', unknown: '⏭️' }

/** issue 的图标按 severity 分级，error 用 ❌，warning 用 ⚠️。 */
export function iconOf(result) {
  if (result.status === 'issue') {
    return result.severity === 'error' ? '❌' : result.severity === 'info' ? 'ℹ️' : '⚠️'
  }
  return ICONS[result.status] ?? '•'
}

function asStringArray(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  return [String(value)].filter(Boolean)
}

/**
 * 构造一条诊断结果。规则里只描述「看到了什么证据、建议查什么」，判定字段由规则显式给出。
 */
export function makeResult(input) {
  const category = CATEGORIES.includes(input.category) ? input.category : 'environment'
  const severity = SEVERITIES.includes(input.severity) ? input.severity : 'info'
  const status = STATUSES.includes(input.status) ? input.status : 'unknown'
  const result = {
    id: String(input.id),
    category,
    severity,
    status,
    summary: String(input.summary ?? ''),
    evidence: asStringArray(input.evidence),
    recommendations: asStringArray(input.recommendations),
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  }
  if (input.title) result.title = String(input.title)
  const causes = asStringArray(input.possibleCauses)
  if (causes.length) result.possibleCauses = causes
  const next = asStringArray(input.nextChecks)
  if (next.length) result.nextChecks = next
  if (typeof input.confidence === 'number') result.confidence = Number(input.confidence.toFixed(2))
  if (input.data !== undefined) result.data = input.data
  return result
}

/** pass / unknown 的快捷构造：不带建议，语义干净。 */
export function pass(id, category, summary, extra = {}) {
  return makeResult({ id, category, severity: 'info', status: 'pass', summary, ...extra })
}

export function unknown(id, category, summary, extra = {}) {
  return makeResult({ id, category, severity: 'info', status: 'unknown', summary, ...extra })
}

export function issue(id, category, severity, summary, extra = {}) {
  return makeResult({ id, category, severity, status: 'issue', summary, ...extra })
}

/**
 * 汇总：ok = pass 数；warn/fail = issue 按 severity 拆分；skip = unknown。
 * score 只统计「有判定」的条目（pass + issue），unknown 不进分母——没测到的东西不该拉低得分，
 * 这也是避免「因为探测不到所以报红」的一种工程约束。
 */
export function summarize(results) {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0, total: results.length, score: 100 }
  for (const r of results) {
    if (r.status === 'pass') summary.ok += 1
    else if (r.status === 'unknown') summary.skip += 1
    else if (r.severity === 'error') summary.fail += 1
    else summary.warn += 1
  }
  const judged = summary.ok + summary.warn + summary.fail
  if (judged > 0) summary.score = Math.round(((summary.ok + summary.warn * 0.6) / judged) * 100)
  else summary.score = 0
  return summary
}

/** 排序：错误 → 警告 → 未知 → 通过；同级别按类别固定顺序，保证面板稳定。 */
export function rankResults(results) {
  const severityRank = { error: 0, warning: 1, info: 2 }
  const statusRank = { issue: 0, unknown: 1, pass: 2 }
  const categoryRank = new Map(CATEGORIES.map((c, i) => [c, i]))
  return [...results].sort((a, b) => {
    const s = (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3)
    if (s !== 0) return s
    const v = (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3)
    if (v !== 0) return v
    const c = (categoryRank.get(a.category) ?? 99) - (categoryRank.get(b.category) ?? 99)
    if (c !== 0) return c
    return String(a.id).localeCompare(String(b.id))
  })
}

/**
 * 兼容层：v0.1 的 checks 结构（{id, group, title, status, detail, hint}）被面板和 render.js
 * 消费。v0.2 起唯一真源是 DiagnosticResult，这里单向派生旧结构，避免两处维护两套判定。
 */
export function toLegacyCheck(result) {
  const status =
    result.status === 'pass'
      ? 'ok'
      : result.status === 'unknown'
        ? 'skip'
        : result.severity === 'error'
          ? 'fail'
          : 'warn'
  const hint = result.recommendations[0]
  return {
    id: result.id,
    group: result.category,
    title: result.title ?? CATEGORY_LABELS[result.category] ?? result.category,
    status,
    detail: result.summary,
    ...(hint ? { hint } : {}),
    ...(result.evidence.length ? { evidence: result.evidence } : {}),
    ...(result.recommendations.length ? { recommendations: result.recommendations } : {}),
    ...(result.data === undefined ? {} : { data: result.data }),
  }
}

/** 最需要注意的一条：错误 > 警告 > 未知，同级取最先出现（已排序后即第一条）。 */
export function topProblem(results) {
  return results.find((r) => r.status === 'issue') ?? results.find((r) => r.status === 'unknown')
}
