/**
 * DSH Doctor — 模型与网络连接检测器（connectivity 探测引擎）。
 *
 * 这一层只回答一个问题：**「这个模型地址，从本机到底能不能用，卡在哪一步」**。
 * 它不做判定（判定在 rules.js），也不装配报告（装配在 facts/diag），只输出可复现的探测证据。
 *
 * 四条设计边界：
 *
 * 1. **只读**：只做 DNS / TCP / TLS / HTTP 的无副作用探测。不发任何 Authorization，
 *    不读 ~/.dsh/.credentials.yaml，不打印密钥；HTTP 响应体只留前 300 字符并脱敏。
 *    调用方就算把 Authorization 塞进 headers，这里也会主动丢掉（见 sanitizeHeaders）。
 * 2. **可注入**：fetch / dns.lookup / net.connect / tls.connect / 时间源全部能从 options 覆盖。
 *    离线单测不需要真网络，也不会因为机器断网就红。
 * 3. **不猜**：探测失败 ≠ 判定失败。分类结果一定带 confidence 和多个 likelyCauses，
 *    因为「HTTP 401」至少有四种成因（Key 错 / Key 撤了 / provider 对不上 / 项目配额空）。
 * 4. **有预算**：每个探测各自超时，collectConnectivity 还有总预算；预算用尽就返回已完成
 *    的部分（partial: true），不让一次体检把面板卡死。
 *
 * 几条被实测修正过的现实（写在这里，省得后人再踩一遍）：
 *
 * - Node 内置 fetch（undici）**默认不读** HTTPS_PROXY/http_proxy。所以 describeProxy 只
 *   报告环境变量，并明确提示「是否真的走代理取决于 fetch 实现」；探测结果和浏览器不一致时，
 *   第一嫌疑就是这一点，而不是「网络坏了」。
 * - DeepSeek 余额不足返回 **402**（payment required），429 才是限流。把两者混成一个
 *   "rate limit" 会给出错误的下一步建议（去充值 vs 去退避）。
 * - 5xx 里 502/503/504 值得重试一次，其余不值得；超时重试只会把等待时间翻倍，所以不重试。
 * - TLS 探测用 rejectUnauthorized:false 建连：目的是**拿到证书**并读出 authorized/有效期，
 *   而不是让握手在证书过期时直接失败、什么信息都留不下。
 */

import { lookup as dnsLookupPromise } from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'

/** 探测步骤的固定顺序：后一步依赖前一步的结果，顺序即因果链。 */
export const PROBE_KINDS = ['dns', 'tcp', 'tls', 'http']

/**
 * 常见 provider 的默认 baseURL（纯公开信息，不含任何密钥）。
 * 只作为「用户没填 endpoint 时的兜底候选」，不参与鉴权，也不代表这些地址此刻可用。
 */
export const PROVIDER_DEFAULTS = {
  // DeepSeek 官方：OpenAI 兼容，带不带 /v1 都收，文档里两种写法都出现过
  'deepseek-official': 'https://api.deepseek.com',
  'deepseek-account': 'https://api.deepseek.com',
  deepseek: 'https://api.deepseek.com',
  // 中转 / 网关
  buzzgw: 'https://api.buzzgw.com',
  // 其它常见 OpenAI 兼容服务
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api',
  siliconflow: 'https://api.siliconflow.cn',
  moonshot: 'https://api.moonshot.cn',
  minimax: 'https://api.minimax.chat',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode',
  zhipu: 'https://open.bigmodel.cn/api/paas',
  groq: 'https://api.groq.com/openai',
  together: 'https://api.together.xyz',
  // 本机推理服务：默认端口没开服务连不上，属正常现象，不是故障
  ollama: 'http://localhost:11434',
  'ollama-openai': 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
  vllm: 'http://localhost:8000/v1',
  llama_cpp: 'http://localhost:8080/v1',
}

/** 总预算保护：剩余不足这个数就不再启动新探测（启动也只会超时，白等）。 */
const MIN_STEP_MS = 250

/** HTTP 响应体只留这么多字符：够看出是哪类错误，又不至于把整页 HTML 塞进报告。 */
const MAX_BODY_SNIPPET = 300

/** 单次 HTTP 重试的退避（只用于 502/503/504 和连接被重置）。 */
const RETRY_BACKOFF_MS = 120

/** 这些头永远不从本模块发出去（凭据类）。 */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-goog-api-key',
  'anthropic-api-key',
])

/* ------------------------------------------------------------------ *
 * 地址解析
 * ------------------------------------------------------------------ */

/**
 * 解析 endpoint。
 *
 * 支持三种真实写法：
 *   https://api.buzzgw.com/v1     （完整地址 + basePath）
 *   http://localhost:11434        （本机服务）
 *   api.deepseek.com              （无协议，按 defaultProtocol 补 https）
 *
 * 解析失败不抛异常，返回 ok:false + error：探测链路上「地址写错」是很常见的一类问题，
 * 它应该变成一条 issue，而不是一个把整次体检炸掉的异常。
 */
export function parseEndpoint(raw, { defaultProtocol = 'https' } = {}) {
  const protocol = defaultProtocol === 'http' || defaultProtocol === 'http:' ? 'http:' : 'https:'
  const defaultPort = protocol === 'https:' ? 443 : 80
  const text = raw === undefined || raw === null ? '' : String(raw).trim()
  const base = {
    ok: false,
    raw: text,
    protocol,
    host: '',
    port: defaultPort,
    basePath: '',
    origin: '',
    isLocal: false,
  }
  if (!text) return { ...base, error: '地址为空' }

  // 没有协议头的写法（"api.deepseek.com/v1"）按默认协议补全，这是用户最常见的输入形态
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `${protocol}//${text}`

  let url
  try {
    url = new URL(withScheme)
  } catch {
    return { ...base, error: `无法解析地址：${text}` }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ...base, error: `只支持 http/https，收到 ${url.protocol}` }
  }

  const bare = url.hostname.replace(/^\[|\]$/g, '')
  if (!bare) return { ...base, error: `缺少主机名：${text}` }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ...base, protocol: url.protocol, host: bare, error: `端口不合法：${url.port}` }
  }

  const basePath = normalizeBasePath(url.pathname)
  const authority = formatAuthority(bare, port, url.protocol)

  return {
    ok: true,
    raw: text,
    protocol: url.protocol,
    host: bare,
    port,
    basePath,
    origin: `${url.protocol}//${authority}`,
    isLocal: isLocalHost(bare),
  }
}

/** "https://host/v1/" -> "/v1"；空路径与 "/" 都归成 ''，方便后面拼 path。 */
function normalizeBasePath(pathname) {
  let path = String(pathname ?? '')
  if (!path || path === '/') return ''
  path = path.replace(/\/+$/, '')
  if (path && !path.startsWith('/')) path = `/${path}`
  return path
}

/** 默认端口不写进 origin（和 URL.origin 的语义保持一致）。 */
function formatAuthority(host, port, protocol) {
  const shown = net.isIP(host) === 6 ? `[${host}]` : host
  const isDefault = (protocol === 'https:' && port === 443) || (protocol === 'http:' && port === 80)
  return isDefault ? shown : `${shown}:${port}`
}

/**
 * 本机地址判定。这些目标跳过 DNS（本来就不该解析）和 TLS（本地多半是明文 http）。
 * 0.0.0.0/:: 也算本机：探测它们等价于探测 loopback。
 */
function isLocalHost(host) {
  const value = String(host ?? '').toLowerCase()
  if (!value) return false
  if (value === 'localhost' || value.endsWith('.localhost')) return true
  if (value === '::1' || value === '0.0.0.0' || value === '::') return true
  if (net.isIP(value) === 4 && value.startsWith('127.')) return true
  return false
}

/* ------------------------------------------------------------------ *
 * DNS
 * ------------------------------------------------------------------ */

function defaultDnsLookup(host) {
  return dnsLookupPromise(host, { all: true, verbatim: true })
}

/**
 * DNS 探测。返回的 addresses 只用于展示与判断「解析成功」，不做任何访问控制。
 *
 * dnsLookup 可注入成三种形态，都能跑：
 *   (host) => Promise<[{address, family}] | string[]>
 *   (host, cb) => cb(err, value)      // Node 原生回调风格
 *   (host) => value                   // 同步假实现，给单测用
 */
