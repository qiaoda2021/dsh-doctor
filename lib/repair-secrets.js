/**
 * DSH Doctor — 明文凭据清理。原文只进入 scanLeaks/maskSecrets 或本地备份。
 * 库默认 activeWindowMs=0；Host/CLI 显式启用 10 分钟保护。
 * 发现、计划、执行使用同一白名单快照；plan/manifest 中的路径从不授予权限。
 * zstd 仍复用 logs.js 的多帧 readLogText，写回单帧并复核行数，不另造解码器。
 */
import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { tmpdir, platform } from 'node:os'
import zlib from 'node:zlib'
import { maskSecrets, readLogText, scanLeaks } from './logs.js'

export const PLAN_ID = 'secret-cleanup'
export const PLAN_TITLE = '清理日志里的明文密钥'
const MAX_ZSTD_BYTES = 64 * 1024 * 1024
const MAX_TEXT_BYTES = 64 * 1024 * 1024
const DEFAULT_LIMIT = 200
const DEFAULT_MIN_HITS = 1
const DEFAULT_ACTIVE_WINDOW_MS = 0
const MANIFEST_NAME = '.dsh-doctor-backup.json'
const LOGISH = /(?:\.(?:log|jsonl|ndjson|zstd)(?:\.\d+)?$)|^(?:dsh-|gateway|session)/i
const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex')
const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const countLines = (text) => text.length ? text.split('\n').length : 0
const nowOf = (options) => Number.isFinite(options.now) ? options.now : Date.now()
const windowOf = (options) => Number.isFinite(options.activeWindowMs) && options.activeWindowMs >= 0 ? options.activeWindowMs : DEFAULT_ACTIVE_WINDOW_MS
const isActive = (stat, options) => windowOf(options) > 0 && nowOf(options) - stat.mtimeMs < windowOf(options)
// 错误只保留系统代码/类型；解码/JSON 异常的 message 可能带原始凭据片段。
const errorText = (error) => String(error?.code ?? error?.name ?? 'operation-failed')
const traverses = (path) => typeof path !== 'string' || path.split(/[\\/]/).includes('..')

