/**
 * DSH Doctor — 故障推理层（设计文档模块 5「故障推理引擎」）
 *
 * ── 模块职责 ──────────────────────────────────────────────────────────
 * 输入一份已经跑完的体检报告（规则结果数组）与采集事实（facts），把「多条互相关联的 issue」
 * 收敛成少量「根因假设」（Diagnosis），并回答两个问题：
 *   1. 每条规则是被哪个根因解释的？           → byRule
 *   2. 还有哪些 issue 没被任何假设解释？         → unmatched（「还有什么没归因」的答案）
 * 本模块是纯函数：不读文件系统、不联网、不调用模型、不读 process/env，也不改任何东西。
 * 同一份输入永远得到同一份输出 —— 唯一例外是 stats.elapsedMs 这个纯耗时字段。
 *
 * ── 输入契约 ──────────────────────────────────────────────────────────
 *   inferDiagnoses({ results, facts, summary? }, options?)
 *   - results : DiagnosticResult[]（lib/diag.js 的结构）。runDoctor 的返回值里字段名就是
 *               `results`（唯一真源），`checks` 只是 toLegacyCheck 派生的兼容视图；把 checks
 *               传进来也能跑（状态会被  ok→pass / skip→unknown / warn→issue / fail→issue
 *               映射回来），但请优先传 results。
 *   - facts   : collectFacts 的返回值。允许 {}，允许缺任意字段（缺字段只会让判据变成
 *               「证据缺失」，不会抛异常，也不会被当成 pass）。
 *   - summary : 可省，本层不消费（留给未来「按总得分降噪」用）。
 *   - 也接受直接传整份报告：inferDiagnoses({ report }) 会自动取 report.results / report.facts。
 *   - options : { minConfidence = 0.4, maxDiagnoses = 12, rules?: string[]（只考虑这些规则 id） }
 *
 * ── 置信度公式（规则加权分，不是统计概率）────────────────────────────────
 *   confidence = clamp( base
 *                     + 0.12 × 成立的 supports 条数
 *                     + 0.10 × (requires 是否全部为 issue ? 1 : 0)
 *                     - 0.15 × 证据缺失条数,
 *                     0.05, 0.95 )
 *
 *   - base：每条假设人工给 0.45~0.60，表示「在没有任何额外证据时，这条假设值不值得先查」。
 *   - 成立的 supports：supports 是一组写死的纯数据判据（只看 results / facts），
 *     返回真值即成立。0.12 是「多一条独立证据加多少分」，不是学习出来的参数。
 *   - requires 全 issue 的 0.10：整条假设需要的规则全部落在 issue，才给这个加成。
 *   - 证据缺失：requires 里状态为 unknown（或压根没出现在结果里）的条数 +
 *     supports 返回 { missing } 的条数。缺失既不加分也不否定，只在 summary 里写明
 *     「另有 N 条证据缺失」，让人知道这条结论有多少是靠推理补的。
 *   - **这是规则加权分**：每条 support 是人工写死的判据，权重是写死的常数。它不表达
 *     「真凶是它的概率」，只表达「在这套判据下，这条假设被多少条独立证据支持」。
 *     所以不要拿它做跨版本比较，也不要拟合分布 —— 要改判据就改 supports，
 *     改完看 tests 里的场景是否仍然过。
 *   - 低于 options.minConfidence 的假设直接丢弃：这是设计，不是漏判。证据不够就不下结论，
 *     比给一条 0.2 分的「可能吧」更有用；被丢掉的规则会出现在 unmatched 里。
 *
 * ── 为什么诊断与修复分离 ──────────────────────────────────────────────
 * 本层只产出「假设 + 下一步验证什么（nextChecks）+ 一句话修复提示（repairHint）」，
 * 绝不执行动作、也不假装自己有修复能力：
 *   - 诊断错了的代价是「多查一次」，修复错了的代价常常不可逆，两者不能同层；
 *   - 修复必须显式确认（L2）并留备份与回滚（见 lib/repair-secrets.js 的 secret-cleanup）；
 *   - repairHint 只填本插件**确实已有**的修复动作 id，没有就 null —— 不让界面出现
 *     「修一下」按钮却找不到实现。
 *
 * ── 判据的三态约定 ────────────────────────────────────────────────────
 *   support 返回值：
 *     false / null / 0 / undefined  → 不成立（这条证据不存在）
 *     true 或 { text, rule? }        → 成立（有文本就进 evidence，rule 进 affectedRules）
 *     { missing: '说明' }            → 无法判定（事实缺字段）。计入「证据缺失」，不是否定。
 *   requires 语义：
 *     任一 required 规则 status === 'pass'  → 整条假设不成立（有反证）；
 *     status === 'unknown' 或不存在         → 不计入也不否定，只算证据缺失；
 *     requires 非空时必须至少有一条 issue   → 否则没有可解释的对象，直接跳过。
 */

export const INFERENCE_VERSION = '1.0.0'

/**
 * 与 lib/diag.js 的 CATEGORIES 保持一致。
 * 本文件刻意不 import 任何东西（连 node: 内置都不需要），保证可以被单测/脚本直接注入，
 * 也避免推理层与展示层互相拖死。**新增类别时两处都要改。**
 */
const ALLOWED_CATEGORIES = [
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

/** 严重度排序：数字越小越严重（与 diag.js 的 rankResults 一致）。 */
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 }

/** 置信度权重。改这里等于同时改所有假设的分数，改之前先看 tests 里的 5 个场景。 */
const WEIGHT = {
  support: 0.12,
  requires: 0.1,
  missing: 0.15,
  floor: 0.05,
  ceiling: 0.95,
}

/**
 * 与 lib/rules.js 的 BLOCKING_CODES 对应的子集：这些分类码表示「网络层根本没通」。
 * 故意不含 'unknown' 和 service 侧代码（rate-limit/quota/server/client/not-found）——
 * 那些属于「网络通了、服务侧有状况」，是 provider-auth-or-quota 的判据，不是出口被墙的证据。
 */
const EGRESS_BLOCKING_CODES = new Set(['timeout', 'dns', 'tls', 'refused', 'reset', 'proxy', 'abort'])

/** 服务侧分类码：网络已通，问题在凭据/配额/对端。 */
const SERVICE_CODES = new Set(['rate-limit', 'quota', 'server', 'client', 'not-found'])

/** 崩溃相关的日志聚类 kind（与 lib/rules.js DSH-LOG-003 的 CRASH_KINDS 一致）。 */
const CRASH_KINDS = ['host-exit', 'web-boot-inactive']

/** DSH 日志里代表「网络层失败」的聚类 kind。 */
const NETWORK_CLUSTER_KINDS = ['dns-lookup-failed', 'network-timeout', 'connection-reset']

/* ------------------------------------------------------------------ *
 * 0. 小工具（全部防御式：输入可能是垃圾）
 * ------------------------------------------------------------------ */

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const asArray = (value) => (Array.isArray(value) ? value : [])

function textOf(value, fallback = '') {
  return typeof value === 'string' && value ? value : fallback
}

/** 计数文案：有数字写「3 个」，没数字写「若干个」——不出现「若干 个」这种半截话。 */
function countText(count, unit) {
  const n = num(count)
  return n !== undefined && n > 0 ? `${n} ${unit}` : `若干${unit}`
}

/** 只接受有限数字，其余一律 undefined —— 免得 NaN 混进排序与文案。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low
  return Math.min(high, Math.max(low, value))
}

function round2(value) {
  return Number((Math.round(value * 100) / 100).toFixed(2))
}

function fmtBytes(value) {
  const n = num(value)
  if (n === undefined || n < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function fmtPct(ratio) {
  const n = num(ratio)
  if (n === undefined) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const key = String(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** 把多条规则的摘要拼成一句（顺序稳定：调用方给什么顺序就是什么顺序）。 */
function joinSummaries(list, limit = 3) {
  return list.slice(0, limit).join('；')
}

/* ------------------------------------------------------------------ *
 * 1. 输入规范化
 * ------------------------------------------------------------------ */

/** 兼容 toLegacyCheck：ok/skip/warn/fail → pass/unknown/issue。 */
function normalizeStatus(raw) {
  switch (textOf(raw)) {
    case 'issue':
    case 'fail':
    case 'warn':
      return 'issue'
    case 'pass':
    case 'ok':
      return 'pass'
    case 'unknown':
    case 'skip':
      return 'unknown'
    default:
      return 'unknown'
  }
}

function normalizeSeverity(raw, legacyStatus) {
  const value = textOf(raw)
  if (value === 'error' || value === 'warning' || value === 'info') return value
  if (textOf(legacyStatus) === 'fail') return 'error'
  if (textOf(legacyStatus) === 'warn') return 'warning'
  return 'info'
}

/** 同 id 重复出现时取更严重的一条：issue > unknown > pass；同级取 severity 更重者。 */
function pickWorse(current, next) {
  const statusRank = { issue: 0, unknown: 1, pass: 2 }
  const a = statusRank[current.status] ?? 3
  const b = statusRank[next.status] ?? 3
  if (b < a) return next
  if (b > a) return current
  const sa = SEVERITY_RANK[current.severity] ?? 3
  const sb = SEVERITY_RANK[next.severity] ?? 3
  return sb < sa ? next : current
}

function normalizeResults(raw) {
  const map = new Map()
  for (const item of asArray(raw)) {
    if (!isObject(item)) continue
    const id = textOf(item.id)
    if (!id) continue
    const status = normalizeStatus(item.status)
    const row = {
      id,
      status,
      severity: normalizeSeverity(item.severity, item.status),
      category: textOf(item.category, textOf(item.group, 'environment')),
      title: textOf(item.title),
      summary: textOf(item.summary, textOf(item.detail)),
      evidence: asArray(item.evidence).map((e) => String(e)).filter(Boolean),
      data: isObject(item.data) ? item.data : undefined,
    }
    const previous = map.get(id)
    map.set(id, previous ? pickWorse(previous, row) : row)
  }
  return [...map.values()]
}

