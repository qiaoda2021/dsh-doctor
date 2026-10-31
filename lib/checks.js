/**
 * DSH Doctor — 诊断入口（Host 半边）。
 *
 * v0.2 起这里只做三件事：采集事实 → 跑规则 → 汇总。判定逻辑全在 rules.js，
 * 采集在 facts.js，结构定义在 diag.js。这个文件保持薄，是为了让「哪里出的结论」
 * 一眼能查到——上一版的教训是所有东西堆在 800 行里，改一条判定要读半天。
 *
 * 对外结构：
 *   {
 *     id, generatedAt, durationMs, env, groups,
 *     results: DiagnosticResult[],   // 唯一真源
 *     checks:  LegacyCheck[],        // 面板/markdown 兼容视图，由 results 单向派生
 *     summary, mode, sources, rules, facts
 *   }
 */
import { platform, arch } from 'node:os'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CATEGORIES, CATEGORY_LABELS, rankResults, summarize, toLegacyCheck } from './diag.js'
import { collectFacts, detectProfileDir, DATA_DIRS, SECRET_ENV_NAMES } from './facts.js'
import { runRules, RULE_CATALOG } from './rules.js'
import { collectPluginUi } from './plugin-recovery.js'
import { unknown } from './diag.js'
import { buildCoverage } from './coverage.js'

/**
 * 报告里带版本号：导出/历史要靠它区分「哪份报告是哪个版本出的」。
 * 读不到就当 unknown —— 版本号缺失不该让体检失败。
 */
let pluginVersion
function readPluginVersion() {
  if (pluginVersion !== undefined) return pluginVersion
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
    pluginVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown'
  } catch {
    pluginVersion = 'unknown'
  }
  return pluginVersion
}

/**
 * 推理层按「可选」加载：它比诊断核心晚到，缺文件/写坏了只应该让报告少一段归因，
 * 不能让整个 Host 半边起不来。缓存结果，避免每次 refresh 都走一次 import。
 */
let inferenceModule
async function loadInference() {
  if (inferenceModule !== undefined) return inferenceModule
  try {
    inferenceModule = await import('./inference.js')
  } catch {
    inferenceModule = null
  }
  return inferenceModule
}

/** 修复计划同样是可选层：只生成草案，绝不执行（L2 的确认流程是后面的事）。 */
let repairModule
async function loadRepairPlan() {
  if (repairModule !== undefined) return repairModule
  try {
    repairModule = await import('./repair-plan.js')
  } catch {
    repairModule = null
  }
  return repairModule
}

async function planRepairs(diagnoses, facts) {
  if (!Array.isArray(diagnoses) || diagnoses.length === 0) return []
  try {
    const mod = await loadRepairPlan()
    if (!mod?.buildRepairPlans) return []
    // 备份目录来自导出/清理模块的既有约定，规划器只读不改；没有就让它按「无备份证据」返回 null。
    return mod.buildRepairPlans(diagnoses, { facts, profileDir: facts?.configuration?.profileDir })
  } catch {
    return []
  }
}

/** 把规则结果收敛成根因假设；推理层自身出错时降级成「没有归因」，不污染报告。 */
async function infer(results, facts, summary, options) {
  const empty = { diagnoses: [], byRule: {}, unmatched: [], stats: { considered: 0, issueCount: 0, hypothesisHits: 0, unmatchedCount: 0, elapsedMs: 0 } }
  try {
    const mod = await loadInference()
    if (!mod?.inferDiagnoses) return empty
    const out = mod.inferDiagnoses({ results, facts, summary }, options ?? {})
    const diagnoses = typeof mod.rankDiagnoses === 'function' ? mod.rankDiagnoses(out?.diagnoses ?? []) : (out?.diagnoses ?? [])
    return {
      version: mod.INFERENCE_VERSION,
      diagnoses,
      byRule: out?.byRule ?? {},
      unmatched: out?.unmatched ?? [],
      stats: out?.stats ?? empty.stats,
    }
  } catch (error) {
    return { ...empty, stats: { ...empty.stats, error: String(error?.message ?? error) } }
  }
}

/** 报告里的分组顺序（面板与 markdown 共用）。 */
export const GROUPS = CATEGORIES.map((id) => ({ id, title: CATEGORY_LABELS[id] }))

export { detectProfileDir, DATA_DIRS, SECRET_ENV_NAMES }

/**
 * 跑一次完整体检。
 * options: { home, profile, profileDir, webUrl, cwd, dshRoot, env, sources, categories }
 * 所有 options 都是「提示」，缺了会自行推断（见 facts.js 的解析链）。
 */
export async function runDoctor(options = {}) {
  const startedAt = Date.now()
  let facts
  try {
    facts = await collectFacts(options)
    facts.pluginUi = await collectPluginUi({ ...options, dshRoot: facts.install?.root ?? options.dshRoot })
  } catch (error) {
    const failure = unknown('DSH-ENGINE-001', 'environment', '事实采集阶段异常，本次报告不可信', {
      title: '诊断引擎',
      evidence: [String(error?.message ?? error)],
      data: { stack: String(error?.stack ?? '').split('\n').slice(0, 5).join('\n') },
    })
    return {
      id: `doctor-${startedAt.toString(36)}`,
      generatedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      env: { node: process.version, platform: `${platform()}/${arch()}` },
      groups: GROUPS,
      results: [failure],
      checks: [toLegacyCheck(failure)],
      summary: summarize([failure]),
      rules: RULE_CATALOG,
      coverage: buildCoverage({ results: [failure], rules: RULE_CATALOG, generatedAt: new Date(startedAt).toISOString(), collectionFailed: true }),
    }
  }

  const results = rankResults(runRules(facts, { categories: options.categories }))
  const summary = summarize(results)
  const inference = await infer(results, facts, summary, options.inference)
  const plans = await planRepairs(inference.diagnoses, facts)

  return {
    id: `doctor-${startedAt.toString(36)}`,
    version: readPluginVersion(),
    generatedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    env: {
      home: facts.data.home,
      profile: facts.configuration.profile,
      profileDir: facts.configuration.profileDir,
      webUrl: facts.web.url,
      dshRoot: facts.install.root,
      dshVersion: facts.install.dshVersion,
      node: facts.runtime.node,
      platform: `${facts.runtime.platform}/${facts.runtime.arch}`,
      cwd: facts.workspace.cwd,
      mode: facts.mode.value,
    },
    groups: GROUPS,
    results,
    checks: results.map(toLegacyCheck),
    summary,
    coverage: buildCoverage({ results, rules: RULE_CATALOG, facts, generatedAt: facts.generatedAt, categories: options.categories }),
    bundleSources: facts.configuration.bundleSources,
    diagnoses: inference.diagnoses,
    plans,
    inference: { version: inference.version, byRule: inference.byRule, unmatched: inference.unmatched, stats: inference.stats },
    mode: facts.mode,
    sources: facts.sources,
    rules: RULE_CATALOG,
    facts,
  }
}

export default { runDoctor, detectProfileDir, GROUPS }
