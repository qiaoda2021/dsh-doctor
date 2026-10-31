/**
 * DSH Doctor — 安装故障诊断（install 通道）。
 *
 * 为什么单独一个文件：安装期的失败和运行期的失败不是一类东西。
 * profile 的 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 三者一致，
 * 插件才装得上；不一致时 pnpm 的报错只说「哪个包解析不到」，不说「是谁把清单改坏的」。
 * 这里把本机真实踩过的五类故障收成只读探针：
 *
 *   1. manifest 带 UTF-8 BOM          → 加载器 SyntaxError: Unexpected token '\uFEFF'
 *   2. manifest 声明版本 ≠ lockfile 锁  → ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY，所有插件都装不上
 *   3. 本地 file: 依赖目录被删、清单还写着 → 安装期 404 / tarball 不存在
 *   4. minimumReleaseAge 挡住新发版本    → 表现为「pnpm 解析不到版本」
 *   5. 装成功但没声明 dsh.compatibility.dsh → 启用阶段失败
 *
 * 三条纪律（和 lib/probe.js 同源）：
 *   - 只读：不执行 pnpm、不写 profile、不联网；
 *   - 异常吞掉：读不到 / 解析失败都变成一个 finding，绝不抛给调用方；
 *   - 零本地依赖：只 import `node:` 内置模块。这样 `scripts/install-doctor.mjs`
 *     在 DSH 完全起不来、插件管理器已经坏掉的时候照跑（恢复入口不能依赖被恢复的东西）。
 *
 * finding 编号固定为 `DSH-INST-001` …（见 FINDING_CATALOG），父层 rules.js 可以直接
 * 把它们映射成诊断结论；编号一旦发布不再改含义。
 */
import { readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

/** 探针自身版本：报告里要能区分「哪份安装结论是哪个版本出的」。 */
export const INSTALLER_VERSION = '1.0.0'

/** pnpm / Node 安装期错误的归类表。key 就是 `classifyInstallerFailure` 返回的 code。 */
export const PNPM_ERROR_CODES = {
  MANIFEST_BOM: {
    phase: 'manifest',
    severity: 'fail',
    zh: 'profile/package.json 带 UTF-8 BOM，严格 JSON 加载器会抛 SyntaxError: Unexpected token \'﻿\'',
    nextSteps: [
      '把 package.json 重写成 UTF-8 无 BOM（PowerShell 不要用 Set-Content -Encoding utf8）',
      '改完先 node --check 不了就手工 json.parse 一次：node -e "JSON.parse(require(\'fs\').readFileSync(\'package.json\',\'utf8\'))"',
    ],
  },
  MANIFEST_JSON: {
    phase: 'manifest',
    severity: 'fail',
    zh: 'profile/package.json 不是合法 JSON（SyntaxError: Unexpected token … is not valid JSON）',
    nextSteps: [
      '用 JSON.parse 逐段定位：先看报错里的 position 附近是不是多了逗号或少了引号',
      '从备份恢复清单，只保留 name / private / dependencies / dsh.profile.bundles 四个键',
    ],
  },
  ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY: {
    phase: 'resolution',
    severity: 'fail',
    zh: 'lockfile 与清单不一致：manifest 声明的版本在 pnpm-lock.yaml 里没有条目（Broken lockfile）',
    nextSteps: [
      '运行 pnpm install 让 lockfile 与 manifest 对齐，或把 manifest 降到 lockfile 里已锁定的版本',
      '对齐后确认三处版本一致：package.json、pnpm-lock.yaml 的 specifier、pnpm-lock.yaml 的 version',
    ],
  },
  ERR_PNPM_OUTDATED_LOCKFILE: {
    phase: 'resolution',
    severity: 'fail',
    zh: 'lockfile 与清单不同步，--frozen-lockfile 下 pnpm 直接拒绝安装',
    nextSteps: [
      '去掉 --frozen-lockfile 跑一次 pnpm install，把新的 lockfile 提交进 profile',
      '排查是谁在改 package.json 却没重跑安装（插件管理器的 write 与 install 不是原子操作）',
    ],
  },
  ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND: {
    phase: 'resolution',
    severity: 'fail',
    zh: '本地 file:/link: 依赖指向的目录不存在（manifest 还写着，盘上已经没了）',
    nextSteps: [
      '把被删的目录放回原位，或从 package.json 删掉这条 file: 依赖后重新安装',
      '只删 node_modules 里的副本没用，pnpm 读的是 manifest 里的路径',
    ],
  },
  ERR_PNPM_NO_MATCHING_VERSION: {
    phase: 'resolution',
    severity: 'fail',
    zh: 'registry 里没有匹配的版本：可能是版本号写错、registry 镜像没同步，或被 minimumReleaseAge 策略挡住',
    nextSteps: [
      '先确认 registry：pnpm config get registry，并核对该版本是否已发布（npm view <pkg> versions）',
      '新发版本被发布年龄策略挡住时，把它加进 pnpm-workspace.yaml 的 minimumReleaseAgeExclude，或临时移除 minimumReleaseAge',
      '镜像源没同步时换源重试：pnpm install --registry=https://registry.npmjs.org/',
    ],
  },
  ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER: {
    phase: 'resolution',
    severity: 'fail',
    zh: 'spec 无法被任何 resolver 解析（file:/link:/git/workspace: 路径或协议写错了）',
    nextSteps: ['检查该依赖的 spec 前缀与路径是否真实存在', 'file: 依赖用正斜杠或绝对路径，别写反斜杠转义'],
  },
  ERR_PNPM_FETCH_404: {
    phase: 'download',
    severity: 'fail',
    zh: 'tarball 拉取 404：registry 上没有这个包或这个版本（私有包还需要 .npmrc 里的 registry 与 token）',
    nextSteps: [
      '确认包名与版本在目标 registry 上真实存在（npm view <pkg>@<version> dist.tarball）',
      '私有 scope 检查 .npmrc：@scope:registry 指向了哪个源，凭据是否过期',
    ],
  },
  ERR_PNPM_TARBALL_INTEGRITY: {
    phase: 'download',
    severity: 'fail',
    zh: 'tarball 完整性校验失败：下载被截断、代理改写了响应，或镜像与 lockfile 的 integrity 不一致',
    nextSteps: [
      '清掉缓存重下：pnpm store prune 后重新 pnpm install',
      '怀疑镜像时换官方源重试一次，再决定要不要改锁文件里的 integrity',
    ],
  },
  EINTEGRITY: {
    phase: 'download',
    severity: 'fail',
    zh: 'integrity 校验失败（EINTEGRITY）：缓存或镜像里的文件与 lockfile 记录不符',
    nextSteps: ['先 pnpm store prune，再 pnpm install --force 重建缓存条目', '仍然失败就把该包从 lockfile 移除重新解析'],
  },
  ERR_PNPM_PEER_DEP_ISSUES: {
    phase: 'policy',
    severity: 'fail',
    zh: 'peer 依赖不满足（ERR_PNPM_PEER_DEP_ISSUES）：插件之间要求的宿主包版本互相冲突',
    nextSteps: [
      '看报错里 unmet peer 的宿主包名，把冲突的一方降到兼容版本',
      'profile 里通常已关掉 autoInstallPeers；不要为了消警告打开它，会引入重复实例',
    ],
  },
  ERR_PNPM_UNSUPPORTED_ENGINE: {
    phase: 'policy',
    severity: 'fail',
    zh: '包声明的 engines 不满足当前 Node 版本（插件自带更严的 engines 约束时常见）',
    nextSteps: ['确认运行时 Node 版本满足插件的 engines.node', '必要时用插件的旧版本，或换满足条件的运行时'],
  },
  EBUSY: {
    phase: 'link',
    severity: 'warn',
    zh: 'Windows 文件被占用（EBUSY）：通常是宿主进程还开着旧版本文件，pnpm 改名/删除失败',
    nextSteps: ['完全退出 DSH（含托盘与残留进程）后重试安装', '装完再启动，别在运行中升级插件'],
  },
  EPERM: {
    phase: 'link',
    severity: 'warn',
    zh: '权限不足或被占用（EPERM）：pnpm 无法创建/改名目录',
    nextSteps: ['确认 profile 目录不在受保护位置，且当前用户对其有写权限', '关闭杀软实时扫描或占用 node_modules 的编辑器后重试'],
  },
  EEXIST: {
    phase: 'link',
    severity: 'warn',
    zh: '目标已存在（EEXIST）：上一次安装留下的半成品挡住了本次链接',
    nextSteps: ['删掉报错路径里的 node_modules/.pnpm 残留目录后重试', '确认没有两个 profile 指向同一 node_modules'],
  },
  ENOSPC: {
    phase: 'link',
    severity: 'warn',
    zh: '磁盘空间不足（ENOSPC）：pnpm 解包或写 store 时写满',
    nextSteps: ['清理磁盘后重试；pnpm store prune 可以回收未引用的包', '确认临时目录与 profile 在同一卷，避免跨盘硬链接变复制'],
  },
  ENOTEMPTY: {
    phase: 'link',
    severity: 'warn',
    zh: '目录非空删不掉（ENOTEMPTY）：Windows 上常见于半删的 node_modules',
    nextSteps: ['退出宿主后手工删掉该目录，再重新安装'],
  },
  ETIMEDOUT: {
    phase: 'network',
    severity: 'warn',
    zh: '网络超时（ETIMEDOUT）：registry 不可达或被代理拦住',
    nextSteps: ['确认代理与 registry 可达：pnpm config get proxy / https-proxy', '换官方源或直连重试一次，排除一次性抖动'],
  },
  ECONNRESET: {
    phase: 'network',
    severity: 'warn',
    zh: '连接被重置（ECONNRESET）：代理、TLS 中间设备或镜像不稳定',
    nextSteps: ['重试一次确认是否偶发；偶发就不用动配置', '持续失败时换源，并检查 http_proxy / https_proxy 是否指到了失效端口'],
  },
  ERR_SOCKET_TIMEOUT: {
    phase: 'network',
    severity: 'warn',
    zh: 'socket 超时（ERR_SOCKET_TIMEOUT）：下载迟迟没有数据，常见于大包 + 慢镜像',
    nextSteps: ['提高 fetch 超时后重试：pnpm install --fetch-timeout 120000', '换更近的镜像源'],
  },
  UNKNOWN_FAILURE: {
    phase: 'unknown',
    severity: 'unknown',
    zh: '认不出的安装失败：没有命中任何已知错误码，需要人工看一眼原文',
    nextSteps: [
      '把完整 stderr 存成文件（不要只截最后一行）',
      '运行 node scripts/install-doctor.mjs --profile <name> 检查 manifest / lockfile / 本地依赖 / workspace 策略',
      '再用 --log <stderr 文件> 让诊断器给出归类',
    ],
  },
}

/** finding 编号表：含义固定，父层 rules.js 与 README 表格都从这里取。 */
export const FINDING_CATALOG = [
  { id: 'DSH-INST-000', meaning: '安装探针自身异常（读目录/解析时抛错），结论不可信', severity: 'fail' },
  { id: 'DSH-INST-001', meaning: 'profile/package.json 带 UTF-8 BOM，严格 JSON 加载器会直接失败', severity: 'fail' },
  { id: 'DSH-INST-002', meaning: 'pnpm-lock.yaml 与 manifest 不一致（版本漂移 / 清单依赖不在锁里 / 无本 profile 的 importer）', severity: 'fail' },
  { id: 'DSH-INST-003', meaning: '本地 file:/link: 依赖指向的路径不存在或类型不对（file: 目录或 .tgz/.tar.gz/.tar 文件，link: 目录）', severity: 'fail' },
  { id: 'DSH-INST-004', meaning: 'pnpm minimumReleaseAge 发布年龄策略会挡住新版本（或只配了白名单没启用）', severity: 'warn' },
  { id: 'DSH-INST-005', meaning: 'pnpm-lock.yaml 缺失：每次安装都要重新解析全部依赖', severity: 'warn' },
  { id: 'DSH-INST-006', meaning: '插件安装通道与命令行 pnpm', severity: 'warn' },
  { id: 'DSH-INST-007', meaning: 'lockfile 里 file: 依赖的 specifier 与 manifest 不一致（目录被搬动 / 路径编码损坏）', severity: 'warn' },
  { id: 'DSH-INST-008', meaning: '已安装插件不满足当前 DSH 的加载期兼容要求（engines.dsh 或 @deepseek-ai/dsh* peer）；只有拿到精确版本豁免时才降级为 warn', severity: 'fail' },
  { id: 'DSH-INST-009', meaning: 'profile/package.json 不存在或不是合法 JSON', severity: 'fail' },
  { id: 'DSH-INST-010', meaning: 'lockfile 里有 manifest 未声明的依赖（孤儿条目）', severity: 'info' },
  { id: 'DSH-INST-011', meaning: 'profile 目录不存在（--profile 写错，或 profile 还没初始化）', severity: 'fail' },
  { id: 'DSH-INST-012', meaning: 'dsh.compatibility 元数据没覆盖当前 DSH（宿主加载期不读它，只影响市场/注册表展示）', severity: 'info' },
]

const SEVERITY_RANK = { fail: 0, warn: 1, info: 2 }
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/* ------------------------------ 读文件原语 ------------------------------ */

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readBuffer(file) {
  try {
    return readFileSync(file)
  } catch {
    return undefined
  }
}

/** 宽容读 JSON：去掉 BOM 再 parse，同时把「有没有 BOM」这件事留给调用方判定。 */
function readManifest(file) {
  const out = {
    path: file,
    exists: false,
    parses: false,
    bom: false,
    dependencyCount: 0,
    bytes: 0,
    value: undefined,
    error: undefined,
  }
  const buf = readBuffer(file)
  if (!buf) {
    out.error = '文件不存在或不可读'
    return out
  }
  out.exists = true
  out.bytes = buf.length
  out.bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  try {
    out.value = JSON.parse(stripBom(buf.toString('utf8')))
    out.parses = true
    out.dependencyCount = Object.keys(out.value?.dependencies ?? {}).length
  } catch (error) {
    out.error = String(error?.message ?? error)
  }
  return out
}

function readJsonTolerant(file) {
  const buf = readBuffer(file)
  if (!buf) return undefined
  try {
    return JSON.parse(stripBom(buf.toString('utf8')))
  } catch {
    return undefined
  }
}

/* ------------------------------ lockfile ------------------------------ */

/**
 * 解析 pnpm-lock.yaml 里「本 profile 的 importer」那一段。
 *
 * 为什么自己写一个小状态机而不是正则抠全篇：真正的锁文件里同名包会出现三次
 * （importers 的 specifier、packages 的 resolution、snapshots），正则必然把
 * snapshots 里的版本当成 importer 的版本，于是漂移判错。这里只走 importer 的
 * 缩进层级（importer 键 +2 是 dependencies，+4 是包名，+6 是 specifier/version），
 * 出界就停，宁可少判也不误判。
 */
function parseLockImporter(text) {
  const out = {
    importerFound: false,
    importerKey: undefined,
    dependencies: {},
    sections: [],
    parseError: undefined,
  }
  const lines = String(text ?? '').split(/\r?\n/)
  const head = lines.findIndex((line) => /^importers:\s*$/.test(line))
  if (head < 0) {
    out.parseError = '没有 importers: 段'
    return out
  }
  let importerIndent = -1
  let start = -1
  for (let i = head + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    if (/^\S/.test(line)) break // 离开 importers 段
    const m = /^(\s+)([^#\s][^:]*):\s*(?:\{\}\s*)?(?:#.*)?$/.exec(line)
    if (!m) continue
    importerIndent = m[1].length
    out.importerKey = m[2].trim()
    out.importerFound = true
    start = i
    break
  }
  if (!out.importerFound) {
    out.parseError = 'importers: 下没有 importer 条目'
    return out
  }
  const depIndent = importerIndent + 2
  const nameIndent = importerIndent + 4
  const fieldIndent = importerIndent + 6
  let section
  let currentDep
  for (let i = start + 1; i < lines.length; i += 1) {
    const raw = lines[i]
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const indent = raw.length - raw.trimStart().length
    if (indent <= importerIndent) break
    const m = /^(\s+)([^:#][^:]*):\s*(.*)$/.exec(raw)
    if (!m) continue
    const key = m[2].trim().replace(/^['"]|['"]$/g, '')
    const value = m[3].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
    if (indent === depIndent && !value) {
      section = key
      if (!out.sections.includes(key)) out.sections.push(key)
      currentDep = undefined
      continue
    }
    if (!section) continue
    if (indent === nameIndent && !value) {
      currentDep = key
      out.dependencies[key] ??= {}
      continue
    }
    if (indent === fieldIndent && currentDep && value) {
      out.dependencies[currentDep][key] = value
    }
  }
  return out
}

function baseVersion(version) {
  // pnpm 会把 peer 解析结果挂在版本后面：1.9.24(@deepseek-ai/dsh-home-paths@0.2.1-rc.2)
  return String(version ?? '').replace(/\(.*$/, '').trim()
}

function normalizeSpecPath(spec) {
  return String(spec ?? '')
    .replace(/^(file|link):/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/* ---------------------------- 本地 file: 依赖 ---------------------------- */

function resolveLocalTarget(spec, dir) {
  let raw = String(spec ?? '').replace(/^(file|link):/i, '')
  if (/^\/\//.test(raw)) raw = raw.replace(/^\/+/, '')
  if (!raw) return undefined
  const slashed = raw.replace(/\\/g, '/')
  return isAbsolute(slashed) ? resolve(slashed) : resolve(dir, slashed)
}

/**
 * pnpm 的 file: 解析只看后缀（@pnpm/local-resolver）：.tgz / .tar.gz / .tar → tarball 文件，
 * 其余一律当目录；link: 永远按目录建软链，哪怕名字长得像归档。
 * 这里只做 stat 类型判定：不解归档、不跑 pnpm、不看文件内容。
 */
const TARBALL_EXTENSION = /\.(?:tgz|tar\.gz|tar)$/i

function classifyLocalTarget(spec, dir) {
  const raw = String(spec ?? '')
  const protocol = /^link:/i.test(raw) ? 'link' : 'file'
  const pathPart = raw.replace(/[\\/]+$/, '')
  const expectedKind = protocol === 'link' || !TARBALL_EXTENSION.test(pathPart) ? 'directory' : 'file'
  const targetPath = resolveLocalTarget(raw, dir) ?? ''
  const targetKind = isDirectory(targetPath) ? 'directory' : isFile(targetPath) ? 'file' : 'missing'
  return { protocol, targetPath, expectedKind, targetKind, exists: targetKind === expectedKind }
}

/** 一条 file:/link: 依赖的判定结果；exists 表示「存在且类型也对得上」。 */
function localDepEntry(name, spec, dir) {
  const { protocol, targetPath, expectedKind, targetKind, exists } = classifyLocalTarget(spec, dir)
  return { name, spec: String(spec), protocol, targetPath, expectedKind, targetKind, exists }
}

/* ------------------------------ workspace ------------------------------ */

function parseWorkspacePolicy(file) {
  const out = { path: file, exists: false, minimumReleaseAge: undefined, excludedCount: 0, excludeList: [] }
  const buf = readBuffer(file)
  if (!buf) return out
  out.exists = true
  const text = stripBom(buf.toString('utf8'))
  let inExclude = false
  let excludeIndent = -1
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const indent = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(trimmed)
    if (m) {
      const key = m[1]
      const value = m[2].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
      inExclude = key === 'minimumReleaseAgeExclude'
      excludeIndent = inExclude ? indent : -1
      if (key === 'minimumReleaseAge' && indent === 0 && value) out.minimumReleaseAge = value
      continue
    }
    if (inExclude && indent > excludeIndent && /^-\s+/.test(trimmed)) {
      const entry = trimmed.replace(/^-\s+/, '').trim()
      out.excludedCount += 1
      out.excludeList.push(entry)
    }
  }
  return out
}

/** 白名单里是否覆盖了 name@version（支持 `1.0.1 || 1.0.2`、`^1.2.3`、通配）。 */
function excludeCovers(list, name, version) {
  if (!version) return false
  for (const raw of list) {
    const entry = String(raw).replace(/^['"]|['"]$/g, '').trim()
    let ranges
    if (entry.startsWith(`${name}@`)) ranges = entry.slice(name.length + 1)
    else if (entry === name) ranges = '*'
    else continue
    for (const part of ranges.split('||').map((s) => s.trim())) {
      if (!part) continue
      if (part === '*' || part === version) return true
      if (satisfiesRange(version, part) === true) return true
    }
  }
  return false
}

/* -------------------------------- semver -------------------------------- */

/**
 * 极简 semver 区间判断（与 lib/probe.js 同算法，但在这里重写一份）。
 * 为什么不 import probe.js：本文件是「插件管理器坏了也能跑」的恢复探针，
 * 少一条 import 就少一条可能在故障机器上抛错的路。
 * 无法解析时返回 undefined（不敢判断），绝不猜 false —— 猜 false 会把健康机器报成故障。
 */
function satisfiesRange(version, range) {
  const v = versionTuple(version)
  if (!v) return undefined
  const groups = String(range).split('||').map((g) => g.trim()).filter(Boolean)
  if (groups.length === 0) return undefined
  let sawUndecidable = false
  for (const group of groups) {
    const verdict = satisfiesGroup(v, group)
    if (verdict === true) return true
    if (verdict === undefined) sawUndecidable = true
  }
  return sawUndecidable ? undefined : false
}

function versionTuple(version) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

function compareTuple(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

function satisfiesGroup(v, group) {
  const clauses = group.split(/\s+/).filter(Boolean)
  let judged = false
  for (const clause of clauses) {
    const m = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(clause)
    if (!m) continue
    judged = true
    const op = m[1] || '='
    const t = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)]
    const c = compareTuple(v, t)
    let ok
    if (op === '>=') ok = c >= 0
    else if (op === '>') ok = c > 0
    else if (op === '<=') ok = c <= 0
    else if (op === '<') ok = c < 0
    else if (op === '^') {
      // 真正的 caret 语义：^1.2.3 → 同 major；^0.2.3 → 同 major.minor；^0.0.3 → 只认这一个 patch
      ok =
        v[0] === t[0] &&
        c >= 0 &&
        (t[0] > 0 ? true : t[1] > 0 ? v[1] === t[1] : v[1] === t[1] && v[2] === t[2])
    }
    else if (op === '~') ok = v[0] === t[0] && v[1] === t[1] && c >= 0
    else ok = c === 0
    if (!ok) return false
  }
  return judged ? true : undefined
}

/* ------------------------------- pnpm 查找 ------------------------------- */

function pathDirs(env) {
  const raw = env.PATH ?? env.Path ?? env.path ?? ''
  const sep = process.platform === 'win32' ? ';' : ':'
  return String(raw).split(sep).map((dir) => dir.trim()).filter(Boolean)
}

/** 只在 PATH 里找，绝不执行任何东西（执行 pnpm 会改磁盘，这个探针必须只读）。 */
function findPnpm(env) {
  const dirs = pathDirs(env)
  const exts = process.platform === 'win32'
    ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean)
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `pnpm${ext.toLowerCase()}`)
      if (isFile(candidate)) return { path: candidate, searchedDirs: dirs.length }
      const upper = join(dir, `pnpm${ext}`)
      if (upper !== candidate && isFile(upper)) return { path: upper, searchedDirs: dirs.length }
    }
  }
  return { path: null, searchedDirs: dirs.length }
}

/** Inspect launcher-provided files only; never execute commands or retain its environment. */
function managedPnpmFiles(invocation) {
  if (!invocation || typeof invocation.command !== 'string' || !invocation.command
      || !Array.isArray(invocation.args) || invocation.args.some((arg) => typeof arg !== 'string')) {
    return { managedConfigured: false, managedFilesPresent: undefined }
  }
  const scripts = invocation.args.filter((arg) => !arg.startsWith('-') && /\.(?:mjs|cjs|js)$/i.test(arg))
  if (!isAbsolute(invocation.command) || scripts.some((file) => !isAbsolute(file))) {
    return { managedConfigured: true, managedFilesPresent: undefined }
  }
  return { managedConfigured: true, managedFilesPresent: [invocation.command, ...scripts].every(isFile) }
}

/* ------------------------------- DSH 版本 ------------------------------- */

function readVersionAt(dir) {
  const core = readJsonTolerant(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  if (core?.version) return { version: core.version, source: 'node_modules/@deepseek-ai/dsh' }
  const root = readJsonTolerant(join(dir, 'package.json'))
  if (root && (root.name === 'dsh' || root.name === '@deepseek-ai/dsh-desktop-runtime') && root.version) {
    return { version: root.version, source: 'package.json' }
  }
  return undefined
}

/** 找当前 DSH 版本（兼容性判定要用）。找不到就返回 undefined，不猜。 */
function detectDshInstall(env) {
  const candidates = []
  if (env.DSH_APP_ROOT) candidates.push([env.DSH_APP_ROOT, 'env DSH_APP_ROOT'])
  if (env.DSH_INSTALL_DIR) candidates.push([env.DSH_INSTALL_DIR, 'env DSH_INSTALL_DIR'])
  if (env.DSH_DESKTOP_NODE_EXECUTABLE) {
    candidates.push([dirname(dirname(env.DSH_DESKTOP_NODE_EXECUTABLE)), 'env DSH_DESKTOP_NODE_EXECUTABLE'])
  }
  const exeDir = dirname(process.execPath || '')
  if (exeDir) {
    candidates.push([join(exeDir, 'resources', 'app', 'dsh'), 'resources/app/dsh（相对可执行文件）'])
    candidates.push([join(exeDir, 'resources', 'app'), 'resources/app（相对可执行文件）'])
  }
  for (const [candidate, source] of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue
    const found = readVersionAt(candidate)
    if (found) return { root: candidate, version: found.version, versionSource: found.source, rootSource: source }
  }
  return { root: undefined, version: undefined }
}

/* ------------------------------ 兼容性扫描 ------------------------------ */

/**
 * profile 的 compatibility.json：**精确版本豁免**。
 *
 * 实测形状（DSH app-boot 的 profile-compatibility.js）：顶层就是
 * `{ "包名@精确版本": ["精确 DSH 版本", ...] }`，没有外层包裹键。
 * 文件缺失 = 一个豁免都没有；文件坏了 = 也当一个都没有（宿主自己也是这么降级的），
 * 只在 warnings 里记一笔，不让探针抛错。
 */
function readProfileCompatibility(profileDir) {
  const file = join(profileDir, 'compatibility.json')
  const out = { path: file, exists: false, exemptions: {}, warnings: [] }
  const buf = readBuffer(file)
  if (!buf) return out
  out.exists = true
  let value
  try {
    value = JSON.parse(stripBom(buf.toString('utf8')))
  } catch (error) {
    out.warnings.push(`不是合法 JSON：${String(error?.message ?? error)}`)
    return out
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.warnings.push('顶层必须是「包名@精确版本 → DSH 版本数组」的对象')
    return out
  }
  for (const [key, versions] of Object.entries(value)) {
    if (!Array.isArray(versions) || !versions.every((v) => typeof v === 'string')) {
      out.warnings.push(`${key} 的值必须是精确 DSH 版本字符串数组，已忽略`)
      continue
    }
    out.exemptions[key] = versions.slice()
  }
  return out
}

/**
 * 复刻 DSH app-boot 的兼容判定（`evaluatePluginCompatibility`）：
 *   1. 有 `engines.dsh` 就只按它判，peerDependencies 不再参与；
 *   2. 否则每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 都要匹配（workspace:^ ≈ 当前版本）；
 *   3. 都没有 = 没有要求 = 可加载。
 * 区间判定用本文件里那个近似 semver，判不出来（undefined）就标 uncertain，绝不硬报不兼容。
 */
export function evaluatePluginGate(pkg, dshVersion) {
  if (!dshVersion) return { requirements: {}, basis: 'unknown', uncertain: true }
  const engines = pkg?.engines && typeof pkg.engines === 'object' ? pkg.engines : {}
  if (Object.prototype.hasOwnProperty.call(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string') return { requirements: { 'engines.dsh': '(不是字符串)' }, basis: 'engines.dsh', uncertain: true }
    if (range.trim() === '') return { requirements: { 'engines.dsh': range }, basis: 'engines.dsh', uncertain: false }
    const verdict = satisfiesRange(dshVersion, range)
    return { requirements: verdict === true ? {} : { 'engines.dsh': range }, basis: 'engines.dsh', uncertain: verdict === undefined }
  }
  const peers = pkg?.peerDependencies && typeof pkg.peerDependencies === 'object' ? pkg.peerDependencies : {}
  const dshPeers = Object.entries(peers).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  if (!dshPeers.length) return { requirements: {}, basis: 'none', uncertain: false }
  const unmet = {}
  let uncertain = false
  for (const [name, range] of dshPeers) {
    const raw = String(range)
    const effective = ['workspace:^', 'workspace:~', 'workspace:*'].includes(raw) ? dshVersion : raw
    if (effective.trim() === '') {
      unmet[name] = raw
      continue
    }
    const verdict = satisfiesRange(dshVersion, effective)
    if (verdict === undefined) uncertain = true
    else if (verdict === false) unmet[name] = raw
  }
  return { requirements: unmet, basis: 'peerDependencies', uncertain }
}

/**
 * 兼容性两种信号分开看，因为它们不是一回事：
 *   - 运行时闸门：engines.dsh / dsh peer（不满足 → 插件加载被判不兼容，除非 compatibility.json 有精确豁免）；
 *   - 元数据：dsh.compatibility.dsh / dshReleases（市场、注册表用，宿主加载时不读它）。
 * 把两者混在一起会把「元数据没覆盖」误报成「启用失败」，实测踩过。
 */
function inspectCompat({ profileDir, dependencies, dshVersion }) {
  const exemptions = readProfileCompatibility(profileDir)
  const out = {
    dshVersion,
    scannedCount: 0,
    noRequirements: [],
    unmet: [],
    exempted: [],
    metadataDrift: [],
    exemptionFile: { path: exemptions.path, exists: exemptions.exists, count: Object.keys(exemptions.exemptions).length, warnings: exemptions.warnings },
  }
  const modulesDir = join(profileDir, 'node_modules')
  for (const name of Object.keys(dependencies ?? {}).sort()) {
    const pkg = readJsonTolerant(join(modulesDir, ...String(name).split('/'), 'package.json'))
    if (!pkg) continue
    out.scannedCount += 1
    const gate = evaluatePluginGate(pkg, dshVersion)
    if (gate.basis === 'none') out.noRequirements.push(name)
    if (Object.keys(gate.requirements).length > 0 && !gate.uncertain) {
      const key = `${pkg.name ?? name}@${pkg.version ?? '0.0.0'}`
      const granted = (exemptions.exemptions[key] ?? []).includes(dshVersion)
      const record = { name: pkg.name ?? name, version: pkg.version, requirements: gate.requirements, key }
      if (granted) out.exempted.push(record)
      else out.unmet.push(record)
    }
    const meta = pkg?.dsh?.compatibility
    const declared = typeof meta?.dsh === 'string' && meta.dsh.trim() ? meta.dsh.trim() : undefined
    if (declared && dshVersion) {
      const verdict = satisfiesRange(dshVersion, declared)
      if (verdict === false) out.metadataDrift.push({ name: pkg.name ?? name, version: pkg.version, range: declared })
    }
  }
  return out
}

/* ------------------------------- finding ------------------------------- */

function finding(id, severity, zh, evidence, nextSteps) {
  return {
    id,
    severity,
    zh: String(zh ?? ''),
    evidence: String(evidence ?? ''),
    nextSteps: (Array.isArray(nextSteps) ? nextSteps : []).filter((step) => typeof step === 'string' && step),
  }
}

function sortFindings(findings) {
  return findings
    .slice()
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.id.localeCompare(b.id))
}

function listOf(items, max = 5) {
  const names = items.slice(0, max)
  const rest = items.length - names.length
  return rest > 0 ? `${names.join('、')} 等 ${items.length} 项` : names.join('、')
}

/** `{ 'engines.dsh': '^0.3.0' }` → `engines.dsh=^0.3.0`：evidence 里要能看出到底哪条要求没过。 */
function formatRequirements(requirements) {
  const entries = Object.entries(requirements ?? {})
  return entries.length ? entries.map(([key, range]) => `${key}=${range}`).join(', ') : '(没有要求)'
}

/* --------------------------- 通道：profile 探针 --------------------------- */

/**
 * 检查一个 profile 的「装得上装不上」。
 *
 * options:
 *   home         ~/.dsh（默认 homedir()/.dsh，可被 env DSH_HOME 覆盖）
 *   profile      profile 名（默认 'desktop'，可被 env DSH_PROFILE 覆盖）
 *   profileDir   直接指定目录（优先于 home+profile）
 *   dshVersion   覆盖当前 DSH 版本（测试用；默认从安装根推断）
 *   env          PATH / PATHEXT 等环境（默认 process.env）
 *
 * 全程只读、不抛：目录不存在也返回结构完整的对象，只是 findings 里多一条。
 */
export async function inspectProfileChannel(options = {}) {
  const env = options.env ?? process.env
  const home = options.home || env.DSH_HOME || join(homedir(), '.dsh')
  const profile = options.profile || env.DSH_PROFILE || 'desktop'
  const dir = options.profileDir ? String(options.profileDir) : join(home, 'profiles', profile)
  const dirExists = isDirectory(dir)

  const manifest = readManifest(join(dir, 'package.json'))
  const manifestDeps = manifest.parses ? { ...(manifest.value?.dependencies ?? {}) } : {}
  const manifestDevDeps = manifest.parses ? { ...(manifest.value?.devDependencies ?? {}) } : {}
  const allManifestNames = new Set([...Object.keys(manifestDeps), ...Object.keys(manifestDevDeps)])

  /* lockfile */
  const lockPath = join(dir, 'pnpm-lock.yaml')
  const lockBuf = readBuffer(lockPath)
  const lockText = lockBuf ? stripBom(lockBuf.toString('utf8')) : undefined
  const parsedLock = lockText !== undefined ? parseLockImporter(lockText) : undefined
  const lockDeps = parsedLock?.dependencies ?? {}
  const versionDrift = []
  const missingInLock = []
  const specifierDrift = []
  if (parsedLock?.importerFound && manifest.parses) {
    for (const [name, spec] of Object.entries(manifestDeps)) {
      const entry = lockDeps[name]
      if (!entry) {
        missingInLock.push(name)
        continue
      }
      const lockedRaw = entry.version ?? entry.specifier
      const locked = baseVersion(lockedRaw)
      if (EXACT_VERSION.test(String(spec))) {
        if (locked && locked !== String(spec)) versionDrift.push({ name, declared: String(spec), locked })
        continue
      }
      if (/^(file|link):/i.test(String(spec))) {
        const declaredNorm = normalizeSpecPath(spec)
        const lockedNorm = normalizeSpecPath(entry.specifier ?? entry.version)
        if (declaredNorm && lockedNorm && declaredNorm !== lockedNorm) {
          specifierDrift.push({ name, declared: String(spec), locked: String(entry.specifier ?? entry.version) })
        }
      }
    }
  }
  const missingInManifest = parsedLock?.importerFound
    ? Object.keys(lockDeps).filter((name) => !allManifestNames.has(name))
    : []

  const lockfile = {
    path: lockPath,
    exists: Boolean(lockBuf),
    bytes: lockBuf?.length ?? 0,
    importerFound: Boolean(parsedLock?.importerFound),
    versionDrift,
    missingInLock,
    missingInManifest,
    // 附加字段：调用方拿得到「锁文件里到底记了哪些依赖」，拼证据时不用再读一遍
    importerKey: parsedLock?.importerKey,
    specifierDrift,
    sections: parsedLock?.sections ?? [],
  }

  /* workspace 策略 */
  const workspacePolicy = parseWorkspacePolicy(join(dir, 'pnpm-workspace.yaml'))

  /* 本地 file: / link: 依赖（dependencies 与 devDependencies 走同一套判定） */
  const localDeps = []
  const collectLocal = (entries) => {
    for (const [name, spec] of Object.entries(entries)) {
      if (!/^(file|link):/i.test(String(spec))) continue
      localDeps.push(localDepEntry(name, spec, dir))
    }
  }
  collectLocal(manifestDeps)
  collectLocal(manifestDevDeps)

  /* pnpm 可执行文件 */
  const pnpm = findPnpm(env)
  const manager = { pnpmPath: pnpm.path, usable: Boolean(pnpm.path), searchedDirs: pnpm.searchedDirs, ...managedPnpmFiles(options.packageManager) }

  /* 兼容性 */
  const detected = options.dshVersion ? { version: String(options.dshVersion), rootSource: 'options.dshVersion' } : detectDshInstall(env)
  const compat = inspectCompat({ profileDir: dir, dependencies: manifestDeps, dshVersion: detected.version })

  /* ------------------------------ findings ------------------------------ */
  const findings = []

  if (!dirExists) {
    findings.push(
      finding(
        'DSH-INST-011',
        'fail',
        `profile 目录不存在：${dir}`,
        `已按 ${home} / profile=${profile} 解析路径；目录不存在，其余安装项无法检查`,
        ['确认 --profile 名称（~/.dsh/profiles 下有哪些目录）', '或先启动一次 DSH 让 profile 初始化，再复查'],
      ),
    )
  } else {
    if (manifest.exists && manifest.bom) {
      findings.push(
        finding(
          'DSH-INST-001',
          'fail',
          'profile/package.json 带 UTF-8 BOM：严格 JSON 加载器会抛 SyntaxError: Unexpected token \'﻿\'',
          `前 3 字节 EF BB BF · 文件 ${manifest.bytes} B · ${manifest.path}`,
          [
            '把 package.json 重写成 UTF-8 无 BOM（PowerShell 别用 Set-Content -Encoding utf8）',
            '改完再装一次；BOM 不修，pnpm 与 DSH 的清单校验都会拒绝',
          ],
        ),
      )
    }

    if (!manifest.exists) {
      findings.push(
        finding(
          'DSH-INST-009',
          'fail',
          'profile/package.json 不存在：没有清单就没有依赖可装',
          `${manifest.path} 不存在`,
          ['用最小清单重建：{ "name": "dsh-profile-<name>", "private": true, "dependencies": {} }', '再从备份恢复 dependencies 与 dsh.profile.bundles'],
        ),
      )
    } else if (!manifest.parses) {
      findings.push(
        finding(
          'DSH-INST-009',
          'fail',
          `profile/package.json 不是合法 JSON：${clip(manifest.error ?? '', 120)}`,
          `${manifest.path} · ${manifest.bytes} B${manifest.bom ? ' · 带 BOM' : ''}`,
          ['按报错位置逐段修：常见是多一个逗号、少一个引号', '从备份恢复，只保留 name / private / dependencies / dsh 四个顶层键'],
        ),
      )
    }

    if (!lockfile.exists) {
      findings.push(
        finding(
          'DSH-INST-005',
          'warn',
          'pnpm-lock.yaml 不存在：每次安装都要重新解析全部依赖，结果可能和上次不同',
          `${lockPath} 不存在（manifest 声明 ${manifest.dependencyCount} 个依赖）`,
          ['先跑一次 pnpm install 生成 lockfile，再让 DSH 装插件', '把 lockfile 一起备份，恢复时才能复现同一组版本'],
        ),
      )
    } else if (!lockfile.importerFound) {
      findings.push(
        finding(
          'DSH-INST-002',
          'fail',
          'pnpm-lock.yaml 里找不到本 profile 的 importer 条目（锁文件可能是别的目录写出来的）',
          `${lockPath} · ${lockfile.bytes} B · ${parsedLock?.parseError ?? '没有 importer'}`,
          ['把这个 lockfile 备份后删掉，重新 pnpm install 生成', '确认没有两个 profile 共用同一个 lockfile'],
        ),
      )
    } else if (versionDrift.length || missingInLock.length) {
      const first = versionDrift[0]
      const others = versionDrift.length + missingInLock.length - 1
      const zh = first
        ? `pnpm-lock.yaml 缺少 ${first.name}@${first.declared}（manifest 声明 ${first.declared}，锁定 ${first.locked}）${others > 0 ? `，另有 ${others} 项` : ''}`
        : `pnpm-lock.yaml 里没有 ${listOf(missingInLock)} 的条目（manifest 已声明）`
      const evidenceParts = []
      if (versionDrift.length) {
        evidenceParts.push(`版本漂移：${versionDrift.map((d) => `${d.name} 声明 ${d.declared} / 锁定 ${d.locked}`).join('；')}`)
      }
      if (missingInLock.length) evidenceParts.push(`锁里没有：${missingInLock.join('、')}`)
      const locked = first?.locked
      findings.push(
        finding(
          'DSH-INST-002',
          'fail',
          zh,
          `${lockPath} · ${evidenceParts.join(' · ')}`,
          [
            locked
              ? `运行 pnpm install 让 lockfile 与 manifest 对齐，或把 manifest 降到 ${locked}`
              : '运行 pnpm install 让 lockfile 与 manifest 对齐，或把 manifest 降到已锁定的版本',
            '别用 --frozen-lockfile 掩盖漂移：那个报错只会让问题换个说法',
          ],
        ),
      )
    }

    const unresolvedLocal = localDeps.filter((dep) => !dep.exists)
    if (unresolvedLocal.length) {
      const kindWord = (kind) => (kind === 'file' ? '文件' : kind === 'directory' ? '目录' : '未知类型')
      const needWord = (dep) => (dep.expectedKind === 'file' ? 'tarball 文件' : '目录')
      const describe = (dep) =>
        dep.targetKind === 'missing'
          ? '路径不存在'
          : `实际是${kindWord(dep.targetKind)}`
      const first = unresolvedLocal[0]
      const missing = first.targetKind === 'missing'
      findings.push(
        finding(
          'DSH-INST-003',
          'fail',
          missing
            ? `本地依赖 ${first.name} 指向的${needWord(first)}不存在：${first.targetPath}`
            : `本地依赖 ${first.name} 指向的路径类型不对：${first.targetPath} ${describe(first)}，需要${needWord(first)}`,
          unresolvedLocal
            .map((dep) => `${dep.name} → ${dep.targetPath}（${dep.spec} · ${dep.protocol}: · 需要${needWord(dep)} · ${describe(dep)}）`)
            .join(' · '),
          missing
            ? [
                `把${kindWord(first.expectedKind)}放回 ${first.targetPath}：file:/link: 的路径由 manifest 决定，跟 node_modules 里的副本无关`,
                first.protocol === 'link'
                  ? 'link: 必须指向真实目录；目录名可以带 .tgz / .tar.gz / .tar 后缀，不按归档文件解析'
                  : first.expectedKind === 'file'
                    ? '归档依赖要写真实存在的 tarball 路径：pnpm 只对 .tgz / .tar.gz / .tar 后缀按文件解析，其余当目录'
                    : 'file: 目录依赖要写成不带归档后缀的路径，或把插件目录放回原处',
                '改完路径重装一次；只删 node_modules 里的副本不会让 pnpm 换路径',
              ]
            : [
                `把 ${first.targetPath} 换回${kindWord(first.expectedKind)}：盘上现在是${kindWord(first.targetKind)}，pnpm 会按后缀语义解析并直接失败`,
                'file: 依赖的解析只看归档后缀：要目录就别带 .tgz / .tar.gz / .tar，要 tarball 就给真实文件',
                'link: 依赖只建目录软链，指向归档文件同样装不上',
                '改完重装一次，让 lockfile 记下新路径',
              ],
        ),
      )
    }

    if (specifierDrift.length) {
      findings.push(
        finding(
          'DSH-INST-007',
          'warn',
          `lockfile 里 ${specifierDrift[0].name} 的路径与 manifest 不一致：目录被搬动过，或 lockfile 的路径编码坏了`,
          specifierDrift.map((d) => `${d.name}：manifest ${d.declared} / lock ${d.locked}`).join(' · '),
          ['重新 pnpm install 让 lockfile 记录新路径，并确认 specifier 与 manifest 逐字一致', '搬动插件目录后必须重装，否则 pnpm 会去旧路径找包'],
        ),
      )
    }

    if (missingInManifest.length) {
      findings.push(
        finding(
          'DSH-INST-010',
          'info',
          `lockfile 里有 manifest 未声明的依赖：${listOf(missingInManifest)}`,
          `manifest 依赖 ${manifest.dependencyCount} 个 / lock importer 记录 ${Object.keys(lockDeps).length} 个`,
          ['pnpm install 会剪掉它们；先确认不是手写清单时漏掉了哪个插件'],
        ),
      )
    }

    if (workspacePolicy.exists && workspacePolicy.minimumReleaseAge) {
      const versionOf = (name) => (EXACT_VERSION.test(String(manifestDeps[name] ?? '')) ? String(manifestDeps[name]) : undefined)
      const uncovered = Object.keys(manifestDeps).filter((name) => {
        const version = versionOf(name)
        return version ? !excludeCovers(workspacePolicy.excludeList, name, version) : false
      })
      findings.push(
        finding(
          'DSH-INST-004',
          'warn',
          `pnpm minimumReleaseAge=${workspacePolicy.minimumReleaseAge} 会挡住新发布的版本（白名单 ${workspacePolicy.excludedCount} 项）`,
          uncovered.length
            ? `白名单未覆盖：${listOf(uncovered.map((name) => `${name}@${manifestDeps[name]}`))}`
            : `白名单已覆盖 manifest 里所有精确版本（${workspacePolicy.excludedCount} 项）`,
          [
            '把要装的 <pkg>@<version> 加进 pnpm-workspace.yaml 的 minimumReleaseAgeExclude',
            '或者装之前临时去掉 minimumReleaseAge，装完恢复；否则表现就是「pnpm 解析不到版本」',
          ],
        ),
      )
    } else if (workspacePolicy.exists && workspacePolicy.excludedCount > 0) {
      findings.push(
        finding(
          'DSH-INST-004',
          'info',
          `已配置 minimumReleaseAgeExclude（${workspacePolicy.excludedCount} 项）但没声明 minimumReleaseAge，当前不拦截新版本`,
          `${workspacePolicy.path} · 白名单：${listOf(workspacePolicy.excludeList, 3)}`,
          ['如果确实想限制发布年龄，在 pnpm-workspace.yaml 顶层补 minimumReleaseAge: <分钟>'],
        ),
      )
    }

    if (!manager.usable || manager.managedFilesPresent === false) {
      const managedMissing = manager.managedFilesPresent === false
      const managedPresent = manager.managedFilesPresent === true
      findings.push(
        finding(
          'DSH-INST-006',
          managedMissing ? 'fail' : managedPresent ? 'info' : 'warn',
          managedMissing ? '宿主配置的安装命令或脚本文件缺失，内置安装通道需修复'
            : managedPresent ? '宿主内置安装命令文件已找到；PATH 未配置 pnpm 只影响手动命令，本次未执行安装测试'
            : 'PATH 未配置 pnpm，手动命令不可用；宿主内置安装通道尚未核实',
          [`扫过 ${manager.searchedDirs} 个 PATH 目录 · 命令行 pnpm ${manager.usable ? '已找到' : '未找到'}`,
            `宿主安装命令：${managedMissing ? '所需文件缺失' : managedPresent ? '所需文件存在，未运行验证' : '未取得可核实信息'}`].join(' · '),
          managedMissing ? ['核对 DSH 应用自带运行时与安装脚本，优先修复应用安装；不要只向 PATH 添加另一个 pnpm']
            : managedPresent ? ['使用 DSH 插件管理入口；仅在需要手动运行 pnpm 时配置命令行环境']
            : ['可先通过 DSH 插件管理入口核对内置安装器；仅在需要手动命令时安装 pnpm 或配置 PATH'],
        ),
      )
    }

    if (compat.unmet.length) {
      findings.push(
        finding(
          'DSH-INST-008',
          'fail',
          `${compat.unmet.length} 个已安装插件不满足当前 DSH ${compat.dshVersion ?? '未知版本'} 的加载期兼容要求（engines.dsh 或 @deepseek-ai/dsh* peer）：${listOf(compat.unmet.map((p) => `${p.name}@${p.version}`), 3)}`,
          `要求：${compat.unmet.map((p) => `${p.name} → ${formatRequirements(p.requirements)}`).join(' · ')} · 判定顺序：engines.dsh 优先，没有才看 @deepseek-ai/dsh* peer`,
          [
            '把插件降到满足当前 DSH 的版本，或先升级/降级 DSH 再启用',
            '插件本身没问题、只是想先跑起来时，给「包名@精确版本」授予精确版本豁免（dsh plugin allow-version，或写 profile 的 compatibility.json），别改插件清单',
          ],
        ),
      )
    }
    if (compat.exempted.length) {
      findings.push(
        finding(
          'DSH-INST-008',
          'warn',
          `${compat.exempted.length} 个插件只凭精确版本豁免才被允许加载（当前 DSH ${compat.dshVersion ?? '未知版本'}）：${listOf(compat.exempted.map((p) => `${p.name}@${p.version}`), 3)}`,
          `豁免文件 ${compat.exemptionFile.path} · 豁免键：${compat.exempted.map((p) => p.key).join(' · ')} · 要求：${compat.exempted.map((p) => `${p.name} → ${formatRequirements(p.requirements)}`).join(' · ')}`,
          [
            '豁免等于明知版本要求不满足仍然加载，崩溃/丢数据的风险由授权方承担',
            '升级 DSH 后重新确认这些豁免还需要不需要，不用了就撤掉',
          ],
        ),
      )
    }
    if (compat.metadataDrift.length) {
      findings.push(
        finding(
          'DSH-INST-012',
          'info',
          `${compat.metadataDrift.length} 个插件的 dsh.compatibility 元数据没覆盖当前 DSH ${compat.dshVersion ?? '未知版本'}（宿主加载期不读它，只影响市场/注册表展示）`,
          `声明：${compat.metadataDrift.map((p) => `${p.name} → ${p.range}`).join(' · ')} · 加载期闸门：满足`,
          [
            '加载期只看 engines.dsh / @deepseek-ai/dsh* peer，这两处满足就不影响启用',
            '别把它当启用失败的直接原因去升降 DSH 版本，元数据由插件作者补即可',
          ],
        ),
      )
    }
  }

  return {
    profile,
    dir,
    manifest: {
      path: manifest.path,
      exists: manifest.exists,
      parses: manifest.parses,
      bom: manifest.bom,
      dependencyCount: manifest.dependencyCount,
      error: manifest.error,
      bytes: manifest.bytes,
    },
    lockfile,
    workspacePolicy,
    localDeps,
    manager,
    compat,
    dsh: { version: detected.version, root: detected.root, source: detected.rootSource, versionSource: detected.versionSource },
    findings: sortFindings(findings),
  }
}

/* --------------------------- 汇总：安装健康度 --------------------------- */

function countBySeverity(findings) {
  const counts = { fail: 0, warn: 0, info: 0 }
  for (const item of findings) if (counts[item.severity] !== undefined) counts[item.severity] += 1
  return counts
}

function verdictOf(counts) {
  if (counts.fail > 0) return 'blocked'
  if (counts.warn > 0) return 'degraded'
  return 'healthy'
}

function summaryOf(counts) {
  const parts = [`${counts.fail} 个阻塞项`, `${counts.warn} 个提醒`]
  if (counts.info > 0) parts.push(`${counts.info} 条提示`)
  return `找到 ${parts.join('、')}`
}

/**
 * 安装健康度汇总：lockfile 一致性 + 本地 file: 依赖 + manifest 可解析 + workspace 策略 + pnpm 可用性。
 * channel 里的 findings 原样带上，另外给出计数与 verdict，方便 rules/panel 直接消费。
 */
export async function inspectInstallHealth(options = {}) {
  const startedAt = Date.now()
  let channel
  let probeError
  let probeStack = ''
  try {
    channel = await inspectProfileChannel(options)
  } catch (error) {
    probeError = String(error?.message ?? error)
    probeStack = String(error?.stack ?? '').split('\n').slice(0, 3).join(' · ')
  }
  const findings = probeError
    ? [
        finding(
          'DSH-INST-000',
          'fail',
          `安装探针自身异常：${clip(probeError, 160)}`,
          probeStack,
          ['把这条贴进 issue：探针抛错时安装结论不可信', '先用 --json 看 channel 段缺了哪一项'],
        ),
      ]
    : channel.findings.slice()
  const counts = countBySeverity(findings)
  const verdict = verdictOf(counts)
  const blocking = findings.filter((item) => item.severity === 'fail').map((item) => item.id)
  return {
    installerVersion: INSTALLER_VERSION,
    generatedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    home: channel ? (options.home || (options.env ?? process.env).DSH_HOME || join(homedir(), '.dsh')) : options.home,
    profile: channel?.profile ?? options.profile ?? 'desktop',
    profileDir: channel?.dir,
    channel,
    findings: sortFindings(findings),
    counts,
    blocking,
    verdict,
    summary: summaryOf(counts),
    error: probeError,
  }
}

/* ------------------------- 失败归类：错误码表 → 结论 ------------------------- */

/**
 * 检测器顺序 = 优先级。同一条 stderr 里常常同时出现
 * `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY` 和后续的 404，
 * 先命中「能解释根因」的那条，避免被连带错误带偏。
 */
const DETECTORS = [
  {
    pick: (text) => (/\uFEFF/.test(text) && /unexpected token/i.test(text) ? 'MANIFEST_BOM' : null),
    line: /unexpected token/i,
  },
  {
    pick: (text) => (/Unexpected token[^\n]*is not valid JSON/i.test(text) || /Unexpected token .+ in JSON at position/i.test(text) ? 'MANIFEST_JSON' : null),
    line: /unexpected token/i,
  },
  {
    pick: (text) => (/ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY|Broken lockfile: no entry for/i.test(text) ? 'ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY' : null),
    line: /ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY|Broken lockfile/i,
  },
  {
    pick: (text) => (/ERR_PNPM_OUTDATED_LOCKFILE|Cannot install with "frozen-lockfile"/i.test(text) ? 'ERR_PNPM_OUTDATED_LOCKFILE' : null),
    line: /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile/i,
  },
  {
    pick: (text) => (/ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND|as it does not contain a package\.json file/i.test(text) ? 'ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND' : null),
    line: /ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND|does not contain a package\.json/i,
  },
  {
    pick: (text) => (/ERR_PNPM_NO_MATCHING_VERSION|No matching version found/i.test(text) ? 'ERR_PNPM_NO_MATCHING_VERSION' : null),
    line: /ERR_PNPM_NO_MATCHING_VERSION|No matching version found/i,
  },
  {
    pick: (text) => (/ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER/i.test(text) ? 'ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER' : null),
    line: /ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER/i,
  },
  {
    pick: (text) => (/ERR_PNPM_FETCH_404|\b404 Not Found\b/i.test(text) ? 'ERR_PNPM_FETCH_404' : null),
    line: /ERR_PNPM_FETCH_404|404 Not Found/i,
  },
  {
    pick: (text) => (/ERR_PNPM_TARBALL_INTEGRITY|\bEINTEGRITY\b/i.test(text) ? (/\bEINTEGRITY\b/.test(text) && !/ERR_PNPM_TARBALL_INTEGRITY/.test(text) ? 'EINTEGRITY' : 'ERR_PNPM_TARBALL_INTEGRITY') : null),
    line: /ERR_PNPM_TARBALL_INTEGRITY|EINTEGRITY/i,
  },
  {
    pick: (text) => (/ERR_PNPM_PEER_DEP_ISSUES|Unmet peer/i.test(text) ? 'ERR_PNPM_PEER_DEP_ISSUES' : null),
    line: /ERR_PNPM_PEER_DEP_ISSUES|Unmet peer/i,
  },
  {
    pick: (text) => (/ERR_PNPM_UNSUPPORTED_ENGINE|Unsupported engine/i.test(text) ? 'ERR_PNPM_UNSUPPORTED_ENGINE' : null),
    line: /ERR_PNPM_UNSUPPORTED_ENGINE|Unsupported engine/i,
  },
  {
    pick: (text) => {
      const m = /\b(EBUSY|EPERM|EEXIST|ENOSPC|ENOTEMPTY)\b/.exec(text)
      return m ? m[1] : null
    },
    line: /\b(EBUSY|EPERM|EEXIST|ENOSPC|ENOTEMPTY)\b/,
  },
  {
    pick: (text) => {
      const m = /\b(ETIMEDOUT|ECONNRESET|ERR_SOCKET_TIMEOUT)\b/.exec(text)
      return m ? m[1] : null
    },
    line: /\b(ETIMEDOUT|ECONNRESET|ERR_SOCKET_TIMEOUT)\b/,
  },
  {
    // 人写的「timed out」也算网络问题，但排在具体错误码之后，避免抢走更精确的归类
    pick: (text) => (/(request|fetch|connect)[^\n]*timed? ?out/i.test(text) || /socket hang up/i.test(text) ? 'ETIMEDOUT' : null),
    line: /timed? ?out|socket hang up/i,
  },
]

function pickEvidence(text, line) {
  const lines = String(text ?? '').split(/\r?\n/)
  const matcher = line ?? /./
  const hit = lines.find((item) => matcher.test(item))
  const first = lines.map((item) => item.trim()).find(Boolean)
  const chosen = (hit ?? first ?? '').trim()
  return clip(chosen, 220)
}

/**
 * 把 pnpm / Node 的安装失败文本归到一个阶段 + 一个可执行的下一步。
 *
 * input: { stderr?, stdout?, exitCode?, message? }
 * 返回: { phase, code, severity, zh, nextSteps, evidence }
 * 认不出来时 phase='unknown' / severity='unknown'，nextSteps 引导收集 stderr 并跑
 * scripts/install-doctor.mjs，而不是编一个结论。
 */
export function classifyInstallerFailure(input = {}) {
  const text = [input.stderr, input.stdout, input.message]
    .filter((part) => typeof part === 'string' && part)
    .join('\n')
  const exitCode = Number.isFinite(input.exitCode) ? Number(input.exitCode) : undefined
  const trimmed = text.trim()

  if (!trimmed && (exitCode === undefined || exitCode === 0)) {
    return {
      phase: 'ok',
      code: null,
      severity: 'unknown',
      zh: '没有失败信号：stderr / stdout / message 都是空的',
      nextSteps: [],
      evidence: exitCode === 0 ? 'exitCode=0' : '',
    }
  }

  for (const detector of DETECTORS) {
    let code
    try {
      code = detector.pick(text)
    } catch {
      code = null
    }
    if (!code) continue
    const spec = PNPM_ERROR_CODES[code] ?? PNPM_ERROR_CODES.UNKNOWN_FAILURE
    return {
      phase: spec.phase,
      code,
      severity: spec.severity ?? 'fail',
      zh: spec.zh,
      nextSteps: [...spec.nextSteps],
      evidence: clip(`${exitCode !== undefined ? `exitCode=${exitCode} · ` : ''}${pickEvidence(text, detector.line)}`, 320),
    }
  }

  const unknownSpec = PNPM_ERROR_CODES.UNKNOWN_FAILURE
  return {
    phase: 'unknown',
    code: 'UNKNOWN_FAILURE',
    severity: 'unknown',
    zh: unknownSpec.zh,
    nextSteps: [...unknownSpec.nextSteps],
    evidence: clip(`${exitCode !== undefined ? `exitCode=${exitCode} · ` : ''}${pickEvidence(text) || '（没有可读的错误行）'}`, 320),
  }
}

export default {
  INSTALLER_VERSION,
  PNPM_ERROR_CODES,
  FINDING_CATALOG,
  classifyInstallerFailure,
  inspectProfileChannel,
  inspectInstallHealth,
}