/** options 规范化：非法值一律回到默认，不抛异常。 */
function normalizeOptions(options) {
  const src = isObject(options) ? options : {}
  const minConfidence = num(src.minConfidence)
  const maxDiagnoses = num(src.maxDiagnoses)
  const rules = Array.isArray(src.rules) ? new Set(src.rules.map((r) => String(r)).filter(Boolean)) : undefined
  return {
    minConfidence: minConfidence === undefined ? 0.4 : clamp(minConfidence, 0, 1),
    maxDiagnoses: maxDiagnoses === undefined ? 12 : Math.max(0, Math.floor(maxDiagnoses)),
    rules,
  }
}

/**
 * 输入可能整份报告、可能是空对象、可能是 null。
 * 这里只做「取到能用的两个数组/对象」，其余交给判据自己判断缺失。
 */
function normalizeInput(input) {
  const src = isObject(input) ? input : {}
  const report = isObject(src.report) ? src.report : undefined
  const resultsRaw = Array.isArray(src.results) ? src.results : report?.results
  const factsRaw = isObject(src.facts) ? src.facts : report?.facts
  return {
    results: normalizeResults(resultsRaw),
    facts: isObject(factsRaw) ? factsRaw : {},
    summary: isObject(src.summary) ? src.summary : undefined,
  }
}

/* ------------------------------------------------------------------ *
 * 2. 上下文（所有判据共享的只读视图）
 * ------------------------------------------------------------------ */

/** 把 logs.clusters 与 logs.clustersOutsideWindow 按 kind 聚起来，给判据一个稳定入口。 */
function buildClusterIndex(facts) {
  const map = new Map()
  const push = (list, inWindow) => {
    for (const cluster of asArray(list)) {
      if (!isObject(cluster)) continue
      // 已自愈的聚类（logs.js markRevived：签名里点名的模块现在存在）不参与归因，
      // 否则「测试脚本 3 分钟前的 import 失败」会被当成「包安装不完整」的证据。
      if (cluster.revived === true) continue
      const kind = textOf(cluster.kind)
      if (!kind) continue
      const count = num(cluster.count) ?? 1
      const sample = textOf(cluster.sample)
      const previous = map.get(kind)
      if (!previous) {
        map.set(kind, { kind, count, sample, inWindow, signatures: 1 })
        continue
      }
      previous.count += count
      previous.signatures += 1
      if (inWindow) previous.inWindow = true
      // 样例取最短的那条：最短往往就是最干净的「错误首行」
      if (sample && (!previous.sample || sample.length < previous.sample.length)) previous.sample = sample
    }
  }
  push(facts?.logs?.clusters, true)
  push(facts?.logs?.clustersOutsideWindow, false)
  return map
}

/** 目标标签：targets 里找不到就退回 targetId 本身。 */
function labelOfTarget(conn, targetId) {
  const target = asArray(conn?.targets).find((t) => isObject(t) && t.id === targetId)
  return textOf(target?.label, textOf(targetId, '未命名接入点'))
}

/**
 * TCP 探测失败的分类码。
 *
 * 错误文本来自 `connectivity.js` 的 `describeError`（`<code>: <message>`）：
 * - 只有**明确** `ECONNREFUSED` 才叫 `refused`；
 * - 超时（`ETIMEDOUT` / `ESOCKETTIMEDOUT` / `超时` / timed out）叫 `timeout`；
 * - 其余（包括没有 error 字段）一律 `unknown` —— 没证据不能写成「对端拒绝」。
 *
 * 旧实现把 TCP 失败一律写死成 `refused`，会把超时误写为「对端拒绝连接」。
 * TCP/TLS 是不同时刻的独立连接，二者结果不一致本身并不构成逻辑矛盾。
 */
function classifyTcpFailureCode(tcp) {
  if (!isObject(tcp)) return 'unknown'
  const text = [tcp.error, tcp.detail, tcp.code]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
  if (!text) return 'unknown'
  if (/ECONNREFUSED/i.test(text)) return 'refused'
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout|timed?\s*out|超时/i.test(text)) return 'timeout'
  return 'unknown'
}

/**
 * 出口被挡或网络层没通的接入点。
 * 刻意排除 local 目标：本机 Ollama 没启动是「可选组件没开」（DSH-NET-004 的 info），
 * 不是「境外接入点被墙」，混进来会让每个没装本地模型的人都看到一条 error。
 */
function blockedTargetsOf(conn) {
  const out = []
  if (!isObject(conn) || conn.available === false) return out
  const targets = asArray(conn.targets)
  const isLocal = (targetId) => Boolean(targets.find((t) => isObject(t) && t.id === targetId && t.local))
  for (const result of asArray(conn.results)) {
    if (!isObject(result)) continue
    if (isLocal(result.targetId)) continue
    const code = textOf(result.probes?.http?.classification?.code)
    const dnsFailed = textOf(result.probes?.dns?.status) === 'fail'
    const tcpFailed = textOf(result.probes?.tcp?.status) === 'fail'
    if (code && EGRESS_BLOCKING_CODES.has(code)) out.push({ targetId: result.targetId, stage: 'http', code })
    else if (dnsFailed) out.push({ targetId: result.targetId, stage: 'dns', code: 'dns' })
    else if (tcpFailed) out.push({ targetId: result.targetId, stage: 'tcp', code: classifyTcpFailureCode(result.probes?.tcp) })
  }
  return out
}

/** 服务侧有状况的接入点（网络已通，401/429/5xx/路径错）。 */
function serviceTargetsOf(conn) {
  const out = []
  if (!isObject(conn) || conn.available === false) return out
  for (const result of asArray(conn.results)) {
    if (!isObject(result)) continue
    const code = textOf(result.probes?.http?.classification?.code)
    if (!code || !SERVICE_CODES.has(code)) continue
    out.push({
      targetId: result.targetId,
      label: labelOfTarget(conn, result.targetId),
      code,
      status: num(result.probes?.http?.httpStatus),
    })
  }
  return out
}

function makeContext(results, facts, byId) {
  const clusters = buildClusterIndex(facts)
  const conn = isObject(facts?.connectivity) ? facts.connectivity : undefined
  const proxy = isObject(conn?.proxy) ? conn.proxy : undefined
  const runtime = isObject(facts?.runtime) ? facts.runtime : undefined
  const totalMemBytes = num(runtime?.totalMemBytes)
  const freeMemBytes = num(runtime?.freeMemBytes)
  const memRatio =
    totalMemBytes !== undefined && totalMemBytes > 0 && freeMemBytes !== undefined ? freeMemBytes / totalMemBytes : undefined

  return {
    results,
    facts,
    byId,
    clusters,
    blockedTargets: blockedTargetsOf(conn),
    serviceTargets: serviceTargetsOf(conn),
    proxyDetected: typeof proxy?.detected === 'boolean' ? proxy.detected : undefined,
    memRatio,
    totalMemBytes,
    freeMemBytes,
    issueResults: results.filter((r) => r.status === 'issue'),
    rule(id) {
      return byId.get(textOf(id))
    },
    status(id) {
      return byId.get(textOf(id))?.status
    },
    summaryOf(id) {
      return textOf(byId.get(textOf(id))?.summary)
    },
    titleOf(id) {
      return textOf(byId.get(textOf(id))?.title)
    },
    dataOf(id) {
      const data = byId.get(textOf(id))?.data
      return isObject(data) ? data : undefined
    },
    cluster(kind) {
      return clusters.get(textOf(kind))
    },
    clusterTotal(kinds) {
      let total = 0
      const found = []
      for (const kind of asArray(kinds)) {
        const cluster = clusters.get(textOf(kind))
        if (!cluster) continue
        total += cluster.count
        found.push(cluster)
      }
      return { total, found }
    },
    /** 任意聚类样例命中正则 → 返回该聚类（用于 OOM / ABI 不匹配这类文本判据）。 */
    clusterBySample(pattern) {
      if (!(pattern instanceof RegExp)) return undefined
      for (const cluster of clusters.values()) {
        if (cluster.sample && pattern.test(cluster.sample)) return cluster
      }
      return undefined
    },
  }
}

/* ------------------------------------------------------------------ *
 * 3. 判据（supports）
 *    统一签名：(results, facts, ctx) => false | true | { text, rule? } | { missing }
 * ------------------------------------------------------------------ */

/** DSH-NET-003 显示没有代理 —— 境外不可达最常见的解释。 */
function supportProxyAbsent(results, facts, ctx) {
  if (ctx.proxyDetected === false) {
    return {
      text: 'DSH-NET-003 / facts.connectivity.proxy.detected=false：HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 全空',
      rule: 'DSH-NET-003',
    }
  }
  const rule = ctx.rule('DSH-NET-003')
  if (rule && rule.status === 'issue') {
    return { text: `DSH-NET-003 判为 issue：${rule.summary || '代理设置异常'}`, rule: 'DSH-NET-003' }
  }
  if (ctx.proxyDetected === true) return false // 配了代理还连不上，说明不是「没配代理」
  return { missing: 'facts.connectivity.proxy 缺失，无法判断本机是否配置了代理' }
}

/** 日志里成簇的 fetch failed —— 网络层失败的直接证据。 */
function supportFetchFailedCluster(results, facts, ctx) {
  const cluster = ctx.cluster('fetch-failed')
  if (!cluster) {
    if (!isObject(facts?.logs)) return { missing: 'facts.logs.clusters 缺失，无法确认日志里是否有 fetch failed' }
    return false
  }
  return {
    text: `日志聚类 fetch-failed ×${cluster.count}${cluster.inWindow ? '（窗口内）' : '（窗口外）'}：${cluster.sample || '—'}`,
  }
}

