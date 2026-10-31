/** Coverage counts executed judgments, never invents a file count from rules. */
import { CATEGORIES } from './diag.js'
export function buildCoverage({ results = [], rules = [], facts, generatedAt, categories, collectionFailed = false } = {}) {
  const groups = CATEGORIES.map((id) => {
    const expected = rules.filter((r) => r.category === id)
    const rows = results.filter((r) => r.category === id)
    const group = { id, ran: 0, skipped: 0, unknown: 0, failed: 0, filesInspected: null, state: 'unverified', reasons: [], checkedAt: generatedAt ?? null }
    const reason = (ruleId, code) => group.reasons.push({ id: ruleId, reason: code })
    if (collectionFailed) { group.failed = 1; reason('collection', 'collection-failed') }
    else if (categories && !categories.includes(id)) { group.skipped = expected.length || 1; reason('group', 'category-not-requested') }
    else {
      for (const row of rows) {
        if (row.data?.executionFailed || /-ERROR$/.test(row.id)) { group.failed++; reason(row.data?.ruleId ?? row.id, 'rule-execution-failed') }
        else if (row.data?.skipped === true || row.status === 'skip') { group.skipped++; reason(row.id, 'not-applicable-or-not-collected') }
        else if (row.status === 'unknown') { group.unknown++; reason(row.id, 'insufficient-evidence-see-result') }
        else if (['pass', 'issue'].includes(row.status)) group.ran++
        else { group.unknown++; reason(row.id, 'unsupported-result-status') }
      }
      const present = new Set(rows.map((r) => r.data?.ruleId ?? r.id))
      const missing = expected.filter((r) => !present.has(r.id))
      group.unknown += missing.length
      for (const rule of missing) reason(rule.id, 'result-not-recorded')
      if (!rows.length && !missing.length) { group.unknown++; reason('group', 'execution-not-recorded') }
    }
    if (!collectionFailed && (!categories || categories.includes(id))) {
      if (id === 'logs' && facts?.logs?.errors?.length) { group.failed++; reason('collection', 'log-collection-errors') }
      if (id === 'connectivity' && facts?.connectivity?.available === false) { group.failed++; reason('collection', 'connectivity-collection-unavailable') }
      if (id === 'plugins' && facts?.installer?.available === false) { group.failed++; reason('collection', 'installer-collection-unavailable') }
      if (id === 'plugins' && facts?.configuration?.bundleSources && facts.configuration.bundleSources.status !== 'verified-subset') { group.unknown++; reason('bundle-metadata', 'bundle-declarations-incomplete') }
    }
    if (id === 'plugins' && Number.isSafeInteger(facts?.configuration?.bundleSources?.filesInspected)) {
      group.filesInspected = facts.configuration.bundleSources.filesInspected
      group.filesInspectedScope = 'bundle-metadata-only'
    }
    group.state = group.failed ? 'failed' : group.ran ? group.unknown || group.skipped ? 'partial' : 'complete' : 'unverified'
    return group
  })
  return { version: 1, scope: 'scan', generatedAt: generatedAt ?? null, source: 'fresh-scan', stale: false, groups }
}
export function coverageSnapshot(coverage, { now = Date.now(), cache = false, ttlMs = 15000 } = {}) {
  if (!coverage) return { version: 1, scope: 'scan', generatedAt: null, source: 'legacy-snapshot', stale: true,
    groups: CATEGORIES.map((id) => ({ id, ran: 0, skipped: 0, unknown: 1, failed: 0, filesInspected: null, state: 'unverified', reasons: [{ id: 'group', reason: 'coverage-not-recorded' }], checkedAt: null })) }
  const age = now - Date.parse(coverage.generatedAt)
  const stale = !Number.isFinite(age) || age > ttlMs || coverage.stale === true
  return { ...coverage, source: cache ? 'cached-scan' : coverage.source, stale,
    groups: coverage.groups.map((group) => stale ? { ...group, state: 'unverified', reasons: [...group.reasons, { id: 'group', reason: 'stale-evidence' }] } : group) }
}
export function coverageLine(coverage) {
  if (!coverage) return '检查覆盖：旧快照未记录覆盖，未核实。'
  const sum = coverage.groups.reduce((out, row) => { for (const key of ['ran', 'skipped', 'unknown', 'failed']) out[key] += row[key]; return out }, { ran: 0, skipped: 0, unknown: 0, failed: 0 })
  return `检查覆盖（${coverage.scope} / ${coverage.source}${coverage.stale ? ' / 过期' : ''}）：执行 ${sum.ran} · 跳过 ${sum.skipped} · 未知 ${sum.unknown} · 采集/执行失败 ${sum.failed}；文件数仅见分组实际测量。`
}