function insideRoot(file, root) {
  const rel = relative(root, file)
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
function rootOfFile(file, roots) {
  const found = roots.find((entry) => insideRoot(file, entry.root))
  return found ? { ...found, rel: relative(found.root, file) } : undefined
}
function backupRelOf(file, roots) {
  const found = rootOfFile(file, roots)
  if (!found) return undefined
  return found.tag ? join(found.tag, found.rel) : found.rel
}

/** options 才是权限来源；不读取 plan.home/manifest.home/manifest.backupRoot。 */
function rootsOf(options = {}) {
  const roots = []
  const errors = []
  function add(path, tag) {
    if (path === undefined || path === null || path === '') return
    if (typeof path !== 'string' || !isAbsolute(path) || traverses(path)) {
      errors.push({ reason: 'invalid-root', error: '根目录必须为无穿越的绝对目录' })
      return
    }
    const root = resolve(path)
    const checked = guardPath(root, { kind: 'directory', allowMissing: !tag.startsWith('extra-') })
    if (!checked.ok) errors.push({ path: root, reason: checked.reason, error: checked.error ?? checked.reason })
    if (!roots.some((entry) => entry.root === root)) roots.push({ root, tag })
  }
  add(options.home, '')
  add(options.profileDir, 'profile')
  // 显式 runtime 或显式 env 才可引入临时目录；无可信 options 时保持空权限。
  if (options.home || options.profileDir || options.env || options.extraRoots?.length) {
    const env = options.env ?? process.env
    add(env.TEMP || env.TMP || tmpdir(), 'temp')
  }
  if (options.extraRoots !== undefined && !Array.isArray(options.extraRoots)) errors.push({ reason: 'invalid-root', error: 'extraRoots 必须为绝对目录数组' })
  for (const [index, path] of (Array.isArray(options.extraRoots) ? options.extraRoots : []).entries()) add(path, `extra-${index}`)
  return { roots, errors }
}

/** 从卷根开始逐级 lstat；包括可信 root 本身及其所有祖先，junction 也按链接处理。 */
function guardPath(path, { kind = 'file', allowMissing = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || traverses(path)) return { ok: false, reason: 'invalid-path' }
  const full = resolve(path)
  const base = parse(full).root
  const parts = relative(base, full).split(sep).filter(Boolean)
  let cursor = base
  let stat
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) cursor = join(cursor, parts[index])
    try { stat = lstatSync(cursor) }
    catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return { ok: true, missing: true }
      return { ok: false, reason: error.code === 'ENOENT' ? 'missing' : 'unreadable', error: errorText(error) }
    }
    if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink' }
    const last = index === parts.length - 1
    if (!last && !stat.isDirectory()) return { ok: false, reason: 'not-directory' }
    if (last && !(kind === 'directory' ? stat.isDirectory() : stat.isFile())) return { ok: false, reason: kind === 'directory' ? 'not-directory' : 'not-file' }
  }
  return { ok: true, stat }
}
function targetGuard(path, roots, config) {
  if (typeof path !== 'string' || !isAbsolute(path) || traverses(path)) return { ok: false, reason: 'invalid-path' }
  if (!rootOfFile(resolve(path), roots)) return { ok: false, reason: 'outside-roots' }
  return guardPath(path, config)
}
function snapshot(path) {
  const checked = guardPath(path)
  if (!checked.ok) return checked
  if (checked.stat.size > MAX_TEXT_BYTES) return { ok: false, reason: 'unreadable', error: 'size-limit' }
  try {
    const bytes = readFileSync(path)
    const after = guardPath(path)
    if (!after.ok) return after
    if (bytes.length !== after.stat.size || checked.stat.size !== after.stat.size || checked.stat.mtimeMs !== after.stat.mtimeMs) return { ok: false, reason: 'changed-since-plan' }
    return { ok: true, hash: hashOf(bytes), size: bytes.length, mtimeMs: after.stat.mtimeMs, mtime: after.stat.mtime.toISOString(), stat: after.stat }
  } catch (error) { return { ok: false, reason: 'unreadable', error: errorText(error) } }
}
const sameSnapshot = (a, b) => a.hash === b.hash && a.size === b.size && a.mtimeMs === b.mtimeMs
function checkExpected(path, expected, roots, options, { hashOnly = false } = {}) {
  const guarded = targetGuard(path, roots)
  if (!guarded.ok) return guarded
  if (isActive(guarded.stat, options)) return { ok: false, reason: 'active-session' }
  if (!isHash(expected?.hash) || (!hashOnly && (!Number.isFinite(expected.size) || !Number.isFinite(expected.mtimeMs)))) return { ok: false, reason: 'missing-snapshot' }
  const actual = snapshot(path)
  if (!actual.ok) return actual
  if (actual.hash !== expected.hash || (!hashOnly && !sameSnapshot(actual, expected))) return { ok: false, reason: 'changed-since-plan' }
  return actual
}

/* Candidate discovery mirrors logs.js's log kinds, but never follows links or hides IO errors.
 * It enumerates before applying per-kind caps, so a budget omission remains visible in coverage.
 */
