/**
 * DSH Doctor — 内置规则库（确定性规则层）。
 *
 * 设计文档第五节的「三层推理」只把第一层放在这里：确定性规则。每条规则：
 *   { id, category, severity, title, evaluate(facts) => DiagnosticResult | undefined }
 * - 返回 undefined 表示「这条规则当前不适用」（例如没有 web 地址就没有端口可探），
 *   不是「通过」——不适用和没问题在报告里必须能区分。
 * - 没有任何一条规则会修改系统。修复能力是后续阶段的独立模块（L2 必须显式确认）。
 *
 * 规则编号约定：DSH-<领域>-<序号>，一旦发布就不改号（报告与测试集都按它索引）。
 */
import { existsSync } from 'node:fs'
import { issue, pass, unknown, CATEGORY_LABELS } from './diag.js'
import { humanBytes, satisfiesRange, versionTuple } from './probe.js'
import { FINDING_CATALOG } from './installer.js'

const R = (def) => def

/**
 * 「已自愈」判定：聚类签名里点名了某个模块路径，而该路径现在存在，说明这条错误是
 * 开发/上次安装时的瞬时产物。实测过：`module-not-found` 指向一个 3 分钟前才建好的文件，
 * 却能在 24h 窗口里继续当作「现在坏了」，把用户骗去重装插件。
 * 只对「模块找不到」类聚类做这个复查，其它错误没有可验证的落点。
 */