/** DNS / 超时 / 连接重置 聚类：出口被挡的旁证（与 fetch failed 不同的判据）。 */
function supportNetworkClusters(results, facts, ctx) {
  const { total, found } = ctx.clusterTotal(NETWORK_CLUSTER_KINDS)
  if (!found.length) return false
  const labels = found.map((c) => `${c.kind}×${c.count}`).join('、')
  return { text: `日志聚类：${labels}（合计 ${total} 次网络层失败）` }
}

/** 四步探测里 DNS/TCP/TLS/HTTP 阶段失败的接入点（排除本地端点）。 */
function supportProbeBlocked(results, facts, ctx) {
  const conn = facts?.connectivity
  if (!isObject(conn) || conn.available === false) return { missing: 'facts.connectivity 不可用，读不到四步探测结果' }
  const blocked = ctx.blockedTargets
  if (!blocked.length) return false
  const detail = blocked
    .slice(0, 4)
    .map((b) => `${labelOfTarget(conn, b.targetId)}（${b.stage}/${b.code}）`)
    .join('、')
  return { text: `facts.connectivity.results：${blocked.length} 个接入点在 ${detail} 处失败` }
}

/** 插件未声明支持当前 DSH（facts 侧细节，比规则摘要更能定位到具体插件）。 */
function supportBadCompatPlugins(results, facts, ctx) {
  const plugins = asArray(facts?.configuration?.plugins)
  const bad = plugins.filter((p) => isObject(p) && p.compat?.declared && p.compat.ok === false)
  if (!bad.length) return false
  const version = textOf(facts?.install?.dshVersion, '当前 DSH 版本')
  const names = bad.slice(0, 4).map((p) => `${p.name}@${p.version ?? '?'}（只声明 ${p.compat.range ?? '?'}）`)
  return {
    text: `facts.configuration.plugins：${bad.length} 个插件未覆盖 ${version} —— ${names.join('、')}`,
    rule: 'DSH-PLG-003',
  }
}

/** 兼容区间无法判定的插件：不是坏，但升级后异常要先怀疑它们。 */
function supportUndecidedCompatPlugins(results, facts, ctx) {
  const plugins = asArray(facts?.configuration?.plugins)
  const undecided = plugins.filter((p) => isObject(p) && p.compat?.declared && p.compat.ok === undefined)
  if (!undecided.length) return false
  return {
    text: `facts.configuration.plugins：${undecided.length} 个插件声明了 compatibility.dsh 但区间无法判定（${undecided
      .slice(0, 4)
      .map((p) => p.name)
      .join('、')}）`,
    rule: 'DSH-PLG-003',
  }
}

/** 模块解析失败聚类：插件入口/依赖没装齐，最典型的「装坏了」。 */
function supportModuleNotFoundCluster(results, facts, ctx) {
  const cluster = ctx.cluster('module-not-found')
  if (!cluster) return false
  return { text: `日志聚类 module-not-found ×${cluster.count}：${cluster.sample || '—'}` }
}

/** pnpm 归并依赖冲突：装了两个互相不兼容的版本。 */
function supportPeerDependencyCluster(results, facts, ctx) {
  const cluster = ctx.cluster('peer-dependency')
  if (!cluster) return false
  return { text: `日志聚类 peer-dependency ×${cluster.count}：${cluster.sample || '—'}` }
}

/** 补丁行引用的包找不到（优先用 facts 的明细，退回规则的 data.missing）。 */
function supportPatchRowsMissing(results, facts, ctx) {
  const missing = asArray(facts?.configuration?.missingPackages)
  const rule = ctx.rule('DSH-CFG-003')
  if (!missing.length && rule?.status !== 'issue') return false
  const fromData = asArray(ctx.dataOf('DSH-CFG-003')?.missing)
  const names = missing.length ? missing.map((m) => textOf(m?.name)) : fromData.map((n) => String(n))
  const cleaned = names.filter(Boolean)
  return {
    text: `DSH-CFG-003 / facts.configuration.missingPackages：${countText(cleaned.length, '个')}补丁行引用的包在 profile 与宿主 node_modules 里都找不到${
      cleaned.length ? `（${cleaned.slice(0, 4).join('、')}）` : ''
    }`,
    rule: 'DSH-CFG-003',
  }
}

/** profile manifest 与 lockfile 的精确依赖版本不一致。只归因，不生成重写计划。 */
function supportDependencyLockDrift(results, facts, ctx) {
  const drift = asArray(facts?.configuration?.lockDrift).filter(isObject)
  if (!drift.length) return false
  return {
    text: `facts.configuration.lockDrift：${drift.length} 个依赖与 lockfile 不一致（${drift
      .slice(0, 6)
      .map((item) => `${textOf(item.name, '未命名依赖')}@${textOf(item.spec, '?')}`)
      .join('、')}）`,
    rule: 'DSH-PLG-004',
  }
}

/** 插件声明了 dsh.bundle.patch，但补丁文件不在 —— 安装不完整。 */
function supportBundlePatchMissing(results, facts, ctx) {
  const plugins = asArray(facts?.configuration?.plugins)
  const broken = plugins.filter((p) => isObject(p) && p.declaredPatch && p.patchExists === false)
  const rule = ctx.rule('DSH-PLG-002')
  if (!broken.length && rule?.status !== 'issue') return false
  const names = broken.length ? broken.map((p) => `${p.name} → ${p.declaredPatch}`) : asArray(ctx.dataOf('DSH-PLG-002')?.broken)
  return {
    text: `DSH-PLG-002 / facts.configuration.plugins：${countText(broken.length || names.length, '个')}插件声明的 bundle 补丁文件缺失（${names
      .slice(0, 3)
      .join('、')}）`,
    rule: 'DSH-PLG-002',
  }
}

/** file:/link: 引用的本地包还没 link 进 profile —— 本地开发最常见的「看起来装了其实没装」。 */
function supportLocalPackageUnlinked(results, facts, ctx) {
  const missing = asArray(facts?.configuration?.missingPackages).filter((m) => isObject(m) && m.isLocalPath)
  if (!missing.length) return false
  return {
    text: `facts.configuration.missingPackages：${missing.length} 个本地包（file:/link:）尚未 link 进 profile（${missing
      .map((m) => m.name)
      .slice(0, 4)
      .join('、')}）`,
  }
}

/** 宿主 node_modules/@deepseek-ai 为空或不可读 —— 整个安装都不完整。 */
function supportHostPackagesUnreadable(results, facts, ctx) {
  const rule = ctx.rule('DSH-ENV-003')
  if (!rule || rule.status !== 'issue') return false
  return { text: `DSH-ENV-003：${rule.summary || '宿主 node_modules/@deepseek-ai 为空或不可读'}`, rule: 'DSH-ENV-003' }
}

/** profile/package.json 缺失或 JSON 解析失败。 */
function supportProfilePkgBroken(results, facts, ctx) {
  const rule = ctx.rule('DSH-CFG-004')
  if (!rule || rule.status !== 'issue') return false
  return { text: `DSH-CFG-004：${rule.summary || 'profile/package.json 缺失或解析失败'}`, rule: 'DSH-CFG-004' }
}

/** cordis.patch.yml 缺失或不可读。单看是弱证据（新 profile 会自动生成），所以只做 support。 */
function supportPatchFileMissing(results, facts, ctx) {
  const rule = ctx.rule('DSH-CFG-002')
  if (!rule || rule.status !== 'issue') return false
  return { text: `DSH-CFG-002：${rule.summary || 'cordis.patch.yml 缺失或不可读'}`, rule: 'DSH-CFG-002' }
}

/** 文件带 UTF-8 BOM：pnpm / DSH 解析会直接拒绝，是「配置看起来没写错却加载不了」的经典原因。 */
function supportBomDetected(results, facts, ctx) {
  const cfg = facts?.configuration
  const pkgBom = cfg?.profilePkgBom === true
  const patchBom = cfg?.patchBom === true
  if (!pkgBom && !patchBom) return false
  const targets = [pkgBom ? 'profile/package.json' : '', patchBom ? 'cordis.patch.yml' : ''].filter(Boolean)
  return {
    text: `facts.configuration：${targets.join(' 与 ')} 带 UTF-8 BOM（pnpm/DSH 会拒绝解析，需另存为无 BOM）`,
  }
}

/** profile 目录本身不可用：后面的配置项全都无从谈起。 */
function supportProfileDirUnusable(results, facts, ctx) {
  const rule = ctx.rule('DSH-CFG-001')
  if (!rule || rule.status !== 'issue') return false
  return { text: `DSH-CFG-001：${rule.summary || 'profile 目录不可用'}`, rule: 'DSH-CFG-001' }
}

/** 日志里确实扫到了密钥样式内容（明细来自 facts，比规则摘要多出「几个不同值」）。 */
function supportLeakFacts(results, facts, ctx) {
  const leaks = facts?.logs?.leaks
  const total = num(leaks?.total) ?? 0
  const rule = ctx.rule('DSH-SEC-003')
  if (total <= 0 && rule?.status !== 'issue') return false
  const unique = num(leaks?.unique)
  const types = Object.entries(isObject(leaks?.uniqueByType) ? leaks.uniqueByType : {})
    .filter(([, n]) => num(n) > 0)
    .map(([k, n]) => `${k}×${n}`)
    .join(' · ')
  return {
    text: `DSH-SEC-003 / facts.logs.leaks：出现 ${countText(total, '处')}疑似密钥${
      unique !== undefined ? `，去重后 ${unique} 个不同值` : ''
    }${types ? `（${types}）` : ''}`,
    rule: 'DSH-SEC-003',
  }
}

