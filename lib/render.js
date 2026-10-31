/**
 * DSH Doctor — 报告渲染（Host 半边）。
 * 只做纯函数格式化：report -> markdown / 纯文本。
 *
 * v0.2 起优先渲染 report.results（DiagnosticResult：带 evidence / recommendations / confidence），
 * 只有旧结构（report.checks 且无 results）才走兼容分支。
 */
import { iconOf, CATEGORY_LABELS } from './diag.js'
import { coverageSnapshot, coverageLine } from './coverage.js'
import { bundleSourceLines } from './bundle-sources.js'

const ICONS = { ok: '✅', warn: '⚠️', fail: '❌', skip: '⏭️' }
const LABELS = { ok: '正常', warn: '警告', fail: '异常', skip: '跳过' }

export function statusIcon(status) {
  return ICONS[status] ?? '•'
}

export function statusLabel(status) {
  return LABELS[status] ?? status
}

/** 一行摘要：✅ 34 · ⚠️ 2 · ❌ 1 · 得分 89% */
export function summaryLine(report) {
  const s = report?.summary ?? {}
  const parts = [
    `${ICONS.ok} ${s.ok ?? 0}`,
    `${ICONS.warn} ${s.warn ?? 0}`,
    `${ICONS.fail} ${s.fail ?? 0}`,
  ]
  if (s.skip) parts.push(`${ICONS.skip} ${s.skip}`)
  return `${parts.join(' · ')} · 得分 ${s.score ?? 0}%`
}

/** 最需要先看的一条：错误 > 警告 > 未知（results 存在时用 results）。 */
export function worstCheck(report) {
  const results = report?.results
  if (Array.isArray(results) && results.length) {
    return (
      results.find((r) => r.status === 'issue' && r.severity === 'error') ??
      results.find((r) => r.status === 'issue') ??
      results.find((r) => r.status === 'unknown')
    )
  }
  const checks = report?.checks ?? []
  return checks.find((c) => c.status === 'fail') ?? checks.find((c) => c.status === 'warn')
}

function groupTitle(report, groupId) {
  return (report?.groups ?? []).find((g) => g.id === groupId)?.title ?? CATEGORY_LABELS[groupId] ?? groupId
}

function problemText(item) {
  return item.summary ?? item.detail ?? ''
}

/** 一条结果的多行 markdown：标题行 + 证据 + 可能原因 + 建议 + 编号/置信度。 */
function resultBlock(item) {
  const lines = [`- ${iconOf(item)} **${item.title ?? groupTitle(undefined, item.category)}** — ${problemText(item)}`]
  for (const ev of item.evidence ?? []) lines.push(`  - 证据：${ev}`)
  for (const cause of item.possibleCauses ?? []) lines.push(`  - 可能原因：${cause}`)
  for (const rec of item.recommendations ?? (item.hint ? [item.hint] : [])) lines.push(`  - 建议：${rec}`)
  const meta = [item.id, typeof item.confidence === 'number' ? `置信度 ${item.confidence}` : undefined]
    .filter(Boolean)
    .join(' · ')
  if (meta) lines.push(`  - \`${meta}\``)
  return lines
}

/**
 * 一条「根因假设」的多行 markdown。
 *
 * 与规则块的区别：规则块回答「这一项哪里不对」，根因块回答「这些项是不是同一件事」。
 * 所以这里必须写出：置信度怎么来的（关联了哪几条规则）、可能原因的权重与依据、
 * 还缺哪些证据（nextChecks）、以及能不能修（repairHint）。
 */