export async function probeDns(host, { timeoutMs = 4000, dnsLookup } = {}) {
  const startedAt = Date.now()
  const cleanHost = String(host ?? '').trim()
  if (!cleanHost) {
    return {
      kind: 'dns',
      status: 'skip',
      host: cleanHost,
      addresses: [],
      durationMs: 0,
      detail: '没有主机名，跳过 DNS 探测',
    }
  }

  const lookup = dnsLookup ?? defaultDnsLookup
  try {
    const raw = await withTimeout(runLookup(lookup, cleanHost), timeoutMs, `DNS 解析超时（${cleanHost}，${timeoutMs}ms）`)
    const addresses = normalizeAddresses(raw)
    if (addresses.length === 0) {
      return {
        kind: 'dns',
        status: 'fail',
        host: cleanHost,
        addresses,
        durationMs: elapsed(startedAt),
        error: 'ENOTFOUND: no address returned',
        detail: `解析 ${cleanHost} 没有拿到任何地址`,
      }
    }
    const shown = addresses.slice(0, 3)
    return {
      kind: 'dns',
      status: 'ok',
      host: cleanHost,
      addresses,
      durationMs: elapsed(startedAt),
      detail: `解析到 ${addresses.length} 个地址：${shown.join('、')}${addresses.length > shown.length ? ' …' : ''}`,
    }
  } catch (error) {
    const verdict = classifyNetworkError(error)
    return {
      kind: 'dns',
      status: 'fail',
      host: cleanHost,
      addresses: [],
      durationMs: elapsed(startedAt),
      error: describeError(error),
      detail: `${cleanHost} 域名解析失败：${verdict.detail}`,
    }
  }
}

async function runLookup(lookup, host) {
  // 默认实现是 promises API，签名是 (host, options)，不能再塞一个回调进去
  if (lookup === defaultDnsLookup) return defaultDnsLookup(host)
  return invoke(lookup, host)
}

/** 把各种形态的解析结果统一成字符串数组。 */
function normalizeAddresses(value) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    if (item === undefined || item === null) continue
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim())
      continue
    }
    const address = item.address ?? item.addr
    if (address) out.push(String(address))
  }
  return out
}

/* ------------------------------------------------------------------ *
 * TCP
 * ------------------------------------------------------------------ */

function defaultTcpConnect({ host, port, timeoutMs }) {
  return new Promise((resolveConnect, rejectConnect) => {
    let settled = false
    let socket
    const finish = (error, value) => {
      if (settled) return
      settled = true
      try {
        socket?.removeAllListeners()
        socket?.destroy()
      } catch {
        /* 关闭失败无害 */
      }
      if (error) rejectConnect(error)
      else resolveConnect(value)
    }
    try {
      socket = net.connect({ host, port })
    } catch (error) {
      finish(error)
      return
    }
    socket.setTimeout(timeoutMs, () => {
      const error = new Error(`TCP 连接超时（${host}:${port}，${timeoutMs}ms）`)
      error.code = 'ETIMEDOUT'
      finish(error)
    })
    socket.once('error', (error) => finish(error))
    socket.once('connect', () => finish(undefined, true))
  })
}

/**
 * TCP 探测：只确认端口在监听，不发任何字节。
 * connect 可注入：({ host, port, timeoutMs }) => boolean | Promise<boolean>。
 * 返回 false 也算「连接失败」，方便假实现显式表达 refused。
 */
export async function probeTcp({ host, port } = {}, { timeoutMs = 4000, connect } = {}) {
  const startedAt = Date.now()
  const cleanHost = String(host ?? '').trim()
  const numericPort = Number(port)
  const safePort = Number.isFinite(numericPort) && numericPort > 0 ? numericPort : null

  if (!cleanHost || safePort === null) {
    return {
      kind: 'tcp',
      status: 'skip',
      host: cleanHost,
      port: safePort,
      connected: false,
      durationMs: 0,
      detail: '缺少主机或端口，跳过 TCP 探测',
    }
  }

  const connector = connect ?? defaultTcpConnect
  try {
    const result = await withTimeout(
      Promise.resolve().then(() => connector({ host: cleanHost, port: safePort, timeoutMs })),
      timeoutMs,
      `TCP 连接超时（${cleanHost}:${safePort}，${timeoutMs}ms）`,
    )
    if (result === false) {
      return {
        kind: 'tcp',
        status: 'fail',
        host: cleanHost,
        port: safePort,
        connected: false,
        durationMs: elapsed(startedAt),
        error: 'ECONNREFUSED: connector returned false',
        detail: `${cleanHost}:${safePort} 拒绝连接`,
      }
    }
    return {
      kind: 'tcp',
      status: 'ok',
      host: cleanHost,
      port: safePort,
      connected: true,
      durationMs: elapsed(startedAt),
      detail: `已连接 ${cleanHost}:${safePort}`,
    }
  } catch (error) {
    const verdict = classifyNetworkError(error)
    return {
      kind: 'tcp',
      status: 'fail',
      host: cleanHost,
      port: safePort,
      connected: false,
      durationMs: elapsed(startedAt),
      error: describeError(error),
      detail: `${cleanHost}:${safePort} 连不上（${verdict.label}）`,
    }
  }
}

/* ------------------------------------------------------------------ *
 * TLS
 * ------------------------------------------------------------------ */

function defaultTlsConnect({ host, port, servername, timeoutMs }) {
  return new Promise((resolveConnect, rejectConnect) => {
    let settled = false
    let socket
    const finish = (error, value) => {
      if (settled) return
      settled = true
      try {
        socket?.removeAllListeners()
        socket?.destroy()
      } catch {
        /* 关闭失败无害 */
      }
      if (error) rejectConnect(error)
      else resolveConnect(value)
    }
    try {
      // rejectUnauthorized:false 是刻意的：证书有问题时也先把证书读出来再说
      socket = tls.connect({ host, port, servername, rejectUnauthorized: false })
    } catch (error) {
      finish(error)
      return
    }
    socket.setTimeout(timeoutMs, () => {
      const error = new Error(`TLS 握手超时（${host}:${port}，${timeoutMs}ms）`)
      error.code = 'ETIMEDOUT'
      finish(error)
    })
    socket.once('error', (error) => finish(error))
    socket.once('secureConnect', () => {
      let cert = {}
      try {
        cert = socket.getPeerCertificate(true) ?? {}
      } catch {
        cert = {}
      }
      finish(undefined, {
        authorized: socket.authorized === true,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : undefined,
        protocol: socket.getProtocol() ?? undefined,
        cipher: socket.getCipher()?.name,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        subject: certName(cert.subject),
        issuer: certName(cert.issuer),
      })
    })
  })
}

/**
 * TLS 探测：握手 + 证书有效期 + 是否受信任。
 *
 * authorized 语义：true=证书链校验通过；false=握手成功但证书不被信任（自签/过期/域名不符）；
 * null=拿不到判断（假实现或对端不给证书）。status 只在 authorized !== false 时才是 ok。
 */
