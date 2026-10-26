/**
 * DSH Doctor — 修复计划层（RepairPlan）：**只生成计划，绝不执行**。
 *
 * 为什么单独一层：
 * 诊断层说的是「哪里可能坏了」，复制粘贴到「动手改」之间隔着一次判断——
 * 改哪个文件、风险几级、能不能无人值守地做、做完怎么证明修好了、坏了怎么退回去。
 * 这一层只做那一次判断，并把结论固化成结构化对象，让面板/CLI/未来的修复执行器
 * 都读同一份东西。**本模块没有执行路径**：不 import `node:fs`、不 import
 * `node:child_process`、不读环境变量、不联网，唯一的外部依赖是 `node:path`
 * 做路径拼接。所有 `context` 只用来填空（home / profileDir / dshRoot / facts / now），
 * 传进来的事实被当成「已经采好的快照」，本模块不回头验证它们。
 *
 * 与 `lib/repair-secrets.js` 同构：
 * 那个模块是本插件第一个**会改文件**的动作，它的纪律是「默认不写 → 必须 confirm →
 * 写前备份 → 写后复检 → 失败自动回滚」，计划对象长这样：
 * `{ id, title, risk, explanation, preconditions[], changes[], rollbackAvailable,
 *    verificationChecks[], dryRun, totalHits }`。这里的 RepairPlan 保留同一组字段
 * （`totalHits` 换成诊断相关数字，放进 `meta`），再加 `diagnosisId / rollbackNote /
 * steps / requiresConfirm / createdAt`，因为计划要给人看、要能跨进程传。
 *
 * 风险分级（`describeRisk`，唯一实现，别处不许再写一份）：
 *   low    → 只读或等价于只读（核对清单、收集快照、给建议）。`autoAllowed: true`，
 *            即使可自动，也要**记录**进历史，事后能查到「谁在什么时候做了这个判断」。
 *   medium → 改配置、停用/重装插件、为路由加代理。`confirmRequired: true`，
 *            `autoAllowed: false`：必须先预览改动，再由人明确确认。
 *   high   → 覆盖写 profile 配置、重写会话日志。`confirmRequired: true`，
 *            `autoAllowed: false`，并且必须「备份 → 写 → 复检 → 失败回滚」。
 * 非法/未知风险值一律按 high 处理（fail-closed：宁可多问一次，不可少问一次）。
 *
 * L2 纪律的出处：
 * 设计文档《DSH Doctor 详细设计计划》模块 6「修复引擎」（P1）与项目确认过的动作分级：
 * **L2 动作（改配置 / 装卸插件 / 杀进程 / 重启）必须「预览 + 明确确认」**；
 * 不可逆操作（删用户数据、改注册表、杀进程、清空目录）第一版**不做**——
 * 所以 `CHANGE_OPERATIONS` 只有 create / update / delete 三个值，且 `normalizeChanges`
 * 会把落在会话数据、凭据文件、state 目录上的 delete 直接拒收（记进 `meta.rejectedChanges`），
 * 而不是「生成了再提示一句小心」。
 *
 * 契约（与推理层对齐，字段名固定，不新增别名）：
 *   Diagnosis = { id, hypothesisId, title, category, severity, status:'issue', confidence,
 *                 summary, evidence[], causes[{cause,weight,basis}], nextChecks[],
 *                 affectedRules[], contradicts[], repairHint }
 * 本模块实际只读 `id / hypothesisId / summary / evidence` 四个字段：
 * `id` 填 `diagnosisId`，`hypothesisId` 选规划器，`evidence`（缺失时退回 `summary`）进
 * `explanation` 当引文。`causes / contradicts / confidence / severity / nextChecks /
 * affectedRules / repairHint` 一律不用——它们影响「信不信」，不影响「怎么做」；
 * 计划层要是能自己挑结论，规则层的置信度就白算了。
 *
 * 规划器（PLANNERS）是唯一扩展点：`{ id, hypothesisId, risk, note?, nullReason?, plan }`。
 * `plan(diagnosis, context)` 返回 RepairPlan 或 null；`null` 是**契约内的答案**，不是错误：
 * 没有把握的动作，宁可不做。`UNPLANNED` 明确列出「故意不规划」的假设与原因，供 UI 解释。
 */
import { isAbsolute, relative, resolve } from 'node:path'

export const REPAIR_VERSION = '1.0.0'

/** 三种风险等级，顺序即严重度。 */
export const RISK_LEVELS = ['low', 'medium', 'high']

/** 对外展示用的中文标签（面板与 CLI 共用，别在别处手抄）。 */
export const RISK_LABELS = {
  low: '只读/低风险',
  medium: '中风险',
  high: '高风险',
}

/** `changes[].operation` 的封闭集合。不在这个集合里的操作不存在「计划」可言。 */
export const CHANGE_OPERATIONS = ['create', 'update', 'delete']

/** 这些路径上的删除与覆盖直接拒收：不是「不建议」，是「本模块不生成」。 */
const CREDENTIAL_FILE = /\.credentials\.yaml$/i
const BACKUP_MANIFEST = /\.dsh-doctor-backup\.json$/i

/* ------------------------------------------------------------------ *
 * 1. describeRisk —— 风险 → 能不能自动做
 * ------------------------------------------------------------------ */

/**
 * 风险分级。未知等级按 high（fail-closed）：
 * 拼错一个 risk 值就变成「可自动执行」，是这一层最昂贵的 bug。
 */
export function describeRisk(risk) {
  const level = RISK_LEVELS.includes(risk) ? risk : 'high'
  return {
    level,
    label: RISK_LABELS[level],
    confirmRequired: level !== 'low',
    autoAllowed: level === 'low',
  }
}

/* ------------------------------------------------------------------ *
 * 2. 小工具（纯函数，不碰盘）
 * ------------------------------------------------------------------ */

