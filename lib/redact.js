/**
 * DSH Doctor — 报告脱敏层（纯 ESM、只用 node: 内置模块、零第三方依赖）。
 *
 * 为什么要有这一层：报告（facts + 诊断结论）迟早要被导出、贴进 issue、发给别人看，
 * 而报告**天生**带着本机身份——家目录绝对路径、用户名、主机名、会话 id，还有日志
 * 样例里夹带的密钥。脱敏不是可选的修饰，而是这份报告能不能离开本机的前提。
 *
 * 三条设计约束，后面的每一行代码都在为它们服务：
 *
 * 1. **密钥规则只此一份**：`maskSecrets` 是 logs.js 的既有实现（sk-/ghp_/Bearer/
 *    apiKey/JWT/PEM/长 hex 全覆盖，hex 只脱敏不计数）。这里复用并累加它的 hits，
 *    绝不另写一套正则——两份规则迟早会分叉，然后出现「日志层说没泄漏、报告层说有三处」
 *    这种互相打脸的报告。
 * 2. **幂等**：导出、复制、再导出会把同一段文本送进来两次。第二遍还能改动文本，
 *    「已脱敏」这三个字就不成立。所以每个替换的目标形态都必须**不再匹配自己的正则**：
 *    `C:\Users\x` → `~`、`x` → `<user>`、UUID → `3f4a1b2c…`、密钥 → `[REDACTED:key]`。
 *    另一半是「保护已生成的占位符」——用户名恰好叫 `user` 时，`<user>` 里那个 `user`
 *    绝不能再被替换成 `<<user>>`（见 mapOutside）。
 * 3. **保留可辨识度**：会话 id 只留前 8 位而不是整段抹掉。报告的价值有一半在「能定位」，
 *    全抹掉等于把定位能力一起删了。
 */
import { homedir, userInfo, hostname } from 'node:os'
import { maskSecrets } from './logs.js'

/* ------------------------------------------------------------------ *
 * 1. 身份探测
 * ------------------------------------------------------------------ */

/** 对象是否**显式**带了某个键。显式空串表示「这一类不参与脱敏」，和「没给」必须区分开。 */
function has(object, key) {
  return Object.hasOwn(object, key)
}

function safeHomedir() {
  try {
    return String(homedir() ?? '')
  } catch {
    // 极端受限环境里 os 的探测会抛；脱敏层不能因为拿不到 home 就把整个报告流程带崩
    return ''
  }
}

function safeUsername() {
  try {
    return String(userInfo().username ?? '')
  } catch {
    return ''
  }
}

function safeHostname() {
  try {
    return String(hostname() ?? '')
  } catch {
    return ''
  }
}

/** 去掉尾部路径分隔符：`C:\Users\tester\` 带着尾斜杠去替换，会留下 `~\` 这种双分隔。 */
function trimTailSep(path) {
  return String(path ?? '').replace(/[\\/]+$/, '')
}

/**
 * 取路径最后一段。刻意不用 `node:path`：`path.basename` 的行为取决于**当前平台**，
 * 而报告里同时可能出现 `C:\Users\x`（Windows 采集）和 `/Users/x`（别人的 macOS 报告）。
 * 按两种分隔符直接切，才是不依赖运行平台的那个答案。
 */
