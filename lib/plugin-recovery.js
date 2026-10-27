/** Read-only UI evidence and single-entry recovery through the native manager. */
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeResult } from './diag.js'

export const PLUGIN_UI_RULE_ID = 'DSH-PLG-006'
const digest = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i

async function manifestOf(name, options) {
  if (!packageName.test(name)) return undefined
  const bases = [options.profileDir, options.dshRoot, dirname(dirname(fileURLToPath(import.meta.url)))].filter(Boolean)
  for (const base of bases) {
    try {
      const require = createRequire(join(resolve(base), 'package.json'))
      let file
      try { file = require.resolve(`${name}/package.json`) }
      catch { file = require.resolve(name) }
      let dir = dirname(file)
      for (let n = 0; n < 8; n++, dir = dirname(dir)) {
        try {
          const path = join(dir, 'package.json')
          const info = await stat(path)
          if (info.size > 128 * 1024) break
          const text = await readFile(path, 'utf8'), pkg = JSON.parse(text)
          if (pkg.name === name) return { pkg, hash: digest(text) }
        } catch { /* entry may be below the package root */ }
        if (dirname(dir) === dir) break
      }
    } catch { /* unresolved manifests are unknown, not a missing UI */ }
  }
  return undefined
}

/** No config text, source URLs or error bodies become diagnostic data. */
export async function collectPluginUi(options = {}) {
  const { pluginManager, clientModules } = options
  if (typeof pluginManager?.listPlugins !== 'function' || typeof pluginManager?.listBundles !== 'function') return { available: false, entries: [] }
  let plugins, bundles
  try {
    ;[plugins, bundles] = await Promise.all([pluginManager.listPlugins(), pluginManager.listBundles()])
    if (!Array.isArray(plugins) || !Array.isArray(bundles)) throw new Error('inventory')
  } catch { return { available: false, entries: [] } }
  let graph
  try { graph = clientModules?.graph() } catch { /* optional capability */ }
  const graphEntries = Array.isArray(graph?.entries) ? graph.entries : undefined
  const entries = []
  for (const bundle of bundles.filter((item) => item?.installed === true || ['installation', 'profile'].includes(item?.availability))) {
    const manifest = await manifestOf(bundle.name, options)
    for (const row of Array.isArray(bundle.rows) ? bundle.rows : []) {
      const matches = plugins.filter((p) => row.entryId && p.entryId === row.entryId && p.moduleName === row.moduleName)
      const p = matches.length === 1 ? matches[0] : undefined
      const advertised = graphEntries?.find((item) => item.id === row.moduleName)
      // A bundle may insert a different package; Host subpaths still need their own evidence.
      const rowManifest = row.moduleName === bundle.name ? manifest : await manifestOf(row.moduleName, options)
      const expected = advertised ? 'yes' : !rowManifest ? 'unknown'
        : rowManifest.pkg.dsh?.client?.platform === 'web' ? 'yes' : rowManifest.pkg.dsh?.client ? 'unknown' : 'no'
      let resource = 'unknown'
      if (advertised && typeof clientModules?.fetchBundle === 'function') {
        try {
          const url = new URL(advertised.url, 'http://doctor.invalid')
          if (url.origin !== 'http://doctor.invalid' || !url.pathname.startsWith('/plugins/')) throw new Error('not a local bundle')
          const response = await clientModules.fetchBundle(new Request(url, { signal: AbortSignal.timeout(3000) }))
          resource = response.status === 200 ? 'pass' : 'issue'
          await response.body?.cancel()
        } catch { resource = 'issue' }
      }
      entries.push({ bundle: bundle.name, version: bundle.version, bundleEnabled: bundle.enabled,
        rowId: row.rowId, entryId: p?.entryId, moduleName: row.moduleName, patchId: p?.patchId,
        enabled: p?.enabled, fiberPhase: p?.fiberPhase ?? null,
        addressable: Boolean(p?.patchId && !p.readOnlyReason && typeof pluginManager.setPluginEnabled === 'function'),
        expected, manifestHash: digest({ bundle: manifest?.hash, module: rowManifest?.hash }),
        graph: graphEntries ? advertised ? 'advertised' : 'missing' : 'unknown', resource, browser: 'unknown' })
    }
  }
  // Ambiguous ownership must never produce a mutation offer.
  for (const entry of entries) if (entries.filter((other) => entry.entryId && other.entryId === entry.entryId).length !== 1) entry.addressable = false
  return { available: true, entries, plugins: plugins.map((p) => ({ entryId: p.entryId, moduleName: p.moduleName, patchId: p.patchId, enabled: p.enabled })).sort((a, b) => String(a.entryId).localeCompare(String(b.entryId))) }
}