const REVIVABLE_KINDS = new Set(['module-not-found', 'app-code-module-missing'])
const PATH_IN_SAMPLE = /[A-Za-z]:\\[^'"\r\n)]+\.(?:m?js|cjs|ts|json)/g

function clusterRevived(cluster) {
  if (!cluster) return false
  if (cluster.revived === true) return true
  if (!REVIVABLE_KINDS.has(cluster.kind)) return false
  const paths = String(cluster.sample ?? '').match(PATH_IN_SAMPLE) ?? []
  if (paths.length === 0) return false
  return paths.every((item) => {
    try {
      return existsSync(item)
    } catch {
      return false
    }
  })
}

/* ------------------------------- 运行环境 ------------------------------- */

const nodeVersion = R({
  id: 'DSH-ENV-001',
  category: 'environment',
  severity: 'error',
  title: 'Node 运行时版本',
  evaluate(facts) {
    const node = facts.runtime?.node
    if (!node) return undefined
    const need = facts.install?.enginesNode
    const base = `${node} · ${facts.runtime.platform}/${facts.runtime.arch}`
    if (!need) {
      return pass(this.id, this.category, base, { title: this.title, evidence: ['DSH 未声明 engines.node'] })
    }
    const ok = satisfiesRange(node, need)
    if (ok === undefined) {
      return unknown(this.id, this.category, `${base} · DSH 声明 ${need}（区间写法无法判定）`, {
        title: this.title,
        evidence: [`engines.node=${need}`],
      })
    }
    if (ok) return pass(this.id, this.category, `${base} · 满足 ${need}`, { title: this.title, evidence: [`engines.node=${need}`] })
    return issue(this.id, this.category, 'error', `当前 ${node}，DSH 要求 ${need}`, {
      title: this.title,
      evidence: [`engines.node=${need}`, `process.version=${node}`],
      possibleCauses: ['安装了多个 Node 版本，DSH 用的是不满足要求的那个', '升级/降级过 Node 但没重启宿主'],
      recommendations: [`切换到满足 ${need} 的 Node（桌面版用内置运行时，一般无需处理）`, '重启 DSH 后重新体检'],
      confidence: 0.95,
    })
  },
})

const installRoot = R({
  id: 'DSH-ENV-002',
  category: 'environment',
  severity: 'warning',
  title: 'DSH 安装位置',
  evaluate(facts) {
    const install = facts.install
    if (!install) return undefined
    if (!install.root) {
      return issue(this.id, this.category, 'warning', '未能定位 DSH 安装根目录', {
        title: this.title,
        evidence: ['环境变量 DSH_APP_ROOT / DSH_INSTALL_DIR 均未设置', '可执行文件相对路径与 process.argv[1] 上溯都没命中'],
        recommendations: ['在插件 Config 里显式指定 dshRoot，或忽略此项（其余检查仍有效）'],
        confidence: 0.6,
      })
    }
    return pass(this.id, this.category, `${install.dshVersion ?? '版本未知'} · ${install.root}`, {
      title: this.title,
      evidence: [`探测线索：${install.rootSource ?? '未知'}`, install.rootName ? `安装根 package.name=${install.rootName}` : ''],
      data: { root: install.root },
    })
  },
})

const hostPackages = R({
  id: 'DSH-ENV-003',
  category: 'environment',
  severity: 'error',
  title: '宿主包完整性',
  evaluate(facts) {
    const install = facts.install
    if (!install?.root) return undefined
    if (install.modulesReadable) {
      return pass(this.id, this.category, `@deepseek-ai 下 ${install.hostPackageCount} 个包`, {
        title: this.title,
        data: { count: install.hostPackageCount },
      })
    }
    return issue(this.id, this.category, 'error', '宿主 node_modules/@deepseek-ai 为空或不可读', {
      title: this.title,
      evidence: [`目录：${install.root}\\node_modules\\@deepseek-ai`],
      possibleCauses: ['安装不完整或被清理工具删过文件', '安装目录权限异常'],
      recommendations: ['重装 DSH 运行时（或修复安装目录权限）'],
      confidence: 0.9,
    })
  },
})

const hostLoad = R({
  id: 'DSH-RUN-001',
  category: 'runtime',
  severity: 'info',
  title: '主机资源',
  evaluate(facts) {
    const r = facts.runtime
    if (!r) return undefined
    const freeRatio = r.totalMemBytes ? r.freeMemBytes / r.totalMemBytes : undefined
    const detail = `${r.cpuCount ?? '?'} 核 · 内存 ${humanBytes(r.totalMemBytes)}（可用 ${humanBytes(r.freeMemBytes)}）· ${r.osRelease}`
    if (freeRatio !== undefined && freeRatio < 0.05) {
      return issue(this.id, this.category, 'warning', `${detail} · 可用内存不足 5%`, {
        title: this.title,
        recommendations: ['关掉占内存的进程再重试；内存耗尽时工具调用会随机失败'],
      })
    }
    return pass(this.id, this.category, detail, { title: this.title })
  },
})

const runMode = R({
  id: 'DSH-RUN-002',
  category: 'runtime',
  severity: 'info',
  title: '运行模式',
  evaluate(facts) {
    const mode = facts.mode
    if (!mode) return undefined
    const label = { desktop: '桌面版（Electron 内置运行时）', web: 'Web 服务', cli: 'CLI', unknown: '未能判定' }[mode.value] ?? mode.value
    const extra = { title: this.title, evidence: mode.evidence }
    if (mode.value === 'unknown') return unknown(this.id, this.category, label, extra)
    return pass(this.id, this.category, label, extra)
  },
})

/* ------------------------------- 配置 ------------------------------- */

const profileDir = R({
  id: 'DSH-CFG-001',
  category: 'configuration',
  severity: 'error',
  title: 'Profile 目录',
  evaluate(facts) {
    const cfg = facts.configuration
    // 区分「采集层整个没跑」与「跑了但没解析出 profileDir」：
    // 前者是 unknown（我们不知道），后者才是 issue（环境确实有问题）。
    if (!cfg) {
      return unknown(this.id, this.category, '本次没有采集到配置层信息', {
        title: this.title,
        evidence: ['facts.configuration 缺失'],
      })
    }
    if (!cfg.profileDir) {
      return issue(this.id, this.category, 'error', '未能解析 profile 目录', {
        title: this.title,
        evidence: ['Config / DSH_PROFILE_DIR / ~/.dsh/profiles 扫描都没有结论'],
        recommendations: ['在插件 Config 里指定 profileDir'],
        confidence: 0.8,
      })
    }
    if (!cfg.profileDirExists) {
      return issue(this.id, this.category, 'error', `${cfg.profileDir}（不存在）`, {
        title: this.title,
        possibleCauses: ['profile 被删除或改名', '配置指向了另一台机器的路径'],
        recommendations: ['确认 ~/.dsh/profiles 下真实存在的 profile 名，并在 Config 里改正'],
        confidence: 0.9,
      })
    }
    const origin = facts.sources?.profileDir ? `（来源：${facts.sources.profileDir}）` : ''
    return pass(this.id, this.category, `${cfg.profileDir}${origin}`, { title: this.title })
  },
})

const patchFile = R({
  id: 'DSH-CFG-002',
  category: 'configuration',
  severity: 'warning',
  title: '组合补丁 cordis.patch.yml',
  evaluate(facts) {
    const cfg = facts.configuration
    if (!cfg?.profileDir) return undefined
    if (cfg.patchExists) {
      return pass(this.id, this.category, `${cfg.patchRowCount} 行 · ${humanBytes(cfg.patchBytes)}`, {
        title: this.title,
        data: { rows: cfg.patchRowCount },
      })
    }
    return issue(this.id, this.category, 'warning', '文件缺失或不可读', {
      title: this.title,
      evidence: [`期望路径：${cfg.patchPath}`],
      possibleCauses: ['全新 profile 首次启动会自动生成', '文件被误删'],
      recommendations: ['确认该 profile 是否真的需要自定义组合；缺失时以默认组合启动'],
      confidence: 0.5,
    })
  },
})

const patchRows = R({
  id: 'DSH-CFG-003',
  category: 'configuration',
  severity: 'warning',
  title: '补丁行 ↔ 已装包',
  evaluate(facts) {
    const cfg = facts.configuration
    if (!cfg?.patchExists || cfg.patchRowCount === 0) return undefined
    const missing = cfg.missingPackages ?? []
    const parts = [`${cfg.patchRowCount} 行（${cfg.overrideRows.length} 行改现有项 · ${cfg.patchRowCount - cfg.overrideRows.length} 行引用包）`]
    if (cfg.hostProvided?.length) parts.push(`${cfg.hostProvided.length} 个包由宿主提供`)
    if (missing.length === 0) return pass(this.id, this.category, parts.join(' · '), { title: this.title, data: { rows: cfg.patchRowCount } })
    const names = missing.map((m) => `${m.name}${m.isLocalPath ? '(本地包未 link)' : ''}`)
    parts.push(`找不到：${names.slice(0, 6).join('、')}${names.length > 6 ? ` …共 ${names.length} 个` : ''}`)
    return issue(this.id, this.category, 'warning', parts.join(' · '), {
      title: this.title,
      evidence: missing.slice(0, 10).map((m) => `行 ${m.id} → ${m.name}`),
      possibleCauses: [
        '补丁行还在，但对应包已从 profile 依赖里移除',
        '本地包用 file:/link: 引用，尚未 link 进 profile 的 node_modules',
        '包由宿主内置提供，但当前安装版本里没有',
      ],
      recommendations: [
        '删掉这些补丁行，或把对应包装回 profile',
        '本地开发包执行一次安装/链接后再体检',
      ],
      confidence: 0.75,
      data: { missing: names.slice(0, 20), rows: cfg.patchRowCount },
    })
  },
})

const profilePackage = R({
  id: 'DSH-CFG-004',
  category: 'configuration',
  severity: 'error',
  title: 'Profile 清单 package.json',
  evaluate(facts) {
    const cfg = facts.configuration
    if (!cfg?.profileDirExists) return undefined
    if (cfg.profilePkgExists) {
      return pass(this.id, this.category, `依赖 ${cfg.dependencyCount} 项`, { title: this.title, data: { deps: cfg.dependencyCount } })
    }
    return issue(this.id, this.category, 'error', '缺失或 JSON 解析失败', {
      title: this.title,
      evidence: [`期望路径：${cfg.profilePkgPath}`],
      possibleCauses: ['手工编辑 package.json 时写坏 JSON', '文件被误删'],
      recommendations: ['从备份恢复，或用插件页重装任一插件让 pnpm 重建清单'],
      confidence: 0.85,
    })
  },
})

/* ------------------------------- 插件 ------------------------------- */

/**
 * UTF-8 BOM 检查（DSH-CFG-005）。
 * 为什么必须单独一条：`profilePkgBom` / `patchBom` 这两个事实从 0.2 就采集了，
 * 但一直没有任何规则读它们 —— 于是「文件里多了一个 U+FEFF、加载器直接 SyntaxError」
 * 这种真故障在报告里完全隐形（回归集 RC-003 就是照这个形态建的）。
 * 它和 CFG-004（存在性/可解析）不是同一件事：能解析的文件也可能带 BOM。
 */
const manifestBom = R({
  id: 'DSH-CFG-005',
  category: 'configuration',
  severity: 'error',
  title: '配置文件 BOM',
  evaluate(facts) {
    const cfg = facts.configuration
    if (!cfg?.profilePkgPath && !cfg?.patchPath) return undefined
    const problems = []
    if (cfg.profilePkgBom === true) problems.push(cfg.profilePkgPath)
    if (cfg.patchBom === true) problems.push(cfg.patchPath)
    if (problems.length === 0) {
      if (cfg.profilePkgBom === undefined && cfg.patchBom === undefined) return undefined
      return pass(this.id, this.category, '没有 BOM', { title: this.title, evidence: [cfg.profilePkgPath, cfg.patchPath].filter(Boolean) })
    }
    return issue(this.id, this.category, 'error', `${problems.length} 个文件带 UTF-8 BOM`, {
      title: this.title,
      evidence: problems.filter(Boolean),
      possibleCauses: ['用 PowerShell 的 `Set-Content -Encoding utf8` 写文件（Windows PowerShell 5 会写 BOM）', '用记事本另存为 UTF-8 时勾选了 BOM'],
      recommendations: [
        '去掉 BOM 后重写：`[IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`',
        '改完重跑 dsh_doctor 确认 DSH-CFG-005 转 pass',
      ],
      confidence: 0.98,
    })
  },
})

const pluginCount = R({
  id: 'DSH-PLG-001',
  category: 'plugins',
  severity: 'warning',
  title: '已安装插件',
  evaluate(facts) {
    const cfg = facts.configuration
    if (!cfg?.profileDirExists) return undefined
    const list = cfg.plugins ?? []
    if (list.length === 0) {
      return issue(this.id, this.category, 'warning', 'profile 里没有可用插件', {
        title: this.title,
        recommendations: ['用「插件」页安装官方或本地 bundle'],
        confidence: 0.7,
      })
    }
    const names = list.map((p) => `${p.name}@${p.version ?? '?'}`)
    return pass(this.id, this.category, names.slice(0, 12).join('、') + (names.length > 12 ? ` …共 ${names.length} 个` : ''), {
      title: this.title,
      data: { count: list.length, packages: names },
    })
  },
})

const bundlePatch = R({
  id: 'DSH-PLG-002',
  category: 'plugins',
  severity: 'error',
  title: 'Bundle 补丁完整性',
  evaluate(facts) {
    const list = facts.configuration?.plugins ?? []
    const broken = list.filter((p) => p.declaredPatch && p.patchExists === false)
    if (list.length === 0) return undefined
    if (broken.length === 0) {
      const declared = list.filter((p) => p.declaredPatch).length
      if (declared === 0) return pass(this.id, this.category, '没有插件声明 dsh.bundle.patch', { title: this.title })
      return pass(this.id, this.category, `${declared} 个声明了 bundle 补丁的插件文件都在`, { title: this.title })
    }
    return issue(this.id, this.category, 'error', `${broken.length} 个插件的补丁文件缺失`, {
      title: this.title,
      evidence: broken.slice(0, 8).map((p) => `${p.name} → ${p.declaredPatch}`),
      possibleCauses: ['安装不完整（pnpm 硬链接/打包漏文件）', '手工删过文件'],
      recommendations: ['重装这些插件（先 remove_bundle 再 install_bundle）'],
      confidence: 0.9,
      data: { broken: broken.map((p) => p.name) },
    })
  },
})

/**
 * 兼容**元数据**（市场/注册表侧）。
 *
 * 校准记录（0.7.0）：这条以前按「版本兼容声明」报 warning，前提是错的。
 * `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` 读的是
 * `engines.dsh`（有就独占判定）或 `@deepseek-ai/dsh*` peer，**从不读 `dsh.compatibility`**；
 * 后者只在市场展示/发布检查里用。也就是说一个插件「只声明 0.2.0-rc.2」并不会让它加载失败，
 * 把它报成风险会让人去改一个不影响运行的字段。
 * 因此这里降为 info，并把真实加载闸门指向 DSH-INST-008（由 lib/installer.js 判）。
 */
const compatibility = R({
  id: 'DSH-PLG-003',
  category: 'plugins',
  severity: 'info',
  title: '兼容元数据（市场侧）',
  evaluate(facts) {
    const list = facts.configuration?.plugins ?? []
    const dshVersion = facts.install?.dshVersion
    const declared = list.filter((p) => p.compat?.declared)
    if (!dshVersion || declared.length === 0) return undefined
    const bad = declared.filter((p) => p.compat.ok === false)
    const undecided = declared.filter((p) => p.compat.ok === undefined)
    if (bad.length === 0) {
      return pass(this.id, this.category, `${declared.length} 个插件的市场元数据覆盖 ${dshVersion}`, { title: this.title, data: { declared: declared.length } })
    }
    const detail = bad.map((p) => `${p.name} 元数据只列 ${p.compat.range}`)
    return issue(this.id, this.category, 'info', `${bad.length}/${declared.length} 个插件的市场元数据未列 ${dshVersion}`, {
      title: this.title,
      evidence: [...detail.slice(0, 6), '宿主加载期不读 dsh.compatibility，真实闸门见 DSH-INST-008'],
      possibleCauses: ['插件作者只更新了部分发布元数据', '插件确实落后于当前 DSH，但这一步不能证明它加载失败'],
      recommendations: [
        '先看 DSH-INST-008：那才是 engines.dsh / peer 的真实加载判定',
        '元数据不影响运行，只是升级前少一层提示',
      ],
      confidence: 0.4,
      data: { bad: bad.map((p) => p.name), undecided: undecided.map((p) => p.name), dshVersion },
    })
  },
})

/**
 * 未声明兼容区间（DSH-PLG-005）。
 * PLG-003 判的是「声明了但盖不住当前版本」（不知道 vs 明确不支持要分开）：
 * 从没声明 `dsh.compatibility.dsh` 的插件在升级后出问题时，人根本不知道该找谁，
 * 而报告此前对「未声明」是零输出 —— 回归集 RC-005 就卡在这个缺口上。
 * 稳定版里这条按 info 处理（很多插件本来就没写，报 warning 会变成噪音）；
 * 预发布版才升到 warning，因为那时版本漂移最凶。
 */
const compatibilityUndeclared = R({
  id: 'DSH-PLG-005',
  category: 'plugins',
  severity: 'info',
  title: '兼容区间未声明',
  evaluate(facts) {
    const list = facts.configuration?.plugins ?? []
    const dshVersion = facts.install?.dshVersion
    if (!dshVersion || list.length === 0) return undefined
    const undeclared = list.filter((p) => p.compat && p.compat.declared === false)
    if (undeclared.length === 0) {
      const declared = list.filter((p) => p.compat?.declared).length
      return pass(this.id, this.category, declared ? `${declared} 个插件都声明了兼容区间` : '没有插件声明兼容区间', {
        title: this.title,
        data: { declared },
      })
    }
    const prerelease = /-(rc|beta|alpha|pre)/i.test(String(dshVersion))
    const severity = prerelease ? 'warning' : 'info'
    return issue(this.id, this.category, severity, `${undeclared.length}/${list.length} 个插件未声明 dsh.compatibility.dsh`, {
      title: this.title,
      evidence: undeclared.slice(0, 8).map((p) => `${p.name}${p.version ? `@${p.version}` : ''}`),
      possibleCauses: ['插件作者没有写 dsh.compatibility 字段（旧模板普遍如此）'],
      recommendations: [
        `未声明不等于坏了，但升级 DSH（当前 ${dshVersion}）后异常优先怀疑这些插件`,
        '在自己的插件里补 `dsh.compatibility.dsh` 区间，能让下次升级前就被提示',
      ],
      confidence: 0.5,
      data: { undeclared: undeclared.map((p) => p.name), dshVersion },
    })
  },
})

/**
 * 清单 ↔ lockfile 不同步：比「某个插件坏了」严重得多——它让 profile 里**所有**插件的
 * 安装/卸载/升级全部失败，而 pnpm 只会报一个包名。
 */
const lockDrift = R({
  id: 'DSH-PLG-004',
  category: 'plugins',
  severity: 'warning',
  title: 'profile 清单 ↔ lockfile',
  evaluate(facts) {
    const cfg = facts.configuration ?? {}
    if (!cfg.lockExists) return undefined
    const drift = cfg.lockDrift ?? []
    if (drift.length === 0) {
      return pass(this.id, this.category, '清单里写死的版本都能在 lockfile 里找到', { title: this.title })
    }
    return issue(this.id, this.category, 'warning', `${drift.length} 个依赖的版本不在 pnpm-lock.yaml 里`, {
      title: this.title,
      evidence: drift.slice(0, 6).map((d) => `${d.name} → package.json 写 ${d.spec}，lockfile 里没有 ${d.name}@${d.spec}`),
      possibleCauses: [
        'package.json 被手工改过（或插件管理器中途失败），pnpm install 没跑完',
        'lockfile 被回滚/替换成旧版',
      ],
      recommendations: [
        '在 profile 目录跑一次 pnpm install，让 lockfile 与清单对齐；对齐前不要依赖插件安装/卸载',
        '若是刚升级的包被 minimumReleaseAge 之类的供应链策略挡住，先确认策略再决定放行或回退版本',
      ],
      confidence: 0.8,
      data: { drift },
    })
  },
})

/* ------------------------------- 连接 ------------------------------- */
const webPort = R({
  id: 'DSH-NET-001',
  category: 'connectivity',
  severity: 'warning',
  title: '本地 Web 端口',
  evaluate(facts) {
    const web = facts.web
    if (!web?.url) {
      return unknown(this.id, this.category, '没有 Web 地址（非 Web 会话）', { title: this.title })
    }
    if (web.port === undefined) {
      return unknown(this.id, this.category, `无法解析地址：${web.url}`, { title: this.title })
    }
    const target = `${web.host}:${web.port}`
    if (web.listening) return pass(this.id, this.category, `${web.url} · ${target} 在监听`, { title: this.title })
    return issue(this.id, this.category, 'warning', `${web.url} · ${target} 未响应`, {
      title: this.title,
      evidence: [`TCP 连接 ${target} 超时或拒绝`],
      possibleCauses: ['端口被防火墙拦了本地探测', '服务已退出但仍开着页面', '地址写的是别的实例'],
      recommendations: ['页面还能用说明只是探测被拦；页面也打不开时重启 dsh web 并看宿主日志'],
      confidence: 0.5,
    })
  },
})

/* ------------------------------- 数据 ------------------------------- */

const homeDir = R({
  id: 'DSH-DATA-001',
  category: 'data',
  severity: 'error',
  title: 'DSH_HOME 数据目录',
  evaluate(facts) {
    const data = facts.data
    if (!data?.home) return undefined
    if (data.homeExists) return pass(this.id, this.category, data.home, { title: this.title })
    return issue(this.id, this.category, 'error', `${data.home}（不存在）`, {
      title: this.title,
      possibleCauses: ['DSH_HOME 指向了不存在的路径', '迁移过用户目录'],
      recommendations: ['确认路径后重启 DSH；新目录会在首次启动时自动创建'],
      confidence: 0.9,
    })
  },
})

const dataDirs = R({
  id: 'DSH-DATA-002',
  category: 'data',
  severity: 'info',
  title: '数据子目录',
  evaluate(facts) {
    const data = facts.data
    if (!data?.homeExists) return undefined
    if (data.missingDirs.length === 0) {
      return pass(this.id, this.category, `${Object.keys(data.dirs).length} 个数据目录齐备`, { title: this.title })
    }
    return pass(this.id, this.category, `缺少 ${data.missingDirs.join('、')}（通常是尚未使用该功能）`, {
      title: this.title,
      evidence: data.missingDirs,
    })
  },
})

const sessions = R({
  id: 'DSH-DATA-003',
  category: 'logs',
  severity: 'info',
  title: '会话日志',
  evaluate(facts) {
    const s = facts.data?.sessions
    if (!s || !facts.data?.homeExists) return undefined
    if (!s.fileCount) {
      return unknown(this.id, this.category, '没有会话文件（全新安装的正常状态）', { title: this.title })
    }
    const parts = [`${s.fileCount} 个文件 · ${humanBytes(s.bytes)}`, `近 24h 写入 ${s.recent24h} 个`]
    parts.push(s.zstdFiles ? `${s.zstdFiles} 个 .zstd${facts.data.zstdSupported ? '（可解压）' : '（当前 Node 无 zstd 能力）'}` : '无压缩文件')
    const extra = { title: this.title, data: { files: s.fileCount, bytes: s.bytes, recent24h: s.recent24h, zstdFiles: s.zstdFiles } }
    if (s.zstdFiles > 0 && !facts.data.zstdSupported) {
      return unknown(this.id, this.category, parts.join(' · '), {
        ...extra,
        evidence: ['Node 没有 zlib.zstdDecompressSync，日志分析器读不了压缩会话'],
      })
    }
    return pass(this.id, this.category, parts.join(' · '), extra)
  },
})

/* ------------------------------- 工作区 ------------------------------- */

const cwd = R({
  id: 'DSH-WS-001',
  category: 'workspace',
  severity: 'error',
  title: '当前工作区',
  evaluate(facts) {
    const ws = facts.workspace
    if (!ws?.cwd) return undefined
    if (ws.cwdExists) {
      return pass(this.id, this.category, `${ws.cwd} · 顶层 ${ws.cwdEntries ?? '?'} 项`, { title: this.title })
    }
    return issue(this.id, this.category, 'error', `${ws.cwd}（不可访问）`, {
      title: this.title,
      possibleCauses: ['目录被删除或改名', '网络盘断开', '权限不足'],
      recommendations: ['重新打开工作区目录，或换一个存在的目录'],
      confidence: 0.9,
    })
  },
})

const cwdWritable = R({
  id: 'DSH-WS-003',
  category: 'workspace',
  severity: 'error',
  title: '工作区写入权限',
  evaluate(facts) {
    const ws = facts.workspace
    if (!ws?.cwd || !ws.cwdExists || typeof ws.cwdWritable !== 'boolean') return undefined
    if (ws.cwdWritable) return pass(this.id, this.category, '工作区写入权限预检通过（未实际创建文件）', { title: this.title, evidence: [ws.cwd] })
    return issue(this.id, this.category, 'error', `工作区写入权限预检失败${ws.cwdWriteError ? `（${ws.cwdWriteError}）` : ''}`, {
      title: this.title,
      evidence: [ws.cwd, ws.cwdWriteError, ws.cwdWriteDetail].filter(Boolean),
      possibleCauses: ['目录 ACL 或只读挂载限制', '磁盘空间或文件系统状态异常'],
      recommendations: ['检查当前工作区的写入权限与可用空间；临时目录可写不代表工作区可写'],
      confidence: 0.9,
    })
  },
})

const tempWritable = R({
  id: 'DSH-WS-002',
  category: 'workspace',
  severity: 'error',
  title: '临时目录写入',
  evaluate(facts) {
    const ws = facts.workspace
    if (!ws?.tempDir) return undefined
    if (ws.tempWritable) return pass(this.id, this.category, `${ws.tempDir} 可写`, { title: this.title })
    return issue(this.id, this.category, 'error', `${ws.tempDir} 不可写`, {
      title: this.title,
      possibleCauses: ['磁盘满', '安全软件拦截', 'TEMP 指向了只读路径'],
      recommendations: ['清理磁盘或换 TEMP 目录；临时目录不可写会拖垮工具链与日志落盘'],
      confidence: 0.9,
    })
  },
})

/* ------------------------------- 凭据安全 ------------------------------- */

const keyAvailable = R({
  id: 'DSH-SEC-001',
  category: 'security',
  severity: 'warning',
  title: '模型凭据（只看存在性）',
  evaluate(facts) {
    const sec = facts.security
    if (!sec) return undefined
    const extra = { title: this.title, data: { keyEnvNames: sec.keyEnvNames, credentialsExists: sec.credentialsExists } }
    if (sec.keyEnvNames.length > 0) {
      return pass(this.id, this.category, `环境变量已设置：${sec.keyEnvNames.join('、')}（值已隐藏）`, extra)
    }
    if (sec.credentialsExists) {
      return pass(this.id, this.category, '密钥由 .credentials.yaml 托管（内容未读取）', extra)
    }
    return issue(this.id, this.category, 'warning', '既没有密钥环境变量，也没有凭据文件', {
      ...extra,
      possibleCauses: ['还没配置模型密钥', '密钥配在了别的用户/别的 DSH_HOME 下'],
      recommendations: ['在模型设置里填 key，或用 vault 注入环境变量；本插件永不读取密钥值'],
      confidence: 0.8,
    })
  },
})

const keySources = R({
  id: 'DSH-SEC-002',
  category: 'security',
  severity: 'info',
  title: '凭据来源',
  evaluate(facts) {
    const sec = facts.security
    if (!sec) return undefined
    const parts = []
    if (sec.credentialsExists) {
      parts.push(`.credentials.yaml（${humanBytes(sec.credentialsBytes ?? 0)}，mtime ${sec.credentialsMtime}）`)
    }
    if (sec.keyEnvNames.length) parts.push(`环境变量 ${sec.keyEnvNames.join('、')}`)
    if (parts.length === 0) return undefined
    const extra = { title: this.title }
    if (sec.credentialsExists && sec.keyEnvNames.length) {
      return pass(this.id, this.category, `两处都有：${parts.join(' + ')}（环境变量优先）`, extra)
    }
    return pass(this.id, this.category, parts.join(' · '), extra)
  },
})

/* ------------------------------- 环境变量 ------------------------------- */

const dshEnv = R({
  id: 'DSH-ENV-004',
  category: 'environment',
  severity: 'info',
  title: 'DSH 环境变量',
  evaluate(facts) {
    const env = facts.env
    if (!env) return undefined
    const resolved = Object.entries(env.present).map(([k, v]) => `${k}=${v}`)
    const fromFs = env.fromFilesystem.filter((k) => env.present[k]).map((k) => `${k}（由插件解析）`)
    const extra = { title: this.title, data: { dshVarNames: env.dshVarNames, fromFilesystem: env.fromFilesystem } }
    if (env.unresolved.length > 0) {
      // 宿主进程里没有 DSH_* 是**常态**（那些变量只注入给子进程工具），
      // 所以这条只能是提示，不能算 issue —— 否则每台健康机器都会挂一条告警。
      return pass(this.id, this.category, `宿主进程内无 ${env.unresolved.join('、')}（插件已按服务与文件系统兜底）`, {
        ...extra,
        evidence: [...resolved, ...fromFs],
      })
    }
    return pass(this.id, this.category, [...resolved, ...fromFs].filter(Boolean).join(' · ') || '全部由插件解析', {
      ...extra,
      evidence: env.dshVarNames.length ? [`进程内 DSH_* 变量名：${env.dshVarNames.join('、')}`] : [],
    })
  },
})

/* ------------------------------- 日志 ------------------------------- */

const logSources = R({
  id: 'DSH-LOG-001',
  category: 'logs',
  severity: 'info',
  title: '日志源',
  evaluate(facts) {
    const logs = facts.logs
    if (!logs) return undefined
    const sources = logs.sources ?? []
    if (sources.length === 0) {
      return unknown(this.id, this.category, '本机没有发现可读日志源', {
        title: this.title,
        evidence: (logs.errors ?? []).map((e) => `${e.path}: ${e.error}`).slice(0, 5),
      })
    }
    const byKind = {}
    for (const s of sources) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1
    const scanned = logs.scanned ?? {}
    // 「跳过 167 个（超限或不可读）」太空泛：167 里 160 个是「同类文件超过每类 20 个上限」，
    // 那是设计上限，不是故障。按原因聚合后才不会让人以为坏了 167 个文件。
    const skipReasons = {}
    for (const item of logs.skipped ?? []) {
      const key = String(item.reason ?? '未知原因')
        // 数字归一 + 把「每类 N 个文件上限」说成人话，否则会出现「超过每类 N 个文件上限 ×168」
        .replace(/超过每类\s*\d+\s*个文件上限/, '超过每类文件数上限（设计上限）')
        .replace(/\d+/g, 'N')
      skipReasons[key] = (skipReasons[key] ?? 0) + 1
    }
    const skipText = Object.entries(skipReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, n]) => `${reason} ×${n}`)
      .join(' · ')
    return pass(this.id, this.category, Object.entries(byKind).map(([k, n]) => `${k}×${n}`).join(' · '), {
      title: this.title,
      evidence: [
        `扫描 ${scanned.files ?? 0} 个文件 / ${humanBytes(scanned.bytes ?? 0)} / ${scanned.lines ?? 0} 行`,
        logs.skipped?.length ? `跳过 ${logs.skipped.length} 个：${skipText}` : '',
      ].filter(Boolean),
      data: { byKind, scanned },
    })
  },
})