function diagnosisBlock(d) {
  const conf = typeof d.confidence === 'number' ? `置信度 ${d.confidence}` : '置信度 —'
  const lines = [`### ❗ ${d.title ?? d.id}（${conf} · ${d.severity ?? 'warning'}）`]
  if (d.summary) lines.push('', d.summary)
  for (const ev of d.evidence ?? []) lines.push(`- 证据：${ev}`)
  for (const cause of d.causes ?? []) {
    const weight = typeof cause?.weight === 'number' ? `（权重 ${cause.weight}` : ''
    const basis = cause?.basis ? `${weight ? '，' : '（'}依据：${cause.basis}）` : weight ? '）' : ''
    lines.push(`- 可能原因：${cause?.cause ?? cause}${weight}${basis}`)
  }
  for (const check of d.nextChecks ?? []) lines.push(`- 下一步：${check}`)
  if (d.affectedRules?.length) lines.push(`- 关联规则：${d.affectedRules.map((id) => `\`${id}\``).join('、')}`)
  if (d.repairHint) lines.push(`- 修复方向：${d.repairHint}`)
  return lines
}

/** 旧结构的一行渲染（兼容 v0.1 报告）。 */
function legacyBlock(item) {
  const lines = [`- ${ICONS[item.status] ?? '•'} **${item.title}** — ${item.detail || statusLabel(item.status)}`]
  if (item.hint) lines.push(`  - ↳ ${item.hint}`)
  return lines
}

/**
 * 完整 markdown 报告。
 * @param {object} report runDoctor() 的返回值
 * @param {{ group?: string, onlyProblems?: boolean }} [options]
 */
export function renderMarkdown(report, options = {}) {
  if (!report) return '> 还没有体检报告，先运行一次 `/doctor`。'
  const modern = Array.isArray(report.results)
  const items = (modern ? report.results : report.checks ?? []).filter((item) => {
    const category = modern ? item.category : item.group
    if (options.group && category !== options.group) return false
    if (options.onlyProblems && modern && item.status !== 'issue') return false
    if (options.onlyProblems && !modern && item.status !== 'fail' && item.status !== 'warn') return false
    return true
  })

  const lines = []
  lines.push(`# DSH Doctor 体检报告`)
  lines.push('')
  // 头部永远是全局数字；有筛选时明确标出来，避免读成「全局只有这几项」
  const filters = []
  if (options.group) filters.push(`仅看「${groupTitle(report, options.group)}」`)
  if (options.onlyProblems) filters.push('仅列问题项')
  const scope = filters.length ? `（${filters.join('，')}；下方数字与得分是全局值）` : ''
  lines.push(`${summaryLine(report)} · 耗时 ${report.durationMs ?? 0}ms · ${report.generatedAt ?? ''}${scope}`)
  const env = report.env ?? {}
  lines.push('')
  lines.push(
    [
      env.dshVersion ? `DSH ${env.dshVersion}` : undefined,
      env.node ? `Node ${env.node}` : undefined,
      env.platform,
      env.profile ? `profile ${env.profile}` : undefined,
      env.mode ? `模式 ${env.mode}` : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
  )

  const coverage = report.coverage ?? coverageSnapshot()
  lines.push('', '## 检查覆盖（整次扫描，不随明细过滤）', coverageLine(coverage))
  for (const group of coverage.groups) lines.push(`- ${groupTitle(report, group.id)}：${group.state} · ran=${group.ran} / skipped=${group.skipped} / unknown=${group.unknown} / failed=${group.failed} · filesInspected=${group.filesInspected ?? '未知'}${group.filesInspectedScope ? ` (${group.filesInspectedScope})` : ''}${group.reasons.length ? ` · ${[...new Set(group.reasons.map((r) => r.reason))].join(' / ')}` : ''}`)
  if (!options.group || options.group === 'plugins') lines.push('', '## Bundle 来源与只读预检', ...bundleSourceLines(report.bundleSources).map((line) => '- ' + line))

  // 根因排在分组明细之前：先回答「这是几件事」，再逐项看证据。
  // 没有推理层（旧报告 / 推理模块缺失）时这段自动消失，不影响其它出口。
  const diagnoses = (report.diagnoses ?? []).filter((d) => !options.group || d.category === options.group)
  if (diagnoses.length) {
    lines.push('')
    lines.push('## 根因（归因）')
    for (const d of diagnoses) {
      lines.push('')
      lines.push(...diagnosisBlock(d))
    }
    if (report.inference?.unmatched?.length) {
      lines.push('')
      lines.push(`_还有 ${report.inference.unmatched.length} 条问题没归因到具体根因：${report.inference.unmatched.map((id) => `\`${id}\``).join('、')}_`)
    }
  }

  // 修复草案：只列出「改哪里 + 多大风险 + 验证什么」，明确写「未执行」。
  // 没有草案（无规划器 / 无证据）时整段消失，不用空标题占位置。
  const plans = report.plans ?? []
  const diagCategory = new Map((report.diagnoses ?? []).map((d) => [d.id, d.category]))
  const visiblePlans = plans.filter((p) => !options.group || diagCategory.get(p.diagnosisId) === options.group)
  if (visiblePlans.length) {
    lines.push('')
    lines.push('## 修复草案（未执行）')
    for (const plan of visiblePlans) {
      lines.push('')
      lines.push(`### ${plan.title} · 风险 ${plan.risk}`)
      if (plan.explanation) lines.push('', plan.explanation)
      for (const change of plan.changes ?? []) {
        lines.push(`- 改动：${change.operation} \`${change.target}\`${change.description ? ` — ${change.description}` : ''}`)
      }
      for (const check of plan.verificationChecks ?? []) lines.push(`- 验证：${check}`)
      lines.push(`- 确认方式：${plan.requiresConfirm ? '需要用户明确确认（本报告不执行）' : '只读/低风险，可直接查看'}`)
      if (plan.rollbackAvailable && plan.rollbackNote) lines.push(`- 回滚：${plan.rollbackNote}`)
    }
  }

  const groups = (report.groups ?? []).filter((g) => !options.group || g.id === options.group)
  for (const group of groups) {
    const rows = items.filter((item) => (modern ? item.category : item.group) === group.id)
    if (rows.length === 0) continue
    lines.push('')
    lines.push(`## ${group.title}`)
    for (const row of rows) lines.push(...(modern ? resultBlock(row) : legacyBlock(row)))
  }

  if (items.length === 0) {
    lines.push('')
    lines.push(
      options.onlyProblems
        ? '_当前筛选条件下没有问题项（全局统计见上）。_'
        : '_当前筛选条件下没有条目。_',
    )
  }

  if (report.frontend && (!options.group || options.group === 'plugins')) {
    const frontend = report.frontend
    lines.push('', '## 浏览器分层证据（不计健康分）', frontend.reason ?? '',
      `来源：最近一个所有者浏览器窗口；${frontend.stale ? '回报已过期，阶段恢复未知' : frontend.observedAt ? `回报时间 ${frontend.observedAt}` : '尚无有效回报'}`)
    for (const row of frontend.modules ?? []) lines.push(`- ${row.id}：entry=${row.entry} · registration=${row.registration} · mount=${row.mount} · selection=${row.selection} · error=${row.error}`)
    for (const limitation of frontend.limitations ?? []) lines.push(`- ${limitation}`)
  }
  return lines.join('\n')
}

