/** Closed, in-memory browser evidence. It never grants repair authority or stores page content. */
import { randomUUID } from 'node:crypto'

export const FRONTEND_OBSERVATION_PATH = '/api/dsh-doctor/frontend'
export const FRONTEND_REPORT_PATH = '/api/dsh-doctor/frontend/report'
const MAX_BODY = 16384
const MAX_MODULES = 64
const MAX_CLIENTS = 8
const ID = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i
const CLIENT_ID = /^[a-zA-Z0-9_-]{8,64}$/
const ENTRY = ['ready', 'pending', 'failed', 'unknown']
const REGISTRATION = ['registered', 'unknown']
const MOUNT = ['mounted', 'not-opened', 'failed', 'unknown']
const ERROR = ['none', 'module-load-or-entry', 'render']
const SELECTION = ['selected', 'not-selected', 'unknown']
const ownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every((key) => keys.includes(key))
const unknownRow = (id) => ({ id, entry: 'unknown', registration: 'unknown', mount: 'unknown', error: 'none', selection: 'unknown' })

export function createFrontendObservation({ graph = () => undefined, now = Date.now, epoch = randomUUID(), ttlMs = 120000 } = {}) {
  const clients = new Map()
  const ttl = Math.max(1000, Math.min(300000, Number(ttlMs) || 120000))
  let disposed = false
  let currentEpoch = epoch
  function rows() {
    let entries
    try { entries = graph()?.entries } catch { return [] }
    if (!Array.isArray(entries)) return []
    const seen = new Set()
    return entries.filter((row) => {
      if (!row || typeof row.id !== 'string' || !ID.test(row.id) || row.id.length > 180
        || typeof row.rev !== 'string' || !row.rev || row.rev.length > 160 || seen.has(row.id)) return false
      seen.add(row.id)
      return true
    }).sort((a, b) => Number(b.id === 'dsh-doctor') - Number(a.id === 'dsh-doctor') || a.id.localeCompare(b.id))
      .slice(0, MAX_MODULES).map((row) => ({ id: row.id, rev: row.rev }))
  }
  function bootstrap() {
    return { epoch: currentEpoch, modules: rows(), maxModules: MAX_MODULES, ttlMs: ttl }
  }
  function accept(body) {
    if (disposed) return { ok: false, status: 410, code: 'observer-disposed' }
    if (!ownKeys(body, ['epoch', 'clientId', 'sequence', 'modules', 'capabilities']) || body.epoch !== currentEpoch
      || typeof body.clientId !== 'string' || !CLIENT_ID.test(body.clientId) || !Number.isSafeInteger(body.sequence) || body.sequence < 1
      || body.sequence > 2147483647 || !Array.isArray(body.modules) || body.modules.length > MAX_MODULES) {
      return { ok: false, status: 400, code: 'invalid-report' }
    }
    const capabilities = { modules: false, registration: false, renderErrors: false }
    if (body.capabilities !== undefined) {
      if (!ownKeys(body.capabilities, Object.keys(capabilities))
        || Object.keys(capabilities).some((key) => typeof body.capabilities[key] !== 'boolean')) return { ok: false, status: 400, code: 'invalid-capabilities' }
      Object.assign(capabilities, body.capabilities)
    }
    const allowed = new Map(rows().map((row) => [row.id, row.rev]))
    const seen = new Set(), modules = []
    for (const row of body.modules) {
      if (!ownKeys(row, ['id', 'rev', 'entry', 'registration', 'mount', 'error', 'selection']) || seen.has(row.id)
        || !allowed.has(row.id) || allowed.get(row.id) !== row.rev
        || !ENTRY.includes(row.entry) || !REGISTRATION.includes(row.registration)
        || !MOUNT.includes(row.mount) || !ERROR.includes(row.error)) {
        return { ok: false, status: 409, code: 'stale-or-invalid-module' }
      }
      const selection = row.selection ?? 'unknown'
      if (!SELECTION.includes(selection)) return { ok: false, status: 400, code: 'inconsistent-report' }
      // Only Doctor owns and witnesses its React lifecycle. External mounting stays unknown.
      if (row.id !== 'dsh-doctor' && (row.mount !== 'unknown' || selection !== 'unknown')) return { ok: false, status: 400, code: 'unsupported-mount-claim' }
      if (row.mount === 'mounted' && (row.registration !== 'registered' || row.entry !== 'ready')) return { ok: false, status: 400, code: 'inconsistent-report' }
      if (row.mount === 'not-opened' && selection !== 'not-selected') return { ok: false, status: 400, code: 'inconsistent-report' }
      if (row.mount === 'failed' && row.error !== 'render') return { ok: false, status: 400, code: 'inconsistent-report' }
      if (row.entry === 'failed' && row.error !== 'module-load-or-entry') return { ok: false, status: 400, code: 'inconsistent-report' }
      if (row.error === 'module-load-or-entry' && row.entry !== 'failed') return { ok: false, status: 400, code: 'inconsistent-report' }
      if (row.error === 'render' && row.id === 'dsh-doctor' && row.mount !== 'failed') return { ok: false, status: 400, code: 'inconsistent-report' }
      seen.add(row.id)
      modules.push({ id: row.id, rev: row.rev, entry: row.entry, registration: row.registration, mount: row.mount, error: row.error, selection })
    }
    const previous = clients.get(body.clientId)
    if (previous && body.sequence <= previous.sequence) return { ok: false, status: 409, code: 'out-of-order-report' }
    clients.delete(body.clientId)
    clients.set(body.clientId, { sequence: body.sequence, at: now(), modules, capabilities })
    while (clients.size > MAX_CLIENTS) clients.delete(clients.keys().next().value)
    return { ok: true, status: 200 }
  }
  function snapshot() {
    const current = rows(), latest = Array.from(clients.values()).at(-1)
    const stale = Boolean(latest && now() - latest.at >= ttl)
    const active = latest && !stale && !disposed ? new Map(latest.modules.map((row) => [row.id, row])) : new Map()
    return {
      available: !disposed && current.length > 0,
      scope: 'recent-owner-browser',
      ttlMs: ttl,
      capabilities: latest?.capabilities ?? null,
      observedAt: latest ? new Date(latest.at).toISOString() : null,
      stale,
      modules: current.map((row) => {
        const observation = active.get(row.id)
        if (!observation || observation.rev !== row.rev) return unknownRow(row.id)
        const { rev: _rev, ...publicRow } = observation
        return publicRow
      }),
      limitations: ['最近一个所有者浏览器窗口的回报，不代表所有窗口。', '资源可获取、入口执行、组件注册与实际挂载是不同证据。', '第三方组件实际挂载缺少通用公开观测接口，继续保留待核对。'],
    }
  }
  return { bootstrap, accept, snapshot, reset() { currentEpoch = randomUUID(); clients.clear() }, dispose() { disposed = true; clients.clear() } }
}