const logClusters = R({
  id: 'DSH-LOG-002',
  category: 'logs',
  severity: 'warning',
  title: '错误聚类',
  evaluate(facts) {
    const logs = facts.logs
    if (!logs) return undefined
    // 先把「签名点名的文件已经存在」的模块缺失聚类摘出去，别让已修好的历史错误继续报障
    const all = logs.clusters ?? []
    const revived = all.filter(clusterRevived)
    const clusters = all.filter((c) => !clusterRevived(c))
    const outside = logs.clustersOutsideWindow ?? []
    const windowStart = logs.windowStart ? logs.windowStart.slice(0, 16).replace('T', ' ') : undefined
    const windowNote = windowStart ? `窗口内（${windowStart} 起）` : ''
    const revivedNote = revived.length
      ? `；${revived.length} 类模块缺失聚类已复查为「文件现已存在」，不计入判定（${revived.map((c) => c.kind).join('、')}）`
      : ''
    if (clusters.length === 0) {
      // 窗口外有错误不代表现在坏了，但必须说出来：否则用户会以为「日志里什么都没有」
      const note = outside.length ? `；另有 ${outside.length} 类窗口外的历史错误（多为重启/升级前遗留）` : ''
      return pass(this.id, this.category, `最近一次扫描没发现错误${note}${revivedNote}`, {
        title: this.title,
        evidence: revived.map((c) => `已自愈：${c.kind} ×${c.count}（文件中已存在，忽略）`),
        data: { revived: revived.map((c) => c.kind) },
      })
    }
    const errors = clusters.filter((c) => c.severity === 'error')
    const total = clusters.reduce((sum, c) => sum + (c.count ?? 1), 0)
    const top = clusters.slice(0, 5).map((c) => `${c.kind} ×${c.count}：${c.sample}`)
    const base = `${windowNote}识别到 ${clusters.length} 类错误，共 ${total} 次`
    if (errors.length === 0) {
      return unknown(this.id, this.category, `${base}（只有低级别样本，判据待补）${revivedNote}`, {
        title: this.title,
        evidence: top,
        data: { clusters: clusters.slice(0, 10) },
      })
    }
    return issue(this.id, this.category, 'error', `${base}，其中 ${errors.length} 类是 error${revivedNote}`, {
      title: this.title,
      evidence: [...top, outside.length ? `窗口外另有 ${outside.length} 类历史错误（不计入本次判定）` : ''].filter(Boolean),
      possibleCauses: ['插件或依赖安装不完整', '网络/DNS 不通导致请求失败', '宿主进程重启或升级后遗留的旧错误'],
      recommendations: [
        '先看最新一次出现的时间：很久以前的错误通常已随重启消失',
        '把 sample 和规则编号一起贴给插件作者，比贴整份日志更有效',
      ],
      confidence: 0.7,
      data: { clusters: clusters.slice(0, 10) },
    })
  },
})

