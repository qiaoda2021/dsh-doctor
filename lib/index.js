/**
 * DSH Doctor — Host 半边。
 *
 * 三个出口共用一份诊断结果：
 *   1. 工具 `dsh_doctor`  —— 模型可主动调用
 *   2. 命令 `/doctor`     —— 用户手动触发
 *   3. 面板只读接口        —— Connection 认证通路按需取数；HTML 注入仅作 Web 首屏兜底
 *
 * 所有服务都按「可选」处理：拿不到就不注册对应出口，绝不因为缺少某个服务而让整个插件加载失败。
 */
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { detectProfileDir, runDoctor } from './checks.js'
import { createRepairController } from './repair-controller.js'
import { registerPanelData } from './panel-data.js'
import { buildRepairActions } from './repair-catalog.js'
import { registerRepairPanel } from './repair-panel.js'
import { runRepairWithConsent } from './repair-consent.js'
import { CATEGORIES } from './diag.js'
import { renderCompact, renderJson, renderMarkdown, summaryLine } from './render.js'

/**
 * 旧分组名 → 新诊断类别。v0.2 换了类别体系（design doc 里的 environment/configuration/...），
 * 但已经写进提示词或脚本的旧名字要继续能用，所以在这里做一次单向映射。
 */
const LEGACY_GROUP_ALIAS = {
  install: 'environment',
  env: 'environment',
  profile: 'configuration',
  web: 'connectivity',
}

function normalizeCategory(group) {
  if (!group) return undefined
  const mapped = LEGACY_GROUP_ALIAS[group] ?? group
  return CATEGORIES.includes(mapped) ? mapped : undefined
}

const REPORT_ELEMENT_ID = 'dsh-doctor-report'
const PANEL_COLLECTION_ERROR = '体检数据采集失败，请稍后重试。'

// The tool report retains internal diagnostic evidence, but engine exception text
// and stacks must never become browser data (including derived view-model data).
function panelReportOf(report) {
  const sanitize = (entry) => {
    if (entry?.id !== 'DSH-ENGINE-001') return entry
    const { data: _data, evidence: _evidence, ...publicFields } = entry
    return { ...publicFields, evidence: [PANEL_COLLECTION_ERROR] }
  }
  const safe = { ...report, results: report.results?.map(sanitize), checks: report.checks?.map(sanitize) }
  if (report.inference?.stats?.error) {
    safe.inference = { ...report.inference, stats: { ...report.inference.stats, error: PANEL_COLLECTION_ERROR } }
  }
  return safe
}

/**
 * 导出/脱敏模块按「可选」加载：它们比诊断核心晚到，任何一个缺失都只应该让「导出」这一项降级，
 * 不能连累插件加载（诊断才是主功能）。所以这里用动态 import + 缓存，而不是顶层静态 import。
 */
const optionalModules = new Map()
async function loadOptional(name) {
  if (optionalModules.has(name)) return optionalModules.get(name)
  let mod
  try {
    mod = await import(`./${name}.js`)
  } catch {
    mod = undefined
  }
  optionalModules.set(name, mod)
  return mod
}

/**
 * 关键：Host 进程的 process.env 里没有 DSH_HOME / DSH_PROFILE_DIR / DSH_WEB_URL
 * （它们只注入到 bash/pwsh 工具的 exec 环境），所以默认值必须从 Host service 解析。
 * 解析链：插件 Config → 服务 → 环境变量 → 文件系统推断。
 */
