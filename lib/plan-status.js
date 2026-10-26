/**
 * DSH Doctor · 计划执行状态（PlanStatus）：把「校验结论」折叠成一个状态 + 一句话 + 原因列表。
 *
 * 为什么单独一层：`repair-plan` 产出的是**草案**，`repair-exec` 才是**动手**，中间隔着一次
 * 校验（executability = `{ executable, reasons, checked }`）。面板既不能把「还没校验」画成
 * 「可执行」，也不能把「只读建议」画成「执行受阻」——前者让人在没预览的情况下点按钮，
 * 后者让人以为只读计划也能执行、或者以为它坏了。本模块只做那次折叠，输出固定三字段：
 * `{ executionState, executionLabel, blockedReasons }`。
 *
 * 四条状态（封闭集合，别处不许再加）：
 *   executable → 已校验 + 执行器说能做 + 计划里**确实有**改动。
 *                label 仍写「仍需确认」：L2 纪律是「预览 + 明确确认」，
 *                状态可执行**不等于**自动执行，别把两者混成一个词。
 *   read-only  → 已校验 + 执行器明确说不能做 + 计划确实是只读的：
 *                显式空 `changes`、没有拒收改动、`coverage.complete !== false`、没有延后、
 *                原因为空或只有执行器自己那句「计划没有 changes：只读计划没有可执行动作」。
 *                **没有动作不是阻塞**，所以这一态的 `blockedReasons` 必须是 `[]`；
 *                把执行器的「无事可做」原样塞进 blockedReasons，面板就会画出红色告警。
 *   blocked    → 已校验，但动手的前提不成立：有改动却没被放行 / 改动被拒收 /
 *                覆盖不完整 / 存在延后 / 原因非空 / 计划结构本身不成立（缺 changes、不是对象）。
 *   unchecked  → 还没校验，或调用方显式 `checked: false`。缺省补一句
 *                「请先在对话里预览校验」，不假装已有结论。
 *
 * 三条不许越界的纪律：
 *   1. **不凭 risk 猜执行能力。** 风险等级回答「要不要多问一次」，不回答「能不能做」；
 *      `risk: 'low'` 不等于可执行，`risk: 'high'` 也不等于不能。可执行性只由
 *      executability 与计划结构决定（与 `repair-plan.js` 的 describeRisk 分工一致）。
 *   2. **不虚报。** 执行器标了 `executable: true` 但计划里没有可用改动，落 blocked，
 *      绝不落 executable——「按钮能点但一点就报错」比「按钮是灰的」昂贵得多。
 *   3. **不回传正文。** 输出只有三个字段：不含 `changes[].content` / `changes[].target`、
 *      不含 `patch`、不含 `meta` 内部内容、不含 `rejectedChanges` 正文（只给条数）。
 *      本模块因此是纯函数、零依赖、不 import 任何 `node:` 模块：它读不到盘，也不需要。
 *
 * 稳健性：`plan` / `executability` 传 null、数组、字符串、数字、缺字段，一律不抛，
 * 折叠成 blocked 或 unchecked；本模块**不修改入参**（只读字段，不排序、不裁切、不补默认值到入参上）。
 * 浏览器与主机共用同一份实现，所以这里没有环境判断分支。
 */

/** 模块自身版本，跟随契约变更；与插件 package.json 版本无关。 */
export const PLAN_STATUS_VERSION = '1.0.0'

/** 封闭状态集合。顺序即「越靠前越接近动手」，面板按它排序/着色时可以直接用。 */
export const EXECUTION_STATES = ['executable', 'read-only', 'blocked', 'unchecked']

/**
 * 固定文案表，唯一真源：面板、CLI、测试都从这里取，别在别处手抄。
 * 改一个字就是改契约，需要同步测试里的逐字断言。
 */
export const EXECUTION_LABELS = {
  executable: '可执行（仍需确认）',
  'read-only': '只读建议（无文件改动）',
  blocked: '执行受阻',
  unchecked: '尚未校验',
}

/**
 * 执行器（`lib/repair-exec.js` 的 inspectPlan）在「计划没有改动」时给出的原话。
 * 只读计划必然带这一条原因，它描述的是「无事可做」，不是「被拦住」，
 * 因此只读态要把它从 blockedReasons 里剔除（剔除后为空 → 只读，而不是阻塞）。
 * 逐字对齐 repair-exec.js，改那边就得同步这边。
 */
export const READ_ONLY_NO_CHANGES_REASON = '计划没有 changes：只读计划没有可执行动作'