const hostCrash = R({
  id: 'DSH-LOG-003',
  category: 'logs',
  severity: 'warning',
  title: '宿主崩溃快照',
  evaluate(facts) {
    const logs = facts.logs
    if (!logs) return undefined
    const crashSources = (logs.sources ?? []).filter((s) => s.kind === 'crash')
    // 崩溃证据经常落在窗口外（崩溃后重启，重启就是几小时前的事），所以两个桶都看。
    // kind 是 host-exit / web-boot-inactive（日志分析层的 LINE_RULES），不是 'crash'。
    const CRASH_KINDS = new Set(['host-exit', 'web-boot-inactive'])
    const all = [...(logs.clusters ?? []), ...(logs.clustersOutsideWindow ?? [])]
    const crashClusters = all.filter(
      (c) => CRASH_KINDS.has(c.kind) || (c.sourceIds ?? []).some((id) => String(id).startsWith('crash:')),
    )
    if (crashSources.length === 0 && crashClusters.length === 0) {
      return pass(this.id, this.category, '没有崩溃快照（Host 侧本来就不写持续日志）', { title: this.title })
    }
    const inWindow = (logs.clusters ?? []).filter((c) => CRASH_KINDS.has(c.kind)).length > 0
    const summary = crashClusters.length
      ? `宿主崩溃记录：${crashClusters[0].kind} ×${crashClusters[0].count}${inWindow ? '（窗口内）' : '（窗口外）'}`
      : `存在 ${crashSources.length} 份崩溃快照，但没解析出错误行`
    // 窗口外的崩溃是「历史上崩过，重启后恢复了」，不是「现在正在崩」。报成 issue 会让
    // 推理层产出「宿主反复崩溃」这种吓人的根因（实测就是这么来的）。所以降级成 pass + 明确时间。
    if (!inWindow) {
      return pass(this.id, this.category, `${summary}；崩溃发生在 24h 窗口外，重启后未见复发`, {
        title: this.title,
        evidence: [
          ...crashSources.slice(0, 3).map((s) => `${s.path}（${humanBytes(s.size ?? 0)}）`),
          ...crashClusters.slice(0, 2).map((c) => `${c.kind} ×${c.count}：${c.sample}`),
        ],
        data: { historical: true, crashSources: crashSources.length },
      })
    }
    return issue(this.id, this.category, 'warning', summary, {
      title: this.title,
      evidence: [
        ...crashSources.slice(0, 3).map((s) => `${s.path}（${humanBytes(s.size ?? 0)}）`),
        ...crashClusters.slice(0, 2).map((c) => `${c.kind} ×${c.count}：${c.sample}`),
      ],
      possibleCauses: ['宿主进程被系统或用户结束', '升级/安装时重启', '内存不足被 OOM 杀掉'],
      recommendations: [
        inWindow ? '刚刚发生过崩溃：先看是否在安装/升级之后' : '崩溃发生在窗口外，通常重启后就恢复了',
        '短时间内反复出现时，带上时间和这份路径反馈',
      ],
      confidence: 0.5,
    })
  },
})