function lastSegment(path) {
  const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/**
 * 探测本机身份：home/user/host。
 * options 里的同名字段优先（测试与「脱敏别人的报告」都靠它）；没给才去问 os。
 */
export function detectIdentity(options = {}) {
  const opts = options ?? {}
  const home = trimTailSep(has(opts, 'home') ? String(opts.home ?? '') : safeHomedir())
  // 用户名探测失败时退回家目录最后一段：`C:\Users\tester` 的最后一段就是用户名，
  // 这比返回空串更有用——空串会让「C:\Users\<user>」这一类规则直接失效。
  const user = has(opts, 'user') ? String(opts.user ?? '') : safeUsername() || lastSegment(home)
  const host = has(opts, 'host') ? String(opts.host ?? '') : safeHostname()
  return { home, user, host }
}

/* ------------------------------------------------------------------ *
 * 2. 占位符保护（幂等的第二道保险）
 * ------------------------------------------------------------------ */

/**
 * 已经是占位符的片段。身份替换必须跳过它们。
 * 每次现做一份而不是复用一个模块级常量：带 g 的 RegExp 有 lastIndex 状态，
 * 复用实例在多次 split 之间留下残留是经典事故（logs.js 的 SECRET_PATTERNS 用
 * source + flags 字符串也是同一个理由）。
 *
 * **必须带捕获组**：`String.prototype.split` 只有捕获组会被保留在结果里，裸分隔符会被
 * 直接丢掉——第一版漏了这对括号，每次 mapOutside 都把 `[REDACTED:key]`、`<user>`
 * 从文本里删掉（测试当场就报 `配置里写着 key=`）。括号不是格式，是数据完整性。
 */
function placeholderRe() {
  return /(\[REDACTED:[A-Za-z]+\]|<user>|<host>)/g
}

/**
 * 只对「占位符之外」的片段执行 fn，占位符原样穿过。
 * 用 split 而不是哨兵字符：单捕获组的分割结果天然是 outside/delim/outside…，
 * 偶数下标一定在占位符外部，判断成本为零，也不会像哨兵那样意外出现在用户文本里。
 */
function mapOutside(text, fn) {
  const parts = String(text).split(placeholderRe())
  for (let i = 0; i < parts.length; i += 2) parts[i] = fn(parts[i])
  return parts.join('')
}

/* ------------------------------------------------------------------ *
 * 3. 替换原语
 * ------------------------------------------------------------------ */

/** 把字符串里所有正则元字符转义：home/用户名/主机名都要进 RegExp 构造函数。 */
function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 替换并计数。
 * 注：`String.prototype.replace` 对 global 正则会在开始时把 lastIndex 归零
 * （Symbol.replace 的既定行为），所以这里复用带 g 的实例是安全的；
 * 换成 test/exec 就必须每次新建实例，两者不能混着记。
 */
function replaceCounting(text, re, replacer) {
  let count = 0
  const out = String(text).replace(re, (...args) => {
    count += 1
    return replacer(...args)
  })
  return { text: out, count }
}

function emptyHits() {
  // 字段固定 5 个且顺序固定：上层会把它直接铺进摘要，形状不许漂
  return { home: 0, user: 0, host: 0, secret: 0, session: 0 }
}

function addHits(into, from) {
  for (const key of Object.keys(into)) into[key] += Number(from?.[key]) || 0
}

/* ------------------------------------------------------------------ *
 * 4. 四类身份规则
 * ------------------------------------------------------------------ */

/**
 * 家目录 → `~`，两种斜杠写法都认，长串优先。
 *
 * 末尾的 `(?![A-Za-z0-9_])` 是必要的：`C:\Users\tester` 是 `C:\Users\tester2` 的前缀，
 * 不做边界判断会把别人的 home 也吞掉半截，产出 `~2\AppData` 这种既错又难看的东西。
 */
function homePatterns(home, user) {
  const patterns = []
  const clean = trimTailSep(home)
  if (clean) {
    // 同一段路径的三种写法：原样、全正斜杠、全反斜杠。Set 去重（纯正斜杠时后两者相同）
    const forms = new Set([clean, clean.replace(/\\/g, '/'), clean.replace(/\//g, '\\')])
    for (const form of forms) {
      if (!form) continue
      patterns.push(new RegExp(`${escapeRe(form)}(?![A-Za-z0-9_])`, 'gi'))
    }
  }
  // 「先长后短」的第二段：options.home 与文本里的真实路径对不上时（测试夹具、别人的报告、
  // 或者只给了 user 没给 home），仍要能认出 `X:\Users\<user>`。
  // 只认 `Users` 这一层是有意的——盘符与用户名才是身份，具体哪个盘不是。
  if (user) {
    patterns.push(new RegExp(`[A-Za-z]:[\\\\/]+Users[\\\\/]+${escapeRe(user)}(?![A-Za-z0-9_])`, 'gi'))
  }
  return patterns
}

/**
 * 用户名独立出现 → `<user>`。前后不允许紧邻字母数字：`testering`、`xtester`
 * 不是用户名，是别的词，替换它们就是纯粹的破坏。
 * 长度 < 2 直接放弃：单字符用户名（比如 `a`）会把整份报告拆成 `<user>` 碎片，
 * 误伤远大于脱敏收益。
 */
function userPattern(user) {
  if (!user || user.length < 2) return undefined
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(user)}(?![A-Za-z0-9])`, 'gi')
}

/**
 * 主机名全串 → `<host>`，大小写不敏感，短于 4 字符不替换。
 * 门槛的理由：`PC`、`VM`、`DEV` 这种短名在英文正文里就是普通词/缩写，
 * 抹掉它们只会让报告读不通；而真实主机名几乎都 ≥4 位。
 * 两侧的字母数字边界同理：`DESKTOP-ABC123` 不该被 `DESKTOP-ABC` 吃掉前半截。
 */
function hostPattern(host) {
  if (!host || host.length < 4) return undefined
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(host)}(?![A-Za-z0-9])`, 'gi')
}

/**
 * 会话 id：`sessions\<workspace>\<id>\` 里的 id → 前 8 位 + `…`。
 *
 * 为什么必须带路径上下文：裸 UUID 在报告里还会以「附件 id」「请求 id」的身份出现，
 * 那些不是会话、也不该被缩短；只认 sessions 目录下一层，语义才准确。
 * 为什么留 8 位：报告要能指着某次会话说「就是这条」，整段抹掉等于连定位能力一起删。
 * sessionMinLen（默认 36）是 id 长度门槛：标准 UUID 正好 36 位，调大即关闭（不存在更长的
 * UUID），调小不会额外命中——门槛只做减法，不去猜别的 id 形状。
 */
const SESSION_ID_RE = /([\\/]sessions[\\/][^\\/\s"'<>]+[\\/])([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?=[\\/"'\s]|$)/gi

function shortSessions(text, minLen) {
  let count = 0
  // 每次新建实例：这里虽然走 replace（会自己归零 lastIndex），但保持与 logs.js 一致的
  // 「谁用谁新建」习惯，避免以后有人把它改成 test() 就静默漏判。
  const re = new RegExp(SESSION_ID_RE.source, SESSION_ID_RE.flags)
  const out = String(text).replace(re, (match, prefix, id) => {
    if (id.length < minLen) return match
    count += 1
    return `${prefix}${id.slice(0, 8)}…`
  })
  return { text: out, count }
}

/* ------------------------------------------------------------------ *
 * 5. 对外接口
 * ------------------------------------------------------------------ */

/**
 * 把一段文本里的敏感信息换成占位符。幂等：对已脱敏文本再跑一次，结果不变。
 *
 * options: { home?, user?, host?, sessionMinLen? }
 * 返回 { text, hits: { home, user, host, secret, session } }——各类替换次数。
 *
 * 顺序不是随手排的，四步都有依赖：
 *   ① 密钥 → ② 会话 id → ③ 家目录 → ④ 用户名 → ⑤ 主机名
 * ①必须在身份替换**之前**且不经过 mapOutside：身份替换会把 token 切断，
 * `Bearer tester-<22 位>` 一旦被用户名规则改成 `Bearer <user>-…`，Bearer 正则
 * 就再也认不出它了——那才是真的把密钥漏在报告里。
 */
export function redactText(text, options = {}) {
  const hits = emptyHits()
  if (typeof text !== 'string') return { text: '', hits }
  if (text.length === 0) return { text, hits }

  const identity = detectIdentity(options)
  const minLen = Number.isFinite(options?.sessionMinLen) && options.sessionMinLen > 0 ? options.sessionMinLen : 36

  // ① 密钥：复用 logs.js 的唯一真相，只把它的分类型计数汇总成一个总数
  const masked = maskSecrets(text)
  let out = masked.text
  hits.secret = Object.values(masked.hits).reduce((sum, n) => sum + n, 0)

  // ② 会话 id：UUID 带连字符，`[0-9a-f]{32,}` 的 hex 规则吃不掉它，所以排在密钥之后仍有效
  const session = shortSessions(out, minLen)
  out = session.text
  hits.session = session.count

  // ③ 家目录。占位符保护在这里不必要（`~` 不是任何规则的输入形态），
  //    但仍走 mapOutside，保持四条身份规则的处理路径一致，少一条特例就少一个坑。
  for (const re of homePatterns(identity.home, identity.user)) {
    out = mapOutside(out, (segment) => {
      const step = replaceCounting(segment, re, () => '~')
      hits.home += step.count
      return step.text
    })
  }

  // ④ 用户名。放在家目录之后：否则 `C:\Users\tester` 会先变成 `C:\Users\<user>`，
  //    从「家目录」降级成「任意用户路径」，把更有用的信息换掉了。
  const userRe = userPattern(identity.user)
  if (userRe) {
    out = mapOutside(out, (segment) => {
      const step = replaceCounting(segment, userRe, () => '<user>')
      hits.user += step.count
      return step.text
    })
  }

  // ⑤ 主机名
  const hostRe = hostPattern(identity.host)
  if (hostRe) {
    out = mapOutside(out, (segment) => {
      const step = replaceCounting(segment, hostRe, () => '<host>')
      hits.host += step.count
      return step.text
    })
  }

  return { text: out, hits }
}

/**
 * 深拷贝 report 并把所有字符串值过一遍 redactText；数字/布尔/null 原样。
 * 返回 { report, hits }（hits 为累计）。
 *
 * 为什么不原地改：这份报告还要继续被调用方使用（写文件、算摘要、本地展示），
 * 一旦就地脱敏，后面任何一步都再也拿不回原文，而原文正是本地诊断要用的东西。
 *
 * 键名不脱敏：报告的键是固定字段名（`plugins`/`score`/`byType`），不是身份；
 * 值才是。这条边界写在这里，免得以后有人「顺手」把键也过一遍再问为什么结构对不上。
 */
export function redactReport(report, options = {}) {
  const hits = emptyHits()
  // 身份只探测一次：os 调用在受限环境里既慢又可能抛，不可能为一个报告里的每个字符串重来一遍
  const resolved = { ...options, ...detectIdentity(options) }
  const stack = new WeakSet()

  const walk = (value) => {
    if (typeof value === 'string') {
      const result = redactText(value, resolved)
      addHits(hits, result.hits)
      return result.text
    }
    if (Array.isArray(value)) return value.map(walk)
    if (!value || typeof value !== 'object') return value
    // 非 JSON 值原样复制：Date 拍平成 {} 会让报告里的时间戳消失，TypedArray 同理
    if (value instanceof Date) return new Date(value.getTime())
    if (ArrayBuffer.isView(value)) return value.slice()
    // 环引用兜底：JSON 报告不该有环，但真出现了也不能让整个导出栈溢出。
    // 只挡「当前递归链上」的对象（stack 用完即删），共享引用仍会各自复制、各自脱敏。
    if (stack.has(value)) return value
    stack.add(value)
    try {
      const copy = {}
      for (const [key, entry] of Object.entries(value)) copy[key] = walk(entry)
      return copy
    } finally {
      stack.delete(value)
    }
  }

  return { report: walk(report), hits }
}