export function pluginUiResult(snapshot) {
  const entries = snapshot?.entries ?? []
  const relevant = entries.filter((e) => e.expected === 'yes')
  // Unselected bundles are intentionally off, not failed UI expectations.
  const broken = relevant.filter((e) => e.bundleEnabled === true && (e.enabled === false || e.fiberPhase === 'failed'
    || (e.enabled === true && e.graph === 'missing') || e.resource === 'issue'))
  const status = broken.length ? 'issue' : 'unknown'
  return makeResult({ id: PLUGIN_UI_RULE_ID, category: 'plugins', severity: broken.length ? 'warning' : 'info', status,
    title: '插件 UI 分层证据',
    summary: broken.length ? `${broken.length} 个前端条目存在禁用、加载或资源异常` : snapshot?.available ? 'Host 证据已采集；浏览器挂载状态待核对' : '插件管理服务不可用，UI 状态未知',
    evidence: relevant.map((e) => `${e.moduleName} · 已安装 ${e.version ?? '未知版本'} · bundle=${e.bundleEnabled} · enabled=${e.enabled ?? 'unknown'} · fiber=${e.fiberPhase ?? 'unknown'} · graph=${e.graph} · resource=${e.resource} · browser=unknown`),
    recommendations: ['仅对可寻址的禁用前端条目准备启用方案；加载或资源异常先核对插件版本和入口。', 'Host 宣告或资源可用不等于浏览器已挂载；按管理器回执刷新页面或手动重启后复查。'],
    data: { entries },
  })
}

export function canEnablePlugin(entry) {
  return entry?.expected === 'yes' && entry.bundleEnabled === true && entry.enabled === false && entry.addressable === true
}

const identity = (e) => e && ({ bundle: e.bundle, version: e.version, rowId: e.rowId, entryId: e.entryId, moduleName: e.moduleName, patchId: e.patchId, manifestHash: e.manifestHash })
const targetOf = (snapshot, id) => {
  const rows = snapshot.entries.filter((e) => e.entryId === id)
  return rows.length === 1 ? rows[0] : undefined
}
const inventory = (snapshot) => ({ plugins: snapshot.plugins, entries: snapshot.entries.map((e) => ({ ...identity(e), enabled: e.enabled, bundleEnabled: e.bundleEnabled })).sort((a, b) => String(a.entryId).localeCompare(String(b.entryId))) })
export const pluginOfferId = (entryId) => `offer-plugin-${digest(entryId).slice(0, 24)}`
const location = (options) => ({ home: resolve(options.home), profileDir: options.profileDir ? resolve(options.profileDir) : undefined })

async function profileHash(options) {
  if (!options.profileDir) throw new Error('缺少当前 profile')
  const hashes = []
  for (const [dir, name] of [[options.profileDir, 'package.json'], [options.profileDir, 'cordis.patch.yml'], [options.profileDir, 'pnpm-lock.yaml'], [options.profileDir, 'compatibility.json'], [options.home, 'cordis.patch.yml']]) {
    try {
      const file = join(dir, name)
      if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error('profile 文件过大')
      hashes.push([name, digest(await readFile(file))])
    } catch (error) { if (error.code === 'ENOENT') hashes.push([name, null]); else throw error }
  }
  return digest(hashes)
}

export async function preparePluginPlan(options, target) {
  if (typeof target !== 'string' || !target || target.length > 240) throw new Error('缺少真实插件 entryId')
  const snapshot = await collectPluginUi(options), entry = targetOf(snapshot, target)
  if (!snapshot.available || !canEnablePlugin(entry)) throw new Error('该条目不是可恢复的禁用前端条目；请刷新诊断并核对管理器状态')
  const id = `plan-plugin-${randomUUID()}`
  return { id, planId: id, title: `启用 ${entry.moduleName}`, risk: 'high', changes: [{ operation: 'plugin-enable', target, summary: '仅通过原生管理器启用此条目；回滚恢复原禁用状态，不覆盖整个 profile。' }],
    meta: { prepared: true, kind: 'plugin-enable', location: location(options), before: identity(entry), inventoryHash: digest(inventory(snapshot)), profileHash: await profileHash(options) } }
}