const logLeaks = R({
  id: 'DSH-SEC-003',
  category: 'security',
  severity: 'error',
  title: '日志里的明文密钥',
  evaluate(facts) {
    const logs = facts.logs
    if (!logs) return undefined
    const leaks = logs.leaks ?? { total: 0, byType: {} }
    if (!leaks.total) {
      return pass(this.id, this.category, '没在日志里扫到密钥样式的内容', { title: this.title })
    }
    // byType 是「出现次数」，uniqueByType 是「每类有几个不同的值」——两者不能混在一句里，
    // 否则「51 处 / 去重 12 个（bearer×10 · other×41）」自相矛盾。标题用去重值，证据分开写。
    const uniqueByType = Object.entries(leaks.uniqueByType ?? {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}×${n}`)
      .join(' · ')
    const byType = Object.entries(leaks.byType ?? {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}×${n}`)
      .join(' · ')
    // 「出现 86 次」和「泄漏了 3 把 key」是两件事：同一把 key 会同时出现在用户消息、
    // 模型推理、工具结果和事件流里。先说清有几个不同的值，再给出现次数。
    const uniqueText = Number.isFinite(leaks.unique) ? `，去重后 ${leaks.unique} 个不同值` : ''
    const detail = uniqueByType || byType
    // 命中位置必须来自采集结果（leaks.bySource），不能写死一句「在会话日志里」——那是没有证据的断言
    const where = (leaks.bySource ?? [])
      .slice(0, 3)
      .map((s) => `${s.path}（${s.kind}，×${s.total}）`)
    return issue(this.id, this.category, 'error', `日志里出现 ${leaks.total} 处疑似密钥${uniqueText}${detail ? `（去重：${detail}）` : ''}`, {
      title: this.title,
      // 证据只给类型和计数，绝不放命中的原文 —— 诊断报告本身不能变成泄露渠道。
      evidence: [
        `去重后的值：${detail || '—'}`,
        `出现次数：${byType || '—'}`,
        ...where.map((w) => `命中位置：${w}`),
        '报告与面板均不显示命中内容',
      ],
      possibleCauses: ['对话或工具输出里直接贴过密钥，会话日志原样留存', '插件把请求头/环境变量打进了日志', '报错时把完整请求体 dump 出来'],
      recommendations: [
        '把命中的密钥当作已泄露处理：立即轮换，并检查该密钥的使用记录',
        '需要贴日志给人看时，先只贴 sample，不要贴整段会话',
        '把命中的日志路径反馈给对应插件作者',
        '清理：scripts/purge-secrets.mjs 先 dry-run 看计划，再 --apply --yes 执行（自动备份，可 --rollback）',
        '活动会话（10 分钟内写过）不会被清理，关掉对应会话后再跑一次',
      ],
      confidence: 0.8,
    })
  },
})