function specsOf(options, roots) {
  const env = options.env ?? process.env
  const home = roots.find((r) => r.tag === '')?.root
  const profile = roots.find((r) => r.tag === 'profile')?.root
  const temp = roots.find((r) => r.tag === 'temp')?.root
  const specs = []
  if (home) {
    specs.push({ kind: 'session', root: join(home, 'sessions'), depth: 3, match: /\.(?:zstd|jsonl)$/i })
    specs.push({ kind: 'gateway', root: join(home, 'dsh-im-connect'), depth: 1, match: /^gateway.*\.log$/i })
    specs.push({ kind: 'diagnostic', root: join(home, 'state'), depth: 2, match: /\.jsonl$/i })
  }
  if (profile) {
    specs.push({ kind: 'pnpm', root: join(profile, '.plugin-manager', 'logs'), depth: 2, match: /\.log$/i })
    specs.push({ kind: 'market', root: join(profile, '.dsh-market'), depth: 1, match: /\.ndjson$/i })
  }
  if (temp) specs.push({ kind: 'temp', root: temp, depth: 0, match: /^dsh-.*\.log(?:\.\d+)?$/i })
  const appData = env.APPDATA || (home ? platform() === 'win32' ? join(dirname(home), 'AppData', 'Roaming') : join(dirname(home), '.config') : undefined)
  if (appData && isAbsolute(appData)) for (const name of ['@deepseek-ai/dsh-desktop', 'DeepSeek Harness', 'com.deepseek.dsh']) {
    specs.push({ kind: 'crash', root: join(appData, name, 'logs'), depth: 1, match: /^crash-.*\.log$/i })
  }
  for (const extra of roots.filter((r) => r.tag.startsWith('extra-'))) specs.push({ kind: 'extra', root: extra.root, depth: 3, match: LOGISH })
  return specs.filter((spec) => !options.kinds?.length || options.kinds.includes(spec.kind))
}

export function collectCandidates(options = {}) {
  const { roots, errors } = rootsOf(options)
  const sources = []
  const skipped = []
  const seen = new Set()
  const blocked = new Set()
  function skip(path, reason, error) {
    if (blocked.has(path) || seen.has(path)) return
    blocked.add(path)
    skipped.push({ path, reason, ...(error ? { error } : {}) })
  }
  function walk(dir, depth, spec) {
    // Optional absent log directories are not failures. Existing untrusted directories are not traversed.
    const checked = guardPath(dir, { kind: 'directory', allowMissing: true })
    if (!checked.ok) { skip(dir, checked.reason, checked.error); return }
    if (checked.missing) return
    if (!roots.some((r) => dir === r.root || insideRoot(dir, r.root))) { skip(dir, 'outside-roots'); return }
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) }
    catch (error) { skip(dir, 'unreadable', errorText(error)); return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      let stat
      try { stat = lstatSync(path) }
      catch (error) { skip(path, 'unreadable', errorText(error)); continue }
      if (stat.isSymbolicLink()) { skip(path, 'symlink'); continue }
      if (stat.isDirectory()) { if (depth > 0) walk(path, depth - 1, spec); continue }
      if (!spec.match.test(entry.name) || seen.has(path) || blocked.has(path)) continue
      if (!stat.isFile()) { skip(path, 'not-file'); continue }
      seen.add(path)
      sources.push({ id: `${spec.kind}:${path}`, kind: spec.kind, path, bytes: stat.size, mtime: stat.mtime.toISOString() })
    }
  }
  for (const spec of specsOf(options, roots)) walk(spec.root, spec.depth, spec)
  if (!roots.length) errors.push({ reason: 'missing-roots', error: '缺少可信 home/profileDir/env/extraRoots' })
  sources.sort((a, b) => a.path.localeCompare(b.path))
  return { sources, skipped, roots, errors }
}

/** Every decoding error (including partially recovered zstd) blocks rewriting. */
function readSourceText(source) {
  if (/\.zstd$/i.test(source.path)) {
    const read = readLogText(source, { maxBytes: MAX_ZSTD_BYTES, maxLines: Number.MAX_SAFE_INTEGER })
    return { text: read.text ?? '', error: read.error ? 'zstd-read-failed' : read.truncated ? 'truncated' : undefined }
  }
  try {
    const stat = lstatSync(source.path)
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return { text: '', error: 'size-or-type-limit' }
    return { text: readFileSync(source.path).toString('utf8') }
  } catch (error) { return { text: '', error: errorText(error) } }
}
function inspectCandidate(source) {
  const before = snapshot(source.path)
  if (!before.ok) return { error: before.error ?? before.reason }
  const read = readSourceText(source)
  if (read.error) return { error: read.error }
  const after = snapshot(source.path)
  if (!after.ok || !sameSnapshot(before, after)) return { error: 'changed-during-scan' }
  const scan = scanLeaks(read.text, { withHashes: false })
  return { path: source.path, kind: source.kind, hits: scan.total, unique: scan.unique, byType: scan.byType, bytes: after.size, hash: after.hash, size: after.size, mtimeMs: after.mtimeMs, mtime: after.mtime }
}

