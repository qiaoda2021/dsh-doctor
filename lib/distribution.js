/**
 * DSH Doctor — 公开发布面（GitHub 分发与 npm tarball 共用的那一层）。
 *
 * 为什么单独一个模块，而不是塞进诊断引擎：
 * 这是**给插件自己用的**发布闸门。它必须能在「没装 DSH、也没装本插件」的干净目录里跑，
 * 所以只有零依赖的 Node 内置模块，且从不读用户目录、不全库扫描——只走白名单里那几层。
 *
 * 三条硬约束，全部来自真实翻车：
 * 1. **白名单而不是黑名单**：`artifacts/`（历史诊断、备份、会话）、`docs/`、`tests/`、
 *    其余 `scripts/`、`node_modules`、`vendor` 里都躺过本机证据。黑名单永远漏一项，
 *    白名单漏一项只会少发文件，代价小得多。
 * 2. **只输出路径 + 问题代号 + 泛化说明**：命中 PEM 私钥、凭据赋值、本机作者路径时，
 *    把值原样打进报告等于把泄露从代码搬进了报告。这里只报位置。
 * 3. **检测器自己的正则不许误报**：本模块与 `lib/logs.js`、`lib/repair-secrets.js` 里
 *    都写着私钥/令牌的**匹配式**，而这些文件本身也要被扫。所以：私钥判定要求真有 base64
 *    正文（检测式正则在单行里，header 后面不是换行，进不来）；本机路径的针是**拼出来的**，
 *    源码文本里不连续 —— 因此「把模块字节复制到别处再扫」也不会自己命中自己，
 *    不需要靠「跳过某个文件名」这种路径身份特例。
 * 4. **检查过的字节就是会发出去的字节**：`files` 的目录条目在 npm 语义下递归发整棵树，
 *    所以除了「已收集文件是否被 manifest 覆盖」这个单向校验，还必须**反向枚举**目录条目，
 *    把任何「会随包发出但没进过检查清单」的文件阻断（`files-unscanned`）；具体文件条目也必须
 *    落在白名单并集里（`entry-outside-whitelist`），glob 只接受 `<白名单目录>/*<后缀>` 这一种形状。
 *    反向枚举只走 manifest 指向的白名单目录（`lib`、`locale`），**不读内容、不列路径以外的信息**，
 *    也不会去 walk 整棵源码树 —— 历史诊断产物动辄几十 MB。
 *
 * 导出面固定三个函数，签名与返回值形状是和 lead 的接线契约：
 *   collectPublicFiles(root) -> string[]                    排序后的 POSIX 相对路径
 *   inspectPublicRelease(root) -> { ok, files, issues }     只读检查
 *   stagePublicRelease(root, destination) -> { ok, files, issues, destination, manifest }
 *
 * issue 形状恒为 `{ code, path, message }`：path 是 POSIX 化的相对路径（destination 相关
 * 问题给绝对路径），message 只描述类型，绝不带命中的原文。
 */
import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const posix = (value) => String(value).replace(/\\/g, '/')
const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** 根目录下允许随包分发的文件（顶层，不递归）。 */
const ROOT_FILE_NAMES = ['package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']
/** 无论 manifest 怎么写都必须存在的入口；缺一条就不该发布。 */
const ALWAYS_REQUIRED = [...ROOT_FILE_NAMES]
/** 允许遍历的目录层级：只有这两层，且只取顶层指定后缀。 */
const DIR_WHITELIST = [
  { dir: 'lib', ext: '.js' },
  { dir: 'locale', ext: '.json' },
]
/** scripts/ 里只有探针脚本是运行面的一部分；其余是开发脚本。 */
const SCRIPT_WHITELIST = ['scripts/connectivity-probe.mjs']
/** 整目录条目覆盖这些目录 = 把开发面随包发出去。 */
const DEV_DIRS = ['docs', 'tests', 'scripts', 'artifacts', 'node_modules', 'vendor', 'coverage', '.github', '.git']
/** 白名单目录本身可以是 files 条目（它们不是缺文件）；但目录里任何未收集项都必须阻断。 */
const DIR_ENTRIES = DIR_WHITELIST.map((rule) => rule.dir)
/** 唯一受支持的 glob 形状：`<白名单目录>/*<后缀>`；`**`、跨目录匹配都不算受支持。 */
const SUPPORTED_GLOBS = DIR_WHITELIST.map((rule) => `${rule.dir}/*${rule.ext}`)
/** 源码根内部唯一允许放 staging 的子树（`artifacts/dist` 这类用法）。 */
const STAGE_ALLOWED_SUBTREE = 'artifacts'
/** 单文件内容检查上限；超过就不敢断言「干净」。 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024
/** 只有文本面才做内容扫描；二进制不该出现在白名单里，出现了也不读。 */
const TEXTUAL = /\.(?:js|mjs|cjs|json|ya?ml|svg|md|txt)$/i