/** 命中分布在多个日志源：说明不是一次性误报，而是多个插件/会话都在打日志。 */
function supportLeakMultiSource(results, facts, ctx) {
  const sources = asArray(facts?.logs?.leaks?.bySource).filter(isObject)
  if (sources.length < 2) return false
  return {
    text: `facts.logs.leaks.bySource：命中分布在 ${sources.length} 个日志源（${sources
      .slice(0, 3)
      .map((s) => `${s.path}×${s.total}`)
      .join('、')}）`,
  }
}

/** bearer 类命中：典型是插件把 Authorization 头打进了日志。 */
function supportLeakBearer(results, facts, ctx) {
  const byType = isObject(facts?.logs?.leaks?.uniqueByType) ? facts.logs.leaks.uniqueByType : {}
  const bearer = num(byType.bearer) ?? 0
  if (bearer <= 0) return false
  return { text: `facts.logs.leaks.uniqueByType.bearer=${bearer}：疑似请求头/Token 被原样写进日志` }
}

/** 可用内存低于 5%（与 DSH-RUN-001 同阈值，但这里给绝对值，便于判断「差多少」）。 */
function supportLowMemFacts(results, facts, ctx) {
  const ratio = ctx.memRatio
  if (ratio === undefined) return { missing: 'facts.runtime 的 freeMemBytes/totalMemBytes 缺失，无法计算可用内存占比' }
  if (ratio >= 0.05) return false
  return {
    text: `facts.runtime：可用内存 ${fmtBytes(ctx.freeMemBytes)} / ${fmtBytes(ctx.totalMemBytes)}（${fmtPct(ratio)}，低于 5% 阈值）`,
    rule: 'DSH-RUN-001',
  }
}

/** 有崩溃快照/崩溃聚类 —— 内存吃紧的常见后果。 */
function supportCrashSnapshotRule(results, facts, ctx) {
  const rule = ctx.rule('DSH-LOG-003')
  if (!rule || rule.status !== 'issue') return false
  return { text: `DSH-LOG-003：${rule.summary || '存在宿主崩溃快照'}`, rule: 'DSH-LOG-003' }
}

/** 崩溃样例里出现 OOM/内存字样：把「资源吃紧」和「被系统杀掉」连起来。 */
function supportOomSample(results, facts, ctx) {
  const cluster = ctx.clusterBySample(/out of memory|oom|enomem|heap limit|allocation failed/i)
  if (!cluster) return false
  return { text: `日志聚类 ${cluster.kind} ×${cluster.count} 的样例含内存不足字样：${cluster.sample || '—'}` }
}

/** host-exit 反复出现（≥2 次）才是「循环」，1 次只是「崩过」。 */
function supportHostExitRepeated(results, facts, ctx) {
  const cluster = ctx.cluster('host-exit')
  if (!cluster || cluster.count < 2) return false
  return {
    text: `日志聚类 host-exit ×${cluster.count}${cluster.inWindow ? '（窗口内）' : '（窗口外）'}：${cluster.sample || '—'}`,
  }
}

/** host-exit / web-boot-inactive 任一出现。 */
function supportHostExitAny(results, facts, ctx) {
  const found = CRASH_KINDS.map((kind) => ctx.cluster(kind)).filter(Boolean)
  if (!found.length) return false
  return { text: `日志聚类：${found.map((c) => `${c.kind}×${c.count}`).join('、')}（宿主非正常退出）` }
}

/** 存在 crash-*.log 崩溃快照文件。 */
function supportCrashSources(results, facts, ctx) {
  const sources = asArray(facts?.logs?.sources).filter((s) => isObject(s) && s.kind === 'crash')
  if (!sources.length) return false
  return {
    text: `facts.logs.sources：${sources.length} 份崩溃快照（${sources
      .slice(0, 2)
      .map((s) => s.path)
      .join('、')}）`,
  }
}

/** engines.node 与 process.version 都在，判据才站得住。 */
function supportEnginesDeclared(results, facts, ctx) {
  const need = textOf(facts?.install?.enginesNode)
  const node = textOf(facts?.runtime?.node)
  if (!need || !node) return false
  return { text: `facts.install.enginesNode=${need} · facts.runtime.node=${node}`, rule: 'DSH-ENV-001' }
}

/** ABI/NODE_MODULE_VERSION 不匹配：换了 Node 之后原生模块直接加载不了。 */
function supportAbiMismatchCluster(results, facts, ctx) {
  const cluster = ctx.clusterBySample(/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different Node/i)
  if (!cluster) return false
  return { text: `日志聚类 ${cluster.kind} ×${cluster.count} 指向原生模块 ABI 不匹配：${cluster.sample || '—'}` }
}

/** 本地 Web 端口探测没通（facts 侧的端口与监听状态）。 */
function supportWebPortProbe(results, facts, ctx) {
  const web = facts?.web
  if (!isObject(web) || !textOf(web.url)) return false
  if (web.listening !== false) return false
  return {
    text: `facts.web：${web.url} 的端口 ${web.port ?? '?'} 探测未响应（listening=false）`,
    rule: 'DSH-NET-001',
  }
}

/** 运行模式是 web/desktop：本地端口本应存在。 */
function supportWebMode(results, facts, ctx) {
  const mode = textOf(facts?.mode?.value)
  if (mode !== 'web' && mode !== 'desktop') return false
  return { text: `facts.mode.value=${mode}：宿主应以本地 HTTP 端口对外提供服务` }
}

/** 端口占用聚类：多半是另一个实例还占着端口。 */
function supportPortInUseCluster(results, facts, ctx) {
  const cluster = ctx.cluster('port-in-use')
  if (!cluster) return false
  return { text: `日志聚类 port-in-use ×${cluster.count}：${cluster.sample || '—'}` }
}

/** 临时目录不可写。 */
function supportTempNotWritable(results, facts, ctx) {
  const rule = ctx.rule('DSH-WS-002')
  const tempWritable = facts?.workspace?.tempWritable
  if (rule?.status === 'issue') {
    return { text: `DSH-WS-002：${rule.summary || '临时目录不可写'}`, rule: 'DSH-WS-002' }
  }
  if (tempWritable === false) {
    return { text: `facts.workspace.tempWritable=false（${facts?.workspace?.tempDir ?? '临时目录'} 不可写）`, rule: 'DSH-WS-002' }
  }
  return false
}

/** 当前工作区不可访问。 */
function supportCwdInaccessible(results, facts, ctx) {
  const rule = ctx.rule('DSH-WS-001')
  const cwdExists = facts?.workspace?.cwdExists
  if (rule?.status === 'issue') {
    return { text: `DSH-WS-001：${rule.summary || '当前工作区不可访问'}`, rule: 'DSH-WS-001' }
  }
  if (cwdExists === false) {
    return { text: `facts.workspace.cwdExists=false（${facts?.workspace?.cwd ?? '工作区'}）`, rule: 'DSH-WS-001' }
  }
  return false
}

/** cwd 与 TEMP 是独立的写入目标；TEMP 的 pass 不是 cwd 的反证。 */
function supportCwdNotWritable(results, facts, ctx) {
  const rule = ctx.rule('DSH-WS-003')
  const ws = facts?.workspace
  const errorCode = textOf(ws?.cwdWriteError)
  const writeFailure = ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EDQUOT', 'EIO'].includes(errorCode)
  const errnoOnlyFailure = ws?.cwdWritable !== true && ws?.cwdExists === true && writeFailure
  if (rule?.status !== 'issue' && ws?.cwdWritable !== false && !errnoOnlyFailure) return false
  if (rule?.status !== 'issue' && ws?.cwdExists === false) return false
  const detail = textOf(ws?.cwdWriteDetail)
  return {
    text: `DSH-WS-003 / facts.workspace：工作区 ${textOf(ws?.cwd, '当前目录')} 写入失败${
      errorCode ? `（${errorCode}）` : ''
    }${detail ? `：${detail}` : rule?.summary ? `：${rule.summary}` : ''}`,
    rule: 'DSH-WS-003',
  }
}

/** 服务侧失败（429/402/5xx/4xx）：网络是通的，问题在凭据/配额/参数。 */
function supportServiceTargets(results, facts, ctx) {
  if (!ctx.serviceTargets.length) return false
  const detail = ctx.serviceTargets
    .slice(0, 4)
    .map((t) => `${t.label}（${t.code}${t.status ? ` HTTP ${t.status}` : ''}）`)
    .join('、')
  return { text: `facts.connectivity.results：${ctx.serviceTargets.length} 个接入点有服务侧状况 —— ${detail}` }
}

/** 日志里出现 401 / 429 聚类。 */
function supportHttpAuthClusters(results, facts, ctx) {
  const { total, found } = ctx.clusterTotal(['http-unauthorized', 'http-rate-limited'])
  if (!found.length) return false
  return { text: `日志聚类：${found.map((c) => `${c.kind}×${c.count}`).join('、')}（合计 ${total} 次，指向凭据或限流）` }
}

/** 既没有密钥环境变量也没有凭据文件。 */
function supportNoModelKey(results, facts, ctx) {
  const rule = ctx.rule('DSH-SEC-001')
  if (!rule || rule.status !== 'issue') return false
  return { text: `DSH-SEC-001：${rule.summary || '没有可用的模型密钥'}`, rule: 'DSH-SEC-001' }
}

/** 日志里「凭据不足」聚类。 */
function supportCredentialInsufficientCluster(results, facts, ctx) {
  const cluster = ctx.cluster('credential-insufficient')
  if (!cluster) return false
  return { text: `日志聚类 credential-insufficient ×${cluster.count}：${cluster.sample || '—'}` }
}

