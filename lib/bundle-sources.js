/** Bounded, inert local metadata. Declaration overlaps are not runtime conflict verdicts. */
import { openSync, closeSync, readSync, fstatSync, realpathSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { packageRootOf } from './probe.js'
import { evaluatePluginGate } from './installer.js'

export const SOURCE_LIMITS = Object.freeze({ bytes: 256 * 1024, packages: 128, depth: 6, entries: 512, tools: 128 })
const identifier = (s) => typeof s === 'string' && /^[A-Za-z0-9_@./:+-]{1,180}$/.test(s) ? s : null
const packageVersion = (s) => typeof s === 'string' && s.length <= 180 && s.trim() === s && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(s) ? s : null
const packageName = (s) => typeof s === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(s) ? s : null
const inside = (root, file) => { const r = relative(root, file); return !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep) }
const pluginShape = (pkg) => Boolean(pkg?.dsh?.bundle || pkg?.dsh?.client || pkg?.dsh?.host)
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
function publicGate(gate) {
  const requirements = Object.fromEntries(Object.entries(gate.requirements).map(([key, value]) => [packageName(key) ? key : '[redacted]', typeof value === 'string' && /^[0-9A-Za-z.*^~<>=|+\- ()]{0,180}$/.test(value) ? value : '[redacted]']))
  return { ...gate, requirements }
}

