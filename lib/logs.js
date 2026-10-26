/**
 * DSH Doctor — 日志分析层（纯 Node 内置模块，零第三方依赖，全只读）。
 *
 * 为什么单独一层：facts.js 只统计「有多少个会话文件、多少字节」，那回答不了
 * 「到底哪里坏了」。日志里才有一手错误，但它同时是**最大的隐私面**——
 * session 文件里必然夹带用户对话、文件正文、可能的密钥。所以这一层的契约是：
 *
 * 1. 进来的是文件路径，出去的是**已脱敏的错误签名**，不是日志原文；
 * 2. 任何异常都进 error 字段，绝不抛（Doctor 自己不能因为读不了日志而崩）；
 * 3. 处处有上限（单文件 / 总量 / 行数 / 每类文件数），宁可漏采样也不许爆内存。
 *
 * 事实来源：docs/research/logs-and-modes.md。路径、格式、真实错误样本全部来自那份实测，
 * 本文档不发明路径；规则表里凡是研究文档标注「未找到真实样本」的模式，一律 verified: false，
 * 「验证标记」是有意义的信息，不是装饰。
 */
import { openSync, closeSync, fstatSync, readSync, accessSync, existsSync, constants as fsConstants } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { tmpdir, platform } from 'node:os'
import { readText, readZstdJsonl, statSafe, dirEntries, stripBom } from './probe.js'

/** 7 类日志源。顺序即「报告里的分组顺序」，与 KIND_PRIORITY（采样优先级）刻意不同： */
export const LOG_KINDS = ['session', 'crash', 'pnpm', 'market', 'gateway', 'diagnostic', 'temp']

/**
 * 采样优先级（研究文档 §5 按价值排序）：崩溃快照唯一带版本指纹，最值钱；
 * 会话流是运行时真相；pnpm/市场是安装期错误。**大文件排在前面**是有意的——
 * 总量预算耗尽时被丢掉的应该是小得多、信息密度也低得多的 %TEMP% 噪声，
 * 而不是 6MB 的会话流。
 */
const KIND_PRIORITY = ['crash', 'session', 'pnpm', 'market', 'gateway', 'diagnostic', 'temp']

const DEFAULT_MAX_FILES = 20
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_LINES = 4000
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 500
/** 「当前故障」窗口：默认只看最近 24 小时。 */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

/** 一条错误输出到报告里的硬上限；脱敏前先粗切到 5 倍，避免对 65KB 的正文跑正则。 */
const ENTRY_CHARS = 400
const PRE_MASK_CHARS = ENTRY_CHARS * 5
/** 签名只取前 160 字：聚类键要短，长尾差异反而会把同一类错误拆散。 */
const SIGNATURE_CHARS = 160

const SEVERITY_RANK = { error: 3, warning: 2, info: 1 }

/* ------------------------------------------------------------------ *
 * 1. 分类规则
 * ------------------------------------------------------------------ */

/**
 * 单行错误规则表。**只收录研究文档 §4 有真实原文样本的模式**。
 *
 * verified: true  = 有真实运行时原文（行号已核对）
 * verified: false = 研究文档明确写「未找到真实运行时样本」，命中全部落在提示词/源码常量里。
 *                  保留规则但标记未验证，等真实样本出现再翻牌子——这样报告里引用它时
 *                  能明确知道「这条判断没有样本背书」。
 *
 * 顺序即优先级，第一个命中即返回，所以「具体 → 泛化」必须严格排列
 * （例如 getaddrinfo 必须排在 fetch failed 前面，否则样本 5 会被归错类）。
 */