/* ------------------------------------------------------------------ *
 * 4. 假设表
 *    { id, title, category, severity, base, requires, supports, contradicts,
 *      minSupports?, summary(ctx), causes[], nextChecks[], repairHint }
 *
 *    - requires：AND 语义。任一为 pass 即否定整条；unknown 只算证据缺失。
 *    - supports：OR / 加权证据。返回 { missing } 的算证据缺口，不算成立。
 *    - minSupports：至少要有几条 support 成立才允许出结论（默认 0，仅用于
 *      「同一条规则能派生出两种互斥根因」的场景，例如 NET-002 的「被墙」vs「服务侧」）。
 *    - contradicts：这些规则若被别的假设引用，说明根因可能另有其人；
 *      输出时会翻成「已命中的竞争假设 id」写进 Diagnosis.contradicts。
 *    - severity 是**上限**：实际严重度取「已命中 issue 规则里最重的那条」，不会超过这里。
 * ------------------------------------------------------------------ */

export const HYPOTHESES = [
  {
    id: 'egress-blocked',
    // 标题只陈述「连不上」这个事实：代理有没有配置由 summary/evidence 分支说明。
    // 旧的「且未配置代理」是常量，proxyDetected=true 时与正文（「但本机已配置代理」）自相矛盾。
    title: '境外接入点不可达',
    category: 'connectivity',
    severity: 'error',
    base: 0.55,
    requires: ['DSH-NET-002'],
    minSupports: 1,
    supports: [supportProxyAbsent, supportFetchFailedCluster, supportNetworkClusters, supportProbeBlocked],
    contradicts: ['DSH-PLG-002', 'DSH-CFG-004'],
    summary(ctx) {
      const blocked = num(ctx.dataOf('DSH-NET-002')?.blocked) ?? ctx.blockedTargets.length
      const fetch = ctx.cluster('fetch-failed')?.count ?? 0
      const dnsTotal = ctx.clusterTotal(NETWORK_CLUSTER_KINDS).total
      const bits = [`${countText(blocked, '个')}远程接入点连不上`]
      if (fetch) bits.push(`日志里 fetch failed ${fetch} 次`)
      if (!fetch && dnsTotal) bits.push(`DNS/超时类错误 ${dnsTotal} 次`)
      if (ctx.proxyDetected === false) bits.push('且本机没有配置代理')
      else if (ctx.proxyDetected === true) bits.push('但本机已配置代理，需确认代理是否放行该域名')
      return `境外接入点不可达：${bits.join('，')}`
    },
    causes: [
      {
        cause: '访问境外 API 需要代理，但当前进程没有代理环境变量（或运行时 fetch 不读代理变量）',
        weight: 0.62,
        basis: 'DSH-NET-003 / facts.connectivity.proxy.detected',
      },
      {
        cause: 'DNS 被污染或企业网络/防火墙拦截了目标域名',
        weight: 0.45,
        basis: 'facts.connectivity.results 的 dns/tcp 阶段',
      },
      {
        cause: 'baseURL 写错，或对端服务已下线',
        weight: 0.28,
        basis: 'DSH-NET-002 的 evidence（四步探测明细）',
      },
    ],
    nextChecks: [
      '单独看四步卡在哪：`node scripts/connectivity-probe.mjs --pretty`（本机 node 由 Electron 提供：`$env:ELECTRON_RUN_AS_NODE=1; & "<DSH 安装目录>\\DeepSeek Harness.exe" scripts/connectivity-probe.mjs --pretty`）',
      '`Resolve-DnsName <目标域名>` 与 `nslookup <目标域名> 223.5.5.5` 对比，判断是否 DNS 污染',
      '`Test-NetConnection <目标域名> -Port 443` 看 TCP 是否能建连（不通就是出口被挡，不是密钥问题）',
      "设置代理后重试：`$env:HTTPS_PROXY='http://127.0.0.1:<端口>'; $env:HTTP_PROXY=$env:HTTPS_PROXY;` 再跑一次 connectivity-probe",
    ],
    repairHint: null,
  },

  {
    id: 'plugin-incompatible',
    title: '插件未声明支持当前 DSH 版本',
    category: 'plugins',
    severity: 'warning',
    base: 0.6,
    requires: ['DSH-PLG-003'],
    supports: [supportBadCompatPlugins, supportUndecidedCompatPlugins, supportModuleNotFoundCluster, supportPeerDependencyCluster],
    contradicts: ['DSH-PLG-002', 'DSH-CFG-003'],
    summary(ctx) {
      const version = textOf(ctx.facts?.install?.dshVersion, '当前 DSH 版本')
      const plugins = asArray(ctx.facts?.configuration?.plugins)
      const bad = plugins.filter((p) => isObject(p) && p.compat?.declared && p.compat.ok === false)
      const undecided = plugins.filter((p) => isObject(p) && p.compat?.declared && p.compat.ok === undefined)
      const bits = [`${countText(bad.length, '个')}插件未声明覆盖 ${version}`]
      if (undecided.length) bits.push(`${undecided.length} 个兼容区间无法判定`)
      const moduleMissing = ctx.cluster('module-not-found')
      const peer = ctx.cluster('peer-dependency')
      if (moduleMissing) bits.push(`日志里 module-not-found ${moduleMissing.count} 次`)
      if (peer) bits.push(`peer-dependency 冲突 ${peer.count} 次`)
      return `插件兼容性风险：${bits.join('，')}（未声明≠已坏，但升级后异常优先怀疑它们）`
    },
    causes: [
      {
        cause: '插件还没跟上 DSH 版本（rc 阶段常见），内部 API 变了',
        weight: 0.55,
        basis: 'DSH-PLG-003 / facts.configuration.plugins[].compat',
      },
      {
        cause: '插件已停更，或装的是与当前 DSH 不配套的旧版本',
        weight: 0.4,
        basis: '兼容区间与本机 dshVersion 比对结果',
      },
    ],
    nextChecks: [
      '先禁用可疑插件再体检：`plugin_manager set_plugin enabled=false target=<插件 id>`，确认问题是否消失',
      '核对插件声明的 `compatibility.dsh` 与本机 `dsh --version` / `facts.install.dshVersion` 是否一致',
      '把 `logs.clusters` 里的 module-not-found 样例贴给插件作者，比贴整份日志有效',
    ],
    repairHint: null,
  },

  {
    id: 'plugin-missing-or-broken',
    title: '包安装不完整：补丁行缺包 / 入口不可解析',
    category: 'plugins',
    severity: 'error',
    base: 0.55,
    // 补丁行缺包（CFG-003）与 bundle 补丁缺失（PLG-002）是**并列症状**：
    // 任一条 pass 都不能否证另一条，所以这里不用 requires（AND 语义会漏判），改用 supports 门控。
    requires: [],
    supports: [
      supportPatchRowsMissing,
      supportBundlePatchMissing,
      supportLocalPackageUnlinked,
      supportHostPackagesUnreadable,
      supportModuleNotFoundCluster,
    ],
    contradicts: ['DSH-PLG-003'],
    summary(ctx) {
      const missing = asArray(ctx.facts?.configuration?.missingPackages)
      const ruleMissing = asArray(ctx.dataOf('DSH-CFG-003')?.missing)
      const broken = asArray(ctx.facts?.configuration?.plugins).filter(
        (p) => isObject(p) && p.declaredPatch && p.patchExists === false,
      )
      const hostRule = ctx.rule('DSH-ENV-003')
      const bits = []
      if (missing.length || ruleMissing.length) bits.push(`${missing.length || ruleMissing.length} 个补丁行引用的包找不到`)
      if (broken.length) bits.push(`${broken.length} 个 bundle 补丁文件缺失`)
      if (hostRule && hostRule.status === 'issue') bits.push('宿主 @deepseek-ai 包不可读')
      const moduleMissing = ctx.cluster('module-not-found')
      if (moduleMissing) bits.push(`module-not-found ${moduleMissing.count} 次`)
      return `包安装不完整：${bits.length ? bits.join('，') : '补丁行或包入口无法解析'}`
    },
    causes: [
      {
        cause: '补丁行还在，但对应包已从 profile 依赖里移除（或没装成功）',
        weight: 0.6,
        basis: 'DSH-CFG-003 / facts.configuration.missingPackages',
      },
      {
        cause: '本地包用 file:/link: 引用，尚未 link 进 profile 的 node_modules',
        weight: 0.5,
        basis: 'facts.configuration.missingPackages[].isLocalPath',
      },
      {
        cause: 'pnpm 安装不完整（硬链接/打包漏文件），bundle 补丁或入口文件缺失',
        weight: 0.45,
        basis: 'DSH-PLG-002 / facts.configuration.plugins[].patchExists',
      },
      {
        cause: '宿主安装被清理过，node_modules/@deepseek-ai 为空',
        weight: 0.35,
        basis: 'DSH-ENV-003',
      },
    ],
    nextChecks: [
      '打开 `cordis.patch.yml`，把 DSH-CFG-003 evidence 里列出的行号与包名逐条核对',
      '重装受影响的插件（先 remove_bundle 再 install_bundle），本地包先 link 进 profile',
      '宿主包缺失时重装 DSH 运行时，而不是重装插件',
    ],
    repairHint: null,
  },

  {
    id: 'dependency-lock-mismatch',
    title: 'Profile 依赖清单与 lockfile 版本漂移',
    category: 'plugins',
    severity: 'warning',
    base: 0.55,
    requires: ['DSH-PLG-004'],
    supports: [supportDependencyLockDrift],
    contradicts: [],
    summary(ctx) {
      const drift = asArray(ctx.facts?.configuration?.lockDrift).filter(isObject)
      const names = drift.slice(0, 4).map((item) => `${textOf(item.name, '依赖')}@${textOf(item.spec, '?')}`)
      return `Profile 依赖清单与 lockfile 不一致：${names.length ? names.join('、') : ctx.summaryOf('DSH-PLG-004') || '精确版本缺少对应锁定项'}；插件安装、卸载或升级可能受阻，需人工核对`
    },
    causes: [
      { cause: '清单改动后依赖安装中断，lockfile 尚未同步', weight: 0.6, basis: 'DSH-PLG-004 / facts.configuration.lockDrift' },
      { cause: 'lockfile 被回退，或发布年龄等供应链策略阻止了目标版本解析', weight: 0.4, basis: 'profile/package.json 与 pnpm-lock.yaml 对账' },
    ],
    nextChecks: [
      '逐项核对 DSH-PLG-004 证据中的依赖名、清单精确版本与 lockfile 锁定项',
      '检查最近一次 pnpm 安装错误与发布年龄策略，确认应保留的清单版本后再由人决定如何对齐',
      '保留现有清单和 lockfile 的备份；本诊断只提出人工复核，不自动改锁文件或启动安装',
    ],
    repairHint: 'manual-review',
  },

  {
    id: 'profile-config-broken',
    title: 'Profile 配置缺失或解析失败',
    category: 'configuration',
    severity: 'error',
    base: 0.5,
    requires: [],
    supports: [supportProfilePkgBroken, supportPatchFileMissing, supportBomDetected, supportProfileDirUnusable],
    contradicts: ['DSH-PLG-002'],
    summary(ctx) {
      const cfg = factsOf(ctx).configuration ?? {}
      const bits = []
      if (ctx.status('DSH-CFG-001') === 'issue') bits.push(`profile 目录不可用（${textOf(cfg.profileDir, '未能解析')}）`)
      if (ctx.status('DSH-CFG-004') === 'issue') bits.push('profile/package.json 缺失或 JSON 解析失败')
      if (ctx.status('DSH-CFG-002') === 'issue') bits.push('cordis.patch.yml 缺失或不可读')
      if (cfg.profilePkgBom === true || cfg.patchBom === true) bits.push('文件带 UTF-8 BOM')
      return `Profile 配置不可用：${bits.length ? bits.join('；') : '配置项无法解析'}`
    },
    causes: [
      {
        cause: '手工编辑 package.json / patch.yml 时写坏了 JSON 或 YAML',
        weight: 0.6,
        basis: 'DSH-CFG-004 / DSH-CFG-002',
      },
      {
        cause: '文件带 UTF-8 BOM，pnpm 与 DSH 的解析器直接拒绝',
        weight: 0.5,
        basis: 'facts.configuration.profilePkgBom / patchBom',
      },
      {
        cause: 'profile 目录被删除、改名，或配置指向了另一台机器的路径',
        weight: 0.45,
        basis: 'DSH-CFG-001',
      },
    ],
    nextChecks: [
      '用 `Get-Content -Raw <profile>\\package.json | ConvertFrom-Json` 验证 JSON 是否能解析',
      '检查文件头三个字节是否为 EF BB BF（BOM）：是就另存为 UTF-8 无 BOM',
      '`Get-ChildItem ~\\.dsh\\profiles` 确认 profile 名真实存在，再改插件 Config 里的 profileDir',
    ],
    repairHint: null,
  },

  {
    id: 'credential-leak-in-logs',
    title: '会话日志里有明文密钥',
    category: 'security',
    severity: 'error',
    base: 0.6,
    requires: ['DSH-SEC-003'],
    supports: [supportLeakFacts, supportLeakMultiSource, supportLeakBearer],
    contradicts: [],
    summary(ctx) {
      const leaks = ctx.facts?.logs?.leaks
      const total = num(leaks?.total) ?? 0
      const unique = num(leaks?.unique)
      const sources = asArray(leaks?.bySource).filter(isObject).length
      const bits = [`${countText(total, '处')}疑似明文密钥`]
      if (unique !== undefined) bits.push(`去重后 ${unique} 个不同值`)
      if (sources) bits.push(`分布在 ${sources} 个日志源`)
      return `凭据已落盘：${bits.join('，')}`
    },
    causes: [
      {
        cause: '对话或工具输出里直接贴过密钥，会话日志原样留存',
        weight: 0.65,
        basis: 'DSH-SEC-003 / facts.logs.leaks.bySource',
      },
      { cause: '插件把请求头或环境变量打进了日志', weight: 0.5, basis: 'facts.logs.leaks.uniqueByType' },
      { cause: '报错时把完整请求体 dump 出来', weight: 0.35, basis: 'facts.logs.leaks.bySource[].kind' },
    ],
    nextChecks: [
      '把命中的密钥全部当作已泄露处理：立即轮换，并检查该密钥的使用记录',
      '先看清理计划：`node scripts/purge-secrets.mjs`（dry-run），确认后再 `--apply --yes`；可 `--rollback` 回滚',
      '活动会话（10 分钟内写过）不会被清理，先关掉对应会话再跑一次',
      '需要贴日志给人看时只贴 sample，绝不贴整段会话',
    ],
    repairHint: 'secret-cleanup',
  },

  {
    id: 'memory-pressure',
    title: '内存/资源吃紧导致进程被拖垮',
    category: 'runtime',
    severity: 'warning',
    base: 0.5,
    requires: ['DSH-RUN-001'],
    supports: [supportLowMemFacts, supportCrashSnapshotRule, supportOomSample],
    contradicts: ['DSH-LOG-003'],
    summary(ctx) {
      const bits = []
      if (ctx.memRatio !== undefined) {
        bits.push(`可用内存 ${fmtPct(ctx.memRatio)}（${fmtBytes(ctx.freeMemBytes)} / ${fmtBytes(ctx.totalMemBytes)}）`)
      }
      if (ctx.status('DSH-LOG-003') === 'issue') bits.push('日志里有崩溃快照佐证')
      const oom = ctx.clusterBySample(/out of memory|oom|enomem|heap limit|allocation failed/i)
      if (oom) bits.push(`崩溃样例含内存不足（${oom.kind}×${oom.count}）`)
      return `内存吃紧：${bits.length ? bits.join('，') : '可用内存已低于阈值'}`
    },
    causes: [
      { cause: '宿主或工具进程占满内存，系统开始杀进程', weight: 0.6, basis: 'DSH-RUN-001 / facts.runtime' },
      { cause: '插件内存泄漏（长时间运行后持续增长）', weight: 0.45, basis: 'facts.logs.clusters 里重复出现的崩溃' },
      { cause: '同时跑了多个 DSH 实例或大型构建任务', weight: 0.3, basis: 'facts.runtime.freeMemBytes' },
    ],
    nextChecks: [
      "`Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 10 Name,WorkingSet` 找出吃内存的进程",
      '关掉不用的 DSH 实例/浏览器/构建任务后重启宿主，再体检一次看内存占比',
      '崩溃样例里搜 `out of memory` / `ENOMEM`，确认是被 OOM 还是被用户/安装流程结束的',
    ],
    repairHint: null,
  },

  {
    id: 'host-crash-loop',
    title: '宿主进程反复崩溃',
    category: 'logs',
    severity: 'warning',
    base: 0.55,
    requires: ['DSH-LOG-003'],
    supports: [supportHostExitRepeated, supportHostExitAny, supportCrashSources],
    contradicts: ['DSH-RUN-001'],
    summary(ctx) {
      const bits = []
      const exit = ctx.cluster('host-exit')
      const boot = ctx.cluster('web-boot-inactive')
      if (exit) bits.push(`host-exit ×${exit.count}${exit.inWindow ? '（窗口内）' : '（窗口外）'}`)
      if (boot) bits.push(`web-boot-inactive ×${boot.count}`)
      const crashSources = asArray(ctx.facts?.logs?.sources).filter((s) => isObject(s) && s.kind === 'crash').length
      if (crashSources) bits.push(`${crashSources} 份崩溃快照`)
      return `宿主非正常退出：${bits.length ? bits.join('，') : '检测到崩溃证据'}`
    },
    causes: [
      { cause: '升级/安装插件时重启，或用户手动结束宿主进程', weight: 0.55, basis: 'DSH-LOG-003 的 evidence' },
      { cause: '内存不足被系统 OOM 杀掉', weight: 0.45, basis: 'facts.logs.clusters 的崩溃样例' },
      { cause: '插件在启动阶段抛异常导致 web boot 未激活', weight: 0.4, basis: 'web-boot-inactive 聚类' },
    ],
    nextChecks: [
      '按时间对齐：崩溃是否紧跟在安装/升级插件之后（`facts.logs.clusters[].firstSeenAt/lastSeenAt`）',
      '打开 `crash-*.log` 看最后一个崩溃栈，确认是插件还是宿主本身',
      '把最近装的插件全部禁用后重启，确认是否还会崩',
    ],
    repairHint: null,
  },

  {
    id: 'runtime-version-mismatch',
    title: 'Node 版本不满足 DSH 要求',
    category: 'environment',
    severity: 'error',
    base: 0.6,
    requires: ['DSH-ENV-001'],
    supports: [supportEnginesDeclared, supportHostPackagesUnreadable, supportAbiMismatchCluster],
    contradicts: [],
    summary(ctx) {
      const node = textOf(ctx.facts?.runtime?.node, textOf(ctx.titleOf('DSH-ENV-001'), '未知'))
      const need = textOf(ctx.facts?.install?.enginesNode, '未声明')
      const rule = ctx.rule('DSH-ENV-001')
      const base = rule?.status === 'issue' ? rule.summary : `当前 Node ${node}，DSH 要求 ${need}`
      const extra = []
      if (ctx.status('DSH-ENV-003') === 'issue') extra.push('宿主包目录同时不可读')
      const abi = ctx.clusterBySample(/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different Node/i)
      if (abi) extra.push('原生模块 ABI 不匹配')
      return `Node 版本不匹配：${base}${extra.length ? `；${extra.join('，')}` : ''}`
    },
    causes: [
      { cause: '机器上有多个 Node 版本，DSH 用的是不满足 engines 的那个', weight: 0.6, basis: 'DSH-ENV-001' },
      { cause: '升级/降级过 Node 但没重启宿主，原生模块还按旧 ABI 加载', weight: 0.5, basis: 'facts.runtime.node' },
      { cause: '安装目录用的是另一套运行时（装错位置/残留旧版本）', weight: 0.4, basis: 'DSH-ENV-003' },
    ],
    nextChecks: [
      '`node -v` 与 `facts.runtime.node` 对比，确认 DSH 实际用的是哪个运行时',
      '桌面版优先用内置运行时；CLI 场景用 nvm/fnm 切到满足 engines.node 的版本',
      '切换后**必须重启宿主**，再重新体检（原生模块不会热切换）',
    ],
    repairHint: null,
  },

  {
    id: 'web-port-down',
    title: '本地 Web 端口未响应',
    category: 'connectivity',
    severity: 'warning',
    base: 0.5,
    requires: ['DSH-NET-001'],
    supports: [supportWebPortProbe, supportWebMode, supportPortInUseCluster],
    contradicts: [],
    summary(ctx) {
      const web = ctx.facts?.web
      const url = textOf(web?.url, '本地 Web 地址')
      const port = web?.port
      const bits = [`${url}${port ? `（:${port}）` : ''} 探测未响应`]
      const inUse = ctx.cluster('port-in-use')
      if (inUse) bits.push(`日志里有 port-in-use ${inUse.count} 次`)
      return `本地 Web 端口不可用：${bits.join('，')}`
    },
    causes: [
      { cause: '页面来自另一个实例，当前进程的服务已经退出', weight: 0.5, basis: 'DSH-NET-001 / facts.web' },
      { cause: '端口被别的进程占用（或上次没退干净）', weight: 0.45, basis: 'port-in-use 聚类' },
      { cause: '防火墙/安全软件拦了本地回环探测（页面其实还能用）', weight: 0.3, basis: 'DSH-NET-001 的 evidence' },
    ],
    nextChecks: [
      '`Test-NetConnection 127.0.0.1 -Port <端口>` 确认端口是否真的没人听',
      '`Get-NetTCPConnection -LocalPort <端口> | Select-Object OwningProcess` 找出占用进程',
      '页面还能用说明只是探测被拦；页面也打不开就重启 `dsh web` 并看宿主日志',
    ],
    repairHint: null,
  },

  {
    id: 'workspace-unwritable',
    title: '工作区或临时目录不可写',
    category: 'workspace',
    severity: 'error',
    base: 0.5,
    requires: [],
    supports: [supportTempNotWritable, supportCwdInaccessible, supportCwdNotWritable],
    contradicts: [],
    summary(ctx) {
      const ws = ctx.facts?.workspace ?? {}
      const bits = []
      if (ctx.status('DSH-WS-002') === 'issue' || ws.tempWritable === false) {
        bits.push(`临时目录 ${textOf(ws.tempDir, '')} 不可写`.replace('  ', ' '))
      }
      if (ctx.status('DSH-WS-001') === 'issue' || ws.cwdExists === false) {
        bits.push(`工作区 ${textOf(ws.cwd, '')} 不可访问`.replace('  ', ' '))
      }
      if (supportCwdNotWritable([], ctx.facts, ctx)) {
        bits.push(`工作区 ${textOf(ws.cwd, '')} 不可写${textOf(ws.cwdWriteError) ? `（${ws.cwdWriteError}）` : ''}`.replace('  ', ' '))
      }
      return `工作区路径不可用：${bits.length ? bits.join('；') : '写入探测失败'}`
    },
    causes: [
      { cause: '磁盘满或配额用尽，写入直接失败', weight: 0.55, basis: 'DSH-WS-002 / DSH-WS-003 / facts.workspace.cwdWriteError' },
      { cause: '工作区目录 ACL 或只读挂载限制当前进程写入', weight: 0.55, basis: 'DSH-WS-003 / facts.workspace.cwdWritable' },
      { cause: '工作区目录被删除/改名，或网络盘断开', weight: 0.5, basis: 'DSH-WS-001' },
      { cause: '安全软件拦截写入，或 TEMP 指向了只读路径', weight: 0.4, basis: 'facts.workspace.tempDir' },
    ],
    nextChecks: [
      '`Get-PSDrive C | Select-Object Used,Free` 看磁盘剩余空间',
      '`New-Item -ItemType File $env:TEMP\\dsh-write-test.txt -Force` 验证临时目录是否真的可写',
      '换一个存在的工作区目录重新打开，确认 DSH-WS-001 是否消失',
    ],
    repairHint: null,
  },

  {
    id: 'provider-auth-or-quota',
    title: '接入点可达但凭据/配额有问题',
    category: 'connectivity',
    severity: 'warning',
    base: 0.5,
    requires: ['DSH-NET-002'],
    minSupports: 1,
    supports: [supportServiceTargets, supportHttpAuthClusters, supportNoModelKey, supportCredentialInsufficientCluster],
    contradicts: ['DSH-NET-003'],
    summary(ctx) {
      const bits = [`${countText(ctx.serviceTargets.length, '个')}接入点返回服务侧错误`]
      const codes = dedupe(ctx.serviceTargets.map((t) => t.code))
      if (codes.length) bits.push(`分类：${codes.join('/')}`)
      if (ctx.status('DSH-SEC-001') === 'issue') bits.push('本机没有可用的模型密钥')
      const auth = ctx.clusterTotal(['http-unauthorized', 'http-rate-limited'])
      if (auth.total) bits.push(`日志里 401/429 共 ${auth.total} 次`)
      return `凭据或配额问题：${bits.join('，')}`
    },
    causes: [
      { cause: '密钥无效、已吊销，或与当前 endpoint 不匹配', weight: 0.6, basis: 'DSH-NET-002 的 data.service / 分类码' },
      { cause: '触发限流或配额/余额用尽（429/402）', weight: 0.5, basis: 'facts.connectivity.results[].probes.http' },
      { cause: '模型名/路径写错，请求被对端以 4xx 拒绝', weight: 0.35, basis: 'not-found/client 分类码' },
    ],
    nextChecks: [
      '核对配置里的 key 与 baseURL 是否属于同一家 provider（401 多半是这两者错配）',
      '429 时等 `Retry-After` 再试；402/配额提示去控制台看余额与套餐',
      '5xx 与本地配置无关，隔一段时间重试；持续 5xx 换个模型名排除单模型故障',
    ],
    repairHint: null,
  },
]

