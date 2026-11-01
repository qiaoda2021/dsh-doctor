/** Maintainer-only fixed evidence contract; never imported by automatic diagnostics. */
export const MATRIX_CASES = ['win32', 'linux', 'darwin'].flatMap((os) => [22, 24].flatMap((node) => ['current-sdk', 'rc4'].map((host) => ({ id: `${os}-node${node}-${host}`, os, node, host }))))
export const EXPECTED_STEPS = ['owner-auth-bootstrap', 'anonymous-get', 'anonymous-post', 'independent-api-peer-minted', 'api-peer-get', 'api-peer-post', 'wrong-origin', 'wrong-host', 'missing-ui-header', 'wrong-content-type', 'malformed-json', 'old-epoch', 'old-revision', 'duplicate-module', 'sensitive-field', 'oversized-content-length', 'oversized-chunked-body', 'stream-limit-rejects-before-request-eof', 'owner-report-snapshot-and-tool-agree', 'duplicate-sequence', 'out-of-order', 'third-party-mount-forgery', 'third-party-render-error-with-unknown-mount', 'graph-revision-change-invalidates-browser-evidence', 'unload-and-remount-revokes-old-epoch', 'privacy-output']
const validHostVersion = (value) => typeof value === 'string' && value.length <= 180 && value.trim() === value && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)
export function judgeMatrixReport(report, { exitCode, timedOut = false, expected, startedAt, finishedAt } = {}) {
  const result = { status: 'failed', reason: 'report-missing-or-invalid', exitCode: exitCode ?? null, timedOut, passed: 0, failed: 0, cleanup: false,
    startedAt: report?.startedAt ?? null, finishedAt: report?.finishedAt ?? null, actual: report?.runtimeInfo ?? null }
  const steps = Array.isArray(report?.steps) ? report.steps : [], ids = steps.map((s) => s?.id)
  result.passed = steps.filter((s) => s?.ok === true).length
  result.failed = steps.filter((s) => s?.ok !== true).length
  result.cleanup = report?.isolation?.homeRemoved === true && report?.isolation?.listenerClosed === true && report?.isolation?.realProfileTouched === false
  if (timedOut) return { ...result, reason: 'timeout' }
  if (exitCode !== 0) return { ...result, reason: 'process-exit-nonzero-or-missing' }
  if (!report || !Array.isArray(report.steps) || !report.runtimeInfo) return result
  const start = Date.parse(report.startedAt), finish = Date.parse(report.finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start || (startedAt && start < Date.parse(startedAt) - 2000) || (finishedAt && finish > Date.parse(finishedAt) + 2000)) return { ...result, reason: 'report-time-unverified' }
  if (!EXPECTED_STEPS.every((id) => ids.includes(id)) || new Set(ids).size !== ids.length) return { ...result, reason: 'required-steps-missing-or-duplicate' }
  if (report.passed !== result.passed || report.failed !== result.failed || result.failed > 0 || report.ok !== true) return { ...result, reason: 'assertions-failed-or-counts-inconsistent' }
  if (!result.cleanup) return { ...result, reason: 'cleanup-incomplete' }
  const actual = report.runtimeInfo
  if (typeof actual.node !== 'string' || !/^v\d+\.\d+\.\d+/.test(actual.node) || !actual.arch || !actual.osRelease || !validHostVersion(actual.host)) return { ...result, reason: 'actual-runtime-unverified' }
  if (expected && (actual.platform !== expected.os || Number(/^v(\d+)/.exec(actual.node)?.[1]) !== expected.node || (expected.host === 'rc4' && actual.host !== '0.2.1-rc.4'))) return { ...result, reason: 'actual-runtime-mismatch' }
  return { ...result, status: 'passed', reason: 'executed-and-cleaned' }
}
export function summarizeMatrix(rows, historical = []) {
  const counts = { passed: 0, failed: 0, pending: 0 }
  for (const row of rows) counts[['passed', 'failed'].includes(row.status) ? row.status : 'pending']++
  return { status: counts.failed ? 'failed' : counts.pending ? 'pending' : 'passed', counts, historicalCount: historical.length }
}
export function renderMatrix(report) {
  const cell = (v) => String(v ?? '—').replace(/[|\r\n]/g, ' ')
  return ['# 固定验证矩阵（维护者开发面）', '', `时间：${report.generatedAt} · 候选 ${report.version} · ${report.summary.status}`,
    '只读规划不算通过。亲跑、历史导入分开；不代表真实 profile 安装、跨机或真人视觉。', '',
    '| 行 | 状态 | 来源 | 实际 Node / OS / Host | 退出码 | passed / failed | cleanup | 原因 |', '|---|---|---|---|---|---|---|---|',
    ...report.rows.map((r) => `| ${cell(r.id)} | ${cell(r.status)} | ${cell(r.source)} | ${cell(r.actual ? `${r.actual.node} / ${r.actual.platform}-${r.actual.arch} ${r.actual.osRelease} / ${r.actual.host}` : null)} | ${cell(r.exitCode)} | ${r.passed ?? 0} / ${r.failed ?? 0} | ${cell(r.cleanup)} | ${cell(r.reason)} |`), '',
    '## 历史导入（不计本轮通过）', ...report.historical.map((r) => `- ${cell(r.source)} · ${cell(r.status)} · ${cell(r.reason)} · ${cell(r.startedAt)} / ${cell(r.finishedAt)} · ${cell(r.actual ? `${r.actual.node}/${r.actual.platform}/${r.actual.host}` : null)} · exit=${cell(r.exitCode)} · ${r.passed ?? 0}/${r.failed ?? 0} · cleanup=${cell(r.cleanup)}`), ''].join('\n')
}