/** Connection owns transport authentication. The owner fence is checked again for direct callers. */
export function registerFrontendObservation(connection, observer) {
  if (typeof connection?.fetch?.register !== 'function' || typeof connection.admit !== 'function' || !connection.browserPeer) return undefined
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  const reply = (status, body) => Response.json(body, { status, headers })
  let active = true
  const handle = async (request, expectedMethod) => {
      if (!active) return reply(410, { ok: false, code: 'route-disposed' })
      const generation = observer.bootstrap().epoch
      if (request.method !== expectedMethod) return reply(405, { ok: false, code: 'method' })
      if (request.signal?.aborted) return reply(499, { ok: false, code: 'aborted' })
      let admission
      try { admission = connection.admit({ headers: request.headers }) } catch { return reply(401, { ok: false, code: 'authentication' }) }
      if (!admission || admission.rejection) return reply(admission?.rejection === 403 ? 403 : 401, { ok: false, code: 'authentication' })
      const owner = connection.browserPeer?.id
      if (typeof owner !== 'string' || !owner || admission.peer?.id !== owner) return reply(403, { ok: false, code: 'owner-only' })
      if (request.method === 'GET') return reply(200, observer.bootstrap())
      if (request.headers.get('x-dsh-doctor-ui') !== '1') return reply(403, { ok: false, code: 'ui-header' })
      if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) return reply(415, { ok: false, code: 'content-type' })
      const length = Number(request.headers.get('content-length'))
      if (Number.isFinite(length) && length > MAX_BODY) return reply(413, { ok: false, code: 'too-large' })
      try {
        const reader = request.body?.getReader()
        const chunks = []
        let bytes = 0
        if (reader) {
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              bytes += value.byteLength
              if (bytes > MAX_BODY) { await reader.cancel(); return reply(413, { ok: false, code: 'too-large' }) }
              chunks.push(value)
            }
          } finally { reader.releaseLock() }
        }
        if (!active || request.signal?.aborted || observer.bootstrap().epoch !== generation) return reply(410, { ok: false, code: 'route-disposed' })
        const text = Buffer.concat(chunks).toString('utf8')
        const result = observer.accept(JSON.parse(text))
        return reply(result.status, { ok: result.ok, ...(result.code ? { code: result.code } : {}) })
      } catch { return reply(400, { ok: false, code: 'invalid-report' }) }
  }
  const disposers = []
  const cleanup = () => {
    if (!active) return
    active = false
    observer.reset()
    for (const close of disposers.splice(0).reverse()) { try { close?.() } catch { /* Release both routes even if one disposer is stale. */ } }
  }
  try {
    // GET cannot carry a stream body in the public carrier; POST must not be pre-buffered.
    disposers.push(connection.fetch.register({ path: FRONTEND_OBSERVATION_PATH, methods: ['GET'], requestBody: 'buffered', fetch: (request) => handle(request, 'GET') }))
    disposers.push(connection.fetch.register({ path: FRONTEND_REPORT_PATH, methods: ['POST'], requestBody: 'streaming', fetch: (request) => handle(request, 'POST') }))
  } catch (error) { cleanup(); throw error }
  return cleanup
}