/** 未校验态的缺省提示：告诉人下一步做什么，而不是留一个空原因。 */
const UNCHECKED_REASON = '请先在对话里预览校验'
/** 已校验、不能执行、但计划里确实有改动时的兜底原因（调用方没给原因才用）。 */
const CHANGES_NOT_READY_REASON = '有改动但尚未满足执行条件'
/** 结构性问题：没有 changes 字段，或它不是数组。 */
const NO_CHANGES_ARRAY_REASON = '计划缺少显式的 changes 数组，无法判断执行能力'
/** 结构性问题：plan 本身不是对象。 */
const NO_PLAN_REASON = '计划不是对象，无法判断执行能力'
/** executable:true 但数组里没有可用条目（全是 null / 字符串 / 数组）。 */
const NO_USABLE_CHANGES_REASON = '执行器标记为可执行，但 changes 里没有可用条目'
/** executable:true 但数组是空的。 */
const EXECUTABLE_WITHOUT_CHANGES_REASON = '执行器标记为可执行，但计划没有改动'
/** checked:true 却没给布尔结论时的兜底：不猜，落阻塞。 */
const NO_EXECUTABLE_VERDICT_REASON = '已校验但缺少 executable 布尔结论'

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 原因清洗：只收 trim 后非空的字符串，去重（按 trim 后的值），保持首次出现的顺序。
 * 非数组（含单个字符串）一律当「没给原因」——不做「顺手接受」的宽容，
 * 否则调用方传 `reasons: '一条长字符串'` 会被拆成字符或整条塞进去，两种都错。
 */
function uniqueReasons(list) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** 统一出口：保证三个字段、固定 label、原因已清洗去重。 */
function result(state, reasons) {
  return {
    executionState: state,
    executionLabel: EXECUTION_LABELS[state],
    blockedReasons: uniqueReasons(reasons),
  }
}

/** 延后条数：既接受数组（延后路径清单），也接受数值（计数）；其余一律当 0。 */
function deferredCountOf(plan) {
  if (!isRecord(plan)) return 0
  const deferred = plan.deferred
  if (Array.isArray(deferred)) return deferred.length
  if (typeof deferred === 'number' && Number.isFinite(deferred) && deferred > 0) return Math.trunc(deferred)
  return 0
}

/**
 * 让「只读」不成立的额外原因（按固定顺序生成，便于测试逐字断言）：
 * 拒收改动只报条数——正文（target / 原因）属于执行器内部，不进公开输出。
 */
function environmentReasons(plan) {
  if (!isRecord(plan)) return []
  const extras = []
  const rejected = isRecord(plan.meta) ? plan.meta.rejectedChanges : undefined
  if (Array.isArray(rejected) && rejected.length > 0) {
    extras.push(`有 ${rejected.length} 个改动被执行器拒收（正文不回传）`)
  }
  if (isRecord(plan.coverage) && plan.coverage.complete === false) {
    extras.push('扫描覆盖不完整：仍有未扫描或不可读的文件')
  }
  const deferred = deferredCountOf(plan)
  if (deferred > 0) extras.push(`有 ${deferred} 项改动延后未处理（活动窗口内的文件不写）`)
  return extras
}

/**
 * 折叠执行状态。签名是契约，别改：
 *   describePlanExecution(plan, executability = {})
 *     → { executionState, executionLabel, blockedReasons }
 *
 * executability 语义：
 *   - `checked` 缺省 = `typeof executable === 'boolean'`；显式 `false` 优先（哪怕 executable 有值），
 *     落 unchecked 并**保留**调用方给的原因（没给才补缺省提示）。
 *   - `reasons` 只接受字符串数组，逐条 trim、去空、去重。
 */
export function describePlanExecution(plan, executability = {}) {
  const verdict = isRecord(executability) ? executability : {}
  const given = uniqueReasons(verdict.reasons)
  const checked = typeof verdict.checked === 'boolean'
    ? verdict.checked
    : typeof verdict.executable === 'boolean'

  if (!checked) return result('unchecked', given.length ? given : [UNCHECKED_REASON])

  const record = isRecord(plan) ? plan : undefined
  const changes = record ? record.changes : undefined
  const explicit = Array.isArray(changes)
  const count = explicit ? changes.length : 0
  const usable = explicit ? changes.filter(isRecord).length : 0

  /* --- 执行器说能做：只认「真有计划改动」，一个条件不成立就落 blocked --- */
  if (verdict.executable === true) {
    const structural = []
    if (!record) structural.push(NO_PLAN_REASON)
    if (!explicit) structural.push(NO_CHANGES_ARRAY_REASON)
    else if (count === 0) structural.push(EXECUTABLE_WITHOUT_CHANGES_REASON)
    else if (usable === 0) structural.push(NO_USABLE_CHANGES_REASON)
    if (structural.length) return result('blocked', [...given, ...structural])
    return result('executable', given)
  }

  /* --- 执行器说不能做：先分清「只读」与「被拦住」 --- */
  if (verdict.executable === false) {
    const extras = environmentReasons(record)
    if (!record) return result('blocked', [...given, NO_PLAN_REASON, ...extras])
    if (!explicit) return result('blocked', [...given, NO_CHANGES_ARRAY_REASON, ...extras])
    if (count > 0) {
      const reasons = [...given, ...extras]
      return result('blocked', reasons.length ? reasons : [CHANGES_NOT_READY_REASON])
    }
    /* changes 显式为空：执行器的「没有 changes」不是阻塞，其余原因才是。 */
    const leftover = given.filter((reason) => reason !== READ_ONLY_NO_CHANGES_REASON)
    if (leftover.length || extras.length) return result('blocked', [...leftover, ...extras])
    return result('read-only', [])
  }

  /* --- checked:true 却没给布尔结论：不猜能执行，落阻塞并说清楚缺了什么 --- */
  return result('blocked', [...given, NO_EXECUTABLE_VERDICT_REASON])
}