export async function probeTls({ host, port } = {}, { timeoutMs = 5000, servername, connectTls } = {}) {
  const startedAt = Date.now()
  const cleanHost = String(host ?? '').trim()
  const numericPort = Number(port)
  const safePort = Number.isFinite(numericPort) && numericPort > 0 ? numericPort : null
  const sni = servername ?? cleanHost

  if (!cleanHost || safePort === null) {
    return {
      kind: 'tls',
      status: 'skip',
      host: cleanHost,
      port: safePort,
      authorized: null,
      protocol: null,
      validFrom: null,
      validTo: null,
      daysLeft: null,
      subject: null,
      issuer: null,
      durationMs: 0,
      detail: '缺少主机或端口，跳过 TLS 探测',
    }
  }

  const connector = connectTls ?? defaultTlsConnect
  try {
    const info = await withTimeout(
      Promise.resolve().then(() => connector({ host: cleanHost, port: safePort, servername: sni, timeoutMs })),
      timeoutMs,
      `TLS 握手超时（${cleanHost}:${safePort}，${timeoutMs}ms）`,
    )

    const authorized = info?.authorized === true ? true : info?.authorized === false ? false : null
    const authorizationError = info?.authorizationError ? String(info.authorizationError) : null
    // connectTls 的注入形态不唯一：真实实现给的是 socket（要自己取 getPeerCertificate），
    // 测试/别的探测库可能直接给一个 info 对象。两种都接住，否则 daysLeft 会静默变成 null。
    const tlsInfo = normalizeTlsInfo(info)
    const validFrom = toIso(tlsInfo.validFrom)
    const validTo = toIso(tlsInfo.validTo)
    const validToMs = toMs(tlsInfo.validTo)
    const daysLeft = validToMs === null ? null : Math.floor((validToMs - Date.now()) / 86400000)
    const protocol = tlsInfo.protocol ? String(tlsInfo.protocol) : null
    const subject = certName(tlsInfo.subject)
    const issuer = certName(tlsInfo.issuer)
    const common = {
      kind: 'tls',
      host: cleanHost,
      port: safePort,
      authorized,
      protocol,
      validFrom,
      validTo,
      daysLeft,
      subject,
      issuer,
    }

    if (authorized === false) {
      const verdict = classifyNetworkError({ code: authorizationError ?? 'CERT_UNTRUSTED', message: authorizationError ?? '' })
      const expired = /CERT_HAS_EXPIRED|CERT_NOT_YET_VALID/i.test(authorizationError ?? '')
      const detail = expired
        ? `证书已过期（到期 ${validTo ?? '未知'}${daysLeft === null ? '' : `，已过期 ${Math.abs(daysLeft)} 天`}）`
        : `证书不受信任（${verdict.label}）`
      return {
        ...common,
        status: 'fail',
        durationMs: elapsed(startedAt),
        error: authorizationError ?? 'CERT_UNTRUSTED',
        detail: protocol ? `${detail} · ${protocol}` : detail,
      }
    }

    // 证书已经过期但握手方仍然报告 authorized=true 的情况：真实 Node 会置 authorized=false，
    // 但注入实现未必。到期时间在手上就以时间为准，否则这条会静默报「正常」。
    if (authorized !== false && daysLeft !== null && daysLeft < 0) {
      return {
        ...common,
        status: 'fail',
        durationMs: elapsed(startedAt),
        error: 'CERT_HAS_EXPIRED',
        detail: `证书已过期（到期 ${validTo ?? '未知'}，已过期 ${Math.abs(daysLeft)} 天）`,
      }
    }

    const parts = [`TLS 握手成功（${protocol ?? '协议未知'}`]
    if (daysLeft !== null) parts.push(`证书 ${daysLeft >= 0 ? `${daysLeft} 天后到期` : `已过期 ${Math.abs(daysLeft)} 天`}`)
    if (issuer) parts.push(`签发者 ${issuer}`)
    return {
      ...common,
      status: 'ok',
      durationMs: elapsed(startedAt),
      detail: `${parts.join('，')}）`,
    }
  } catch (error) {
    const verdict = classifyNetworkError(error)
    return {
      kind: 'tls',
      status: 'fail',
      host: cleanHost,
      port: safePort,
      authorized: null,
      protocol: null,
      validFrom: null,
      validTo: null,
      daysLeft: null,
      subject: null,
      issuer: null,
      durationMs: elapsed(startedAt),
      error: describeError(error),
      detail: `TLS 握手失败（${verdict.label}）`,
    }
  }
}

/**
 * 把 connectTls 的返回值归一成 { authorized, authorizationError, protocol, validFrom, validTo, subject, issuer }。
 * 入参可能是 tls.TLSSocket（有 getPeerCertificate()），也可能是一个普通信息对象。
 */
function normalizeTlsInfo(info) {
  if (!info || typeof info !== 'object') return {}
  if (typeof info.getPeerCertificate === 'function') {
    let cert = {}
    try {
      cert = info.getPeerCertificate() ?? {}
    } catch {
      cert = {}
    }
    let protocol = info.protocol
    try {
      protocol = typeof info.getProtocol === 'function' ? info.getProtocol() : protocol
    } catch {
      /* 部分实现没有 getProtocol */
    }
    return {
      authorized: info.authorized,
      authorizationError: info.authorizationError,
      protocol,
      validFrom: cert.valid_from ?? cert.validFrom,
      validTo: cert.valid_to ?? cert.validTo,
      subject: cert.subject ?? null,
      issuer: cert.issuer ?? null,
    }
  }
  return {
    authorized: info.authorized,
    authorizationError: info.authorizationError,
    protocol: info.protocol,
    validFrom: info.validFrom ?? info.valid_from,
    validTo: info.validTo ?? info.valid_to,
    subject: info.subject ?? null,
    issuer: info.issuer ?? null,
  }
}

/** 证书名：优先 CN，其次前几个字段拼一下；没有就 null。 */function certName(value) {
  if (!value) return null
  if (typeof value === 'string') return value
  const cn = value.CN ?? value.cn
  if (cn) return String(cn)
  const parts = Object.entries(value)
    .slice(0, 3)
    .map(([key, val]) => `${key}=${val}`)
  return parts.length > 0 ? parts.join(', ') : null
}

function toMs(value) {
  if (value === undefined || value === null) return null
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isNaN(ms) ? null : ms
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const ms = Date.parse(String(value))
  return Number.isNaN(ms) ? null : ms
}

function toIso(value) {
  if (value === undefined || value === null) return null
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isNaN(ms) ? null : new Date(ms).toISOString()
  }
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null
  const ms = Date.parse(String(value))
  return Number.isNaN(ms) ? String(value) : new Date(ms).toISOString()
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function resolveHttpTarget(endpoint, path) {
  const parsed = typeof endpoint === 'string' || endpoint === undefined || endpoint === null ? parseEndpoint(endpoint ?? '') : endpoint
  if (!parsed?.ok) return { parsed, url: null }
  const suffix = path === undefined || path === null || path === '' ? parsed.basePath || '/' : String(path)
  const normalized = suffix.startsWith('/') ? suffix : `/${suffix}`
  return { parsed, url: `${parsed.origin}${normalized}` }
}

/**
 * HTTP 探测：**不带凭据**的一次 GET。
 *
 * 关键约定：
 * - status 表示「有没有拿到 HTTP 响应」（传输层），语义由 classification 表达。
 *   这样 401/503 也能说清「服务可达，卡在鉴权/服务端」，而不是笼统地算失败。
 * - 不跟随跨 host 的重定向；maxRedirects=0 时一个都不跟，只把 3xx 如实报出来。
 * - 502/503/504 与连接被重置重试一次；超时绝不重试（重试只会让等待翻倍）。
 */
export async function probeHttp(
  endpoint,
  { timeoutMs = 8000, path, method = 'GET', headers = {}, fetchImpl, maxRedirects = 0, retry = 1 } = {},
) {
  const startedAt = Date.now()
  const upperMethod = String(method ?? 'GET').toUpperCase()
  const { parsed, url } = resolveHttpTarget(endpoint, path)
  const fallbackUrl = url ?? String(endpoint?.raw ?? endpoint ?? '')

  if (!parsed?.ok || !url) {
    return {
      kind: 'http',
      status: 'skip',
      url: fallbackUrl,
      method: upperMethod,
      httpStatus: null,
      classification: classifyHttpStatus(null, {}),
      durationMs: 0,
      retryAfterMs: null,
      contentType: null,
      server: null,
      bodySnippet: '',
      error: parsed?.error ?? 'INVALID_ENDPOINT',
      detail: `地址无法解析，跳过 HTTP 探测（${parsed?.error ?? '未知原因'}）`,
    }
  }

  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    return {
      kind: 'http',
      status: 'fail',
      url,
      method: upperMethod,
      httpStatus: null,
      classification: classifyHttpStatus(null, {}),
      durationMs: elapsed(startedAt),
      retryAfterMs: null,
      contentType: null,
      server: null,
      bodySnippet: '',
      error: 'NO_FETCH: globalThis.fetch is not available',
      detail: '当前运行时没有可用的 fetch 实现，无法做 HTTP 探测',
    }
  }

  const safeHeaders = sanitizeHeaders(headers)
  const attempts = Math.max(1, Math.min(2, Number(retry) + 1 || 1))
  let last
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await requestWithRedirects({
      url,
      method: upperMethod,
      headers: safeHeaders,
      fetchImpl: doFetch,
      timeoutMs,
      maxRedirects: Number(maxRedirects) || 0,
    })
    if (attempt + 1 < attempts && shouldRetryHttp(last)) {
      await sleep(RETRY_BACKOFF_MS)
      continue
    }
    break
  }

  if (last?.error) {
    let verdict = classifyNetworkError(last.error)
    if (last.timedOut && verdict.code !== 'timeout') {
      // 假实现可能不认 signal；超时标记优先于其它分类
      verdict = networkTemplate('timeout')
    }
    return {
      kind: 'http',
      status: 'fail',
      url: last.url ?? url,
      method: upperMethod,
      httpStatus: null,
      // 失败原因是网络层的：把 classifyNetworkError 的整条分类带上，而不是固定写 unknown。
      // status/httpStatus 不变（fail/null）：这里确实没拿到任何 HTTP 响应。
      classification: networkClassification(verdict),
      durationMs: elapsed(startedAt),
      retryAfterMs: null,
      contentType: null,
      server: null,
      bodySnippet: '',
      error: `${verdict.code}: ${describeError(last.error)}`,
      detail: `HTTP 请求失败（${verdict.label}）：${verdict.detail}`,
    }
  }

  // 只有真实数值/整数数字串里的 100..599 才算「拿到了 HTTP 响应」。
  // null/undefined/0/''/布尔/NaN/Infinity/越界/小数一律 null → 不能算 ok。
  const rawStatus = last?.status
  const httpStatus = normalizeHttpStatus(rawStatus)
  const retryAfterMs = parseRetryAfter(headerGet(last?.headers, 'retry-after'))
  const bodySnippet = sanitizeSnippet(last?.body, MAX_BODY_SNIPPET)
  const classification = classifyHttpStatus(httpStatus, { bodySnippet, retryAfterMs })
  const contentType = headerGet(last?.headers, 'content-type')
  const server = headerGet(last?.headers, 'server')
  // 拿到响应却没有可用状态码：这是传输层缺陷（假响应、被中间层改写、协议错乱），
  // detail 不能写「服务可达」，也不该把 0 之类的占位值当状态码展示。
  const shownStatus = rawStatus === undefined ? 'undefined' : JSON.stringify(rawStatus)

  const result = {
    kind: 'http',
    status: httpStatus === null ? 'fail' : 'ok',
    url: last?.url ?? url,
    method: upperMethod,
    httpStatus,
    classification,
    durationMs: elapsed(startedAt),
    retryAfterMs,
    contentType: contentType ? String(contentType).slice(0, 160) : null,
    server: server ? String(server).slice(0, 120) : null,
    bodySnippet,
    detail:
      httpStatus === null
        ? `响应里没有可用的 HTTP 状态码（收到 ${shownStatus}）：只确认连接有响应，无法判断服务状态`
        : `服务可达（HTTP ${httpStatus} · ${classification.label}）${classification.code === 'ok' ? '' : `：${classification.detail}`}`,
  }
  if (httpStatus === null) result.error = `INVALID_HTTP_STATUS: 响应里的 status=${shownStatus} 不是 100..599 的整数`
  return result
}

