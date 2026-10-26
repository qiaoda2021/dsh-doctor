/**
 * Read-only preparation for repair-exec.js. Only that executor writes files.
 * Raw changes.content belongs in the controller's private cache; publicPlan()
 * removes it before presenting a plan. Errors and validation never echo input.
 * Freshness is a byte-hash precondition; the controller owns its 15-minute TTL.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { parseEnv, TextDecoder } from 'node:util'

const HASH = /^[a-f0-9]{64}$/
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const PROFILE_FILES = ['package.json', 'cordis.patch.yml']
const PLAN_KEYS = ['id', 'planId', 'title', 'risk', 'changes', 'verificationChecks', 'meta']
const META_KEYS = ['prepared', 'kind', 'restartRequired', 'before', 'afterSha256']
const FIELDS = {
  'proxy-env': { title: '配置 home 层代理环境变量（下次启动生效）', risk: 'medium' },
  'strip-bom': { title: '移除 profile 配置的 UTF-8 BOM（仅验证磁盘配置）', risk: 'medium' },
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fold = (value) => process.platform === 'win32' ? value.toLowerCase() : value
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && fold(a) === fold(b)
class PreparationError extends Error {}
const fail = (message) => { throw new PreparationError(message) }

function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && own.every((key) => keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key))
}

function absolute(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) fail(`${label} 路径格式异常`)
  if (!isAbsolute(value) || value.split(/[\\/]+/).includes('..')) fail(`${label} 须为无穿越的绝对路径`)
  // Drive-relative, device, ADS and ambiguous Win32 trailing-dot/space paths
  // are excluded before resolve() can erase their spelling.
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':')) fail(`${label} 路径格式异常`)
    if (value.slice(3).split(/[\\/]+/).some((part) => /[. ]$/.test(part))) fail(`${label} 路径格式异常`)
  }
  return resolve(value)
}

function trusted(options = {}, needProfile = false) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('options 格式异常')
  // Never trust plan.home, plan.meta.home, process.env or a guessed profile.
  const home = absolute(options.home === undefined ? join(homedir(), '.dsh') : options.home, 'home')
  let profileDir
  if (options.profileDir !== undefined) {
    profileDir = absolute(options.profileDir, 'profileDir')
    const rel = relative(fold(home), fold(profileDir))
    const parts = rel.split(sep)
    if (isAbsolute(rel) || parts.length !== 2 || parts[0] !== 'profiles' || !parts[1] || parts[1] === '.' || parts[1] === '..') fail('profileDir 须为 home/profiles/<name>')
  }
  if (needProfile && !profileDir) fail('须显式指定可信 profileDir')
  return { home, profileDir }
}

function bomTarget(context, raw) {
  if (typeof raw !== 'string' || !raw) fail('须显式指定 BOM target')
  const target = PROFILE_FILES.includes(raw) ? join(context.profileDir, raw) : absolute(raw, 'target')
  if (!PROFILE_FILES.some((name) => samePath(target, join(context.profileDir, name)))) fail('BOM target 仅支持当前 profile 的 package.json 或 cordis.patch.yml')
  return resolve(target)
}

/** Walk from the volume root, including home and all of its ancestors. */
async function auditPath(target, directory = false) {
  const root = parse(target).root
  const segments = relative(root, target).split(sep).filter(Boolean)
  let cursor = root
  let found
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) cursor = join(cursor, segments[index])
    try { found = await lstat(cursor) }
    catch (error) {
      if (error?.code === 'ENOENT') return { exists: false }
      fail('路径检查失败（未读取配置正文）')
    }
    if (found.isSymbolicLink()) fail('路径含符号链接或目录 junction')
    const last = index === segments.length - 1
    if ((!last || directory) && !found.isDirectory()) fail('路径祖先不是目录')
    if (last && !directory && !found.isFile()) fail('配置目标不是普通文件')
  }
  return { exists: true, stat: found }
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