/**
 * coverage 的数字单位全部是文件/候选路径，不是命中处数：
 * discovered = 枚举到的唯一候选 + 被阻断的路径（目录不可读时内容未知）；
 * scanned = 完整成功读取并扫描的文件，读取失败不计入；
 * matched = scanned 中含凭据的文件（不受 minHits 隐藏）；eligible = matched 中达到 minHits、可列入 changes 的文件；
 * deferred = 活动窗口延后的候选；skipped = 链接/白名单/预算等其他跳过；
 * unreadable = IO/解码/并发变化导致未完整扫描的候选（不重复计入 skipped）；
 * complete 仅当未发生 deferred/skipped/unreadable/根配置错误时为 true，0 命中不代表覆盖完整。
 */
export async function scanSecretFiles(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : 20
  const minHits = Number.isInteger(options.minHits) && options.minHits >= 0 ? options.minHits : DEFAULT_MIN_HITS
  const found = collectCandidates(options)
  const { sources, skipped, roots } = found
  const errors = [...found.errors]
  const files = []
  const scanned = { files: 0, bytes: 0 }
  const coverage = { discovered: sources.length + skipped.length, scanned: 0, matched: 0, eligible: 0, deferred: 0, skipped: 0, unreadable: 0, complete: false }
  let totalHits = 0
  let totalUnique = 0
  const perKind = new Map()
  let attempted = 0
  for (const source of [...sources].sort((a, b) => b.mtime.localeCompare(a.mtime) || a.path.localeCompare(b.path))) {
    const count = perKind.get(source.kind) ?? 0
    perKind.set(source.kind, count + 1)
    if (count >= maxFiles || attempted >= limit) { skipped.push({ path: source.path, reason: count >= maxFiles ? 'kind-limit' : 'limit' }); continue }
    const checked = targetGuard(source.path, roots)
    if (!checked.ok) { skipped.push({ path: source.path, reason: checked.reason, error: checked.error }); continue }
    if (isActive(checked.stat, options)) { skipped.push({ path: source.path, reason: 'active-session' }); continue }
    attempted += 1
    const info = inspectCandidate(source)
    if (info.error) { skipped.push({ path: source.path, reason: 'unreadable', error: info.error }); continue }
    scanned.files += 1
    scanned.bytes += info.bytes
    if (info.hits <= 0) continue
    coverage.matched += 1
    totalHits += info.hits
    totalUnique += info.unique
    if (info.hits >= minHits) files.push(info)
  }
  for (const item of skipped) {
    if (item.reason === 'active-session') coverage.deferred += 1
    else if (item.reason === 'unreadable' || item.reason === 'missing') { coverage.unreadable += 1; errors.push({ path: item.path, error: item.error ?? item.reason }) }
    else coverage.skipped += 1
  }
  coverage.scanned = scanned.files
  coverage.eligible = files.length
  coverage.complete = skipped.length === 0 && errors.length === 0
  return { files, totalHits, totalUnique, scanned, skipped, errors, coverage, roots: roots.map((r) => r.root), rootSnapshot: roots.map((r) => ({ ...r })) }
}