async function requestWithRedirects({ url, method, headers, fetchImpl, timeoutMs, maxRedirects }) {
  let currentUrl = url
  let redirectsLeft = Math.max(0, maxRedirects)
  for (let hop = 0; hop <= redirectsLeft; hop += 1) {
    const result = await requestOnce({ url: currentUrl, method, headers, fetchImpl, timeoutMs })
    if (result.error) return result
    const status = Number(result.status)
    const isRedirect = status >= 300 && status < 400
    if (!isRedirect) return result
    const location = headerGet(result.headers, 'location')
    if (!location) return result
    const nextUrl = safeResolveUrl(currentUrl, location)
    if (!nextUrl) return result
    // 只在同源内部跟随：跨 host 的重定向一律不跟（避免被导到未知目标）
    if (new URL(nextUrl).origin !== new URL(currentUrl).origin) return result
    if (redirectsLeft <= 0) return result
    redirectsLeft -= 1
    currentUrl = nextUrl
  }
  return { url: currentUrl, status: null, headers: null, body: '', error: new Error('重定向次数过多') }
}

async function requestOnce({ url, method, headers, fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      controller.abort()
    } catch {
      /* ignore */
    }
  }, Math.max(1, timeoutMs))

  try {
    const response = await withTimeout(
      Promise.resolve().then(() =>
        fetchImpl(url, {
          method,
          headers,
          redirect: 'manual',
          credentials: 'omit',
          signal: controller.signal,
        }),
      ),
      Math.max(1, timeoutMs),
      `HTTP 请求超时（${url}，${timeoutMs}ms）`,
    )
    const body = await readBody(response)
    return { url, status: response?.status ?? null, headers: response?.headers ?? null, body, timedOut }
  } catch (error) {
    return { url, status: null, headers: null, body: '', error, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

async function readBody(response) {
  try {
    const length = Number(headerGet(response?.headers, 'content-length'))
    // 大响应不读：探测只需要状态码，把 5MB HTML 拖进内存没有意义
    if (Number.isFinite(length) && length > 512 * 1024) return ''
    if (typeof response.text !== 'function') return ''
    const text = await response.text()
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

function shouldRetryHttp(result) {
  if (!result) return false
  if (result.error) {
    const verdict = classifyNetworkError(result.error)
    return verdict.code === 'reset'
  }
  const status = Number(result.status)
  return status === 502 || status === 503 || status === 504
}

/* ------------------------------------------------------------------ *
 * 分类
 * ------------------------------------------------------------------ */

const HTTP_CODES = {
  ok: {
    label: '连接正常',
    likelyCauses: ['网络、TLS、鉴权与接口路径都正常'],
    nextChecks: ['如需确认模型本身可用，下一步才是发一次最小推理请求（v1 刻意不做，避免消耗 token）'],
  },
  auth: {
    label: '鉴权失败（401）',
    likelyCauses: [
      'API Key 没配置、拼错、或已被撤销',
      'Key 与 endpoint 不是同一家 provider（把中转 Key 发给了官方地址，或反过来）',
      'Key 已过期，或所在组织/项目被禁用',
    ],
    nextChecks: [
      '在 provider 控制台确认 Key 仍然有效',
      '核对 endpoint 与 Key 是否属于同一来源',
      '用 curl -H "Authorization: Bearer $KEY" 手工复现一次（不要贴进报告）',
    ],
  },
  forbidden: {
    label: '权限不足（403）',
    likelyCauses: [
      'Key 有效，但没有该模型/接口的权限',
      '组织或项目级限制（地区、合规、模型白名单）',
      '中转网关按出口 IP 或来源域名做了限制',
    ],
    nextChecks: [
      '换一个有权限的 Key/项目再试',
      '在控制台确认该模型已开通',
      '若走中转，确认网关允许当前出口 IP',
    ],
  },
  'rate-limit': {
    label: '限流（429）',
    likelyCauses: [
      '短时间内请求过多，触发 RPM/TPM 限制',
      '并发太高或上层在重试风暴',
      '免费额度档位被限速',
    ],
    nextChecks: [
      '按 Retry-After 退避后重试',
      '降低并发与频率',
      '在控制台查看当前档位的限流规则',
    ],
  },
  quota: {
    label: '配额/余额不足',
    likelyCauses: [
      '账户余额不足（DeepSeek 这类服务返回 402）',
      '免费额度用尽或套餐到期',
      'Key 所属项目配额已用尽',
    ],
    nextChecks: [
      '登录平台确认余额与配额',
      '换一个还有额度的 Key/项目',
      '确认不是把「配额」误判成「网络不通」',
    ],
  },
  server: {
    label: '服务端错误（5xx）',
    likelyCauses: [
      'provider 侧故障或过载（502/503/504 最常见）',
      '中转网关后端不可用',
      '请求触发上游风控被拒',
    ],
    nextChecks: [
      '隔几分钟重试，观察是否自愈',
      '查看 provider 状态页',
      '换直连地址对照，判断是不是中转的问题',
    ],
  },
  client: {
    label: '请求被拒（4xx）',
    likelyCauses: [
      '路径拼错（basePath 少了或多了 /v1）',
      '请求方法或参数不被接受',
      '模型名在当前 provider 不存在',
    ],
    nextChecks: [
      '对照文档核对 baseURL 与路径',
      '用 /models 这类只读接口验证路径',
      '看响应体里的 error.message（报告里只保留前 300 字符）',
    ],
  },
  'not-found': {
    label: '接口不存在（404）',
    likelyCauses: [
      'basePath 拼错（/v1 有或无）',
      '该 provider 没有这个接口或模型',
      '网关没配置这条路由',
    ],
    nextChecks: [
      '去掉 /v1 再试一次，确认哪一层 404',
      '对照文档确认接口路径',
      '确认 endpoint 指向的是 OpenAI 兼容层',
    ],
  },
  unknown: {
    label: '未拿到有效状态码',
    likelyCauses: ['连接在拿到响应前就断了', '响应的状态码不可解析'],
    nextChecks: ['用 curl -v 复现，看请求停在哪一步', '检查是否有中间设备改写了响应'],
  },
}

/**
 * HTTP 状态码分类。**状态码本身定不了根因**，所以每个结果都带 confidence 和至少两个
 * likelyCauses：401 也可能是配额问题，429 也可能是配额问题，403 也可能是 Key 没权限。
 */
export function classifyHttpStatus(httpStatus, { bodySnippet = '', retryAfterMs = null } = {}) {
  // 与 probeHttp 共用同一套严格解析：0/''/true/null 都不能进「有效状态码」分支。
  const status = normalizeHttpStatus(httpStatus)
  const text = String(bodySnippet ?? '').toLowerCase()
  const hasQuota = /quota|insufficient|exceeded|balance|credit|余额|配额|额度/.test(text)
  const hasRate = /rate.?limit|too many requests|requests per|tpm|rpm|限流|频率/.test(text)
  const hasAuthWord = /invalid.*(api.?key|token)|unauthor|authentication|认证|令牌|密钥/.test(text)

  const make = (code, { confidence = 'high', label, detail, likelyCauses, nextChecks } = {}) => {
    const base = HTTP_CODES[code] ?? HTTP_CODES.unknown
    return {
      code,
      // label 可覆盖：3xx 复用 unknown 这个 code（下游 rules/inference 的判定语义不变），
      // 但「未拿到有效状态码」这句话对 3xx 是错的——我们明明拿到了状态码。
      label: label ?? base.label,
      confidence,
      detail: detail ?? base.likelyCauses[0],
      likelyCauses: likelyCauses ?? base.likelyCauses,
      nextChecks: nextChecks ?? base.nextChecks,
    }
  }

  if (status === null) {
    return make('unknown', { confidence: 'low', detail: '没有拿到 HTTP 状态码，无法判断服务状态' })
  }

  if (status >= 200 && status < 300) {
    return make('ok', { confidence: 'high', detail: `HTTP ${status}，服务与路径都正常` })
  }

  if (status === 401) {
    if (hasQuota) {
      return make('quota', {
        confidence: 'medium',
        detail: `HTTP 401，但响应体提到配额/余额——可能是额度耗尽而不是 Key 错`,
        likelyCauses: ['Key 所在项目配额用尽，被上游以 401 拒绝', 'Key 无效或已撤销', 'Key 与 endpoint 不匹配'],
        nextChecks: ['先去控制台确认余额与配额', '再核对 Key 是否属于当前 provider', '换一个 Key 对照，区分两种原因'],
      })
    }
    return make('auth', { confidence: hasAuthWord ? 'high' : 'medium', detail: `HTTP 401，服务可达，卡在鉴权` })
  }

  if (status === 403) {
    if (hasQuota) {
      return make('quota', {
        confidence: 'medium',
        detail: `HTTP 403，但响应体提到配额/余额——更像额度或权限策略问题`,
        likelyCauses: ['项目配额用尽', 'Key 无该模型权限', '网关按来源 IP/域名做了限制'],
        nextChecks: ['确认余额与配额', '确认模型是否开通', '确认出口 IP 是否被允许'],
      })
    }
    return make('forbidden', { confidence: 'high', detail: `HTTP 403，Key 有效但权限不够或来源被限制` })
  }

  if (status === 429) {
    if (hasRate || retryAfterMs !== null) {
      return make('rate-limit', {
        confidence: 'high',
        detail: retryAfterMs !== null ? `HTTP 429，服务可达，限流（建议 ${Math.round(retryAfterMs / 1000)}s 后重试）` : 'HTTP 429，服务可达，请求太频繁',
      })
    }
    if (hasQuota) {
      return make('quota', {
        confidence: 'medium',
        detail: 'HTTP 429，响应体提到配额/余额——可能是额度耗尽后的限速',
        likelyCauses: ['配额用尽被降速', '请求频率超限', '并发过高'],
        nextChecks: ['确认余额与配额', '按 Retry-After 退避重试', '降低并发'],
      })
    }
    return make('rate-limit', { confidence: 'medium', detail: 'HTTP 429，通常是限流（没有 Retry-After 时按经验判断）' })
  }

  if (status === 402) {
    return make('quota', { confidence: 'high', detail: 'HTTP 402，服务可达，需要付费：余额或配额不足' })
  }

  if (status === 404) {
    return make('not-found', { confidence: 'high', detail: 'HTTP 404，路径或模型名不存在' })
  }

  if (status >= 500 && status < 600) {
    return make('server', {
      confidence: status === 503 || status === 502 ? 'high' : 'medium',
      detail: `HTTP ${status}，服务可达，问题在服务端`,
    })
  }

  if (status >= 400 && status < 500) {
    if (hasQuota) {
      return make('quota', {
        confidence: 'medium',
        detail: `HTTP ${status}，响应体提到配额/余额，优先怀疑额度`,
        likelyCauses: ['配额/余额不足', '请求参数不被接受', '路径或模型名不对'],
        nextChecks: ['先确认余额与配额', '再核对请求参数与路径'],
      })
    }
    return make('client', { confidence: 'medium', detail: `HTTP ${status}，服务可达，请求被拒（多半是路径/参数/模型名）` })
  }

  if (status >= 300 && status < 400) {
    // 3xx 是**有效的 HTTP transport 响应**：状态码拿到了，只是探测按契约不跟随重定向
    // （maxRedirects=0，且绝不跨 host 跟随）。所以 code 沿用 unknown（下游判定语义不变），
    // 但 label/detail 必须说清「拿到了 HTTP 状态码」，不能再写「未拿到有效状态码」。
    return make('unknown', {
      confidence: 'medium',
      label: `重定向（3xx，未跟随）`,
      detail: `已拿到 HTTP ${status}（3xx 重定向）：探测按契约不跟随 Location，该地址不是最终的 API 入口`,
      likelyCauses: ['endpoint 少了或多了路径，被重定向', '网关把 http 跳到 https', '域名换了新地址'],
      nextChecks: ['把 Location 里的地址填成 endpoint 再试一次', '确认是否应该使用 https'],
    })
  }

  return make('unknown', { confidence: 'low', detail: `HTTP ${status}，不在已知分类里` })
}

const NETWORK_CODES = {
  timeout: {
    label: '连接超时',
    detail: '超时时间内没有完成握手或响应',
    likelyCauses: [
      'DNS/TCP/TLS 某一步被网络设备丢弃（公司网络、运营商限制最常见）',
      '目标服务过载或正在重启',
      '代理配置指向了不可达的代理',
      '本机防火墙静默丢包',
    ],
    nextChecks: [
      '用 curl -v --max-time 10 <URL> 复现，看卡在 DNS/TCP/TLS 哪一步',
      '确认 HTTPS_PROXY/http_proxy 没有指向不存在的代理',
      '换一个网络（手机热点）对照',
    ],
  },
  dns: {
    label: '域名解析失败',
    detail: '域名没有解析出 IP',
    likelyCauses: [
      '域名拼错或该域名已不存在',
      '本机 DNS 服务器不可用/被拦截',
      'hosts 覆盖了该域名',
      '离线环境或 VPN 未连接',
    ],
    nextChecks: [
      'nslookup <域名> 换个公共 DNS（1.1.1.1 / 223.5.5.5）对照',
      '检查 hosts 文件里是否有该域名',
      '确认当前能正常解析其它域名',
    ],
  },
  refused: {
    label: '连接被拒绝',
    detail: 'TCP 握手被对端明确拒绝',
    likelyCauses: [
      '端口没有服务在监听（本地模型服务没启动最常见）',
      '服务只监听 127.0.0.1，而请求打到了别的地址',
      '容器/虚拟机的端口没映射出来',
    ],
    nextChecks: [
      '确认服务已启动且端口正确（本地服务看它的启动日志）',
      '用 netstat -ano | findstr <端口> 看监听地址',
      '把 endpoint 的 host 换成 127.0.0.1 对照',
    ],
  },
  tls: {
    label: 'TLS/证书错误',
    detail: '证书校验失败或协议不兼容',
    likelyCauses: [
      '证书过期、自签或域名与证书不匹配',
      '公司网络做了 TLS 中间人（自签 CA 未被信任）',
      '对端只支持旧版 TLS 或 ALPN 不兼容',
    ],
    nextChecks: [
      '用 openssl s_client -connect <host>:<port> -servername <host> 看证书链',
      '确认系统时间正确（时间偏移会让证书看起来过期）',
      '公司网络下确认是否需要安装内部 CA',
    ],
  },
  proxy: {
    label: '代理错误',
    detail: '代理连接失败或代理拒绝转发',
    likelyCauses: [
      'HTTPS_PROXY 指向了不可达的代理',
      '代理需要认证但没带凭据（本探测刻意不带凭据）',
      'NO_PROXY 没包含目标域名，请求被送进了代理',
    ],
    nextChecks: [
      '确认代理进程在跑、端口正确',
      '把目标域名加进 NO_PROXY 再试',
      '临时清空 HTTPS_PROXY 对照',
    ],
  },
  reset: {
    label: '连接被重置',
    detail: '连接建立后被对端或中间设备重置',
    likelyCauses: [
      '中间设备按特征阻断了连接',
      '服务端进程崩溃/重启',
      '长连接被中间设备超时切断',
    ],
    nextChecks: ['重试一次看是否稳定复现', '换网络对照', '看服务端日志有没有对应时间点的错误'],
  },
  abort: {
    label: '请求被取消',
    detail: '请求被主动中止',
    likelyCauses: ['调用方取消了探测', '上层超时先把请求 abort 掉了'],
    nextChecks: ['确认不是上层超时设置过短', '重跑一次观察是否复现'],
  },
  unknown: {
    label: '未知网络错误',
    detail: '没有匹配到已知错误类型',
    likelyCauses: ['不常见的底层错误', '被中间层包装过的错误'],
    nextChecks: ['用 curl -v 复现拿到原始错误', '看错误对象的 code/cause 字段'],
  },
}

function networkTemplate(code) {
  const base = NETWORK_CODES[code] ?? NETWORK_CODES.unknown
  return { code, ...base }
}

/**
 * 把网络层分类原样转成 HTTP 探测的 classification。
 *
 * 为什么需要这个：探测失败时 `status:'fail'` + `httpStatus:null` 只说明「没拿到响应」，
 * 真正的原因（超时 / 拒绝 / DNS / 重置 / TLS / 代理 / 取消）在 classifyNetworkError 里。
 * 过去 probeHttp 的错误分支固定写 `classifyHttpStatus(null)`，classification.code 恒为
 * `unknown`，于是「被 1000ms 超时 abort 掉」在证据行里显示成「状态码不可解析」——
 * 结论错，且下游 inference 只能退回 TCP 兜底把它写成 refused。
 *
 * 字段与 classifyHttpStatus 的输出保持同一形状（code/label/confidence/detail/
 * likelyCauses/nextChecks），消费方不需要分支处理。
 */
function networkClassification(verdict) {
  const base = NETWORK_CODES[verdict?.code] ?? NETWORK_CODES.unknown
  return {
    code: verdict?.code ?? 'unknown',
    label: verdict?.label ?? base.label,
    // 分类码本身来自真实错误（code/message 双判据），除 unknown 外给 high：
    // 「没匹配到已知类型」才真的低置信。
    confidence: verdict?.code && verdict.code !== 'unknown' ? 'high' : 'low',
    detail: verdict?.detail ?? base.detail,
    likelyCauses: verdict?.likelyCauses ?? base.likelyCauses,
    nextChecks: verdict?.nextChecks ?? base.nextChecks,
  }
}

/**
 * 严格解析 HTTP 状态码。
 *
 * 只接受「真实数值」或「纯整数数字串」中的 100..599；其余一律返回 null：
 * null / undefined / 0 / '' / true / false / NaN / Infinity / 越界 / 小数。
 *
 * 为什么必须严格：旧写法是 `Number.isFinite(Number(last?.status)) ? Number(last.status) : null`，
 * 而 `Number(null) === 0`、`Number('') === 0`、`Number(true) === 1` 都是有限数，
 * 于是「响应对象为 null / status 缺失」被写成了 httpStatus=0 + status:'ok'，
 * 报告里出现「服务可达（HTTP 0）」这种不存在的状态码。缺失状态码只能算 fail。
 */
function normalizeHttpStatus(raw) {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 100 && raw <= 599 ? raw : null
  }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!/^[0-9]+$/.test(text)) return null
    const value = Number(text)
    return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
  }
  return null
}

/**
 * 网络错误分类。依据 err.code 为主、message 为辅：
 * ENOTFOUND/EAI_AGAIN → dns；ECONNREFUSED → refused；ETIMEDOUT → timeout；
 * ECONNRESET/EPIPE → reset；以 CERT_ 开头、DEPTH_ZERO_SELF_SIGNED_CERT、UNABLE_TO_VERIFY_LEAF_SIGNATURE 等
 * ERR_TLS_ 前缀 / EPROTO → tls；AbortError → abort（本模块自己的超时会打 __dshTimeout 标记 → timeout）。
 */
export function classifyNetworkError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase()
  const name = String(error?.name ?? '')
  const message = String(error?.message ?? error ?? '')
  const text = `${code} ${name} ${message}`.toLowerCase()

  if (error?.__dshTimeout || name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timed? ?out|timeout|超时/.test(text)) {
    return networkTemplate('timeout')
  }
  if (
    ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'ERR_NAME_NOT_RESOLVED', 'UND_ERR_DNS'].includes(code) ||
    /getaddrinfo|dns lookup|name resolution|域名解析/.test(text)
  ) {
    return networkTemplate('dns')
  }
  if (['ERR_PROXY_CONNECTION_FAILED', 'EPROXY', 'ERR_PROXY_AUTH_FAILED'].includes(code) || /proxy/.test(text)) {
    return networkTemplate('proxy')
  }
  if (code === 'ECONNREFUSED') return networkTemplate('refused')
  if (['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return networkTemplate('reset')
  if (
    code.startsWith('CERT_') ||
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'HOSTNAME_MISMATCH',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'EPROTO',
    ].includes(code) ||
    /certificate|ssl|tls handshake|self.signed/i.test(message)
  ) {
    return networkTemplate('tls')
  }
  if (code === 'ABORT_ERR' || name === 'AbortError' || /aborted|abort/.test(text)) {
    return networkTemplate('abort')
  }
  return networkTemplate('unknown')
}

