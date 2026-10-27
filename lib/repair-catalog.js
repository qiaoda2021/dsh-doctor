/**
 * DSH Doctor — 修复动作目录（公开 offer 层）。
 *
 * 报告里的诊断结果描述「哪里不对」，这个模块只回答「有哪几个用户可点、可确认的动作」。
 * 它是纯函数：不读环境、不碰磁盘、不生成 id、不看时间——同一份报告永远得到同一份目录，
 * 这样面板取数、Agent 工具和回归测试看到的是同一组承诺。
 *
 * 输出契约（docs/dev-log/2026-10-25-通用发布与确认修复闭环.md「Catalog」）：
 *   buildRepairActions(report, runtime = {}) => Offer[]
 *   Offer = { id, kind, title, summary, ruleIds, prepareArgs, inputs, restartRequired }
 *
 * 文件动作的目标仅来自可信 runtime 与固定文件名；诊断文字不是写目标。
 * plugin-enable 只使用原生管理器关联的 entryId，并在准备及执行前重新取数校验。
 * offer 不是 plan，不授予执行权限；每个计划仍需预览与用户确认。
 * 不承诺自动重装或版本回退，也不把 Host 复检当成浏览器已经显示 UI。
 */

import { canEnablePlugin, pluginOfferId, PLUGIN_UI_RULE_ID } from './plugin-recovery.js'

/** offer id ↔ 执行器 kind 的固定映射。顺序即输出顺序，保证面板稳定。 */
const OFFERS = [
  { id: 'offer-proxy-env', kind: 'proxy-env', rules: ['DSH-NET-002', 'DSH-NET-003'] },
  { id: 'offer-bom-package', kind: 'strip-bom', rules: ['DSH-CFG-005'], file: 'package.json' },
  { id: 'offer-bom-patch', kind: 'strip-bom', rules: ['DSH-CFG-005'], file: 'cordis.patch.yml' },
  { id: 'offer-secret-cleanup', kind: 'secret-cleanup', rules: ['DSH-SEC-003'] },
]

/** 规则号的固定次序：合并去重后按它排，避免「谁先出现谁在前」的抖动。 */
const RULE_ORDER = ['DSH-CFG-005', 'DSH-NET-002', 'DSH-NET-003', 'DSH-SEC-003']

const CONTROL = /[\x00-\x1f\x7f]/
const WIN_DRIVE = /^[A-Za-z]:[\\/]/
const WIN_UNC = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/

/** 代理地址只能由用户显式输入；目录里不预填任何猜测值（含本机 buzz 例外地址）。 */
function proxyInputs() {
  return [{ name: 'proxyUrl', label: '代理地址', required: true, placeholder: 'http://127.0.0.1:PORT' }]
}

/**
 * 判定 runtime.profileDir 是否是一个可以拼固定文件名的可信绝对路径，并返回它的
 * 路径风格。相对路径、空值、带穿越段、带控制字符的输入一律不给 BOM 动作——
 * 拼不出来就不承诺，而不是退回「证据里那个路径」。
 *
 * 这里刻意不用 node:path 的 join/sep：宿主可能是 Windows，但报告的 runtime 也可能来自
 * POSIX 侧的快照，混用会造成 `\home\user\...` 这种既不是 Windows 也不是 POSIX 的怪路径。
 * 按输入自身的风格拼接，两种写法都能得到各自正确的结果。
 */
function profileBase(value) {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (!raw || CONTROL.test(raw)) return undefined
  let sep
  if (WIN_DRIVE.test(raw)) sep = raw[2]
  else if (WIN_UNC.test(raw)) sep = raw.startsWith('\\\\') ? '\\' : '/'
  else if (raw.startsWith('/')) sep = '/'
  else return undefined
  if (raw.split(/[\\/]+/).includes('..')) return undefined
  const base = raw.replace(/[\\/]+$/, '')
  if (!base) return { base: sep, sep }
  // 盘符根（C:）后面必须还剩分隔符，否则 C:package.json 会被当成驱动器相对路径。
  if (WIN_DRIVE.test(base) && base.length === 2) return { base: `${base}${sep}`, sep }
  return { base, sep }
}

/** 可信目录 + 固定文件名，不读证据、不做 glob、不跟随任何外部输入。 */
function fixedTarget(trusted, name) {
  if (!trusted) return undefined
  return trusted.base.endsWith(trusted.sep) ? `${trusted.base}${name}` : `${trusted.base}${trusted.sep}${name}`
}

/** 只把「确实 issue」的结果算进来；pass / unknown / 脏条目都不产生动作。 */
function issueIds(report) {
  const results = report && typeof report === 'object' ? report.results : undefined
  if (!Array.isArray(results)) return new Set()
  const ids = new Set()
  for (const item of results) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    if (item.status !== 'issue') continue
    const id = typeof item.id === 'string' ? item.id : undefined
    if (id) ids.add(id)
  }
  return ids
}