function defaultBackupRoot(options, roots) {
  const home = roots.find((r) => r.tag === '')?.root
  const base = home ? join(home, 'state', 'dsh-doctor', 'backups') : join(roots[0]?.root ?? tmpdir(), '.dsh-doctor', 'backups')
  return join(base, new Date(nowOf(options)).toISOString().replace(/[:.]/g, '-'))
}
export async function planCleanup(options = {}) {
  const scan = await scanSecretFiles(options)
  const roots = scan.rootSnapshot
  const backupRoot = options.backupRoot ? resolve(options.backupRoot) : defaultBackupRoot(options, roots)
  return {
    id: PLAN_ID, title: PLAN_TITLE, risk: 'high', dryRun: true,
    explanation: `完整扫描 ${scan.scanned.files} 个文件，发现 ${scan.totalHits} 处明文凭据。先备份，再脱敏，再完整复检；覆盖 ${scan.coverage.complete ? '完整' : '未完整'}，延后/不可读不代表干净。`,
    preconditions: ['仅可信调用 options 白名单内的普通文件', '所有祖先目录逐级 lstat，链接/junction 跳过', '执行时重新核对活动窗口及计划 hash/size/mtime', '备份 hash 校验且先写清单，失败中止', '写后完整解码、扫描及 hash 复检；新追加内容不覆盖'],
    changes: scan.files.map((file) => ({
      target: file.path, operation: 'update',
      description: `${/\.zstd$/i.test(file.path) ? '会话流单帧 zstd' : '文本'}脱敏：${file.hits} 处（${Object.keys(file.byType).join('/')}）`,
      backupPath: join(backupRoot, backupRelOf(file.path, roots)), kind: file.kind, hits: file.hits, unique: file.unique,
      hash: file.hash, size: file.size, mtime: file.mtime, mtimeMs: file.mtimeMs,
    })),
    rollbackAvailable: true,
    verificationChecks: ['remaining 必须为 0 且 complete=true', 'zstd 完整解码且行数一致（允许 PEM 脱敏折行）', '备份及写后内容均校验 SHA-256', '回滚只覆盖仍等于写后 hash 的非活动文件'],
    totalHits: scan.totalHits, totalUnique: scan.totalUnique, backupRoot,
    home: options.home ? resolve(options.home) : undefined, profileDir: options.profileDir ? resolve(options.profileDir) : undefined,
    rootSnapshot: scan.rootSnapshot, scanned: scan.scanned, skipped: scan.skipped, errors: scan.errors, coverage: scan.coverage,
    deferred: scan.skipped.filter((item) => item.reason === 'active-session').map((item) => item.path),
  }
}