/* ------------------------------------------------------------------ *
 * 代理
 * ------------------------------------------------------------------ */

/** 代理 URL 里的 userinfo 一律打码：报告里不能出现凭据。 */
function maskProxyUrl(value) {
  if (!value) return null
  try {
    const url = new URL(String(value))
    if (url.username || url.password) {
      url.username = '***'
      url.password = ''
    }
    return url.toString()
  } catch {
    // 不是合法 URL 就直接把 @ 之前的内容隐掉
    return String(value).replace(/\/\/[^/@]*@/, '//***@')
  }
}

/**
 * 读代理环境变量。大小写都看（Windows 上常见的是小写那套）。
 *
 * 注意 note 里的提醒：**Node 内置 fetch 默认不读这些变量**，探测是否真的走代理取决于
 * 运行时用的 fetch 实现。报告里不能假装「有代理就一定走代理」。
 */
export function describeProxy(env = {}) {
  const pick = (...names) => {
    for (const name of names) {
      const value = env?.[name]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return null
  }

  const allProxy = pick('ALL_PROXY', 'all_proxy')
  const httpsProxy = pick('HTTPS_PROXY', 'https_proxy') ?? allProxy
  const httpProxy = pick('HTTP_PROXY', 'http_proxy') ?? allProxy
  const noProxy = pick('NO_PROXY', 'no_proxy')
  const detected = Boolean(httpsProxy || httpProxy)

  return {
    detected,
    httpProxy: maskProxyUrl(httpProxy),
    httpsProxy: maskProxyUrl(httpsProxy),
    noProxy: noProxy ? String(noProxy) : null,
    source: detected ? 'env' : 'none',
    note: detected
      ? '检测到代理环境变量：本探测是否真的走代理取决于所用 fetch 实现（Node 内置 fetch 默认不读 HTTPS_PROXY）。探测结果与浏览器不一致时，先怀疑代理未生效或 NO_PROXY 把它绕过了。'
      : '未检测到代理环境变量（HTTPS_PROXY/http_proxy/ALL_PROXY）。若所在网络强制走代理，终端里的探测会直接失败，而浏览器可能仍然正常。',
  }
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

function problemAreaOf(code) {
  switch (code) {
    case 'auth':
      return '鉴权（Key 无效或与 endpoint 不匹配）'
    case 'forbidden':
      return '权限'
    case 'rate-limit':
      return '限流'
    case 'quota':
      return '配额/余额'
    case 'server':
      return '服务端'
    case 'client':
      return '请求本身（路径/参数/模型名）'
    case 'not-found':
      return '接口路径'
    default:
      return '未知环节'
  }
}

function stepNoteOf(kind, probe) {
  if (!probe) return ''
  if (kind === 'http' && probe.httpStatus !== null && probe.httpStatus !== undefined) {
    const label = probe.classification?.label ? ` · ${probe.classification.label}` : ''
    return (`HTTP ${probe.httpStatus}${label}：${probe.detail ?? ''}`).slice(0, 180)
  }
  if (probe.detail) return String(probe.detail).slice(0, 180)
  if (probe.error) return String(probe.error).slice(0, 180)
  return ''
}

/**
 * 单目标结论。
 *
 * 判定规则（与产品口径一致）：
 * - dns fail → 后续 step 记 skip，verdict=issue（域名解析不了，后面全是空动作）；
 * - **只有 http 拿到 2xx 才算 pass**；
 * - http 401/403 算 pass（探测不带凭据，能拿到 401 恰好证明服务活着）；429/5xx 算 issue，note 说清在哪一层；
 * - 全部 skip 或没有数据 → unknown（检测不到 ≠ 有问题）。
 */
export function summarizeTarget(target = {}, probes = {}) {
  const safeProbes = probes && typeof probes === 'object' ? probes : {}
  const targetId = target?.id ?? target?.targetId ?? null
  const label = target?.label ?? targetId ?? '目标'

  const dnsProbe = safeProbes.dns ?? null
  const dnsFailed = dnsProbe?.status === 'fail'
  const steps = []
  let skipReason = null

  for (const kind of PROBE_KINDS) {
    const probe = safeProbes[kind] ?? null
    if (!probe) {
      if (skipReason) steps.push({ step: kind, status: 'skip', note: skipReason })
      continue
    }
    let status = probe.status ?? 'skip'
    let note = stepNoteOf(kind, probe)
    if (kind !== 'dns' && dnsFailed && status !== 'skip') {
      // 防御：调用方传进来的 http.ok 但 dns 失败时，语义仍然按「前置失败」收敛
      status = 'skip'
      note = 'DNS 解析失败，跳过'
    }
    steps.push({ step: kind, status, note })
    if (kind === 'dns' && status === 'fail') skipReason = 'DNS 解析失败，后续步骤跳过'
  }

  const http = safeProbes.http ?? null
  // 同一套严格解析：httpStatus 为 null 的探针不能被 Number(null)===0 蒙成「可达」
  const httpStatus = normalizeHttpStatus(http?.httpStatus)
  const httpReachable = http?.status === 'ok' && httpStatus !== null
  const httpOk = httpReachable && httpStatus >= 200 && httpStatus < 300
  const httpFailed = http?.status === 'fail'

  if (dnsFailed) {
    return {
      targetId,
      label,
      verdict: 'issue',
      steps,
      note: `域名解析失败：${dnsProbe?.detail ?? dnsProbe?.error ?? '未知原因'}`,
    }
  }

  if (httpOk) {
    return { targetId, label, verdict: 'pass', steps, note: `${label} 连接正常（HTTP ${httpStatus}）` }
  }

  if (httpReachable) {
    const code = http?.classification?.code ?? 'unknown'
    const label2 = http?.classification?.label ?? '异常状态码'
    // 401/403 是「探测不带凭据」的必然结果，恰恰证明服务是活的 —— 不能算问题。
    // 这条口径必须与 rules.js 的 REACHABLE_HTTP_CODES 保持一致，否则面板与探针脚本会互相打脸。
    if (code === 'auth' || code === 'forbidden') {
      return {
        targetId,
        label,
        verdict: 'pass',
        steps,
        note: `服务可达（HTTP ${httpStatus} · ${label2}）；探测不带凭据，鉴权未验证`,
      }
    }
    return {
      targetId,
      label,
      verdict: 'issue',
      steps,
      note: `服务可达（HTTP ${httpStatus} · ${label2}），问题在${problemAreaOf(code)}`,
    }
  }

  if (httpFailed) {
    return {
      targetId,
      label,
      verdict: 'issue',
      steps,
      // http.detail 已经是完整的「HTTP 请求失败（原因）：…」，再包一层会读成叠字
      note: http?.detail ? String(http.detail) : `HTTP 请求失败：${http?.error ?? '未知原因'}`,
    }
  }

  if (safeProbes.tls?.status === 'fail') {
    return {
      targetId,
      label,
      verdict: 'issue',
      steps,
      note: `TLS 不可用：${safeProbes.tls?.detail ?? safeProbes.tls?.error ?? '未知原因'}`,
    }
  }

  if (safeProbes.tcp?.status === 'fail') {
    return {
      targetId,
      label,
      verdict: 'issue',
      steps,
      note: `TCP 连不上：${safeProbes.tcp?.detail ?? safeProbes.tcp?.error ?? '未知原因'}`,
    }
  }

  return {
    targetId,
    label,
    verdict: 'unknown',
    steps,
    note: steps.every((step) => step.status === 'skip')
      ? '所有探测都被跳过，无法判断（不代表有问题）'
      : '没有拿到足够的探测结果，无法判断（不代表有问题）',
  }
}

/* ------------------------------------------------------------------ *
 * 采集入口
 * ------------------------------------------------------------------ */

/**
 * 连接采集：对一组模型目标跑 DNS→TCP→TLS→HTTP，并给出每目标结论。
 *
 * 预算语义：
 * - 每个探测有自己的超时（dns/tcp 4s、tls 5s、http 用 timeoutMs），并且都会被裁剪到
 *   「剩余总预算」以内；
 * - 剩余预算低于 MIN_STEP_MS 就不再启动新探测，剩余目标直接 unknown + note='总预算用尽'，
 *   同时 partial=true —— 面板要能区分「探测失败」和「没来得及探测」。
 */
export async function collectConnectivity({
  targets = [],
  proxyEnv = process.env,
  timeoutMs = 8000,
  totalBudgetMs = 15000,
  fetchImpl,
  dnsLookup,
  connect,
  connectTls,
  now = Date.now,
} = {}) {
  const clock = typeof now === 'function' ? now : Date.now
  const startedAt = clock()
  const list = Array.isArray(targets) ? targets : []
  const httpTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 8000
  const budget = Number.isFinite(Number(totalBudgetMs)) && Number(totalBudgetMs) > 0 ? Number(totalBudgetMs) : 0
  const deadline = budget > 0 ? startedAt + budget : Number.POSITIVE_INFINITY

  const remainingMs = () => (Number.isFinite(deadline) ? deadline - clock() : Number.MAX_SAFE_INTEGER)
  const lowBudget = () => remainingMs() < MIN_STEP_MS
  const clampStep = (base) => Math.max(1, Math.min(base, httpTimeout, remainingMs()))

  const proxy = describeProxy(proxyEnv)
  const notes = [proxy.note]
  const results = []
  const errors = []
  const normalized = []
  let partial = false

  for (let index = 0; index < list.length; index += 1) {
    const target = list[index] ?? {}
    const targetId = target.id ?? target.targetId ?? `target-${index + 1}`
    const label = target.label ?? targetId
    const rawEndpoint = target.endpoint ?? target.baseUrl ?? target.url ?? target.baseURL ?? ''
    const parsed = parseEndpoint(rawEndpoint)

    normalized.push({
      id: targetId,
      label,
      provider: target.provider ?? null,
      endpoint: String(rawEndpoint ?? ''),
      origin: parsed.ok ? parsed.origin : null,
      local: parsed.ok ? parsed.isLocal : Boolean(target.local),
      source: target.source ?? null,
    })

    if (!parsed.ok) {
      errors.push({ targetId, step: 'parse', error: parsed.error ?? '地址无法解析' })
      results.push({
        targetId,
        probes: { dns: null, tcp: null, tls: null, http: null },
        summary: {
          targetId,
          label,
          verdict: 'unknown',
          steps: [],
          note: `endpoint 无法解析：${parsed.error ?? '未知原因'}`,
        },
      })
      continue
    }

    if (lowBudget()) {
      partial = true
      results.push(budgetExhaustedResult(targetId, label))
      continue
    }

    const local = parsed.isLocal || target.local === true
    const probes = { dns: null, tcp: null, tls: null, http: null }
    let dnsFailed = false
    let stopped = false

    // 1) DNS：本地目标跳过；失败则后续全部 skip（再探也没有意义）
    if (local) {
      probes.dns = skipProbe('dns', parsed, '本地目标，跳过 DNS 探测')
    } else if (lowBudget()) {
      stopped = true
    } else {
      probes.dns = await probeDns(parsed.host, { timeoutMs: clampStep(4000), dnsLookup })
      if (probes.dns.status === 'fail') {
        dnsFailed = true
        errors.push({ targetId, step: 'dns', error: probes.dns.error ?? probes.dns.detail })
      }
    }

    // 2) TCP：只要能解析就试；DNS 失败时不试
    if (!stopped) {
      if (dnsFailed) {
        probes.tcp = skipProbe('tcp', parsed, 'DNS 解析失败，跳过 TCP')
      } else if (lowBudget()) {
        stopped = true
      } else {
        probes.tcp = await probeTcp(
          { host: parsed.host, port: parsed.port },
          { timeoutMs: clampStep(4000), connect },
        )
        if (probes.tcp.status === 'fail') errors.push({ targetId, step: 'tcp', error: probes.tcp.error ?? probes.tcp.detail })
      }
    }

    // 3) TLS：只有 https 才做；本地目标跳过（本地多半是明文 http）
    if (!stopped) {
      if (dnsFailed) {
        probes.tls = skipProbe('tls', parsed, 'DNS 解析失败，跳过 TLS')
      } else if (parsed.protocol !== 'https:') {
        probes.tls = skipProbe('tls', parsed, '明文 http，跳过 TLS 探测')
      } else if (local) {
        probes.tls = skipProbe('tls', parsed, '本地目标，跳过 TLS 探测')
      } else if (lowBudget()) {
        stopped = true
      } else {
        probes.tls = await probeTls(
          { host: parsed.host, port: parsed.port },
          { timeoutMs: clampStep(5000), connectTls },
        )
        if (probes.tls.status === 'fail') errors.push({ targetId, step: 'tls', error: probes.tls.error ?? probes.tls.detail })
      }
    }

    // 4) HTTP：最终的证据来源（host 可能通了但接口挂了）
    if (!stopped) {
      if (dnsFailed) {
        probes.http = skipProbe('http', parsed, 'DNS 解析失败，跳过 HTTP')
      } else if (lowBudget()) {
        stopped = true
      } else {
        const httpPath = typeof target.basePath === 'string' && target.basePath.trim() ? target.basePath.trim() : undefined
        probes.http = await probeHttp(parsed, { timeoutMs: clampStep(httpTimeout), path: httpPath, fetchImpl })
        if (probes.http.status === 'fail') errors.push({ targetId, step: 'http', error: probes.http.error ?? probes.http.detail })
      }
    }

    // 预算在任何一步用尽：把没跑到的步骤补成 skip，并明确标注原因
    if (stopped) {
      partial = true
      for (const kind of PROBE_KINDS) {
        if (!probes[kind]) probes[kind] = skipProbe(kind, parsed, '总预算用尽，未执行')
      }
    }

    const summary = summarizeTarget({ id: targetId, label }, probes)
    if (stopped) {
      summary.verdict = 'unknown'
      summary.note = '总预算用尽'
    }
    // `local` 必须跟着 result 一起返回：判定层（lib/rules.js 的 verdictOf）与
    // 报告渲染都是按 result 遍历的，只在 targets[] 里留一份等于让它们看不到这个字段。
    // 曾经因此把「本机 ollama 没开」算成「模型服务连不上」，也就是把设计内的默认值
    // 报成了故障。字段来源仍是 normalized 里的那一份，不在这里重新推导。
    results.push({ targetId, probes, summary, local: normalized.local === true })
  }

  if (partial) notes.push(`总预算用尽（${budget}ms）：未完成的探测标记为 unknown，不代表目标有问题`)
  if (list.length === 0) notes.push('没有传入任何模型目标')

  return {
    collectedAt: new Date(startedAt).toISOString(),
    durationMs: elapsed(startedAt),
    partial,
    proxy,
    targets: normalized,
    results,
    notes,
    errors,
  }
}

function budgetExhaustedResult(targetId, label) {
  return {
    targetId,
    probes: { dns: null, tcp: null, tls: null, http: null },
    summary: {
      targetId,
      label,
      verdict: 'unknown',
      steps: [],
      note: '总预算用尽',
    },
  }
}

/** 统一的 skip 结果工厂：形状与真实探测完全一致，消费方不用分支处理。 */
function skipProbe(kind, parsed, detail) {
  const host = parsed?.host ?? ''
  const port = parsed?.port ?? null
  switch (kind) {
    case 'dns':
      return { kind: 'dns', status: 'skip', host, addresses: [], durationMs: 0, detail }
    case 'tcp':
      return { kind: 'tcp', status: 'skip', host, port, connected: false, durationMs: 0, detail }
    case 'tls':
      return {
        kind: 'tls',
        status: 'skip',
        host,
        port,
        authorized: null,
        protocol: null,
        validFrom: null,
        validTo: null,
        daysLeft: null,
        subject: null,
        issuer: null,
        durationMs: 0,
        detail,
      }
    default:
      return {
        kind: 'http',
        status: 'skip',
        url: parsed?.ok ? `${parsed.origin}${parsed.basePath || '/'}` : '',
        method: 'GET',
        httpStatus: null,
        classification: classifyHttpStatus(null, {}),
        durationMs: 0,
        retryAfterMs: null,
        contentType: null,
        server: null,
        bodySnippet: '',
        detail,
      }
  }
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

/**
 * 调用可能是 promise / 回调 / 同步的函数，三种都能吃。
 * 判据：返回值是 thenable 就按 promise；否则只有函数声明的形参不比实参多时才当同步结果，
 * 否则等回调（Node 原生 API 都是这种形态）。
 */
function invoke(fn, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    let returned
    try {
      returned = fn(...args, (error, value) => finish(error, value))
    } catch (error) {
      finish(error)
      return
    }
    if (returned && typeof returned.then === 'function') {
      returned.then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      )
      return
    }
    if (fn.length <= args.length) finish(undefined, returned)
  })
}

