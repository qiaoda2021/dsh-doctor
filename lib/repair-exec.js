/**
 * DSH Doctor — RepairPlan 受控执行器（计划 → 真正落盘的唯一入口）。
 *
 * 为什么要有这一层，以及为什么它比计划层还啰嗦：
 * `lib/repair-plan.js` 的纪律是「只出计划、绝不执行」，所以它连 `node:fs` 都不 import。
 * 一旦要把计划变成动作，风险就从「说错」跳到「写坏用户的 ~/.dsh」——那里放着 profile 配置、
 * 会话数据、密钥。所以本模块把每一条安全边界都写成**可被代码读出来的判断点**，逐条对应：
 *
 * ① 默认拒绝：`executePlan(plan)` 不带确认令牌一律 `status: 'refused'`，一个字节都不写
 *    （连备份目录都不建）。令牌 = `plan.confirmToken ?? plan.id`，必须由
 *    `options.confirmToken` 或 `options.confirm` 逐字给出。**布尔 `true` 不算令牌**：
 *    布尔太容易被一路透传，最后没人记得自己确认过什么。
 * ② 路径白名单：只允许写数据根（默认 `~/.dsh`，`options.home` 可覆盖）之下，且
 *    `sessions/`、`state/`、`.credentials.*`、任意 `*.log` 一律拒收。越界 = 预检失败：
 *    该步 `failed`、整条记录 `failed`，并且**一个文件都不动**（预检在第一次 open 之前完成）。
 * ③ 符号链接 / 穿越：原始 target 里出现 `..` 段直接拒；再从数据根开始逐段 `lstat`，
 *    任何一段是符号链接就拒；最后用最近的已存在祖先的 `realpath` 复核仍在根内。
 *    （`options.probePath` 是**测试缝**，只用于在无权限建链接的机器上验证同一段判断逻辑。）
 * ④ 备份先行：目标已存在 → 先复制到
 *    `<home>/state/dsh-doctor/backups/<YYYYMMDD-HHmmss>-<recordId>/`，保留相对路径层级，
 *    复制后回读大小，大小不符就中止该步（绝不出现「写了但没备份」）。
 * ⑤ 不执行 shell：本模块不 import `node:child_process`（测试会读源码断言这一条）。
 *    `run-check` 只能是纯 JS 校验：存在 / 不存在 / JSON 可解析 / 含 / 不含 / 正则命中。
 * ⑥ 验证：`options.verify(record)` 优先；否则用计划自带的 `verificationChecks`
 *    （对象形态 `{id, kind, path, expect}` 走内置校验，字符串形态只能标 `skip` 交人工）；
 *    两者都没有 → `status: 'skip'` 且 `detail` 写明「无验证条件」。
 * ⑦ 失败即回滚：`options.rollbackOnFailure !== false` 时，任一步 `failed` 或验证 `fail`
 *    自动 `rollbackExecution()`：从备份还原被覆盖的文件、删掉本次新建的文件，
 *    并把 `record.rollback.performed/detail` 写清。「半途成功」的步骤仍留在 `steps` 里，不被吞掉。
 * ⑧ 审计留痕：每次执行（含 `refused` / `noop`）把记录原子写进
 *    `<home>/state/dsh-doctor/repair-log/<recordId>.json`（先 `.tmp` 再 rename）。
 *    **日志里没有文件内容**，只有路径、字节数、状态、原因；JSON 解析失败也只写
 *    「解析失败」，不写错误片段（V8 的报错会带一段原文）。
 *
 * 与 `lib/repair-secrets.js` 同构：那个模块是本插件第一个会改文件的动作，纪律同样是
 * 「默认不写 → 必须确认 → 写前备份 → 写后复检 → 失败自动回滚」。这里只是把同一个纪律
 * 从「一种动作」推广到「计划里的一组动作」，并额外承担跨会话的审计。
 *
 * 契约（字段名固定，扩展一律加可选字段，不改已有字段含义）：
 *   ExecutionRecord = {
 *     recordId, planId, title, risk, startedAt, finishedAt,
 *     status: 'applied'|'failed'|'refused'|'noop',
 *     steps: [{ index, kind, path, status: 'applied'|'skipped'|'failed', detail, created?, bytes? }],
 *     backup: { dir, files: [{ path, backupPath, bytes }] } | null,
 *     verification: { status: 'pass'|'fail'|'skip', checks: [{ id, status, detail }], detail },
 *     rollback: { available, performed, detail },
 *     confirmToken,
 *     // 以下为本模块附加字段，供面板/CLI 解释「为什么没执行」
 *     home, confirmed, logPath, refusedReasons?, logError?
 *   }
 *
 * 与 `lib/repair-plan.js` 的真实形状对齐：那里的 `changes[].operation` 只有
 * create / update / delete，且 `changes[].description` 是**人话**，没有可写入的正文。
 * 所以本模块把 operation 映射成执行 kind，并要求 `changes[].content`（或 `patch`）；
 * 拿不到正文的计划一律 `refused`——这是刻意的 fail-closed：现在的计划层本来就是给人看的，
 * 「看起来像能一键修复」比「明确告诉我这一步需要人来做」危险得多。
 */
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const EXEC_VERSION = '1.0.0'

/**
 * 执行步骤的封闭集合。多一个值就意味着多一条写盘路径，所以这里只认这五个：
 * create-file（新建）、write-file（覆盖写）、patch-json（JSON 合并）、
 * delete-file（删除，必须先备份）、run-check（纯 JS 校验，不写盘）。
 */
export const EXEC_KINDS = ['create-file', 'write-file', 'patch-json', 'delete-file', 'run-check']

/** 执行记录的状态值。`noop` = 目标已经符合预期，本次没有写任何字节。 */
export const EXEC_STATUS = ['applied', 'failed', 'refused', 'noop']

/** `plan.changes[].operation` → 执行 kind。update 只有在给了 `patch` 对象时才是 patch-json。 */
const OPERATION_KIND = { create: 'create-file', update: 'write-file', delete: 'delete-file' }

