/**
 * DSH Doctor — 探测原语（纯 Node 内置模块，无第三方依赖）。
 *
 * 这一层只做「读文件 / 判断存在 / 比版本 / 探端口」这类无副作用动作，不做任何判定。
 * 判定全部在 rules.js 里，采集在 facts.js 里，三者分开是为了：
 * 1. 规则可以用合成的 facts 单测（不需要真实机器处于故障状态）；
 * 2. 采集失败不会变成「判定失败」，采集异常一律落到 unknown。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'

export function readJson(file) {
  try {
    return JSON.parse(stripBom(readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * 去掉 UTF-8 BOM。这不是洁癖：Windows PowerShell 的 `Set-Content -Encoding utf8`
 * 会写 BOM，而 `JSON.parse` 遇 BOM 直接抛 —— 我们就踩过这个坑（profile 的
 * package.json 带 BOM 时 pnpm 安装被 DSH 拒绝：Cannot validate installed package）。
 * 读别人的文件时按「宽容读取」处理，写自己的文件时保证无 BOM。
 */
export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function readText(file) {
  try {
    return stripBom(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export function dirEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

export function statSafe(path) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)}${units[i]}`
}

export function basenameOf(path) {
  const trimmed = String(path ?? '').replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

export function majorOf(version) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''))
  return m ? Number(m[1]) : undefined
}

export function compareVersion(a, b) {
  const pa = String(a ?? '').split('.').map((n) => Number(n) || 0)
  const pb = String(b ?? '').split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/** "0.2.1-rc.2" -> [0,2,1]，预发布标签按基线版本处理（够用且不引入 semver 依赖）。 */
export function versionTuple(version) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

export function compareTuple(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * 极简 semver 区间判断。支持：
 * - OR 组：`^22.19.0 || >=24.0.0`（任一组成立即成立）
 * - 组内 AND：`>=0.2.0-rc.1 <0.3.0-0`
 * - 运算符：>= <= > < = ^ ~，缺省按 `=`
 * - 允许两段写法 `^22.19`（自动补 .0）
 * 完全无法解析时返回 undefined（对调用方表示「不敢判断」），绝不猜 false ——
 * 猜 false 会把健康机器报成故障（实测踩过：`^22.19.0 || >=24.0.0` 被判不匹配）。
 */
export function satisfiesRange(version, range) {
  const v = versionTuple(version)
  if (!v) return undefined
  const groups = String(range)
    .split('||')
    .map((g) => g.trim())
    .filter(Boolean)
  if (groups.length === 0) return undefined
  let sawUndecidable = false
  for (const group of groups) {
    const verdict = satisfiesGroup(v, group)
    if (verdict === true) return true
    if (verdict === undefined) sawUndecidable = true
  }
  return sawUndecidable ? undefined : false
}

/** 单个 AND 组的判定：true / false / undefined（组内一条都没解析出来）。 */
function satisfiesGroup(v, group) {
  const clauses = group.split(/\s+/).filter(Boolean)
  let judged = false
  for (const clause of clauses) {
    // 允许 1~3 段数字：^22 / ^22.19 / ^22.19.0
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
    else if (op === '^') ok = v[0] === t[0] && c >= 0
    else if (op === '~') ok = v[0] === t[0] && v[1] === t[1] && c >= 0
    else ok = c === 0
    if (!ok) return false
  }
  return judged ? true : undefined
}

/**
 * 判断某个目录是不是「DSH 安装根」。
 * 三种都能认：CLI 独立安装（name=dsh）、桌面版（@deepseek-ai/dsh-desktop-runtime）、
 * 以及任何自带 node_modules/@deepseek-ai/dsh 的骨架目录。
 */
export function isDshRoot(dir) {
  if (!dir) return false
  const pkg = readJson(join(dir, 'package.json'))
  if (pkg && (pkg.name === 'dsh' || pkg.name === '@deepseek-ai/dsh-desktop-runtime')) return true
  return existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

/** 从任意入口文件向上找 DSH 安装根。 */
export function walkUpToDshRoot(startFile) {
  let dir = startFile ? dirname(startFile) : undefined
  for (let i = 0; dir && i < 12; i += 1) {
    if (isDshRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 返回 { root, source }：找到安装根，以及它来自哪条判定线索。 */
export function detectDshRoot(env) {
  const candidates = []
  if (env.DSH_APP_ROOT) candidates.push([env.DSH_APP_ROOT, 'env DSH_APP_ROOT'])
  if (env.DSH_INSTALL_DIR) candidates.push([env.DSH_INSTALL_DIR, 'env DSH_INSTALL_DIR'])
  // 桌面版：Electron 主进程 + 内置 node 运行时
  const nodeExe = env.DSH_DESKTOP_NODE_EXECUTABLE
  if (nodeExe) candidates.push([dirname(dirname(nodeExe)), 'env DSH_DESKTOP_NODE_EXECUTABLE'])
  const exeDir = dirname(process.execPath || '')
  if (exeDir) {
    candidates.push([join(exeDir, 'resources', 'app', 'dsh'), 'resources/app/dsh（相对可执行文件）'])
    candidates.push([join(exeDir, 'resources', 'app'), 'resources/app（相对可执行文件）'])
  }
  const fromArgv = walkUpToDshRoot(process.argv?.[1])
  if (fromArgv) candidates.push([fromArgv, 'process.argv[1] 向上查找'])
  for (const [candidate, source] of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue
    if (isDshRoot(candidate)) return { root: candidate, source }
  }
  return { root: undefined, source: undefined }
}

/** 读取 DSH 核心包（@deepseek-ai/dsh）的清单，拿版本与引擎约束。 */
export function readDshCorePkg(root) {
  return root ? readJson(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')) : undefined
}

/**
 * 解析 profile 的 cordis.patch.yml，尽力而行（不引 yaml 依赖）。
 * 只认「行首缩进 <= 2 的 - id:」作为补丁行起点，config 里嵌套的 - id:
 * （例如 providers 的 models 列表）不算；name 取同一行块内缩进更深的 name:。
 */
export function scanPatchRows(file) {
  const text = readText(file)
  if (text === undefined) return undefined
  const rows = []
  let current
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const idMatch = /^-\s*id:\s*(.+)$/.exec(trimmed)
    if (idMatch && indent <= 2) {
      const id = idMatch[1].trim().replace(/^['"]|['"]$/g, '')
      current = { id, indent, name: undefined, disabled: undefined }
      rows.push(current)
      continue
    }
    if (!current) continue
    if (indent <= current.indent) {
      // 同级但不是 id 行（数组里的其它条目或不良缩进）→ 当前行块结束
      current = undefined
      continue
    }
    if (indent !== current.indent + 2) continue
    if (/^name:/.test(trimmed)) {
      current.name = trimmed.slice(5).trim().replace(/^['"]|['"]$/g, '')
    } else if (/^disabled:/.test(trimmed)) {
      current.disabled = /^true$/i.test(trimmed.slice(9).trim())
    }
  }
  return { text, rows }
}

/** 把 "@scope/pkg/sub" 收敛成 "@scope/pkg"，"pkg/sub" 收敛成 "pkg"。 */
export function packageRootOf(spec) {
  if (!spec) return undefined
  const parts = String(spec).split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** 该包在哪些 node_modules 根里能找到。 */
export function packageLocations(packageName, roots) {
  const found = []
  for (const root of roots) {
    if (!root) continue
    if (existsSync(join(root, ...packageName.split('/'), 'package.json'))) found.push(root)
  }
  return found
}

/** 短超时 TCP 探测：只确认端口在监听，不发 HTTP。 */
export function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 临时目录写探测：写一个小文件再删掉，绝不留在系统里。 */
export function probeTempWritable(dir = tmpdir()) {
  const file = join(dir, `dsh-doctor-probe-${process.pid}-${Date.now()}.tmp`)
  let ok = false
  try {
    writeFileSync(file, 'ok')
    ok = true
  } catch {
    ok = false
  } finally {
    try {
      if (ok) unlinkSync(file)
    } catch {
      /* 探测文件残留无害，忽略 */
    }
  }
  return ok
}

/** Node 是否有 zstd 解压能力（会话日志是 session.v4.jsonl.zstd）。 */
export function zstdSupport() {
  try {
    // 只在需要时才加载，避免老版本 Node 直接抛在模块顶层的 import 上
    const zlib = globalThis.process?.getBuiltinModule?.('node:zlib')
    return Boolean(zlib && typeof zlib.zstdDecompressSync === 'function')
  } catch {
    return false
  }
}

export function tryJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 文件是否以 UTF-8 BOM 开头（BOM 会让 JSON.parse 和 pnpm 直接失败）。 */
export function hasBom(file) {
  try {
    const buf = readFileSync(file)
    return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  } catch {
    return undefined
  }
}

/**
 * 只按标准 Zstd frame container 结构算出下一帧的结束偏移，不做解压。
 *
 * 不能靠扫魔数切帧：RAW/RLE/压缩块的载荷里都可能出现 `28 B5 2F FD`。
 * 也不能靠 `zstdDecompressSync` 判完整性：Node 22.19.0 对残帧空返回不抛错
 * （实测 `info: true` 的 `engine.bytesWritten` 只等于输入消费量，残帧同样是全长，
 * 不是流完整信号）。结构决定边界，完整性由结构证明，再把整帧交给原解压器。
 * 返回 { end } 或 { error }。
 */
function zstdFrameEnd(buf, start) {
  let at = start + 4
  if (at >= buf.length) return { error: '帧头截断' }
  const descriptor = buf[at]
  at += 1
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  if (descriptor & 0x18) return { error: '帧头保留位非零' } // 0x10 Unused_bit、0x08 Reserved_bit
  if (!singleSegment) at += 1 // Window_Descriptor
  at += [0, 1, 2, 4][descriptor & 3] // Dictionary_ID
  at += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag] // Frame_Content_Size
  if (at > buf.length) return { error: '帧头截断' }
  for (;;) {
    if (at + 3 > buf.length) return { error: '块头截断' }
    const header = buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16)
    const type = (header >> 1) & 3
    if (type === 3) return { error: '块类型为保留值' }
    at += 3 + (type === 1 ? 1 : header >>> 3) // RLE 块只带 1 字节载荷，Block_Size 是解压后大小
    if (at > buf.length) return { error: '块数据截断' }
    if (header & 1) break // Last_Block
  }
  if (descriptor & 0x4) at += 4 // Content_Checksum
  if (at > buf.length) return { error: '内容校验和截断' }
  return { end: at }
}

/**
 * 读取会话日志 `session.v4.jsonl.zstd`。
 *
 * 实测（docs/research/logs-and-modes.md）：DSH 写的是**多帧 zstd**，
 * 对整个 buffer 调一次 `zstdDecompressSync` 只会解出第一帧（207 B / 1 行），
 * 必须逐帧解压（同一文件分帧解出 8.3 MB / 2841 行）。
 * 帧边界由 `zstdFrameEnd` 按容器结构决定；未结束的帧、非帧起点的残留字节一律记 error，
 * 让上层把该文件当不可读（不重写），绝不把残余字节当完整读取。
 * 返回 { frames, bytes, lines, text, error }，任何异常都进 error，不抛。
 */
export function readZstdJsonl(file, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const out = { frames: 0, bytes: 0, lines: 0, text: '', error: undefined }
  let buf
  try {
    buf = readFileSync(file)
  } catch (error) {
    out.error = String(error?.message ?? error)
    return out
  }
  out.bytes = buf.length
  if (buf.length > maxBytes) {
    out.error = `文件 ${buf.length} B 超过上限 ${maxBytes} B，已跳过`
    return out
  }
  const zlib = globalThis.process?.getBuiltinModule?.('node:zlib')
  if (!zlib || typeof zlib.zstdDecompressSync !== 'function') {
    out.error = '当前 Node 没有 zstdDecompressSync'
    return out
  }
  if (buf.length === 0) {
    out.error = '没有找到 zstd 帧魔数'
    return out
  }
  // 先按容器结构切帧；结构一旦不确定就记 error 并停止，剩下的字节算未读
  const spans = []
  let at = 0
  while (at < buf.length) {
    if (!(buf[at] === 0x28 && buf[at + 1] === 0xb5 && buf[at + 2] === 0x2f && buf[at + 3] === 0xfd)) {
      out.error = at === 0 ? '没有找到 zstd 帧魔数' : `偏移 ${at} 起的 ${buf.length - at} B 不是 zstd 帧起点（skippable/垃圾/残帧）`
      break
    }
    const framed = zstdFrameEnd(buf, at)
    if (framed.error) {
      out.error = `第 ${spans.length + 1} 帧结构不完整：${framed.error}（偏移 ${at}）`
      break
    }
    spans.push([at, framed.end])
    at = framed.end
  }
  const chunks = []
  for (let i = 0; i < spans.length; i += 1) {
    const [from, to] = spans[i]
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(from, to)))
      out.frames += 1
    } catch (error) {
      // 结构完整但载荷坏掉：记 error 并继续解后面的帧（部分可读仍要挡住重写）
      out.error ??= `第 ${i + 1} 帧解压失败：${String(error?.message ?? error)}`
    }
  }
  out.text = Buffer.concat(chunks).toString('utf8')
  out.lines = out.text ? out.text.split('\n').filter(Boolean).length : 0
  return out
}