function withTimeout(promise, ms, message) {
  const limit = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 1
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeTimeoutError(message ?? `操作超时（${limit}ms）`)), limit)
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

function makeTimeoutError(message) {
  const error = new Error(message)
  error.code = 'ETIMEDOUT'
  error.__dshTimeout = true
  return error
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function elapsed(startedAt) {
  return Math.max(0, Date.now() - startedAt)
}

function describeError(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  const code = error.code ? `${error.code}: ` : ''
  // Node 的 happy-eyeballs（autoSelectFamily）失败时抛的是 AggregateError，
  // 它的 message 是空字符串，真正的原因在 errors[] 里 —— 直接取 message 会得到 "ECONNREFUSED: "。
  const inner = Array.isArray(error.errors)
    ? error.errors
        .map((item) => [item?.code, item?.message].filter(Boolean).join(' '))
        .filter(Boolean)
        .slice(0, 2)
        .join('; ')
    : ''
  const text = [error.message, inner].filter(Boolean).join(' | ')
  return `${code}${text || String(error)}`.slice(0, 300)
}

/** 从 Headers / Map / 普通对象里取头（三种形态都见过，尤其是假实现）。 */
function headerGet(headers, name) {
  if (!headers) return null
  const wanted = name.toLowerCase()
  try {
    if (typeof headers.get === 'function') {
      const value = headers.get(name)
      if (value !== undefined && value !== null) return String(value)
    }
    if (typeof headers.forEach === 'function') {
      let found = null
      headers.forEach((value, key) => {
        if (String(key).toLowerCase() === wanted && found === null) found = value
      })
      if (found !== null && found !== undefined) return String(found)
    }
  } catch {
    /* 老实现可能没有这些方法，退回对象遍历 */
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== wanted) continue
      if (value === undefined || value === null) return null
      return Array.isArray(value) ? value.join(', ') : String(value)
    }
  }
  return null
}