/** 小工具：把 ctx 里的 facts 取出来（summary 里为了可读性包一层）。 */
function factsOf(ctx) {
  return isObject(ctx?.facts) ? ctx.facts : {}
}

/* ------------------------------------------------------------------ *
 * 5. 单个假设的评估
 * ------------------------------------------------------------------ */

function isSupportHit(out) {
  if (!out) return false
  if (out === true) return true
  if (!isObject(out)) return false
  // { missing } 是「无法判定」，不是成立
  return typeof out.missing !== 'string'
}

function evaluateHypothesis(hypothesis, results, facts, byId) {
  const requires = asArray(hypothesis.requires).map((id) => String(id)).filter(Boolean)

  // ① 反证：任一 required 规则明确 pass → 整条假设不成立
  for (const id of requires) {
    const row = byId.get(id)
    if (row && row.status === 'pass') return null
  }

  const requireHits = requires.filter((id) => byId.get(id)?.status === 'issue')
  const requireMissing = requires.filter((id) => {
    const row = byId.get(id)
    return !row || row.status === 'unknown'
  })
  // ② 必须有可解释的对象：requires 非空时至少要有一条 issue
  if (requires.length > 0 && requireHits.length === 0) return null

  const ctx = makeContext(results, facts, byId)

  // ③ supports：成立 / 不成立 / 无法判定 三态
  const hits = []
  const gaps = []
  for (const support of asArray(hypothesis.supports)) {
    let out
    try {
      out = typeof support === 'function' ? support(results, facts, ctx) : false
    } catch {
      out = false // 一条判据写崩了不许拖垮整层推理
    }
    if (isSupportHit(out)) {
      hits.push({
        text: typeof out === 'object' ? textOf(out.text) : '',
        rule: typeof out === 'object' ? textOf(out.rule) : '',
      })
      continue
    }
    if (isObject(out) && typeof out.missing === 'string' && out.missing) gaps.push(out.missing)
  }

  // ④ 只靠 support 立论的假设（requires 为空）必须有至少一条证据；
  //    minSupports 用于「同一条规则派生两种互斥根因」时进一步收紧
  const minSupports = num(hypothesis.minSupports) ?? 0
  if (requires.length === 0 && hits.length === 0) return null
  if (hits.length < minSupports) return null

  // ⑤ 规则加权分（不是统计概率，见文件头公式）
  const allRequiresIssue = requires.length > 0 && requireHits.length === requires.length
  const missingCount = requireMissing.length + gaps.length
  const raw =
    (num(hypothesis.base) ?? 0.5) +
    WEIGHT.support * hits.length +
    (allRequiresIssue ? WEIGHT.requires : 0) -
    WEIGHT.missing * missingCount
  const confidence = round2(clamp(raw, WEIGHT.floor, WEIGHT.ceiling))

  return { hypothesis, ctx, requireHits, requireMissing, hits, gaps, confidence }
}

