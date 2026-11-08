#!/usr/bin/env node
/** CI only: exact SDK packages, disposable profile, bounded children, allowlisted receipts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createHook } from 'node:async_hooks'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { tmpdir, platform, arch, release } from 'node:os'
import { fileURLToPath } from 'node:url'
import { inspectPublicRelease, stagePublicRelease } from '../lib/distribution.js'
import { judgeMatrixReport } from './matrix-contract.mjs'
import { PLATFORM_STEP_IDS } from './platform-checks.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CI_FILES = ['.github/workflows/compatibility.yml', 'ci/README.md', 'ci/compatibility.mjs', 'ci/host-http.mjs', 'ci/platform-checks.mjs', 'ci/matrix-contract.mjs']
export const HOSTS = ['0.2.1-rc.2', '0.2.1-rc.4']
export const SDK_PACKAGES = ['@deepseek-ai/dsh', '@deepseek-ai/cordis', '@deepseek-ai/dsh-credentials-local', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-client-connection']
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
const fixedCode = (error) => /^[A-Z_0-9]{1,80}$/.test(error?.code ?? '') ? error.code : 'CHECK_FAILED'

export const NPM_PHASE_IDS = ['idealTree', 'idealTree:buildDeps', 'reify:loadTrees', 'reify:createSparse', 'reify:unpack', 'reify:build', 'build:link', 'reify:save', 'reify', 'packageReify']
const PHASE_FILE = '.doctor-ci-npm-phases.json'
export function readGracefulQueue(readQueue, version) {
  try {
    if ((version ?? process.env.DOCTOR_CI_GRACEFUL_FS_VERSION) !== '4.2.11') return { status: 'unknown' }
    const queue = readQueue ? readQueue() : globalThis[Symbol.for('graceful-fs.queue')]
    if (!Array.isArray(queue) || queue.length > 1000000) return { status: 'unknown' }
    const queuedCount = queue.length, sampledCount = Math.min(queuedCount, 128)
    let emfileCount = 0, enfileCount = 0, unclassifiedCount = 0
    for (let index = 0; index < sampledCount; index++) {
      const entry = queue[index], code = Array.isArray(entry) ? entry[2]?.code : undefined
      if (code === 'EMFILE') emfileCount++
      else if (code === 'ENFILE') enfileCount++
      else unclassifiedCount++
    }
    return { status: 'available', queuedCount, sampledCount, omittedCount: queuedCount - sampledCount, emfileCount, enfileCount, unclassifiedCount }
  } catch { return { status: 'unknown' } }
}

export function observeInstallActivity() {
  const active = new Map()
  let activatedMs, previousMs, previousCpu, previousLoop
  try {
    activatedMs = performance.now(); previousMs = activatedMs
    previousCpu = process.cpuUsage(); previousLoop = performance.eventLoopUtilization()
  } catch { return { snapshot: () => ({ status: 'unknown' }), stop() {} } }
  let fsStarts = 0, fsFinishedTracked = 0, fsPeakTracked = 0, fsDropped = 0, failed = false, hook
  try {
    hook = createHook({
      init(id, type) {
        if (failed || type !== 'FSREQCALLBACK' && type !== 'FSREQPROMISE') return
        try {
          if (++fsStarts > 1000000000) { failed = true; return }
          if (active.size >= 4096) { fsDropped++; return }
          active.set(id, performance.now()); fsPeakTracked = Math.max(fsPeakTracked, active.size)
        } catch { failed = true }
      },
      destroy(id) { try { if (active.delete(id)) fsFinishedTracked++ } catch { failed = true } },
    }).enable()
  } catch { failed = true }
  return {
    snapshot() {
      if (failed) return { status: 'unknown' }
      try {
        const now = performance.now(), cpu = process.cpuUsage(), loop = performance.eventLoopUtilization()
        const value = { status: 'available', sampleElapsedMs: Math.floor(now - activatedMs), sampleWindowMs: Math.floor(now - previousMs),
          cpuUserUs: cpu.user - previousCpu.user, cpuSystemUs: cpu.system - previousCpu.system,
          loopActiveMs: loop.active - previousLoop.active, loopIdleMs: loop.idle - previousLoop.idle, fsStarts, fsFinishedTracked, fsTrackedAlive: active.size,
          fsOldestTrackedAgeMs: active.size ? Math.floor(now - Math.min(...active.values())) : 0, fsPeakTracked, fsDropped }
        assert(Object.entries(value).every(([key, n]) => key === 'status' || Number.isFinite(n) && n >= 0 && n <= 1000000000000))
        previousMs = now; previousCpu = cpu; previousLoop = loop
        return value
      } catch { return { status: 'unknown' } }
    },
    stop() { failed = true; try { hook?.disable() } catch {} active.clear() },
  }
}

export function recordNpmPhases(publish) {
  const start = performance.now(), phases = Object.fromEntries(NPM_PHASE_IDS.map((id) => [id, { started: 0, ended: 0, startMs: null, endMs: null }]))
  const activity = observeInstallActivity()
  let dirty = true, lastPhase = null, lastEvent = null
  const elapsed = () => Math.floor(performance.now() - start)
  const flush = (heartbeat = false) => {
    if (!dirty && !heartbeat) return
    // Observation failures must not change npm's exit status or discard the pending snapshot.
    try {
      publish({ schemaVersion: 3, observerReady: true, elapsedMs: elapsed(), lastPhase, lastEvent, phases: Object.fromEntries(Object.entries(phases).map(([id, row]) => [id, { ...row }])), activity: activity.snapshot(), gracefulFs: readGracefulQueue() })
      dirty = false
    } catch {}
  }
  const onTime = (event, name) => {
    const id = NPM_PHASE_IDS.includes(name) ? name : typeof name === 'string' && name.startsWith('reifyNode:') ? 'packageReify' : null
    if (!id || !['start', 'end'].includes(event)) return
    const row = phases[id], key = event === 'start' ? 'started' : 'ended'
    if (row[key] >= 1000000) return
    row[key]++; row[event === 'start' ? 'startMs' : 'endMs'] = elapsed()
    lastPhase = id; lastEvent = event; dirty = true
    if (id !== 'packageReify') flush()
  }
  const timer = setInterval(() => flush(true), 5000); timer.unref()
  const stop = () => { clearInterval(timer); process.off('time', onTime); process.off('exit', stop); flush(true); activity.stop() }
  process.on('time', onTime); process.once('exit', stop); flush()
  return stop
}
export function readNpmPhases(file) {
  try {
    const info = lstatSync(file)
    assert(info.isFile() && !info.isSymbolicLink() && info.size <= 4096)
    const value = json(file), integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max
    assert.deepEqual(Object.keys(value).sort(), ['schemaVersion', 'observerReady', 'elapsedMs', 'lastPhase', 'lastEvent', 'phases', 'activity', 'gracefulFs'].sort())
    assert(value.schemaVersion === 3 && value.observerReady === true && integer(value.elapsedMs, 1800000))
    assert(value.lastPhase === null ? value.lastEvent === null : NPM_PHASE_IDS.includes(value.lastPhase) && ['start', 'end'].includes(value.lastEvent))
    assert.deepEqual(Object.keys(value.phases).sort(), NPM_PHASE_IDS.slice().sort())
    for (const row of Object.values(value.phases)) {
      assert.deepEqual(Object.keys(row).sort(), ['started', 'ended', 'startMs', 'endMs'].sort())
      assert(integer(row.started, 1000000) && integer(row.ended, 1000000))
      for (const [count, time] of [['started', 'startMs'], ['ended', 'endMs']]) assert(row[count] === 0 ? row[time] === null : integer(row[time], value.elapsedMs))
    }
    const data = value.activity
    assert(data && ['available', 'unknown'].includes(data.status))
    if (data.status === 'unknown') assert.deepEqual(Object.keys(data), ['status'])
    else {
      assert.deepEqual(Object.keys(data).sort(), ['status', 'sampleElapsedMs', 'sampleWindowMs', 'cpuUserUs', 'cpuSystemUs', 'loopActiveMs', 'loopIdleMs', 'fsStarts', 'fsFinishedTracked', 'fsTrackedAlive', 'fsOldestTrackedAgeMs', 'fsPeakTracked', 'fsDropped'].sort())
      for (const key of ['loopActiveMs', 'loopIdleMs']) assert(Number.isFinite(data[key]) && data[key] >= 0 && data[key] <= 1800000)
      for (const key of ['cpuUserUs', 'cpuSystemUs']) assert(integer(data[key], 1000000000000))
      for (const key of ['sampleElapsedMs', 'sampleWindowMs', 'fsOldestTrackedAgeMs']) assert(integer(data[key], 1800000))
      for (const key of ['fsStarts', 'fsFinishedTracked', 'fsTrackedAlive', 'fsPeakTracked', 'fsDropped']) assert(integer(data[key], 1000000000))
      assert(data.sampleWindowMs <= data.sampleElapsedMs)
      assert(data.fsTrackedAlive <= 4096 && data.fsPeakTracked <= 4096 && data.fsPeakTracked >= data.fsTrackedAlive)
      assert(data.fsStarts - data.fsFinishedTracked - data.fsDropped === data.fsTrackedAlive)
      assert(data.fsTrackedAlive !== 0 || data.fsOldestTrackedAgeMs === 0)
    }
    const queued = value.gracefulFs
    assert(queued && ['available', 'unknown'].includes(queued.status))
    if (queued.status === 'unknown') assert.deepEqual(Object.keys(queued), ['status'])
    else {
      assert.deepEqual(Object.keys(queued).sort(), ['status', 'queuedCount', 'sampledCount', 'omittedCount', 'emfileCount', 'enfileCount', 'unclassifiedCount'].sort())
      assert(Object.entries(queued).every(([key, n]) => key === 'status' || integer(n, 1000000)))
      assert(queued.sampledCount === Math.min(queued.queuedCount, 128) && queued.omittedCount === queued.queuedCount - queued.sampledCount)
      assert(queued.emfileCount + queued.enfileCount + queued.unclassifiedCount === queued.sampledCount)
    }
    return { status: 'available', ...value }
  } catch { return { status: 'unknown' } }
}
const expectedNpmCli = process.env.DOCTOR_CI_NPM_CLI, isolatedHome = process.env.HOME
if (process.env.DOCTOR_CI_NPM_PHASES === '1' && expectedNpmCli && /(?:^|[\\/])npm-cli\.js$/.test(expectedNpmCli) && process.argv[1] && resolve(process.argv[1]) === resolve(expectedNpmCli)
  && isolatedHome && isAbsolute(isolatedHome) && process.env.USERPROFILE === isolatedHome && process.env.DSH_HOME === join(isolatedHome, '.dsh')) {
  const target = join(isolatedHome, PHASE_FILE)
  recordNpmPhases((value) => { writeFileSync(target + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(target + '.tmp', target) })
}

export function samePublishedBytes(path, actual, expected) {
  if (path !== 'package.json') return hash(actual) === hash(expected)
  // Observed pnpm normalization removes exactly one final LF; no other byte drift is allowed.
  if (!actual.equals(expected) && !Buffer.concat([actual, Buffer.from('\n')]).equals(expected)) return false
  try { assert.deepEqual(JSON.parse(actual.toString('utf8')), JSON.parse(expected.toString('utf8'))); return true } catch { return false }
}

export function sourceInventory(root = ROOT) {
  const inspected = inspectPublicRelease(root)
  assert.equal(inspected.ok, true, 'distribution gate')
  const files = [...inspected.files, ...CI_FILES].sort()
  assert.equal(new Set(files).size, files.length)
  const entries = files.map((file) => {
    const full = join(root, file)
    assert(lstatSync(full).isFile() && !lstatSync(full).isSymbolicLink())
    return { path: file, sha256: hash(readFileSync(full)) }
  })
  return { files: entries, sha256: hash(entries.map((row) => `${row.path}\0${row.sha256}\n`).join('')) }
}

export function validateWorkerReport(report, exitCode, host) {
  const judged = judgeMatrixReport(report, { exitCode })
  if (judged.status !== 'passed' || report.runtimeInfo.host !== host) return false
  if (report.steps.length !== 42 || !PLATFORM_STEP_IDS.every((id) => report.steps.some((row) => row.id === id))) return false
  return ['cordis', 'dsh-credentials-local', 'dsh-host-webserver', 'dsh-client-connection'].every((name) => report.versions?.[name] === (name === 'cordis' ? '4.0.5' : host))
}

export function childFailure(result, elapsedMs) {
  const stderr = String(result.stderr ?? '')
  const observedCodes = [...stderr.matchAll(/^npm (?:error|ERR!) code ([A-Z][A-Z0-9_]*)\r?$/gm),
    ...stderr.matchAll(/^npm http fetch (?:GET|POST|PUT|DELETE|HEAD) https:\/\/registry\.npmjs\.org\/\S+ attempt [1-9]\d* failed with ([A-Z][A-Z0-9_]*)\r?$/gm)].map((match) => match[1])
  const npmErrorCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EACCES', 'EPERM', 'ENOENT', 'EBUSY', 'ENOSPC', 'ENOTEMPTY', 'ERESOLVE', 'EINTEGRITY', 'ENOTSUP', 'E401', 'E403', 'E404', 'E429', 'E500', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_SOCKET_TIMEOUT']
    .filter((code) => observedCodes.includes(code))
  const registryHttpStatuses = {}
  for (const match of stderr.matchAll(/^npm http fetch (?:GET|POST|PUT|DELETE|HEAD) ([1-5]\d\d) https:\/\/registry\.npmjs\.org\//gm)) registryHttpStatuses[match[1]] = (registryHttpStatuses[match[1]] ?? 0) + 1
  return { elapsedMs, processErrorCode: result.error ? (['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES', 'EPERM'].includes(result.error.code) ? result.error.code : 'UNKNOWN') : null,
    signal: ['SIGTERM', 'SIGKILL', 'SIGABRT'].includes(result.signal) ? result.signal : null, npmErrorCodes, registryHttpStatuses,
    stdoutBytes: Buffer.byteLength(String(result.stdout ?? '')), stderrBytes: Buffer.byteLength(stderr) }
}

function npmCli() {
  const bin = dirname(process.execPath)
  return [join(bin, 'node_modules/npm/bin/npm-cli.js'), join(bin, '../lib/node_modules/npm/bin/npm-cli.js')].find(existsSync)
}

async function main() {
  const option = (name) => { const index = process.argv.indexOf('--' + name); return index < 0 ? undefined : process.argv[index + 1] }
  const host = option('host'), output = option('output')
  assert(HOSTS.includes(host) && output, 'host and output are required')
  const out = resolve(output)
  mkdirSync(out, { recursive: true })
  const sandbox = mkdtempSync(join(realpathSync(tmpdir()), 'doctor-ci-'))
  const home = join(sandbox, 'home'), work = join(sandbox, 'workspace'), receiptDir = join(sandbox, 'receipts')
  for (const dir of [home, work, receiptDir, join(sandbox, 'tmp'), join(sandbox, 'appdata'), join(sandbox, 'config')]) mkdirSync(dir)
  const env = { PATH: dirname(process.execPath), HOME: home, USERPROFILE: home, DSH_HOME: join(home, '.dsh'),
    TEMP: join(sandbox, 'tmp'), TMP: join(sandbox, 'tmp'), TMPDIR: join(sandbox, 'tmp'), APPDATA: join(sandbox, 'appdata'), XDG_CONFIG_HOME: join(sandbox, 'config'),
    NO_COLOR: '1', FORCE_COLOR: '0', ELECTRON_RUN_AS_NODE: '1', NPM_CONFIG_CACHE: join(sandbox, 'npm-cache'), NPM_CONFIG_USERCONFIG: join(sandbox, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(sandbox, 'global-npmrc'), NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_LOGS_MAX: '0' }
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  writeFileSync(env.NPM_CONFIG_USERCONFIG, ''); writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, '')
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), runtime: { platform: platform(), arch: arch(), osRelease: release(), node: process.version, host, packages: {} },
    source: { revision: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null }, steps: [], cleanup: { homeRemoved: false, listenerClosed: false },
    evidenceLimits: ['graph rows are fixtures, not desktop or browser visual proof', 'no model request, real profile, or live repair', 'platform overrides are branch tests; runtime fields identify native OS'] }
  const step = (id, status, exitCode, extra = {}) => report.steps.push({ id, status, exitCode, ...extra })
  const run = (id, args, cwd, timeout = 180000) => {
    const started = Date.now(), npmInstall = id === 'exact-sdk-and-candidate-fixture-install'
    const childEnv = npmInstall ? { ...env, DOCTOR_CI_NPM_PHASES: '1', DOCTOR_CI_NPM_CLI: args[0], DOCTOR_CI_GRACEFUL_FS_VERSION: report.runtime.gracefulFsVersion ?? '' } : env
    const childArgs = npmInstall ? ['--import', import.meta.url, ...args] : args
    const result = spawnSync(process.execPath, childArgs, { cwd, env: childEnv, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 })
    const exitCode = typeof result.status === 'number' ? result.status : -1
    step(id, exitCode === 0 ? 'passed' : 'failed', exitCode, { timedOut: result.error?.code === 'ETIMEDOUT',
      ...(npmInstall ? { npmPhaseEvidence: readNpmPhases(join(home, PHASE_FILE)) } : {}), ...(exitCode === 0 ? {} : { diagnostic: childFailure(result, Date.now() - started) }) })
    assert.equal(exitCode, 0, id)
    return result.stdout
  }
  try {
    const inventory = sourceInventory()
    report.source.sha256 = inventory.sha256
    report.source.files = inventory.files
    report.source.packageVersion = json(join(ROOT, 'package.json')).version
    step('source-distribution-and-hash', 'passed', 0)
    const stage = join(sandbox, 'package')
    assert.equal(stagePublicRelease(ROOT, stage).ok, true)
    const localRuntime = option('runtime-root'), prepared = option('prepared-package')
    let runtime, doctorRoot
    if (localRuntime) {
      assert(prepared, 'local runtime proof needs a separately verified candidate package')
      runtime = resolve(localRuntime); doctorRoot = stage
      report.source.packageSha256 = hash(readFileSync(resolve(prepared)))
      report.source.packageExecution = 'staged-source; supplied tarball hash only, not installation proof'
      report.evidenceLimits.push('local cached-SDK mode does not prove npm installation or an Actions matrix row')
    } else {
      const npm = npmCli()
      assert(npm, 'setup-node npm CLI required')
      report.runtime.npm = json(join(dirname(npm), '../package.json')).version
      try {
        const graceful = json(join(dirname(npm), '../node_modules/graceful-fs/package.json'))
        report.runtime.gracefulFsVersion = graceful.name === 'graceful-fs' && graceful.version === '4.2.11' ? graceful.version : null
      } catch { report.runtime.gracefulFsVersion = null }
      const packed = JSON.parse(run('candidate-pack', [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', sandbox], stage))
      assert.equal(packed.length, 1)
      const packedFiles = packed[0].files.map((row) => row.path).sort()
      assert.deepEqual(packedFiles, inspectPublicRelease(ROOT).files.slice().sort(), 'package inventory matches explicit runtime whitelist')
      const archive = join(sandbox, packed[0].filename)
      report.source.packageSha256 = hash(readFileSync(archive))
      runtime = join(sandbox, 'sdk'); mkdirSync(runtime)
      writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'doctor-ci-sdk', private: true, type: 'module' }))
      const specs = SDK_PACKAGES.map((name) => `${name}@${name === '@deepseek-ai/cordis' ? '4.0.5' : host}`)
      run('exact-sdk-and-candidate-fixture-install', [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=http', '--registry=https://registry.npmjs.org', '--save-exact', ...specs, archive], runtime, 480000)
      doctorRoot = join(runtime, 'node_modules', 'dsh-doctor')
      report.source.packageExecution = 'npm tarball install; exact SDK Host/HTTP'
      for (const row of inspectPublicRelease(ROOT).files) assert.equal(samePublishedBytes(row, readFileSync(join(doctorRoot, row)), readFileSync(join(ROOT, row))), true, 'installed runtime bytes and manifest values match source')
      step('installed-candidate-byte-parity', 'passed', 0)
    }
    for (const name of SDK_PACKAGES) {
      const actual = json(join(runtime, 'node_modules', name, 'package.json')).version
      assert.equal(actual, name === '@deepseek-ai/cordis' ? '4.0.5' : host)
      report.runtime.packages[name] = actual
    }
    step('actual-sdk-version-lock', 'passed', 0)
    run('real-sdk-host-http-and-platform-fixtures', [join(ROOT, 'ci/host-http.mjs'), '--runtime-root', runtime, '--doctor-root', doctorRoot, '--output', receiptDir, '--platform-checks'], work, 120000)
    const worker = json(join(receiptDir, 'report.json'))
    assert.equal(validateWorkerReport(worker, 0, host), true)
    assert.equal(worker.runtimeInfo.platform, report.runtime.platform)
    assert.equal(worker.runtimeInfo.node, report.runtime.node)
    for (const row of worker.steps) step(row.id, row.ok === true ? 'passed' : 'failed', row.ok === true ? 0 : 1)
    report.cleanup.listenerClosed = worker.isolation.listenerClosed === true
    report.runtime.host = worker.runtimeInfo.host
    step('worker-receipt-contract', 'passed', 0)
  } catch (error) {
    step('fatal', 'failed', 1, { code: fixedCode(error) })
  } finally {
    try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { step('cleanup', 'failed', 1) }
    report.cleanup.homeRemoved = !existsSync(sandbox)
  }
  report.finishedAt = new Date().toISOString()
  report.passed = report.steps.filter((row) => row.status === 'passed').length
  report.failed = report.steps.filter((row) => row.status !== 'passed').length
  report.ok = report.failed === 0 && report.cleanup.homeRemoved && report.cleanup.listenerClosed
  const text = JSON.stringify(report, null, 2) + '\n'
  assert(!text.includes(sandbox), 'no temporary absolute path in summary')
  writeFileSync(join(out, 'summary.json'), text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### ${report.runtime.platform} / ${report.runtime.node} / ${host}\n\nstatus=${report.ok ? 'passed' : 'failed'}; passed=${report.passed}; failed=${report.failed}; cleanup=${report.cleanup.homeRemoved && report.cleanup.listenerClosed}\n\nsource-sha256=${report.source.sha256 ?? 'unverified'}; package-sha256=${report.source.packageSha256 ?? 'unverified'}\n`)
  console.log(JSON.stringify({ ok: report.ok, passed: report.passed, failed: report.failed, cleanup: report.cleanup }))
  if (!report.ok) process.exitCode = 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() } catch { console.error('CI_ARGUMENT_OR_RECEIPT_FAILURE'); process.exitCode = 1 }
}