function parseRetryAfter(value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Math.min(24 * 3600 * 1000, Number(text) * 1000)
  const at = Date.parse(text)
  if (!Number.isNaN(at)) return Math.max(0, Math.min(24 * 3600 * 1000, at - Date.now()))
  return null
}

/**
 * 响应体脱敏：去掉标签与尖括号、压掉控制字符、遮掉疑似密钥，最后截到 300 字符。
 * 探测本身不带凭据，所以这里主要是防止「服务端把回显内容带出来」这种意外。
 */
function sanitizeSnippet(text, max = MAX_BODY_SNIPPET) {
  let value = String(text ?? '')
  value = value.replace(/<[^>]*>/g, ' ')
  value = value.replace(/[<>]/g, '')
  value = value.replace(/[\u0000-\u001f\u007f]+/g, ' ')
  value = value.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
  value = value.replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***')
  value = value.replace(/\s+/g, ' ').trim()
  return value.slice(0, max)
}

/** 去掉凭据类请求头（硬保证：调用方传了 Authorization 也不会发出去）。 */
function sanitizeHeaders(input) {
  const out = {}
  if (!input) return out
  const entries = []
  try {
    if (typeof input.entries === 'function') {
      for (const [key, value] of input.entries()) entries.push([key, value])
    } else if (Array.isArray(input)) {
      for (const pair of input) if (Array.isArray(pair) && pair.length >= 2) entries.push([pair[0], pair[1]])
    } else if (typeof input === 'object') {
      for (const [key, value] of Object.entries(input)) entries.push([key, value])
    }
  } catch {
    return out
  }
  for (const [key, value] of entries) {
    if (!key) continue
    if (CREDENTIAL_HEADERS.has(String(key).toLowerCase())) continue
    if (value === undefined || value === null) continue
    out[String(key)] = String(value)
  }
  return out
}

/** new URL(location, base) 的安全版本：非法 Location 直接放弃跟随。 */
function safeResolveUrl(base, location) {
  try {
    return new URL(String(location), base).toString()
  } catch {
    return null
  }
}