/** No in-place fallback: a busy/changed file must remain untouched. */
function writeAllBytes(file, buffer, recheck) {
  const temp = `${file}.dsh-doctor-${randomUUID()}.tmp`
  let created = false
  try {
    const parent = guardPath(dirname(file), { kind: 'directory' })
    if (!parent.ok) return parent
    writeFileSync(temp, buffer, { flag: 'wx', mode: 0o600 })
    created = true
    const tempGuard = guardPath(temp)
    if (!tempGuard.ok || hashOf(readFileSync(temp)) !== hashOf(buffer)) return { ok: false, reason: 'temporary-changed' }
    const checked = recheck()
    if (!checked.ok) return checked
    renameSync(temp, file)
    created = false
    return { ok: true }
  } catch (error) { return { ok: false, reason: 'write-failed', error: errorText(error) } }
  finally { if (created) { try { unlinkSync(temp) } catch { /* best effort; no target overwrite */ } } }
}
function explainedCollapse(originalText, maskedText) {
  const delta = countLines(originalText) - countLines(maskedText)
  if (delta <= 0) return delta === 0
  let pemLines = 0
  for (const match of originalText.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g)) pemLines += (match[0].match(/\n/g) ?? []).length
  return delta === pemLines
}
function backupGuard(backupRoot, roots) {
  const checked = targetGuard(backupRoot, roots, { kind: 'directory', allowMissing: true })
  return checked.ok ? checked : { ...checked, error: `备份失败：${checked.reason}` }
}
function applyOne(change, ctx) {
  const path = typeof change?.target === 'string' ? change.target : ''
  const state = { path, kind: change?.kind, masked: 0, verified: false, remaining: 0, bytesBefore: 0, bytesAfter: 0 }
  const fail = (checked) => { state.skipped = checked.reason; if (checked.error) state.error = checked.error; return state }
  const current = checkExpected(path, change, ctx.roots, ctx.options)
  if (!current.ok) return fail(current)
  const read = readSourceText({ path })
  if (read.error) return fail({ reason: 'unreadable', error: read.error })
  const masked = maskSecrets(read.text)
  state.masked = Object.values(masked.hits).reduce((sum, value) => sum + (Number(value) || 0), 0)
  state.maskedByType = masked.hits
  state.bytesBefore = current.size
  if (!state.masked) { state.skipped = 'clean'; state.verified = true; return state }
  let bytes
  try { bytes = /\.zstd$/i.test(path) ? zlib.zstdCompressSync(Buffer.from(masked.text, 'utf8')) : Buffer.from(masked.text, 'utf8') }
  catch (error) { state.error = `压缩失败：${errorText(error)}`; state.abortedBeforeWrite = true; return state }
  const hashAfter = hashOf(bytes)
  const rel = backupRelOf(path, ctx.roots)
  const backup = join(ctx.backupRoot, rel)
  try {
    const base = backupGuard(ctx.backupRoot, ctx.roots)
    if (!base.ok) throw new Error('backup-directory')
    const dest = guardPath(backup, { allowMissing: true })
    if (!dest.ok || !dest.missing) throw new Error('backup-exists-or-link')
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 })
    const parent = guardPath(dirname(backup), { kind: 'directory' })
    if (!parent.ok) throw new Error('backup-parent')
    copyFileSync(path, backup, constants.COPYFILE_EXCL)
    const copied = snapshot(backup)
    if (!copied.ok || copied.hash !== change.hash || copied.size !== change.size) throw new Error('backup-hash')
    state.backup = backup
    state.hashBefore = change.hash
    state.hashAfter = hashAfter
    ctx.persist({ path, backup, kind: state.kind, bytesBefore: current.size, bytesAfter: bytes.length, hashBefore: change.hash, hashAfter })
  } catch (error) {
    state.error = `备份失败，已中止（原文件未写入）：${errorText(error)}`
    state.abortedBeforeWrite = true
    return state
  }
  // Copying/compressing may take time: recheck immediately before the atomic rename as well.
  const wrote = writeAllBytes(path, bytes, () => checkExpected(path, change, ctx.roots, ctx.options))
  if (!wrote.ok) { state.abortedBeforeWrite = true; return fail(wrote) }
  state.wrote = true
  const after = inspectCandidate({ path, kind: change.kind })
  const lineOk = !/\.zstd$/i.test(path) || (explainedCollapse(read.text, masked.text) && countLines(readSourceText({ path }).text) === countLines(masked.text))
  state.bytesAfter = after.bytes ?? bytes.length
  state.remaining = after.hits ?? 0
  if (!after.error && after.hash === hashAfter && !state.remaining && lineOk) { state.verified = true; return state }
  state.error = `写后复检失败：${after.error ?? (after.hash !== hashAfter ? 'changed-since-write' : 'remaining-or-lines')}`
  // A new append wins over automatic restoration. Never restore blindly over changed data.
  const safe = checkExpected(path, { hash: hashAfter }, ctx.roots, { ...ctx.options, activeWindowMs: 0 }, { hashOnly: true })
  if (safe.ok) {
    const original = snapshot(backup)
    if (original.ok && original.hash === change.hash) {
      const originalBytes = readFileSync(backup)
      if (hashOf(originalBytes) === change.hash && originalBytes.length === change.size) {
        const restored = writeAllBytes(path, originalBytes, () => checkExpected(path, { hash: hashAfter }, ctx.roots, { ...ctx.options, activeWindowMs: 0 }, { hashOnly: true }))
        state.rolledBack = restored.ok
      } else state.rollbackSkipped = 'backup-changed'
    }
  } else state.rollbackSkipped = safe.reason === 'changed-since-plan' ? 'changed-since-write' : safe.reason
  return state
}