/* ------------------------------ 模型与网络连接 ------------------------------ */

/**
 * 这些分类表示「服务是活的，只是我们没带凭据 / 没权限」。
 * 探测请求刻意不带任何 Authorization（见 connectivity.js），所以 401/403 是**预期结果**，
 * 不能当成故障 —— 这是整个连接检测里最容易写错、也最容易误报的一点。
 */
const REACHABLE_HTTP_CODES = new Set(['ok', 'auth', 'forbidden'])
/** 网络层根本没通：这些必然算问题。 */
const BLOCKING_CODES = new Set(['timeout', 'dns', 'tls', 'refused', 'reset', 'proxy', 'abort', 'unknown'])
/** 网络通了但服务侧有状况：严重度降一级。 */
const SERVICE_CODES = new Set(['rate-limit', 'quota', 'server', 'client', 'not-found'])

const CODE_LABELS = {
  ok: '正常',
  auth: '未授权（探测不带凭据，属预期）',
  forbidden: '被拒绝访问',
  'rate-limit': '限流',
  quota: '配额/余额',
  server: '服务端错误',
  client: '请求被拒',
  'not-found': '路径不存在',
  unknown: '无法判定',
}

function describeProbeSteps(result) {
  const probes = result.probes ?? {}
  const steps = []
  if (probes.dns) steps.push(`DNS ${probes.dns.status === 'ok' ? `✅ ${(probes.dns.addresses ?? []).length} 个地址` : probes.dns.status === 'skip' ? '⏭ 跳过' : '❌ 失败'}`)
  if (probes.tcp) steps.push(`TCP ${probes.tcp.connected ? `✅:${probes.tcp.port}` : '❌ 未连通'}`)
  if (probes.tls) {
    steps.push(
      probes.tls.status === 'skip'
        ? 'TLS ⏭ 跳过'
        : probes.tls.authorized
          ? `TLS ✅ ${probes.tls.daysLeft ?? '?'} 天后到期`
          : `TLS ❌ ${probes.tls.error ?? '证书校验未通过'}`,
    )
  }
  if (probes.http) {
    const code = probes.http.classification?.code ?? 'unknown'
    steps.push(`HTTP ${probes.http.httpStatus ?? '—'} ${code === 'ok' ? '✅' : '⚠️'} ${CODE_LABELS[code] ?? probes.http.classification?.label ?? code}`)
  }
  return steps
}

/** 一个目标算不算「可达」：HTTP 给了 2xx/401/403，或者 TCP 通了但没做 HTTP。 */
function verdictOf(result, targetsById) {
  // `local` 优先取 result 上的字段；取不到时回落到 targets[]——合成 facts（回归集、
  // 单测）常常只写 targets 不写 result，而判定必须只依赖一个来源。
  const local = typeof result.local === 'boolean' ? result.local : targetsById?.get(result.targetId)?.local === true
  const http = result.probes?.http
  const code = http?.classification?.code
  if (code && REACHABLE_HTTP_CODES.has(code)) return 'reachable'
  if (code && SERVICE_CODES.has(code)) return 'service'
  if (code) return local ? 'local' : 'blocked'
  const tcp = result.probes?.tcp
  if (tcp?.connected) return 'reachable'
  if (tcp && tcp.status === 'fail') {
    // 本机端口没在听，多数是可选组件（本地 embedding / 本地模型）没启动。
    // 这不该算「接入点坏了」——否则每个装了本地 provider 却没用的人都会看到一条红叉。
    // 单独由 DSH-NET-004 以 info 级别提示。
    return local ? 'local' : 'blocked'
  }
  return 'unknown'
}