function asTextList(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

function uniqueStrings(values) {
  const out = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/** `'plan-' + 规划器 id`，刻意不含时间戳：同一个假设在历史里应指向同一条计划线。 */
function planIdOf(plannerId) {
  return `plan-${plannerId}`
}

function diagnosisIdOf(diagnosis) {
  if (diagnosis && typeof diagnosis.id === 'string' && diagnosis.id.trim()) return diagnosis.id.trim()
  if (diagnosis && typeof diagnosis.hypothesisId === 'string') return `hyp-${diagnosis.hypothesisId}`
  return 'hyp-unknown'
}

/** context.now ?? now：允许 Date / 毫秒数 / ISO 串；认不出来就退回当前时间。 */
function timestampOf(now) {
  if (now !== undefined && now !== null) {
    const date =
      now instanceof Date
        ? now
        : typeof now === 'number'
          ? new Date(now)
          : typeof now === 'string'
            ? new Date(now)
            : undefined
    if (date && !Number.isNaN(date.getTime())) return date.toISOString()
  }
  return new Date().toISOString()
}

/** 证据摘要：截断到 limit 条、每条 140 字，避免把整份报告塞进 explanations。 */
function evidenceLine(diagnosis, limit = 2) {
  const items = Array.isArray(diagnosis?.evidence)
    ? diagnosis.evidence.filter((value) => typeof value === 'string' && value.trim())
    : []
  const trimmed = items.slice(0, limit).map((value) => (value.length > 140 ? `${value.slice(0, 139)}…` : value))
  if (trimmed.length) return trimmed.join('；')
  if (typeof diagnosis?.summary === 'string' && diagnosis.summary.trim()) return diagnosis.summary.trim()
  return '诊断没有附带证据'
}

/** 步骤统一编号：planner 里写人话，编号由这里加，免得手写序号错位。 */
function numberSteps(steps) {
  return asTextList(steps).map((text, index) => `${index + 1}. ${text}`)
}

/** 把事实快照里的点号路径读成字符串；读不到就 undefined，不抛。 */
function readPath(root, dotted) {
  if (!root || typeof dotted !== 'string') return undefined
  let node = root
  for (const key of dotted.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = node[key]
  }
  if (typeof node === 'string' && node.trim()) return node.trim()
  return node
}

/** 目录来源：先看 context 顶层，再看 facts 里已知的位置。 */
const DIR_SOURCES = {
  home: ['home', 'facts.data.home'],
  profileDir: ['profileDir', 'facts.configuration.profileDir'],
  dshRoot: ['dshRoot', 'facts.install.root'],
}

function dirOf(context, name) {
  for (const dotted of DIR_SOURCES[name] ?? []) {
    const value = readPath(context, dotted)
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * 拼 `changes[].target`：有真路径就拼绝对路径；没有就保留 `<profileDir>/...` 这种可读占位。
 * 占位不是「偷懒」——面板与 CLI 都要能显示「这条计划会改哪个文件」，
 * 而在没有 profileDir 的调用场景（纯规则单测、报告导出的离线渲染）里，
 * 一个假造的绝对路径比占位更危险：它会看起来像真的。
 */
function under(context, dirName, ...parts) {
  const tail = parts.filter((part) => typeof part === 'string' && part !== '')
  const base = dirOf(context, dirName)
  if (base) return resolve(base, ...tail)
  return `<${dirName}>/${tail.join('/')}`
}

function patchPathOf(context) {
  const direct = readPath(context, 'facts.configuration.patchPath')
  if (typeof direct === 'string') return resolve(direct)
  return under(context, 'profileDir', 'cordis.patch.yml')
}

function profilePkgPathOf(context) {
  const direct = readPath(context, 'facts.configuration.profilePkgPath')
  if (typeof direct === 'string') return resolve(direct)
  return under(context, 'profileDir', 'package.json')
}

/** `target` 落在 `base` 之内（含 base 本身）。纯路径运算，不跟随符号链接、不读盘。 */
function within(target, base) {
  if (!target || !base) return false
  const rel = relative(resolve(base), resolve(target))
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 改动安全带。这里拒收的东西是**写死在代码里的边界**，不是配置项：
 * - 删除会话数据 / state 目录 = 不可逆，第一版不做；
 * - 任何写/删 `.credentials.yaml` = 凭据不归修复引擎管（轮换密钥是人的决定）；
 * - 删备份清单 = 把唯一的回滚线索也删了。
 * 返回原因字符串表示拒收，undefined 表示放行。
 */
function unsafeChange(change, context) {
  const target = typeof change?.target === 'string' ? change.target.trim() : ''
  if (!target) return '缺少 target'
  if (!CHANGE_OPERATIONS.includes(change.operation)) return `未知操作 ${String(change.operation)}`
  if (CREDENTIAL_FILE.test(target)) return '凭据文件不在修复范围内（轮换密钥请手工做）'
  if (change.operation !== 'delete') return undefined
  const home = dirOf(context, 'home')
  if (home && within(target, resolve(home, 'sessions'))) return '会话数据不可删除'
  if (home && within(target, resolve(home, 'state'))) return 'state 目录不可删除'
  if (BACKUP_MANIFEST.test(target)) return '备份清单不可删除（回滚靠它）'
  return undefined
}

/**
 * 规范化 `changes`：只留 create/update/delete，拒收的写进 rejected。
 * 注意这里**不会**自动把未知操作改成 update：错的操作比没有操作更糟，
 * 直接丢掉并留痕，比悄悄替规划器做决定诚实。
 */
function normalizeChanges(changes, context) {
  const accepted = []
  const rejected = []
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || typeof change !== 'object') continue
    const target = typeof change.target === 'string' ? change.target.trim() : ''
    const operation = typeof change.operation === 'string' ? change.operation.trim().toLowerCase() : ''
    const candidate = { target, operation, description: typeof change.description === 'string' ? change.description.trim() : '' }
    const reason = unsafeChange(candidate, context)
    if (reason) {
      rejected.push({ target: target || '(空)', operation: operation || '(空)', reason })
      continue
    }
    accepted.push(candidate)
  }
  return { changes: accepted, rejected }
}

/**
 * 组装 RepairPlan。字段集合是契约，扩展一律进 `meta`：
 * 顶层随便加字段会让下游的「字段固定」假设失效（面板按字段渲染、序列化会变）。
 */
function finalizePlan(plannerId, hypothesisId, diagnosis, context, fields) {
  const risk = RISK_LEVELS.includes(fields.risk) ? fields.risk : 'high'
  const described = describeRisk(risk)
  const { changes, rejected } = normalizeChanges(fields.changes, context)
  const meta = { planner: plannerId, hypothesisId, riskLabel: described.label, autoAllowed: described.autoAllowed }
  for (const [key, value] of Object.entries(fields.meta ?? {})) {
    if (value !== undefined) meta[key] = value
  }
  if (rejected.length) meta.rejectedChanges = rejected
  if (fields.layer) meta.layer = fields.layer

  return {
    id: planIdOf(plannerId),
    diagnosisId: diagnosisIdOf(diagnosis),
    title: fields.title,
    risk,
    explanation: fields.explanation,
    preconditions: asTextList(fields.preconditions),
    changes,
    rollbackAvailable: Boolean(fields.rollbackAvailable),
    rollbackNote: fields.rollbackNote ?? '',
    verificationChecks: asTextList(fields.verificationChecks),
    steps: numberSteps(fields.steps),
    requiresConfirm: described.confirmRequired,
    dryRun: true,
    createdAt: timestampOf(context?.now),
    meta,
  }
}

/* ------------------------------------------------------------------ *
 * 3. 从事实快照里取计划所需的几个数（只读快照，不回头验证）
 * ------------------------------------------------------------------ */

/** 没声明支持当前 DSH 的插件（与 DSH-PLG-003 同一判据：compat.declared && ok === false）。 */
function incompatiblePlugins(context) {
  const plugins = readPath(context, 'facts.plugins')
  if (!Array.isArray(plugins)) return []
  return plugins.filter((plugin) => plugin && plugin.compat && plugin.compat.declared === true && plugin.compat.ok === false)
}

/** 补丁文件缺失 / 包根本没装上的插件名（DSH-PLG-002 与 DSH-CFG-003 的并集）。 */
function brokenPluginNames(context) {
  const names = []
  const plugins = readPath(context, 'facts.plugins')
  if (Array.isArray(plugins)) {
    for (const plugin of plugins) {
      if (plugin && typeof plugin.name === 'string' && plugin.declaredPatch && plugin.patchExists === false) names.push(plugin.name)
    }
  }
  const missing = readPath(context, 'facts.configuration.missingPackages')
  if (Array.isArray(missing)) {
    for (const entry of missing) {
      if (entry && typeof entry.name === 'string') names.push(entry.name)
    }
  }
  return uniqueStrings(names)
}

function installedVersion(context, name) {
  const plugins = readPath(context, 'facts.plugins')
  if (!Array.isArray(plugins)) return undefined
  const found = plugins.find((plugin) => plugin && plugin.name === name)
  return found && typeof found.version === 'string' && found.version.trim() ? found.version.trim() : undefined
}

function pluginDirOf(context, name) {
  const plugins = readPath(context, 'facts.plugins')
  if (Array.isArray(plugins)) {
    const found = plugins.find((plugin) => plugin && plugin.name === name)
    if (found && typeof found.dir === 'string' && found.dir.trim()) return found.dir.trim()
  }
  return under(context, 'profileDir', 'node_modules', name)
}

/** `cordis.patch.yml` 里对应这个包的那一行（override 行没有 name，不参与匹配）。 */
function patchRowFor(context, name) {
  const rows = readPath(context, 'facts.configuration.patchRows')
  if (!Array.isArray(rows) || !name) return undefined
  const needle = String(name).toLowerCase()
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || !row.name.trim()) continue
    const rowName = row.name.trim().toLowerCase()
    const rowId = typeof row.id === 'string' ? row.id.trim().toLowerCase() : ''
    if (rowName === needle || rowId === needle) return row
  }
  return undefined
}

/** 日志里已确认带明文密钥的文件（`facts.logs.leaks.bySource`，最多 5 条）。 */
function leakSources(context) {
  const bySource = readPath(context, 'facts.logs.leaks.bySource')
  if (!Array.isArray(bySource)) return []
  const out = []
  for (const item of bySource) {
    if (!item || typeof item.path !== 'string' || !item.path.trim()) continue
    const hits = Number(item.total ?? item.hits ?? 0)
    out.push({
      path: item.path.trim(),
      kind: typeof item.kind === 'string' && item.kind.trim() ? item.kind.trim() : 'log',
      hits: Number.isFinite(hits) ? hits : 0,
    })
  }
  return out
}

/** 崩溃快照路径（`facts.logs.sources` 里 kind === 'crash' 的那几份）。 */
function crashSources(context) {
  const sources = readPath(context, 'facts.logs.sources')
  if (!Array.isArray(sources)) return []
  const out = []
  for (const source of sources) {
    if (!source || source.kind !== 'crash') continue
    if (typeof source.path === 'string' && source.path.trim()) out.push(source.path.trim())
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 4. 备份证据（profile-config-restore 的硬前置）
 * ------------------------------------------------------------------ */

/** 备份可能被放在这些位置；顺序即优先级，取第一个非空的。 */
const BACKUP_KEYS = [
  'backups',
  'backupDir',
  'facts.backups',
  'facts.repair.backups',
  'facts.repair.backupRoot',
  'facts.history.backups',
  'facts.doctor.backups',
]

function pushBackup(out, item) {
  if (typeof item === 'string') {
    const text = item.trim()
    if (text && !out.includes(text)) out.push(text)
    return
  }
  if (!item || typeof item !== 'object') return
  const candidate = item.path ?? item.backup ?? item.file ?? item.dir ?? item.target
  if (typeof candidate === 'string' && candidate.trim() && !out.includes(candidate.trim())) out.push(candidate.trim())
}

/**
 * 备份证据。只认「调用方已经采到的事实」，本模块**不**去 `fs` 里找一个可能存在的备份——
 * 「我觉得这个目录像备份」不能当成恢复依据。
 */
function findBackups(context) {
  const out = []
  for (const dotted of BACKUP_KEYS) {
    const value = readPath(context, dotted)
    if (value === undefined || value === null) continue
    if (typeof value === 'string') pushBackup(out, value)
    else if (Array.isArray(value)) value.forEach((item) => pushBackup(out, item))
    else if (typeof value === 'object') {
      pushBackup(out, value)
      for (const item of Object.values(value)) pushBackup(out, item)
    }
    if (out.length) break
  }
  return out.slice(0, 20)
}

/* ------------------------------------------------------------------ *
 * 5. 规划器
 * ------------------------------------------------------------------ */

/* ------------------------------ 1. egress-proxy ------------------------------ */

const egressProxy = {
  id: 'egress-proxy',
  hypothesisId: 'egress-blocked',
  risk: 'medium',
  note: '改 profile 的 cordis.patch.yml（L2：改配置）。必须预览 + 明确确认；本模块只出计划。',
  plan(diagnosis, context) {
    const patch = patchPathOf(context)
    const proxy = readPath(context, 'facts.connectivity.proxy')
    const proxyDetected = Boolean(proxy && proxy.detected)
    const evidence = evidenceLine(diagnosis, 2)

    return finalizePlan('egress-proxy', 'egress-blocked', diagnosis, context, {
      title: '为境外接入点配置代理（或换用可达端点）',
      risk: 'medium',
      explanation:
        `诊断认为「接入点被网络挡住」：${evidence}。` +
        '这条诊断能落地的动作只有两类：给模型路由配一个能到达目标的代理，或把 baseURL 换成可达的同族端点。' +
        (proxyDetected
          ? '注意：DSH-NET-003 已经检测到代理环境变量，所以先怀疑「代理没放行这个域名 / NO_PROXY 把它绕过了」，而不是再加一层配置。'
          : 'DSH-NET-003 没有检测到代理环境变量，所以这一步才需要动 cordis.patch.yml。') +
        '改动落在 profile 的 cordis.patch.yml，属 L2（改配置）：先预览、再由你确认，本模块不写盘。',
      preconditions: [
        '需要知道代理地址与端口（形如 http://127.0.0.1:7890）；本插件不猜、不探测、不读取你的代理软件配置',
        `改之前先把 ${patch} 复制一份同目录 .bak（人手工复制，本计划不代劳）`,
        '代理或换的端点必须真的放行该域名：企业网络的 TLS 拦截会让 DSH 报证书错误，那不是换端点能解决的',
        '本地端点（localhost / 127.0.0.1 / ::1）要留在 NO_PROXY 里，否则会被代理一起拦掉',
        '改完必须重启 DSH 才生效；重启本身是 L2 手工动作',
      ],
      changes: [
        {
          target: patch,
          operation: 'update',
          description: '给受影响的 llm-* 路由加 proxy 配置，或把该路由的 baseURL 换成可达端点（二选一，不要同时改）',
        },
      ],
      rollbackAvailable: true,
      rollbackNote:
        '改前把 cordis.patch.yml 复制成 cordis.patch.yml.<时间戳>.bak；回滚 = 用备份覆盖回去并重启 DSH。本模块不写盘、也不自动回滚。',
      verificationChecks: [
        '重启后 dsh_doctor group=connectivity：DSH-NET-002「接入点可达性」由 issue 变 pass（或 blocked 数量明显下降）',
        '同一份报告里 DSH-NET-003「代理设置」与你的预期一致：要走代理就该看到代理变量',
        'scripts/connectivity-probe.mjs 单点复探：DNS / TCP / TLS / HTTP 里原来卡住的那一步过了',
        '真发一次模型 completion 属于 L2 动作，只在你明确同意后手工做；本插件默认不做',
      ],
      steps: [
        `备份 ${patch}`,
        '打开该文件，找到诊断证据里点名的 llm-* 路由（或它所属的 provider 块）',
        '加 proxy: http://127.0.0.1:<代理端口>；或者把 baseURL 换成可达的同族端点',
        '用环境变量把本地端点写进 NO_PROXY',
        '重启 DSH',
        '跑 dsh_doctor group=connectivity 复检 DSH-NET-002',
        '仍 blocked：用 scripts/connectivity-probe.mjs 看卡在 DNS / TCP / TLS / HTTP 哪一步，再判断是代理问题还是端点写错',
        '失败回滚：把 .bak 覆盖回 cordis.patch.yml 并重启',
      ],
      meta: { targets: ['cordis.patch.yml'], proxyDetected },
    })
  },
}

/* --------------------------- 2. plugin-compat-review --------------------------- */

const pluginCompatReview = {
  id: 'plugin-compat-review',
  hypothesisId: 'plugin-incompatible',
  risk: 'low',
  note:
    '默认只读（changes 为空）。只有「插件确实没声明支持当前 DSH」且「能定位到 cordis.patch.yml 里对应行」时，' +
    '才附一条「停用该行」的改动，并把风险升到 medium（停用会删掉它提供的工具/页面）。',
  plan(diagnosis, context) {
    const bad = incompatiblePlugins(context)
    const dshVersion =
      readPath(context, 'facts.install.dshVersion') ?? readPath(context, 'facts.runtime.dshVersion') ?? '当前 DSH 版本'
    const names = bad.map((plugin) => `${plugin.name}@${plugin.version ?? '?'}`)
    const rows = []
    for (const plugin of bad) {
      const row = patchRowFor(context, plugin.name)
      if (row) rows.push({ plugin, row })
    }
    const hasDisable = rows.length > 0
    const patch = patchPathOf(context)
    const evidence = evidenceLine(diagnosis, 2)

    const changes = rows.map(({ plugin, row }) => ({
      target: patch,
      operation: 'update',
      description: `给 cordis.patch.yml 里 ${row.id} 行加 disabled: true，暂时停用 ${plugin.name}@${plugin.version ?? '?'}（停用 = medium：会同时去掉它提供的工具与页面）`,
    }))

    return finalizePlan('plugin-compat-review', 'plugin-incompatible', diagnosis, context, {
      title: '核对插件声明的支持版本（默认只读）',
      risk: hasDisable ? 'medium' : 'low',
      explanation:
        `诊断指向「插件与当前 DSH 版本不匹配」：${evidence}。` +
        (bad.length
          ? `事实快照里 ${bad.length} 个插件没有声明支持 ${dshVersion}：${names.join('、')}。`
          : '诊断没有给出具体插件名，所以这一步只做核对清单，不指定任何文件改动。') +
        '未声明兼容不等于一定坏（插件作者常常只是忘了更新 compatibility.dsh），但升级后出异常要优先怀疑它们。' +
        (hasDisable
          ? '本计划额外包含「停用某一行」，那属于改配置（L2 / medium），需要明确确认后才能执行。'
          : '所以默认版本一个文件都不改，只给核对顺序与判据。'),
      preconditions: [
        '能读到 profile 的 cordis.patch.yml 与各插件目录里的 package.json（只读）',
        '插件包的 compatibility.dsh / dshReleases 是作者自述，不是兼容性保证：本插件只转述，不替你判断能不能跑',
        '停用某一行会同时去掉该插件提供的工具 / 页面 / 面板，需要确认这些功能可以暂时没有',
        '优先升级插件；停用是退路，不是首选',
      ],
      changes,
      rollbackAvailable: true,
      rollbackNote: hasDisable
        ? '把加上的 disabled: true 删掉并重启即可；改前仍建议把 cordis.patch.yml 复制成 .bak。'
        : '本计划不改文件，无需回滚。',
      verificationChecks: [
        'dsh_doctor group=plugins：DSH-PLG-003「版本兼容声明」不再把这些插件列为未声明支持',
        '停用或升级后重跑 dsh_doctor group=plugins，没有新增 error（尤其 DSH-PLG-001 / DSH-PLG-002）',
        '重启后该插件原本提供的工具从工具列表消失（说明停用真的生效），或升级后仍在（说明升级成功）',
      ],
      steps: [
        `打开 ${patch}，记下这些插件对应的行 id；这一步只看不改`,
        '到 <profileDir>/node_modules/<包名>/package.json 读 dsh.compatibility.dsh 或 dshReleases，与当前 DSH 版本比对',
        '先试升级插件（plugin_manager install_bundle 带新版本；升级 = medium，走 plugin-reinstall 计划）',
        '升级不了再停用对应行：加 disabled: true（medium，需要确认）',
        '重启 DSH，跑 dsh_doctor group=plugins 复检 DSH-PLG-003',
        '回滚：删掉 disabled: true 并重启',
      ],
      meta: { plugins: names, layer: hasDisable ? 'L2' : 'L1' },
    })
  },
}

/* ------------------------------ 3. plugin-reinstall ------------------------------ */

const pluginReinstall = {
  id: 'plugin-reinstall',
  hypothesisId: 'plugin-missing-or-broken',
  risk: 'medium',
  note: 'plugin_manager remove_bundle → install_bundle（L2：装卸插件）。先记录版本，否则回不到原版本。',
  nullReason:
    '从事实快照里找不到确切的包名（facts.plugins 的补丁缺失、facts.configuration.missingPackages 都为空）时返回 null：' +
    '装错包 / 装错来源比不装更糟，包名必须来自证据，不能从自然语言里猜。',
  plan(diagnosis, context) {
    const candidates = brokenPluginNames(context)
    const name = candidates[0]
    if (!name) return null

    const version = installedVersion(context, name)
    const dir = pluginDirOf(context, name)
    const evidence = evidenceLine(diagnosis, 2)
    const spec = version ? `${name}@${version}` : name

    return finalizePlan('plugin-reinstall', 'plugin-missing-or-broken', diagnosis, context, {
      title: `重装插件 ${name}`,
      risk: 'medium',
      explanation:
        `诊断认为「插件缺失或装坏」：${evidence}。` +
        `补丁文件缺失 / 包没落到 profile 的 node_modules 时，重装是唯一有确定性的动作：先 remove_bundle 再 install_bundle，` +
        `让安装器重新写一遍包与硬链接，而不是让人去手工补文件。` +
        `本计划涉及 ${spec}；两个动作都是 plugin_manager 的官方动作，属 L2（装卸插件），必须预览 + 明确确认。`,
      preconditions: [
        'profile 的 package.json 里仍有这个包的依赖声明（file: / link: 的本地包要确认路径还在）',
        '重装前记录当前版本，否则回不到原版本',
        'remove_bundle 只卸载安装产物（node_modules 里的包目录、bundle 硬链接），不动会话数据、配置与密钥',
        '如果包来自本地目录（file: / link:），先在源目录确认文件齐全，否则重装只是把坏状态抄一遍',
        '重装后需要重启 DSH 才会加载新包',
      ],
      changes: [
        {
          target: dir,
          operation: 'delete',
          description: `plugin_manager action=remove_bundle target=${name}（卸载的是安装产物，不是用户数据；会话/配置/密钥都不在这个目录里）`,
        },
        {
          target: dir,
          operation: 'create',
          description: `plugin_manager action=install_bundle target=${spec}（重新安装后该目录应再次出现，且补充声明里列出的文件都在）`,
        },
      ],
      rollbackAvailable: Boolean(version),
      rollbackNote: version
        ? `回滚 = 用同一版本重新 plugin_manager action=install_bundle target=${spec}；profile 清单若被改动，用改前的 package.json / cordis.patch.yml 备份覆盖。`
        : '版本未知：装不回原版本，所以不给「可回滚」的承诺。先跑 plugin_manager list_plugins 记下版本再执行。',
      verificationChecks: [
        `dsh_doctor group=plugins：DSH-PLG-002「Bundle 补丁完整性」不再把 ${name} 列为补丁缺失`,
        `dsh_doctor group=plugins：DSH-PLG-001 里能看到 ${name}${version ? `@${version}` : ''}，且数量与重装前一致`,
        `plugin_manager list_plugins 里 ${name} 状态为启用，且没有 unmet DSH version requirement`,
        '重启后 dsh_doctor group=configuration：DSH-CFG-003「补丁行 ↔ 已装包」不再把该行列为缺失',
      ],
      steps: [
        `plugin_manager action=list_plugins，记下 ${name} 当前的版本与启用状态（这是回滚依据）`,
        '备份 profile 的 cordis.patch.yml 与 package.json 到同目录 .bak',
        `plugin_manager action=remove_bundle target=${name}`,
        `plugin_manager action=install_bundle target=${spec}`,
        '重启 DSH',
        '跑 dsh_doctor group=plugins 复检 DSH-PLG-002 / DSH-PLG-001',
        `失败回滚：用记录的版本重新 install_bundle；清单被改过就用 .bak 覆盖回去`,
      ],
      meta: { packageName: name, version, layer: 'L2' },
    })
  },
}

/* --------------------------- 4. profile-config-restore --------------------------- */

const profileConfigRestore = {
  id: 'profile-config-restore',
  hypothesisId: 'profile-config-broken',
  risk: 'high',
  note: '从备份覆盖写 profile 配置（high）。没有备份证据就 null —— 不用猜的内容替换用户的配置。',
  nullReason:
    '没有备份证据（context.backups / context.facts.backups / facts.repair.backups 都为空）时返回 null：' +
    '凭猜测重写 cordis.patch.yml 等于把用户配置换成我的猜写；也不做「删掉配置让它自己重建」。' +
    '这一条是刻意的：诊断能证明「配置坏了」，不能证明「我写的比它好」。',
  plan(diagnosis, context) {
    const backups = findBackups(context)
    if (!backups.length) return null

    const patch = patchPathOf(context)
    const pkg = profilePkgPathOf(context)
    const lower = backups.map((entry) => entry.toLowerCase())
    const backupHasPatch = lower.some((entry) => entry.endsWith('cordis.patch.yml') || entry.endsWith('cordis.patch.yaml'))
    const backupHasPkg = lower.some((entry) => entry.endsWith('package.json'))
    const backupRoot = backups[0]
    const evidence = evidenceLine(diagnosis, 2)

    const changes = []
    if (backupHasPatch || !backupHasPkg) {
      changes.push({
        target: patch,
        operation: 'update',
        description: `用备份 ${backupRoot} 覆盖回 cordis.patch.yml（覆盖前把当前文件另存为 .broken）`,
      })
    }
    if (backupHasPkg || !backupHasPatch) {
      changes.push({
        target: pkg,
        operation: 'update',
        description: `用备份 ${backupRoot} 覆盖回 package.json（覆盖前另存 .broken；恢复后必须确认是 UTF-8 无 BOM）`,
      })
    }

    return finalizePlan('profile-config-restore', 'profile-config-broken', diagnosis, context, {
      title: '从备份恢复 profile 配置',
      risk: 'high',
      explanation:
        `诊断认为 profile 配置损坏：${evidence}。` +
        `存在可用备份（${backupRoot}），所以「把备份盖回去」是确定性最高、副作用最小的一步；` +
        '这一步是覆盖写，属 high：必须先关掉 DSH（否则它会把内存里的旧配置写回）、先把现状另存、写完立刻复检。' +
        '这是配置恢复，不是数据恢复：会话与密钥不在这个计划里。',
      preconditions: [
        '备份必须来自同一个 profile（路径一致）：跨 profile 的补丁里 provider / 插件名往往对不上',
        '备份时间必须早于损坏发生的时间，否则恢复等于把坏文件再覆盖一遍',
        '恢复是覆盖写：先关掉 DSH 并确认进程退出，避免它把内存里的旧配置写回',
        `覆盖前把当前文件另存为 <文件>.broken，这是唯一的回滚路径`,
        '恢复后用 UTF-8 无 BOM 保存：带 BOM 的 package.json 会被 pnpm / DSH 直接拒绝（SyntaxError: Unexpected token）',
      ],
      changes,
      rollbackAvailable: true,
      rollbackNote: '.broken 快照与备份本身都保留；回滚 = 用 .broken 覆盖回去。本模块不写盘、不自动回滚。',
      verificationChecks: [
        'dsh_doctor group=configuration：DSH-CFG-002「组合补丁 cordis.patch.yml」变 pass',
        'dsh_doctor group=configuration：DSH-CFG-003「补丁行 ↔ 已装包」不再把行列为缺失',
        'dsh_doctor group=configuration：DSH-CFG-004「Profile 清单 package.json」pass，且读取时没有 BOM 报错',
        '重启后 dsh_doctor group=plugins 的插件数量恢复到备份对应的那一天',
      ],
      steps: [
        '关掉 DSH（关窗口不够，确认进程退出；这一步需要你确认）',
        `把当前的 ${patch} 与 ${pkg} 复制成 .broken 快照`,
        `从 ${backupRoot} 复制同名文件覆盖回去`,
        '确认两个文件都是 UTF-8 无 BOM',
        '启动 DSH',
        '跑 dsh_doctor group=configuration 复检 DSH-CFG-002 / 003 / 004',
        '失败回滚：把 .broken 覆盖回去',
        '配置恢复后仍然坏：说明根因不在配置，回到诊断层看 runtime / plugin 假设',
      ],
      meta: { backups: backups.slice(0, 5), backupRoot, layer: 'L2' },
    })
  },
}

/* ------------------------------ 5. secret-cleanup ------------------------------ */

const secretCleanup = {
  id: 'secret-cleanup',
  hypothesisId: 'credential-leak-in-logs',
  risk: 'high',
  note: '复用 scripts/purge-secrets.mjs 的三步：dry-run → --apply --yes → --rollback。活动会话不会被清理。',
  plan(diagnosis, context) {
    const sources = leakSources(context)
    const totalHits = sources.reduce((sum, item) => sum + item.hits, 0)
    const backupRoot = under(context, 'home', 'state', 'dsh-doctor', 'backups', '<时间戳>')
    const evidence = evidenceLine(diagnosis, 2)

    const changes = sources.length
      ? sources.map((source) => ({
          // 事实快照里的路径已经是绝对路径；不是的话也照原样展示，绝不替它 resolve 到 cwd
          target: source.path,
          operation: 'update',
          description: `${source.kind} 日志里 ${source.hits} 处命中的可识别凭据替换为 [REDACTED:类型]，其余内容与 UTF-8 编码保持不变；.zstd 会话流重写为单帧 zstd`,
        }))
      : [
          {
            target: under(context, 'home', 'sessions', '<工作区>', '<会话ID>', 'session.v4.jsonl.zstd'),
            operation: 'update',
            description:
              '会话日志里的可识别凭据替换为 [REDACTED:类型]（占位目标：具体文件由 scripts/purge-secrets.mjs 扫描得出，本模块不读盘）',
          },
        ]

    return finalizePlan('secret-cleanup', 'credential-leak-in-logs', diagnosis, context, {
      title: '清理日志里的明文密钥',
      risk: 'high',
      explanation:
        `诊断在日志里发现了明文凭据：${evidence}。` +
        `已有现成的、经过验证的实现（lib/repair-secrets.js + scripts/purge-secrets.mjs），它的纪律是「先备份 → 再原地脱敏 → 再复检 → 失败自动回滚单个文件」。` +
        `本计划只是把那套流程排成三步给你看：dry-run 看命中、--apply --yes 才动文件、--rollback 退回。` +
        `**活动会话不会被清理**：最近 10 分钟内被写过的文件会被当成「可能仍在追加写入」，apply 时列入 deferred 并跳过——` +
        `重写一个正被 append 的会话流，会让持有写入句柄的进程按旧偏移继续落盘，那个会话就废了。` +
        '清理只是止血；真正的修复是轮换这些密钥。',
      preconditions: [
        '这是本插件唯一会改文件的动作：走 scripts/purge-secrets.mjs，默认 dry-run，必须 --apply 与 --yes 两个开关同时给',
        '活动会话不会被清理：默认 --active-window 10 分钟，窗口内被写过的文件跳过并列入 deferred（--active-window 0 能强改，但会把正在写的会话写坏）',
        '每个文件都是「先备份并回读校验大小 → 再写 → 写后重新扫描 → 仍未清理干净就自动回滚该文件」；符号链接一律跳过',
        '只替换可识别凭据（sk- / ghp_ / Bearer / JWT / PEM / apiKey）为 [REDACTED:类型]，不改其它内容，也不打印任何命中原文',
        '对已清理过的文件重复执行是幂等的（第二次 changes 为空）',
        '清理不等于修复：轮换密钥并按需清理会话历史，才是把泄漏这件事关掉',
      ],
      changes,
      rollbackAvailable: true,
      rollbackNote: `每个被改文件在备份目录里都有一份同字节数副本，清单 ${backupRoot}/.dsh-doctor-backup.json 记录原绝对路径；回滚 = node scripts/purge-secrets.mjs --rollback "<备份目录>"。失败时 applyCleanup 已经自动回滚了单文件。`,
      verificationChecks: [
        'node scripts/purge-secrets.mjs --verify 输出「仍剩 0 处命中」，退出码 0',
        'dsh_doctor group=security：DSH-SEC-003「日志里的明文密钥」变 pass',
        '备份目录里 .dsh-doctor-backup.json 的每条记录都有绝对路径与写前字节数，且备份文件仍存在',
        '被改文件仍是可读 UTF-8；.zstd 会话流能重新解开，行数只允许因多行 PEM 折成一行而减少',
      ],
      steps: [
        'node scripts/purge-secrets.mjs（dry-run：只打印命中文件与数量，一个字节都不写）',
        `抄下它打印的备份目录（形如 ${backupRoot}），回滚要靠它`,
        '关掉要清理的那些会话：最近 10 分钟内被写过的文件会被当成活动会话，apply 时跳过',
        'node scripts/purge-secrets.mjs --apply --yes（缺 --yes 会拒绝执行）',
        'node scripts/purge-secrets.mjs --verify，确认 0 命中',
        '失败回滚：node scripts/purge-secrets.mjs --rollback "<备份目录>"',
        '清理完成后轮换这些密钥：日志只是留痕，泄漏已经发生',
      ],
      meta: {
        totalHits,
        fileCount: changes.length,
        deferredAware: true,
        activeWindowMinutes: 10,
        layer: 'L2',
      },
    })
  },
}

/* ------------------------------ 6. memory-relief ------------------------------ */

const memoryRelief = {
  id: 'memory-relief',
  hypothesisId: 'memory-pressure',
  risk: 'low',
  note: '只读建议：不改文件、不结束进程。重启与结束进程都属于需要你自己操作的 L2 动作。',
  plan(diagnosis, context) {
    const rss = readPath(context, 'facts.runtime.rssBytes')
    const evidence = evidenceLine(diagnosis, 2)
    return finalizePlan('memory-relief', 'memory-pressure', diagnosis, context, {
      title: '给内存减负（只读建议）',
      risk: 'low',
      explanation:
        `诊断认为宿主内存吃紧：${evidence}${rss ? `（本次采样 ${Math.round(Number(rss) / 1024 / 1024)} MB RSS）` : ''}。` +
        '内存压力几乎没有「一条命令修好」的版本：能降下来的是并行度、常驻页面与日志采样量。' +
        '本计划不生成任何文件改动，也不结束任何进程——结束进程属于 L2 且可能丢数据，必须由你自己判断后手工做。',
      preconditions: [
        '本计划不改文件、不杀进程；下面全是可选项，做与不做由你决定',
        '先确认是「真的内存压力」而不是「日志里一条历史 OOM」：看 dsh_doctor 的 DSH-RUN-001 与当前任务管理器里的实际占用',
        '每个并行子 agent 都是一份独立上下文，内存与它们数量近似线性；关掉它们是最有效的单项手段',
        '重启 DSH 会丢当前未保存的会话状态，属 L2 手工动作',
      ],
      changes: [],
      rollbackAvailable: false,
      rollbackNote: '只读计划，没有改动就没有回滚。',
      verificationChecks: [
        'dsh_doctor group=runtime：DSH-RUN-001「主机资源」由 issue 变 pass',
        'facts.runtime.rssBytes 在同样负载下明显下降（对比本次采样）',
        'dsh_doctor group=logs：DSH-LOG-003「宿主崩溃快照」不再新增 host-exit 记录',
      ],
      steps: [
        '关掉不用的会话与并行子 agent（先降并行度，再谈重启）',
        '减少同时启用的 bundle 补丁与长开的本地 Web 页面',
        '调低日志采样量（dsh_doctor 的 maxLogFiles / maxLogBytes；这是只读体检的参数，不改变你自己的日志策略）',
        '确实需要时再重启 DSH（L2，需要你确认；重启前保存会话）',
        '复检 dsh_doctor group=runtime 的 DSH-RUN-001 与 rssBytes',
      ],
      meta: { rssBytes: Number.isFinite(Number(rss)) ? Number(rss) : undefined, layer: 'L0' },
    })
  },
}

/* ---------------------------- 7. host-crash-collect ---------------------------- */

const hostCrashCollect = {
  id: 'host-crash-collect',
  hypothesisId: 'host-crash-loop',
  risk: 'low',
  note: '只读收集：崩溃快照路径 + 复现步骤。不删快照、不改配置。',
  plan(diagnosis, context) {
    const sources = crashSources(context)
    const sample = sources.slice(0, 3)
    const evidence = evidenceLine(diagnosis, 2)
    return finalizePlan('host-crash-collect', 'host-crash-loop', diagnosis, context, {
      title: '收集崩溃快照与复现步骤',
      risk: 'low',
      explanation:
        `诊断认为宿主在反复退出：${evidence}。` +
        (sample.length
          ? `已经定位到 ${sources.length} 份崩溃快照（${sample.join('、')}）。`
          : '本次采样没有拿到崩溃快照路径（Host 侧只在退出时写 crash-*.log）。') +
        '崩溃这件事在拿到「快照 + 当时在跑什么」之前没法修：重启只是让它再崩一次。' +
        '所以这一步只收集证据，不生成任何文件改动。',
      preconditions: [
        '快照目录通常是 <userData>/logs/crash-*.log；本模块只读事实快照里已记录的路径，不自己去翻盘',
        '崩溃后立刻复制快照：后续重启可能覆盖同名文件',
        '复现步骤要写「当时开着什么」：哪些插件、是否开着本地 Web、是否在跑 connectivity probe、有没有大文件导出',
        '本计划不删快照、不改配置、不结束进程',
      ],
      changes: [],
      rollbackAvailable: false,
      rollbackNote: '只读计划，没有改动就没有回滚。',
      verificationChecks: [
        '诊断目录里能看到复制出来的 crash-*.log 与它原始路径、时间戳的对照',
        'dsh_doctor 导出的报告 JSON 里 DSH-LOG-003 的证据路径与你复制的文件一致',
        '复现步骤能写出触发序列（打开哪个页面 / 装了哪些插件 / 是否在跑探测），下次崩溃能对上',
      ],
      steps: [
        sample.length ? `复制这些快照到诊断目录：${sample.join('、')}` : '崩溃发生后到 <userData>/logs 找 crash-*.log 并复制出来',
        '记录 DSH 版本、node/Electron 版本与已启用插件清单（dsh_doctor group=plugins 的输出即可）',
        '写下复现步骤：崩溃前最后做的三件事，以及是否同时在跑本地 Web / 探测 / 大文件导出',
        '用 dsh_doctor 导出报告（json + markdown），和快照放在一起',
        '把快照 + 报告 + 复现步骤一起交给插件作者或 DSH issue；贴 sample 比贴整份日志有效',
      ],
      meta: { crashSources: sample, crashCount: sources.length, layer: 'L0' },
    })
  },
}

/* ------------------------------------------------------------------ *
 * 6. 注册表
 * ------------------------------------------------------------------ */

/**
 * 规划器清单。顺序即面板展示顺序（与设计文档的编号一致）。
 * 每个条目额外带 `note`（这条计划为什么是这个风险级）与可选的 `nullReason`
 * （什么情况下它刻意返回 null）——UI 需要能解释「为什么没有修复按钮」。
 */
export const PLANNERS = [egressProxy, pluginCompatReview, pluginReinstall, profileConfigRestore, secretCleanup, memoryRelief, hostCrashCollect]

const PLANNER_BY_HYPOTHESIS = new Map()
for (const planner of PLANNERS) {
  if (!PLANNER_BY_HYPOTHESIS.has(planner.hypothesisId)) PLANNER_BY_HYPOTHESIS.set(planner.hypothesisId, planner)
}

/**
 * 故意「不做计划」的假设。这些不是遗漏，是判断：
 * 能做，但「做」的代价（重装环境 / 不可回滚 / 只有猜测）超过收益，第一版只出报告。
 */
export const UNPLANNED = [
  {
    hypothesisId: 'runtime-version-mismatch',
    reason:
      '切换 Node / Electron 运行时 = 重装宿主或改 PATH，属 L3 环境重装：既不可自动回滚，也可能让现在能跑的插件全部失效。' +
      '这一版只把它写进报告与 README 的引擎要求（package.json engines），不生成任何计划。',
  },
  {
    hypothesisId: '*',
    reason: '未登记的假设一律返回 null：没有验证过的动作不进计划表，宁可让面板显示「暂无可执行的修复」。',
  },
]

/* ------------------------------------------------------------------ *
 * 7. 对外 API
 * ------------------------------------------------------------------ */

/**
 * 单个诊断 → RepairPlan 或 null。永不抛。
 * 不认识的 hypothesisId（包括未来新增的）→ null，让调用方显示「暂无可执行的修复」，
 * 而不是像坏掉一样抛异常。
 */
export function buildRepairPlan(diagnosis, context = {}) {
  if (!diagnosis || typeof diagnosis !== 'object') return null
  const hypothesisId = typeof diagnosis.hypothesisId === 'string' ? diagnosis.hypothesisId.trim() : ''
  if (!hypothesisId) return null
  const planner = PLANNER_BY_HYPOTHESIS.get(hypothesisId)
  if (!planner || typeof planner.plan !== 'function') return null
  try {
    const plan = planner.plan(diagnosis, context ?? {})
    return plan && typeof plan === 'object' ? plan : null
  } catch {
    // 规划器抛 = 这一条给不出可信计划；不因为一个假设炸掉整份报告的修复页
    return null
  }
}

/**
 * 一批诊断 → RepairPlan[]。保持输入顺序、过滤 null、`id` 去重
 * （同一个规划器命中多条诊断时，第二条起加 `-2` / `-3`，不丢信息也不撞 key）。
 */
export function buildRepairPlans(diagnoses, context = {}) {
  const list = Array.isArray(diagnoses) ? diagnoses : []
  const out = []
  const counts = new Map()
  for (const diagnosis of list) {
    const plan = buildRepairPlan(diagnosis, context)
    if (!plan) continue
    const baseId = plan.id
    const used = counts.get(baseId) ?? 0
    counts.set(baseId, used + 1)
    if (used > 0) plan.id = `${baseId}-${used + 1}`
    out.push(plan)
  }
  return out
}

export default {
  REPAIR_VERSION,
  RISK_LEVELS,
  RISK_LABELS,
  CHANGE_OPERATIONS,
  PLANNERS,
  UNPLANNED,
  describeRisk,
  buildRepairPlan,
  buildRepairPlans,
}