export async function validatePluginPlan(plan, options) {
  const snapshot = await collectPluginUi(options), entry = targetOf(snapshot, plan.meta.before.entryId)
  return snapshot.available && canEnablePlugin(entry) && digest(identity(entry)) === digest(plan.meta.before)
    && digest(inventory(snapshot)) === plan.meta.inventoryHash && digest(location(options)) === digest(plan.meta.location)
    && await profileHash(options) === plan.meta.profileHash
}

/** The controller saves its receipt before invoking this function. */
export async function applyPluginPlan(plan, options) {
  if (!await validatePluginPlan(plan, options)) return { status: 'refused', text: '插件或 profile 已变化；请重新准备并确认。' }
  let change
  try { change = await options.pluginManager.setPluginEnabled(plan.meta.before.entryId, true) }
  catch { change = { application: 'failed' } }
  const snapshot = await collectPluginUi(options), entry = targetOf(snapshot, plan.meta.before.entryId)
  const verified = snapshot.available && entry?.enabled === true && entry.fiberPhase === 'active' && entry.graph === 'advertised' && entry.resource === 'pass'
  const othersBefore = plan.meta.inventoryHash
  const expectedSnapshot = { ...snapshot, entries: snapshot.entries.map((e) => e.entryId === plan.meta.before.entryId ? { ...e, enabled: false } : e), plugins: snapshot.plugins?.map((e) => e.entryId === plan.meta.before.entryId ? { ...e, enabled: false } : e) }
  const othersUnchanged = snapshot.available && digest(inventory(expectedSnapshot)) === othersBefore
  const application = ['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(change?.application) ? change.application : 'failed'
  const status = ['failed', 'cancelled'].includes(application) ? 'failed' : application === 'applied' && verified && othersUnchanged ? 'applied' : 'partial'
  return { status, application, verification: { status: verified && othersUnchanged ? 'pass' : 'unknown', browser: 'unknown', othersUnchanged },
    after: snapshot.available && entry && digest(identity(entry)) === digest(plan.meta.before) ? { identity: identity(entry), enabled: entry.enabled, profileHash: await profileHash(options) } : undefined,
    text: `单插件启用：${application}；Host/资源复检：${verified ? '通过' : '未完整'}；其他条目：${othersUnchanged ? '未变' : '需核对'}。浏览器挂载未验证，请刷新页面；restart-required 须手动重启后复查。` }
}

export async function rollbackPluginRecord(record, options) {
  if (digest(location(options)) !== digest(record.location) || !record.after || !['applied', 'partial', 'failed'].includes(record.status)) return { status: 'refused', text: '回滚记录或运行位置不匹配。' }
  const snapshot = await collectPluginUi(options), entry = targetOf(snapshot, record.before.entryId)
  // A startup-only enable request becomes visible in the inventory only after restart.
  const expectedEnabled = entry?.enabled === record.after.enabled || (record.application === 'restart-required' && entry?.enabled === true)
  if (!snapshot.available || !entry?.addressable || digest(identity(entry)) !== digest(record.before)
      || !expectedEnabled || await profileHash(options) !== record.after.profileHash) return { status: 'refused', text: '插件或 profile 在执行后已变化；保留当前状态，请重新核对。' }
  let change
  try { change = await options.pluginManager.setPluginEnabled(record.before.entryId, false) }
  catch { return { status: 'failed', text: '管理器回滚失败，请核对当前条目状态。' } }
  const after = targetOf(await collectPluginUi(options), record.before.entryId)
  const status = ['failed', 'cancelled'].includes(change?.application) ? 'failed'
    : change?.application === 'applied' && after?.enabled === false ? 'restored' : 'partial'
  return { status, text: `单插件回滚：${change?.application ?? 'unknown'}；${status === 'restored' ? '原禁用状态已恢复' : '需核对状态或手动重启'}；仅请求修改目标条目。` }
}
