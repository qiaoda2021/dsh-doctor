/**
 * 连接检测器（模块 4）的真机探针：把「模型与网络连接」的探测结果打成中文表格。
 *
 * 这是开发者工具，不是诊断规则：它不写任何文件、不改配置、不发密钥。它只做两件事——
 *   1. 只读扫描 profile 的 cordis.patch.yml，把「provider 名」和「同块里出现的 URL」配成对；
 *   2. 交给 lib/connectivity.js 的 collectConnectivity 跑 dns/tcp/tls/http 四步，然后把结果排版。
 *
 * 密钥永不进入输出路径：扫描阶段遇到 apiKey/token/secret/key 这类键直接跳过，
 * URL 里的 userinfo（user:pass@）和查询串也不会被打印。
 *
 * 用法：
 *   node scripts/connectivity-probe.mjs --discover-only
 *   node scripts/connectivity-probe.mjs --target https://example.invalid --json
 *   Use DSH_PROFILE_DIR to select a specific profile; otherwise discover it under DSH_HOME.
 *
 * 参数：
 *   --target <url>    追加一个探测目标（可重复）
 *   --timeout <ms>    单步超时（默认交给模块，通常 4000）
 *   --budget <ms>     总预算（默认交给模块）
 *   --json            输出原始 JSON 而不是表格
 *   --allow-issue     即使有 issue 也 exit 0
 *   --discover-only   只做目标发现，不探测（调模块前自检用）
 *
 * exit code：有 issue → 1；否则 0；--allow-issue 强制 0；模块缺失/契约不符 → 2。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { detectProfileDir } from '../lib/facts.js'

/* ------------------------------------------------------------------ *
 * 0. 常量
 * ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 4000
const DEFAULT_BUDGET_MS = 20000

/** 目标形状里的四个探测步骤，顺序即输出顺序 */
const STEPS = ['dns', 'tcp', 'tls', 'http']