/** 内置校验能做的判断。run-check 与 verificationChecks 共用这一套。 */
export const CHECK_KINDS = ['exists', 'absent', 'json', 'contains', 'not-contains', 'regex', 'not-regex']

/** 凭据文件：任何层级的 `.credentials` / `.credentials.*` 都不许碰。 */
const CREDENTIAL_RE = /(^|[\\/])\.credentials(\.[^\\/]*)?$/i

/** 日志文件不是修复目标：它们是运行时真相，改它们属于「样本清理」而不是「配置修复」。 */
const LOG_FILE_RE = /\.log$/i

/** 单条 detail 的上限。detail 会进审计日志，无限长等于把日志变成第二份数据。 */
const MAX_DETAIL = 300

/** `listExecutions` 默认返回条数。 */
const MAX_LIST = 20

/** 记录目录 / 备份目录，都相对数据根。 */
const LOG_DIR = ['state', 'dsh-doctor', 'repair-log']
const BACKUP_DIR = ['state', 'dsh-doctor', 'backups']

/** 日志文件名：本模块只认自己写的那一种，目录里别人的文件不读不删。 */
const RECORD_RE = /^exec-[\w.-]+\.json$/

/* ------------------------------------------------------------------ *
 * 1. 小工具（纯函数）
 * ------------------------------------------------------------------ */

/** detail 一律截断：审计日志里出现的任何字符串都必须是有限的。 */
function clip(text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  return value.length > MAX_DETAIL ? `${value.slice(0, MAX_DETAIL - 1)}…` : value
}

function errorText(error) {
  return clip(String(error?.message ?? error))
}

/** Windows 大小写不敏感：前缀判断不折叠大小写会把真实越界当成「更长的合法路径」。 */
function foldPath(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value)
}