const connectivityTargets = R({
  id: 'DSH-NET-005',
  category: 'connectivity',
  severity: 'warning',
  title: '模型接入点',
  evaluate(facts) {
    const conn = facts.connectivity
    if (!conn || conn.available === false) {
      return unknown(this.id, this.category, `连接检测模块不可用：${conn?.reason ?? '未采集到连接事实'}`, {
        title: this.title,
        evidence: [String(conn?.reason ?? 'facts.connectivity 缺失')],
        data: { ruleId: this.id },
      })
    }
    const targets = conn.targets ?? []
    if (!targets.length) {
      return unknown(this.id, this.category, 'profile 里没有发现模型接入点（provider + baseURL）', {
        title: this.title,
        evidence: [
          '扫描器只认 cordis.patch.yml 里的 provider 与 baseURL/endpoint 字段',
          '如果你的模型配置在别处（自定义插件/环境变量），这一项会一直显示「无法判定」',
        ],
        recommendations: ['确认模型接入确实写在本 profile 的 cordis.patch.yml 里'],
        data: { ruleId: this.id },
      })
    }
    const origins = []
    for (const target of targets) {
      let origin = target.endpoint
      try {
        origin = new URL(target.endpoint).origin
      } catch {
        /* 保留原文 */
      }
      const nativeNote =
        /^deepseek/.test(String(target.provider ?? '')) && !target.local
          ? '；DeepSeek 原生 baseURL 是 /anthropic 后缀，这里只验主机可达'
          : ''
      origins.push(`${target.provider} → ${origin}（${target.source ?? '配置'}${target.local ? '，本机' : ''}${nativeNote}）`)
    }
    const evidence = origins.slice(0, 6)
    if (origins.length > 6) evidence.push(`另有 ${origins.length - 6} 个未列出`)
    if ((conn.missingBaseUrl ?? []).length) evidence.push(`没有地址、只能靠内置默认值判断的 provider：${conn.missingBaseUrl.join(' · ')}`)
    return pass(this.id, this.category, `发现 ${targets.length} 个接入点`, {
      title: this.title,
      evidence,
      data: { ruleId: this.id, targetCount: targets.length },
    })
  },
})

const connectivityReachability = R({
  id: 'DSH-NET-002',
  category: 'connectivity',
  severity: 'error',
  title: '接入点可达性',
  evaluate(facts) {
    const conn = facts.connectivity
    if (!conn || conn.available === false) return undefined
    if (!conn.enabled) {
      return unknown(this.id, this.category, `未执行网络探测${conn.reason ? `（${conn.reason}）` : ''}`, {
        title: this.title,
        evidence: ['探测是可选的：默认只在面板/工具显式打开时联网'],
        data: { ruleId: this.id },
      })
    }
    const results = conn.results ?? []
    if (!results.length) {
      return unknown(this.id, this.category, '没有探测到任何接入点', {
        title: this.title,
        evidence: (conn.errors ?? []).map((e) => `${e.targetId}/${e.step}: ${e.error}`),
        data: { ruleId: this.id },
      })
    }
    const buckets = { reachable: [], service: [], blocked: [], local: [], unknown: [] }
    const targetsById = new Map((conn.targets ?? []).map((t) => [t.id, t]))
    for (const result of results) buckets[verdictOf(result, targetsById)].push(result)
    // 本地端点是可选组件，不参与「接入点连不上」的分母；否则一条「没用 Ollama」就能把全局分拉下来
    const total = results.length - buckets.local.length
    if (!total) {
      return unknown(this.id, this.category, '只发现本地端点，没有需要联网的接入点', {
        title: this.title,
        evidence: results.map((r) => describeProbeSteps(r).join(' · ')),
        data: { ruleId: this.id },
      })
    }
    const labelOf = (result) => {
      const target = (conn.targets ?? []).find((t) => t.id === result.targetId)
      return target?.label ?? result.targetId
    }
    const detailOf = (result) => {
      const code = result.probes?.http?.classification?.code
      const bits = describeProbeSteps(result).join(' · ')
      const cls = result.probes?.http?.classification
      if (code && cls && !REACHABLE_HTTP_CODES.has(code)) {
        return `${labelOf(result)}：${bits}｜最可能原因：${(cls.likelyCauses ?? []).slice(0, 2).join('；') || '—'}`
      }
      return `${labelOf(result)}：${bits}`
    }
    if (buckets.blocked.length) {
      // 全挂 = 本机网络整体不通（error）；只有部分挂 = 个别域名被墙/写错（warning），
      // 把后者判成 error 会让「境外 API 被墙」这种常态把整个体检刷红。
      const severity = buckets.blocked.length === total ? 'error' : 'warning'
      return issue(this.id, this.category, severity, `${buckets.blocked.length}/${total} 个接入点连不上`, {
        title: this.title,
        evidence: buckets.blocked.map(detailOf),
        possibleCauses: [
          '本机网络不通 / DNS 解析失败 / 需要代理',
          '目标地址写错或服务已下线',
          '防火墙或企业网络拦截了该域名',
        ],
        recommendations: [
          '先用 scripts/connectivity-probe.mjs 单独看四步（DNS/TCP/TLS/HTTP）卡在哪一步',
          '在国内网络访问境外 API 通常需要代理；确认代理放行该域名后再体检',
          '本地端点请确认对应服务已启动',
        ],
        confidence: 0.75,
        data: { ruleId: this.id, blocked: buckets.blocked.length },
      })
    }
    if (buckets.service.length) {
      return issue(this.id, this.category, 'warning', `${buckets.service.length}/${total} 个接入点有服务侧状况`, {
        title: this.title,
        evidence: buckets.service.map(detailOf),
        possibleCauses: ['密钥无效或已被吊销（401/403）', '触发限流或配额用尽（429/402）', '对端服务故障（5xx）'],
        recommendations: [
          '401/403 先核对配置里的密钥是否与目标端点匹配（本条探测本身不带凭据）',
          '429 等待 Retry-After 后再试；402/配额提示检查余额与套餐',
          '5xx 与本地配置无关，隔一段时间重试',
        ],
        confidence: 0.7,
        data: { ruleId: this.id, service: buckets.service.length },
      })
    }
    if (buckets.reachable.length === total) {
      const unauth = buckets.reachable.filter((r) => ['auth', 'forbidden'].includes(r.probes?.http?.classification?.code)).length
      return pass(
        this.id,
        this.category,
        `${total} 个接入点网络可达${unauth ? `（其中 ${unauth} 个未授权，属预期：探测不带凭据）` : ''}`,
        {
          title: this.title,
          evidence: buckets.reachable.map(detailOf),
          data: { ruleId: this.id, reachable: total },
        },
      )
    }
    return unknown(this.id, this.category, '接入点可达性无法判定', {
      title: this.title,
      evidence: results.map(detailOf),
      data: { ruleId: this.id },
    })
  },
})

const proxySetting = R({
  id: 'DSH-NET-003',
  category: 'connectivity',
  severity: 'info',
  title: '代理设置',
  evaluate(facts) {
    const conn = facts.connectivity
    if (!conn || conn.available === false || !conn.proxy) return undefined
    const proxy = conn.proxy
    if (!proxy.detected) {
      return pass(this.id, this.category, '未检测到代理环境变量', {
        title: this.title,
        evidence: ['HTTP(S)_PROXY / ALL_PROXY / NO_PROXY 均未设置'],
        data: { ruleId: this.id },
      })
    }
    return pass(this.id, this.category, '检测到代理环境变量', {
      title: this.title,
      evidence: [
        proxy.httpsProxy ? `HTTPS_PROXY=${proxy.httpsProxy}` : '',
        proxy.httpProxy ? `HTTP_PROXY=${proxy.httpProxy}` : '',
        proxy.noProxy ? `NO_PROXY=${proxy.noProxy}` : 'NO_PROXY 未设置',
        '探测请求是否真的走代理，取决于运行时 fetch 实现；本插件不修改任何代理设置',
      ].filter(Boolean),
      recommendations: ['模型请求超时时，先确认代理放行目标域名', '本地端点（localhost/127.0.0.1）应加入 NO_PROXY，否则可能被代理拦掉'],
      data: { ruleId: this.id },
    })
  },
})