async function snapshot(target) {
  const first = await auditPath(target)
  if (!first.exists) return { exists: false, bytes: Buffer.alloc(0), sha256: null }
  let handle
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(first.stat, opened)) fail('配置读取期间发生变化，请重新准备')
    const bytes = await handle.readFile()
    const end = await handle.stat()
    const last = await auditPath(target)
    if (!last.exists || !sameFile(opened, end) || !sameFile(end, last.stat) || bytes.length !== end.size) fail('配置读取期间发生变化，请重新准备')
    return { exists: true, bytes, sha256: sha(bytes) }
  } catch (error) {
    // Node/V8 errors can contain input excerpts. Only our fixed messages escape.
    if (error instanceof PreparationError) throw error
    fail('配置读取失败（未读取或返回配置正文）')
  } finally { await handle?.close() }
}

async function auditContext(context) {
  await auditPath(context.home, true)
  if (context.profileDir) await auditPath(context.profileDir, true)
}

function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { fail('配置须为有效 UTF-8，正文未返回') }
}

function proxyValue(value) {
  if (typeof value !== 'string' || !value || /[\s\x00-\x1f\x7f\\'"`?#]/u.test(value)) fail('proxyUrl 须显式提供 http/https URL，且不含凭据、查询、片段或控制字符')
  let url
  try { url = new URL(value) } catch { fail('proxyUrl 格式异常（地址未返回）') }
  const authority = value.match(/^https?:\/\/([^/]+)/i)?.[1]
  if (!authority || authority.includes('@') || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) fail('proxyUrl 仅支持无凭据、无查询和片段的 http/https URL')
  return value
}

function linesOf(text) {
  const result = []
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g
  let match
  while ((match = pattern.exec(text)) && match[0]) result.push({ body: match[1], eol: match[2] })
  return result
}

function closingQuote(text, quote, start = 0) {
  for (let i = start; i < text.length; i += 1) {
    if (text[i] !== quote) continue
    let slashes = 0
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j -= 1) slashes += 1
    if (slashes % 2 === 0) return i
  }
  return -1
}

/** Preserve every non-proxy byte, including quoted multiline secret values. */
function proxyContent(bytes, proxyUrl) {
  const text = utf8(bytes)
  const lines = linesOf(text)
  const sourceEol = lines.find((line) => line.eol)?.eol ?? '\n'
  // Node's boot parser recognizes LF/CRLF, not bare CR separators. Existing
  // bytes stay intact; newly appended assignments use a recognized newline.
  const eol = sourceEol === '\r' ? '\n' : sourceEol
  const trailingEol = !text || /[\r\n]$/.test(text)
  const seen = new Set()
  let quote
  for (const line of lines) {
    if (quote) {
      if (closingQuote(line.body, quote) >= 0) quote = undefined
      continue
    }
    const match = line.body.match(/^(\uFEFF?[ \t]*(?:export[ \t]+)?)([A-Za-z0-9_.-]+)([ \t]*=[ \t]*)(.*)$/)
    if (!match) continue
    const [, prefix, key, , value] = match
    const trimmed = value.trimStart()
    const quoted = ['"', "'", '`'].includes(trimmed[0])
    const end = quoted ? closingQuote(trimmed, trimmed[0], 1) : -1
    const routing = /^(?:http|https|all)_proxy$/i.test(key)
    if (quoted && end < 0) {
      if (routing) fail('代理键含跨行值，请先人工核对（正文未返回）')
      quote = trimmed[0]
    }
    if (!routing) continue // NO_PROXY/no_proxy and all other keys stay intact.
    seen.add(key)
    const commentAt = quoted ? (end >= 0 ? trimmed.indexOf('#', end + 1) : -1) : value.indexOf('#')
    const comment = commentAt < 0 ? '' : ` ${quoted ? trimmed.slice(commentAt) : value.slice(commentAt)}`
    line.body = `${prefix}${key}=${proxyUrl}${comment}`
  }
  if (quote) fail('环境文件有未闭合跨行值，请先人工核对（正文未返回）')
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY']) {
    if (seen.has(key)) continue
    if (lines.length && !lines[lines.length - 1].eol) lines[lines.length - 1].eol = eol
    else if (lines.length && lines[lines.length - 1].eol === '\r') lines[lines.length - 1].eol += '\n'
    lines.push({ body: `${key}=${proxyUrl}`, eol: trailingEol ? eol : '' })
    seen.add(key)
  }
  const content = lines.map((line) => line.body + line.eol).join('')
  // Use the exact boot parser as a semantic backstop: physical-line matching
  // alone must never rewrite a proxy-looking line inside an unrelated value.
  let prior, next
  try { prior = parseEnv(text); next = parseEnv(content) }
  catch { fail('环境文件解析异常（正文未返回）') }
  const routing = (key) => /^(?:http|https|all)_proxy$/i.test(key)
  for (const key of new Set([...Object.keys(prior), ...Object.keys(next)])) {
    if (!routing(key) && prior[key] !== next[key]) fail('环境文件非代理值未保持原样（正文未返回）')
    if (routing(key) && next[key] !== proxyUrl) fail('代理赋值未被宿主解析为准确值（正文未返回）')
  }
  if (next.HTTP_PROXY !== proxyUrl || next.HTTPS_PROXY !== proxyUrl) fail('代理赋值未被宿主解析为准确值（正文未返回）')
  return content
}