/** facts 只读，形状不明就当没有——缺事实时宁可不给动作。 */
function configurationOf(report) {
  const facts = report && typeof report === 'object' ? report.facts : undefined
  const cfg = facts && typeof facts === 'object' ? facts.configuration : undefined
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {}
}

function sortRules(ids) {
  const rank = (id) => {
    const index = RULE_ORDER.indexOf(id)
    return index === -1 ? RULE_ORDER.length : index
  }
  return [...ids].sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)))
}

function proxyOffer(ruleIds) {
  return {
    id: 'offer-proxy-env',
    kind: 'proxy-env',
    title: '配置代理环境变量',
    // 只承诺「按你给的地址写 home/.env 并复检」，不承诺治愈连接；代理是否放行该域名要人来判。
    summary: '把显式填写的 http(s) 代理写进 home/.env，下次启动生效；只在你确认当前网络需要代理时使用，不表示它是根因。',
    ruleIds,
    prepareArgs: { kind: 'proxy-env' },
    inputs: proxyInputs(),
    restartRequired: true,
  }
}

function bomOffer(file, ruleIds) {
  return {
    id: file === 'package.json' ? 'offer-bom-package' : 'offer-bom-patch',
    kind: 'strip-bom',
    title: `移除 profile/${file} 的 UTF-8 BOM`,
    summary: `去掉 ${file} 文件头的 UTF-8 BOM 再重写；写前备份、写后复检，目标固定为当前 profile 的该文件。`,
    ruleIds,
    prepareArgs: { kind: 'strip-bom', target: undefined },
    inputs: [],
    restartRequired: true,
  }
}

function secretOffer(ruleIds) {
  return {
    id: 'offer-secret-cleanup',
    kind: 'secret-cleanup',
    title: '清理日志里的明文密钥',
    summary: '用专用清理器备份并清理命中日志，最近 10 分钟仍有写入的文件延后处理；命中内容不进报告。',
    ruleIds,
    prepareArgs: { kind: 'secret-cleanup' },
    inputs: [],
    restartRequired: false,
  }
}

/**
 * @param {object} report  一次体检报告（至少含 results；facts 可选）
 * @param {{profileDir?: string}} runtime  可信运行时上下文；profileDir 是唯一写目标来源
 * @returns {Array<object>} 纯 JSON 数组，已按固定顺序排列并按 offer 去重
 */
export function buildRepairActions(report, runtime = {}) {
  const issues = issueIds(report)
  if (issues.size === 0) return []
  const cfg = configurationOf(report)
  const trusted = profileBase(runtime && typeof runtime === 'object' ? runtime.profileDir : undefined)

  const collected = new Map()

  const note = (offerId, ruleId) => {
    if (!collected.has(offerId)) collected.set(offerId, new Set())
    collected.get(offerId).add(ruleId)
  }

  for (const rule of ['DSH-NET-002', 'DSH-NET-003']) {
    if (issues.has(rule)) note('offer-proxy-env', rule)
  }
  if (issues.has('DSH-CFG-005')) {
    if (cfg.profilePkgBom === true) note('offer-bom-package', 'DSH-CFG-005')
    if (cfg.patchBom === true) note('offer-bom-patch', 'DSH-CFG-005')
  }
  if (issues.has('DSH-SEC-003')) note('offer-secret-cleanup', 'DSH-SEC-003')

  const actions = []
  for (const offer of OFFERS) {
    const rules = collected.get(offer.id)
    if (!rules) continue
    let action
    if (offer.kind === 'proxy-env') action = proxyOffer(sortRules(rules))
    else if (offer.kind === 'strip-bom') {
      const target = fixedTarget(trusted, offer.file)
      // 目录不可信就不给 BOM 动作：没有可信落点时不制造可执行承诺。
      if (!target) continue
      action = bomOffer(offer.file, sortRules(rules))
      action.prepareArgs.target = target
    } else action = secretOffer(sortRules(rules))
    const ordered = ['id', 'kind', 'title', 'summary', 'ruleIds', 'prepareArgs', 'inputs', 'restartRequired']
    const shaped = {}
    for (const key of ordered) shaped[key] = action[key]
    actions.push(shaped)
  }
  if (issues.has(PLUGIN_UI_RULE_ID)) {
    for (const entry of report?.facts?.pluginUi?.entries ?? []) {
      if (!canEnablePlugin(entry)) continue
      actions.push({ id: pluginOfferId(entry.entryId), kind: 'plugin-enable',
        title: `启用 ${entry.moduleName}`, summary: '仅恢复此条目的启用状态；先预览并确认。Host 与资源复检不等于浏览器 UI 已挂载。',
        ruleIds: [PLUGIN_UI_RULE_ID], prepareArgs: { kind: 'plugin-enable', target: entry.entryId }, inputs: [], restartRequired: false })
    }
  }
  return actions
}

export default { buildRepairActions }
