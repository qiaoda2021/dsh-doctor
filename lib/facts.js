/**
 * DSH Doctor — 事实采集层。
 *
 * 只采集，不判定。所有「这东西算不算问题」的判断都在 rules.js。
 * 这样做的直接好处：单测可以喂一份合成 facts（比如「patch 行引用了不存在的包」），
 * 不需要真的把机器搞坏一次。
 *
 * 解析链（顺序固定，越靠前越可信）：
 *   options（插件 Config / 工具参数）
 *   → 宿主进程环境变量（注意：桌面版宿主进程通常**没有** DSH_*，它们只注入子进程工具环境）
 *   → Host service（profileContext / configEditor / webApp / webServer / workingDirectory）
 *   → 文件系统推断（~/.dsh、profiles 扫描、可执行文件相对路径）
 * 每一段来源都记进 facts.sources，报告里能看到「这个值是怎么来的」。
 */
import { join, isAbsolute } from 'node:path'
import { tmpdir, homedir, platform, arch, release, cpus, totalmem, freemem } from 'node:os'
import { existsSync } from 'node:fs'
import { collectLogs } from './logs.js'
import { probeWorkspaceWritable } from './workspace-probe.js'
import {
  readJson,
  readText,
  dirEntries,
  statSafe,
  basenameOf,
  majorOf,
  versionTuple,
  satisfiesRange,
  detectDshRoot,
  readDshCorePkg,
  scanPatchRows,
  packageRootOf,
  packageLocations,
  probeTcp,
  probeTempWritable,
  zstdSupport,
  hasBom,
} from './probe.js'

/** DSH 数据目录里预期存在的子目录。 */
export const DATA_DIRS = ['sessions', 'cache', 'storages', 'state', 'attachments', 'skills', '.agent-presets']

/** 只检查「是否存在」的环境变量名，永远不读取值。 */
export const SECRET_ENV_NAMES = ['DEEPSEEK_API_KEY', 'DSH_LLM_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']

/**
 * 在没有 DSH_PROFILE_DIR（宿主进程的常态）时，从 ~/.dsh/profiles 里找出
 * 声明了本插件的那一个 profile —— 也就是「我自己所在的 profile」，不会认错。
 * scanPatchRows 的第一个有 cordis.patch.yml 的 profile 作为兜底。
 */
export function detectProfileDir(home, markerId = 'dsh-doctor') {
  if (!home) return undefined
  const profilesDir = join(home, 'profiles')
  const candidates = dirEntries(profilesDir).filter((e) => e.isDirectory() || e.isSymbolicLink())
  let firstExisting
  for (const entry of candidates) {
    const dir = join(profilesDir, entry.name)
    const text = readText(join(dir, 'cordis.patch.yml'))
    if (text === undefined) continue
    if (firstExisting === undefined) firstExisting = dir
    const matcher = new RegExp(
      `(^|\\n)\\s*-\\s*id:\\s*["']?${markerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`,
    )
    if (matcher.test(text)) return dir
  }
  return firstExisting
}

/** 运行模式识别：桌面版 / web 服务 / CLI。只看证据，不确定就 unknown。 */
function detectMode({ home, webUrl, dshRoot, dshPkg, env }) {
  const evidence = []
  const isDesktopRuntime = dshPkg?.name === '@deepseek-ai/dsh-desktop-runtime'
  if (isDesktopRuntime) evidence.push(`安装根 package.name=${dshPkg.name}`)
  const exeName = basenameOf(process.execPath)
  if (/\.exe$/i.test(exeName) && !/^node(\.exe)?$/i.test(exeName)) evidence.push(`进程可执行文件=${exeName}`)
  if (env.DSH_WEB_URL || webUrl) evidence.push(`web 地址=${env.DSH_WEB_URL || webUrl}`)
  if (env.DSH_SESSION_ID) evidence.push('存在 DSH_SESSION_ID（由宿主启动的会话）')
  if (env.DSH_SHELL === '1') evidence.push('DSH_SHELL=1（工具子进程环境）')
  const value = isDesktopRuntime ? 'desktop' : env.DSH_WEB_URL && !isDesktopRuntime ? 'web' : dshRoot ? 'unknown' : 'unknown'
  return { value, evidence: evidence.length ? evidence : ['没有足以判定的证据'] }
}

