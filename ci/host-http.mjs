#!/usr/bin/env node
/** Real Cordis + BrowserAuth HTTP proof. Graph rows are explicit fixtures, not browser execution proof.
 * All credentials/profile/files belong to this process's unique temporary home; never use live user state.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { platformChecks } from './platform-checks.mjs'
import { join, resolve } from 'node:path'
import { tmpdir, platform, arch, release } from 'node:os'
import { readDshCorePkg, readJson } from '../lib/probe.js'
const doctorRoot = process.argv.includes('--doctor-root') ? process.argv[process.argv.indexOf('--doctor-root') + 1] : null
const { apply } = await import(doctorRoot ? pathToFileURL(join(resolve(doctorRoot), 'lib/index.js')).href : '../lib/index.js')
import { FRONTEND_OBSERVATION_PATH as PATH, FRONTEND_REPORT_PATH as REPORT_PATH } from '../lib/frontend-observation.js'
const option = (key, fallback) => { const index = process.argv.indexOf('--' + key); return index < 0 ? fallback : process.argv[index + 1] }
if (!option('runtime-root') || !option('output')) throw new Error('runtime-root and output are required')
const runtime = resolve(option('runtime-root'))
const output = resolve(option('output'))
const require_ = createRequire(join(runtime, 'package.json'))
const load = (name) => import(pathToFileURL(require_.resolve(name)).href)
const home = mkdtempSync(join(realpathSync(tmpdir()), 'doctor-frontend-'))
for (const name of ['temp', 'appdata', 'config']) mkdirSync(join(home, name))
Object.assign(process.env, { HOME: home, USERPROFILE: home, DSH_HOME: home, TEMP: join(home, 'temp'), TMP: join(home, 'temp'), TMPDIR: join(home, 'temp'), APPDATA: join(home, 'appdata'), XDG_CONFIG_HOME: join(home, 'config') })
const profileDir = join(home, 'profiles', 'frontend-sample')
mkdirSync(profileDir, { recursive: true })
mkdirSync(join(home, 'workspace'), { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'frontend-sample', private: true, dependencies: {} }))
writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
let ctx, origin, connection, fiber, cookie, apiCookie, tool, boot, seq = 0
const fibers = []
const steps = [], secrets = []
const report = { startedAt: new Date().toISOString(),
  runtimeInfo: { node: process.version, platform: platform(), arch: arch(), osRelease: release(), host: readDshCorePkg(runtime)?.version ?? readJson(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'))?.version ?? null }, steps, isolation: { realProfileTouched: false, graphFixture: true, browserClicks: false, separateOsProcess: true } }
let graphRows = [{ id: 'dsh-doctor', url: '/plugins/dsh-doctor.js', rev: 'r1' }, { id: 'other-plugin', url: '/plugins/other-plugin.js', rev: 'r1' }]
async function check(id, fn) { const evidence = await fn(); steps.push({ id, ok: true, evidence }); console.log('PASS ' + id) }
function request(path, { method = 'GET', headers = {}, body, chunked = false } = {}) {
  return new Promise((done, fail) => {
    const url = new URL(path, origin)
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: { ...headers, ...(body && !chunked ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(10000, () => req.destroy(new Error('fixture-http-timeout')))
    req.on('error', (error) => error.code === 'ECONNRESET' ? done({ status: 0, headers: {}, text: '' }) : fail(error))
    if (body) req.write(body)
    req.end()
  })
}
// Do not send EOF: a buffered carrier would wait here until the explicit test deadline.
function oversizedBeforeEof() {
  return new Promise((done, fail) => {
    const target = new URL(REPORT_PATH, origin)
    const started = Date.now()
    let settled = false, timer
    const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json', 'x-dsh-doctor-ui': '1', 'transfer-encoding': 'chunked' } }, (res) => {
      res.resume()
      res.on('end', () => finish(null, { status: res.statusCode, beforeEof: true, elapsedMs: Date.now() - started }))
    })
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.destroy()
      if (error) fail(error); else done(result)
    }
    req.on('error', (error) => finish(error.code === 'ECONNRESET' ? null : error,
      { status: 0, beforeEof: true, elapsedMs: Date.now() - started, code: error.code }))
    timer = setTimeout(() => finish(new Error('early-stream-limit-deadline-before-eof')), 4000)
    req.write(Buffer.alloc(16385, 120))
    // Intentionally no req.end(); only the receiver or deadline may close this request.
  })
}
const auth = () => ({ cookie, origin })
const row = (extra = {}) => ({ id: 'dsh-doctor', rev: 'r1', entry: 'ready', registration: 'registered', mount: 'mounted', selection: 'selected', error: 'none', ...extra })
const payload = (extra = {}) => ({ epoch: boot.epoch, clientId: 'http_test_client', sequence: ++seq, modules: [row()], capabilities: { modules: true, registration: true, renderErrors: true }, ...extra })
const post = (value, headers = {}, raw, chunked) => request(REPORT_PATH, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json', 'x-dsh-doctor-ui': '1', ...headers }, body: raw ?? JSON.stringify(value), chunked })
async function panel() { const r = await request('/api/dsh-doctor/panel', { headers: auth() }); assert.equal(r.status, 200); return JSON.parse(r.text) }
async function negative(id, status, send) {
  await check(id, async () => { const before = (await panel()).report.frontend; const response = await send(); assert.equal(response.status, status); assert.deepEqual((await panel()).report.frontend, before); return { status, stateUnchanged: true } })
}
const watchdog = setTimeout(() => { console.error('fixture watchdog timeout'); process.exit(1) }, 90000).unref()
try {
  if (process.argv.includes('--platform-checks')) await platformChecks(check)
  const [cordis, credentials, web, transport] = await Promise.all([load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-credentials-local'), load('@deepseek-ai/dsh-host-webserver'), load('@deepseek-ai/dsh-client-connection')])
  ctx = new cordis.Context()
  for (const [plugin, config] of [[credentials.default, { path: join(home, 'auth.yaml'), dshHome: home, watch: false }], [web.default, { host: '127.0.0.1', port: 0 }], [Object.assign(transport.apply, { inject: transport.inject }), { maxRequestBodyBytes: 65536 }]]) { const mounted = ctx.plugin(plugin, config); await mounted; fibers.push(mounted) }
  connection = ctx.get('connection'); const webServer = ctx.get('webServer'); origin = webServer.getOrigin()
  for (const name of ['cordis', 'dsh-client-connection', 'dsh-host-webserver', 'dsh-credentials-local']) {
    report.versions ??= {}; report.versions[name] = JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version
  }
  const services = ctx.plugin({ apply(c) { c.provide('clientModules', { graph: () => ({ entries: graphRows }) }); c.provide('tools', { register(def) { if (def.name === 'dsh_doctor') tool = def; return () => {} } }) } })
  await services; fibers.push(services)
  fiber = ctx.plugin(apply, { home, profileDir, profile: 'frontend-sample', cwd: join(home, 'workspace'), dshRoot: runtime, connectivity: false })
  await fiber
  webServer.register({ kind: 'exact', path: '/', handler(req, res) { if (connection.authorizeIndex(req, res)) { res.writeHead(200); res.end('fixture') } } })
  await check('owner-auth-bootstrap', async () => {
    assert.equal(typeof connection.admit, 'function'); assert(connection.browserPeer)
    const login = new URL(connection.authenticatedUrl(origin)); const exchange = await request(login.pathname + login.search)
    assert.equal(exchange.status, 303); cookie = exchange.headers['set-cookie'][0].split(';')[0]; secrets.push(cookie, login.searchParams.get('token'))
    const r = await request(PATH, { headers: auth() }); assert.equal(r.status, 200, 'authenticated bootstrap'); assert.equal(r.headers['cache-control'], 'no-store'); boot = JSON.parse(r.text); assert.equal(boot.modules.length, 2)
    return { status: r.status, modules: boot.modules.length, browserPeerPresent: true }
  })
  const score = (await panel()).report.summary.score
  await negative('anonymous-get', 401, () => request(PATH))
  await negative('anonymous-post', 401, () => post(payload(), { cookie: '' }))
  await check('independent-api-peer-minted', async () => {
    const launch = new URL(connection.authenticatedUrl(origin)); const r = await request('/connect?token=' + encodeURIComponent(launch.searchParams.get('token')) + '&interactions=none')
    assert.equal(r.status, 302); apiCookie = r.headers['set-cookie'][0].split(';')[0]; secrets.push(apiCookie)
    assert.notEqual(connection.admit({ headers: new Headers({ cookie: apiCookie, host: new URL(origin).host }) }).peer?.id, connection.browserPeer.id)
    return { status: r.status, separatePeer: true }
  })
  await negative('api-peer-get', 403, () => request(PATH, { headers: { cookie: apiCookie, origin } }))
  await negative('api-peer-post', 403, () => post(payload(), { cookie: apiCookie }))
  await negative('wrong-origin', 403, () => post(payload(), { origin: 'http://foreign.invalid' }))
  await negative('wrong-host', 403, () => post(payload(), { host: 'foreign.invalid' }))
  await negative('missing-ui-header', 403, () => post(payload(), { 'x-dsh-doctor-ui': '0' }))
  await negative('wrong-content-type', 415, () => post(payload(), { 'content-type': 'text/plain' }))
  await negative('malformed-json', 400, () => post({}, {}, '{bad'))
  await negative('old-epoch', 400, () => post(payload({ epoch: 'old-epoch' })))
  await negative('old-revision', 409, () => post(payload({ modules: [row({ rev: 'old' })] })))
  await negative('duplicate-module', 409, () => post(payload({ modules: [row(), row()] })))
  await negative('sensitive-field', 409, () => post(payload({ modules: [row({ message: 'SYNTHETIC_CANARY_VALUE' })] })))
  await negative('oversized-content-length', 413, () => post({}, {}, 'x'.repeat(17000)))
  await check('oversized-chunked-body', async () => {
    const before = (await panel()).report.frontend; const r = await post({}, {}, 'x'.repeat(17000), true)
    assert([0, 413].includes(r.status)); assert.deepEqual((await panel()).report.frontend, before)
    return { status: r.status, stateUnchanged: true, socketResetAcceptedAsTransportLimit: r.status === 0 }
  })
  await check('stream-limit-rejects-before-request-eof', async () => {
    const before = (await panel()).report.frontend
    const result = await oversizedBeforeEof()
    assert([0, 413].includes(result.status))
    assert.equal(result.beforeEof, true)
    assert.deepEqual((await panel()).report.frontend, before)
    return { ...result, stateUnchanged: true, noRequestEofSent: true }
  })
  let accepted
  await check('owner-report-snapshot-and-tool-agree', async () => {
    accepted = payload(); const r = await post(accepted); assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.text), { ok: true })
    const snapshot = await panel(); const raw = JSON.parse((await tool.execute({ format: 'json' })).text)
    assert.deepEqual(raw.frontend, snapshot.report.frontend); assert.equal(raw.frontend.modules[0].mount, 'mounted'); assert.equal(raw.frontend.reporting, true); assert.equal(raw.summary.score, score)
    return { status: r.status, mounted: true, snapshotReportEqual: true, healthScoreUnchanged: true }
  })
  await negative('duplicate-sequence', 409, () => post(accepted))
  await negative('out-of-order', 409, () => post({ ...accepted, sequence: accepted.sequence - 1 }))
  await negative('third-party-mount-forgery', 400, () => post(payload({ modules: [{ ...row(), id: 'other-plugin' }] })))
  await check('third-party-render-error-with-unknown-mount', async () => {
    const r = await post(payload({ modules: [{ ...row(), id: 'other-plugin', mount: 'unknown', selection: 'unknown', error: 'render' }] })); assert.equal(r.status, 200)
    const snapshot = (await panel()).report.frontend; assert.equal(snapshot.modules[1].error, 'render'); assert.equal(snapshot.modules[1].mount, 'unknown'); return { status: 200, renderError: true, mount: 'unknown' }
  })
  await check('graph-revision-change-invalidates-browser-evidence', async () => {
    graphRows = graphRows.map((row) => ({ ...row, rev: 'r2' })); const snapshot = (await panel()).report.frontend
    assert(snapshot.modules.every((row) => row.entry === 'unknown' && row.mount === 'unknown'))
    const r = await post(payload()); assert.equal(r.status, 409); return { status: r.status, oldEvidenceInvalidated: true }
  })
  await check('unload-and-remount-revokes-old-epoch', async () => {
    const previous = boot.epoch; await fiber.dispose(); const absent = await request(PATH, { headers: auth() }); assert.equal(absent.status, 404)
    graphRows = graphRows.map((row) => ({ ...row, rev: 'r1' }))
    fiber = ctx.plugin(apply, { home, profileDir, profile: 'frontend-sample', cwd: join(home, 'workspace'), dshRoot: runtime, connectivity: false }); await fiber
    const response = await request(PATH, { headers: auth() }); assert.equal(response.status, 200); boot = JSON.parse(response.text); assert.notEqual(boot.epoch, previous)
    const old = await post(payload({ epoch: previous })); assert.equal(old.status, 400); const valid = await post(payload()); assert.equal(valid.status, 200)
    return { unloaded: absent.status, oldEpoch: old.status, remounted: valid.status, sameNodeProcessNotCrossProcessProof: true }
  })
  await check('privacy-output', async () => { const text = JSON.stringify((await panel()).report.frontend); assert(!text.includes('SYNTHETIC_CANARY_VALUE')); for (const secret of secrets) assert(!text.includes(secret)); return { rawErrors: 0, cookies: 0, launchTokens: 0 } })
} catch (error) {
  steps.push({ id: 'fatal', ok: false, error: /^[A-Z_0-9]+$/.test(error.code ?? '') ? error.code : 'ASSERTION_OR_RUNTIME_FAILURE' }); console.error('FAIL host-http'); process.exitCode = 1
} finally {
  for (const mounted of [fiber, ...fibers.reverse()].filter(Boolean)) {
    try { await mounted.dispose() } catch { steps.push({ id: 'dispose', ok: false, error: 'DISPOSE_FAILURE' }); process.exitCode = 1 }
  }
  clearTimeout(watchdog)
  if (origin) {
    try { const response = await request(PATH); report.isolation.listenerClosed = response.status === 0 } catch (error) { report.isolation.listenerClosed = error.code === 'ECONNREFUSED' }
  }
  try { rmSync(home, { recursive: true, force: true }) } catch { steps.push({ id: 'cleanup', ok: false }) }
  report.isolation.homeRemoved = !existsSync(home)
}
report.finishedAt = new Date().toISOString(); report.passed = steps.filter((step) => step.ok).length; report.failed = steps.filter((step) => !step.ok).length
report.ok = report.failed === 0 && report.isolation.homeRemoved && report.isolation.listenerClosed
const text = JSON.stringify(report, null, 2)
for (const secret of secrets) assert(!text.includes(secret), 'receipt must not contain auth material')
mkdirSync(output, { recursive: true }); writeFileSync(join(output, 'report.json'), text + '\n')
console.log(JSON.stringify({ ok: report.ok, passed: report.passed, failed: report.failed, cleanup: report.isolation.homeRemoved && report.isolation.listenerClosed }))
if (!report.ok) process.exitCode = 1