/** 极简版：给命令结果 / 状态栏用的一屏总结。 */
export function renderCompact(report) {
  if (!report) return 'DSH Doctor：暂无报告'
  const worst = worstCheck(report)
  // 耗时也放进 compact 首行：验收脚本要对比「有没有变慢」，缺这个字段就只能靠肉眼
  const dur = Number.isFinite(report.durationMs) ? ` · ${report.durationMs}ms` : ''
  const lines = [`DSH Doctor ${summaryLine(report)}${dur}`, coverageLine(report.coverage)]
  if (report.bundleSources) lines.push(`Bundle 来源：${report.bundleSources.packages.length} 项 · 声明重叠 ${report.bundleSources.matches.length} · 未核实 ${report.bundleSources.unverified.length}；详见 markdown/json${report.bundleSources.candidate ? ` · 候选 ${report.bundleSources.candidate.label}` : ''}`)
  // compact 只有三行预算：先给「最可能的根因」，再给「最需要注意的单条规则」。
  // 根因优先，因为用户真正要的是「先修哪一件事」。
  const top = report.diagnoses?.[0]
  if (top) {
    const conf = typeof top.confidence === 'number' ? `置信度 ${top.confidence}` : '置信度 —'
    const affects = top.affectedRules?.length ? ` · 影响 ${top.affectedRules.length} 条规则` : ''
    // 根因行必须挂规则 id：只说「网络不通」而不说命中了哪条规则，用户没法回头核对
    const ids = (top.affectedRules ?? []).slice(0, 4).map((id) => (typeof id === 'string' ? id : id?.id)).filter(Boolean)
    const idText = ids.length ? ` · 规则 ${ids.join('/')}${top.affectedRules.length > ids.length ? ' 等' : ''}` : ''
    lines.push(`最可能根因：${top.title ?? top.id}（${conf}${affects}${idText}）`)
    if (top.nextChecks?.[0]) lines.push(`下一步：${top.nextChecks[0]}`)
    return lines.join('\n')
  }
  if (worst) {
    const icon = worst.status ? iconOf(worst) : statusIcon(worst.status)
    lines.push(`最需要注意：${icon} ${worst.title ?? ''} — ${problemText(worst)}`)
    const rec = (worst.recommendations ?? [])[0] ?? worst.hint
    if (rec) lines.push(`建议：${rec}`)
  } else {
    lines.push(report.coverage?.groups.every((g) => g.state === 'complete') && !report.coverage.stale ? '全部检查通过。' : '当前没有问题项；覆盖尚有未核实，见分组摘要。')
  }
  return lines.join('\n')
}

/** 结构化 JSON（给模型/脚本消费）：只留判定与建议，不带 facts 大对象。 */
export function renderJson(report, { group, onlyProblems } = {}) {
  const items = (report?.results ?? []).filter((r) => {
    if (group && r.category !== group) return false
    if (onlyProblems && r.status !== 'issue') return false
    return true
  })
  const diagnoses = (report?.diagnoses ?? []).filter((d) => !group || d.category === group)
  return JSON.stringify(
    {
      generatedAt: report?.generatedAt,
      durationMs: report?.durationMs,
      summary: report?.summary,
      coverage: report?.coverage ?? coverageSnapshot(),
      bundleSources: report?.bundleSources,
      mode: report?.mode,
      diagnoses,
      plans: report?.plans,
      inference: report?.inference ? { unmatched: report.inference.unmatched, stats: report.inference.stats } : undefined,
      results: items,
      frontend: report?.frontend,
    },
    null,
    2,
  )
}

export default { renderMarkdown, renderCompact, renderJson, summaryLine, statusIcon, statusLabel, worstCheck }