/** 本地时间戳做目录名（`20261022-193000`）：Windows 不允许冒号，而本地时间更贴近「刚才那一次」。 */
function stampOf(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

function randomToken() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

/** target 是否真的在 root 之内（不含 root 本身）。跨盘符时 relative 返回绝对路径 → 不在。 */
function insideRoot(root, target) {
  if (!root || !target) return false
  const rel = relative(foldPath(root), foldPath(target))
  if (!rel) return false
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** 原始 target 里是否出现 `..` 段。**在 resolve 之前判断**，否则归一化会把证据抹掉。 */
function hasTraversal(raw) {
  if (typeof raw !== 'string' || !raw) return true
  return raw.split(/[\\/]+/).includes('..')
}

/**
 * 路径白名单。返回原因字符串表示拒收，undefined 表示放行。
 * 顺序有意义：先判越界，再判受保护目录——「不在根里」比「在 state 里」更根本。
 */
function policyReason(home, abs) {
  if (!insideRoot(home, abs)) return `路径越界：${abs} 不在数据根 ${home} 之内`
  const rel = relative(foldPath(home), foldPath(abs))
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  const name = parts[parts.length - 1] ?? ''
  if (CREDENTIAL_RE.test(rel)) return `凭据文件不在修复范围内：${abs}`
  if (parts[0] === 'sessions') return `会话数据（sessions/）不可写：${abs}`
  if (parts[0] === 'state') return `state/ 目录不可写（执行器自己的备份与日志除外）：${abs}`
  if (LOG_FILE_RE.test(name)) return `日志文件不是修复目标：${abs}`
  return undefined
}

/**
 * 数据根：`options.home` → `plan.home`（仅当是绝对路径）→ `DSH_HOME` → `~/.dsh`。
 * 与 `lib/store.js` 的解析顺序一致：报告落在哪个 profile，修复就该落在同一个 profile。
 */
function dataRoot(options = {}, plan) {
  const explicit = options.home
  if (typeof explicit === 'string' && explicit.trim()) return resolve(explicit)
  const fromPlan = plan && typeof plan === 'object' ? plan.home : undefined
  if (typeof fromPlan === 'string' && fromPlan.trim() && isAbsolute(fromPlan)) return resolve(fromPlan)
  const env = options.env ?? process.env
  const dshHome = env?.DSH_HOME
  if (typeof dshHome === 'string' && dshHome.trim()) return resolve(dshHome)
  return resolve(join(homedir(), '.dsh'))
}

/* ------------------------------------------------------------------ *
 * 2. 读盘探测（唯一允许注入的地方）
 * ------------------------------------------------------------------ */

/**
 * 单个路径的观察结果。
 *
 * `options.probePath(abs)` 是**测试缝**：Windows 上普通用户建不了文件符号链接，
 * 于是「路径经过符号链接必须拒绝」这条判断在部分机器上没法用真链接验证。
 * probe 可以让同一条判断逻辑看到「这里是个链接」，而不用真的建出来。
 * 生产调用绝不传它——它能让白名单看起来通过，等价于把闸门交给调用方。
 */
async function inspectPath(abs, options = {}) {
  const info = { exists: false, isSymbolicLink: false, isFile: false, isDirectory: false, size: 0, realpath: undefined }
  try {
    const found = await lstat(abs)
    info.exists = true
    info.isSymbolicLink = found.isSymbolicLink()
    info.isFile = found.isFile()
    info.isDirectory = found.isDirectory()
    info.size = found.size
    info.realpath = await realpath(abs).catch(() => undefined)
  } catch (error) {
    const code = error?.code
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES' && code !== 'EPERM') throw error
  }
  if (typeof options.probePath === 'function') {
    let override
    try {
      override = await options.probePath(abs)
    } catch {
      override = undefined
    }
    if (override && typeof override === 'object') return { ...info, ...override }
  }
  return info
}

/** 最近的已存在祖先的 realpath。目标还不存在时，用祖先判断它「会长在哪里」。 */
async function nearestReal(abs, options = {}) {
  let cursor = abs
  for (let depth = 0; depth < 64; depth += 1) {
    const info = await inspectPath(cursor, options)
    if (info.exists) return info.realpath ?? cursor
    const parent = dirname(cursor)
    if (parent === cursor) return cursor
    cursor = parent
  }
  return abs
}

/**
 * 符号链接 + realpath 复核。三条判断缺一不可：
 * 1. 从数据根开始逐段 lstat，任何一段是链接就拒（`home/link/x` 里 link 指向外部时，
 *    x 自己不是链接，但物理位置已经跑出去了）；
 * 2. 最近已存在祖先的 realpath 必须仍在数据根 realpath 之内（挡住 junction / 挂载点）；
 * 3. 数据根本身允许是链接（用户完全可以把 ~/.dsh 放到别的盘），所以从 home 里面开始查。
 */
async function auditSymlink(abs, home, options = {}) {
  const homeInfo = await inspectPath(home, options)
  const rel = relative(foldPath(home), foldPath(abs))
  const segments = rel.split(/[\\/]+/).filter(Boolean)
  let cursor = home
  for (const segment of segments) {
    cursor = join(cursor, segment)
    const info = await inspectPath(cursor, options)
    if (!info.exists) break
    if (info.isSymbolicLink) return `路径经过符号链接，拒绝执行：${cursor}`
  }
  if (!homeInfo.exists) return undefined
  const homeReal = homeInfo.realpath ?? home
  const targetReal = await nearestReal(abs, options)
  const same = foldPath(targetReal) === foldPath(homeReal)
  if (!same && !insideRoot(homeReal, targetReal)) return `realpath 解析后越界：${targetReal}`
  return undefined
}

/* ------------------------------------------------------------------ *
 * 3. 计划 → 步骤（不改计划对象，只读）
 * ------------------------------------------------------------------ */

function planInfoOf(plan) {
  const planId = typeof plan?.id === 'string' && plan.id.trim() ? plan.id.trim() : ''
  const title = typeof plan?.title === 'string' && plan.title.trim() ? plan.title.trim() : '(未命名修复计划)'
  const rawRisk = typeof plan?.risk === 'string' ? plan.risk.trim().toLowerCase() : ''
  // 未知风险按 high：拼错一个 risk 值就变成「可自动执行」，是这一层最昂贵的 bug。
  const risk = rawRisk === 'low' || rawRisk === 'medium' || rawRisk === 'high' ? rawRisk : 'high'
  const planToken = typeof plan?.confirmToken === 'string' && plan.confirmToken.trim() ? plan.confirmToken.trim() : ''
  return { planId: planId || '(no-id)', title, risk, confirmToken: planToken || planId }
}

/** 执行 kind：优先认显式 `kind`，否则由 `operation` 推；update + patch 对象 = patch-json。 */
function kindOf(change) {
  if (typeof change?.kind === 'string' && EXEC_KINDS.includes(change.kind)) return change.kind
  const operation = typeof change?.operation === 'string' ? change.operation.trim().toLowerCase() : ''
  const mapped = OPERATION_KIND[operation]
  if (mapped === 'write-file' && change?.patch && typeof change.patch === 'object' && !Array.isArray(change.patch)) return 'patch-json'
  return mapped
}

function collectSteps(plan) {
  const changes = Array.isArray(plan?.changes) ? plan.changes : []
  const steps = []
  changes.forEach((change, offset) => {
    const source = change && typeof change === 'object' ? change : {}
    const rawTarget = typeof source.target === 'string' ? source.target.trim() : typeof source.path === 'string' ? source.path.trim() : ''
    const step = {
      index: offset + 1,
      change: source,
      rawTarget,
      path: rawTarget && isAbsolute(rawTarget) ? resolve(rawTarget) : undefined,
      kind: kindOf(source),
      content: typeof source.content === 'string' ? source.content : undefined,
      patch: source.patch && typeof source.patch === 'object' && !Array.isArray(source.patch) ? source.patch : undefined,
      expect: source.expect ?? source.check,
    }
    steps.push(step)
  })
  return steps
}

/**
 * 静态体检：把「连计划都算不上」和「路径不合规」分成两类。
 * - blocking：缺 target / 缺正文 / 未知操作 —— 计划本身不成立，一律 refused；
 * - pathIssues：穿越 / 越界 / 受保护路径 —— 计划成立但危险，执行时按 failed 记账，
 *   且预检阶段就停手，一个文件都不动。
 */
function inspectPlan(plan, home) {
  if (!plan || typeof plan !== 'object') {
    return { steps: [], blocking: ['计划不是对象，无可执行内容'], pathIssues: new Map() }
  }
  const steps = collectSteps(plan)
  const blocking = []
  const pathIssues = new Map()
  if (!steps.length) blocking.push('计划没有 changes：只读计划没有可执行动作')

  for (const step of steps) {
    const label = `change #${step.index}`
    if (step.kind === 'run-check') {
      if (!step.expect || typeof step.expect !== 'object') {
        blocking.push(`${label} run-check 缺少 expect 对象`)
        continue
      }
      const checkPath = typeof step.expect.path === 'string' && step.expect.path.trim() ? step.expect.path.trim() : step.rawTarget
      if (!checkPath || !isAbsolute(checkPath)) blocking.push(`${label} run-check 缺少绝对路径`)
      continue
    }
    if (!step.rawTarget) {
      blocking.push(`${label} 缺少 target`)
      continue
    }
    if (!step.kind) {
      blocking.push(`${label} 操作不受支持：${String(step.change.operation ?? step.change.kind ?? '(空)')}`)
      continue
    }
    if (hasTraversal(step.rawTarget)) {
      pathIssues.set(step.index, `${label} 路径含 ..：${step.rawTarget}`)
      continue
    }
    if (!step.path) {
      blocking.push(`${label} target 不是绝对路径：${step.rawTarget}`)
      continue
    }
    const reason = policyReason(home, step.path)
    if (reason) {
      pathIssues.set(step.index, `${label} ${reason}`)
      continue
    }
    if ((step.kind === 'create-file' || step.kind === 'write-file') && typeof step.content !== 'string') {
      blocking.push(`${label} 缺少可写入内容（content 必须是字符串）`)
    }
    if (step.kind === 'patch-json' && !step.patch) blocking.push(`${label} patch-json 缺少 patch 对象`)
  }
  return { steps, blocking, pathIssues }
}

/* ------------------------------------------------------------------ *
 * 4. summarizePlan —— 纯静态判断，不读盘
 * ------------------------------------------------------------------ */

/**
 * 计划摘要（面板/CLI 的「能不能点」判断）。
 *
 * 刻意**不读盘**：`blockedReasons` 只覆盖计划自身的形状与纯路径规则。
 * 符号链接与 realpath 需要 fs，放在 `executePlan` 的预检里；也就是说
 * `executable: true` 表示「值得试着执行」，不表示「一定写得进去」。
 *
 * @param {object} plan
 * @param {{ home?: string, env?: object }} [options] 第二参数可选，只为测试与 CLI 覆盖数据根
 * @returns {{ planId: string, title: string, risk: string, changeCount: number, touches: string[], executable: boolean, blockedReasons: string[] }}
 */
export function summarizePlan(plan, options = {}) {
  const home = dataRoot(options, plan)
  const info = planInfoOf(plan)
  const { steps, blocking, pathIssues } = inspectPlan(plan, home)
  const blockedReasons = [...blocking, ...pathIssues.values()]
  const touches = []
  for (const step of steps) {
    if (!step.path || step.kind === 'run-check') continue
    if (!touches.includes(step.path)) touches.push(step.path)
  }
  return {
    planId: info.planId,
    title: info.title,
    risk: info.risk,
    changeCount: steps.length,
    touches,
    executable: blockedReasons.length === 0 && steps.length > 0,
    blockedReasons,
  }
}

/* ------------------------------------------------------------------ *
 * 5. 确认令牌
 * ------------------------------------------------------------------ */

/**
 * 是否给了匹配的确认令牌。
 *
 * 令牌 = `plan.confirmToken ?? plan.id`，必须逐字相等。三件刻意不做的事：
 * - 不接受 `options.confirm === true`：布尔太容易被上层一路透传，等于没有确认；
 * - 不接受前缀/包含匹配：`plan-good` 能放行 `plan-good-2` 就失去了「这一步」的语义；
 * - 计划没有 id 也没有 confirmToken 时无法确认 → 永远 refused（连个能对的字串都没有）。
 */
function isConfirmed(plan, options, info) {
  const expected = info.confirmToken
  if (!expected) return false
  const token = typeof options.confirmToken === 'string' ? options.confirmToken.trim() : ''
  if (token && token === expected) return true
  const confirm = options.confirm
  if (typeof confirm === 'string' && confirm.trim() === expected) return true
  return false
}

/* ------------------------------------------------------------------ *
 * 6. 落盘小工具
 * ------------------------------------------------------------------ */

/** 原子写：先写 `<name>.tmp-<pid>-<rand>` 再 rename。列表/读取要么看不到它，要么看到完整的它。 */
async function writeFileAtomic(target, text) {
  const tmp = `${target}.tmp-${process.pid}-${randomToken()}`
  await mkdir(dirname(target), { recursive: true })
  try {
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(tmp, target)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/** Exclusive random temporary file; a busy rename fails instead of truncating the live file. */
async function writeBytes(target, buffer) {
  const tmp = `${target}.dsh-doctor-${process.pid}-${randomToken()}.tmp`
  try {
    await writeFile(tmp, buffer, { flag: 'wx', mode: 0o600 })
    await rename(tmp, target)
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

/** 备份单个已存在的文件，保留相对数据根的层级；复制后回读大小，不符由调用方中止该步。 */
async function backupOne(target, size, ctx) {
  const rel = relative(ctx.home, target)
  const backupPath = join(ctx.backupDir, rel)
  const reason = await auditSymlink(backupPath, ctx.home, ctx.options)
  if (reason) throw new Error(reason)
  await mkdir(dirname(backupPath), { recursive: true })
  const before = await readFile(target)
  await copyFile(target, backupPath)
  const copiedBytes = await readFile(backupPath)
  if (copiedBytes.length !== size || !copiedBytes.equals(before)) throw new Error('备份字节校验失败，已中止')
  return { path: target, backupPath, bytes: copiedBytes.length, sha256: createHash('sha256').update(copiedBytes).digest('hex') }
}

/** JSON 深合并：对象逐键递归，数组与标量整体替换。原型污染的三个键直接忽略。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function mergeJson(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? mergeJson(out[key], value) : value
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 7. 内置校验（run-check 与 verificationChecks 共用）
 * ------------------------------------------------------------------ */

/**
 * 执行一条校验。返回 `{ ok, detail }`，永不抛（正则写错也是 fail 而不是崩溃）。
 * 只读，且只用 Node 内置能力——本模块不执行任何外部命令。
 */
async function evaluateCheck(spec, options = {}) {
  const kind = CHECK_KINDS.includes(spec?.kind) ? spec.kind : undefined
  if (!kind) return { ok: false, detail: `未知校验类型 ${String(spec?.kind)}` }
  const rawPath = typeof spec.path === 'string' ? spec.path.trim() : ''
  if (!rawPath || !isAbsolute(rawPath)) return { ok: false, detail: '校验缺少绝对路径' }
  const target = resolve(rawPath)
  const info = await inspectPath(target, options)
  if (kind === 'exists') return info.exists ? { ok: true, detail: '存在' } : { ok: false, detail: '不存在' }
  if (kind === 'absent') return info.exists ? { ok: false, detail: '仍然存在' } : { ok: true, detail: '已不存在' }
  if (!info.exists || !info.isFile) return { ok: false, detail: '文件不存在或不是普通文件' }

  let text
  try {
    text = await readFile(target, 'utf8')
  } catch (error) {
    // 只回传错误码，不回传文件内容：V8/Node 的报错可能带片段。
    return { ok: false, detail: `读取失败：${String(error?.code ?? 'unknown')}` }
  }
  if (kind === 'json') {
    try {
      JSON.parse(text)
      return { ok: true, detail: 'JSON 可解析' }
    } catch {
      return { ok: false, detail: 'JSON 无法解析（内容不写入日志）' }
    }
  }
  const expect = spec.expect ?? spec.value ?? spec.pattern
  if (kind === 'contains') return text.includes(String(expect ?? '')) ? { ok: true, detail: '命中' } : { ok: false, detail: '未命中目标字符串' }
  if (kind === 'not-contains') return text.includes(String(expect ?? '')) ? { ok: false, detail: '仍包含目标字符串' } : { ok: true, detail: '已不含目标字符串' }
  let regex
  try {
    regex = new RegExp(String(expect ?? ''))
  } catch {
    return { ok: false, detail: '正则表达式无法编译' }
  }
  const hit = regex.test(text)
  if (kind === 'regex') return hit ? { ok: true, detail: '正则命中' } : { ok: false, detail: '正则未命中' }
  return hit ? { ok: false, detail: '正则仍然命中' } : { ok: true, detail: '正则已不命中' }
}

/* ------------------------------------------------------------------ *
 * 8. 单步执行
 * ------------------------------------------------------------------ */

/**
 * 执行一步。返回 `{ status, detail, created?, bytes?, backup? }`，**不抛**（调用方再兜一层）。
 * 所有 detail 只描述「做了什么、多少字节、为什么不行」，绝不包含文件内容。
 */
async function runStep(step, ctx) {
  const { home, options, backupDir } = ctx
  if (step.kind === 'run-check') {
    const spec = { ...step.expect }
    if (!spec.path && step.path) spec.path = step.path
    const result = await evaluateCheck(spec, {})
    const label = `${String(spec.kind)} ${String(spec.path ?? step.rawTarget)}`
    return result.ok
      ? { status: 'applied', detail: `校验通过：${label}` }
      : { status: 'failed', detail: `校验未通过：${label}（${result.detail}）` }
  }

  const target = step.path
  const info = await inspectPath(target, options)

  if (step.kind === 'create-file') {
    const buffer = Buffer.from(step.content, 'utf8')
    if (info.exists) {
      if (info.isDirectory) return { status: 'failed', detail: `目标是目录，不能新建文件：${target}` }
      const current = await readFile(target)
      if (current.equals(buffer)) return { status: 'skipped', detail: `内容已一致（${buffer.length} B），未写入`, bytes: buffer.length }
      return { status: 'failed', detail: '目标已存在且内容不同：create-file 不覆盖已有文件（改用 write-file）' }
    }
    await mkdir(dirname(target), { recursive: true })
    await writeBytes(target, buffer)
    return { status: 'applied', detail: `已新建 ${buffer.length} B`, created: true, bytes: buffer.length }
  }

  if (step.kind === 'write-file') {
    const buffer = Buffer.from(step.content, 'utf8')
    if (info.exists) {
      if (!info.isFile) return { status: 'failed', detail: `目标不是普通文件：${target}` }
      const current = await readFile(target)
      if (current.equals(buffer)) return { status: 'skipped', detail: `内容已一致（${buffer.length} B），未写入`, bytes: buffer.length }
      const backup = await backupOne(target, info.size, { ...ctx, backupDir })
      await writeBytes(target, buffer)
      return { status: 'applied', detail: `已写入 ${buffer.length} B（备份 ${backup.bytes} B）`, created: false, bytes: buffer.length, backup }
    }
    await mkdir(dirname(target), { recursive: true })
    await writeBytes(target, buffer)
    return { status: 'applied', detail: `已新建 ${buffer.length} B`, created: true, bytes: buffer.length }
  }

  if (step.kind === 'patch-json') {
    if (info.exists) {
      if (!info.isFile) return { status: 'failed', detail: `目标不是普通文件：${target}` }
      const text = await readFile(target, 'utf8')
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return { status: 'failed', detail: '目标 JSON 解析失败（内容不写入日志），已中止' }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'failed', detail: '目标 JSON 不是对象，patch-json 只合并对象' }
      }
      const merged = mergeJson(parsed, step.patch)
      if (JSON.stringify(merged) === JSON.stringify(parsed)) {
        return { status: 'skipped', detail: 'JSON 已包含目标键值，未写入' }
      }
      const next = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf8')
      const backup = await backupOne(target, info.size, ctx)
      await writeBytes(target, next)
      return { status: 'applied', detail: `JSON 已合并（${next.length} B，备份 ${backup.bytes} B）`, created: false, bytes: next.length, backup }
    }
    const created = Buffer.from(`${JSON.stringify(step.patch, null, 2)}\n`, 'utf8')
    await mkdir(dirname(target), { recursive: true })
    await writeBytes(target, created)
    return { status: 'applied', detail: `已新建 JSON ${created.length} B`, created: true, bytes: created.length }
  }

  if (step.kind === 'delete-file') {
    if (!info.exists) return { status: 'skipped', detail: '目标不存在，无需删除' }
    if (info.isDirectory) return { status: 'failed', detail: `目标是目录，delete-file 只删文件：${target}` }
    const backup = await backupOne(target, info.size, ctx)
    await unlink(target)
    return { status: 'applied', detail: `已删除（备份 ${backup.bytes} B）`, bytes: 0, backup }
  }

  return { status: 'failed', detail: `不支持的步骤类型：${String(step.kind)}` }
}

/* ------------------------------------------------------------------ *
 * 9. 验证
 * ------------------------------------------------------------------ */

function normalizeChecks(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue
    const status = item.status === 'pass' || item.status === 'fail' || item.status === 'skip' ? item.status : 'skip'
    out.push({ id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `check-${out.length + 1}`, status, detail: clip(item.detail ?? '') })
  }
  return out
}

function deriveStatus(checks, declared) {
  if (declared === 'pass' || declared === 'fail' || declared === 'skip') return declared
  if (checks.some((check) => check.status === 'fail')) return 'fail'
  if (checks.length && checks.every((check) => check.status === 'pass')) return 'pass'
  return 'skip'
}

/**
 * 验证。三条来源按优先级：
 * 1. `options.verify(record)`（异步或同步都行）→ 用它的 status/checks；
 * 2. 计划自带的 `verificationChecks`：对象形态走内置校验；字符串形态只能 `skip`（给人看）；
 * 3. 两者都没有 → `status: 'skip'` + `detail: '无验证条件'`。
 */
async function verifyPlan(plan, record, options, home) {
  if (typeof options.verify === 'function') {
    try {
      const result = await options.verify(record)
      const checks = normalizeChecks(result?.checks)
      const status = deriveStatus(checks, result?.status)
      return { status, checks, detail: clip(result?.detail ?? `调用方验证：${checks.length} 项`) }
    } catch (error) {
      return {
        status: 'fail',
        checks: [{ id: 'verify-callback', status: 'fail', detail: `验证函数抛错：${errorText(error)}` }],
        detail: '验证函数抛错',
      }
    }
  }

  const declared = Array.isArray(plan?.verificationChecks) ? plan.verificationChecks : []
  if (!declared.length) return { status: 'skip', checks: [], detail: '无验证条件' }

  const checks = []
  for (let index = 0; index < declared.length; index += 1) {
    const entry = declared[index]
    if (typeof entry === 'string') {
      checks.push({ id: `check-${index + 1}`, status: 'skip', detail: `文字校验条件（需人工确认）：${clip(entry)}` })
      continue
    }
    if (!entry || typeof entry !== 'object') {
      checks.push({ id: `check-${index + 1}`, status: 'skip', detail: '无法识别的校验条件' })
      continue
    }
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `check-${index + 1}`
    const checkPath = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (!checkPath || !isAbsolute(checkPath) || !insideRoot(home, resolve(checkPath))) {
      checks.push({ id, status: 'skip', detail: `校验路径缺失或越界，已跳过：${clip(checkPath)}` })
      continue
    }
    const result = await evaluateCheck({ kind: entry.kind, path: checkPath, expect: entry.expect ?? entry.value ?? entry.pattern }, {})
    checks.push({
      id,
      status: result.ok ? 'pass' : 'fail',
      detail: result.ok ? `通过：${String(entry.kind)} ${clip(checkPath)}` : `未通过：${String(entry.kind)} ${clip(checkPath)}（${result.detail}）`,
    })
  }
  const status = deriveStatus(checks, undefined)
  const detail = status === 'skip' ? `只有文字校验条件（${checks.length} 项），需人工确认` : `${checks.length} 项内置校验：${status}`
  return { status, checks, detail }
}

/* ------------------------------------------------------------------ *
 * 10. 审计日志
 * ------------------------------------------------------------------ */

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
}

/** 写记录。失败不抛：审计写不进去不该把一次真实执行改写成异常。 */
async function persistRecord(home, record) {
  const dir = join(home, ...LOG_DIR)
  const file = join(dir, `${record.recordId}.json`)
  try {
    const reason = await auditSymlink(file, home)
    if (reason) throw new Error(reason)
    await writeFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`)
    record.logPath = file
    return file
  } catch (error) {
    record.logError = errorText(error)
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * 11. executePlan
 * ------------------------------------------------------------------ */

function blankSteps(steps) {
  return steps.map((step) => ({
    index: step.index,
    kind: step.kind ?? 'unknown',
    path: step.path ?? step.rawTarget,
    status: 'skipped',
    detail: '未执行',
  }))
}

/**
 * 执行一条计划。
 *
 * options: {
 *   home?, env?,            // 数据根覆盖（默认 ~/.dsh）——测试必须用它，绝不碰真实 profile
 *   confirmToken?, confirm?,// 确认令牌，必须等于 plan.confirmToken ?? plan.id
 *   verify?,                // (record) => { status, checks } | Promise<...>
 *   rollbackOnFailure?,     // 默认 true；false 时保留半成品并写进记录
 *   now?,                   // 固定时间戳（测试/审计对齐）
 *   probePath?              // 仅测试：符号链接判断的注入缝
 * }
 *
 * 永不抛 fs 异常给调用方：所有能预见的失败都落进 `record`（审计要能记下「试过、失败了」）。
 *
 * @returns {Promise<object>} ExecutionRecord
 */
export async function executePlan(plan, options = {}) {
  const nowMs = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const home = dataRoot(options, plan)
  const info = planInfoOf(plan)
  const recordId = `exec-${stampOf(nowMs)}-${randomToken()}`
  const { steps, blocking, pathIssues } = inspectPlan(plan, home)
  const startedAt = new Date(nowMs).toISOString()

  const record = {
    recordId,
    planId: info.planId,
    title: info.title,
    risk: info.risk,
    home,
    startedAt,
    finishedAt: startedAt,
    status: 'refused',
    steps: blankSteps(steps),
    backup: null,
    verification: { status: 'skip', checks: [], detail: '未执行' },
    rollback: { available: false, performed: false, detail: '' },
    confirmToken: info.confirmToken,
    confirmed: false,
    logPath: undefined,
  }

  const finish = async () => {
    record.finishedAt = new Date().toISOString()
    await persistRecord(home, record)
    return record
  }

  /* ---- ① 计划本身不成立 → refused（连预检都不做） ---- */
  if (blocking.length) {
    record.status = 'refused'
    record.refusedReasons = blocking
    record.verification = { status: 'skip', checks: [], detail: `计划不可执行：${blocking[0]}` }
    record.rollback = { available: false, performed: false, detail: '未写入任何文件' }
    for (const view of record.steps) view.detail = `计划不可执行，未执行：${blocking[0]}`
    return finish()
  }

  /* ---- ① 确认令牌 ---- */
  const confirmed = isConfirmed(plan, options, info)
  record.confirmed = confirmed
  if (!confirmed) {
    record.status = 'refused'
    record.refusedReasons = [`缺少确认令牌：options.confirmToken 或 options.confirm 必须逐字等于 ${info.confirmToken}`]
    record.verification = { status: 'skip', checks: [], detail: '未执行（缺少确认令牌）' }
    record.rollback = { available: false, performed: false, detail: '未写入任何文件' }
    for (const view of record.steps) view.detail = '缺少确认令牌，未执行'
    return finish()
  }

  /* ---- ②③ 预检：纯路径规则先判，再过符号链接/realpath；任一步不过 → 全不动 ---- */
  const issues = new Map(pathIssues)
  if (!issues.size) {
    for (const step of steps) {
      if (step.kind === 'run-check' || !step.path) continue
      const reason = await auditSymlink(step.path, home, options)
      if (reason) issues.set(step.index, `change #${step.index} ${reason}`)
    }
  }
  if (issues.size) {
    record.status = 'failed'
    for (const view of record.steps) {
      const reason = issues.get(view.index)
      if (reason) {
        view.status = 'failed'
        view.detail = `预检拒绝：${reason}`
      } else {
        view.detail = '预检未通过：整条计划一个文件都没动'
      }
    }
    record.refusedReasons = [...issues.values()]
    record.verification = { status: 'skip', checks: [], detail: '未执行（预检未通过，未写入任何文件）' }
    record.rollback = { available: false, performed: false, detail: '预检阶段没有写入任何文件，无需回滚' }
    return finish()
  }

  // A durable started receipt is a prerequisite for any target write.
  record.phase = 'started'
  if (!await persistRecord(home, record)) {
    record.status = 'refused'
    record.refusedReasons = ['执行审计写入失败，目标文件尚未修改']
    return record
  }

  /* ---- ④ 备份根：只在真的要覆盖/删除时才用到 ---- */
  const ctx = {
    home,
    options,
    backupDir: join(home, ...BACKUP_DIR, `${stampOf(nowMs)}-${recordId}`),
    backups: [],
  }

  /* ---- 执行 ---- */
  let failure
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const view = record.steps[index]
    if (failure) {
      view.detail = '前序步骤失败，未执行'
      continue
    }
    let outcome
    try {
      outcome = await runStep(step, ctx)
    } catch (error) {
      // 备份失败、写失败、权限不足…… 都在这里收口。错误信息只带路径与错误码量级的文本。
      outcome = { status: 'failed', detail: `执行异常：${errorText(error)}` }
    }
    view.status = outcome.status
    view.detail = clip(outcome.detail ?? '')
    if (outcome.created !== undefined) view.created = outcome.created
    if (outcome.bytes !== undefined) view.bytes = outcome.bytes
    if (outcome.backup) ctx.backups.push(outcome.backup)
    if (outcome.status === 'applied' && step.kind !== 'run-check') {
      try {
        if (step.kind === 'delete-file') view.afterSha256 = null
        else view.afterSha256 = createHash('sha256').update(await readFile(step.path)).digest('hex')
      } catch { outcome.status = view.status = 'failed'; view.detail = '写后字节读取失败' }
    }
    if (outcome.status === 'failed') failure = view.detail
  }

  if (ctx.backups.length) {
    record.backup = {
      dir: ctx.backupDir,
      files: ctx.backups.map((item) => ({ path: item.path, backupPath: item.backupPath, bytes: item.bytes, sha256: item.sha256 })),
    }
  }

  /* ---- ⑥ 验证 ---- */
  record.verification = await verifyPlan(plan, record, options, home)

  const wrote = record.steps.some((view) => view.status === 'applied' && view.kind !== 'run-check')
  const failed = record.steps.some((view) => view.status === 'failed') || record.verification.status === 'fail'
  record.status = failed ? 'failed' : wrote ? 'applied' : 'noop'

  /* ---- ⑦ 失败即回滚 ---- */
  const rollbackable = record.steps.some((view) => view.created === true) || Boolean(record.backup)
  record.rollback.available = rollbackable
  if (record.status === 'failed' && options.rollbackOnFailure !== false) {
    if (rollbackable) {
      const result = await rollbackExecution(record, { home, persist: false })
      record.rollback = { available: true, performed: result.performed, detail: result.detail }
    } else {
      record.rollback.detail = '没有可回滚的写入（失败发生在任何落盘之前）'
    }
  } else if (record.status === 'failed') {
    record.rollback.detail = options.rollbackOnFailure === false ? '调用方关闭了自动回滚（rollbackOnFailure=false），半成品保留' : '没有可回滚的写入'
  } else {
    record.rollback.detail = rollbackable ? `备份保留在 ${ctx.backupDir}，可用 rollbackExecution 还原` : '没有写入，无需回滚'
  }

  record.phase = 'finished'
  return finish()
}