function resolveRuntime(ctx, config) {
  const env = process.env
  const sources = {}
  const get = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  let home = config.home
  if (home) sources.home = 'config'
  if (!home && env.DSH_HOME) {
    home = env.DSH_HOME
    sources.home = 'env'
  }
  if (!home) {
    home = join(homedir(), '.dsh')
    sources.home = 'default ~/.dsh'
  }

  const profileContext = get('profileContext')
  const configEditor = get('configEditor')

  let profileDir = config.profileDir
  if (profileDir) sources.profileDir = 'config'
  if (!profileDir && env.DSH_PROFILE_DIR) {
    profileDir = env.DSH_PROFILE_DIR
    sources.profileDir = 'env'
  }
  if (!profileDir && typeof profileContext?.dir === 'string' && profileContext.dir) {
    profileDir = profileContext.dir
    sources.profileDir = 'profileContext.dir'
  }
  if (!profileDir && typeof configEditor?.documentPath === 'string' && configEditor.documentPath) {
    profileDir = dirnameOf(configEditor.documentPath)
    sources.profileDir = 'configEditor.documentPath'
  }
  if (!profileDir) {
    const detected = detectProfileDir(home)
    if (detected) {
      profileDir = detected
      sources.profileDir = 'scan ~/.dsh/profiles'
    }
  }

  let profile = config.profile
  if (profile) sources.profile = 'config'
  if (!profile && env.DSH_PROFILE) {
    profile = env.DSH_PROFILE
    sources.profile = 'env'
  }
  if (!profile && profileDir) {
    profile = basename(profileDir)
    sources.profile = 'dirname(profileDir)'
  }

  let webUrl = config.webUrl
  if (webUrl) sources.webUrl = 'config'
  if (!webUrl && env.DSH_WEB_URL) {
    webUrl = env.DSH_WEB_URL
    sources.webUrl = 'env'
  }
  if (!webUrl) {
    const advertised = safeCall(get('webApp'), 'getAdvertisedUrl')
    if (typeof advertised === 'string' && advertised) {
      webUrl = advertised
      sources.webUrl = 'webApp.getAdvertisedUrl'
    }
  }
  if (!webUrl) {
    const origin = safeCall(get('webServer'), 'getOrigin')
    if (typeof origin === 'string' && origin) {
      webUrl = origin
      sources.webUrl = 'webServer.getOrigin'
    }
  }

  let cwd = config.cwd
  if (!cwd) {
    const workingDirectory = get('workingDirectory')
    if (typeof workingDirectory?.defaultDirectory === 'string' && workingDirectory.defaultDirectory) {
      cwd = workingDirectory.defaultDirectory
      sources.cwd = 'workingDirectory.defaultDirectory'
    } else {
      cwd = process.cwd()
      sources.cwd = 'process.cwd()'
    }
  } else {
    sources.cwd = 'config'
  }

  return {
    home,
    profile,
    profileDir,
    webUrl,
    cwd,
    dshRoot: config.dshRoot,
    env,
    sources,
    // 连接探测是可选项：config.connectivity === false 时只做接入点发现，不联网。
    connectivity: config.connectivity,
    connectivityBudgetMs: config.connectivityBudgetMs,
  }
}

function dirnameOf(file) {
  const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return index > 0 ? file.slice(0, index) : file
}