const localEndpoint = R({
  id: 'DSH-NET-004',
  category: 'connectivity',
  severity: 'info',
  title: '本地模型端点',
  evaluate(facts) {
    const conn = facts.connectivity
    if (!conn || conn.available === false || !conn.enabled) return undefined
    const locals = (conn.results ?? []).filter((result) => {
      const target = (conn.targets ?? []).find((t) => t.id === result.targetId)
      return target?.local
    })
    if (!locals.length) return undefined
    const targetOf = (result) => (conn.targets ?? []).find((t) => t.id === result.targetId)
    // 配置里写着 enabled: false 的本地端点不会被探测（探了也只是给用户添堵），单独统计
    const disabled = locals.filter((result) => targetOf(result)?.disabled)
    const probed = locals.filter((result) => !targetOf(result)?.disabled)
    const down = probed.filter((result) => result.probes?.tcp && !result.probes.tcp.connected)
    const evidence = locals.map((result) => {
      const target = targetOf(result)
      let port = result.probes?.tcp?.port
      if (!port) {
        try {
          port = new URL(target.endpoint).port
        } catch {
          port = ''
        }
      }
      const state = target?.disabled
        ? '⏭ 配置里 enabled: false，未探测'
        : result.probes?.tcp
          ? result.probes.tcp.connected
            ? '✅ 端口在听'
            : '❌ 端口未监听'
          : '⏭ 未探测'
      return `${target?.label ?? result.targetId} ${target?.endpoint ?? ''} · ${state}${port ? `（:${port}）` : ''}`
    })
    if (down.length) {
      return issue(this.id, this.category, 'info', `${down.length} 个本地端点没有在监听`, {
        title: this.title,
        evidence,
        possibleCauses: ['对应本地服务（如 Ollama）没有启动', '端口被改过，配置里还是旧端口', '服务启动失败，可看日志聚类结果'],
        recommendations: ['不用本地模型可以忽略；要用就先启动对应服务再体检'],
        confidence: 0.6,
        data: { ruleId: this.id },
      })
    }
    return pass(
      this.id,
      this.category,
      disabled.length
        ? `本地端点${probed.length ? '端口可达' : '未启用（配置里 enabled: false），没有探测'}`
        : '本地端点端口可达',
      { title: this.title, evidence, data: { ruleId: this.id } },
    )
  },
})

/* --------------------------- 安装通道（lib/installer.js） --------------------------- */
/*
 * 为什么是「按安装器目录生成规则」而不是手写：
 * 安装期故障的判据（lockfile 漂移、file: 依赖目录被删、BOM、发布年龄策略）已经在
 * `lib/installer.js` 里实现过一次，并且带着自己的样本测试。这里只是把它的 findings
 * 转成报告里的一行 —— 判据只有一份，报告与「安装恢复入口」不会各说各话。
 *
 * 编号沿用安装器的 DSH-INST-xxx（同一个 id 空间，报告里能直接对上 install-doctor.mjs 的输出）。
 *
 * 刻意**不生成**的条目（避免同一件事报两遍、扣两次分）：
 *   INST-002 lockfile 与 manifest 不一致 → 已由 DSH-PLG-004 负责
 *   INST-008 已装插件未声明兼容区间    → 已由 DSH-PLG-003 负责
 *   INST-009 manifest 不可解析          → 已由 DSH-CFG-001 负责
 *   INST-011 profile 目录不存在        → 已由 DSH-CFG-001 负责
 */
const INSTALLER_RULE_IDS = new Set(['DSH-INST-001', 'DSH-INST-003', 'DSH-INST-004', 'DSH-INST-005', 'DSH-INST-006', 'DSH-INST-007', 'DSH-INST-010'])
const INSTALLER_SEVERITY = { fail: 'error', warn: 'warning', info: 'info' }

const installerRules = (FINDING_CATALOG ?? [])
  .filter((entry) => INSTALLER_RULE_IDS.has(entry.id))
  .map((entry) =>
    R({
      id: entry.id,
      category: 'plugins',
      severity: INSTALLER_SEVERITY[entry.severity] ?? 'warning',
      title: entry.meaning,
      evaluate(facts) {
        const installer = facts?.installer
        // 没有安装器事实：说明模块缺失或采集抛错。明确说「没测」，不当通过。
        if (!installer) return undefined
        if (installer.available === false) {
          return unknown(this.id, this.category, `安装探针未运行：${installer.reason ?? '未知原因'}`, {
            title: this.title,
            evidence: [String(installer.reason ?? '')].filter(Boolean),
          })
        }
        const finding = (installer.findings ?? []).find((item) => item.id === this.id)
        if (!finding) {
          return pass(this.id, this.category, `${entry.meaning}：未命中`, { title: this.title, evidence: ['安装器未报这条'] })
        }
        const severity = INSTALLER_SEVERITY[finding.severity] ?? 'warning'
        const evidence = [finding.evidence].flat().filter((item) => typeof item === 'string' && item)
        if (severity === 'info') {
          return pass(this.id, this.category, finding.zh ?? entry.meaning, { title: this.title, evidence })
        }
        return issue(this.id, this.category, severity, finding.zh ?? entry.meaning, {
          title: this.title,
          evidence,
          possibleCauses: [],
          recommendations: (finding.nextSteps ?? []).filter((item) => typeof item === 'string'),
          confidence: 0.9,
        })
      },
    }),
  )

/** 规则表（顺序即报告里的展示顺序，组内按类别）。 */
export const RULES = [
  nodeVersion,
  installRoot,
  hostPackages,
  dshEnv,
  hostLoad,
  runMode,
  profileDir,
  patchFile,
  patchRows,
  profilePackage,
  manifestBom,
  pluginCount,
  bundlePatch,
  compatibility,
  compatibilityUndeclared,
  lockDrift,
  ...installerRules,
  webPort,
  homeDir,
  dataDirs,
  sessions,
  cwd,
  cwdWritable,
  tempWritable,
  keyAvailable,
  keySources,
  logSources,
  logClusters,
  hostCrash,
  logLeaks,
  connectivityTargets,
  connectivityReachability,
  proxySetting,
  localEndpoint,
]

export const RULE_INDEX = new Map(RULES.map((rule) => [rule.id, rule]))

/**
 * 跑规则。单条规则抛异常不会终止整场体检：转成一条 unknown 结果，把错误文本作为证据。
 * 这符合「一条坏规则不该让整个诊断失去意义」的工程底线。
 *
 * 规则返回 undefined（不适用 / 没采集到）时补一条显式 unknown：报告里必须能看出
 * 「这条没测」，而不是悄悄少一行 —— 否则读者会以为 21 条都跑过了。
 */
export function runRules(facts, { categories } = {}) {
  const only = categories ? new Set(categories) : undefined
  const results = []
  for (const rule of RULES) {
    if (only && !only.has(rule.category)) continue
    try {
      const result = rule.evaluate(facts)
      if (result) {
        results.push(result)
        continue
      }
      results.push(
        unknown(rule.id, rule.category, '本次没有可判定的信息（不适用或未采集到）', {
          title: rule.title,
          data: { ruleId: rule.id, skipped: true },
        }),
      )
    } catch (error) {
      results.push(
        unknown(`${rule.id}-ERROR`, rule.category, `规则执行异常：${rule.title}`, {
          title: rule.title,
          evidence: [String(error?.message ?? error)],
          data: { ruleId: rule.id },
        }),
      )
    }
  }
  return results
}

export const RULE_CATALOG = RULES.map((rule) => ({
  id: rule.id,
  category: rule.category,
  severity: rule.severity,
  title: rule.title,
}))

export { CATEGORY_LABELS }
export default { RULES, RULE_INDEX, RULE_CATALOG, runRules }