/** 已命中 issue 规则里最重的那条；假设声明的 severity 是上限。 */
function resolveSeverity(hypothesis, affectedRules, byId) {
  const ceiling = textOf(hypothesis.severity, 'warning')
  let worst = null
  for (const id of affectedRules) {
    const row = byId.get(id)
    if (!row || row.status !== 'issue') continue
    const rank = SEVERITY_RANK[row.severity]
    if (rank === undefined) continue
    if (worst === null || rank < SEVERITY_RANK[worst]) worst = row.severity
  }
  if (worst === null) return ceiling
  // 更轻的严重度照实报（例如 DSH-NET-002 部分被挡只是 warning），更重的不越过上限
  return SEVERITY_RANK[worst] >= SEVERITY_RANK[ceiling] ? worst : ceiling
}

function buildDiagnosis(matched, allMatched) {
  const { hypothesis, ctx, requireHits, hits, gaps, confidence } = matched

  const affectedRules = []
  const pushRule = (id) => {
    const ruleId = textOf(id)
    if (!ruleId) return
    if (affectedRules.includes(ruleId)) return
    if (!ctx.byId.has(ruleId)) return // 只引用本份报告里真实存在的规则，便于回查
    affectedRules.push(ruleId)
  }
  for (const id of requireHits) pushRule(id)
  for (const hit of hits) pushRule(hit.rule)

  const evidence = []
  for (const id of requireHits) {
    const row = ctx.byId.get(id)
    evidence.push(`${id}${row.title ? `（${row.title}）` : ''}：${row.summary || '无摘要'}`)
  }
  for (const hit of hits) if (hit.text) evidence.push(hit.text)
  const limitedEvidence = evidence.length > 8 ? [...evidence.slice(0, 8), `另有 ${evidence.length - 8} 条证据未列出`] : evidence

  const missingCount = matched.requireMissing.length + gaps.length
  let summary = ''
  try {
    summary = typeof hypothesis.summary === 'function' ? textOf(hypothesis.summary(ctx)) : textOf(hypothesis.summary)
  } catch {
    summary = ''
  }
  if (!summary) summary = textOf(hypothesis.title, hypothesis.id)
  if (missingCount > 0) {
    const details = [
      ...matched.requireMissing.map((id) => `${id} 无法判定`),
      ...gaps.map((g) => g),
    ].slice(0, 3)
    summary += `；另有 ${missingCount} 条证据缺失（${details.join('；')}），结论按现有证据给出`
  }

  const causes = []
  for (const cause of asArray(hypothesis.causes)) {
    if (!isObject(cause)) continue
    const text = textOf(cause.cause)
    if (!text) continue
    causes.push({
      cause: text,
      weight: clamp(num(cause.weight) ?? 0.3, 0, 1),
      basis: textOf(cause.basis, '假设内联判据'),
    })
  }
  causes.sort((a, b) => b.weight - a.weight)

  const nextChecks = asArray(hypothesis.nextChecks).map((c) => String(c)).filter(Boolean)
  if (!nextChecks.length) nextChecks.push('重跑一次 dsh_doctor 并对比前后两份报告的同一条规则')

  // 竞争假设：本假设声明要排除的规则，若已被别的假设引用，就把那个假设列出来
  const contradictions = []
  for (const other of allMatched) {
    if (other.hypothesis.id === hypothesis.id) continue
    const overlap = other.affectedRules.some((id) => asArray(hypothesis.contradicts).includes(id))
    if (overlap && !contradictions.includes(`hyp-${other.hypothesis.id}`)) {
      contradictions.push(`hyp-${other.hypothesis.id}`)
    }
  }

  const category = ALLOWED_CATEGORIES.includes(textOf(hypothesis.category))
    ? hypothesis.category
    : 'environment'

  const diagnosis = {
    id: `hyp-${hypothesis.id}`,
    hypothesisId: hypothesis.id,
    title: textOf(hypothesis.title, hypothesis.id),
    category,
    severity: resolveSeverity(hypothesis, affectedRules, ctx.byId),
    status: 'issue',
    confidence,
    summary,
    evidence: limitedEvidence,
    causes,
    nextChecks,
    affectedRules,
    contradicts: contradictions,
    repairHint: repairHintOf(hypothesis),
  }
  return diagnosis
}