const proxyChecks = (path, value) => [
  { id: 'proxy-http-value', kind: 'contains', path, expect: `HTTP_PROXY=${value}` },
  { id: 'proxy-https-value', kind: 'contains', path, expect: `HTTPS_PROXY=${value}` },
]

function bomChecks(path) {
  const checks = [{ id: 'bom-absent', kind: 'not-regex', path, expect: '^\\uFEFF' }]
  if (samePath(path, join(resolve(path, '..'), 'package.json'))) checks.push({ id: 'json-valid', kind: 'json', path, expect: true })
  return checks
}

function bomContent(bytes, path) {
  const hadBom = bytes.subarray(0, 3).equals(BOM)
  const content = utf8(hadBom ? bytes.subarray(3) : bytes)
  if (content.startsWith('\uFEFF')) fail('配置含重复 UTF-8 BOM，请先人工核对（正文未返回）')
  if (bomChecks(path).length > 1) {
    try { JSON.parse(content) } catch { fail('package.json 须为有效 JSON，正文未返回') }
  }
  return content
}

function planId(kind, before, afterSha256) {
  const fingerprint = JSON.stringify([kind, fold(before.path), before.exists, before.sha256, afterSha256])
  return `plan-${kind}-${sha(fingerprint).slice(0, 12)}`
}

function prepared(kind, path, before, content, verificationChecks) {
  const afterSha256 = sha(Buffer.from(content, 'utf8'))
  const prior = { path, exists: before.exists, sha256: before.sha256 }
  const id = planId(kind, prior, afterSha256)
  return {
    id, planId: id, ...FIELDS[kind],
    changes: before.exists && before.sha256 === afterSha256 ? [] : [{ operation: before.exists ? 'update' : 'create', path, content }],
    verificationChecks,
    meta: { prepared: true, kind, restartRequired: true, before: prior, afterSha256 },
  }
}

/** Prepare home/.env only; proxyUrl has no environment or guessed default. */
export async function prepareProxyPlan(options = {}) {
  const value = proxyValue(options?.proxyUrl)
  const context = trusted(options)
  if (options.target !== undefined && !samePath(absolute(options.target, 'target'), join(context.home, '.env'))) fail('代理配置仅支持 home/.env')
  await auditContext(context)
  const path = join(context.home, '.env')
  const before = await snapshot(path)
  return prepared('proxy-env', path, before, proxyContent(before.bytes, value), proxyChecks(path, value))
}

/** Only a leading EF BB BF is removed. JSON is parsed, never reserialized. */
export async function prepareBomPlan(options = {}) {
  const context = trusted(options, true)
  const path = bomTarget(context, options.target)
  await auditContext(context)
  const before = await snapshot(path)
  if (!before.exists) fail('BOM target 尚不存在，未准备任何写入')
  return prepared('strip-bom', path, before, bomContent(before.bytes, path), bomChecks(path))
}

function equalChecks(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((check, index) =>
    record(check, ['id', 'kind', 'path', 'expect']) && ['id', 'kind', 'path', 'expect'].every((key) => check[key] === expected[index][key]))
}