export const LINE_RULES = [
  // —— 崩溃快照（Electron 侧，最权威）——
  { kind: 'host-exit', severity: 'error', verified: true, re: /dsh desktop host exited with \d+/i },
  { kind: 'web-boot-inactive', severity: 'error', verified: true, re: /web boot: \d+ entr(?:y|ies) did not activate/i },

  // —— 会话流里的工具执行失败 ——
  { kind: 'module-not-found', severity: 'error', verified: true, re: /Cannot find module/i },
  // 文档 §4 样本 5：Error: web fetch failed: Error: getaddrinfo ENOENT web.qq.com
  { kind: 'dns-lookup-failed', severity: 'error', verified: true, re: /getaddrinfo\s+(?:ENOENT|ENOTFOUND|EAI_AGAIN)/i },
  { kind: 'unsupported-content-type', severity: 'warning', verified: true, re: /unsupported content type/i },
  // 文档 §4 样本 9：Chromium USB 噪声，单文件里同一行出现 3 次 —— 聚类的主要来源
  { kind: 'usb-guid-parse', severity: 'warning', verified: true, re: /Failed to parse device interface GUID/i },
  // 文档 §4 样本 6：Error: web fetch failed: TypeError: fetch failed
  { kind: 'fetch-failed', severity: 'error', verified: true, re: /(?:TypeError: )?fetch failed/i },

  // —— 插件安装（pnpm）——
  { kind: 'pnpm-error', severity: 'error', verified: true, re: /\[(ERR_PNPM_[A-Z0-9_]+)\]/ },
  { kind: 'peer-dependency', severity: 'warning', verified: true, re: /Issues with peer dependencies found/i },
  { kind: 'connection-reset', severity: 'warning', verified: true, re: /\bECONNRESET\b/ },

  // —— IM 网关 ——
  { kind: 'credential-insufficient', severity: 'error', verified: true, re: /凭据不足/ },

  // —— 兜底：样本 3/4/6/7/8 的错误首行全部形如 "Error: ..."，匹配到具体规则之后才轮到它 ——
  { kind: 'generic-error', severity: 'error', verified: true, re: /^\s*(?:Error|TypeError|SyntaxError|RangeError|ReferenceError|AggregateError): /m },

  // —— 未验证：研究文档 §4 结尾表格明确记录「真实日志里未找到样本」——
  // EADDRINUSE 的 11 次命中全落在本轮任务的提示词文本里；ETIMEDOUT 全部落在被引用的
  // JS 源码字符串 `attempt.error.code === 'ETIMEDOUT'`；401/429 是源码常量与模型推理文本。
  // 这里写得刻意窄（要求 HTTP/status 上下文），因为裸 \b401\b 会命中任何序号或字节数 ——
  // 未验证 + 宽正则 = 稳定的误报制造机。
  { kind: 'port-in-use', severity: 'error', verified: false, re: /\bEADDRINUSE\b/ },
  { kind: 'network-timeout', severity: 'warning', verified: false, re: /\bETIMEDOUT\b/ },
  { kind: 'http-unauthorized', severity: 'warning', verified: false, re: /(?:HTTP\/[\d.]+\s*401|status(?:Code)?["'\s:=]*401|401 Unauthorized)/i },
  { kind: 'http-rate-limited', severity: 'warning', verified: false, re: /(?:HTTP\/[\d.]+\s*429|status(?:Code)?["'\s:=]*429|429 Too Many Requests)/i },
]

/* ------------------------------------------------------------------ *
 * 2. 脱敏
 * ------------------------------------------------------------------ */

/**
 * 泄漏模式的**唯一定义**：maskSecrets（替换）和 scanLeaks（只计数）共用同一张表，
 * 否则两条路径迟早会出现「一个说没有、一个说有」的矛盾。
 * 用 source + flags 字符串而不是 RegExp 字面量，是因为带 g 标志的 RegExp 有 lastIndex 状态，
 * 复用实例会漏判（同一对象第二次 match 从上次位置continue）。
 *
 * keepGroups: 只抹「值」、保留「键名」，例如 `apiKey: xxx` → `apiKey: [REDACTED:apiKey]`。
 * 保留键名不是手软，是让报告能说清「泄漏的是哪一类凭据」。
 */
const SECRET_PATTERNS = [
  // DeepSeek / OpenAI / Anthropic 风格：一律要求 20 位以上，`sk-xxx`、`sk-test` 这类占位符进不来
  { name: 'key', source: '\\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}', flags: 'g' },
  // 常见平台令牌（GitHub / HuggingFace / Slack / AWS）
  {
    name: 'key',
    source: '\\b(?:ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|hf_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\\b',
    flags: 'g',
  },
  {
    name: 'bearer',
    // 值必须够长，且不能是文档里的占位写法：Bearer <token>、Bearer xxx、Bearer [REDACTED]
    source: '\\bBearer\\s+(?![<\\[*])(?!(?:redacted|xxx+|example|placeholder|your[_-]?token|test)\\b)[A-Za-z0-9._~+/=-]{20,}',
    flags: 'gi',
  },
  {
    name: 'apiKey',
    // 必须「键名 + 引号包裹的长值」，裸的 apiKey: xxx 是代码/文档，不是泄漏
    source:
      '(?:api[_-]?key|access[_-]?token|client[_-]?secret|refresh[_-]?token)("?\\s*[:=]\\s*")(?!(?:your|example|placeholder|xxx|test|demo|redacted)\\b)[A-Za-z0-9_./+=-]{24,}',
    flags: 'gi',
    keepGroups: 1,
  },
  // 长十六进制：sha256 附件 id、git hash、UUID 全都是正常内容，**只脱敏不计数**
  { name: 'hex', source: '\\b[0-9a-fA-F]{32,}\\b', flags: 'g', maskOnly: true },
  // JWT / PEM 私钥
  { name: 'other', source: '\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{6,}', flags: 'g' },
  { name: 'other', source: '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----', flags: 'g' },
]

function freshRe(pattern) {
  return new RegExp(pattern.source, pattern.flags)
}

/**
 * 把疑似密钥替换成 `[REDACTED:<类型>]`。
 * 返回命中计数，是为了让上层能回答「这条日志里泄漏了几处」，而不必看到值。
 */
export function maskSecrets(text) {
  const hits = { key: 0, bearer: 0, apiKey: 0, hex: 0, other: 0 }
  if (typeof text !== 'string' || text.length === 0) return { text: typeof text === 'string' ? text : '', hits }
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(freshRe(pattern), (...args) => {
      hits[pattern.name] += 1
      if (pattern.keepGroups) {
        // args = [match, g1, g2, ..., offset, string]。最后一个分组才是「值」，
        // 而键名（如 "apiKey"）是 match 里没被分组的字面量 —— 回调的返回值会替换**整个** match，
        // 所以必须显式把「值之前的那截」接回去，否则 `apiKey: xxx` 会变成 `[REDACTED:apiKey]`，
        // 报告就看不出泄漏的是哪一类凭据了。
        const value = String(args[pattern.keepGroups] ?? '')
        const head = value ? args[0].slice(0, args[0].length - value.length) : args[0]
        return head + `[REDACTED:${pattern.name}]`
      }
      return `[REDACTED:${pattern.name}]`
    })
  }
  return { text: out, hits }
}

/**
 * 只统计泄漏**数量与类型**，绝不返回命中的值。
 * 这是本模块唯一「可以对外说数」的泄漏接口：报告里写「发现 3 处疑似密钥」，
 * 而不是把密钥贴进报告。
 *
 * 为什么要 unique：同一把 key 会同时出现在用户消息、模型推理、工具结果和事件里，
 * 本机实测一把 key 能被记 86 次。只报次数会让人以为「泄漏了 86 把」，
 * 所以额外的 unique 用值的 sha256 前 12 位做去重键（不可逆、不落盘、不导出）。
 */
export function scanLeaks(text, options = {}) {
  const byType = {}
  const hashes = {}
  let total = 0
  let unique = 0
  if (typeof text !== 'string' || text.length === 0) return { total, unique, byType, hashes }
  for (const pattern of SECRET_PATTERNS) {
    // maskOnly 的模式只做替换、不参与「泄漏计数」：sha256 附件 id 与 git hash 遍地都是，
    // 把它们算成密钥会让报告第一屏永远在喊「发现 760 处密钥」，真正的问题反而被埋掉。
    if (pattern.maskOnly) continue
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    const re = new RegExp(pattern.source, flags)
    const seen = hashes[pattern.name] ?? new Set()
    hashes[pattern.name] = seen
    let m
    while ((m = re.exec(text)) !== null) {
      total += 1
      byType[pattern.name] = (byType[pattern.name] ?? 0) + 1
      seen.add(createHash('sha256').update(m[0]).digest('hex').slice(0, 12))
      if (m.index === re.lastIndex) re.lastIndex += 1
    }
  }
  for (const set of Object.values(hashes)) unique += set.size
  const out = { total, unique, byType }
  if (options.withHashes) out.hashes = hashes
  return out
}

/* ------------------------------------------------------------------ *
 * 3. 单行解析：从「一行」里取出真正该看的那段文本
 * ------------------------------------------------------------------ */

const ISO_RE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/

function timeOfLine(line) {
  const m = ISO_RE.exec(line)
  if (!m) return undefined
  const t = Date.parse(m[1])
  return Number.isFinite(t) ? t : undefined
}

/**
 * 把一行原始日志变成 `{ text, level, time }`，拿不到可分析文本时返回 undefined。
 *
 * 这是整层最关键的一段。会话日志**一行就是一整条 JSON 记录**，而 `assistant/message`
 * 记录的正文是模型的思考过程——里面会大量出现 "Error:"、"fetch failed" 这种字符串
 * （研究文档 §4 专门警告过：EADDRINUSE/ETIMEDOUT 的检索命中就全部来自这类文本）。
 * 直接对整行跑正则会把这些**讨论错误的文字**当成错误，报告立刻变成噪声机。
 * 所以：只有 `tool/result`(isError/exit≠0)、`job/settled`(失败终态)、以及
 * 结构化日志里 level=error/warn 的记录才允许贡献文本，用户/助手消息一律不读。
 */
/** JSON 里被 dump 出来的大字段（整段正文、整个请求体）折叠掉：sample 要能一眼看完。 */
function tidyJson(text, maxValue = 120) {
  return String(text ?? '').replace(/"([\w.-]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g, (match, key, value) =>
    value.length > maxValue ? `"${key}":"…"` : match,
  )
}

/** 取一段文本的第一行（工具的 stderr 常常是多行，签名只要首行）。 */
function firstLine(text) {
  const line = String(text ?? '').split('\n').find((l) => l.trim().length > 0)
  return line ? clip(line, 100) : ''
}

function recordCore(line) {
  if (typeof line !== 'string' || line.length === 0) return undefined
  const trimmed = line.trimStart()
  // 非 JSON 行（crash / pnpm / gateway / temp 全是纯文本）原样返回
  if (trimmed.charCodeAt(0) !== 0x7b) return { text: line, level: undefined, time: undefined }
  let record
  try {
    record = JSON.parse(trimmed)
  } catch {
    // 会话文件末帧可能被截断，半条 JSON 直接放弃（研究文档 §8：容忍末帧不完整）
    return undefined
  }
  if (!record || typeof record !== 'object') return undefined

  const time = Number.isFinite(record.time) ? record.time : undefined

  if (record.type === 'tool/result') {
    const message = record.data?.message
    const content = Array.isArray(message?.content) ? message.content : []
    let text = ''
    for (const part of content) {
      if (part && part.type === 'text' && typeof part.text === 'string') text += (text ? '\n' : '') + part.text
    }
    // 实测存在 isError=false 但正文含 exit=1 的记录（会话里的探测命令），
    // 所以失败判定不能只看 isError —— 但也不能只看 exit=1：读文档类工具的输出里
    // 本身就抄着 `exit=1` / `[stderr]` 这些字样，会把「读了一份日志分析文档」记成崩溃。
    // 折中：只在**输出开头**（工具真正打印退出码/错误流的位置）认这两个标记，
    // 正文深处的同款字样不算失败。
    const head = text.slice(0, 400)
    const looksFailed = message?.isError === true || /(^|\n)\s*exit=[1-9]/.test(head) || /\[stderr\]/.test(head)
    if (!looksFailed) return undefined
    const error = record.data?.error
    let hint = ''
    if (error && typeof error === 'object') {
      const label = [error.name, error.code].filter(Boolean).join(' ')
      if (label) text = `${label}${text ? ' ' + text : ''}`
      hint = label
    }
    if (!text) return undefined
    // 工具失败的签名 = 错误名/错误码 + 首行。首行里带着具体文件名，那正是「不同失败」的分界。
    return { text: tidyJson(text), level: undefined, time, hint: `${hint} ${firstLine(text)}`.trim() }
  }

  if (record.type === 'job/settled') {
    const status = String(record.data?.status ?? '')
    if (!/^(?:failed|error|errored|cancelled|aborted|timeout)$/i.test(status)) return undefined
    const kind = String(record.data?.kind ?? record.data?.label ?? 'job')
    const detail = [record.data?.kind, record.data?.label, record.data?.detail].filter((v) => typeof v === 'string').join(' ')
    return detail ? { text: tidyJson(detail), level: 'error', time, hint: `job ${status} ${kind}` } : undefined
  }

  // 市场事件流 / 诊断日志：字段是 {level, event, detail} 与 {level, area, message}
  const level = typeof record.level === 'string' ? record.level.toLowerCase() : undefined
  if (level === 'error' || level === 'warn' || level === 'warning') {
    const body = [record.event, record.area, record.message, record.detail].filter((v) => typeof v === 'string').join(' ')
    const clock = Number.isFinite(record.time) ? record.time : Date.parse(String(record.at ?? '')) || undefined
    // 结构化日志的签名优先用「事件名 + 错误码」：它们才是这一行属于哪一类的判据。
    // 只按消息归一化会把 update-rollback dsh-context / dshmarket / billion-context 拆成三组，
    // 而它们本质是同一个故障（already-installed 回滚失败），组数就是这么被撑到 200 的。
    const code = String(record.code ?? record.err?.code ?? record.data?.code ?? record.error?.code ?? '')
    const event = String(record.event ?? record.area ?? '')
    const hint = `${event} ${code}`.trim() || undefined
    if (!body) return { text: level, level, time, hint }
    return { text: tidyJson(body), level, time: Number.isFinite(clock) ? clock : time, hint }
  }
  // 其余（user/message、assistant/message、request/*、system/message、info 级日志）不解析
  return undefined
}

/** 共享的分类逻辑：规则优先，其次结构化 level。 */
function classifyCore(core) {
  if (!core) return undefined
  for (const rule of LINE_RULES) {
    if (rule.re.test(core.text)) return { kind: rule.kind, severity: rule.severity, verified: rule.verified }
  }
  // 结构化日志的 level=error 本身就是信号（市场日志：update-rollback / exit=1）
  if (core.level === 'error') return { kind: 'log-level-error', severity: 'error', verified: true }
  return undefined
}

/**
 * 分类单行错误。返回 `{ kind, severity }`，不是错误行返回 undefined。
 * kind 是稳定的小写标识符（报告、规则、单测都靠它对齐，不许中途改名）。
 */
export function classifyLine(line) {
  const verdict = classifyCore(recordCore(line))
  if (!verdict) return undefined
  return { kind: verdict.kind, severity: verdict.severity }
}

/* ------------------------------------------------------------------ *
 * 4. 抽取错误行
 * ------------------------------------------------------------------ */

function clip(text, maxChars) {
  const s = String(text ?? '')
  // 多行 stderr 压成一行：报告是一条错误一行，不展开堆栈（堆栈首帧在签名里已保留信息量）
  const flat = s.replace(/\r\n|\r|\n/g, ' ⏎ ').replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? flat.slice(0, maxChars) + '…' : flat
}

/**
 * 从文本里抽错误行。返回 `Array<{ kind, severity, line, lineNo }>`。
 *
 * 额外的 `time` / `sourceId` 是给 clusterErrors 用的（可选字段，不影响解构）：
 * 聚类要算 firstSeenAt/lastSeenAt，而时间信息只在这一行或这个文件里才有。
 */
export function extractErrors(text, options = {}) {
  const { limit = DEFAULT_MAX_ENTRIES, sourceId, sourceMtimeMs } = options
  const out = []
  if (typeof text !== 'string' || text.length === 0) return out
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (out.length >= limit) break
    const raw = lines[i]
    // 便宜的前置过滤：短行不可能承载任何一条真实规则（最短的规则串 > 8 字）
    if (raw.length < 8) continue
    const core = recordCore(raw)
    if (!core) continue
    const verdict = classifyCore(core)
    if (!verdict) continue
    // 先粗切再脱敏：脱敏是对「真要输出的那点内容」做的，不是对 65KB 正文做的
    const masked = maskSecrets(clip(core.text, PRE_MASK_CHARS)).text
    const entry = {
      kind: verdict.kind,
      severity: verdict.severity,
      line: clip(masked, ENTRY_CHARS),
      lineNo: i + 1,
    }
    // 结构化日志/工具失败的签名由 recordCore 给出（事件名 + 错误码），比整行文本稳得多
    if (core.hint) entry.hint = signatureOf(core.hint)
    const time = core.time ?? timeOfLine(raw) ?? sourceMtimeMs
    if (Number.isFinite(time)) entry.time = time
    if (sourceId) entry.sourceId = sourceId
    out.push(entry)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 5. 聚类
 * ------------------------------------------------------------------ */

/**
 * 归一化掉「每条日志都不一样、但没有信息量」的部分：GUID、sessionId、URL、绝对路径、
 * 行列号、端口、长十六进制、所有数字。
 * 文档 §4 样本 9 是活教材：同一行 USB GUID 解析失败在单文件里出现 3 次，
 * 只有第五个字符之后的部分不同；不归一化的话「重复」永远统计不出来。
 *
 * 顺序有意：URL 要在 Windows 路径之前吃掉（否则 `http://x` 会被 `p:/` 规则切成 `<path>`）。
 */
function signatureOf(line) {
  let s = String(line ?? '')
  // 时间戳必须最先吃掉。实测：gateway.log 的同一句「凭据不足」出现 15 次，
  // 归一化后仍留下 `2026-10-21t06:<line>:<col>.912z` —— T 后面的 06 和 .912 没有
  // 词边界，\b\d+\b 规则抓不到，于是同一句错误被拆成 15 个 count=1 的组，
  // 「重复」这个最有价值的信号直接消失。研究文档 §5.4 的配方里本来就有「时间戳」。
  s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
  s = s.replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<ts>')
  s = s.replace(/\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<session>')
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"')]+/gi, '<url>')
  s = s.replace(/[A-Za-z]:[\\/][^\s"'(),;]*/g, '<path>')
  s = s.replace(/(?:^|[\s"'=(])\/(?:[\w.@%~-]+\/)+[\w.@%~-]+/g, (m) => m.replace(/\/.*$/, '<path>'))
  s = s.replace(/:\d+:\d+\b/g, ':<line>:<col>')
  s = s.replace(/:\d{2,5}\b/g, ':<port>')
  s = s.replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
  s = s.replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
  s = s.replace(/\b\d+(?:\.\d+)*\b/g, '<n>')
  s = s.replace(/\s+/g, ' ').trim().toLowerCase()
  return s.slice(0, SIGNATURE_CHARS)
}

/**
 * 聚类：按 kind + 归一化签名去重，count 降序。
 * 输入是 extractErrors 的返回值（可以来自多个文件、多个 kind，靠 entry.sourceId 区分）。
 * sample / signature 都已经脱敏过，这里只做聚合，不重新接触原文。
 */
export function clusterErrors(entries, options = {}) {
  const { limit = 200 } = options
  const buckets = new Map()
  const list = Array.isArray(entries) ? entries : []
  for (const entry of list) {
    if (!entry || typeof entry.kind !== 'string' || !entry.kind) continue
    // 有 hint 就用 hint（事件名+错误码），否则退回整行归一化签名
    const signature = entry.hint || signatureOf(entry.line)
    const key = `${entry.kind}\u0000${signature}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {
        kind: entry.kind,
        severity: entry.severity ?? 'warning',
        count: 0,
        signature,
        sample: entry.line ?? '',
        sourceIds: new Set(),
        firstMs: Number.POSITIVE_INFINITY,
        lastMs: Number.NEGATIVE_INFINITY,
      }
      buckets.set(key, bucket)
    }
    bucket.count += 1
    // 同一签名可能一次以 warning、一次以 error 出现（例如同类行在不同 kind 的源里）：取重的那个
    if ((SEVERITY_RANK[entry.severity] ?? 0) > (SEVERITY_RANK[bucket.severity] ?? 0)) bucket.severity = entry.severity
    if (entry.sourceId) bucket.sourceIds.add(entry.sourceId)
    if (Number.isFinite(entry.time)) {
      if (entry.time < bucket.firstMs) bucket.firstMs = entry.time
      if (entry.time > bucket.lastMs) bucket.lastMs = entry.time
    }
    // 样例取最短的那条：最短往往就是最干净的「错误首行」，长的通常是夹带了上下文的
    if (entry.line && entry.line.length < bucket.sample.length) bucket.sample = entry.line
  }
  return [...buckets.values()]
    .map((bucket) => {
      const row = {
        kind: bucket.kind,
        severity: bucket.severity,
        count: bucket.count,
        signature: bucket.signature,
        sample: bucket.sample,
        sourceIds: [...bucket.sourceIds].sort(),
      }
      if (Number.isFinite(bucket.firstMs)) row.firstSeenAt = new Date(bucket.firstMs).toISOString()
      if (Number.isFinite(bucket.lastMs)) row.lastSeenAt = new Date(bucket.lastMs).toISOString()
      return row
    })
    .sort((a, b) => b.count - a.count || (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || a.kind.localeCompare(b.kind))
    .slice(0, limit)
}

/* ------------------------------------------------------------------ *
 * 6. 发现日志源
 * ------------------------------------------------------------------ */

/**
 * Windows 上 %APPDATA% 可能没注入（服务、计划任务、某些子进程），
 * 那就从 home（`<用户>\.dsh`）反推 `<用户>\AppData\Roaming`。非 Windows 用 ~/.config。
 */
function appDataDir(env, home) {
  if (env.APPDATA) return env.APPDATA
  if (!home) return undefined
  return platform() === 'win32' ? join(dirname(home), 'AppData', 'Roaming') : join(dirname(home), '.config')
}

/**
 * Electron userData 目录候选。研究文档 §2 实测：DSH 的 userData 是
 * `%APPDATA%\@deepseek-ai\dsh-desktop`（package.json 的 name 带 scope，Electron 直接把 scope
 * 当子目录用）。**不要硬编码 "DeepSeek Harness"**——那是可执行文件名，不是目录名。
 * 后面两个只是别名兜底，按顺序命中。
 */
function userDataDirs(env, home) {
  const appData = appDataDir(env, home)
  if (!appData) return []
  return ['@deepseek-ai/dsh-desktop', 'DeepSeek Harness', 'com.deepseek.dsh'].map((name) => join(appData, name))
}

/**
 * 递归列文件（深度 0 = 只看本层）。符号链接当目录继续走，靠 depth 上限防环。
 * match 必须真的生效：`.dsh-market` 里除了 log.ndjson 还有一个 1MB 的
 * discovery-compatibility-v1.json，%TEMP% 里更是什么都有——不过滤就等于把
 * 一堆无关 JSON 当日志读，既慢又脏。
 */
function walkFiles(dir, depth, out, match) {
  if (!dir || depth < 0) return out
  for (const entry of dirEntries(dir)) {
    const full = join(dir, entry.name)
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (depth > 0) walkFiles(full, depth - 1, out, match)
      continue
    }
    if (match && !match.test(entry.name)) continue
    const stat = statSafe(full)
    if (!stat?.isFile()) continue
    out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs })
  }
  return out
}

function readableOf(path) {
  try {
    accessSync(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 每一类的「根目录 + 匹配 + 递归深度」。全部来自研究文档 §1/§2 的实测路径。
 * match 一律用 test() 前重置 lastIndex —— 这些正则都带 g，不重置会每轮跳过文件。
 */
function kindSpecs({ home, profileDir, env }) {
  const temp = env.TEMP || env.TMP || tmpdir()
  const specs = []

  if (home) {
    specs.push({
      kind: 'session',
      root: join(home, 'sessions'),
      depth: 3, // <workspace>/<sessionId>/session.v4.jsonl.zstd
      match: /\.(?:zstd|jsonl)$/i,
    })
    specs.push({ kind: 'gateway', root: join(home, 'dsh-im-connect'), depth: 1, match: /^gateway.*\.log$/i })
    specs.push({ kind: 'diagnostic', root: join(home, 'state'), depth: 2, match: /\.jsonl$/i })
  }
  for (const dir of userDataDirs(env, home)) {
    specs.push({ kind: 'crash', root: join(dir, 'logs'), depth: 1, match: /^crash-.*\.log$/i })
  }
  if (profileDir) {
    specs.push({ kind: 'pnpm', root: join(profileDir, '.plugin-manager', 'logs'), depth: 2, match: /\.log$/i })
    specs.push({ kind: 'market', root: join(profileDir, '.dsh-market'), depth: 1, match: /\.ndjson$/i })
  }
  // %TEMP% 只看本层：里面成千上万个子目录（各种安装器的临时目录）不是 DSH 的日志，
  // 递归进去只会把别人的东西读进来。本层就是 dsh-purge-desktop.log 与 .log.1。
  specs.push({ kind: 'temp', root: temp, depth: 0, match: /^dsh-.*\.log(?:\.\d+)?$/i })
  return specs
}

function toSource(spec, root, file) {
  const rel = file.path.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
  return {
    id: `${spec.kind}:${rel || basename(file.path)}`,
    kind: spec.kind,
    path: file.path,
    size: file.size,
    mtime: new Date(file.mtimeMs).toISOString(),
    readable: readableOf(file.path),
  }
}

/** 内部版：同时给出被 maxFiles 挤掉的候选，collectLogs 要把它们记进 skipped。 */
function discoverAll(options = {}) {
  const env = options.env ?? process.env
  const home = options.home
  const profileDir = options.profileDir
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES
  const kinds = Array.isArray(options.kinds) && options.kinds.length ? new Set(options.kinds) : undefined

  const picked = []
  const dropped = []
  for (const spec of kindSpecs({ home, profileDir, env })) {
    if (kinds && !kinds.has(spec.kind)) continue
    const files = walkFiles(spec.root, spec.depth, [], spec.match)
    if (files.length === 0) continue
    // 新文件优先：老的错误早就被处理或早已不可复现
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
    for (let i = 0; i < files.length; i += 1) {
      const source = toSource(spec, spec.root, files[i])
      if (i < maxFiles) picked.push(source)
      else dropped.push({ path: source.path, reason: `超过每类 ${maxFiles} 个文件上限` })
    }
  }
  return { picked, dropped }
}

/**
 * 发现日志源。只读、不做网络。
 * maxFiles 限制每类最多取多少个最新文件（默认 20）—— 会话有 100+ 个，
 * 全读是没必要的 IO，而且总量预算根本不够。
 */
export function discoverLogSources(options = {}) {
  return discoverAll(options).picked
}

/* ------------------------------------------------------------------ *
 * 7. 读成文本（处处有上限）
 * ------------------------------------------------------------------ */

/**
 * 有界读取：只读文件头 maxBytes 字节。
 *
 * probe.js 的 readText 会整文件读入 —— 对 `%TEMP%\dsh-purge-desktop.log.1`（已 2.2MB 且按大小轮转）
 * 或者将来某个 500MB 的日志，一次 readFileSync 就是把 Doctor 自己拖死。
 * 于是：文件在预算内就交给 readText（复用、简单），超预算才走这里截断。
 * 末尾可能切在多字节字符中间，解出来带一个替换字符 —— 可接受，因为它落在被丢弃的尾巴上。
 */
function readHead(file, maxBytes) {
  let fd
  try {
    fd = openSync(file, 'r')
  } catch (error) {
    return { text: '', error: String(error?.message ?? error) }
  }
  try {
    const stat = fstatSync(fd)
    const take = Math.max(0, Math.min(stat.size, maxBytes))
    const buf = Buffer.alloc(take)
    let read = 0
    while (read < take) {
      const n = readSync(fd, buf, read, take - read, read)
      if (n <= 0) break
      read += n
    }
    return { text: stripBom(buf.subarray(0, read).toString('utf8')), error: undefined }
  } catch (error) {
    return { text: '', error: String(error?.message ?? error) }
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* 关不掉也无所谓，进程退出即释放 */
    }
  }
}

/**
 * 读一个源成文本。
 * session 走 readZstdJsonl（多帧！整缓冲解压只拿到第一帧，会静默丢掉 99.99%），其余走 readText。
 * 返回 { text, bytes, truncated, error }，任何异常进 error，绝不抛。
 *
 * 注意：这是本模块**唯一**返回日志原文的函数。原因是 scanLeaks 的计数必须基于原文
 * （先脱敏再统计永远得 0）。调用方只允许把 text 喂给 extractErrors / scanLeaks，
 * collectLogs 从不在返回值里带原文。
 */
export function readLogText(source, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : DEFAULT_MAX_LINES
  const out = { text: '', bytes: 0, truncated: false, error: undefined }
  if (!source?.path) {
    out.error = 'source.path 为空'
    return out
  }
  const stat = statSafe(source.path)
  out.bytes = stat?.size ?? source.size ?? 0
  if (!stat?.isFile()) {
    out.error = '不是可读文件（不存在或不是普通文件）'
    return out
  }

  if (/\.zstd$/i.test(source.path)) {
    // zstd 必须整缓冲读：帧边界靠魔数扫描，截断后剩下的半帧解不出来，所以不做局部读取
    const decoded = readZstdJsonl(source.path, { maxBytes })
    out.bytes = decoded.bytes
    out.text = decoded.text
    out.error = decoded.error
  } else if (stat.size > maxBytes) {
    const head = readHead(source.path, maxBytes)
    out.text = head.text
    out.truncated = true
    // bytes 记的是「真正读进来的量」。这里若记文件总大小，预算核算就会跟着虚高：
    // 实测一个 22MB 的文件只读 8MB，却按 22MB 扣预算 —— 报告里的「扫了多少字节」
    // 会和上限保护自相矛盾（第一次跑出来 38MB > 32MB 上限就是这么来的）。
    out.bytes = Math.min(stat.size, maxBytes)
    out.error = head.error ?? `只读取前 ${maxBytes} B（文件 ${stat.size} B）`
  } else {
    const text = readText(source.path)
    if (text === undefined) out.error = 'readText 读取失败'
    else out.text = text
  }

  if (out.text) {
    const lines = out.text.split('\n')
    if (lines.length > maxLines) {
      out.text = lines.slice(0, maxLines).join('\n')
      out.truncated = true
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 8. 一次性入口
 * ------------------------------------------------------------------ */

/**
 * 截断聚类列表时，先保证「每个 kind 至少留一组」。
 * 纯按 count 截断的后果实测过：crash 快照只产生 1 条 host-exit（count=1），
 * 而 fetch-failed 有上百条不同签名 —— 最权威的崩溃证据直接排在 200 名之外被切掉。
 * 这不是排序口味问题，是「报告里会不会漏掉最该看的东西」的问题。
 */
function selectClusters(all, limit) {
  if (all.length <= limit) return all
  const chosen = new Set()
  const firstOfKind = new Map()
  for (const cluster of all) if (!firstOfKind.has(cluster.kind)) firstOfKind.set(cluster.kind, cluster)
  for (const cluster of firstOfKind.values()) chosen.add(cluster)
  for (const cluster of all) {
    if (chosen.size >= limit) break
    chosen.add(cluster)
  }
  // 保序（all 已按 count 降序），只取选中的那些
  return all.filter((cluster) => chosen.has(cluster)).slice(0, limit)
}

/**
 * 发现 → 读取 → 抽错 → 聚类。
 * options: { home, profileDir, maxFiles, maxTotalBytes, kinds, now, env, maxBytes, maxLines, maxEntries }
 * 返回 facts 片段（形状固定，供 facts.js 直接嵌入）。
 */
export function collectLogs(options = {}) {
  const now = options.now ?? Date.now()
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : DEFAULT_MAX_LINES
  const maxTotalBytes =
    Number.isFinite(options.maxTotalBytes) && options.maxTotalBytes > 0 ? options.maxTotalBytes : DEFAULT_MAX_TOTAL_BYTES
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : DEFAULT_MAX_ENTRIES
  // 聚类上限是「防爆内存的安全阀」，不是排行榜。第一次跑实测：本机光 fetch-failed 一个 kind
  // 就有上百条不同签名，200 的默认值把 count=1 的 crash 崩溃快照整个挤出了结果 ——
  // 最权威的错误反而看不见。所以放到 500，并且下面再兜一层「每类至少留一组」。
  const maxClusters = Number.isInteger(options.maxClusters) && options.maxClusters > 0 ? options.maxClusters : 500

  const { picked, dropped } = discoverAll({ ...options, maxFiles })
  const skipped = [...dropped]
  const errors = []
  const scanned = { files: 0, bytes: 0, lines: 0, truncated: 0 }
  const leaks = { total: 0, unique: 0, byType: {} }
  const leakBySource = []
  const leakSeen = new Map()
  const entries = []

  if (picked.length === 0 && !options.home && !options.profileDir) {
    // 两个根都没有时结果必然是空的，把原因写在 skipped 里，比返回一堆 0 更有用
    skipped.push({ path: '(none)', reason: '缺少 home 与 profileDir，无从发现日志' })
  }

  // 采样顺序 = 价值优先；同类内新的在前
  const rank = (kind) => {
    const index = KIND_PRIORITY.indexOf(kind)
    return index >= 0 ? index : KIND_PRIORITY.length
  }
  const queue = [...picked].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || Date.parse(b.mtime) - Date.parse(a.mtime) || a.path.localeCompare(b.path),
  )

  let remaining = maxTotalBytes
  for (const source of queue) {
    if (source.readable === false) {
      skipped.push({ path: source.path, reason: '不可读（权限或已删除）' })
      continue
    }
    const isZstd = /\.zstd$/i.test(source.path)
    // zstd 必须整缓冲读（帧边界靠魔数扫描），所以「只读剩下的预算」对它不成立
    const cap = Math.min(maxBytes, Math.max(remaining, 0))
    if (isZstd && source.size > cap) {
      skipped.push({ path: source.path, reason: `需要完整帧结构，超出可用预算 ${cap} B` })
      continue
    }
    if (cap < 1024) {
      skipped.push({ path: source.path, reason: `总字节上限 ${maxTotalBytes} B 已用尽` })
      continue
    }
    // 普通文本允许截头读取：最后几个文件仍能贡献开头那段，比整份丢掉有用
    const read = readLogText(source, { maxBytes: cap, maxLines })
    remaining -= read.bytes
    scanned.files += 1
    scanned.bytes += read.bytes
    if (read.truncated) scanned.truncated += 1
    if (read.error && !read.text) errors.push({ path: source.path, error: read.error })
    if (!read.text) continue

    scanned.lines += read.text.split('\n').length
    const leak = scanLeaks(read.text, { withHashes: true })
    leaks.total += leak.total
    // 命中在哪个文件里 —— 报告不能写死「会话日志与插件管理日志里」这种没有证据的断言
    if (leak.total > 0) leakBySource.push({ path: source.path, kind: source.kind, total: leak.total })
    for (const [type, count] of Object.entries(leak.byType)) leaks.byType[type] = (leaks.byType[type] ?? 0) + count
    // 同一把 key 会在多个源里重复出现：全局按哈希去重，「几个不同的密钥」才是人关心的数
    for (const [type, set] of Object.entries(leak.hashes ?? {})) {
      const merged = leakSeen.get(type) ?? new Set()
      for (const hash of set) merged.add(hash)
      leakSeen.set(type, merged)
    }

    const found = extractErrors(read.text, {
      limit: maxEntries,
      sourceId: source.id,
      sourceMtimeMs: Date.parse(source.mtime) || now,
    })
    for (const entry of found) entries.push(entry)
  }

  // 窗口是「当前故障」的判据：三天前那次 already-installed 不等于现在坏了。
  // 窗口外的错误不丢，单独放 clustersOutsideWindow —— 它们仍能解释「某个插件为什么状态怪」。
  const since = options.since === undefined ? now - DEFAULT_WINDOW_MS : Number(options.since)
  const recent = []
  const older = []
  for (const entry of entries) {
    // 拿不到时间的条目按「窗口内」算：宁可多看一眼，也不要因为读不出时间就把新故障藏起来
    if (!Number.isFinite(entry.time) || entry.time >= since) recent.push(entry)
    else older.push(entry)
  }

  // 去重后的总数在循环结束后才能算：leaks.total 是「出现次数」，leaks.unique 是「几个不同的值」。
  // uniqueByType 是「每类有几个不同的值」——报告里必须用它，否则 byType 的出现次数会和
  // 标题里的「去重后 N 个」对不上（实测：51 处 vs 12 个，读者会以为算错了）。
  const uniqueByType = {}
  for (const [type, set] of leakSeen.entries()) {
    uniqueByType[type] = set.size
    leaks.unique += set.size
  }
  leaks.uniqueByType = uniqueByType
  // 只留命中数最多的 5 个文件：全列出来会把报告淹没，而且这些路径本身也可能带着项目名
  leaks.bySource = leakBySource.sort((a, b) => b.total - a.total).slice(0, 5)

  return {
    collectedAt: new Date(now).toISOString(),
    windowStart: Number.isFinite(since) && since > 0 ? new Date(since).toISOString() : undefined,
    windowEnd: new Date(now).toISOString(),
    sources: picked,
    scanned,
    clusters: markRevived(selectClusters(clusterErrors(recent, { limit: Number.MAX_SAFE_INTEGER }), maxClusters)),
    clustersOutsideWindow: markRevived(selectClusters(clusterErrors(older, { limit: Number.MAX_SAFE_INTEGER }), maxClusters)),
    leaks,
    skipped,
    errors,
  }
}

/**
 * 给「模块找不到」类聚类打上 revived 标记：签名里点名的路径现在存在 → 这条错误是
 * 开发中途/上次安装时的瞬时产物，不该继续当成现状。实测：测试脚本报
 * `Cannot find module '...\lib\inference.js'`，3 分钟后该文件就建好了，而聚类还要在
 * 24h 窗口里挂一整天，把用户骗去重装插件。这里只标不改（severity/count 保持原样），
 * 由规则层和推理层决定怎么处置。
 */
const REVIVABLE_KINDS = new Set(['module-not-found', 'app-code-module-missing'])
const MODULE_PATH_IN_SAMPLE = /[A-Za-z]:\\[^'"\r\n)]+\.(?:m?js|cjs|ts|json)/g

export function markRevived(clusters) {
  if (!Array.isArray(clusters)) return clusters
  for (const cluster of clusters) {
    if (!cluster || !REVIVABLE_KINDS.has(cluster.kind)) continue
    const paths = String(cluster.sample ?? '').match(MODULE_PATH_IN_SAMPLE) ?? []
    if (paths.length === 0) continue
    cluster.revived = paths.every((item) => {
      try {
        return existsSync(item)
      } catch {
        return false
      }
    })
  }
  return clusters
}

export default {
  LOG_KINDS,
  LINE_RULES,
  discoverLogSources,
  readLogText,
  classifyLine,
  extractErrors,
  clusterErrors,
  markRevived,
  maskSecrets,
  scanLeaks,
  collectLogs,
}