/** 扫 profile/node_modules，挑出「插件包」（声明了 dsh 段，或名字像 dsh 插件）。 */
function scanPlugins(profileModules) {
  const plugins = []
  if (!profileModules) return plugins
  const accept = (pkg) => Boolean(pkg) && (Boolean(pkg.dsh) || String(pkg.name).startsWith('dsh-') || String(pkg.name).startsWith('@deepseek-ai/'))
  for (const entry of dirEntries(profileModules)) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = join(profileModules, entry.name)
      for (const inner of dirEntries(scopeDir)) {
        if (!inner.isDirectory() && !inner.isSymbolicLink()) continue
        const dir = join(scopeDir, inner.name)
        const pkg = readJson(join(dir, 'package.json'))
        if (accept(pkg)) plugins.push({ name: pkg.name, version: pkg.version, dir, pkg })
      }
      continue
    }
    const dir = join(profileModules, entry.name)
    const pkg = readJson(join(dir, 'package.json'))
    if (accept(pkg)) plugins.push({ name: pkg.name, version: pkg.version, dir, pkg })
  }
  return plugins.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

/** 版本兼容判定：优先 compatibility.dsh 区间，其次 dshReleases 白名单。 */
function judgeCompat(pkg, dshVersion) {
  const compat = pkg?.dsh?.compatibility
  if (!compat || !dshVersion) return { declared: false }
  if (typeof compat.dsh === 'string' && compat.dsh.trim()) {
    const ok = satisfiesRange(dshVersion, compat.dsh)
    return { declared: true, source: 'dsh', range: compat.dsh.trim(), ok }
  }
  if (compat.dshReleases && typeof compat.dshReleases === 'object') {
    const releases = Object.keys(compat.dshReleases)
    if (releases.length === 0) return { declared: true, source: 'dshReleases', range: '(空)', ok: undefined }
    const target = versionTuple(dshVersion)
    const exact = releases.includes(dshVersion)
    const sameBase = releases.some((r) => {
      const t = versionTuple(r)
      return t && target && t[0] === target[0] && t[1] === target[1] && t[2] === target[2]
    })
    return { declared: true, source: 'dshReleases', range: releases.join(' / '), releases, ok: exact || sameBase }
  }
  return { declared: false }
}

/** 会话文件统计（递归深度 ≤3，只 stat，不读内容）。 */
function scanSessions(sessionsDir) {
  const stats = { dir: sessionsDir, fileCount: 0, bytes: 0, newest: undefined, newestMtimeMs: 0, recent24h: 0, zstdFiles: 0, plainFiles: 0 }
  if (!sessionsDir) return stats
  const cutoff = Date.now() - 24 * 3600 * 1000
  const walk = (dir, depth) => {
    if (depth > 3) return
    for (const entry of dirEntries(dir)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      const st = statSafe(full)
      if (!st?.isFile()) continue
      stats.fileCount += 1
      stats.bytes += st.size
      if (st.mtimeMs > cutoff) stats.recent24h += 1
      if (/\.zstd$/i.test(entry.name)) stats.zstdFiles += 1
      else if (/\.jsonl$/i.test(entry.name)) stats.plainFiles += 1
      if (st.mtimeMs > stats.newestMtimeMs) {
        stats.newestMtimeMs = st.mtimeMs
        stats.newest = full
      }
    }
  }
  walk(sessionsDir, 0)
  return stats
}

/* ------------------------- 模型接入点（连接检测的事实源） ------------------------- */

/**
 * 从 cordis.patch.yml 里把「provider → 地址」配成对。
 *
 * 这段解析刻意不复用 scanPatchRows：那个函数回答的是「哪些补丁行引用了哪些包」，
 * 而这里要钻到 config 里找 providers 列表。两者关注点不同，混在一起会互相拖累。
 * 只认 URL 与非敏感字段，遇到 apiKey/token/secret 一律跳过 —— 探测目标里绝不允许出现凭据。
 */
/*
 * ── provider 发现（YAML 子集解析）────────────────────────────────────────────
 *
 * 为什么不用正则按行抠：真实的 cordis.patch.yml 里 provider 有三种完全不同的形状，
 * 逐行抠字段必然把 allowedModels / models 列表项里的 `provider:` 当成接入点，
 * 又会漏掉 `providers:` 这个**字典**（键就是 route id，没有 id/name/type 字段）。
 * 这里实现一个只认「缩进 + key: value」的极简树解析：不处理多行字符串、锚点、
 * 流式集合 —— patch 里也用不到；遇到不认识的写法就跳过，绝不猜。
 *
 * 安全底线：这些名字的**值**一律不进树（apiKey/token/secret…），
 * 连 key 名里的引用（apiKeyEnv）也是只当普通字符串记下，不解析引用。
 */