/** 视作「密钥」的键：整行跳过，绝不做任何解析 */
const SECRET_LINE =
  /^\s*[-]?\s*(api[-_]?key|apikey|apiKeyEnv|apiKeyEnvVar|token|access[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|passwd|passphrase|authorization|cookie|key|privateKey)\s*:/i

/** 块首：缩进 <= 2 的 `- id:` / `- name:` 开一个新块（更深的 `- id:` 是 models 列表，忽略） */
const BLOCK_OPEN = /^(\s*)-\s+(id|name):\s*(.*)$/

/** providers: 映射的开头 */
const PROVIDERS_MAP = /^(\s*)providers\s*:\s*(?:#.*)?$/

/** providers 映射的下一层键（provider 名） */
const PROVIDER_CHILD = /^(\s*)([A-Za-z0-9@._-]+)\s*:\s*(?:#.*)?$/

/** provider 标量：`provider: deepseek-official` / `- provider: buzz` */
const PROVIDER_SCALAR = /^\s*-\s*provider\s*:\s*['"]?([A-Za-z0-9@._-]+)['"]?|^\s*provider\s*:\s*['"]?([A-Za-z0-9@._-]+)['"]?/

/** 地址键（容忍缩进、引号与行尾注释） */
const URL_LINE = /^\s*(baseURL|baseUrl|base_url|endpoint|basePath|apiBase|apiBaseUrl|url)\s*:\s*['"]?([^'"\s#]+)['"]?/

const ANSI = { pass: '✅', ok: '✅', warn: '⚠️', fail: '❌', skip: '⏭', unknown: '❔' }

/* ------------------------------------------------------------------ *
 * 1. 参数
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {
    targets: [],
    timeoutMs: undefined,
    budgetMs: undefined,
    json: false,
    allowIssue: false,
    discoverOnly: false,
    help: false,
  }
  const take = (index) => argv[index + 1]
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--json') out.json = true
    else if (arg === '--allow-issue') out.allowIssue = true
    else if (arg === '--discover-only') out.discoverOnly = true
    else if (arg === '--target' || arg === '-t') {
      const value = take(index)
      if (value && !value.startsWith('--')) {
        out.targets.push(value)
        index += 1
      }
    } else if (arg.startsWith('--target=')) out.targets.push(arg.slice('--target='.length))
    else if (arg === '--timeout') {
      const value = Number(take(index))
      if (Number.isFinite(value) && value > 0) {
        out.timeoutMs = value
        index += 1
      }
    } else if (arg.startsWith('--timeout=')) {
      const value = Number(arg.slice('--timeout='.length))
      if (Number.isFinite(value) && value > 0) out.timeoutMs = value
    } else if (arg === '--budget') {
      const value = Number(take(index))
      if (Number.isFinite(value) && value > 0) {
        out.budgetMs = value
        index += 1
      }
    } else if (arg.startsWith('--budget=')) {
      const value = Number(arg.slice('--budget='.length))
      if (Number.isFinite(value) && value > 0) out.budgetMs = value
    }
  }
  out.targets = out.targets.filter((value) => value.trim().length > 0)
  return out
}

const HELP = `连接探针（开发者工具）：探测 provider 的 dns/tcp/tls/http 并打表。

  --target <url>    追加探测目标（可重复）
  --timeout <ms>    单步超时
  --budget <ms>     总预算
  --json            输出原始 JSON
  --allow-issue     有 issue 也 exit 0
  --discover-only   只发现目标，不探测
`

/* ------------------------------------------------------------------ *
 * 2. 配置文件扫描（自我包含，不依赖 lib/facts.js）
 * ------------------------------------------------------------------ */

const stripQuotes = (text) => String(text ?? '').trim().replace(/^['"]|['"]$/g, '')

function indentOf(line) {
  return line.length - line.trimStart().length
}

/** 去掉 userinfo 与 hash；查询串保留但打印时另走 displayUrl（只印 origin+path） */
function sanitizeUrl(raw) {
  const trailing = String(raw ?? '')
    .replace(/[)\]},;]+$/, '')
    .trim()
  if (!trailing) return undefined
  // 允许 "api.deepseek.com/v1" 这种没协议头的写法（模块的 parseEndpoint 本来就收），本机名按 http 补
  const schemed = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trailing)
    ? trailing
    : `${/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(trailing) ? 'http' : 'https'}://${trailing}`
  try {
    const url = new URL(schemed)
    url.username = ''
    url.password = ''
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

/** 打印用：origin + path，绝不带查询串（有些网关把 key 放 query 里） */
function displayUrl(raw) {
  try {
    const url = new URL(raw)
    return url.origin + (url.pathname === '/' ? '' : url.pathname)
  } catch {
    return String(raw ?? '')
  }
}

function isLocalHost(hostname) {
  const host = String(hostname ?? '').toLowerCase()
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    host === 'host.docker.internal' ||
    host.startsWith('127.')
  )
}

function configFile(profileDir) {
  const patch = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patch)) return patch
  const plain = join(profileDir, 'cordis.yml')
  if (existsSync(plain)) return plain
  return undefined
}

/**
 * 逐行扫描配置，返回块列表。块 = 一个 `- id:`/`- name:` 条目，
 * 里面收集 provider 名与 URL，并保留各自的真实行号（差异排查时要用）。
 */
function scanConfig(text, file) {
  const lines = String(text ?? '').split(/\r?\n/)
  const blocks = []
  let current = null
  let providersIndent = -1

  const pushProvider = (block, name, lineNo, via) => {
    const cleaned = stripQuotes(name)
    if (!cleaned) return
    if (block.providers.some((item) => item.name === cleaned)) return
    block.providers.push({ name: cleaned, lineNo, via })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const lineNo = index + 1
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    // 密钥行整行跳过：即使它的值长得像 URL 也不碰
    if (SECRET_LINE.test(raw)) continue

    const open = BLOCK_OPEN.exec(raw)
    if (open && indentOf(raw) <= 2) {
      current = { file, lineNo, id: '', name: '', providers: [], urls: [] }
      blocks.push(current)
      providersIndent = -1
      const name = stripQuotes(open[3])
      if (open[2] === 'id') current.id = name
      else current.name = name
      continue
    }
    if (!current) continue

    const map = PROVIDERS_MAP.exec(raw)
    if (map) {
      providersIndent = map[1].length
      continue
    }
    if (providersIndent >= 0) {
      const indent = indentOf(raw)
      if (indent <= providersIndent) providersIndent = -1
      else if (indent === providersIndent + 2) {
        const child = PROVIDER_CHILD.exec(raw)
        if (child) {
          pushProvider(current, child[2], lineNo, 'map')
          continue
        }
      }
    }

    const scalar = PROVIDER_SCALAR.exec(raw)
    if (scalar) {
      pushProvider(current, scalar[1] ?? scalar[2], lineNo, 'scalar')
      continue
    }

    const urlMatch = URL_LINE.exec(raw)
    if (urlMatch) {
      const value = sanitizeUrl(urlMatch[2])
      if (value) current.urls.push({ key: urlMatch[1], value, lineNo })
      continue
    }
  }

  return blocks
}

/** 模块给不出默认地址时的最后一层兜底：常见 provider 的公开地址 */
const FALLBACK_DEFAULTS = {
  deepseek: 'https://api.deepseek.com',
  'deepseek-official': 'https://api.deepseek.com',
  'deepseek-account': 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  buzz: 'https://api.buzzgw.com',
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234/v1',
}

/** PROVIDER_DEFAULTS 的形状未知：字符串、对象或用 id 索引都可能 */
function defaultEndpointFor(providerId, providerDefaults) {
  const candidates = [providerDefaults, FALLBACK_DEFAULTS]
  for (const table of candidates) {
    if (!table) continue
    const entry = table[providerId]
    if (typeof entry === 'string' && entry.length > 0) return entry
    if (entry && typeof entry === 'object') {
      const url = entry.endpoint ?? entry.baseURL ?? entry.baseUrl ?? entry.base_url ?? entry.url ?? entry.apiBase
      if (typeof url === 'string' && url.length > 0) return url
    }
  }
  return undefined
}

function slug(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * 把块整理成 target 列表。
 * 关联规则：**按行号就近归属** —— 一个 URL 属于它上面最近的那个 provider 名
 * （providers 映射里 `buzz:` 在第 35 行，它的 `baseURL:` 在第 39 行，中间还夹着 openai），
 * 所以「按出现顺序配对」会串味，必须比较行号。没有归属的 URL 用块自身 id/name 当标签；
 * 没拿到 URL 的 provider 退到默认地址，默认表也没有的记进 skipped。
 */
function buildTargets({ blocks, cliTargets, providerDefaults }) {
  const targets = []
  const skipped = []
  const duplicates = []
  const seen = new Map()
  let counter = 0

  const add = (target) => {
    counter += 1
    const id = target.id || `t${counter}`
    const key = displayUrl(target.endpoint).toLowerCase()
    if (seen.has(key)) {
      duplicates.push({ id, endpoint: key, first: seen.get(key) })
      return
    }
    seen.set(key, id)
    targets.push({ ...target, id })
  }

  for (const block of blocks) {
    const label = block.name || block.id || 'block'
    const source = `${block.file}:${block.lineNo}`
    const providers = block.providers
    const urls = block.urls
    if (urls.length === 0 && providers.length === 0) continue

    const claimed = new Set()

    for (const url of urls) {
      const above = providers.filter((item) => item.lineNo < url.lineNo)
      const owner =
        above.filter((item) => !claimed.has(item.name)).sort((a, b) => b.lineNo - a.lineNo)[0] ??
        (providers.length === 1 ? providers[0] : undefined)
      if (owner) claimed.add(owner.name)
      add({
        id: owner ? `prov-${slug(owner.name)}` : `cfg-${slug(block.id || label) || 'block'}-${url.lineNo}`,
        label: owner?.name ?? (urls.length > 1 ? `${label}#${url.lineNo}` : label),
        provider: owner?.name,
        endpoint: url.value,
        basePath: url.key === 'basePath' ? url.value : undefined,
        local: isLocalHost(safeHost(url.value)),
        source: `${block.file}:${url.lineNo} (${url.key}${owner ? ` ← ${owner.name}:${owner.lineNo}` : ''})`,
      })
    }

    for (const provider of providers) {
      if (claimed.has(provider.name)) continue
      const endpoint = defaultEndpointFor(provider.name, providerDefaults)
      if (!endpoint) {
        skipped.push({ provider: provider.name, source: `${block.file}:${provider.lineNo}`, reason: '配置里没有地址，默认表里也没有' })
        continue
      }
      add({
        id: `prov-${slug(provider.name)}-default`,
        label: provider.name,
        provider: provider.name,
        endpoint,
        local: isLocalHost(safeHost(endpoint)),
        source: `${block.file}:${provider.lineNo} (默认地址)`,
      })
    }
  }

  cliTargets.forEach((raw, index) => {
    const endpoint = sanitizeUrl(raw)
    if (!endpoint) {
      skipped.push({ provider: `命令行 #${index + 1}`, source: 'argv', reason: '不是合法 URL' })
      return
    }
    add({
      id: `cli-${index + 1}`,
      label: `命令行 #${index + 1}`,
      endpoint,
      local: isLocalHost(safeHost(endpoint)),
      source: 'argv',
    })
  })

  return { targets, skipped, duplicates }
}

function safeHost(endpoint) {
  try {
    return new URL(endpoint).hostname
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * 3. 模块契约自检（静态 import 会在文件缺失时直接炸，所以走动态 import）
 * ------------------------------------------------------------------ */

async function loadModule() {
  try {
    const namespace = await import('../lib/connectivity.js')
    return { module: namespace.default && !namespace.collectConnectivity ? namespace.default : namespace }
  } catch (error) {
    return { module: undefined, error }
  }
}

/** 从真实源码里抽出导出名与行号，用于「契约 vs 实际」的差异报告 */
function inspectExports(file) {
  if (!existsSync(file)) return { file, exists: false, exports: [] }
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const found = []
  const push = (name, lineNo) => {
    if (!found.some((item) => item.name === name)) found.push({ name, lineNo })
  }
  lines.forEach((line, index) => {
    const lineNo = index + 1
    const decl = /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/.exec(line)
    if (decl) push(decl[1], lineNo)
    const list = /^\s*export\s*\{([^}]*)\}/.exec(line)
    if (list) {
      for (const piece of list[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/).pop()
        if (name) push(name.trim(), lineNo)
      }
    }
    const star = /^\s*export\s+\*\s+from\s+['"]([^'"]+)['"]/.exec(line)
    if (star) push(`* from ${star[1]}`, lineNo)
  })
  return { file, exists: true, exports: found }
}

function reportContract({ module, error, providerDefaults }) {
  const expected = ['collectConnectivity', 'parseEndpoint', 'describeProxy', 'PROVIDER_DEFAULTS']
  const missing = []
  if (!module) {
    console.log('❌ 加载 lib/connectivity.js 失败：')
    console.log(`   ${error?.code ?? ''} ${error?.message ?? error}`)
    console.log('   期望契约：')
    console.log('     collectConnectivity({ targets, proxyEnv, timeoutMs, totalBudgetMs })')
    console.log('     parseEndpoint · describeProxy · PROVIDER_DEFAULTS')
  } else {
    if (typeof module.collectConnectivity !== 'function') missing.push('collectConnectivity')
    if (typeof module.parseEndpoint !== 'function') missing.push('parseEndpoint')
    if (typeof module.describeProxy !== 'function') missing.push('describeProxy')
    if (providerDefaults == null) missing.push('PROVIDER_DEFAULTS')
  }
  return { expected, missing }
}

function printExportDiff(missing) {
  const file = join(import.meta.dirname ?? '.', '..', 'lib', 'connectivity.js')
  const info = inspectExports(file)
  console.log(`   实际文件：${file}${info.exists ? '' : '（不存在）'}`)
  if (info.exists) {
    const actual = info.exports.length
      ? info.exports.map((item) => `${item.name}:${item.lineNo}`).join(' · ')
      : '(没有匹配到 export 声明)'
    console.log(`   实际导出：${actual}`)
  }
  if (missing.length) console.log(`   契约缺口：${missing.join(' · ')}`)
}

/* ------------------------------------------------------------------ *
 * 4. 结果读取（容忍模块内部形状的细微差异，缺字段就打 ⏭ 而不是崩）
 * ------------------------------------------------------------------ */

function normalizeStatus(raw) {
  const text = String(raw ?? '').toLowerCase()
  if (['pass', 'ok', 'true', 'up', 'healthy', 'success', 'done'].includes(text)) return 'pass'
  if (['warn', 'warning', 'degraded', 'partial', 'slow'].includes(text)) return 'warn'
  if (['fail', 'failed', 'error', 'false', 'down', 'refused', 'timeout', 'unreachable'].includes(text)) return 'fail'
  if (['skip', 'skipped', 'pending', 'idle'].includes(text)) return 'skip'
  return 'unknown'
}

function statusOf(probe) {
  if (probe == null) return 'skip'
  const raw = probe.status ?? probe.state ?? probe.result ?? probe.outcome
  // probes.http.status 往往就是 HTTP 状态码（数字），不能当「步骤状态」读
  if (typeof raw === 'string') return normalizeStatus(raw)
  if (probe.ok === true) return 'pass'
  if (probe.ok === false) return 'fail'
  if (probe.error) return 'fail'
  if (typeof raw === 'number') return 'pass' // 拿到响应码就说明这一步通了
  if (probe.skipped === true) return 'skip'
  return 'unknown'
}

const glyph = (status) => ANSI[status] ?? ANSI.unknown

function oneLine(text, maxChars = 120) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > maxChars ? flat.slice(0, maxChars) + '…' : flat
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function ipList(probe) {
  const raw = probe?.addresses ?? probe?.ips ?? probe?.answers ?? probe?.records ?? []
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return list
    .map((item) => (typeof item === 'string' ? item : item?.address ?? item?.ip ?? item?.value))
    .filter((item) => typeof item === 'string' && item.length > 0)
}

function msOf(probe) {
  const value = num(probe?.ms) ?? num(probe?.durationMs) ?? num(probe?.latencyMs) ?? num(probe?.elapsedMs)
  return value === undefined ? undefined : `${Math.round(value)}ms`
}

function daysLeft(probe) {
  const direct = num(probe?.daysRemaining) ?? num(probe?.daysLeft)
  if (direct !== undefined) return Math.round(direct)
  const stamp = probe?.validTo ?? probe?.notAfter ?? probe?.expiresAt
  if (stamp) {
    const at = new Date(stamp)
    if (!Number.isNaN(at.getTime())) return Math.round((at.getTime() - Date.now()) / 86400000)
  }
  return undefined
}

function httpStatusOf(probe) {
  // 真模块用 httpStatus 承载状态码，probes.http.status 是步骤状态（ok/fail/skip）
  return num(probe?.httpStatus) ?? num(probe?.statusCode)
}

function classificationOf(probe, item) {
  return probe?.classification ?? item?.classification ?? item?.summary?.classification ?? undefined
}

function verdictOf(item) {
  const raw = item?.summary?.verdict ?? item?.verdict ?? item?.summary?.status ?? (item?.summary?.ok === true ? 'pass' : item?.summary?.ok === false ? 'issue' : undefined)
  const text = String(raw ?? '').toLowerCase()
  if (text === 'pass' || text === 'ok') return 'pass'
  if (text === 'unknown' || text === '') return 'unknown'
  if (!raw) return 'unknown'
  return 'issue'
}

function pick(value, list) {
  return Array.isArray(value) ? value.slice(0, list) : []
}

function stepDetail(step, probe, target, fallbackNote) {
  const status = statusOf(probe)
  const error = probe && (probe.error ?? probe.message ?? probe.detail ?? probe.reason)
  // skip 也要说清为什么跳过（本地目标 / 明文 http / DNS 失败 / 预算用尽），沉默的 ⏭ 会让人误读
  if (status === 'skip') return oneLine(probe?.detail ?? fallbackNote ?? '未探测', 80)
  if (status === 'fail') {
    // 中文 detail 比 "timeout: 20: This operation was aborted" 这种底层报错更好读
    const reason = [probe?.detail, error].find((value) => typeof value === 'string' && /[\u4e00-\u9fa5]/.test(value)) ?? error
    return reason ? oneLine(reason, 90) : '失败（模块未给原因）'
  }
  if (step === 'dns') {
    const ips = ipList(probe)
    const host = probe?.hostname ?? safeHost(target.endpoint)
    const parts = [`${host || '?'} → ${ips.length} 个 IP`]
    if (ips.length) parts.push(`(${ips.slice(0, 2).join(', ')}${ips.length > 2 ? ', …' : ''})`)
    const ms = msOf(probe)
    if (ms) parts.push(`· ${ms}`)
    return parts.join(' ')
  }
  if (step === 'tcp') {
    const host = probe?.host ?? probe?.hostname ?? safeHost(target.endpoint)
    const port = num(probe?.port) ?? (Number(new URL(target.endpoint).port) || (target.endpoint.startsWith('https') ? 443 : 80))
    const ms = msOf(probe)
    return `${host || '?'}:${port}${ms ? ` · ${ms}` : ''}`
  }
  if (step === 'tls') {
    const days = daysLeft(probe)
    const subject = probe?.subject ?? probe?.cn ?? probe?.subjectCN ?? probe?.issuer
    const ms = msOf(probe)
    const parts = [days === undefined ? '握手成功（未给有效期）' : `剩余 ${days} 天`]
    if (subject) parts.push(`· ${oneLine(subject, 50)}`)
    if (ms) parts.push(`· ${ms}`)
    return parts.join(' ')
  }
  const httpCode = httpStatusOf(probe)
  const classification = classificationOf(probe, undefined)
  const ms = msOf(probe)
  const parts = []
  if (httpCode !== undefined) parts.push(`HTTP ${httpCode}`)
  if (classification?.code) parts.push(`· ${classification.code}`)
  if (classification?.label) {
    // 模块的 label 自带状态码（"鉴权失败（401）"），前面已经印过 HTTP 401 就不再重复
    const label = httpCode === undefined ? classification.label : classification.label.replace(new RegExp(`[（(]\\s*${httpCode}\\s*[）)]$`), '')
    if (label) parts.push(`· ${oneLine(label, 40)}`)
  }
  if (!parts.some((part) => part && part.length)) parts.push(error ? oneLine(error, 90) : '有响应')
  if (ms) parts.push(`· ${ms}`)
  return parts.filter((part) => typeof part === 'string' && part.length > 0).join(' ')
}

/* ------------------------------------------------------------------ *
 * 5. 渲染
 * ------------------------------------------------------------------ */

function renderTable({ discovery, configPath, profileDir, args, result, describeProxy, parseEndpoint }) {
  const { targets, skipped, blocks } = discovery
  const duplicates = discovery.duplicates ?? []
  console.log('== DSH Doctor 连接探针 ==')
  console.log(`profile    = ${profileDir}`)
  console.log(`config     = ${configPath ?? '(未找到 cordis.patch.yml)'}`)
  if (configPath) {
    const withProvider = blocks.filter((block) => block.providers.length > 0).length
    const withUrl = blocks.filter((block) => block.urls.length > 0).length
    console.log(`配置块     = ${blocks.length} 个 · 带 provider ${withProvider} 个 · 带 URL ${withUrl} 个`)
  }
  console.log(
    `目标       = ${targets.length} 个（配置 ${targets.filter((item) => item.source !== 'argv').length} · 命令行 ${targets.filter((item) => item.source === 'argv').length}）`,
  )
  if (duplicates.length) console.log(`去重       = ${duplicates.length} 个（同 URL 已合并到 ${[...new Set(duplicates.map((item) => item.first))].join(', ')}）`)
  if (skipped.length) {
    console.log(`未探测     = ${skipped.length} 个`)
    for (const item of skipped) console.log(`             · ${item.provider} — ${item.reason}`)
  }
  console.log(`超时       = ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms/步 · 预算 ${args.budgetMs ?? DEFAULT_BUDGET_MS}ms`)
  console.log(`转发       = ${renderProxy(result.proxy, describeProxy)}`)
  console.log(`collectedAt= ${result.collectedAt ?? '(未给出)'}`)
  console.log(`partial    = ${result.partial === true ? '是（预算耗尽/部分步骤跳过）' : '否'}`)
  const notes = Array.isArray(result.notes) ? result.notes : []
  for (const note of notes.slice(0, 5)) console.log(`note       = ${oneLine(note, 110)}`)
  console.log('')

  const results = Array.isArray(result.results) ? result.results : []
  const byTarget = new Map()
  for (const item of results) {
    const key = String(item?.targetId ?? item?.id ?? '')
    if (!byTarget.has(key)) byTarget.set(key, [])
    byTarget.get(key).push(item)
  }

  const viewed = new Set()
  const rows = []

  targets.forEach((target, index) => {
    const items = byTarget.get(target.id) ?? []
    const item = items[0]
    viewed.add(target.id)
    const verdict = verdictOf(item)
    rows.push({ target, item, verdict })
    const parsed = endpointOf(target, parseEndpoint)
    console.log(`── [${index + 1}/${targets.length}] ${target.label} — ${parsed.origin}${parsed.path}`)
    console.log(`   id       = ${target.id}${target.provider ? ` · provider ${target.provider}` : ''}`)
    console.log(`   来源     = ${target.source}${target.local ? ' · 本机地址' : ''}`)
    console.log(`   endpoint = ${formatEndpoint(target.endpoint, target.basePath, parseEndpoint)}`)
    if (!item) {
      console.log(`   结果     = ⏭ 模块没有返回这个目标（可能预算耗尽或被跳过）`)
      console.log(`   verdict  = unknown`)
      console.log('')
      return
    }
    const probes = item.probes ?? item.steps ?? {}
    for (const step of STEPS) {
      const probe = probes[step]
      console.log(`   ${step.padEnd(5)} ${glyph(statusOf(probe))} ${stepDetail(step, probe, target, item.summary?.note)}`)
    }
    console.log(`   verdict  = ${verdict}`)
    if (item.summary?.note) console.log(`   note     = ${oneLine(item.summary.note, 110)}`)
    if (item.summary?.detail) console.log(`   detail   = ${oneLine(item.summary.detail, 110)}`)
    console.log('')
  })

  // 模块返回了配置里没有的目标（例如它自己发现的内置目标）也要打出来
  for (const [key, items] of byTarget) {
    if (viewed.has(key)) continue
    const item = items[0]
    const probes = item?.probes ?? {}
    console.log(`── [额外] ${key}`)
    for (const step of STEPS) {
      console.log(`   ${step.padEnd(5)} ${glyph(statusOf(probes[step]))} ${stepDetail(step, probes[step], { endpoint: '' })}`)
    }
    console.log(`   verdict  = ${verdictOf(item)}`)
    console.log('')
  }
  return rows
}

function renderProxy(proxy, describeProxy) {
  // result.proxy 本身就是 describeProxy(env) 的返回值，直接排版即可；
  // 只有在模块没给 proxy 时才回退到自己调一次 describeProxy（入参必须是 env，不是它自己的产物）
  let info = proxy
  if (!info && typeof describeProxy === 'function') {
    try {
      info = describeProxy(process.env)
    } catch (error) {
      return `describeProxy 抛错：${oneLine(error?.message ?? error, 90)}`
    }
  }
  if (!info) return '(模块未给出代理信息)'
  if (typeof info === 'string') return oneLine(info, 200)
  const bits = []
  if (info.detected === true) bits.push('检测到代理环境变量')
  else if (info.detected === false) bits.push('未检测到代理环境变量')
  if (info.httpsProxy) bits.push(`https_proxy=${oneLine(info.httpsProxy, 60)}`)
  if (info.httpProxy && info.httpProxy !== info.httpsProxy) bits.push(`http_proxy=${oneLine(info.httpProxy, 60)}`)
  if (info.noProxy) bits.push(`no_proxy=${oneLine(info.noProxy, 40)}`)
  if (info.source) bits.push(`source=${info.source}`)
  if (!bits.length) {
    const keys = ['url', 'httpsProxy', 'httpProxy', 'all', 'mode', 'source']
    for (const key of keys) if (info[key]) bits.push(`${key}=${oneLine(info[key], 60)}`)
  }
  return bits.length ? bits.join(' · ') : oneLine(JSON.stringify(info), 160)

}

/** 优先用模块的 parseEndpoint（这正是它的职责），抛错或缺失时退回 URL 解析 */
function endpointOf(target, parseEndpoint) {
  try {
    if (typeof parseEndpoint === 'function') {
      const parsed = parseEndpoint(target.endpoint)
      if (typeof parsed === 'string' && parsed.length) {
        const url = new URL(parsed)
        return { origin: url.origin, path: url.pathname === '/' ? '' : url.pathname }
      }
      if (parsed && typeof parsed === 'object') {
        // 真模块：{ ok, origin, basePath, host, port, protocol, isLocal }，路径在 basePath 里
        const origin = parsed.origin ?? parsed.base ?? parsed.baseUrl ?? ''
        const path = parsed.path ?? parsed.pathname ?? parsed.basePath ?? ''
        if (origin) return { origin: String(origin), path: String(path ?? ''), ok: parsed.ok !== false, error: parsed.error }
        if (parsed.ok === false) return { origin: String(target.endpoint ?? ''), path: '', ok: false, error: parsed.error }
      }
    }
  } catch {
    // 模块的 parseEndpoint 不接受这一形状：退回 URL 解析，不让整个渲染炸掉
  }
  try {
    const url = new URL(target.endpoint)
    return { origin: url.origin, path: url.pathname === '/' ? '' : url.pathname }
  } catch {
    return { origin: String(target.endpoint ?? ''), path: '', ok: false }
  }
}

function formatEndpoint(endpoint, basePath, parseEndpoint) {
  const parsed = endpointOf({ endpoint, basePath }, parseEndpoint)
  const shown = `${parsed.origin}${parsed.path}${parsed.ok === false && parsed.error ? `  ⚠️ ${parsed.error}` : ''}`
  if (!basePath) return shown
  return parsed.path.endsWith(basePath) ? shown : `${shown} · basePath ${basePath}`
}

/** 第一个失败的步骤 + 它的原因：比「HTTP 拿不到状态码」更能指向根因 */
function firstFailingStep(item) {
  const probes = item?.probes ?? {}
  for (const step of STEPS) {
    const probe = probes[step]
    if (statusOf(probe) !== 'fail') continue
    const text = [probe?.detail, probe?.error].find((value) => typeof value === 'string' && value.trim().length)
    return text ? `${step} — ${oneLine(text, 90)}` : step
  }
  return null
}

function renderConclusion(rows, result) {
  const counts = { pass: 0, issue: 0, unknown: 0 }
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1

  console.log('== 结论 ==')

  for (const row of rows) {
    const { target, item, verdict } = row
    const classification = classificationOf(item?.probes?.http ?? item?.probes?.['http'], item)
    const causes = pick(classification?.likelyCauses, 2)
    const next = pick(classification?.nextChecks, 2)
    if (verdict === 'issue') {
      console.log(`- issue  ${target.label} (${displayUrl(target.endpoint)})`)
      const breakpoint = firstFailingStep(item)
      if (breakpoint) console.log(`   失败点    ：${breakpoint}`)
      console.log(`   最可能原因：${causes.length ? causes.map((text) => oneLine(text, 80)).join('；') : '模块未给出 classification.likelyCauses'}`)
      console.log(`   下一步    ：${next.length ? next.map((text) => oneLine(text, 80)).join('；') : '模块未给出 classification.nextChecks'}`)
    } else if (verdict === 'unknown') {
      console.log(`- unknown ${target.label} (${displayUrl(target.endpoint)}) — 数据不足，无法判定`)
    } else {
      console.log(`- pass   ${target.label} (${displayUrl(target.endpoint)})`)
    }
  }
  if (rows.length === 0) console.log('(没有目标)')

  const errors = Array.isArray(result.errors) ? result.errors : []
  if (errors.length) {
    console.log(`模块报告 ${errors.length} 个错误：`)
    for (const error of errors.slice(0, 5)) console.log(`  ! ${oneLine(typeof error === 'string' ? error : (error?.message ?? error?.error ?? JSON.stringify(error)), 120)}`)
  }
  console.log('')
  console.log(`耗时 ${Math.round(num(result.durationMs) ?? 0)}ms`)
  console.log(`total: ${rows.length} · pass ${counts.pass} · issue ${counts.issue} · unknown ${counts.unknown}`)
  return counts
}

/** JSON 输出前把密钥类字段抹掉：模块不该带，但我们不赌 */
function scrubForJson(value, depth = 0) {
  if (value === null || depth > 6) return value
  if (Array.isArray(value)) return value.map((item) => scrubForJson(item, depth + 1))
  if (typeof value !== 'object') return value
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    if (/api[-_]?key|token|secret|password|passwd|authorization|cookie/i.test(key)) out[key] = '[redacted]'
    else out[key] = scrubForJson(inner, depth + 1)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 6. 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(HELP)
    return 0
  }

  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = process.env.DSH_PROFILE_DIR || detectProfileDir(home)
  const configPath = profileDir ? configFile(profileDir) : undefined

  const loaded = await loadModule()
  const providerDefaults = loaded.module?.PROVIDER_DEFAULTS

  let blocks = []
  let scanError
  try {
    blocks = configPath ? scanConfig(readFileSync(configPath, 'utf8'), configPath) : []
  } catch (error) {
    scanError = error
  }
  const discovery = { ...buildTargets({ blocks, cliTargets: args.targets, providerDefaults }), blocks }

  if (args.discoverOnly) {
    console.log(`profile = ${profileDir}`)
    console.log(`config  = ${configPath ?? '(未找到)'}`)
    console.log(`块      = ${discovery.blocks.length} 个`)
    console.log(`目标    = ${discovery.targets.length} 个${discovery.skipped.length ? ` · 跳过 ${discovery.skipped.length} 个` : ''}`)
    for (const target of discovery.targets) {
      console.log(`  · ${target.label.padEnd(24)} ${target.provider ? `${target.provider} → ` : ''}${displayUrl(target.endpoint)}  [${target.source}]`)
    }
    for (const item of discovery.skipped) console.log(`  ⏭ ${item.provider} — ${item.reason}`)
    return 0
  }

  const contract = reportContract({ module: loaded.module, error: loaded.error, providerDefaults })

  if (scanError) console.log(`⚠️ 读配置失败：${oneLine(scanError.message ?? scanError, 120)}`)
  if (!configPath) console.log('⚠️ 没找到 cordis.patch.yml / cordis.yml，只有命令行目标可用')

  if (contract.missing.length || typeof loaded.module?.collectConnectivity !== 'function') {
    // 契约不符时仍然把目标发现结果交出来，方便对照另一侧的实现
    if (loaded.module) console.log(`⚠️ 契约不符：lib/connectivity.js 存在，但缺少 ${contract.missing.join(' · ')}`)
    console.log('')
    printExportDiff(contract.missing)
    console.log('')
    console.log(`发现目标 ${discovery.targets.length} 个（未探测）`)
    for (const target of discovery.targets) {
      console.log(`  · ${target.label.padEnd(22)} ${target.provider ? `${target.provider} → ` : ''}${displayUrl(target.endpoint)}`)
    }
    return 2
  }

  const startedAt = Date.now()
  let result
  try {
    result = await loaded.module.collectConnectivity({
      targets: discovery.targets,
      proxyEnv: process.env,
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      totalBudgetMs: args.budgetMs ?? DEFAULT_BUDGET_MS,
    })
  } catch (error) {
    console.log(`❌ collectConnectivity 抛错：${oneLine(error?.stack ?? error?.message ?? error, 400)}`)
    return 2
  }
  const wallClockMs = Date.now() - startedAt

  if (!result || typeof result !== 'object') {
    console.log(`❌ collectConnectivity 返回值不是对象：${typeof result}`)
    printExportDiff(contract.missing)
    return 2
  }
  if (result.durationMs === undefined) result.durationMs = wallClockMs

  if (args.json) {
    console.log(JSON.stringify(scrubForJson({ argv: process.argv.slice(2), profileDir, configPath, targets: discovery.targets, skipped: discovery.skipped, result }), null, 2))
    const countsJson = { pass: 0, issue: 0, unknown: 0 }
    for (const item of Array.isArray(result.results) ? result.results : []) {
      const verdict = verdictOf(item)
      countsJson[verdict] = (countsJson[verdict] ?? 0) + 1
    }
    if (args.allowIssue) return 0
    return countsJson.issue > 0 ? 1 : 0
  }

  const rows = renderTable({
    discovery,
    configPath,
    profileDir,
    args,
    result,
    describeProxy: loaded.module.describeProxy,
    parseEndpoint: loaded.module.parseEndpoint,
  })
  const counts = renderConclusion(rows, result)
  if (args.allowIssue) return 0
  return counts.issue > 0 ? 1 : 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`❌ 探针自身崩溃：${error?.stack ?? error}`)
    process.exitCode = 2
  })
