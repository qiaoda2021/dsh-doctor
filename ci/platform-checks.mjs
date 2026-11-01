/** Portable boundary fixtures only. Native OS evidence comes from the runner, not platform overrides. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { desktopAppDataDir, detectDshRoot, readDshCorePkg, probeTempWritable } from '../lib/probe.js'
import { inspectProfileChannel } from '../lib/installer.js'
import { collectFacts } from '../lib/facts.js'
import { discoverLogSources } from '../lib/logs.js'
import { collectCandidates, planCleanup, applyCleanup, rollbackFrom } from '../lib/repair-secrets.js'
import { prepareBomPlan, prepareProxyPlan, validatePreparedPlan } from '../lib/config-repair.js'
import { executePlan, rollbackExecution } from '../lib/repair-exec.js'
import { probeWorkspaceWritable } from '../lib/workspace-probe.js'

export const PLATFORM_STEP_IDS = ['platform-appdata-mapping', 'platform-macos-app-bundle-root', 'platform-windows-linux-relative-resource-root', 'platform-cli-core-package-root', 'platform-cli-linked-entry-root', 'platform-installer-keeps-config-root-and-gate', 'platform-file-url-encoding-and-archive', 'platform-pnpm-native-command-versus-node-script', 'platform-posix-path-and-command-branch-simulation', 'platform-log-discovery-only-dsh-owned-children', 'platform-temp-and-workspace-write-cleanup', 'platform-proxy-fixture-confirm-backup-rollback', 'platform-bom-fixture-byte-preserving-rollback', 'platform-log-fixture-confirm-recheck-rollback', 'platform-linked-config-target-stays-protected', 'platform-fixture-home-removed']

export async function platformChecks(check) {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'doctor-platform-'))
  const home = join(root, '用户 home'), profileDir = join(home, 'profiles', 'sample')
  const temp = join(root, 'temp'), appData = join(root, 'appdata'), bin = join(root, 'bin')
  const env = { TEMP: temp, TMP: temp, APPDATA: appData, PATH: bin }
  for (const dir of [profileDir, temp, appData, bin]) fs.mkdirSync(dir, { recursive: true })
  const put = (path, value) => { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }
  const manifest = join(profileDir, 'package.json')
  put(manifest, { name: 'sample', private: true, dependencies: {} })
  put(join(profileDir, 'cordis.patch.yml'), '[]\n')
  const options = { home, profileDir, env }
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    await check('platform-appdata-mapping', () => {
      assert.equal(desktopAppDataDir({}, home, 'darwin'), join(root, 'Library', 'Application Support'))
      assert.equal(desktopAppDataDir({}, home, 'linux'), join(root, '.config'))
      assert.equal(desktopAppDataDir({}, home, 'win32'), join(root, 'AppData', 'Roaming'))
      assert.equal(desktopAppDataDir({ XDG_CONFIG_HOME: appData }, home, 'linux'), appData)
      assert.equal(desktopAppDataDir({ XDG_CONFIG_HOME: 'relative' }, home, 'linux'), join(root, '.config'))
      assert.equal(desktopAppDataDir({ APPDATA: appData }, home, 'win32'), appData)
      assert.equal(desktopAppDataDir({}, undefined, 'darwin'), undefined)
    })
    await check('platform-macos-app-bundle-root', () => {
      const runtime = join(root, 'Doctor.app', 'Contents', 'Resources', 'app', 'dsh')
      put(join(runtime, 'package.json'), { name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.1-rc.2' })
      assert.equal(detectDshRoot({}, { execPath: join(root, 'Doctor.app', 'Contents', 'MacOS', 'Doctor'), entryFile: '' }).root, runtime)
      assert.equal(detectDshRoot({ DSH_APP_ROOT: appData }, { execPath: join(root, 'missing', 'node'), entryFile: '' }).root, undefined)
    })
    await check('platform-windows-linux-relative-resource-root', () => {
      const runtime = join(bin, 'resources', 'app', 'dsh')
      put(join(runtime, 'package.json'), { name: 'dsh', version: '0.2.1-rc.4' })
      assert.equal(detectDshRoot({}, { execPath: join(bin, 'node'), entryFile: '' }).root, runtime)
      assert.equal(detectDshRoot({ DSH_INSTALL_DIR: runtime }, { execPath: '', entryFile: '' }).root, runtime)
    })
    const cli = join(root, 'cli')
    put(join(cli, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.2.1-rc.4' })
    put(join(cli, 'lib', 'bin.js'), '// fixture\n')
    await check('platform-cli-core-package-root', () => {
      assert.equal(detectDshRoot({}, { execPath: '', entryFile: join(cli, 'lib', 'bin.js') }).root, cli)
      assert.equal(readDshCorePkg(cli).version, '0.2.1-rc.4')
    })
    await check('platform-cli-linked-entry-root', () => {
      const entry = join(root, 'linked-entry')
      fs.symlinkSync(join(cli, 'lib', 'bin.js'), entry, 'file')
      assert.equal(detectDshRoot({}, { execPath: '', entryFile: entry }).root, cli)
    })
    await check('platform-installer-keeps-config-root-and-gate', async () => {
      put(join(profileDir, 'node_modules', 'gated', 'package.json'), { name: 'gated', version: '1.0.0', engines: { dsh: '>=9.0.0' } })
      put(manifest, { dependencies: { gated: '1.0.0' } })
      const channel = await inspectProfileChannel({ ...options, dshRoot: cli })
      assert.equal(channel.dsh.version, '0.2.1-rc.4')
      assert(channel.findings.some((row) => row.id === 'DSH-INST-008'))
      const facts = await collectFacts({ ...options, cwd: root, dshRoot: cli, connectivity: false })
      assert.equal(facts.installer.channel.dsh.version, '0.2.1-rc.4')
      put(manifest, { dependencies: {} })
    })
    await check('platform-file-url-encoding-and-archive', async () => {
      const folder = join(root, '含 空格 # %'), archive = join(root, '包 # %.tgz')
      fs.mkdirSync(folder); put(archive, 'fixture, not an installed package')
      put(manifest, { dependencies: { folder: pathToFileURL(folder).href, archive: pathToFileURL(archive).href, bad: 'file:///%ZZ' } })
      const result = await inspectProfileChannel(options)
      assert.equal(result.localDeps.find((row) => row.name === 'folder').targetPath, folder)
      assert.equal(result.localDeps.find((row) => row.name === 'folder').exists, true)
      assert.equal(result.localDeps.find((row) => row.name === 'archive').expectedKind, 'file')
      assert.equal(result.localDeps.find((row) => row.name === 'archive').exists, true)
      assert.equal(result.localDeps.find((row) => row.name === 'bad').exists, false)
      put(manifest, { dependencies: {} })
    })
    await check('platform-pnpm-native-command-versus-node-script', async () => {
      const wrapper = join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
      const script = join(root, 'pnpm.mjs')
      put(wrapper, '#!/bin/sh\nexit 0\n'); put(script, '// read-only fixture\n')
      fs.chmodSync(wrapper, 0o755); fs.chmodSync(script, 0o644)
      const result = await inspectProfileChannel({ ...options, packageManager: { command: process.execPath, args: [script] } })
      assert.equal(result.manager.usable, true)
      assert.equal(result.manager.managedFilesPresent, true)
      if (process.platform !== 'win32') {
        fs.chmodSync(wrapper, 0o644)
        assert.equal((await inspectProfileChannel(options)).manager.usable, false)
        assert.equal((await inspectProfileChannel({ ...options, packageManager: { command: script, args: [] } })).manager.managedFilesPresent, false)
      } else {
        assert(result.manager.pnpmPath.endsWith('.cmd'))
      }
      assert.equal((await inspectProfileChannel({ ...options, packageManager: { command: process.execPath, args: [join(root, 'missing.mjs')] } })).manager.managedFilesPresent, false)
    })
    await check('platform-posix-path-and-command-branch-simulation', async () => {
      const command = join(bin, 'pnpm'); put(command, '#!/bin/sh\nexit 0\n'); fs.chmodSync(command, 0o755)
      const cwd = process.cwd()
      try {
        process.chdir(root)
        for (const os of ['darwin', 'linux']) {
          Object.defineProperty(process, 'platform', { ...originalPlatform, value: os })
          const channel = await inspectProfileChannel({ ...options, env: { ...env, PATH: 'bin:missing' } })
          assert.equal(channel.manager.pnpmPath, join('bin', 'pnpm'))
          assert.equal(channel.manager.searchedDirs, 2)
        }
      } finally { process.chdir(cwd); Object.defineProperty(process, 'platform', originalPlatform) }
    })
    await check('platform-log-discovery-only-dsh-owned-children', () => {
      const reads = [], readdir = fs.readdirSync
      try {
        fs.readdirSync = (path, ...args) => { reads.push(String(path)); return readdir(path, ...args) }
        syncBuiltinESMExports()
        for (const os of ['win32', 'darwin', 'linux']) {
          Object.defineProperty(process, 'platform', { ...originalPlatform, value: os })
          const base = desktopAppDataDir({ XDG_CONFIG_HOME: appData }, home, os)
          const own = join(base, '@deepseek-ai', 'dsh-desktop', 'logs', 'crash-fixture.log')
          const unrelated = join(base, 'unrelated-app', 'logs', 'crash-unrelated.log')
          put(own, 'fixture\n'); put(unrelated, 'must not be scanned\n')
          const sources = discoverLogSources({ home, env: { TEMP: temp, XDG_CONFIG_HOME: appData }, kinds: ['crash'] })
          assert(sources.some((row) => row.path === own))
          assert(!sources.some((row) => row.path === unrelated))
          assert(!reads.includes(base)); assert(!reads.includes(dirname(unrelated)))
          const candidates = collectCandidates({ home, env: { TEMP: temp, XDG_CONFIG_HOME: appData }, kinds: ['crash'] })
          assert(!candidates.sources.some((row) => row.path === unrelated))
        }
      } finally { fs.readdirSync = readdir; syncBuiltinESMExports(); Object.defineProperty(process, 'platform', originalPlatform) }
    })
    await check('platform-temp-and-workspace-write-cleanup', () => {
      const before = fs.readdirSync(temp)
      assert.equal(probeTempWritable(temp), true)
      assert.equal(probeTempWritable(join(temp, 'missing')), false)
      assert.equal(probeWorkspaceWritable(temp, { writeProbe: true }).writable, true)
      assert.deepEqual(fs.readdirSync(temp), before)
    })
    await check('platform-proxy-fixture-confirm-backup-rollback', async () => {
      const target = join(home, '.env'), before = 'NO_PROXY=localhost\nOTHER=kept\n'
      put(target, before)
      const plan = await prepareProxyPlan({ ...options, proxyUrl: 'http://127.0.0.1:17890' })
      assert.equal((await validatePreparedPlan(plan, options)).ok, true)
      assert.notEqual((await executePlan(plan, { home, confirmToken: 'wrong' })).status, 'applied')
      const record = await executePlan(plan, { home, confirmToken: plan.id })
      assert.equal(record.status, 'applied'); assert.equal(record.verification.status, 'pass')
      assert(fs.readFileSync(target, 'utf8').includes('NO_PROXY=localhost'))
      assert.equal((await rollbackExecution(record, { home })).performed, true)
      assert.equal(fs.readFileSync(target, 'utf8'), before)
    })
    await check('platform-bom-fixture-byte-preserving-rollback', async () => {
      const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"private":true}\n')])
      fs.writeFileSync(manifest, before)
      const plan = await prepareBomPlan({ ...options, target: 'package.json' })
      const record = await executePlan(plan, { home, confirmToken: plan.id })
      assert.equal(record.status, 'applied'); assert.deepEqual(fs.readFileSync(manifest), before.subarray(3))
      assert.equal((await rollbackExecution(record, { home })).performed, true)
      assert.deepEqual(fs.readFileSync(manifest), before)
    })
    await check('platform-log-fixture-confirm-recheck-rollback', async () => {
      const file = join(home, 'dsh-im-connect', 'gateway.log')
      const before = `Authorization: Bearer ${'Ab3Cd'.repeat(8)}\n`
      put(file, before)
      const scoped = { ...options, kinds: ['gateway'] }
      assert.equal((await planCleanup(options)).coverage.complete, false, 'external crash logs remain outside repair roots')
      const plan = await planCleanup(scoped)
      assert.equal((await applyCleanup(plan, scoped)).reason, 'unconfirmed')
      const applied = await applyCleanup(plan, { ...scoped, confirm: true })
      assert.equal(applied.applied, true); assert.equal(applied.verification.complete, true)
      assert.equal(applied.verification.remaining, 0)
      assert.equal((await rollbackFrom(applied.backupRoot, options)).restored, 1)
      assert.equal(fs.readFileSync(file, 'utf8'), before)
    })
    await check('platform-linked-config-target-stays-protected', async () => {
      const other = join(root, 'other.json'), link = join(profileDir, 'cordis.patch.yml')
      put(other, '\ufeff{}'); fs.unlinkSync(link); fs.symlinkSync(other, link, 'file')
      await assert.rejects(prepareBomPlan({ ...options, target: 'cordis.patch.yml' }))
      assert.equal(fs.readFileSync(other, 'utf8'), '\ufeff{}')
    })
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform)
    fs.rmSync(root, { recursive: true, force: true })
    await check('platform-fixture-home-removed', () => assert.equal(fs.existsSync(root), false))
  }
}