/**
 * PEM 私钥：要求 header 后**紧跟换行**，且后面真有 base64 正文（至少两行，或一行 64+）。
 * 这个形状让 `'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?'` 这类**检测式源码**进不来。
 */
const PEM_PRIVATE_KEY = /-----BEGIN[A-Z ]*PRIVATE KEY[A-Z ]*-----(?:\r?\n)(?:[A-Za-z0-9+/=]{16,}[ \t]*(?:\r?\n)|[A-Za-z0-9+/=]{64,})/
/** 服务商令牌前缀：要求足够长的随机尾巴，`sk-xxx` / `sk-test` 这类占位符进不来。 */
const PROVIDER_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|hf_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,})\b/
/** 凭据字段名；后面必须跟**引号包起来的字面量**才算赋值。 */
const CREDENTIAL_KEY = /(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credential|private[_-]?key|client[_-]?secret|bearer)/i
/** `key = "值"` / `"key": "值"`；`const apiKey = facts.apiKey` 这种属性读取不进来（无引号）。 */
const CREDENTIAL_ASSIGN = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[:=]\s*('|"|`)([^'"`\r\n]{16,240})\2/g
/** 占位值：README 与模板里的示例不该当凭据报。 */
const PLACEHOLDER_VALUE = /^(?:your|example|placeholder|sample|dummy|fake|test|redacted|change|none|null|undefined|todo|tbd|xxx|abc|apikey|bearer|secret|token|key)(?:[_\-\s.]|$)/i
const PLACEHOLDER_ANY = /(?:YOUR_|<[^>]*>|\$\{|placeholder|example\.com|redacted|xxxxxxxx)/i
/**
 * 本机作者路径（折叠 `\\` 与 `/` 之后的小写匹配）。三条针都是**拼出来**的：
 * 写成字面量的话，模块自己的字节就会命中自己 —— 而且这份文件被 staging 复制到新路径后
 * 也没有「跳过自己」可依赖。拼装串在源码文本里不连续，扫不到。
 */
const LOCAL_PATH_NEEDLES = [
  ['c:', 'users', 'administrator'].join('/'),
  ['d:', '生活辅助插件'].join('/'),
  ['d:', 'harness'].join('/'),
]

function issue(code, path, message) {
  return { code, path: posix(path), message }
}
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
/** 稳定排序 + 去重：同一路径同一代号同一说明只留一条，避免同一事实报两遍。 */
function sortIssues(issues) {
  const seen = new Set()
  const unique = []
  for (const item of issues) {
    const key = `${item.code}\u0000${item.path}\u0000${item.message}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  return unique.sort((a, b) => (a.path === b.path ? compareText(a.code, b.code) : compareText(a.path, b.path)))
}
/** Windows 大小写不敏感；判包含关系时两边都折叠，避免 `d:\x` 与 `D:\x` 误判成越界。 */
function insidePath(root, target) {
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const rel = relative(fold(root), fold(target))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/* ------------------------------------------------------------------ *
 * 内容检查：只报位置，绝不回传命中的值
 * ------------------------------------------------------------------ */

/** 双反斜杠（源码写法）、单反斜杠、正斜杠三种写法归一成同一种形状，再小写比较。 */
function flattenPathText(text) {
  return String(text).replace(/\\\\/g, '\\').replace(/\\/g, '/').toLowerCase()
}

/** 值够不够像真凭据：要混合字母数字、不能是标识符路径、不能是占位符。 */
function looksLikeSecret(value) {
  if (!value || /[\s]/.test(value)) return false
  if (PLACEHOLDER_VALUE.test(value) || PLACEHOLDER_ANY.test(value)) return false
  if (new Set(value).size < 6) return false
  const hasDigit = /[0-9]/.test(value)
  const hasAlpha = /[A-Za-z]/.test(value)
  if (!hasDigit || !hasAlpha) return false
  // `facts.inference.apiKey` / `process.env.X` 这类**带点的取值路径**不是凭据字面量；
  // 但纯字母数字的长随机串必须放行——真令牌经常就是这样，判太严会漏报。
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false
  return true
}

function scanContent(relPath, text, issues) {
  if (PEM_PRIVATE_KEY.test(text)) {
    issues.push(issue('pem-private-key', relPath, '公开文件里出现 PEM 私钥块（只报位置，值已隐去）'))
  }
  if (PROVIDER_TOKEN.test(text)) {
    issues.push(issue('provider-token', relPath, '公开文件里出现服务商令牌形态的字符串（只报位置，值已隐去）'))
  }
  for (const match of text.matchAll(CREDENTIAL_ASSIGN)) {
    if (!CREDENTIAL_KEY.test(match[1])) continue
    if (!looksLikeSecret(match[3])) continue
    issues.push(issue('credential-value', relPath, '公开文件里出现凭据赋值（只报位置，值已隐去）'))
    break // 同一文件一条就够，避免刷屏也不便于逐条定位
  }
  const flat = flattenPathText(text)
  if (LOCAL_PATH_NEEDLES.some((needle) => flat.includes(needle))) {
    issues.push(issue('local-author-path', relPath, '公开文件里出现本机作者绝对路径（只报位置）'))
  }
}

/* ------------------------------------------------------------------ *
 * 白名单枚举
 * ------------------------------------------------------------------ */

function walkTree(dir, prefix = '') {
  const out = []
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names.slice().sort(compareText)) {
    const relPath = prefix ? `${prefix}/${name}` : name
    const full = join(dir, name)
    let info
    try {
      info = lstatSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) out.push(...walkTree(full, relPath))
    else out.push(relPath)
  }
  return out
}

/**
 * 只读枚举。返回结构内部用，不导出。
 * 文件被接受才进 `files`；被拒绝的每一项都留下一个 issue（链接、越界、非普通文件、读不到）。
 */
function collect(root) {
  const issues = []
  const files = []
  const rootPath = resolve(String(root ?? '.'))
  if (!existsSync(rootPath)) {
    issues.push(issue('root-missing', rootPath, '源码根目录不存在，无法枚举发布面'))
    return { rootPath, files, issues, scanned: 0 }
  }
  let realRoot = rootPath
  try {
    realRoot = realpathSync(rootPath)
  } catch {
    /* 读不到就按原路径比较，后续每个文件仍各自判定 */
  }

  let scanned = 0
  /** @returns {string|null} 被接受的文件的绝对路径 */
  const accept = (relPath, { required = false } = {}) => {
    const full = join(rootPath, ...relPath.split('/'))
    let info
    try {
      info = lstatSync(full)
    } catch (error) {
      const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
      if (missing && !required) return null
      issues.push(issue(missing ? 'required-missing' : 'unreadable', relPath, missing ? '必需的发布入口缺失' : '白名单文件读不到'))
      return null
    }
    // 链接/重解析点一律不发：pnpm file: 与 junction 都会把「看起来在根里」的东西指到根外。
    if (info.isSymbolicLink()) {
      issues.push(issue('symlink-detected', relPath, '发布面里出现链接/重解析点，拒绝随包分发'))
      return null
    }
    if (!info.isFile()) {
      issues.push(issue('not-a-regular-file', relPath, '白名单要求普通文件'))
      return null
    }
    let realFile = full
    try {
      realFile = realpathSync(full)
    } catch {
      /* 保底用原路径 */
    }
    if (!insidePath(realRoot, realFile)) {
      issues.push(issue('path-escapes-root', relPath, '文件真实路径越出源码根'))
      return null
    }
    if (info.size > MAX_SCAN_BYTES) {
      issues.push(issue('file-too-large', relPath, '文件超出内容检查上限，无法证明它干净'))
      return null
    }
    files.push(relPath)
    return full
  }

  const scan = (relPath, full) => {
    if (!TEXTUAL.test(relPath)) return
    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      issues.push(issue('unreadable', relPath, '白名单文件读不到，无法证明它干净'))
      return
    }
    scanned += 1
    scanContent(relPath, text, issues)
  }

  for (const rule of DIR_WHITELIST) {
    const dirPath = join(rootPath, rule.dir)
    let info
    try {
      info = lstatSync(dirPath)
    } catch {
      continue // 没有这一层就是没有这类文件，不是问题
    }
    if (info.isSymbolicLink()) {
      issues.push(issue('symlink-detected', rule.dir, '白名单目录本身是链接/重解析点'))
      continue
    }
    if (!info.isDirectory()) {
      issues.push(issue('not-a-directory', rule.dir, '白名单目录不是目录'))
      continue
    }
    let names = []
    try {
      names = readdirSync(dirPath)
    } catch {
      issues.push(issue('unreadable', rule.dir, '白名单目录读不到'))
      continue
    }
    // 只取顶层；子目录不在白名单里，静默跳过（白名单 = 少发，不是漏发）。
    for (const name of names.slice().sort(compareText)) {
      if (!name.endsWith(rule.ext)) continue
      const relPath = `${rule.dir}/${name}`
      const full = accept(relPath)
      if (full) scan(relPath, full)
    }
  }
  for (const name of ROOT_FILE_NAMES) {
    const full = accept(name, { required: true })
    if (full) scan(name, full)
  }
  for (const relPath of SCRIPT_WHITELIST) {
    const full = accept(relPath, { required: true })
    if (full) scan(relPath, full)
  }

  files.sort(compareText)
  return { rootPath, files, issues, scanned }
}

/* ------------------------------------------------------------------ *
 * manifest（package.json）检查
 * ------------------------------------------------------------------ */

/** 整目录条目是否落在开发目录上；具体文件条目不在这里判（见 checkFilesEntries）。 */
function broadDirOf(entry) {
  const clean = posix(String(entry)).trim().replace(/^\.\//, '')
  if (!clean || clean.startsWith('!')) return ''
  const stripped = clean.replace(/\/\*{1,2}$/, '').replace(/\/+$/, '')
  if (!stripped || stripped.includes('*')) return ''
  const first = stripped.split('/')[0]
  if (stripped !== first) return '' // `lib/index.js`、`scripts/connectivity-probe.mjs` 是具体文件
  return DEV_DIRS.includes(first) ? first : ''
}

/** `!lib/` 这类取反条目与尾斜杠都在这里归一，后面的判定只看 `clean`。 */
function normalizeEntry(raw) {
  const text = String(raw).trim()
  const negative = text.startsWith('!')
  const clean = posix(negative ? text.slice(1) : text).replace(/^\.\//, '').replace(/\/+$/, '')
  return { negative, clean }
}

/** 父级路径与绝对路径：两种写法都会把源码根之外的字节带进 tarball。 */
function entryEscapesRoot(clean) {
  if (!clean) return false
  if (clean.startsWith('/') || isAbsolute(clean)) return true
  if (/^[A-Za-z]:\//.test(clean)) return true // `C:/x` 在 POSIX 上不算绝对路径，但同样越界
  return clean.split('/').includes('..')
}

/**
 * `files` 条目的双向闭合：
 *  - 正向：每个条目本身必须是「白名单目录 / 白名单里的实际文件 / 受支持的白名单 glob」之一；
 *  - 反向：目录条目在 npm 语义下递归发整棵树，于是逐层枚举它，任何没进过检查清单的文件
 *    （`lib/leak.json`、`lib/notes.txt`、`lib/deep/nested.js` 之类）一律阻断。
 * 反向枚举只走 `DIR_ENTRIES` 指向的目录，只用 readdir/lstat 列路径，**不读文件内容**，
 * 因此既不会把几十 MB 的 `artifacts/` 读一遍，也不会把被排除文件的原文写进报告。
 */
function checkFilesEntries(entries, files, rootPath, issues) {
  const collected = new Set(files)
  const allowed = new Set([...files, ...ALWAYS_REQUIRED, ...SCRIPT_WHITELIST, ...DIR_ENTRIES])
  const declared = new Set()
  for (const raw of entries) {
    const { negative, clean } = normalizeEntry(raw)
    if (negative || !clean) continue // 取反条目只做减法，不新增可发布字节
    declared.add(clean)
    if (broadDirOf(raw)) continue // 整目录开发面已由 files-broad 报过，不重复刷屏
    if (entryEscapesRoot(clean)) {
      issues.push(issue('entry-escapes-root', clean, 'files 条目指向父级路径或绝对路径，会把源码根之外的字节随包发出'))
      continue
    }
    if (clean.includes('*')) {
      if (SUPPORTED_GLOBS.includes(clean)) continue
      issues.push(issue('entry-unsupported-glob', clean, 'files 的 glob 条目不在受支持形状内（只接受 <白名单目录>/*<后缀>，不接受 ** 或跨目录匹配）'))
      continue
    }
    if (allowed.has(clean)) continue
    issues.push(issue('entry-outside-whitelist', clean, 'files 条目不在发布白名单内；具体条目只能指向白名单里的实际文件'))
  }
  for (const clean of declared) {
    if (clean.includes('*')) continue // 受支持 glob 只匹配顶层白名单文件，已全部进过清单
    // Only exact approved directory entries may be traversed. A rejected entry such
    // as lib/../../private must never be re-used here after its forward check failed.
    if (!DIR_ENTRIES.includes(clean)) continue
    const dirPath = join(rootPath, ...clean.split('/'))
    let info = null
    try {
      info = lstatSync(dirPath)
    } catch {
      continue // 目录不存在：没有可发字节，缺不缺由必需入口那条规则管
    }
    if (info.isSymbolicLink() || !info.isDirectory()) continue
    for (const relPath of walkTree(dirPath)) {
      const published = `${clean}/${relPath}`
      if (collected.has(published)) continue
      issues.push(issue('files-unscanned', published, '这会随包发出，但没有被发布检查扫描过（只报路径，不读内容）'))
    }
  }
}

function matchesFilesEntry(clean, relPath) {
  if (clean === relPath) return true
  if (clean.includes('*')) {
    const pattern = clean
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .split('\u0000')
      .join('.*')
    return new RegExp(`^${pattern}$`).test(relPath)
  }
  return relPath.startsWith(`${clean}/`)
}

/** npm/pnpm 的 files 语义：目录前缀 + glob，`!` 取反覆盖前面的命中。 */
function coveredBy(entries, relPath) {
  let covered = false
  for (const raw of entries) {
    const text = String(raw).trim()
    const negative = text.startsWith('!')
    const clean = posix(negative ? text.slice(1) : text).replace(/^\.\//, '').replace(/\/+$/, '')
    if (!clean) continue
    if (!matchesFilesEntry(clean, relPath)) continue
    covered = !negative
  }
  return covered
}

/** 必需入口 = 固定清单 + manifest 自己声明的入口（glob 条目跳过）。 */
function requiredEntries(pkg) {
  const out = new Set(ALWAYS_REQUIRED)
  const add = (value) => {
    if (typeof value !== 'string') return
    const clean = posix(value).trim().replace(/^\.\//, '')
    if (!clean || clean.includes('*')) return
    out.add(clean)
  }
  add(pkg.main)
  add(pkg.icon)
  add(pkg.dsh?.bundle?.patch)
  const exported = pkg.exports
  if (typeof exported === 'string') add(exported)
  else if (exported && typeof exported === 'object') {
    for (const value of Object.values(exported)) {
      if (typeof value === 'string') add(value)
      else if (value && typeof value === 'object') {
        for (const nested of Object.values(value)) add(typeof nested === 'string' ? nested : '')
      }
    }
  }
  return [...out].sort(compareText)
}

function checkManifest({ rootPath, files }, issues) {
  let pkg = null
  if (files.includes('package.json')) {
    try {
      pkg = JSON.parse(readFileSync(join(rootPath, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      issues.push(issue('package-unparsable', 'package.json', 'package.json 不是合法 JSON，发布前必须修'))
    }
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return
  const entries = Array.isArray(pkg.files) ? pkg.files.map((entry) => String(entry)) : []
  if (!entries.length) {
    issues.push(issue('files-missing', 'package.json', '没有声明 files，安装会把整棵树（含 docs/tests/artifacts）带上'))
  }
  if (entries.length) {
    const broad = [...new Set(entries.map(broadDirOf).filter(Boolean))].sort(compareText)
    if (broad.length) {
      issues.push(issue('files-broad', 'package.json', `files 用整目录条目覆盖了开发目录（${broad.join('、')}），会随包分发文档/测试/脚本`))
    }
    // 双向闭合：条目必须落在白名单里，且目录条目会带出的每一个字节都必须进过检查清单。
    checkFilesEntries(entries, files, rootPath, issues)
    for (const relPath of requiredEntries(pkg)) {
      // 固定清单里的入口由 collect() 已经按「必需项」报过，这里只管 manifest 自己声明的。
      if (ALWAYS_REQUIRED.includes(relPath)) continue
      if (files.includes(relPath)) continue
      const exists = existsSync(join(rootPath, ...relPath.split('/')))
      issues.push(issue(
        exists ? 'entry-outside-whitelist' : 'required-missing',
        relPath,
        exists ? '入口文件存在但不在发布白名单内，装上会缺文件' : '必需的发布入口缺失',
      ))
    }
    for (const relPath of files) {
      if (relPath === 'package.json') continue // npm 总是随包发 manifest
      if (coveredBy(entries, relPath)) continue
      issues.push(issue('files-not-covering', relPath, '运行文件没被 package.json.files 覆盖，装进 profile 会缺文件'))
    }
  }
  // 元数据只检查「有没有编造」：占位 owner/repo 比缺失更容易骗过审核。
  // private:true 只拦 npm publish，不拦 GitHub 分发 —— 故意不检查它。
  for (const key of ['repository', 'homepage', 'bugs']) {
    const value = pkg[key]
    const text = typeof value === 'string' ? value : value && typeof value === 'object' ? String(value.url ?? '') : ''
    if (!text) continue
    if (/OWNER|YOUR_|your-name|example\.com|REPLACE_ME/i.test(text)) {
      issues.push(issue('metadata-placeholder', 'package.json', `${key} 还是占位符，发布前换成真实地址或删掉`))
    }
  }
}

/* ------------------------------------------------------------------ *
 * 对外三个导出
 * ------------------------------------------------------------------ */

/** 白名单内的发布文件，POSIX 相对路径、已排序。 */
export function collectPublicFiles(root) {
  return collect(root).files
}

/** 只读检查：`ok` 为真等价于「没有 issue」，`files` 仍是白名单枚举结果。 */
export function inspectPublicRelease(root) {
  const collected = collect(root)
  const issues = [...collected.issues]
  checkManifest(collected, issues)
  const sorted = sortIssues(issues)
  return { ok: sorted.length === 0, files: collected.files, issues: sorted }
}

/**
 * 检查通过后复制到一个新空目录。任何一步失败都会清掉本次写入（不留半成品、不覆盖既有内容）。
 * manifest 只在返回值里，不写成包内文件、也不改 package.json。
 */
export function stagePublicRelease(root, destination) {
  const inspected = inspectPublicRelease(root)
  const issues = [...inspected.issues]
  const rootPath = resolve(String(root ?? '.'))
  const destPath = typeof destination === 'string' && destination.trim() && isAbsolute(destination) ? resolve(destination) : ''

  if (!destPath) {
    issues.push(issue('destination-invalid', typeof destination === 'string' && destination.trim() ? destination : '(未提供)', 'staging 需要绝对路径的新空目录'))
  } else {
    if (destPath === rootPath) {
      issues.push(issue('destination-is-source-root', destPath, 'destination 不能就是源码根'))
    } else if (insidePath(rootPath, destPath)) {
      const top = relative(rootPath, destPath).split(sep)[0]
      // 允许 `artifacts/dist`：那里本来就该是产物区，且永远不会被白名单递归进去。
      if (top !== STAGE_ALLOWED_SUBTREE) {
        issues.push(issue('destination-inside-source', destPath, `destination 落在源码根内部；只有 ${STAGE_ALLOWED_SUBTREE}/ 下的新目录可以这么用`))
      }
    }
    if (existsSync(destPath)) {
      let info = null
      try {
        info = lstatSync(destPath)
      } catch {
        info = null
      }
      if (!info) issues.push(issue('destination-invalid', destPath, 'destination 状态读不到'))
      else if (info.isSymbolicLink()) issues.push(issue('destination-is-link', destPath, 'destination 是链接/重解析点'))
      else if (!info.isDirectory()) issues.push(issue('destination-not-a-directory', destPath, 'destination 已存在但不是目录'))
      else if (readdirSync(destPath).length) issues.push(issue('destination-not-empty', destPath, 'destination 不是空目录；staging 不覆盖任何既有内容'))
    }
  }

  if (issues.length || !destPath) {
    return { ok: false, files: inspected.files, issues: sortIssues(issues), destination: destPath || String(destination ?? '') }
  }

  const createdDirs = []
  const written = []
  const manifest = []
  const mkdirTracked = (target) => {
    if (existsSync(target)) return
    mkdirTracked(dirname(target))
    mkdirSync(target)
    createdDirs.push(target)
  }
  const cleanup = () => {
    for (const file of written.slice().reverse()) {
      try {
        unlinkSync(file)
      } catch {
        /* 已经不在了 */
      }
    }
    for (const dir of createdDirs.slice().reverse()) {
      try {
        rmdirSync(dir)
      } catch {
        /* 非空或已删 */
      }
    }
  }

  try {
    mkdirTracked(destPath)
    for (const relPath of inspected.files) {
      const source = join(rootPath, ...relPath.split('/'))
      const target = join(destPath, ...relPath.split('/'))
      mkdirTracked(dirname(target))
      const bytes = readFileSync(source)
      // `wx` = 目标已存在就失败，从写入侧再保证一次「不覆盖」。
      writeFileSync(target, bytes, { flag: 'wx' })
      written.push(target)
      const digest = hashOf(bytes)
      if (hashOf(readFileSync(target)) !== digest) {
        const drifted = new Error('复制后复核不一致')
        drifted.code = 'integrity'
        throw drifted
      }
      manifest.push({ path: relPath, bytes: bytes.length, sha256: digest })
    }
    const extras = walkTree(destPath).filter((relPath) => !inspected.files.includes(relPath))
    if (extras.length) {
      const extra = new Error('destination 里出现了白名单之外的文件')
      extra.code = 'inventory'
      throw extra
    }
    // 独立复检：把 staging 结果当成一个新的源码根重新过一遍同一道门。
    // 复制前后的结论必须一致，否则「检查过的字节 ≠ 发出去的字节」又会从复制环节漏回来。
    const restaged = inspectPublicRelease(destPath)
    const sameInventory = restaged.files.length === inspected.files.length
      && restaged.files.every((relPath, index) => relPath === inspected.files[index])
    if (!restaged.ok || !sameInventory) {
      const drifted = new Error('staging 后独立复检与复制前清单不一致')
      drifted.code = 'restage-inspect'
      throw drifted
    }
  } catch (error) {
    cleanup()
    issues.push(issue('stage-failed', destPath, `复制阶段中止（${error?.code ?? 'operation-failed'}），已清掉本次写入，未覆盖既有内容`))
    return { ok: false, files: inspected.files, issues: sortIssues(issues), destination: destPath }
  }

  return { ok: true, files: inspected.files, issues: [], destination: destPath, manifest }
}