export async function applyCleanup(plan, options = {}) {
  if (options.confirm !== true) return { applied: false, reason: 'unconfirmed' }
  const trusted = rootsOf(options)
  const roots = trusted.roots
  const effectivePlan = plan?.changes ? plan : await planCleanup(options)
  const backupRoot = resolve(options.backupRoot ?? effectivePlan.backupRoot ?? defaultBackupRoot(options, roots))
  const sameRoots = JSON.stringify(effectivePlan.rootSnapshot) === JSON.stringify(roots)
  const changes = Array.isArray(effectivePlan.changes) ? effectivePlan.changes : []
  const results = []
  const manifest = { version: 2, createdAt: new Date(nowOf(options)).toISOString(), files: [] }
  const manifestPath = join(backupRoot, MANIFEST_NAME)
  let manifestCreated = false
  function persist(entry) {
    const checked = backupGuard(backupRoot, roots)
    if (!checked.ok) throw new Error('backup-directory')
    const checkManifest = guardPath(manifestPath, { allowMissing: true })
    if (!checkManifest.ok || (!manifestCreated && !checkManifest.missing)) throw new Error('manifest-exists-or-link')
    manifest.files.push(entry)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: manifestCreated ? 'w' : 'wx', mode: 0o600 })
    manifestCreated = true
  }
  for (const change of changes) {
    if (!roots.length || trusted.errors.length || !sameRoots) {
      results.push({ path: change?.target, skipped: !roots.length ? 'missing-roots' : 'changed-roots', verified: false })
      continue
    }
    results.push(applyOne(change, { roots, backupRoot, options, persist }))
  }
  const verification = verifyResults(results, options)
  if (effectivePlan.coverage?.complete !== true || trusted.errors.length || !sameRoots) verification.complete = false
  return {
    applied: results.some((r) => r.wrote && r.verified && !r.rolledBack),
    wrote: results.filter((r) => r.wrote && r.verified && !r.rolledBack).length,
    rolledBack: results.filter((r) => r.rolledBack).length, aborted: results.filter((r) => r.abortedBeforeWrite).length,
    backupRoot, results, verification, id: PLAN_ID,
  }
}

function verifyPaths(paths, roots) {
  const files = []
  const errors = []
  let remaining = 0
  let checked = 0
  for (const path of [...new Set(paths)]) {
    const guarded = targetGuard(path, roots)
    if (!guarded.ok) { const item = { path, error: guarded.error ?? guarded.reason }; errors.push(item); files.push({ ...item, hits: 0, unique: 0 }); continue }
    const info = inspectCandidate({ path })
    if (info.error) { errors.push({ path, error: info.error }); files.push({ path, hits: 0, unique: 0, error: info.error }); continue }
    checked += 1
    remaining += info.hits
    files.push({ path, hits: info.hits, unique: info.unique, byType: info.byType })
  }
  return { remaining, checked, files, errors, complete: errors.length === 0 }
}
/** remaining=0 alone is never a green result: skipped/errors force complete=false. */
function verifyResults(results, options) {
  const trusted = rootsOf(options)
  const result = verifyPaths(results.filter((r) => typeof r.path === 'string').map((r) => r.path), trusted.roots)
  if (trusted.errors.length || results.some((r) => r.error || r.rolledBack || (r.skipped && r.skipped !== 'clean') || !r.verified)) result.complete = false
  return result
}
export async function verifyClean(options = {}) {
  if (!Array.isArray(options.paths)) {
    const scan = await scanSecretFiles({ ...options, minHits: 1 })
    return { remaining: scan.totalHits, checked: scan.scanned.files, files: scan.files.map(({ path, hits, unique, byType }) => ({ path, hits, unique, byType })), complete: scan.coverage.complete, errors: scan.errors, coverage: scan.coverage }
  }
  const trusted = rootsOf(options)
  const result = verifyPaths(options.paths, trusted.roots)
  result.errors.push(...trusted.errors)
  if (trusted.errors.length || !trusted.roots.length) result.complete = false
  return result
}

/**
 * rollbackFrom(backupRoot, {home, profileDir, env, extraRoots, activeWindowMs})
 * Manifest v2 is data, not authority: preflight ALL paths before any write; validate
 * backup containment, all ancestor lstat, trusted target roots, before/after hashes.
 * Old manifests without write hashes stay manual-only; never guess a root from them.
 */