function safeCall(target, method) {
  try {
    return typeof target?.[method] === 'function' ? target[method]() : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx, config = {}) {
  const state = {
    report: undefined,
    running: undefined,
    createdAt: 0,
    error: undefined,
    history: [],
    exportsDir: undefined,
  }
  const refreshMs = Number(config.refreshMs ?? 15000) || 15000

  // 预热可选视图模型与样式；认证数据接口还会等待 ready，Web 首屏同步兜底尽量复用缓存。
  void loadOptional('view-model')
  void loadOptional('panel-css')

  const isFresh = () => state.report !== undefined && Date.now() - state.createdAt < refreshMs

  function refresh({ force = false } = {}) {
    if (!force && isFresh()) return Promise.resolve(state.report)
    if (state.running) return state.running
    state.running = Promise.resolve()
      .then(() => runDoctor(resolveRuntime(ctx, config)))
      .then((report) => {
        state.report = report
        state.createdAt = Date.now()
        state.error = undefined
        // 历史列表跟着报告一起刷新：面板和工具都要用它，但它的失败不能影响报告本身
        void refreshHistory()
        return report
      })
      .catch((error) => {
        state.error = error
        throw error
      })
      .finally(() => {
        state.running = undefined
      })
    return state.running
  }

  /** 读导出历史（可选模块；失败就把历史清空，不抛错）。 */
  async function refreshHistory() {
    const store = await loadOptional('store')
    const home = resolveRuntime(ctx, config).home
    if (!store) {
      state.exportsDir = undefined
      state.history = []
      return
    }
    try {
      state.exportsDir = store.exportsDir({ home })
      state.history = await store.listExports({ home, limit: 5 })
    } catch {
      state.history = []
    }
  }

  /**
   * 生成一份脱敏导出。默认脱敏（家目录/用户名/主机名/密钥/会话 id），
   * 因为「导出一份报告发给人看」是这个功能最常见的用法 —— 不脱敏的导出等于制造新的泄漏。
   */
  async function exportReport(report, format = 'markdown', { redact = true } = {}) {
    const store = await loadOptional('store')
    if (!store) throw new Error('导出模块不可用（lib/store.js 缺失）')
    const runtime = resolveRuntime(ctx, config)
    let body = report
    let redaction = { hits: {} }
    if (redact) {
      const redactMod = await loadOptional('redact')
      if (redactMod?.redactReport) redaction = redactMod.redactReport(report, { home: runtime.home })
    }
    if (redact && !redaction.report) throw new Error('脱敏模块不可用，已停止导出，未写入原始报告')
    body = redaction.report ?? report
    const text = format === 'json' ? renderJson(body) : renderMarkdown(body)
    // score 要显式传：store 是从入参读的，不会去猜报告结构（脱敏后的对象结构也不该被它依赖）
    const score = body?.summary?.score ?? report?.summary?.score ?? null
    const meta = await store.exportReport({ text, format, report: body, home: runtime.home, score })
    const totalRedactions = Object.values(redaction.hits ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0)
    void refreshHistory()
    return { ...meta, redactions: totalRedactions, redactionHits: redaction.hits ?? {}, redacted: redact }
  }

  function historyLines(limit = 5) {
    const items = state.history.slice(0, limit)
    if (items.length === 0) return `还没有导出记录。用 /doctor export 生成一份（默认脱敏）。`
    const head = `导出目录：${state.exportsDir ?? '(未知)'}`
    const rows = items.map((it) => {
      const size = it.bytes >= 1024 ? `${(it.bytes / 1024).toFixed(1)} KB` : `${it.bytes} B`
      return `· ${it.name} — ${it.format} · ${size} · 得分 ${it.score ?? 'na'}`
    })
    return [head, ...rows].join('\n')
  }

  // 启动即预热，让面板首屏就有数据
  refresh().catch(() => {})

  const disposers = []
  const onDispose = (fn) => {
    if (typeof fn === 'function') disposers.push(fn)
  }

  /* ------------------------------ 工具 ------------------------------ */
  const tools = ctx.get?.('tools')
  if (tools && typeof tools.register === 'function') {
    onDispose(
      tools.register({
        name: 'dsh_doctor',
        description:
          '体检当前 DSH 运行环境（Node/安装/配置/插件/数据/工作区/环境变量/本地 Web），只读探测，不读取任何密钥的值。返回统一结构的诊断结果（id/category/severity/status/summary/evidence/recommendations）、得分与可操作建议。',
        parameters: {
          type: 'object',
          properties: {
            group: {
              type: 'string',
              description:
                '只看某一类别；省略则返回全部。旧名 install/env/profile/web 仍可用（自动映射到新类别）。',
              enum: [
                ...CATEGORIES,
                'install',
                'env',
                'profile',
                'web',
              ],
            },
            format: {
              type: 'string',
              description: 'markdown = 完整分组报告；compact = 一屏摘要；json = 结构化结果。默认 compact。',
              enum: ['compact', 'markdown', 'json'],
            },
            onlyProblems: {
              type: 'boolean',
              description: '只列出 issue 状态的条目（severity error/warning）。',
            },
            force: {
              type: 'boolean',
              description: '强制重新探测，忽略缓存。',
            },
            export: {
              type: 'string',
              description:
                '把报告导出到本地目录（默认脱敏：家目录/用户名/主机名/密钥/会话 id 全部替换），返回文件路径。',
              enum: ['markdown', 'json'],
            },
            history: {
              type: 'boolean',
              description: '列出最近的导出记录（名称、格式、大小、得分）。',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              score: { type: 'number', description: '健康得分 0-100' },
              summary: { type: 'object', description: 'ok/warn/fail/skip/total/score 计数' },
              problems: {
                type: 'array',
                description: '需要处理的条目（severity error/warning）',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: '规则编号，如 DSH-CFG-003' },
                    category: { type: 'string' },
                    severity: { type: 'string' },
                    title: { type: 'string' },
                    summary: { type: 'string' },
                    recommendations: { type: 'array', items: { type: 'string' } },
                    repairOffers: { type: 'array', description: '适用的准备动作；调用 dsh_repair prepare 后仍须预览和用户确认', items: { type: 'object' } },
                  },
                },
              },
              text: { type: 'string', description: '渲染好的报告正文' },
            },
          },
          render(_args, value) {
            const text = typeof value?.text === 'string' && value.text ? value.text : summaryLine(state.report)
            return [{ type: 'text', text }]
          },
        },
        isConcurrencySafe: () => true,
        timeoutMs: 20000,
        async execute(args = {}) {
          // 未知分组必须当场拒绝：否则 normalizeCategory 返回 undefined，
          // 报告悄悄变成全量，调用方以为自己在看某一组。先校验再跑体检，省下 3s。
          const group = normalizeCategory(args.group)
          if (args.group !== undefined && args.group !== null && args.group !== '' && !group) {
            return {
              score: state.report?.summary?.score ?? null,
              summary: state.report?.summary ?? null,
              problems: [],
              text: [
                `未知分组：${String(args.group)}`,
                `可用分组：${CATEGORIES.join(' / ')}`,
                `旧别名：${Object.keys(LEGACY_GROUP_ALIAS).join(' / ')}（会自动映射到新类别）`,
              ].join('\n'),
            }
          }
          const report = await refresh({ force: args.force === true })
          const onlyProblems = args.onlyProblems === true
          const repairOffers = buildRepairActions(report, resolveRuntime(ctx, config))
          const problems = (report.results ?? [])
            .filter((r) => r.status === 'issue' && (!group || r.category === group))
            .map((r) => ({
              id: r.id,
              category: r.category,
              severity: r.severity,
              title: r.title ?? r.id,
              summary: r.summary,
              recommendations: r.recommendations,
              repairOffers: repairOffers
                .filter((offer) => offer.ruleIds.includes(r.id))
                .map((offer) => ({ offerId: offer.id, kind: offer.kind, prepareArgs: offer.prepareArgs, requiredInputs: offer.inputs.map((input) => input.name) })),
            }))
          const lines = []
          if (args.export === 'markdown' || args.export === 'json') {
            try {
              const meta = await exportReport(report, args.export)
              const hits = Object.entries(meta.redactionHits ?? {})
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${k}×${n}`)
                .join(' · ')
              lines.push(`已导出 ${args.export}：${meta.path}`)
              lines.push(
                `脱敏 ${meta.redactions} 处${hits ? `（${hits}）` : ''}${meta.redacted ? '' : '（未脱敏，调用方要求原样）'}`,
              )
            } catch (error) {
              lines.push(`导出失败：${String(error?.message ?? error)}`)
            }
          }
          if (args.history === true) {
            await refreshHistory()
            lines.push(historyLines())
          }
          // 报告正文：只有显式指定 format 才渲染；只做导出/看历史时不要塞一屏报告进去。
          // 但「什么都没指定」必须给 compact，否则调用方拿到的是一段纯路径文字，看不出健康度。
          let body = ''
          if (args.format === 'json') body = renderJson({ ...report, results: (report.results ?? []).map((r) => ({ ...r, repairOffers: problems.find((p) => p.id === r.id)?.repairOffers ?? [] })) }, { group, onlyProblems })
          else if (args.format === 'markdown') body = renderMarkdown(report, { group, onlyProblems })
          else if (args.format === 'compact' || (args.export === undefined && args.history !== true)) body = renderCompact(report)
          const actionable = [...new Map(problems.flatMap((p) => p.repairOffers).map((offer) => [offer.offerId, offer])).values()]
          if (body && args.format !== 'json' && actionable.length) {
            body += '\n\n可准备的修复（尚未执行）：\n' + actionable.map((offer) =>
              `· dsh_repair action=prepare ${JSON.stringify(offer.prepareArgs)}${offer.requiredInputs.length ? `；由用户提供 ${offer.requiredInputs.join(' / ')}` : ''}`,
            ).join('\n') + '\n准备后先 preview，再由真实用户确认；也可使用面板修复中心。'
          }
          const text = [...lines, body].filter((x) => x !== '').join('\n\n')
          return { score: report.summary.score, summary: report.summary, problems, text }
        },
      }),
    )
  }

  /* ------------------------------ 命令 ------------------------------ */
  const commands = ctx.get?.('commands')
  if (commands && typeof commands.register === 'function') {
    onDispose(
      commands.register({
        name: 'doctor',
        description: '体检 DSH 运行环境（只读）并输出分组报告；/doctor export [md|json] 导出脱敏报告，/doctor history 看历史，/doctor repair [list|apply <planId> --yes|rollback <recordId> --yes] 受控修复',
        handler: async (invocation) => {
          const raw = String(invocation?.rawInput ?? invocation?.input ?? invocation?.args ?? invocation?.text ?? '').trim()
          const parts = raw.split(/\s+/).filter(Boolean)
          const [sub, arg] = parts
          try {
            if (sub === 'repair') {
              const act = parts[1] ?? 'list'
              const target = parts[2]
              const yes = parts.includes('--yes')
              const outcome = await runRepair(act, {
                kind: act === 'prepare' ? target : undefined,
                proxyUrl: act === 'prepare' && target === 'proxy-env' ? parts[3] : undefined,
                target: act === 'prepare' && target === 'strip-bom' ? parts.slice(3).join(' ').replace(/^"|"$/g, '') : undefined,
                planId: act === 'rollback' || act === 'prepare' ? undefined : target,
                recordId: act === 'rollback' ? target : undefined,
                // 命令里的 --yes 是「人在这里明确同意」的等价物；工具里对应 confirm=<id>。
                confirm: yes ? target : undefined,
              })
              return { kind: ['failed', 'refused', 'partial'].includes(outcome.status) ? 'error' : 'success', text: outcome.text }
            }
            if (sub === 'history') {
              const report = await refresh()
              await refreshHistory()
              return { kind: 'success', text: `${historyLines(10)}\n\n${renderCompact(report)}` }
            }
            if (sub === 'export') {
              const format = arg === 'json' ? 'json' : 'markdown'
              const report = await refresh({ force: true })
              const meta = await exportReport(report, format)
              const hits = Object.entries(meta.redactionHits ?? {})
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${k}×${n}`)
                .join(' · ')
              return {
                kind: 'success',
                text: `已导出 ${format}：${meta.path}\n大小 ${meta.bytes} B · 脱敏 ${meta.redactions} 处${hits ? `（${hits}）` : ''}`,
              }
            }
            const report = await refresh({ force: true })
            return { kind: 'success', text: renderMarkdown(report) }
          } catch (error) {
            return { kind: 'error', text: `DSH Doctor 执行失败：${String(error?.message ?? error)}` }
          }
        },
      }),
    )
  }

  /* --------------------------- 修复执行（受控） --------------------------- */
  const repairController = createRepairController({
    refresh,
    runtime: () => resolveRuntime(ctx, config),
    loadModule: loadOptional,
  })
  const runRepair = (action, args) => repairController.run(action, args)

  if (tools && typeof tools.register === 'function') {
    onDispose(
      tools.register({
        name: 'dsh_repair',
        description:
          '查看、准备和执行 DSH Doctor 修复计划。prepare/preview 只生成和展示方案；apply/rollback 会向真实用户提问，用户同意后才备份执行或回滚。支持代理配置、profile BOM 与日志脱敏。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'list 列计划；prepare 准备真实动作；preview 预览；apply 确认执行；rollback 还原；history 看记录。默认 list。',
              enum: ['list', 'prepare', 'preview', 'apply', 'rollback', 'history'],
            },
            kind: { type: 'string', enum: ['proxy-env', 'strip-bom', 'secret-cleanup'], description: 'prepare 的动作类型。日志清理默认延后最近10分钟写入的文件。' },
            proxyUrl: { type: 'string', description: 'prepare proxy-env 时显式提供的 http(s) 代理地址，不含账号密码；写入主目录 .env，下次启动生效。' },
            target: { type: 'string', description: 'prepare strip-bom 的目标，仅当前 profile 的 package.json 或 cordis.patch.yml。' },
            planId: { type: 'string', description: 'list/prepare 返回的计划 id，用于 preview/apply；准备快照15分钟过期。' },
            confirm: {
              type: 'string',
              description: 'apply 须与 planId 一致，rollback 须与 recordId 一致；随后仍会向真实用户提问，此参数本身不代表用户已同意。',
            },
            recordId: { type: 'string', description: '执行记录 id（action=history 可查），用于 rollback。' },
            force: { type: 'boolean', description: '先重新体检再取计划（默认用缓存报告）。' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              status: { type: 'string', description: 'prepared/applied/partial/failed/refused/noop/restored；partial 表示覆盖或复检未完整。' },
              text: { type: 'string', description: '渲染好的说明' },
              record: { type: 'object', description: '执行记录（apply 时返回）' },
              plan: { type: 'object', description: '计划摘要（preview 时返回）' },
            },
          },
          render(_args, value) {
            return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '（无输出）' }]
          },
        },
        isConcurrencySafe: () => false,
        // A human may need time to review the exact plan; prepared plans still expire after 15 minutes.
        timeoutMs: 5 * 60 * 1000,
        async execute(args = {}, exec = {}) {
          const action = String(args.action ?? 'list')
          const questions = ctx.get?.('userQuestions')
          const ask = exec.agent && typeof questions?.ask === 'function' ? async ({ action: operation, id, preview, signal }) => {
            const questionId = `doctor-${operation}-${id}`
            const label = operation === 'rollback' ? '同意回滚此记录' : '同意执行此方案'
            const answer = await questions.ask({
              agent: exec.agent,
              signal,
              questions: [{
                id: questionId,
                header: operation === 'rollback' ? '确认回滚' : '确认修复',
                question: `${operation === 'rollback' ? '回滚执行记录' : '执行修复方案'} ${id}？仅在你同意后修改文件。`,
                detail: JSON.stringify(preview, null, 2),
                options: [{ label }, { label: '取消' }],
              }],
            })
            const rows = answer?.answers
            return Array.isArray(rows) && rows.length === 1 && rows[0].id === questionId
              && Array.isArray(rows[0].selected) && rows[0].selected.length === 1 && rows[0].selected[0] === label
          } : undefined
          try {
            return await runRepairWithConsent(runRepair, action, args, { ask, signal: exec.signal })
          } catch {
            return { action, status: 'failed', text: '修复动作未完成，请重新预览后重试。' }
          }
        },
      }),
    )
  }

  /* --------------------------- 面板数据注入 --------------------------- */
  const webServer = ctx.get?.('webServer')
  // Shared by authenticated panel Fetch and optional initial HTML injection.
  const snapshot = () => {
      const report = state.report && panelReportOf(state.report)
      if (!report) {
        return { pending: true, error: state.error || state.panelTransportError ? PANEL_COLLECTION_ERROR : undefined }
      }
      // report 不传 raw facts/rules；model 从去除内部异常后的报告提取白名单展示字段（含 facts 派生信息）。
      // 两种只读通路共享同一 payload；准备好的文件正文和 patch 始终不进入它。
      const { facts: _facts, rules: _rules, plans: _plans, ...slim } = report
      // HTML only gets content-free plan summaries, never prepared file contents.
      slim.plans = repairController.snapshotPlans(report.plans ?? [])
      // 面板要 5 个页面：整理数据的活交给 lib/view-model.js（纯函数、可单测），
      // 面板只负责画。模块缺失时不注入 model，client 会用报告本体现场拼一份。
      const viewModel = optionalModules.get('view-model')
      const panelCss = optionalModules.get('panel-css')
      let model
      try {
        model = typeof viewModel?.buildViewModel === 'function' ? viewModel.buildViewModel({ ...report, plans: slim.plans }, { limitIssues: 40, limitClusters: 12 }) : undefined
      } catch {
        model = undefined
      }
      return {
        pending: false,
        error: state.panelTransportError,
        report: slim,
        model,
        styles: typeof panelCss?.PANEL_CSS === 'string' ? panelCss.PANEL_CSS : undefined,
        stale: Date.now() - state.createdAt > refreshMs,
        refreshInFlight: Boolean(state.running),
        staleAfterMs: refreshMs,
        generatedAt: report.generatedAt,
        // 导出历史只读展示；随面板认证请求或 Web 首屏快照一起返回，不触发导出动作。
        exports: { dir: state.exportsDir, items: state.history.slice(0, 5) },
        repair: {
          available: state.repairPanelEnabled === true,
          error: state.repairTransportError,
          actions: buildRepairActions(state.report, resolveRuntime(ctx, config)),
        },
      }
    }
    // Connection owns the authentication fence. Reactively mount when it arrives,
  // including after this optional plugin has already activated.
  const mountPanelData = (panelCtx) => {
    try {
      const dispose = registerPanelData(panelCtx.get?.('connection'), {
        refresh,
        snapshot,
        ready: () => Promise.all([loadOptional('view-model'), loadOptional('panel-css')]),
      })
      if (typeof dispose === 'function') {
        if (typeof panelCtx.effect === 'function') panelCtx.effect(() => dispose)
        else onDispose(dispose)
      }
      state.panelTransportError = undefined
    } catch {
      // Optional route failures must not disable the diagnostic tools or leak raw errors.
      state.panelTransportError = '面板数据接口暂未就绪，请重新启用插件后重试。'
    }
  }
  const mountRepairPanel = (panelCtx) => {
    state.repairPanelEnabled = false
    try {
      const dispose = registerRepairPanel(panelCtx.get?.('connection'), {
        runRepair,
        getActions: async () => buildRepairActions(await refresh(), resolveRuntime(ctx, config)),
        onChanged: () => refresh({ force: true }),
      })
      if (typeof dispose === 'function') {
        state.repairPanelEnabled = true
        if (typeof panelCtx.effect === 'function') panelCtx.effect(() => dispose)
        else onDispose(dispose)
      }
      state.repairTransportError = undefined
    } catch {
      state.repairTransportError = '面板修复入口暂未就绪，请使用对话中的修复工具。'
    }
  }
  const mountConnection = (panelCtx) => { mountPanelData(panelCtx); mountRepairPanel(panelCtx) }
  if (typeof ctx.inject === 'function') ctx.inject(['connection'], mountConnection)
  else mountConnection(ctx)
  if (webServer && typeof webServer.tapIndex === 'function') {
    onDispose(
      webServer.tapIndex((html) => {
        if (!isFresh()) refresh().catch(() => {})
        let payload
        try {
          payload = JSON.stringify(snapshot()).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, ' ')
        } catch {
          payload = '{"pending":true}'
        }
        const tag = `<script type="application/json" id="${REPORT_ELEMENT_ID}">${payload}</script>`
        return html.includes('</head>') ? html.replace('</head>', `${tag}\n</head>`) : `${tag}\n${html}`
      }),
    )
  }

  // 兜底：即使上面全部不可用，也让插件能加载、能通过命令/工具之外的途径排查
  if (disposers.length > 0 && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 卸载时的清理失败不影响其它插件 */
        }
      }
    })
  }
}

export default { apply }