export function collectBundleInventory({ profileDir, dshRoot, dshVersion, candidateDir } = {}) {
  const report = { version: 1, checkedAt: new Date().toISOString(), source: 'local-metadata', status: 'unknown', filesInspected: 0,
    packages: [], matches: [], unverified: [], candidate: null,
    limitations: ['仅比较本地声明；重名不证明运行时冲突。', '工具声明不是完整动态工具清单；不执行目标代码或表达式。', '维护者矩阵为独立开发工具；自动体检不会运行验证进程。'] }
  const nodes = new Map(), plugins = [], seenFiles = new Set()
  let readAttempts = 0
  const note = (owner, reason) => { if (report.unverified.length < SOURCE_LIMITS.entries) report.unverified.push({ owner, reason }) }
  function text(file, owner) {
    let fd
    if (readAttempts++ >= SOURCE_LIMITS.packages * 2) { note(owner, 'metadata-file-count-limit'); return }
    try {
      fd = openSync(file, 'r'); const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > SOURCE_LIMITS.bytes) { note(owner, 'metadata-size-or-type-limit'); return }
      const buffer = Buffer.alloc(Math.min(stat.size + 1, SOURCE_LIMITS.bytes + 1))
      const count = readSync(fd, buffer, 0, buffer.length, 0)
      if (count > SOURCE_LIMITS.bytes || count !== stat.size) { note(owner, 'metadata-changed-or-truncated'); return }
      const key = realpathSync(file)
      if (!seenFiles.has(key)) { seenFiles.add(key); report.filesInspected++ }
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)).replace(/^\uFEFF/, '')
    } catch { note(owner, 'metadata-missing-or-unreadable') } finally { if (fd !== undefined) closeSync(fd) }
  }
  function json(file, owner) {
    const raw = text(file, owner)
    if (raw === undefined) return
    try { return JSON.parse(raw) } catch { note(owner, 'invalid-json') }
  }
  let yaml
  if (dshRoot) {
    try { const req = createRequire(join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json')); yaml = req('js-yaml') } catch { /* JSON remains available. */ }
  }
  function patch(dir, pkg, owner) {
    const declared = pkg?.dsh?.bundle?.patch
    const out = { status: 'unknown', entries: [] }
    if (typeof declared !== 'string') { out.reason = 'patch-not-declared'; return out }
    const file = resolve(dir, declared)
    try { if (!inside(dir, realpathSync(file))) { note(owner, 'patch-outside-package'); return out } } catch { note(owner, 'patch-missing-or-unreadable'); return out }
    const raw = text(file, owner)
    if (raw === undefined) return out
    let parsed
    try { parsed = JSON.parse(raw) } catch {
      if (!yaml) { note(owner, 'yaml-parser-unavailable'); return out }
      try { parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) } catch { note(owner, 'yaml-unsupported-or-invalid'); return out }
    }
    const visited = new Set()
    let count = 0, complete = true
    function rows(list, operation, group, depth) {
      if (!Array.isArray(list) || depth > SOURCE_LIMITS.depth || visited.has(list)) { complete = false; return }
      visited.add(list)
      for (const row of list) {
        if (++count > SOURCE_LIMITS.entries || !object(row)) { complete = false; break }
        if (row.insert !== undefined) { rows(row.insert, 'insert', identifier(row.id) ?? group, depth + 1); continue }
        const id = identifier(row.id), name = identifier(row.name)
        if ((!id && !name) || (row.id !== undefined && !id) || (row.name !== undefined && !name)) complete = false
        out.entries.push({ ...(id ? { id } : {}), ...(name ? { name } : {}), operation,
          ...(group ? { group } : {}), ...(row.isolate ? { isolated: true } : {}) })
        if (row.group === true && row.name === 'cordis:group') rows(row.config, 'insert', id, depth + 1)
        if (row.name === 'cordis:include') complete = false
      }
    }
    rows(parsed, 'override', undefined, 0)
    out.status = complete ? 'verified-subset' : 'unknown'
    if (!complete) note(owner, 'patch-structure-or-include-unverified')
    return out
  }
  function locate(dir, name) {
    let current = dir
    for (let n = 0; n < 12; n++) {
      const file = join(current, 'node_modules', name, 'package.json')
      if (existsSync(file)) return resolve(current, 'node_modules', name)
      const parent = resolve(current, '..'); if (parent === current) break; current = parent
    }
  }
  function visit(dir, providedBy, topLevel, depth, referenced = false, candidate = false, ancestors = new Set()) {
    let actual
    try { actual = realpathSync(dir) } catch { note(candidate ? 'candidate' : 'profile', 'package-directory-unreadable'); return }
    if (ancestors.has(actual)) { note('profile', 'dependency-cycle'); return }
    if (depth > SOURCE_LIMITS.depth) { note('profile', 'dependency-depth-or-count-limit'); return }
    const previous = nodes.get(actual)
    if (previous) {
      const promoted = topLevel && !previous.public.topLevel
      const newOrigins = providedBy.filter((id) => !previous.public.providedBy.includes(id))
      for (const id of providedBy) if (!previous.public.providedBy.includes(id)) previous.public.providedBy.push(id)
      previous.public.topLevel ||= topLevel
      previous.public.standalone = previous.public.topLevel && previous.public.providedBy.length === 0
      const childOrigins = [...newOrigins, ...(promoted ? [previous.public.id] : [])]
      if (!childOrigins.length) return previous.public
      // A promoted aggregate is also a root source, even without new ancestors.
      for (const child of previous.children) visit(child.dir, childOrigins, false, depth + 1, child.referenced, candidate, new Set([...ancestors, actual]))
      return previous.public
    }
    if (depth > SOURCE_LIMITS.depth || nodes.size >= SOURCE_LIMITS.packages) { note('profile', 'dependency-depth-or-count-limit'); return }
    const pkg = json(join(actual, 'package.json'), candidate ? 'candidate' : 'profile')
    if (!object(pkg) || !packageName(pkg.name)) { note(candidate ? 'candidate' : 'profile', 'package-manifest-unverified'); return }
    if (!pluginShape(pkg) && !referenced && !candidate) return
    const id = 'pkg-' + createHash('sha256').update(actual).digest('hex').slice(0, 16)
    const row = { id, name: pkg.name, version: packageVersion(pkg.version), role: pkg.dsh?.bundle ? 'bundle' : 'plugin', providedBy: [...providedBy], topLevel,
      standalone: topLevel && providedBy.length === 0, candidate, gate: publicGate(evaluatePluginGate(pkg, dshVersion)), tools: { status: 'unknown', names: [], source: 'dynamic-tools-unverified' } }
    if (row.version === null) note(id, 'package-version-unverified')
    const hints = pkg.dsh?.doctor?.toolNames
    if (Array.isArray(hints) && hints.length <= SOURCE_LIMITS.tools && hints.every((v) => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(v))) {
      row.tools = { status: 'declared-subset', names: [...new Set(hints)], source: 'package.dsh.doctor.toolNames (Doctor hint; not SDK contract)' }
    }
    note(id, row.tools.names.length ? 'dynamic-tools-not-covered-by-declarations' : 'dynamic-tools-unverified')
    if (typeof pkg.dsh?.bundle?.patch === 'string') {
      row.declaredPatch = '[declared]'
      row.patchExists = inside(actual, resolve(actual, pkg.dsh.bundle.patch)) && existsSync(resolve(actual, pkg.dsh.bundle.patch))
    }
    row.patch = patch(actual, pkg, id)
    const node = { public: row, children: [] }; nodes.set(actual, node); report.packages.push(row)
    if (!candidate) plugins.push({ name: row.name, version: row.version, dir: actual, pkg, sourceId: id, providedBy: row.providedBy, topLevel, standalone: topLevel })
    if (pkg.dsh?.bundle) {
      const refs = new Set(row.patch.entries.map((e) => packageRootOf(e.name)).filter(Boolean))
      const deps = object(pkg.dependencies) ? Object.keys(pkg.dependencies) : []
      if (deps.length > SOURCE_LIMITS.packages) note(id, 'dependency-count-limit')
      for (const name of deps.slice(0, SOURCE_LIMITS.packages)) {
        if (!packageName(name)) { note(id, 'dependency-name-unverified'); continue }
        const childDir = locate(actual, name)
        if (!childDir) { note(id, 'declared-dependency-unresolved'); continue }
        node.children.push({ dir: childDir, referenced: refs.has(name) })
        visit(childDir, topLevel ? [id] : providedBy, false, depth + 1, refs.has(name), candidate, new Set([...ancestors, actual]))
      }
    }
    return row
  }
  if (profileDir) {
    const profile = json(join(profileDir, 'package.json'), 'profile')
    if (object(profile?.dependencies)) {
      const names = Object.keys(profile.dependencies)
      if (names.length > SOURCE_LIMITS.packages) note('profile', 'dependency-count-limit')
      for (const name of names.slice(0, SOURCE_LIMITS.packages)) {
        if (!packageName(name)) { note('profile', 'dependency-name-unverified'); continue }
        const dir = locate(profileDir, name)
        if (dir) visit(dir, [], true, 0)
        else note('profile', 'declared-package-unresolved')
      }
    } else note('profile', 'profile-dependencies-unverified')
  } else note('profile', 'explicit-profile-unavailable')
  if (candidateDir !== undefined) {
    if (typeof candidateDir !== 'string' || !candidateDir.trim() || candidateDir.length > 2048 || /[\0\r\n]|:\/\//.test(candidateDir)) {
      note('candidate', 'candidate-must-be-local-package-directory'); report.candidate = { label: 'candidate', status: 'unknown' }
    } else {
      const row = visit(resolve(candidateDir), [], true, 0, true, true)
      report.candidate = { label: row?.name ?? 'candidate', status: row ? 'verified-subset' : 'unknown' }
    }
  }
  const declarations = new Map(), occurrences = new Map()
  function declaration(kind, value, owner) {
    if (!value || report.matches.length >= SOURCE_LIMITS.entries) return
    const key = kind + '\0' + value, owners = declarations.get(key) ?? []
    if (!owners.includes(owner)) owners.push(owner)
    declarations.set(key, owners)
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1)
  }
  for (const pkg of report.packages) {
    declaration('package', pkg.name, pkg.id)
    for (const name of pkg.tools.names) declaration('tool', name, pkg.id)
    for (const e of pkg.patch.entries) {
      // Overrides intentionally target existing IDs; a name may legally create multiple instances.
      if (e.operation === 'insert') declaration('patch-id', e.id, pkg.id)
      declaration('patch-name', e.name, pkg.id)
    }
  }
  for (const [key, owners] of declarations) if (occurrences.get(key) > 1) {
    if (report.matches.length >= SOURCE_LIMITS.entries) { note('profile', 'declaration-match-count-limit'); break }
    const [kind, value] = key.split('\0'); report.matches.push({ kind, value, owners, effect: 'review-required' })
  }
  report.status = report.packages.length ? report.unverified.length ? 'partial' : 'verified-subset' : 'unknown'
  for (const plugin of plugins) {
    const current = report.packages.find((p) => p.id === plugin.sourceId)
    plugin.topLevel = current.topLevel; plugin.standalone = current.standalone
  }
  return { report, plugins }
}
export function inspectBundleSources(options) { return collectBundleInventory(options).report }
export function bundleSourceLines(report) {
  if (!report) return ['Bundle 来源：旧快照未记录，未核实。']
  const labels = new Map(report.packages.map((p) => [p.id, `${p.name}@${p.version ?? '?'}`]))
  return [
    `Bundle 来源 / 候选预检：${report.status} · 读取 ${report.filesInspected} 个元数据文件 · ${report.checkedAt}`,
    ...(report.candidate ? [`候选：${report.candidate.label} · ${report.candidate.status}（仅声明子集）`] : []),
    ...report.packages.slice(0, 128).map((p) => `${labels.get(p.id)} [${p.id}]${p.candidate ? ' · candidate' : ''} · ${p.providedBy.length ? `providedBy=${p.providedBy.map((id) => labels.get(id) ?? id).join(' / ')}；操作来源 bundle，不单独卸载` : '顶层声明'} · 加载要求 ${p.gate.uncertain ? 'unknown' : Object.keys(p.gate.requirements).length ? 'unmet' : 'met'} (${p.gate.basis})`),
    ...report.matches.slice(0, 32).map((m) => `声明重叠（待核实，非运行时冲突）：${m.kind} ${m.value} · ${m.owners.map((id) => labels.get(id) ?? id).join(' / ')}`),
    ...report.unverified.slice(0, 32).map((u) => `未核实：${labels.get(u.owner) ?? u.owner} · ${u.reason}`),
    ...(report.unverified.length > 32 ? [`另有 ${report.unverified.length - 32} 条未核实原因，完整信息见 JSON。`] : []),
    ...report.limitations,
  ]
}