/* ------------------------------------------------------------------ *
 * 12. rollbackExecution
 * ------------------------------------------------------------------ */

/**
 * 按执行记录回滚：删掉「本次新建」的文件，再从备份还原被覆盖/删除的文件。
 *
 * 记录里的路径是外部可改的（日志文件在磁盘上），所以回滚时**重新做一遍路径校验**：
 * - 目标必须在数据根内且不在受保护目录；
 * - 备份来源必须在 `<home>/state/dsh-doctor/backups/` 之内。
 * 这条重复检查是刻意的：回滚是最容易变成「任意文件写入」的入口。
 *
 * @param {object} record
 * @param {{ home?: string, env?: string, persist?: boolean }} [options] persist=false 时由调用方统一落盘
 * @returns {Promise<{ recordId: string, restored: number, removed: number, performed: boolean, files: object[], detail: string }>}
 */
export async function rollbackExecution(record, options = {}) {
  const out = { recordId: record?.recordId, restored: 0, removed: 0, performed: false, files: [], detail: '' }
  if (!record || typeof record !== 'object') {
    out.detail = '缺少执行记录'
    return out
  }
  const home = dataRoot(options, record)
  const backupRoot = join(home, ...BACKUP_DIR)
  const entries = Array.isArray(record.backup?.files) ? record.backup.files : []
  const created = (Array.isArray(record.steps) ? record.steps : [])
    .filter((step) => step && step.created === true && typeof step.path === 'string' && step.path)
    .map((step) => resolve(step.path))

  if (!entries.length && !created.length) {
    out.detail = '没有可回滚的备份或新建文件'
    record.rollback = { available: false, performed: false, detail: out.detail }
    if (options.persist !== false) await persistRecord(home, record)
    return out
  }

  // Validate the whole batch before the first restore. New receipts bind both the
  // backup bytes and the post-write file, so rollback preserves later edits.
  const latest = new Map()
  for (const step of record.steps ?? []) if (step?.path && Object.hasOwn(step, 'afterSha256')) latest.set(resolve(step.path), step.afterSha256)
  for (const target of new Set([...created, ...entries.map((entry) => entry?.path).filter(Boolean).map((path) => resolve(path))])) {
    const reason = policyReason(home, target) || await auditSymlink(target, home, options)
    if (reason) { out.files.push({ path: target, action: 'preflight', ok: false, detail: reason }); continue }
    if (latest.has(target)) {
      let actual
      try { actual = createHash('sha256').update(await readFile(target)).digest('hex') }
      catch (error) { if (error.code === 'ENOENT') actual = null; else { out.files.push({ path: target, action: 'preflight', ok: false, detail: '目标读取失败' }); continue } }
      const priorBackup = entries.find((entry) => typeof entry?.path === 'string' && resolve(entry.path) === target)
      const alreadyRestored = record.rollback?.performed === true && (priorBackup?.sha256 ? actual === priorBackup.sha256 : created.includes(target) && actual === null)
      if (actual !== latest.get(target) && !alreadyRestored) out.files.push({ path: target, action: 'preflight', ok: false, detail: '执行后文件已改变，保留当前内容' })
    }
  }
  for (const entry of entries) {
    const from = typeof entry?.backupPath === 'string' ? resolve(entry.backupPath) : ''
    const reason = !from || !insideRoot(backupRoot, from) ? '备份路径越界' : await auditSymlink(from, home, options)
    if (reason) { out.files.push({ path: entry?.path, action: 'preflight', ok: false, detail: reason }); continue }
    try {
      const digest = createHash('sha256').update(await readFile(from)).digest('hex')
      if (entry.sha256 && digest !== entry.sha256) throw new Error('备份内容已改变')
    } catch { out.files.push({ path: entry?.path, action: 'preflight', ok: false, detail: '备份读取或哈希校验失败' }) }
  }
  if (out.files.length) { out.detail = '回滚预检未通过；本次未还原或删除任何目标文件'; return out }
  if (options.persist !== false && !await persistRecord(home, record)) { out.files.push({ action: 'audit', ok: false, detail: '审计写入失败' }); out.detail = '回滚审计未写入，目标保持原状'; return out }

  /* 1) 先删本次新建的文件：回滚 = 回到「执行前它不存在」。倒序更贴近栈语义。 */
  for (const target of [...created].reverse()) {
    const reason = isAbsolute(target) ? policyReason(home, target) : '路径不是绝对路径'
    if (reason) {
      out.files.push({ path: target, action: 'remove', ok: false, detail: reason })
      continue
    }
    try {
      await unlink(target)
      out.removed += 1
      out.files.push({ path: target, action: 'remove', ok: true })
    } catch (error) {
      if (error?.code === 'ENOENT') out.files.push({ path: target, action: 'remove', ok: true, detail: '已不存在' })
      else out.files.push({ path: target, action: 'remove', ok: false, detail: errorText(error) })
    }
  }

  /* 2) 再从备份还原被覆盖 / 被删除的文件。 */
  for (const entry of [...entries].reverse()) {
    const target = typeof entry?.path === 'string' && entry.path ? resolve(entry.path) : undefined
    const from = typeof entry?.backupPath === 'string' && entry.backupPath ? resolve(entry.backupPath) : undefined
    if (!target || !from) {
      out.files.push({ path: target, action: 'restore', ok: false, detail: '记录缺少 path/backupPath' })
      continue
    }
    if (!insideRoot(backupRoot, from)) {
      out.files.push({ path: target, action: 'restore', ok: false, detail: '备份来源不在备份根之内' })
      continue
    }
    const reason = isAbsolute(target) ? policyReason(home, target) : '路径不是绝对路径'
    if (reason) {
      out.files.push({ path: target, action: 'restore', ok: false, detail: reason })
      continue
    }
    try {
      await mkdir(dirname(target), { recursive: true })
      await copyFile(from, target)
      const size = (await lstat(target)).size
      if (Number.isFinite(entry.bytes) && size !== entry.bytes) throw new Error(`还原后大小 ${size} B ≠ 备份 ${entry.bytes} B`)
      out.restored += 1
      out.files.push({ path: target, action: 'restore', ok: true })
    } catch (error) {
      out.files.push({ path: target, action: 'restore', ok: false, detail: errorText(error) })
    }
  }

  out.performed = out.restored + out.removed > 0
  out.detail = `还原 ${out.restored} 个文件，删除 ${out.removed} 个本次新建的文件`
  if (out.files.some((item) => !item.ok)) out.detail += '（有失败项，详见 files）'
  record.rollback = { available: true, performed: out.performed, detail: out.detail }
  if (options.persist !== false) await persistRecord(home, record)
  return out
}