/* ------------------------------------------------------------------ *
 * 6. 排序
 * ------------------------------------------------------------------ */

/* 每条假设对应的修复动作 id（与 lib/repair-plan.js 的 PLANNERS.id 对齐）。
 * 没有自动修复路径的假设落到 'manual-review'：界面据此显示「按 nextChecks 手工处理」，
 * 而不是留一个 null 让调用方去猜是「没写」还是「没有」。 */
export const REPAIR_HINTS = {
  'egress-blocked': 'egress-proxy',
  'plugin-incompatible': 'plugin-compat-review',
  'plugin-missing-or-broken': 'plugin-reinstall',
  'profile-config-broken': 'profile-config-restore',
  'credential-leak-in-logs': 'secret-cleanup',
  'memory-pressure': 'memory-relief',
  'host-crash-loop': 'host-crash-collect',
}

function repairHintOf(hypothesis) {
  if (typeof hypothesis.repairHint === 'string' && hypothesis.repairHint) return hypothesis.repairHint
  return REPAIR_HINTS[hypothesis.id] ?? null
}

/**
 * 稳定排序：严重度（error → warning → info）→ 置信度降序 → 影响面（affectedRules 多者先）→ id。
 * 纯函数，不修改入参；垃圾输入返回空数组。
 */
export function rankDiagnoses(diagnoses) {
  const list = asArray(diagnoses).filter(isObject)
  return [...list].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] ?? 3
    const sb = SEVERITY_RANK[b.severity] ?? 3
    if (sa !== sb) return sa - sb
    const ca = num(a.confidence) ?? 0
    const cb = num(b.confidence) ?? 0
    if (ca !== cb) return cb - ca
    const ra = asArray(a.affectedRules).length
    const rb = asArray(b.affectedRules).length
    if (ra !== rb) return rb - ra
    return String(a.id).localeCompare(String(b.id))
  })
}

/* ------------------------------------------------------------------ *
 * 7. 主入口
 * ------------------------------------------------------------------ */

/**
 * 推理：results + facts → 根因假设列表。
 * 任何输入问题都退化成「更少的诊断」，绝不抛异常（体检工具本身不能成为新的故障源）。
 */
export function inferDiagnoses(input, options = {}) {
  const startedAt = Date.now()
  const opts = normalizeOptions(options)

  let results = []
  let facts = {}
  try {
    const normalized = normalizeInput(input)
    results = normalized.results
    facts = normalized.facts
  } catch {
    results = []
    facts = {}
  }
  // options.rules：只考虑这些规则 id（未知 id 不会凭空造出结果）
  if (opts.rules) results = results.filter((row) => opts.rules.has(row.id))

  const byId = new Map(results.map((row) => [row.id, row]))
  const issueCount = results.filter((row) => row.status === 'issue').length

  // ① 逐条假设评估；单条假设的判据写崩了只丢这一条
  const matched = []
  for (const hypothesis of HYPOTHESES) {
    let entry = null
    try {
      entry = evaluateHypothesis(hypothesis, results, facts, byId)
    } catch {
      entry = null
    }
    if (!entry) continue
    if (entry.confidence < opts.minConfidence) continue // 低于阈值：设计上就不下结论
    matched.push(entry)
  }

  // ①.5 互斥裁决：出口被挡与「凭据/配额」共用 DSH-NET-002 这条 requires，
  // 靠各自的 supports 分流。实测两者会同时命中（网关日志里的 credential-insufficient
  // 被当成模型端点的鉴权证据），报告上就出现「连不上」和「连得上但没钥匙」并存。
  // 同一份 NET-002 只能有一个主因：谁分高留谁。
  if (matched.some((entry) => entry.hypothesis.id === 'egress-blocked')) {
    const index = matched.findIndex((entry) => entry.hypothesis.id === 'provider-auth-or-quota')
    if (index >= 0) matched.splice(index, 1)
  }

  // ② 先给每条假设算出 affectedRules，竞争假设才能互相引用
  const withRules = matched.map((entry) => {
    const affectedRules = []
    const push = (id) => {
      const ruleId = textOf(id)
      if (!ruleId || affectedRules.includes(ruleId) || !byId.has(ruleId)) return
      affectedRules.push(ruleId)
    }
    for (const id of entry.requireHits) push(id)
    for (const hit of entry.hits) push(hit.rule)
    return { ...entry, affectedRules }
  })

  // ③ 生成诊断 → 排序 → 截断
  let diagnoses = []
  for (const entry of withRules) {
    try {
      diagnoses.push(buildDiagnosis(entry, withRules))
    } catch {
      // 单条诊断构造失败只丢这一条
    }
  }
  diagnoses = rankDiagnoses(diagnoses).slice(0, opts.maxDiagnoses)

  // ④ byRule / unmatched 只反映**最终可见**的诊断：
  //    被 minConfidence 丢掉或被 maxDiagnoses 截断的规则，确实没有归因，就该出现在 unmatched。
  const byRule = {}
  for (const diagnosis of diagnoses) {
    for (const ruleId of asArray(diagnosis.affectedRules)) {
      if (!Array.isArray(byRule[ruleId])) byRule[ruleId] = []
      if (!byRule[ruleId].includes(diagnosis.id)) byRule[ruleId].push(diagnosis.id)
    }
  }
  const unmatched = []
  for (const row of results) {
    if (row.status !== 'issue') continue
    if (byRule[row.id]) continue
    if (unmatched.includes(row.id)) continue
    unmatched.push(row.id)
  }

  return {
    diagnoses,
    byRule,
    unmatched,
    stats: {
      considered: results.length,
      issueCount,
      hypothesisHits: withRules.length,
      unmatchedCount: unmatched.length,
      elapsedMs: Date.now() - startedAt,
    },
  }
}

export default { HYPOTHESES, INFERENCE_VERSION, inferDiagnoses, rankDiagnoses }