export async function rollbackFrom(backupRoot, options = {}) {
  const trusted = rootsOf(options)
  const failed = (error, files = []) => ({ restored: 0, files, backupRoot, error, complete: false })
  if (!trusted.roots.length || trusted.errors.length) return failed('缺少有效可信根 options')
  if (typeof backupRoot !== 'string' || !isAbsolute(backupRoot) || traverses(backupRoot)) return failed('备份根须为无穿越的绝对目录')
  const root = resolve(backupRoot)
  const rootCheck = backupGuard(root, trusted.roots)
  if (!rootCheck.ok || rootCheck.missing) return failed(`备份目录无效：${rootCheck.reason ?? 'missing'}`)
  const manifestPath = join(root, MANIFEST_NAME)
  const checkManifest = guardPath(manifestPath)
  if (!checkManifest.ok) return failed(`备份清单无效：${checkManifest.reason}`)
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
  catch (error) { return failed(`读取备份清单失败：${errorText(error)}`) }
  if (!Array.isArray(manifest?.files) || manifest.version !== 2) return failed('备份清单缺少 v2 写后 hash')
  const validated = []
  const seen = new Set()
  for (const entry of manifest.files) {
    const target = entry?.path
    const backup = entry?.backup
    if (typeof target !== 'string' || typeof backup !== 'string' || !isAbsolute(target) || !isAbsolute(backup) || traverses(target) || traverses(backup) || !insideRoot(backup, root) || seen.has(target) || seen.has(backup) || insideRoot(target, root) || target === root) return failed('备份清单路径校验失败')
    const targetCheck = targetGuard(target, trusted.roots)
    const backupCheck = guardPath(backup)
    if (!targetCheck.ok || !backupCheck.ok || !isHash(entry.hashBefore) || !isHash(entry.hashAfter)) return failed('备份清单目标/备份/哈希校验失败')
    const data = snapshot(backup)
    if (!data.ok || data.hash !== entry.hashBefore || data.size !== entry.bytesBefore) return failed('备份内容哈希校验失败')
    seen.add(target); seen.add(backup)
    validated.push(entry)
  }
  const files = []
  for (const entry of validated) {
    const current = checkExpected(entry.path, { hash: entry.hashAfter }, trusted.roots, options, { hashOnly: true })
    if (!current.ok) { files.push({ path: entry.path, backup: entry.backup, restored: false, skipped: current.reason === 'changed-since-plan' ? 'changed-since-write' : current.reason, error: current.error }); continue }
    try {
      const data = snapshot(entry.backup)
      if (!data.ok || data.hash !== entry.hashBefore) { files.push({ path: entry.path, restored: false, error: '备份内容已变化' }); continue }
      const bytes = readFileSync(entry.backup)
      if (bytes.length !== entry.bytesBefore || hashOf(bytes) !== entry.hashBefore) { files.push({ path: entry.path, restored: false, error: '备份内容已变化' }); continue }
      const written = writeAllBytes(entry.path, bytes, () => checkExpected(entry.path, { hash: entry.hashAfter }, trusted.roots, options, { hashOnly: true }))
      const after = written.ok ? snapshot(entry.path) : undefined
      const restored = written.ok && after.ok && after.hash === entry.hashBefore
      files.push({ path: entry.path, backup: entry.backup, restored, ...(restored ? {} : { skipped: written.reason === 'changed-since-plan' ? 'changed-since-write' : written.reason, error: written.error ?? '还原后哈希不一致' }) })
    } catch (error) { files.push({ path: entry.path, backup: entry.backup, restored: false, error: errorText(error) }) }
  }
  return { restored: files.filter((file) => file.restored).length, files, backupRoot: root, restoredAt: new Date(nowOf(options)).toISOString(), complete: files.every((file) => file.restored) }
}

export default { PLAN_ID, PLAN_TITLE, collectCandidates, scanSecretFiles, planCleanup, applyCleanup, verifyClean, rollbackFrom }