/* ------------------------------------------------------------------ *
 * 13. listExecutions
 * ------------------------------------------------------------------ */

/**
 * 读执行日志，最新在前，最多 20 条。
 *
 * 只认 `exec-*.json` 的普通文件：目录里混进的 `.tmp-*` 残骸、用户手放的笔记、
 * 别的插件的文件一律不读。坏 JSON 直接跳过——一份坏记录不该让整页历史消失。
 */
export async function listExecutions(options = {}) {
  const home = dataRoot(options)
  const dir = join(home, ...LOG_DIR)
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : MAX_LIST
  const entries = await safeReaddir(dir)
  const items = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!RECORD_RE.test(entry.name)) continue
    const full = join(dir, entry.name)
    let text
    try {
      text = await readFile(full, 'utf8')
    } catch {
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    parsed.logPath = full
    items.push(parsed)
  }
  const timeOf = (item) => {
    const value = Date.parse(String(item?.startedAt ?? ''))
    return Number.isFinite(value) ? value : 0
  }
  items.sort((a, b) => timeOf(b) - timeOf(a) || String(b.recordId ?? '').localeCompare(String(a.recordId ?? '')))
  return items.slice(0, limit)
}

export default {
  EXEC_VERSION,
  EXEC_KINDS,
  EXEC_STATUS,
  CHECK_KINDS,
  summarizePlan,
  executePlan,
  rollbackExecution,
  listExecutions,
}