const SENSITIVE_FIELD_NAMES = ['apikey', 'api_key', 'token', 'secret', 'password', 'key', 'authorization']
const URL_FIELD_NAMES = ['baseurl', 'base_url', 'endpoint', 'basepath', 'api_base', 'apibase', 'url']

/** 补丁里字段大小写不统一（baseURL / base_url / displayName），按小写名取一次。 */
function pickField(object, name) {
  if (!object || typeof object !== 'object') return undefined
  const target = String(name).toLowerCase()
  for (const [key, value] of Object.entries(object)) {
    if (key.toLowerCase() === target) return value
  }
  return undefined
}

/** 从一个对象里找出第一个像 URL 的字段名对应的值。 */
function pickUrlField(object) {
  for (const name of URL_FIELD_NAMES) {
    const value = pickField(object, name)
    if (typeof value === 'string' && value) return value
  }
  return undefined
}
/** 这一步只是把行归一化，真正的树在 parsePatchEntries 里长出来。 */
function yamlLine(raw) {
  const indent = raw.match(/^\s*/)[0].length
  let body = raw.slice(indent)
  let item = false
  if (body.startsWith('- ')) {
    item = true
    body = body.slice(2)
  } else if (body === '-') {
    return { indent, item: true, key: '', value: '' }
  }
  const match = body.match(/^([^:]+):\s*(.*)$/)
  if (!match) return undefined
  const unquote = (text) => text.replace(/^["']|["']$/g, '').trim()
  return { indent, item, key: unquote(match[1]), value: unquote(match[2]) }
}

/**
 * 把补丁文本解析成 [{ id, name, config }]。
 *
 * 规则：顶层 `- id: x` 开一个条目；条目内 `config:` 之下按缩进建普通对象；
 * 列表项（`- foo: bar`）只记录「这里有个列表」，不把列表项的内容并进父对象 ——
 * 这正是 allowedModels/models 里那些 `provider:` 不该变成接入点的原因。
 */
export function parsePatchEntries(patchText) {
  const entries = []
  let current
  let stack = []
  const pushContainer = (node, key, indent) => {
    const child = {}
    node[key] = child
    stack.push({ indent, node: child })
    return child
  }
  for (const raw of String(patchText ?? '').split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const line = yamlLine(raw)
    if (!line) continue
    if (line.indent === 0 && line.item && line.key === 'id') {
      current = { id: line.value, name: undefined, config: {} }
      entries.push(current)
      stack = []
      continue
    }
    if (!current) continue
    while (stack.length && line.indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack.length ? stack[stack.length - 1].node : current
    const fieldName = line.key.toLowerCase()
    if (SENSITIVE_FIELD_NAMES.includes(fieldName)) continue
    if (line.item) continue // 列表项内容不并进父对象
    if (line.key === 'name' && parent === current && !current.name) {
      current.name = line.value
      continue
    }
    if (line.key === 'config' && parent === current) {
      pushContainer(current, 'config', line.indent)
      continue
    }
    if (!line.value) {
      pushContainer(parent, line.key, line.indent)
      continue
    }
    if (parent[line.key] === undefined) parent[line.key] = line.value
  }
  return entries
}

/** 老接口保留：返回扁平的「列表项块」视图，供只关心 provider 字段的调用方使用。 */
export function parseModelBlocks(patchText) {
  const blocks = []
  for (const entry of parsePatchEntries(patchText)) {
    const config = entry.config ?? {}
    const providers = config.providers && typeof config.providers === 'object' ? config.providers : {}
    for (const [routeId, providerConfig] of Object.entries(providers)) {
      const fields = { provider: routeId }
      const baseURL = pickUrlField(providerConfig)
      if (baseURL) fields.url = baseURL
      const displayName = pickField(providerConfig, 'displayName')
      if (displayName) fields.name = displayName
      const api = pickField(providerConfig, 'api')
      if (api) fields.api = api
      blocks.push({ indent: 2, key: routeId.toLowerCase(), value: routeId, fields, entryId: entry.id })
    }
    if (typeof config.provider === 'string' && config.provider) {
      const url = pickUrlField(config)
      blocks.push({
        indent: 2,
        key: 'provider',
        value: config.provider,
        fields: { provider: config.provider, ...(url ? { url } : {}) },
        entryId: entry.id,
      })
    }
  }
  return blocks
}

/**
 * 从 patch 文本里提取探测目标（去重、去敏感、标注来源）。
 *
 * 三类目标：
 * 1. `providers:` 字典里的每个 route（openai / buzz / …），地址取 baseURL，其次内置默认；
 * 2. 条目里的 `provider: <route>`（agent-default-model 这种），地址只能取内置默认；
 * 3. 本地端点（`embedding.endpoint` 这类）—— 标 local，并记住它是否 `enabled: false`。
 * 同一地址只探一次（deepseek-official / deepseek-account 都指向同一主机），
 * 标签合并，避免同一个 DNS 查询做两遍、报告里出现两行一样的证据。
 */
export function discoverModelTargets(patchText, { providerDefaults = {} } = {}) {
  const defaults = Object.fromEntries(
    Object.entries(providerDefaults ?? {}).map(([key, value]) => [String(key).toLowerCase(), value]),
  )
  const entries = parsePatchEntries(patchText)
  const candidates = []
  const missingBaseUrl = []

  const push = (provider, endpoint, source, extra = {}) => {
    candidates.push({ provider, endpoint, source, ...extra })
  }

  for (const entry of entries) {
    const config = entry.config ?? {}
    const providers = config.providers && typeof config.providers === 'object' ? config.providers : {}
    for (const [routeId, providerConfig] of Object.entries(providers)) {
      const explicit = pickUrlField(providerConfig)
      const fallback = defaults[routeId.toLowerCase()]
      if (!explicit && !fallback) {
        missingBaseUrl.push(routeId)
        continue
      }
      push(routeId, explicit ?? fallback, explicit ? `cordis.patch.yml › ${entry.id}.providers.${routeId}` : '内置默认地址', {
        api: pickField(providerConfig, 'api'),
        displayName: pickField(providerConfig, 'displayName'),
      })
    }
    if (config.providers) continue
    if (typeof config.provider === 'string' && config.provider) {
      const explicit = pickUrlField(config)
      const fallback = defaults[config.provider.toLowerCase()]
      if (!explicit && !fallback) {
        missingBaseUrl.push(config.provider)
        continue
      }
      push(config.provider, explicit ?? fallback, explicit ? `cordis.patch.yml › ${entry.id}` : '内置默认地址')
    }
    // 本地服务端点（本地 embedding / 本地模型）：不是 provider，但一样能连不通
    const embedding = config.embedding && typeof config.embedding === 'object' ? config.embedding : undefined
    const embeddingEndpoint = pickField(embedding, 'endpoint')
    if (embeddingEndpoint) {
      push(`${entry.id} · embedding`, embedding.endpoint, `cordis.patch.yml › ${entry.id}.embedding`, {
        disabled: String(pickField(embedding, 'enabled')).toLowerCase() === 'false',
        optional: true,
        api: pickField(embedding, 'model'),
      })
    }
  }

  const targets = []
  const byEndpoint = new Map()
  for (const candidate of candidates) {
    const key = String(candidate.endpoint).replace(/\/+$/, '').toLowerCase()
    const existing = byEndpoint.get(key)
    if (existing) {
      if (!existing.providers.includes(candidate.provider)) existing.providers.push(candidate.provider)
      existing.label = existing.providers.join(' / ')
      // 只要有一个 route 没被禁用，这条路径就是活的
      existing.disabled = existing.disabled && candidate.disabled
      continue
    }
    const target = {
      id: `target-${targets.length + 1}`,
      label: candidate.provider,
      provider: candidate.provider,
      providers: [candidate.provider],
      endpoint: candidate.endpoint,
      source: candidate.source,
      api: candidate.api,
      disabled: candidate.disabled === true,
      optional: candidate.optional === true,
    }
    byEndpoint.set(key, target)
    targets.push(target)
  }
  return { targets, missingBaseUrl: [...new Set(missingBaseUrl)] }
}

/** 主机名是不是本机（用于跳过 dns/tls）。 */
function isLocalEndpoint(endpoint) {
  try {
    const host = new URL(endpoint).hostname
    return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(host)
  } catch {
    return false
  }
}

/** 单目标探测总预算的默认值（ms）：一个被墙的目标最多吃掉这么多。 */
export const CONNECTIVITY_BUDGET_DEFAULT_MS = 12000
/** 单步超时上限（ms）：有界等待，不保证覆盖退化代理路径的全部长尾延迟。 */
export const CONNECTIVITY_STEP_MAX_MS = 4000
/** 单步超时下限（ms）：再低连本机的回环端口都测不准。 */
export const CONNECTIVITY_STEP_MIN_MS = 250

/**
 * 把「单目标总预算」解析成「单步超时 / 总预算」这一对值。
 *
 * 为什么需要它：HTTP 由运行时 fetch/dispatcher 路由，DNS/TCP/TLS 则独立建连，
 * 不应默认它们走同一路径。本轮部分代理 HTTP 样本耗时 1.5–2.2s，且存在更长的退化样本。
 * 旧的 `min(1000, max(250, floor(budget/4)))` 把所有步骤压到 1000ms，容易误报不可达。
 * 放宽预算只减少短超时的假阴性，并不修复代理路径本身，也不保证每次探测都成功。
 *
 * 规则：
 * - 只有**有限正数**才算有效预算；`undefined` / `NaN` / `Infinity` / 负数 / 0 / 非数字一律回退默认；
 * - 单步 = `min(4000, max(250, floor(预算/4)))`，默认预算 12000 → 3000ms/步，显式 16000 → 4000ms/步；
 * - 总预算 = `min(预算, 单步 × 4)`：不再有 1200ms 地板，小的显式预算不会被放大。
 *
 * 纯函数，不读 env 不联网，单测（tests/facts-connectivity.test.mjs）直接覆盖。
 */
export function resolveConnectivityProbeBudget(value) {
  const raw = Number(value)
  const budget = Number.isFinite(raw) && raw > 0 ? raw : CONNECTIVITY_BUDGET_DEFAULT_MS
  const timeoutMs = Math.min(
    CONNECTIVITY_STEP_MAX_MS,
    Math.max(CONNECTIVITY_STEP_MIN_MS, Math.floor(budget / 4)),
  )
  const totalBudgetMs = Math.min(budget, timeoutMs * 4)
  return { timeoutMs, totalBudgetMs }
}

/**
 * 连接检测：发现目标 → 探测（dns/tcp/tls/http，全程不带凭据）。
 *
 * 两条纪律：
 * 1. 模块缺失（用户装的是旧版本 / 只复制了部分文件）只降级成 available:false，绝不抛错；
 * 2. 默认不探测网络 —— 由调用方显式打开（options.connectivity 为 false 时只做发现）。
 */
async function collectConnectivityFacts({ patchText, env, options }) {
  const probeStartedAt = Date.now()
  let mod
  try {
    mod = await import('./connectivity.js')
  } catch (error) {
    return { available: false, reason: `lib/connectivity.js 不可用：${String(error?.message ?? error)}`, targets: [], results: [] }
  }
  const providerDefaults = Object.fromEntries(
    Object.entries(mod.PROVIDER_DEFAULTS ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  )
  const discovered = discoverModelTargets(patchText, { providerDefaults })
  const targets = discovered.targets.map((target) => ({ ...target, local: isLocalEndpoint(target.endpoint) }))
  const proxy = typeof mod.describeProxy === 'function' ? mod.describeProxy(env) : undefined
  if (!targets.length) {
    return { available: true, enabled: false, targets, results: [], proxy, missingBaseUrl: discovered.missingBaseUrl }
  }
  if (options.connectivity === false) {
    return { available: true, enabled: false, targets, results: [], proxy, missingBaseUrl: discovered.missingBaseUrl, reason: '未启用网络探测' }
  }
  // 预算交给 resolveConnectivityProbeBudget 统一算：默认单目标 12s / 单步 3s。
  // 1000ms 天花板会截断部分可达但较慢的请求；新预算增加延迟容忍度，而非掩盖代理退化。
  // 超时仍如实报告，预算用尽则标为未完成；环境路径是否可用由独立直连/代理对照验证。
  const { timeoutMs: perStep, totalBudgetMs } = resolveConnectivityProbeBudget(options.connectivityBudgetMs)
  try {
    /**
     * 逐目标并行探测，而不是把一队目标塞给一个共享预算。
     *
     * 原因是一路实测出来的：共享预算会按顺序发钱，第一个被墙的域名（openai 在这台机器上
     * 三步全超时）把预算吃光，后面的 buzz、本地端点直接变成「未探测」——
     * 于是报告里最需要看的那个「其实能通但被前一个拖累」的结论就丢了。
     * 每个目标自己的预算 = min(总预算, 单步超时 × 4)，被墙的目标最多花一份单目标预算，
     * 互不影响；整体耗时 = 最慢的那个目标，而不是所有目标之和。
     */
    const reports = await Promise.all(
      targets.map(async (target) => {
        if (target.disabled) return { targetId: target.id, skipped: true }
        try {
          return await mod.collectConnectivity({
            targets: [target],
            proxyEnv: env,
            timeoutMs: perStep,
            totalBudgetMs,
          })
        } catch (error) {
          return { targetId: target.id, error: String(error?.message ?? error) }
        }
      }),
    )
    const results = []
    const errors = []
    for (const report of reports) {
      if (!report || report.skipped) continue
      if (report.error) {
        errors.push({ targetId: report.targetId, step: 'collect', error: report.error })
        continue
      }
      results.push(...(report.results ?? []))
      errors.push(...(report.errors ?? []))
    }
    return {
      available: true,
      enabled: true,
      collectedAt: new Date().toISOString(),
      durationMs: Date.now() - probeStartedAt,
      partial: reports.some((report) => report?.partial === true),
      proxy,
      targets,
      results,
      errors,
      missingBaseUrl: discovered.missingBaseUrl,
    }
  } catch (error) {
    return {
      available: true,
      enabled: true,
      targets,
      results: [],
      proxy,
      missingBaseUrl: discovered.missingBaseUrl,
      errors: [{ targetId: '*', step: 'collect', error: String(error?.message ?? error) }],
    }
  }
}

/**
 * 采集全部事实。返回纯数据结构，任何字段都可能是 undefined —— 规则必须能容忍缺字段，
 * 缺字段的正确结果是 unknown，不是 fail。
 */
export async function collectFacts(options = {}) {
  const startedAt = Date.now()
  const env = options.env ?? process.env
  const sources = { ...(options.sources ?? {}) }

  /* ---------- 路径解析链 ---------- */
  let home = options.home || env.DSH_HOME
  if (!home) {
    home = join(homedir(), '.dsh')
    sources.home = sources.home ?? '默认 ~/.dsh（宿主进程无 DSH_HOME）'
  }
  let profileDir = options.profileDir || env.DSH_PROFILE_DIR
  if (!profileDir) {
    profileDir = detectProfileDir(home)
    if (profileDir) sources.profileDir = '扫描 ~/.dsh/profiles 找到声明 dsh-doctor 的 profile'
  } else if (!sources.profileDir) {
    sources.profileDir = env.DSH_PROFILE_DIR ? 'env DSH_PROFILE_DIR' : 'options'
  }
  const profile = options.profile || env.DSH_PROFILE || (profileDir ? basenameOf(profileDir) : undefined)
  if (profile && !sources.profile && !env.DSH_PROFILE) sources.profile = 'dirname(profileDir)'
  const webUrl = options.webUrl || env.DSH_WEB_URL
  const cwd = options.cwd ?? process.cwd()
  const rootInfo = options.dshRoot
    ? { root: options.dshRoot, source: 'options' }
    : detectDshRoot(env)

  /* ---------- 运行时 ---------- */
  const runtime = {
    node: process.version,
    nodeMajor: majorOf(process.version),
    nodeMinor: versionTuple(process.version)?.[1],
    platform: platform(),
    arch: arch(),
    execPath: process.execPath,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssBytes: process.memoryUsage().rss,
    cpuCount: cpus()?.length,
    totalMemBytes: totalmem(),
    freeMemBytes: freemem(),
    osRelease: release(),
  }

  /* ---------- 安装 ---------- */
  const root = rootInfo.root
  const rootPkg = root ? readJson(join(root, 'package.json')) : undefined
  const corePkg = readDshCorePkg(root)
  const dshModules = root ? join(root, 'node_modules', '@deepseek-ai') : undefined
  const hostPackages = dshModules ? dirEntries(dshModules).filter((e) => e.isDirectory() || e.isSymbolicLink()) : []
  const install = {
    root,
    rootSource: rootInfo.source,
    rootName: rootPkg?.name,
    desktopRuntime: rootPkg?.name === '@deepseek-ai/dsh-desktop-runtime',
    dshVersion: corePkg?.version ?? rootPkg?.version,
    corePresent: Boolean(corePkg),
    coreName: corePkg?.name,
    enginesNode: corePkg?.engines?.node ?? rootPkg?.engines?.node,
    hostPackageCount: hostPackages.length,
    modulesReadable: Boolean(dshModules) && hostPackages.length > 0,
  }

  /* ---------- 配置 / profile ---------- */
  const profileStat = profileDir ? statSafe(profileDir) : undefined
  const patchPath = profileDir ? join(profileDir, 'cordis.patch.yml') : undefined
  const patch = patchPath ? scanPatchRows(patchPath) : undefined
  const profilePkgPath = profileDir ? join(profileDir, 'package.json') : undefined
  const profilePkg = profilePkgPath ? readJson(profilePkgPath) : undefined
  const profileModules = profileDir ? join(profileDir, 'node_modules') : undefined
  const hostModules = root ? join(root, 'node_modules') : undefined

  // 补丁行 → 能否解析到对应包
  const missingPackages = []
  const hostProvided = []
  const overrideRows = []
  if (patch && profileModules) {
    const checked = new Set()
    for (const row of patch.rows) {
      if (!row.name) {
        overrideRows.push(row.id)
        continue
      }
      const name = packageRootOf(row.name)
      if (!name || checked.has(name)) continue
      checked.add(name)
      const spec = profilePkg?.dependencies?.[name]
      const isLocalPath = typeof spec === 'string' && (spec.startsWith('file:') || spec.startsWith('link:'))
      const where = packageLocations(name, [profileModules, hostModules])
      if (where.length === 0) missingPackages.push({ id: row.id, name, isLocalPath })
      else if (where[0] === hostModules) hostProvided.push(name)
    }
  }

  const plugins = scanPlugins(profileModules).map((p) => {
    const patchRel = p.pkg?.dsh?.bundle?.patch
    const compat = judgeCompat(p.pkg, install.dshVersion)
    return {
      name: p.name,
      version: p.version,
      dir: p.dir,
      declaredPatch: patchRel ?? undefined,
      patchExists: patchRel ? existsSync(join(p.dir, patchRel)) : undefined,
      compat,
    }
  })

  /**
   * profile 清单 ↔ pnpm-lock.yaml 是否一致。
   * 真实事故：package.json 写 `billion-context: 0.1.204`，lockfile 里只有 0.1.202，
   * 于是每次 remove_bundle/install_bundle 都在 pnpm 解析阶段炸掉，**所有**插件都装不上，
   * 而报错信息只提包名不提「清单和锁不同步」。这里只做精确版本号的字符串对账：
   * 范围/标签/git/file 依赖不参与（lockfile 里写的是解析后的形态，对不上是正常的）。
   */
  const lockPath = profileDir ? join(profileDir, 'pnpm-lock.yaml') : undefined
  const lockText = lockPath ? readText(lockPath) : undefined
  const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
  const lockDrift = []
  if (lockText) {
    for (const [name, spec] of Object.entries(profilePkg?.dependencies ?? {})) {
      if (typeof spec !== 'string' || !EXACT_VERSION.test(spec)) continue
      if (!lockText.includes(`${name}@${spec}`)) lockDrift.push({ name, spec })
    }
  }

  const configuration = {
    profile,
    profileDir,    profileDirExists: Boolean(profileStat?.isDirectory()),
    patchPath,
    patchExists: Boolean(patch),
    patchBytes: patch ? patch.text.length : 0,
    patchRowCount: patch ? patch.rows.length : 0,
    patchRows: patch ? patch.rows.map((r) => ({ id: r.id, name: r.name, disabled: r.disabled })) : [],
    overrideRows,
    missingPackages,
    hostProvided,
    profilePkgPath,
    profilePkgExists: Boolean(profilePkg),
    // profile/package.json 带 UTF-8 BOM 时，pnpm 与 DSH 的安装校验会直接拒绝
    // （真实踩过：SyntaxError: Unexpected token '\uFEFF'）。这里单独记一个事实。
    profilePkgBom: profilePkgPath ? hasBom(profilePkgPath) : undefined,
    patchBom: patchPath ? hasBom(patchPath) : undefined,
    dependencyCount: profilePkg?.dependencies ? Object.keys(profilePkg.dependencies).length : 0,
    lockPath,
    lockExists: Boolean(lockText),
    lockDrift,
    pluginCount: plugins.length,
    plugins,
  }

  /* ---------- 数据目录 / 会话 ---------- */
  const missingDataDirs = []
  const dataDirState = {}
  for (const name of DATA_DIRS) {
    const present = Boolean(home) && existsSync(join(home, name))
    dataDirState[name] = present
    if (!present) missingDataDirs.push(name)
  }
  const sessions = scanSessions(home ? join(home, 'sessions') : undefined)
  const data = {
    home,
    homeExists: Boolean(home) && Boolean(statSafe(home)?.isDirectory()),
    dirs: dataDirState,
    missingDirs: missingDataDirs,
    sessions,
    zstdSupported: zstdSupport(),
  }

  /* ---------- 工作区 ---------- */
  const cwdStat = cwd ? statSafe(cwd) : undefined
  const cwdProbe = probeWorkspaceWritable(cwd)
  const workspace = {
    cwd,
    cwdExists: Boolean(cwdStat?.isDirectory()),
    cwdEntries: cwdStat?.isDirectory() ? dirEntries(cwd).length : undefined,
    cwdWritable: cwdProbe.writable,
    cwdWriteError: cwdProbe.errorCode,
    cwdWriteDetail: cwdProbe.detail,
    tempDir: tmpdir(),
    tempWritable: probeTempWritable(),
  }

  /* ---------- 凭据（只看存在性） ---------- */
  const credentialsPath = home ? join(home, '.credentials.yaml') : undefined
  const credentialsStat = credentialsPath ? statSafe(credentialsPath) : undefined
  const keyEnvNames = SECRET_ENV_NAMES.filter((name) => Boolean(env?.[name]))
  const security = {
    credentialsPath,
    credentialsExists: Boolean(credentialsStat?.isFile()),
    credentialsBytes: credentialsStat?.size,
    credentialsMtime: credentialsStat ? new Date(credentialsStat.mtimeMs).toISOString() : undefined,
    keyEnvNames,
    keyAvailable: keyEnvNames.length > 0 || Boolean(credentialsStat?.isFile()),
  }

  /* ---------- 环境变量名（不读值，DSH_* 里没有密钥） ---------- */
  const dshVarNames = Object.keys(env).filter((name) => name.startsWith('DSH_')).sort()
  const effective = { DSH_HOME: home, DSH_PROFILE: profile, DSH_PROFILE_DIR: profileDir, DSH_WEB_URL: webUrl }
  const envInfo = {
    dshVarNames,
    present: Object.fromEntries(Object.entries(effective).filter(([, v]) => Boolean(v)).map(([k, v]) => [k, v])),
    unresolved: Object.entries(effective).filter(([, v]) => !v).map(([k]) => k),
    fromFilesystem: Object.entries(effective)
      .filter(([k, v]) => Boolean(v) && !env[k])
      .map(([k]) => k),
    shellMode: env.DSH_SHELL === '1',
  }

  /* ---------- 本地 Web ---------- */
  let web = { url: webUrl, host: undefined, port: undefined, listening: undefined }
  if (webUrl) {
    try {
      const parsed = new URL(webUrl)
      const host = parsed.hostname || '127.0.0.1'
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      web = { url: webUrl, host, port, listening: await probeTcp(host, port, 600) }
    } catch {
      web = { url: webUrl, host: undefined, port: undefined, listening: undefined }
    }
  }

  const mode = detectMode({ home, webUrl, dshRoot: root, dshPkg: rootPkg, env })

  /* ---------- 日志（只读扫描，样本在 lib/logs.js） ---------- */
  // 采集失败不许让整份报告挂掉：logs 段整体 try/catch，失败就把错误塞进 errors。
  let logs
  try {
    logs = await collectLogs({
      home,
      profileDir,
      maxFiles: options.maxLogFiles ?? 12,
      maxTotalBytes: options.maxLogBytes ?? 32 * 1024 * 1024,
      now: startedAt,
    })
  } catch (error) {
    logs = { collectedAt: new Date(startedAt).toISOString(), sources: [], clusters: [], leaks: { total: 0, byType: {} }, errors: [{ path: '(collectLogs)', error: String(error?.message ?? error) }], skipped: [] }
  }

  /* ---------- 连接（模型接入点，默认只发现目标、可选真实探测） ---------- */
  let connectivity
  try {
    connectivity = await collectConnectivityFacts({ patchText: patchPath ? readText(patchPath) : undefined, env, options })
  } catch (error) {
    connectivity = { available: false, reason: String(error?.message ?? error), targets: [], results: [] }
  }

  /* ---------- 安装通道（lockfile / manifest / 本地依赖 / 发布策略） ---------- */
  // 为什么要单独一段：插件管理器坏了的时候，诊断工具自己也可能装不上，
  // 所以这一段的证据必须来自「直接读文件」，不依赖任何安装动作成功（见 lib/installer.js）。
  let installer
  try {
    const mod = await import('./installer.js')
    installer = await mod.inspectInstallHealth({ home, profile, profileDir })
  } catch (error) {
    installer = { available: false, reason: `lib/installer.js 不可用：${String(error?.message ?? error)}`, findings: [], channel: undefined }
  }

  return {
    generatedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    sources,
    mode,
    runtime,
    install,
    configuration,
    plugins: configuration.plugins,
    data,
    workspace,
    security,
    env: envInfo,
    web,
    logs,
    connectivity,
    installer,
  }
}

export default { collectFacts, detectProfileDir, parseModelBlocks, discoverModelTargets, DATA_DIRS, SECRET_ENV_NAMES }