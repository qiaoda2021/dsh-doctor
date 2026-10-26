/**
 * DSH Doctor · 报告本地导出与历史存储（lib/store.js）
 *
 * 职责单一：把调用方已经渲染好的 `text`（体检报告正文）落盘成一份历史文件，
 * 并提供列表、读取、清理、保留策略五个动作。
 *
 * 三条不写在别处、只写在这里的边界：
 *   1. 脱敏不在这里。`lib/redact.js` 负责，本模块**不 import 它**，也不假设它存在；
 *      拿到的 `text` 就是最终要落盘的字节。
 *   2. 只认自己的命名。历史目录里可能混进别的东西（用户手放的笔记、别的插件写的中转文件），
 *      本模块只处理 `/^\d{8}-\d{6}-[\w-]+\.(md|json)$/` 命中的文件，其余一律不读不删。
 *   3. 所有读写都锁在 `exportsDir()` 之内。历史文件列表是"用户可点开"的入口，
 *      路径只要能被外部拼一段 `..` 决定，就等于把任意本地文件读成"报告"。
 *
 * 零第三方依赖，只用 node: 内置（fs/promises、path、os）。
 */
import { lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 历史默认保留份数。50 份足够回看最近几周，也不至于把 state 目录养成垃圾场。 */
export const MAX_KEEP = 50

/** 抢名字最多试 50 次。同一秒同分连点 50 次仍撞名，说明文件名方案已经失效，该报错而不是继续转。 */
const MAX_NAME_ATTEMPTS = 50

/** tmp 残留的存活上限：1 小时。进程被 kill 时 tmp 会留下，超过这个时间才认定为残骸。 */
const TMP_TTL_MS = 60 * 60 * 1000

/** tmp 文件名标记。写成 `<最终名>.tmp-<pid>-<rand>`，所以后缀是 `.tmp-` 而不是前缀。 */
const TMP_MARK = '.tmp-'

/**
 * 本模块认领的文件名。
 * 用 `[\w-]+` 而不是 `\d+` 容纳 score 缺失时的 `na`，以及 `-2` 后缀（`60-2`）。
 * 只在 `.md` / `.json` 结尾上匹配，所以任何 `.tmp-*` 残留天然不命中——这是"不误删"的第一道闸。
 */
const EXPORT_RE = /^\d{8}-\d{6}-([\w-]+)\.(md|json)$/

/** format → 扩展名。format 本身是接口值，扩展名是落盘事实，两者分开存。 */
const FORMAT_EXT = { markdown: 'md', json: 'json' }

/* ------------------------------- 路径解析 ------------------------------- */

/**
 * 导出目录：`options.dir` 优先，否则 `<home>/state/dsh-doctor/exports`。
 *
 * home 的解析顺序与 lib/facts.js 保持一致（options.home → DSH_HOME → ~/.dsh），
 * 这样体检报告知道自己在哪个 profile 下跑，导出的文件就落在同一个 profile 里，
 * 不会出现"报告写到另一个目录、历史列表看不见"的错位。
 *
 * 同步返回字符串：调用方（渲染层、测试）需要在 await 之前就知道路径。
 */
export function exportsDir(options = {}) {
  if (options.dir) return resolve(String(options.dir))
  const home = resolve(String(options.home || process.env.DSH_HOME || join(homedir(), '.dsh')))
  return resolve(home, 'state', 'dsh-doctor', 'exports')
}

/**
 * Windows 的路径比较是大小写不敏感的：`C:\a\B.md` 与 `c:\A\b.md` 是同一个文件。
 * 不折叠大小写，前缀判断在 Windows 上会漏判（把真实越界当成"更长的合法路径"）。
 * POSIX 上大小写敏感，折叠反而会把两个不同文件混成一个，所以只对 win32 折叠。
 */
function foldPath(target) {
  return process.platform === 'win32' ? String(target).toLowerCase() : String(target)
}

/**
 * target 是否真的在 dir 之内（不含 dir 本身）。
 *
 * 用 `path.relative` 而不是字符串 `startsWith`：`C:\a\bc` 以 `C:\a\b` 开头但不是父子关系，
 * 纯字符串前缀会把这种兄弟目录误判为内部。relative 之后只剩三种合法形态：
 * 空（同一路径）、以 `..` + 分隔符开头（在外层）、或绝对路径（Windows 跨盘符时 relative 的回落）。
 */
function isInsideDir(dirAbs, targetAbs) {
  const rel = relative(foldPath(dirAbs), foldPath(targetAbs))
  if (!rel) return false
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** 越界统一用这条消息：调用方与测试都按 `escapes` 关键字识别，不依赖中英文措辞。 */
function escapeError() {
  return new Error('path escapes exports dir')
}

/**
 * 逐段 lstat，拒绝"目录里放一个符号链接指向外部"的逃逸。
 *
 * 只检查目标本身不够：`<dir>/link/x.md` 里 link 是指向外部的目录链接，
 * 目标 x.md 自己不是符号链接，但物理位置已经跑出去了。所以从 dir 开始一段一段走。
 * `dir` 自己允许是链接（用户完全可以把 state 目录放到别的盘），只校验它内部。
 * 已存在性不是本函数的职责，中间段不存在就直接收手，让后续 readFile 自己抛 ENOENT。
 */
async function assertNoSymlink(dirAbs, targetAbs) {
  const segments = relative(foldPath(dirAbs), foldPath(targetAbs)).split(/[\\/]+/).filter(Boolean)
  let cursor = dirAbs
  for (const segment of segments) {
    cursor = join(cursor, segment)
    let info
    try {
      info = await lstat(cursor)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink()) throw escapeError()
  }
}

/* ------------------------------- 小工具 ------------------------------- */

/** 列目录，目录不存在就是空目录——list/clear 对"还没导出过"必须返回空结果，不能把 ENOENT 抛给 UI。 */
async function safeReaddir(dirAbs) {
  try {
    return await readdir(dirAbs, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
}

/** 文件名里的时间戳用本地时间：这份文件名是给人看的（"昨天下午三点那份"），不是排序依据。 */
function stampOf(now) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function normalizeFormat(format) {
  const value = String(format ?? '').toLowerCase()
  if (!value) return 'markdown'
  if (value === 'markdown' || value === 'md') return 'markdown'
  if (value === 'json') return 'json'
  throw new Error(`unsupported export format: ${String(format)}`)
}

/**
 * 分数只取整数段，缺失返回 `na`。
 *
 * 之所以先在内存里定下字符串再拼名字，是因为文件名是要被正则反解的：
 * `78.6`（含点）会让 `\.(md|json)$` 之前的 `[\w-]+` 失配，整份文件从此在列表里消失。
 * `-0` 也在这里挡掉：`Math.round(-0.2)` 是 `-0`，字符串化会变成 `-0`，看着像负分。
 */
function scoreToken(report) {
  const raw = report?.summary?.score
  let num = NaN
  if (typeof raw === 'number') num = raw
  else if (typeof raw === 'string' && raw.trim() !== '') num = Number(raw)
  if (!Number.isFinite(num)) return 'na'
  const int = Math.round(num)
  return String(Object.is(int, -0) ? 0 : int)
}

/** 从文件名反解 score。解析不到（`na`、`60-2` 这类）就是 null——"未知"和"0 分"必须能区分。 */
function parseScore(name) {
  const token = EXPORT_RE.exec(name)?.[1]
  return token && /^-?\d+$/.test(token) ? Number(token) : null
}

/** format 由扩展名判定，不信目录里其他任何信息。 */
function formatOf(name) {
  return name.endsWith('.json') ? 'json' : 'markdown'
}

function normalizeCount(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(0, Math.floor(num))
}

/** 正文来源：优先调用方给好的 text；只有在 format=json 且给了 report 时才允许代劳序列化。 */
function resolveText(input, format) {
  if (typeof input.text === 'string') return input.text
  if (input.text == null && format === 'json' && input.report && typeof input.report === 'object') {
    return `${JSON.stringify(input.report, null, 2)}\n`
  }
  throw new TypeError('exportReport: input.text must be a string')
}

/* ------------------------------- 导出 ------------------------------- */

/**
 * 原子写入一份导出。
 *
 * 为什么必须 tmp → rename：历史列表是按目录内容实时列出来的，直接往最终名写入的话，
 * 列表随时可能读到"写了一半"的文件——用户点开就是半截 JSON，或者一个 0 字节的 md。
 * tmp 是列表正则匹配不到的名字，写完整了再一次 rename 换上去，列表要么看不到它，要么看到完整的它。
 *
 * 为什么不覆盖：历史的价值在于"每一次体检都留得住"。
 * 同一秒、同一分数导出两次是正常操作（比如改动配置后立刻复检），
 * 如果第二次覆盖第一次，用户就永久丢掉了上一次的证据。所以先 `wx` 独占抢名，撞了就追加 `-2`、`-3`。
 *
 * @param {{ text: string, format?: 'markdown'|'json', report?: object, home?: string, dir?: string, now?: number, keep?: number }} input
 * @returns {Promise<{ path: string, name: string, format: string, bytes: number, createdAt: number, score: number|null }>}
 */
export async function exportReport(input = {}) {
  const format = normalizeFormat(input.format)
  const text = resolveText(input, format)
  const dirAbs = exportsDir({ dir: input.dir, home: input.home })
  const createdAt = Number.isFinite(input.now) ? Number(input.now) : Date.now()
  const token = scoreToken(input.report)
  const ext = FORMAT_EXT[format]
  const base = `${stampOf(createdAt)}-${token}`

  // 目录不存在时自动建。用户在全新 profile 上点"导出"不该先收到一个 ENOENT。
  await mkdir(dirAbs, { recursive: true })

  /* ---- 第一步：抢名字。wx = O_CREAT|O_EXCL，创建即占有，天然互斥，不会覆盖已有文件 ---- */
  let target = null
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? `${base}.${ext}` : `${base}-${attempt}.${ext}`
    const full = join(dirAbs, name)
    let handle = null
    try {
      handle = await open(full, 'wx')
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'EISDIR' || error?.code === 'EPERM') continue
      throw error
    }
    await handle.close()
    target = full
    break
  }
  if (!target) {
    throw new Error(`export name collision after ${MAX_NAME_ATTEMPTS} attempts: ${base}.${ext}`)
  }

  /* ---- 第二步：写 tmp，再 rename 到已经占住的最终名 ---- */
  const tmpPath = `${target}${TMP_MARK}${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  try {
    await writeFile(tmpPath, text, 'utf8')
    // rename 换名是同一文件系统内的原子操作；Windows 上 rename 会替换已存在的目标，
    // 而目标是我们刚刚用 wx 占住的空文件，替换它正是预期行为。
    await rename(tmpPath, target)
  } catch (error) {
    // 失败路径必须两头都清：tmp 清掉免得变成残骸；占名留下的空文件也要清掉，
    // 否则历史列表里会多出一条 0 字节、点开啥也没有的"报告"。
    await unlink(tmpPath).catch(() => {})
    await unlink(target).catch(() => {})
    throw error
  }

  /* ---- 第三步：保留策略。失败不影响已经落盘的文件，所以吞掉异常 ---- */
  // 至少留 1 份：调用方传 keep=0 时如果照做，刚写出来的这份立刻就被自己删了。
  const keep = input.keep === undefined || input.keep === null
    ? MAX_KEEP
    : Math.max(1, normalizeCount(input.keep, MAX_KEEP))
  try {
    await applyRetention({ dir: dirAbs, keep, now: createdAt })
  } catch {
    /* 保留策略是维护动作，写成功就该算成功 */
  }

  const info = await lstat(target)
  return {
    path: target,
    name: basename(target),
    format,
    bytes: info.size,
    createdAt,
    score: token === 'na' ? null : Number(token),
  }
}

/* ------------------------------- 列表 ------------------------------- */

/**
 * 历史列表，按 createdAt 倒序。
 *
 * createdAt 取文件 mtime 而不是从文件名解析：文件名只有秒精度，而 mtime 是真实写入时刻，
 * 连续导出的几份也能稳定排出先后（文件名相同秒时靠名字兜底）。文件名里的时间戳是给人看的。
 *
 * 只认 EXPORT_RE 命中的普通文件：符号链接、子目录、`.tmp-*` 残骸、用户手放的文件全都不进列表。
 *
 * @param {{ home?: string, dir?: string, limit?: number }} options
 */
export async function listExports(options = {}) {
  const dirAbs = exportsDir(options)
  const limit = normalizeCount(options.limit, 20)
  const entries = await safeReaddir(dirAbs)
  const items = []

  for (const entry of entries) {
    if (!EXPORT_RE.test(entry.name)) continue
    // dirent 的 isFile() 对符号链接是 false，这里就挡掉了"链接冒充历史文件"。
    if (!entry.isFile()) continue
    const full = join(dirAbs, entry.name)
    let info
    try {
      info = await lstat(full)
    } catch {
      continue // 列目录与 lstat 之间被删了，跳过即可，不该让整次列表失败
    }
    if (!info.isFile() || info.isSymbolicLink()) continue
    items.push({
      name: entry.name,
      path: full,
      format: formatOf(entry.name),
      bytes: info.size,
      createdAt: Math.round(info.mtimeMs),
      score: parseScore(entry.name),
    })
  }

  // mtime 相同（同一毫秒写两次）时按名字倒序：名字里带秒级时间戳，等价于"后写的在前"。
  items.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return items.slice(0, limit)
}

/* ------------------------------- 读取 ------------------------------- */

/**
 * 读一份历史文件的文本。
 *
 * 这是唯一会按"外部传入路径"打开文件的入口，所以在真正 open 之前必须过三道闸：
 * 前缀归属（isInsideDir，含 Windows 大小写折叠）、符号链接（逐段 lstat）、普通文件（不是目录/设备）。
 * 任一道不过就抛 `path escapes exports dir`。
 *
 * @param {string} targetPath
 * @param {{ home?: string, dir?: string }} options
 */
export async function readExport(targetPath, options = {}) {
  const dirAbs = exportsDir(options)
  const targetAbs = resolve(String(targetPath ?? ''))
  if (!isInsideDir(dirAbs, targetAbs)) throw escapeError()

  await assertNoSymlink(dirAbs, targetAbs)

  const info = await lstat(targetAbs)
  if (info.isSymbolicLink()) throw escapeError()
  if (!info.isFile()) throw new Error(`not a regular file: ${basename(targetAbs)}`)
  return readFile(targetAbs, 'utf8')
}

/* ------------------------------- 清理 ------------------------------- */

/**
 * 清理历史。
 * - all=true：删掉目录下所有导出文件，但**保留目录本身**（下一次导出不用再 mkdir），也不递归子目录。
 * - 否则保留最新 keep 份（默认 0 = 全删）。
 *
 * 只删 EXPORT_RE 命中的普通文件：`notes.txt`、`.tmp-*` 这类不属于本模块的东西一行都不碰。
 *
 * @param {{ home?: string, dir?: string, all?: boolean, keep?: number }} options
 * @returns {Promise<{ removed: number, bytes: number, dir: string }>}
 */
export async function clearExports(options = {}) {
  const dirAbs = exportsDir(options)
  const keep = options.all ? 0 : normalizeCount(options.keep, 0)
  const items = await listExports({ dir: dirAbs, limit: Number.MAX_SAFE_INTEGER })
  const victims = items.slice(keep)

  let removed = 0
  let bytes = 0
  for (const item of victims) {
    try {
      await unlink(item.path)
      removed += 1
      bytes += item.bytes
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return { removed, bytes, dir: dirAbs }
}

/**
 * 保留最新 keep 份（默认 MAX_KEEP），返回被删除的**导出文件**数量。
 *
 * 顺带清理超过 1 小时的 tmp 残留。tmp 不计入返回值：调用方拿这个数字判断"保留策略删了几份报告"，
 * 把进程崩溃留下的半截文件混进去会让数字失去意义。
 *
 * 只处理普通文件且名字里带 `.tmp-`：不递归、不碰子目录、不对符号链接动手（unlink 链接虽然安全，
 * 但这里没有清理链接的正当理由，少做一件事就少一个误删的机会）。
 *
 * @param {{ home?: string, dir?: string, keep?: number, now?: number }} options
 */
export async function applyRetention(options = {}) {
  const dirAbs = exportsDir(options)
  const keep = normalizeCount(options.keep, MAX_KEEP)
  const items = await listExports({ dir: dirAbs, limit: Number.MAX_SAFE_INTEGER })

  let removed = 0
  for (const item of items.slice(keep)) {
    try {
      await unlink(item.path)
      removed += 1
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  await sweepStaleTmp(dirAbs, Number.isFinite(options.now) ? Number(options.now) : Date.now())
  return removed
}

/** 清掉过期的 tmp。目录不存在时 safeReaddir 返回空，天然是 no-op。 */
async function sweepStaleTmp(dirAbs, now) {
  const entries = await safeReaddir(dirAbs)
  for (const entry of entries) {
    if (!entry.name.includes(TMP_MARK)) continue
    if (!entry.isFile()) continue
    const full = join(dirAbs, entry.name)
    let info
    try {
      info = await lstat(full)
    } catch {
      continue
    }
    if (!info.isFile() || info.isSymbolicLink()) continue
    if (now - info.mtimeMs <= TMP_TTL_MS) continue
    try {
      await unlink(full)
    } catch {
      /* 被别人抢先删了 / 被占用，留给下一轮 */
    }
  }
}