/**
 * Rebind every path to trusted options, re-lstat ancestors, compare current bytes
 * with before, and recompute the exact allowed transformation (not just hashes).
 * Returns fixed reasons only: neither env content nor an injected field escapes.
 */
export async function validatePreparedPlan(plan, options = {}) {
  try {
    if (!record(plan, PLAN_KEYS) || !record(plan.meta, META_KEYS) || !record(plan.meta.before, ['path', 'exists', 'sha256'])) fail('预备计划结构异常')
    const { meta } = plan
    if (meta.prepared !== true || !Object.hasOwn(FIELDS, meta.kind) || meta.restartRequired !== true) fail('预备计划类型或重启标记异常')
    const context = trusted(options, meta.kind === 'strip-bom')
    const path = meta.kind === 'proxy-env' ? join(context.home, '.env') : bomTarget(context, meta.before.path)
    const declared = absolute(meta.before.path, 'before')
    if (!samePath(declared, path) || meta.before.path !== path) fail('计划路径与可信配置范围不一致')
    if (options.target !== undefined) {
      const selected = meta.kind === 'strip-bom' ? bomTarget(context, options.target) : absolute(options.target, 'target')
      if (!samePath(selected, path)) fail('计划路径与可信 target 不一致')
    }
    if (plan.title !== FIELDS[meta.kind].title || plan.risk !== FIELDS[meta.kind].risk) fail('计划标题或风险字段已变化')
    if (typeof meta.before.exists !== 'boolean' || (meta.before.exists ? !HASH.test(meta.before.sha256) : meta.before.sha256 !== null) || !HASH.test(meta.afterSha256)) fail('计划字节摘要格式异常')
    if (plan.id !== planId(meta.kind, meta.before, meta.afterSha256) || plan.planId !== plan.id) fail('计划标识与内容摘要不一致')
    if (!Array.isArray(plan.changes) || plan.changes.length > 1) fail('配置计划只允许单目标改动')
    for (const change of plan.changes) {
      if (!record(change, ['operation', 'path', 'content']) || change.path !== path || typeof change.content !== 'string' || change.operation !== (meta.before.exists ? 'update' : 'create')) fail('计划改动路径、操作或正文格式异常')
      if (sha(Buffer.from(change.content, 'utf8')) !== meta.afterSha256) fail('计划正文与 afterSha256 不一致')
    }
    await auditContext(context)
    const current = await snapshot(path)
    if (current.exists !== meta.before.exists || current.sha256 !== meta.before.sha256) fail('配置文件已变化，原计划已过期，请重新准备')
    let content, checks
    if (meta.kind === 'proxy-env') {
      const expect = plan.verificationChecks?.[0]?.expect
      if (typeof expect !== 'string' || !expect.startsWith('HTTP_PROXY=')) fail('代理计划缺少准确赋值验证')
      const value = proxyValue(expect.slice('HTTP_PROXY='.length))
      if (options.proxyUrl !== undefined && value !== proxyValue(options.proxyUrl)) fail('计划代理值与可信 proxyUrl 不一致')
      content = proxyContent(current.bytes, value)
      checks = proxyChecks(path, value)
    } else {
      if (!current.exists) fail('BOM target 尚不存在')
      content = bomContent(current.bytes, path)
      checks = bomChecks(path)
    }
    if (!equalChecks(plan.verificationChecks, checks)) fail('计划验证条件已变化或路径不一致')
    if (sha(Buffer.from(content, 'utf8')) !== meta.afterSha256) fail('计划内容超出已支持的配置变换')
    const changed = !current.exists || current.sha256 !== meta.afterSha256
    if (plan.changes.length !== Number(changed) || (changed && plan.changes[0].content !== content)) fail('计划改动与文件状态不一致')
    return { ok: true, reasons: [] }
  } catch (error) {
    // Only fixed messages generated by this module; no fs/parser/input excerpts.
    return { ok: false, reasons: [error instanceof PreparationError ? error.message : '预备计划验证失败（正文未返回）'] }
  }
}
