__ModuleLoader__.load({
  id: 'dsh-doctor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NAME = 'dsh-doctor'
    const REPORT_ID = 'dsh-doctor-report'
    // @generated from lib/panel-data.js; run scripts/sync-panel-path.mjs (do not edit the next line).
    const PANEL_DATA_PATH = '/api/dsh-doctor/panel'
    // Must match lib/repair-panel.js; covered by repair integration tests.
    const REPAIR_PANEL_PATH = '/api/dsh-doctor/repair'
    const inject = ['slots']
    const FRONTEND_OBSERVATION_PATH = '/api/dsh-doctor/frontend'
    const FRONTEND_REPORT_PATH = '/api/dsh-doctor/frontend/report'
    let frontendReporter

    // Only closed stage codes leave this browser. Never serialize errors or Slot objects.
    function createFrontendReporter(ctx, { send = (...args) => fetch(...args), delay = 120 } = {}) {
      let stopped = false, timer, running, bootstrap, dirty = false, needBootstrap = true
      let sequence = 0, last = '', mounted = 0, registered = 0, selection = 'unknown'
      const errors = new Map(), cleanups = [], controllers = new Set()
      const clientId = globalThis.crypto?.randomUUID?.() || 'doctor_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
      const get = (name) => { try { return ctx.get?.(name) } catch { return undefined } }
      const modules = get('modules'), slots = get('slots') || ctx.slots
      const localRows = () => Array.isArray(modules?.manifest?.modules) ? modules.manifest.modules : []
      function registrationIds() {
        const ids = new Set()
        if (registered > 0) ids.add(NAME)
        if (typeof slots?.snapshot !== 'function') return ids
        try {
          const roots = slots.snapshot()
          const pending = Array.isArray(roots) ? roots.slice(0, 2048) : []
          let visited = 0, occupants = 0
          while (pending.length && visited++ < 2048) {
            const node = pending.pop()
            if (node?.type === 'factory' && typeof node.registrant === 'string') ids.add(node.registrant)
            for (const occupant of Array.isArray(node?.occupants) ? node.occupants : []) {
              if (++occupants > 8192) break
              if (typeof occupant?.registrant === 'string') ids.add(occupant.registrant)
            }
            if (occupants > 8192) break
            if (Array.isArray(node?.children)) pending.push(...node.children.slice(0, Math.max(0, 2048 - visited - pending.length)))
          }
        } catch { /* Missing public registry capability stays unknown. */ }
        return ids
      }
      function collect() {
        const allowed = new Map((bootstrap?.modules || []).map((row) => [row.id, row.rev]))
        const registrations = registrationIds(), rows = [], seen = new Set()
        let state
        try { state = modules?.entries?.state?.getSnapshot?.() } catch { /* optional SDK */ }
        const failures = new Set((Array.isArray(state?.failures) ? state.failures : []).map((failure) => failure?.id))
        for (const local of localRows()) {
          if (!local || !allowed.has(local.id) || allowed.get(local.id) !== local.rev || seen.has(local.id)) continue
          seen.add(local.id)
          let failed = failures.has(local.id), ready = false
          try { failed ||= Boolean(modules.importError?.(local.id)); ready = modules.loadCache?.has?.(local.id) === true } catch { /* optional SDK */ }
          const entry = failed ? 'failed' : ready ? 'ready' : state?.syncing === true ? 'pending' : 'unknown'
          const renderFailed = errors.get(local.id) === local.rev
          const registration = registrations.has(local.id) ? 'registered' : 'unknown'
          const own = local.id === NAME
          const mount = !own ? 'unknown' : failed ? 'unknown' : renderFailed ? 'failed'
            : mounted > 0 && registration === 'registered' && ready ? 'mounted'
              : selection === 'not-selected' ? 'not-opened' : 'unknown'
          rows.push({ id: local.id, rev: local.rev, entry, registration, mount,
            selection: own ? selection : 'unknown', error: failed ? 'module-load-or-entry' : renderFailed ? 'render' : 'none' })
          if (rows.length >= 64) break
        }
        rows.sort((a, b) => Number(b.id === NAME) - Number(a.id === NAME))
        return rows
      }
      async function request(method, body) {
        const controller = new AbortController()
        controllers.add(controller)
        const timeout = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await send(method === 'POST' ? FRONTEND_REPORT_PATH : FRONTEND_OBSERVATION_PATH, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'x-dsh-doctor-ui': '1' } : {}) },
            ...(body === undefined ? {} : { body }) })
          const value = method === 'GET' && response.ok ? await response.json() : undefined
          if (method !== 'GET' || !response.ok) await response.body?.cancel()
          return { ok: response.ok, status: response.status, value }
        } finally { clearTimeout(timeout); controllers.delete(controller) }
      }
      async function drain() {
        try {
          while (dirty && !stopped) {
            dirty = false
            if (needBootstrap) {
              needBootstrap = false
              const response = await request('GET')
              if (stopped || !response.ok) { bootstrap = undefined; return }
              const value = response.value
              if (stopped) return
              if (typeof value?.epoch !== 'string' || value.epoch.length > 80 || !Array.isArray(value.modules) || value.modules.length > 64) return
              bootstrap = value
              last = ''
            }
            if (!bootstrap || stopped) return
            const rows = collect()
            const fingerprint = JSON.stringify(rows)
            if (fingerprint === last) continue
            const value = { epoch: bootstrap.epoch, clientId, sequence: ++sequence, modules: rows,
              capabilities: { modules: typeof modules?.entries?.state?.getSnapshot === 'function' && typeof modules?.importError === 'function' && typeof modules?.loadCache?.has === 'function', registration: typeof slots?.snapshot === 'function', renderErrors: typeof slots?.onEntryError === 'function' } }
            let body = JSON.stringify(value)
            while (new TextEncoder().encode(body).length > 16384 && value.modules.length) { value.modules.pop(); body = JSON.stringify(value) }
            const response = await request('POST', body)
            if (stopped) return
            if (!response.ok) { bootstrap = undefined; return }
            last = fingerprint
          }
        } catch { /* Fixed UI hints live on Host; exception text stays inside the browser. */ }
      }
      function flush({ rebootstrap = false } = {}) {
        if (stopped) return Promise.resolve()
        if (timer) { clearTimeout(timer); timer = undefined }
        dirty = true
        if (rebootstrap) { needBootstrap = true; last = '' }
        if (!running) running = drain().finally(() => { running = undefined })
        return running
      }
      function schedule() {
        if (stopped) return
        dirty = true
        if (!timer) timer = setTimeout(() => { timer = undefined; void flush() }, delay)
      }
      const own = {
        registration(value) { registered = Math.max(0, registered + (value ? 1 : -1)); schedule() },
        mount(value) { mounted = Math.max(0, mounted + (value ? 1 : -1)); if (value) errors.delete(NAME); schedule() },
        select(value) { selection = value === true ? 'selected' : value === false ? 'not-selected' : 'unknown'; schedule() },
      }
      const keep = (fn) => { if (typeof fn === 'function') cleanups.push(fn) }
      try { keep(modules?.entries?.state?.subscribe?.(schedule)) } catch { /* optional SDK */ }
      try { keep(ctx.on?.('slots/changed', schedule)) } catch { /* optional event */ }
      try { keep(ctx.on?.('connection/reset', () => { needBootstrap = true; schedule() })) } catch { /* optional event */ }
      try {
        keep(slots?.onEntryError?.((_key, registration) => {
          const id = registration?.registrant
          const row = localRows().find((item) => item.id === id)
          if (row && (errors.has(id) || errors.size < 64)) { errors.set(id, row.rev); schedule() }
        }))
      } catch { /* optional SDK */ }
      schedule()
      return { ...own, flush, collect,
        dispose() { stopped = true; clearTimeout(timer); for (const controller of controllers) controller.abort(); controllers.clear(); for (const close of cleanups.splice(0).reverse()) { try { close() } catch { /* One stale SDK disposer must not retain the other subscriptions. */ } } errors.clear() },
      }
    }

    const STATUS_LABEL = { ok: '正常', info: '普通信息', warn: '提醒', fail: '故障', unknown: '待核对', skip: '未检查' }
    const TAB_ORDER = ['overview', 'environment', 'plugins', 'issues', 'logs']
    const TAB_LABEL = { overview: '概览', environment: '环境', plugins: '插件', issues: '问题', logs: '日志' }

    /* --------------------------- 读取 Host 注入的数据 --------------------------- */
    // 主通路是 Connection 认证的同源只读 GET；HTML JSON 仅作 Web 首屏兜底。
    // 桌面静态页面缺少注入时，同样自动加载并保持五个页签可用。
    async function fetchPanelPayload({ force = false, signal } = {}) {
      if (typeof fetch !== 'function') throw new Error('当前页面未提供数据请求能力，请重新打开 Harness 页面。')
      const response = await fetch(PANEL_DATA_PATH + (force ? '?force=1' : ''), {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('页面连接已失效（HTTP ' + response.status + '），请重新连接 Harness 后重试。')
        throw new Error('体检数据请求失败（HTTP ' + response.status + '），请重试。')
      }
      let value
      try { value = await response.json() } catch { throw new Error('体检数据格式错误，请重试。') }
      if (!value || typeof value !== 'object' || !value.report || typeof value.report !== 'object' || Array.isArray(value.report)) {
        throw new Error('Host 尚未返回完整体检数据，请重试。')
      }
      return value
    }

    function readPayload() {
      if (typeof document === 'undefined') return { pending: true }
      const node = document.getElementById(REPORT_ID)
      if (!node) return { pending: true, missing: true }
      try {
        return JSON.parse(node.textContent || '{}')
      } catch (error) {
        return { pending: true, error: String(error && error.message ? error.message : error) }
      }
    }

    /* --------------------------------- 兜底样式 --------------------------------- */
    // 正常路径：Host 注入 lib/panel-css.js 的 PANEL_CSS（payload.styles）。
    // 注入缺失时用这份最小样式，保证面板不是一坨裸 HTML —— 宁可丑，不能读不出结构。
    const FALLBACK_CSS =
      '.dd-root{box-sizing:border-box;height:100%;max-height:100%;min-height:0;min-width:0;max-width:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain;font-size:12px;line-height:1.55;color:inherit}' +
      '.dd-content{padding:10px 14px 20px}.dd-root summary{cursor:pointer}' +
      '.dd-head{display:flex;flex-direction:column;gap:6px;padding:12px 14px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}' +
      '.dd-title{font-size:15px;font-weight:600;margin:0}' +
      '.dd-tabs{display:flex;flex-wrap:wrap;gap:2px}' +
      '.dd-tab{background:transparent;color:inherit;border:0;padding:4px 8px;cursor:pointer;font:inherit;opacity:.7}' +
      '.dd-tab-active{opacity:1;box-shadow:inset 0 -2px 0 currentColor}' +
      '.dd-badge{display:inline-block;margin-left:4px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-variant-numeric:tabular-nums}' +
      '.dd-section{margin:14px 0;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}' +
      '.dd-section-title{font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:.55;margin-bottom:6px}' +
      '.dd-row{display:flex;gap:8px;align-items:baseline;padding:3px 0;min-width:0}' +
      '.dd-label{flex:1;min-width:0;overflow-wrap:anywhere}' +
      '.dd-value{font-variant-numeric:tabular-nums;opacity:.85}' +
      '.dd-hint{font-size:11.5px;opacity:.62;overflow-wrap:anywhere}' +
      '.dd-muted{opacity:.6}' +
      '.dd-item{padding:6px 0;min-width:0}' +
      '.dd-item-head{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}' +
      '.dd-item-title{font-weight:600;overflow-wrap:anywhere}' +
      '.dd-evidence{margin:4px 0 0;padding-left:16px;opacity:.75;overflow-wrap:anywhere}' +
      '.dd-empty{padding:24px 0;text-align:center;opacity:.6}' +
      '.dd-foot{padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);opacity:.55;font-size:11px}' +
      '.dd-btn{font:inherit;padding:3px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;cursor:pointer}' +
      '.dd-chip{display:inline-block;padding:0 6px;border-radius:999px;border:1px solid currentColor;font-size:11px}' +
      '.dd-status-ok{color:var(--dsw-alias-state-success-primary)}.dd-status-warn{color:var(--dsw-alias-state-warn-primary)}.dd-status-fail{color:var(--dsw-alias-state-error-primary)}' +
      '.dd-status-unknown{color:var(--dsw-alias-label-secondary)}.dd-status-skip{color:var(--dsw-alias-state-idle-primary)}' +
      '.dd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;overflow-wrap:anywhere}' +
      '.dd-table{width:100%;border-collapse:collapse}.dd-th,.dd-td{text-align:left;padding:3px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}' +
      '.dd-th{font-size:11px;opacity:.6;font-weight:500}' +
      '.dd-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:14px;min-width:0}.dd-brand{display:flex;align-items:center;gap:12px;flex:1 1 240px;min-width:0}' +
      '.dd-brand-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}' +
      '.dd-heading{min-width:0}.dd-subtitle,.dd-score-label,.dd-stat-label{font-size:12px;color:var(--dsw-alias-label-secondary)}.dd-scorecard{display:flex;align-items:center;gap:12px;padding:8px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}' +
      '.dd-score{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}.dd-meta{min-width:0}.dd-btn-primary{min-height:38px;border-color:var(--dsw-alias-brand-primary)}.dd-btn:disabled{opacity:.5;cursor:not-allowed}' +
      '.dd-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,128px),1fr));gap:10px;margin:16px 0}.dd-stat{display:flex;flex-direction:column;gap:8px;min-width:0;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}' +
      '.dd-stat-value{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums}.dd-notice{padding:12px 16px;margin:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}.dd-row{flex-wrap:wrap}'

    /* --------------------------------- 小工具 --------------------------------- */
    function statusClass(status) {
      return 'dd-status-' + (status === 'info' ? 'unknown' : STATUS_LABEL[status] ? status : 'skip')
    }

    function StatusChip(props) {
      const status = STATUS_LABEL[props.status] ? props.status : 'skip'
      return h('span', { className: 'dd-chip ' + statusClass(status) }, props.text || STATUS_LABEL[status])
    }

    function formatBytes(bytes) {
      const n = Number(bytes) || 0
      if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
      if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
      return n + ' B'
    }

    function formatTime(value) {
      if (!value) return ''
      try {
        return new Date(value).toLocaleString()
      } catch (error) {
        return String(value)
      }
    }

    function num(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback === undefined ? null : fallback
    }

    // 面板只翻两个词：插件的来源（host/profile 是 view-model 的机器取值）与修复风险等级。
    // 其余文案一律由 view-model 给定，面板不另造一套中文名。
    function sourceLabel(source) {
      if (source === 'host') return '宿主提供'
      if (source === 'profile') return 'profile'
      return source || '—'
    }

    function riskLabel(risk) {
      if (risk === 'low') return '低风险'
      if (risk === 'medium') return '中风险'
      if (risk === 'high') return '高风险'
      return '风险未定'
    }

    function Section(props) {
      return h(
        'div',
        { className: 'dd-section' },
        props.title ? h('div', { className: 'dd-section-title' }, props.title) : null,
        props.children,
      )
    }

    function Empty(props) {
      return h(
        'div',
        { className: 'dd-empty' },
        h('div', null, props.title),
        props.hint ? h('div', { className: 'dd-hint' }, props.hint) : null,
      )
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dd-row' },
        h('span', { className: 'dd-label', title: props.title }, props.label),
        props.value === undefined || props.value === null || props.value === ''
          ? null
          : h('span', { className: 'dd-value' }, props.value),
      )
    }

    /* ------------------------------ 兼容旧 payload ------------------------------ */
    // Host 侧 view-model 还没装上（或装了旧版）时，用报告本体就地拼出同一套形状，
    // 保证面板永远有东西可显示。字段名与 view-model 契约一致，缺什么给空。
    function derivePages(report) {
      const summary = report.summary || {}
      const suppliedResults = Array.isArray(report.results) ? report.results.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : []
      const rawChecks = suppliedResults.length ? suppliedResults : (Array.isArray(report.checks) ? report.checks : [])
      const aliases = { pass: 'ok', passed: 'ok', ok: 'ok', warn: 'warn', warning: 'warn', fail: 'fail', failed: 'fail', error: 'fail', info: 'info', unknown: 'unknown', skip: 'skip', skipped: 'skip' }
      const checks = rawChecks.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item) => {
        let status = item.status === 'issue' ? item.severity === 'error' ? 'fail' : 'warn' : aliases[item.status]
        if (item.data && typeof item.data === 'object' && !Array.isArray(item.data) && item.data.informationOnly === true && ['unknown', 'skip'].includes(status) && (!item.severity || item.severity === 'info')) status = 'info'
        if (!['ok', 'info', 'warn', 'fail', 'unknown', 'skip'].includes(status)) status = 'unknown'
        return { ...item, group: item.category || item.group, status, detail: item.summary || item.detail || '' }
      })
      const groups = Array.isArray(report.groups) ? report.groups : []
      const env = report.env || {}
      const counts = {
        ok: num(summary.ok, 0), info: num(summary.info, 0),
        warn: num(summary.warn, 0), fail: num(summary.fail, 0),
        unknown: num(summary.unknown, num(summary.skip, 0)),
        skip: typeof summary.unknown === 'number' ? num(summary.skip, 0) : 0,
        total: num(summary.total, checks.length),
      }
      if (checks.length) {
        Object.keys(counts).forEach((key) => { counts[key] = 0 })
        checks.forEach((item) => { counts[item.status] += 1; counts.total += 1 })
      }
      const labelOf = {}
      groups.forEach((group) => {
        labelOf[group.id] = group.title || group.id
      })
      const issues = checks
        .filter((item) => ['fail', 'warn', 'unknown'].includes(item.status))
        .map((item) => ({
          id: item.id,
          category: item.group,
          label: labelOf[item.group] || item.group || '',
          severity: item.severity || (item.status === 'fail' ? 'error' : 'warning'),
          status: item.status,
          title: item.title || item.id,
          summary: item.detail || '',
          evidence: item.evidence || (item.hint ? [item.hint] : []),
          recommendations: item.recommendations || [],
          checkedAt: item.checkedAt,
        }))
      const byCategory = new Map()
      issues.forEach((issue) => {
        const key = issue.category || 'other'
        if (!byCategory.has(key)) byCategory.set(key, [])
        byCategory.get(key).push(issue)
      })
      const logs = report.logs || null
      return {
        version: report.version || null,
        generatedAt: report.generatedAt || null,
        coverage: report.coverage || null,
        score: num(summary.score, null),
        counts,
        status: counts.fail > 0 ? 'fail' : counts.warn > 0 ? 'warn' : counts.ok > 0 ? 'ok' : 'unknown',
        runtime: {
          dsh: env.dshVersion || null,
          node: env.node || env.nodeVersion || null,
          os: [env.platform, env.arch].filter(Boolean).join('/') || null,
          profile: state_profile(report),
        },
        tabs: [
          { id: 'overview', label: TAB_LABEL.overview, badge: null },
          { id: 'environment', label: TAB_LABEL.environment, badge: null },
          { id: 'plugins', label: TAB_LABEL.plugins, badge: null },
          { id: 'issues', label: TAB_LABEL.issues, badge: issues.length },
          { id: 'logs', label: TAB_LABEL.logs, badge: logs && logs.clusters ? logs.clusters.length : null },
        ],
        pages: {
          overview: {
            headline:
              counts.total + ' 项检查：' + counts.ok + ' 通过 · ' + counts.warn + ' 提醒 · ' + counts.fail + ' 失败',
            facts: [
              { label: 'DSH', value: env.dshVersion || '(未知)' },
              { label: 'Node', value: env.node || env.nodeVersion || '(未知)' },
              { label: '耗时', value: (num(report.durationMs, 0) || 0) + 'ms' },
            ],
            top: issues.slice().sort((a, b) => ['fail', 'warn', 'unknown'].indexOf(a.status) - ['fail', 'warn', 'unknown'].indexOf(b.status)).slice(0, 3),
            groups: groups.map((group) => {
              const items = checks.filter((item) => item.group === group.id)
              const tally = { ok: 0, info: 0, warn: 0, fail: 0, unknown: 0, skip: 0, total: items.length }
              items.forEach((item) => {
                if (tally[item.status] !== undefined) tally[item.status] += 1
              })
              return { id: group.id, label: group.title || group.id, counts: tally, score: null }
            }),
          },
          environment: {
            sections: Array.from(new Set(checks.map((item) => item.group)))
              .filter((key) => ['environment', 'runtime', 'configuration', 'connectivity', 'data', 'security', 'workspace', 'install', 'profile', 'env', 'web'].includes(key))
              .map((key) => ({
                group: key,
                label: labelOf[key] || key,
                rows: checks
                  .filter((item) => item.group === key)
                  .map((item) => ({ label: item.title, value: item.status, status: item.status, hint: item.detail })),
              })),
          },
          plugins: {
            sources: report.bundleSources ? ['本地元数据来源：' + report.bundleSources.status].concat((report.bundleSources.packages || []).map((p) => p.name + '@' + (p.version || '?') + (p.providedBy.length ? ' · providedBy=' + p.providedBy.join(' / ') + '；操作来源 bundle，不单独卸载' : ' · 顶层声明')), (report.bundleSources.unverified || []).slice(0, 32).map((u) => '未核实：' + u.reason), report.bundleSources.limitations || []) : undefined,
            installed: checks
              .filter((item) => item.group === 'plugins')
              .map((item) => ({ name: item.title, version: null, source: null, link: null, status: item.status, note: item.detail })),
            patch: { rows: null, mismatches: [] },
            information: checks.filter((item) => item.group === 'plugins' && item.status === 'info').map((item) => ({ ...item, summary: item.detail })),
            summary: { installed: null, missing: null, disabled: null },
          },
          issues: {
            groups: Array.from(byCategory.entries()).map(([key, items]) => ({
              category: key,
              label: labelOf[key] || key,
              counts: { total: items.length },
              items,
            })),
            total: issues.length,
            truncated: 0,
          },
          logs: {
            available: Boolean(logs),
            sources: logs && Array.isArray(logs.sources) ? logs.sources : [],
            clusters: logs && Array.isArray(logs.clusters) ? logs.clusters.slice(0, 20) : [],
            leaks: (logs && logs.leaks) || { total: 0, unique: 0, byType: [] },
            window: (logs && logs.window) || { hours: null, startedAt: null, outsideCount: null },
          },
        },
        diagnoses: report.diagnoses || [],
        plans: report.plans || [],
        exports: [],
      }
    }

    function state_profile(report) {
      const env = report.env || {}
      if (env.profile) return env.profile
      const parts = String(env.profileDir || '').split(/[\\/]/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : null
    }

    function resolveModel(payload) {
      // Host 侧 view-model 在（lib/view-model.js）时，注入的就是它算好的完整模型；
      // 不在就用报告本体现场拼一份形状一致的（见 derivePages）。
      return (payload && payload.model) || derivePages((payload && payload.report) || {})
    }

    /* --------------------------------- 各页面 --------------------------------- */
    function IssueItem(props) {
      const item = props.item || {}
      const repair = props.repair || {}
      const actions = Array.isArray(repair.actions) ? repair.actions : []
      // 只认 Host 给的 offer：ruleIds 必须点名这条问题，按钮才出现在标题旁。
      const matched = actions.filter((offer) => offer && typeof offer === 'object' && Array.isArray(offer.ruleIds) && offer.ruleIds.includes(item.id))
      // 行内卡与普通问题卡是同一个渲染函数；有 offer 时多出若干按钮，按钮只调 onRepair(offer)。
      const card = (onRepair, disabled) => {
        const evidence = (item.evidence || []).slice(0, 6)
        const advice = (item.recommendations || []).slice(0, 6)
        const fire = typeof onRepair === 'function' ? onRepair : null
        return h('div', { className: 'dd-item' },
          h('div', { className: 'dd-item-head' },
            h(StatusChip, { status: item.status }),
            h('span', { className: 'dd-item-title' }, item.title || item.id),
            item.id ? h('span', { className: 'dd-mono dd-muted' }, item.id) : null,
            matched.map((offer) => h('button', {
              key: 'fix-' + offer.id, type: 'button', className: 'dd-btn',
              disabled: disabled === true || !fire,
              title: String(offer.title || offer.id || ''),
              'aria-label': '修复 ' + (item.title || item.id) + '：' + (offer.title || offer.id),
              onClick: () => { if (fire) void fire(offer) },
            }, matched.length > 1 ? '修复 · ' + (offer.title || offer.id) : '修复'))),
          item.summary ? h('div', { className: 'dd-hint' }, item.summary) : null,
          evidence.length || advice.length ? h('details', null,
            h('summary', { className: 'dd-hint' }, matched.length ? '证据与建议' : '查看建议'),
            evidence.length ? h('ul', { className: 'dd-evidence' },
              evidence.map((line, index) => h('li', { key: 'ev-' + index, className: 'dd-mono' }, String(line)))) : null,
            advice.length ? h('div', { className: 'dd-hint' },
              advice.map((line, index) => h('div', { key: 'ad-' + index }, '↳ ' + String(line)))) : null) : null)
      }
      // 没有匹配 offer 就是纯建议卡：不伪造一键修复。
      if (!matched.length) return card(null, true)
      return h(RepairCenter, { repair: { ...repair, actions: matched }, inline: true, renderIssue: card, onChanged: props.onChanged })
    }

    function DiagnosisCard(props) {
      const item = props.item || {}
      const conf = typeof item.confidence === 'number' ? item.confidence : null
      return h(
        'div',
        { className: 'dd-item' },
        h(
          'div',
          { className: 'dd-item-head' },
          h('span', { className: 'dd-item-title' }, item.title || item.hypothesisId || item.id),
          conf === null ? null : h('span', { className: 'dd-badge' }, '证据评分 ' + conf),
          item.repairHint ? h('span', { className: 'dd-mono dd-muted' }, item.repairHint) : null,
        ),
        item.reason ? h('div', { className: 'dd-hint' }, item.reason) : null,
        item.nextStep ? h('div', { className: 'dd-hint' }, '→ ' + item.nextStep) : null,
      )
    }

    function PlanRow(props) {
      const plan = props.plan || {}
      const preview = plan.previewCommand || '/doctor repair preview ' + (plan.id || '')
      const [copied, setCopied] = useState(false)
      const copy = function () {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(preview).then(() => setCopied(true)).catch(() => setCopied(false))
        }
      }
      return h('div', { className: 'dd-item' },
        h('div', { className: 'dd-row' },
          h('span', { className: 'dd-label' }, plan.title || plan.id),
          h('span', { className: statusClass(plan.risk === 'high' ? 'fail' : plan.risk === 'medium' ? 'warn' : 'skip') }, riskLabel(plan.risk) + ' · ' + (num(plan.changes, 0) || 0) + ' 处改动')),
        h('div', { className: statusClass(plan.executionState === 'blocked' ? 'warn' : plan.executionState === 'executable' ? 'ok' : 'skip') }, plan.executionLabel || '尚未校验'),
        (Array.isArray(plan.blockedReasons) ? plan.blockedReasons : []).filter((reason) => typeof reason === 'string' && reason.trim()).map((reason, index) => h('div', { key: 'reason-' + index, className: 'dd-hint' }, reason)),
        h('div', { className: 'dd-mono dd-hint' }, preview),
        h('button', { type: 'button', className: 'dd-btn', onClick: copy }, copied ? '已复制' : '复制预览指令'),
        h('div', { className: 'dd-hint' }, '这里只复制草案；实际修复请到「问题」页准备并确认。'))
    }

    function OverviewPage(props) {
      const page = props.page || {}
      const counts = props.model.counts || {}
      const tabs = props.model.tabs || []
      const top = (page.top || []).slice(0, 3)
      const issueTab = tabs.find((tab) => tab.id === 'issues')
      const problems = issueTab && typeof issueTab.badge === 'number' ? issueTab.badge : null
      return h(
        'div',
        null,
        page.headline ? h('div', { className: 'dd-hint', style: { marginBottom: 6 } }, page.headline) : null,
        h(
          'div',
          { className: 'dd-stats', 'aria-label': '体检状态统计' },
          ['ok', 'info', 'warn', 'fail', 'unknown', 'skip'].map((key) =>
            h(
              'div',
              { key, className: 'dd-stat' },
              h('span', { className: 'dd-stat-label' }, STATUS_LABEL[key] || key),
              h('strong', { className: 'dd-stat-value ' + statusClass(key) }, num(counts[key], 0) || 0),
            ),
          ),
        ),
        (page.facts || []).length
          ? h('details', { className: 'dd-section' },
              h('summary', { className: 'dd-section-title' }, '运行环境摘要'),
              (page.facts || []).map((fact, index) => h(Row, { key: 'fact-' + index, label: fact.label, value: fact.value })))
          : null,
        top.length
          ? h(
              Section,
              { title: '最需要注意' },
              top.map((item) => h(IssueItem, { key: (item.id || item.title) + ':' + (props.repairRevision || 0), item, repair: props.repair, onChanged: props.onChanged })),
              problems !== null && problems > top.length
                ? h('button', { type: 'button', className: 'dd-btn', onClick: props.onShowIssues }, '查看全部 ' + problems + ' 项问题')
                : null,
            )
          : h(Section, { title: '最需要注意' }, h(Empty, { title: '没有失败或警告项。', hint: '「未知」项表示缺少证据无法判定，不算失败。' })),
        (props.model.diagnoses || []).length
          ? h(
              Section,
              { title: '根因归因（' + props.model.diagnoses.length + '）' },
              (props.model.diagnoses || []).slice(0, 3).map((item) => h(DiagnosisCard, { key: item.id || item.title, item })),
            )
          : null,
        (props.model.plans || []).length
          ? h('details', { className: 'dd-section' },
              h('summary', { className: 'dd-section-title' }, '修复草案（未执行）'),
              (props.model.plans || []).map((plan) => h(PlanRow, { key: plan.id, plan })),
              h('div', { className: 'dd-hint' }, '可执行修复请到「问题」页准备；草案不等于可执行。'),
            )
          : null,
        (page.groups || []).length
          ? h('details', { className: 'dd-section' },
              h('summary', { className: 'dd-section-title' }, '分组概览'),
              h(
                'table',
                { className: 'dd-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { className: 'dd-th' }, '分组'),
                    h('th', { className: 'dd-th' }, '通过'),
                    h('th', { className: 'dd-th' }, '提醒'),
                    h('th', { className: 'dd-th' }, '失败'),
                    h('th', { className: 'dd-th' }, '未知'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  (page.groups || []).map((group) => {
                    const c = group.counts || {}
                    return h(
                      'tr',
                      { key: group.id },
                      h('td', { className: 'dd-td' }, group.label || group.id),
                      h('td', { className: 'dd-td' }, String(num(c.ok, 0))),
                      h('td', { className: 'dd-td' }, String(num(c.warn, 0))),
                      h('td', { className: 'dd-td' }, String(num(c.fail, 0))),
                      h('td', { className: 'dd-td' }, String(num(c.unknown, 0))),
                    )
                  }),
                ),
              ),
            )
          : null,
        h(Section, { title: '检查覆盖（整次扫描）' },
          props.model.coverage ? h('div', { className: 'dd-hint' }, props.model.coverage.source + ' · ' + (props.model.coverage.generatedAt || '时间未记录') + (props.model.coverage.stale ? ' · 过期证据' : '')) : h('div', { className: 'dd-hint' }, '旧快照未记录覆盖，未核实。'),
          ((props.model.coverage || {}).groups || []).map((group) => h('div', { key: group.id, className: 'dd-row' },
            h('span', { className: 'dd-label' }, group.id), h('span', { className: 'dd-value' }, group.state + ' · 执行 ' + group.ran + ' / 跳过 ' + group.skipped + ' / 未知 ' + group.unknown + ' / 采集失败 ' + group.failed + ' · 文件 ' + (group.filesInspected == null ? '未知' : group.filesInspected) + (group.filesInspectedScope ? ' (' + group.filesInspectedScope + ')' : '')),
            (group.reasons || []).length ? h('div', { className: 'dd-hint' }, Array.from(new Set(group.reasons.map((row) => row.reason))).join(' / ')) : null))),
        h(ExportHistory, { data: props.payload.exports }),
      )
    }

    function EnvironmentPage(props) {
      const sections = props.page.sections || []
      if (!sections.length) {
        return h(Empty, {
          title: '这一版报告里没有环境分组数据。',
          hint: '执行 /doctor 重新体检；若仍旧为空，说明 facts 采集被禁用或全部失败。',
        })
      }
      return h(
        'div',
        null,
        sections.map((section) =>
          h(
            Section,
            { key: section.group || section.label, title: section.label || section.group },
            (section.rows || []).map((row, index) =>
              h(
                'div',
                { key: 'row-' + index, className: 'dd-row' },
                h('span', { className: 'dd-label' }, row.label),
                h('span', { className: 'dd-value ' + statusClass(row.status) }, row.value === undefined || row.value === null ? '' : String(row.value)),
                row.hint ? h('span', { className: 'dd-hint' }, String(row.hint)) : null,
              ),
            ),
          ),
        ),
      )
    }

    function PluginsPage(props) {
      const page = props.page || {}
      const installed = page.installed || []
      const summary = page.summary || {}
      const patch = page.patch || {}
      const summaryLine = [
        typeof summary.installed === 'number' ? '已装 ' + summary.installed : null,
        typeof summary.missing === 'number' ? '缺失 ' + summary.missing : null,
        typeof summary.disabled === 'number' ? '停用 ' + summary.disabled : null,
      ]
        .filter(Boolean)
        .join(' · ')
      return h(
        'div',
        null,
        summaryLine ? h('div', { className: 'dd-hint' }, summaryLine) : null,
        h(Section, { title: 'Bundle 来源与只读预检' },
          (page.sources || ['来源未记录；运行 /doctor，或用 dsh_doctor candidateDir / /doctor preflight <本地包目录> 只读预检。']).map((line, index) => h('div', { key: index, className: 'dd-hint' }, line)),
          h('div', { className: 'dd-hint' }, '本地候选：dsh_doctor candidateDir 或 /doctor preflight <本地包目录>；只读，不安装。')),
        (page.information || []).length ? h(Section, { title: '普通信息（不代表已验证通过）' },
          page.information.map((item, index) => h('div', { key: 'info-' + index, className: 'dd-item' },
            h('div', { className: 'dd-item-head' }, h(StatusChip, { status: 'info' }), h('span', { className: 'dd-item-title' }, item.title || item.id)),
            h('div', { className: 'dd-hint' }, item.summary || item.detail || ''),
            (item.recommendations || []).map((line, i) => h('div', { key: i, className: 'dd-hint' }, line))))) : null,
        h(
          Section,
          { title: '已安装插件（' + installed.length + '）' },
          installed.length
            ? h(
                'table',
                { className: 'dd-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { className: 'dd-th' }, '插件'),
                    h('th', { className: 'dd-th' }, '版本'),
                    h('th', { className: 'dd-th' }, '来源'),
                    h('th', { className: 'dd-th' }, '状态'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  installed.map((item, index) =>
                    h(
                      'tr',
                      { key: (item.name || 'row') + index },
                      h('td', { className: 'dd-td' }, h('div', null, item.name || '(未命名)'), item.note ? h('div', { className: 'dd-hint' }, item.note) : null),
                      h('td', { className: 'dd-td dd-mono' }, item.version || '—'),
                      h('td', { className: 'dd-td dd-mono' }, sourceLabel(item.source)),
                      h('td', { className: 'dd-td' }, h(StatusChip, { status: item.status })),
                    ),
                  ),
                ),
              )
            : h(Empty, { title: '报告里没有解析出插件清单。', hint: '执行 /doctor 重新体检；插件清单来自 profile 的 package.json 与 node_modules。' }),
        ),
        h(
          Section,
          { title: 'bundle 补丁' },
          patch.rows === null || patch.rows === undefined
            ? h(Empty, { title: '没有读到 bundle 补丁行。', hint: '检查 profile 的 cordis.patch.yml 是否存在且可读。' })
            : h(Row, { label: '补丁行', value: String(patch.rows) }),
          (patch.mismatches || []).length
            ? (patch.mismatches || []).map((item, index) =>
                h('div', { key: 'mm-' + index, className: 'dd-hint' }, '× ' + (item.name || item) + (item.reason ? '：' + item.reason : '')),
              )
            : null,
        ),
      )
    }

    function IssuesPage(props) {
      const page = props.page || {}
      const groups = page.groups || []
      if (!groups.length) {
        return h(Empty, {
          title: '没有问题项。',
          hint: '所有规则要么通过、要么因缺证据标记为「未知」；「未知」不算失败。',
        })
      }
      return h(
        'div',
        null,
        h('div', { className: 'dd-hint' }, '共 ' + (num(page.total, 0) || 0) + ' 条需要关注（失败 + 警告 + 未知）'),
        groups.map((group) =>
          h(
            Section,
            { key: group.category || group.label, title: (group.label || group.category) + '（' + ((group.items || []).length) + '）' },
            (group.items || []).map((item) => h(IssueItem, { key: (item.id || item.title) + ':' + (props.repairRevision || 0), item, repair: props.repair, onChanged: props.onChanged })),
          ),
        ),
        page.truncated ? h('div', { className: 'dd-hint' }, '另有 ' + page.truncated + ' 条被省略（面板单页上限）。') : null,
      )
    }

    function LogsPage(props) {
      const page = props.page || {}
      if (!page.available) {
        return h(Empty, {
          title: '这次报告里没有日志段。',
          hint: 'Host 侧的日志采集未运行或全部失败；执行 /doctor 重新体检可重试。',
        })
      }
      const window = page.window || {}
      const leaks = page.leaks || {}
      const clusters = page.clusters || []
      const sources = page.sources || []
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dd-hint' },
          [
            window.hours ? '窗口 ' + window.hours + ' 小时' : null,
            window.startedAt ? '自 ' + formatTime(window.startedAt) : null,
            typeof window.outsideCount === 'number' ? '窗口外 ' + window.outsideCount + ' 行' : null,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
        h(
          Section,
          { title: '错误簇（' + clusters.length + '）' },
          clusters.length
            ? clusters.map((cluster, index) =>
                h(
                  'div',
                  { key: 'cl-' + index, className: 'dd-item' },
                  h(
                    'div',
                    { className: 'dd-item-head' },
                    h(StatusChip, { status: cluster.level === 'error' ? 'fail' : cluster.level === 'warn' ? 'warn' : 'skip', text: String(cluster.level || 'info') }),
                    h('span', { className: 'dd-badge' }, '×' + (num(cluster.count, 0) || 0)),
                    cluster.lastAt ? h('span', { className: 'dd-hint' }, formatTime(cluster.lastAt)) : null,
                  ),
                  h('div', { className: 'dd-mono dd-muted' }, String(cluster.signature || '')),
                  cluster.sample ? h('div', { className: 'dd-hint dd-mono' }, String(cluster.sample).slice(0, 400)) : null,
                ),
              )
            : h(Empty, { title: '窗口内没有错误行。', hint: '日志里出现 exit≠0、异常栈、超时会在这里聚成簇。' }),
        ),
        h(
          Section,
          { title: '明文密钥扫描' },
          num(leaks.total, 0) > 0
            ? h(
                'div',
                null,
                h(Row, { label: '命中（去重后）', value: String(num(leaks.unique, 0)) + ' / ' + String(num(leaks.total, 0)) }),
                (leaks.byType || []).map((item, index) => h(Row, { key: 'lt-' + index, label: '  ' + (item.type || 'unknown'), value: String(num(item.count, 0)) })),
                h('div', { className: 'dd-hint' }, '面板只显示类型与数量。准备清理：/doctor repair prepare secret-cleanup；默认延后活动文件，先预览再确认执行。'),
              )
            : h(Empty, { title: '窗口内没有扫到明文密钥。', hint: '扫描只看结构特征（sk-、ghp_、Bearer 等），不会把值写进报告。' }),
        ),
        h(
          Section,
          { title: '日志来源（' + sources.length + '）' },
          sources.length
            ? h(
                'table',
                { className: 'dd-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { className: 'dd-th' }, '类型'),
                    h('th', { className: 'dd-th' }, '行数'),
                    h('th', { className: 'dd-th' }, '大小'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  sources.map((source, index) =>
                    h(
                      'tr',
                      { key: 'src-' + index },
                      h('td', { className: 'dd-td' }, source.label || source.kind || '(未知)', source.path ? h('div', { className: 'dd-hint dd-mono' }, String(source.path)) : null),
                      h('td', { className: 'dd-td' }, source.lines === null || source.lines === undefined ? '—' : String(source.lines)),
                      h('td', { className: 'dd-td' }, source.bytes === null || source.bytes === undefined ? '—' : formatBytes(source.bytes)),
                    ),
                  ),
                ),
              )
            : h(Empty, { title: '没有可读的日志来源。', hint: '检查 ~/.dsh 与 Host 日志目录是否存在、是否有读权限。' }),
        ),
      )
    }

    function ExportHistory(props) {
      const data = props.data
      const items = (data && data.items) || []
      return h(
        Section,
        { title: '导出与历史' },
        items.length === 0
          ? h(
              'div',
              { className: 'dd-hint' },
              h('div', null, '还没有导出记录。'),
              h('div', null, '在对话里执行 /doctor export 生成一份脱敏报告，或 /doctor export json 导出机器可读版。'),
            )
          : h(
              'div',
              null,
              items.map((item) =>
                h(Row, {
                  key: item.name,
                  label: item.name,
                  title: item.path,
                  value: String(item.format) + ' · ' + formatBytes(item.bytes) + ' · ' + (item.score === undefined || item.score === null ? 'na' : item.score + '%'),
                }),
              ),
              h('div', { className: 'dd-hint' }, '目录：' + ((data && data.dir) || '(未知)')),
            ),
      )
    }

    /* ---------------- 面板修复入口（粘入 client.js factory，Panel 之前） ---------------- */
    // 闭包已有 React/h/useState/useEffect/useCallback/useRef/Section/formatTime/riskLabel/REPAIR_PANEL_PATH。
    // 协议：lib/repair-panel.js（REPAIR_PANEL_PATH POST）+ lib/repair-catalog.js（offer 形状）。
    // 硬规则：① 只在 onClick 发请求，mount/effect 不自动 prepare/apply；② 令牌只活在本组件 state，发出 apply/rollback
    // 的同一刻抹掉，不进 storage/DOM/日志；③ ok:true ≠ 成功：failed/partial/refused/noop 一律不涂绿。
    async function requestRepair(body, { signal } = {}) {
      if (typeof fetch !== 'function') throw new Error('当前页面未提供数据请求能力，请重新打开 Harness 页面。')
      const response = await fetch(REPAIR_PANEL_PATH, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-dsh-doctor-ui': '1' }, body: JSON.stringify(body),
      })
      const value = await response.json().catch(() => null)
      if (!response.ok) {
        const text = value && typeof value.error === 'string' && value.error ? value.error : '修复面板请求失败（HTTP ' + response.status + '），请重试。'
        throw new Error(text + (response.status === 401 || response.status === 403 ? '\n请重新连接 Harness 页面后再试。' : ''))
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('修复面板返回格式错误，请重试。')
      return value
    }

    const REPAIR_TONE = { ok: 'dd-status-ok', warn: 'dd-status-warn', fail: 'dd-status-fail', skip: 'dd-status-skip' }
    const REPAIR_TEXT = { prepared: '方案待确认（尚未修改目标）', applied: '已执行，生效范围待核对', partial: '部分完成，仍需核对', failed: '执行未完成，修改情况待核对', refused: '未执行目标修改', noop: '没有目标改动', restored: '已回滚', cancelled: '操作已取消，不等于回滚' }
    const REPAIR_FIELD = { font: 'inherit', padding: '7px 10px', borderRadius: 7, minWidth: 0, width: 'min(100%, 320px)', maxWidth: '100%', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit' }
    const REPAIR_ROW = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }
    const REPAIR_CHECK = { display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 6 }
    const repairStatusText = (status) => REPAIR_TEXT[status] || '结果待核对'
    const repairBytes = (bytes) => { const n = Number(bytes); if (!Number.isFinite(n) || n < 0) return ''; return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B' }
    const repairLines = (items) => items.filter((item) => typeof item === 'string' && item.trim()).join('\n')
    // applied/restored 才是成功；partial 是部分结果，failed/refused/noop 同样不能当成功。
    const repairTone = (status) => (status === 'applied' || status === 'restored' ? 'ok' : status === 'failed' ? 'fail' : status === 'partial' || status === 'refused' || status === 'noop' ? 'warn' : 'skip')

    function RepairCenter(props) {
      const repair = (props && props.repair) || {}
      const available = repair.available === true
      const offers = Array.isArray(repair.actions) ? repair.actions.filter((item) => item && typeof item === 'object') : []
      const [proxyUrl, setProxyUrl] = useState('')
      const [offerId, setOfferId] = useState('')
      const [preview, setPreview] = useState(null)
      const [agreed, setAgreed] = useState(false)
      const [rollback, setRollback] = useState(null)
      const [rollbackAgreed, setRollbackAgreed] = useState(false)
      const [history, setHistory] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState('')
      const busyRef = useRef(false)
      const requestRef = useRef(null)
      const mountedRef = useRef(true)

      // 卸载只中止本地 fetch：服务端可能已经开始写入，界面不据此宣称“已取消/已回滚”。
      useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; if (requestRef.current) requestRef.current.abort() } }, [])

      // busyRef 是同步闸门（setBusy 要等下一帧，双击的第二下会被这里挡住）。
      const send = useCallback(async (label, body) => {
        if (busyRef.current) return { error: '上一次操作还没有结束，请稍后再点。' }
        busyRef.current = true; setBusy(label)
        const controller = new AbortController(); requestRef.current = controller
        try { return { value: await requestRepair(body, { signal: controller.signal }) } }
        catch (error) { return controller.signal.aborted || !mountedRef.current ? { aborted: true } : { error: String((error && error.message) || error) } }
        finally {
          if (requestRef.current === controller) requestRef.current = null
          busyRef.current = false; if (mountedRef.current) setBusy('')
        }
      }, [])
      const refreshPayload = useCallback(async () => {
        if (!props || typeof props.onChanged !== 'function') return false
        try { await props.onChanged(); return true } catch { return false }
      }, [props && props.onChanged])
      // 一次点击一张收据：任何新动作都先作废旧同意与旧令牌。
      const dropPreview = useCallback(() => { setPreview(null); setAgreed(false) }, [])
      const dropRollback = useCallback(() => { setRollback(null); setRollbackAgreed(false) }, [])
      const currentOffer = offers.find((offer) => offer && offer.id === offerId) || null

      const runPrepare = async (offer) => {
        if (!offer || typeof offer.id !== 'string' || !offer.id) return
        const body = { action: 'prepare', offerId: offer.id }
        if ((Array.isArray(offer.inputs) ? offer.inputs : []).some((input) => input && input.name === 'proxyUrl')) {
          const value = proxyUrl.trim()
          if (!value) { setNotice({ tone: 'warn', text: '请先填写代理地址，形如 http://127.0.0.1:PORT。' }); return }
          body.proxyUrl = value
        }
        dropPreview(); dropRollback(); setNotice(null); setOfferId(offer.id) // 新的一次准备：旧方案/旧同意/旧令牌全部作废
        const result = await send('prepare', body)
        if (result.aborted) return
        if (result.error) { setNotice({ tone: 'fail', text: '准备方案失败：' + result.error }); return }
        const outcome = result.value || {}
        const plan = outcome.plan && typeof outcome.plan === 'object' ? outcome.plan : null; const ready = Boolean(plan) && outcome.ok === true && outcome.canApply === true && Boolean(outcome.confirmation)
        setPreview(plan ? { plan, canApply: ready, confirmation: ready ? outcome.confirmation : null, text: typeof outcome.text === 'string' ? outcome.text : '' } : null); setAgreed(false)
        if (!ready) setNotice({ tone: 'warn', text: repairLines(['方案已生成，但当前不可执行，不会写入任何文件。', outcome.error, plan && plan.executionLabel, plan && Array.isArray(plan.blockedReasons) ? plan.blockedReasons.join('；') : null, plan && plan.refusal, '处理完上面的原因后可以重新准备。']) })
      }

      const runApply = async () => {
        if (!preview || !preview.plan) return
        if (!agreed) { setNotice({ tone: 'warn', text: '请先勾选同意当前方案，再点确认执行。' }); return }
        const confirmation = preview.confirmation
        if (!confirmation || typeof confirmation.token !== 'string' || !confirmation.token) {
          setNotice({ tone: 'warn', text: '这次预览没有可用令牌（可能已过期或已用掉），请重新准备方案后再确认。' }); dropPreview(); return
        }
        const planId = preview.plan.id; const token = confirmation.token; const restart = preview.plan.restartRequired === true
        // 发出即烧：双击、回放、回来再点都拿不到第二张收据。
        setPreview({ plan: preview.plan, canApply: false, confirmation: null, text: preview.text }); setAgreed(false)
        const result = await send('apply', { action: 'apply', planId, confirmationToken: token })
        if (result.aborted) return
        dropPreview(); dropRollback(); setHistory(null)
        if (result.error) { setNotice({ tone: 'fail', text: repairLines(['执行请求失败：' + result.error, '令牌已用掉，请重新准备方案并重新勾选同意。']) }); await refreshPayload(); return }
        const outcome = result.value || {}; const status = typeof outcome.status === 'string' ? outcome.status : 'unknown'; const presentation = outcome.presentation || {}; const tone = outcome.refreshFailed ? 'warn' : REPAIR_TONE[presentation.tone] ? presentation.tone : repairTone(status)
        setNotice({ tone, text: repairLines([presentation.label || repairStatusText(status), presentation.explanation, outcome.text, outcome.record && outcome.record.recordId ? '执行记录：' + outcome.record.recordId + '（可在下方「读取执行记录」后预览回滚）' : null, outcome.error, restart ? '只写了磁盘配置，下次启动生效；当前进程的实际状态没有被验证。' : null, outcome.refreshFailed ? '请求已结束，但结果刷新失败：请重新取数并核对执行记录。' : null, tone === 'ok' ? null : '要再试一次，请重新准备方案并重新勾选同意。']) })
        await refreshPayload()
      }

      const runHistory = async () => {
        dropPreview(); dropRollback(); const result = await send('history', { action: 'history' })
        if (result.aborted) return
        if (result.error) { setHistory(null); setNotice({ tone: 'fail', text: '读取执行记录失败：' + result.error }); return }
        const outcome = result.value || {}; const records = Array.isArray(outcome.records) ? outcome.records.filter((row) => row && typeof row.recordId === 'string') : []
        setHistory({ records, text: typeof outcome.text === 'string' ? outcome.text : '' })
        if (!records.length) setNotice({ tone: 'skip', text: '还没有执行记录；执行过一次写入后这里才会出现可回滚的条目。' })
      }

      const runRollbackPreview = async (record) => {
        const recordId = record && typeof record.recordId === 'string' ? record.recordId : ''
        if (!recordId) return; dropPreview(); dropRollback()
        const result = await send('rollback-preview', { action: 'rollback-preview', recordId })
        if (result.aborted) return
        if (result.error) { setNotice({ tone: 'fail', text: '回滚预览失败：' + result.error }); return }
        const outcome = result.value || {}; if (outcome.ok !== true || !outcome.confirmation) { setNotice({ tone: 'warn', text: String(outcome.error || '这条记录当前不能回滚。') }); return }
        setRollback({ record: outcome.record || record, confirmation: outcome.confirmation }); setNotice(null)
      }

      const runRollback = async () => {
        if (!rollback || !rollback.confirmation) return
        if (!rollbackAgreed) { setNotice({ tone: 'warn', text: '请先勾选同意回滚这条记录，再点确认回滚。' }); return }
        const confirmation = rollback.confirmation
        const recordId = (rollback.record && rollback.record.recordId) || confirmation.id; const token = confirmation.token
        setRollback({ record: rollback.record, confirmation: null }); setRollbackAgreed(false) // 同样是发出即烧
        const result = await send('rollback', { action: 'rollback', recordId, confirmationToken: token })
        if (result.aborted) return
        dropRollback(); setHistory(null)
        if (result.error) { setNotice({ tone: 'fail', text: repairLines(['回滚请求失败：' + result.error, '令牌已用掉，请重新预览回滚并重新勾选同意。']) }); await refreshPayload(); return }
        const outcome = result.value || {}; const status = typeof outcome.status === 'string' ? outcome.status : 'unknown'
        const presentation = outcome.presentation || {}
        setNotice({ tone: outcome.refreshFailed ? 'warn' : REPAIR_TONE[presentation.tone] ? presentation.tone : repairTone(status), text: repairLines(['回滚 ' + recordId + '：' + (presentation.label || repairStatusText(status)), presentation.explanation, outcome.text, outcome.error, outcome.refreshFailed ? '请求已结束，但结果刷新失败：请重新取数并核对执行记录。' : null]) })
        await refreshPayload()
      }

      const busyAny = Boolean(busy)
      const inline = props.inline === true
      const historyOnly = props.historyOnly === true
      const onRepair = (offer) => {
        const selected = offers.find((item) => item.id === (offer && offer.id))
        if (!selected || !available || busyRef.current || busyAny) return Promise.resolve()
        if ((selected.inputs || []).some((input) => input.name === 'proxyUrl') && !proxyUrl.trim()) {
          dropPreview(); dropRollback(); setOfferId(selected.id); setNotice(null)
          return Promise.resolve()
        }
        return runPrepare(selected)
      }
      const plan = preview && preview.plan ? preview.plan : null; const confirmation = preview && preview.confirmation ? preview.confirmation : null
      const noticeLine = notice
        ? h('div', { className: 'dd-hint', role: notice.tone === 'fail' ? 'alert' : 'status', 'aria-live': 'polite', style: { whiteSpace: 'pre-wrap', marginTop: 6 } }, h('span', { className: REPAIR_TONE[notice.tone] || 'dd-status-skip' }, '● '), notice.text)
        : null

      const offerOf = (offer) => {
        const proxyInput = (Array.isArray(offer.inputs) ? offer.inputs : []).find((input) => input && input.name === 'proxyUrl')
        return h('div', { key: offer.id, className: 'dd-item' },
          h('div', { className: 'dd-item-head' }, h('span', { className: 'dd-item-title' }, offer.title || offer.id),
            Array.isArray(offer.ruleIds) && offer.ruleIds.length ? h('span', { className: 'dd-mono dd-muted' }, offer.ruleIds.join(' · ')) : null,
            offer.restartRequired === true ? h('span', { className: 'dd-chip' }, '需重启生效') : null),
          offer.summary ? h('div', { className: 'dd-hint' }, String(offer.summary)) : null,
          proxyInput ? h('label', { className: 'dd-row', style: { marginTop: 4 } }, h('span', { className: 'dd-label' }, String(proxyInput.label || '代理地址')),
            // 输入一变，旧方案可能对应旧地址：立刻丢掉旧预览与旧同意。
            h('input', { type: 'text', inputMode: 'url', autoComplete: 'off', spellCheck: false, disabled: busyAny, value: proxyUrl, style: REPAIR_FIELD, placeholder: String(proxyInput.placeholder || 'http://127.0.0.1:PORT'), onChange: (event) => { setProxyUrl(event.target.value); dropPreview(); setNotice(null) } })) : null,
          proxyInput ? h('div', { className: 'dd-hint' }, '不预填任何地址：用不用代理、用哪个由你判断；这里只把你写的值写进 home/.env，不保证连通。') : null,
          h('div', { style: REPAIR_ROW }, h('button', { type: 'button', className: 'dd-btn', disabled: !available || busyAny, onClick: () => { void runPrepare(offer) } },
            busy === 'prepare' && offerId === offer.id ? '正在准备…' : '准备方案（只预览，不写入）')))
      }
      const offersBlock = offers.length ? offers.map(offerOf)
        : h('div', { className: 'dd-hint' }, '这份报告没有适用的修复项。支持配置文件头清理、代理配置、日志脱敏和禁用前端条目恢复四类动作；其它问题先给建议。')

      const previewBlock = plan ? h('div', { className: 'dd-item' },
        h('div', { className: 'dd-item-head' }, h('span', { className: 'dd-item-title' }, String(plan.title || plan.id)), h('span', { className: 'dd-mono dd-muted' }, String(plan.id || '')),
          h('span', { className: 'dd-value' }, riskLabel(plan.risk) + ' · ' + (plan.prepared === true ? '已准备' : '草案') + (plan.restartRequired === true ? ' · 需重启生效' : ''))),
        plan.executionLabel ? h('div', { className: 'dd-hint ' + (plan.executable === true ? 'dd-status-ok' : 'dd-status-warn') }, String(plan.executionLabel)) : null,
        Array.isArray(plan.changes) && plan.changes.length
          ? h('ul', { className: 'dd-evidence' }, plan.changes.map((change, index) => h('li', { key: 'chg-' + index, className: 'dd-mono' },
              [change.operation ? String(change.operation) : null, change.path ? String(change.path) : null, repairBytes(change.bytes)].filter(Boolean).join(' · '))))
          : null,
        Array.isArray(plan.blockedReasons) && plan.blockedReasons.length ? h('div', { className: 'dd-hint dd-status-warn' }, '阻碍：' + plan.blockedReasons.join('；')) : null,
        plan.refusal ? h('div', { className: 'dd-hint dd-status-warn' }, String(plan.refusal)) : null,
        plan.deferred ? h('div', { className: 'dd-hint' }, '延后处理：' + String(plan.deferred) + ' 项（活动窗口内的文件先保护起来）。') : null,
        preview.text ? h('div', { className: 'dd-hint', style: { whiteSpace: 'pre-wrap', marginTop: 4 } }, preview.text) : null,
        confirmation
          ? h('div', { style: { marginTop: 6 } },
              h('label', { style: REPAIR_CHECK }, h('input', { type: 'checkbox', checked: agreed, 'aria-label': '我同意执行当前预览的方案', onChange: (event) => setAgreed(event.target.checked === true) }),
                h('span', { className: 'dd-hint' }, '我核对过上面的路径与操作，同意执行。令牌到期：' + (formatTime(confirmation.expiresAt) || '未知') + '（一次性，用一次就作废）')),
              h('div', { style: REPAIR_ROW }, h('button', { type: 'button', className: 'dd-btn', disabled: !agreed || busyAny || Date.parse(confirmation.expiresAt) <= Date.now(), onClick: () => { void runApply() } }, busy === 'apply' ? '正在执行…' : '确认执行'),
                h('span', { className: 'dd-hint' }, '勾选后才可点；执行前 Host 会再复核计划仍是这一份。')))
          : h('div', { className: 'dd-hint dd-status-warn', style: { marginTop: 6 } }, '这条方案拿不到执行令牌，确认执行不可用；按上面的阻碍处理后重新准备。'),
        h('div', { style: REPAIR_ROW },
          currentOffer ? h('button', { type: 'button', className: 'dd-btn', disabled: busyAny, onClick: () => { void runPrepare(currentOffer) } }, busy === 'prepare' ? '正在重新准备…' : '重新准备（刷新方案）') : null,
          h('button', { type: 'button', className: 'dd-btn', disabled: busyAny, onClick: () => { dropPreview(); setNotice({ tone: 'skip', text: '已丢弃本地预览与确认令牌；没有发出任何写请求。' }) } }, '取消这次预览')))
        : null

      const rollbackBlock = h('div', { className: 'dd-item' },
        h('div', { className: 'dd-item-head' }, h('span', { className: 'dd-item-title' }, '执行记录与回滚')),
        h('div', { className: 'dd-hint' }, '只有真执行过的写入才有记录；回滚同样是「预览 → 单独勾选同意 → 确认」三步，令牌一次性有效。'),
        h('div', { style: REPAIR_ROW }, h('button', { type: 'button', className: 'dd-btn', disabled: !available || busyAny, onClick: () => { void runHistory() } }, busy === 'history' ? '正在读取…' : '读取执行记录')),
        history
          ? (history.records.length
              ? h('div', null, history.records.map((record) => h('div', { key: record.recordId, className: 'dd-row' },
                  h('span', { className: 'dd-label dd-mono' }, record.recordId + (record.kind ? ' · ' + String(record.kind) : '')),
                  h('span', { className: 'dd-hint' }, [record.status ? (record.presentation && record.presentation.label) || repairStatusText(record.status) : null, record.rollback && record.rollback.performed === true ? '已有回滚操作记录（完整性以回滚结果为准）' : null, record.finishedAt ? formatTime(record.finishedAt) : null].filter(Boolean).join(' · ')),
                  h('button', { type: 'button', className: 'dd-btn', title: record.status === 'restored' ? '该记录已回滚' : '预览回滚这条记录', disabled: busyAny || record.status === 'restored', onClick: () => { void runRollbackPreview(record) } },
                    record.status === 'restored' ? '已回滚' : '预览回滚'))))
              : h('div', { className: 'dd-hint' }, history.text || '没有可回滚的执行记录。'))
          : null,
        rollback && rollback.confirmation
          ? h('div', { style: { marginTop: 6 } },
              h('div', { className: 'dd-item-head' }, h('span', { className: 'dd-item-title' }, '回滚 ' + String((rollback.record && rollback.record.recordId) || rollback.confirmation.id)),
                rollback.record && rollback.record.status ? h('span', { className: 'dd-chip' }, (rollback.record.presentation && rollback.record.presentation.label) || repairStatusText(rollback.record.status)) : null),
              rollback.record && rollback.record.backup && rollback.record.backup.dir ? h('div', { className: 'dd-hint dd-mono' }, '备份：' + String(rollback.record.backup.dir) + '（含原始凭据，仅本地保留）') : null,
              h('label', { style: REPAIR_CHECK }, h('input', { type: 'checkbox', checked: rollbackAgreed, 'aria-label': '我同意回滚这条执行记录', onChange: (event) => setRollbackAgreed(event.target.checked === true) }),
                h('span', { className: 'dd-hint' }, '我同意把这条记录写过的文件还原成备份内容。令牌到期：' + (formatTime(rollback.confirmation.expiresAt) || '未知'))),
              h('div', { style: REPAIR_ROW }, h('button', { type: 'button', className: 'dd-btn', disabled: !rollbackAgreed || busyAny || Date.parse(rollback.confirmation.expiresAt) <= Date.now(), onClick: () => { void runRollback() } }, busy === 'rollback' ? '正在回滚…' : '确认回滚'),
                h('button', { type: 'button', className: 'dd-btn', disabled: busyAny, onClick: () => { dropRollback(); setNotice({ tone: 'skip', text: '已丢弃回滚预览与令牌；没有发出任何写请求。' }) } }, '取消回滚')))
          : null)

      const repairHint = h('div', { className: 'dd-hint' }, available
        ? '每一步都先在这里预览、由你单独勾选同意后才执行；面板打开时不会自动准备或执行。只对 BOM、代理环境变量、日志清理三类动作写文件，其它问题保持建议。'
        : '面板修复入口没有就绪' + (repair.error ? '（' + String(repair.error) + '）' : '') + '：下面的按钮暂不可用，但诊断与修复本身不受影响——对话里的 /doctor repair 与 dsh_repair 工具走同一条预览、确认、回滚链。')

      return h(inline ? 'div' : Section, inline ? null : { title: historyOnly ? '修复记录' : '面板修复入口' },
        inline ? null : historyOnly
          ? h('div', { className: 'dd-hint' }, available ? '这里只保留执行记录与回滚，不再重复列全部修复动作。' : '修复入口没有就绪' + (repair.error ? '（' + String(repair.error) + '）' : '') + '：记录与回滚按钮暂不可用。')
          : repairHint,
        // 行内分支：该问题卡在最前，随后是这一条动作的输入、notice 与预览；不显示回滚历史大块。
        inline && typeof props.renderIssue === 'function' ? props.renderIssue(onRepair, !available || busyAny) : null,
        noticeLine,
        historyOnly ? null : inline
          ? currentOffer && (currentOffer.inputs || []).some((input) => input.name === 'proxyUrl') ? offerOf(currentOffer) : null
          : offersBlock,
        historyOnly ? null : previewBlock,
        inline ? null : rollbackBlock)
    }

    function FrontendEvidence({ report, now }) {
      const frontend = report?.frontend
      const observedAt = frontend?.observedAt ? Date.parse(frontend.observedAt) : NaN
      const stale = frontend?.stale === true || (Number.isFinite(observedAt) && now - observedAt >= (frontend.ttlMs || 120000))
      const rows = Array.isArray(frontend?.modules) ? frontend.modules : []
      const resources = new Map((report?.results?.find((row) => row.id === 'DSH-PLG-006')?.data?.entries || []).map((row) => [row.moduleName, row.resource]))
      const failed = !stale && rows.some((row) => row.error !== 'none')
      const label = (value) => ({ ready: '已执行模块工厂', pending: '同步中', failed: '失败', registered: '已注册', mounted: '已挂载', 'not-opened': '当前未选中', selected: '当前选中', 'not-selected': '当前未选中', pass: 'Host 可获取', issue: 'Host 获取失败', unknown: '待核对' }[value] || '待核对')
      const phase = (title, value) => h(StatusChip, { status: value === 'failed' || value === 'issue' ? 'fail' : ['ready', 'registered', 'mounted', 'pass'].includes(value) ? 'ok' : 'unknown', text: title + '：' + label(value) })
      return h(Section, { title: '界面分层证据（不计健康分）' },
        h('div', { className: 'dd-hint' }, frontend?.reason || '浏览器回报能力待核对；原有 Host 诊断与故障保持原样。'),
        h('div', { className: failed ? 'dd-status-fail' : 'dd-hint', role: failed ? 'status' : undefined },
          stale ? '浏览器回报已过期：各浏览器阶段恢复待核对，请刷新体检数据。'
            : failed ? '已观察到入口或渲染失败；先核对兼容版本和入口，保留浏览器本地错误用于人工排查。'
              : Number.isFinite(observedAt) ? '最近一个所有者浏览器窗口 · ' + formatTime(frontend.observedAt)
                : '尚无有效浏览器回报；没有挂载证据不等于未打开，也不排除渲染失败。'),
        frontend?.capabilities ? h('div', { className: 'dd-hint' }, '最近回报宿主能力：模块状态 ' + (frontend.capabilities.modules ? '支持' : '未支持') + ' · 注册台账 ' + (frontend.capabilities.registration ? '支持' : '未支持') + ' · 渲染错误 ' + (frontend.capabilities.renderErrors ? '支持' : '未支持')) : null,
        h('details', null, h('summary', null, '资源 / 入口执行 / 组件注册 / 实际挂载 · ' + rows.length + ' 个模块'),
          rows.map((row) => h('div', { className: 'dd-item', key: row.id },
            h('div', { className: 'dd-item-title dd-mono' }, row.id),
            h('div', { className: 'dd-item-head' }, phase('资源', resources.get(row.id) || 'unknown'), phase('入口', stale ? 'unknown' : row.entry), phase('注册', stale ? 'unknown' : row.registration), phase('挂载', stale ? 'unknown' : row.mount)),
            !stale && row.selection !== 'unknown' ? h('div', { className: 'dd-hint' }, label(row.selection)) : null,
            !stale && row.error !== 'none' ? h('div', { className: 'dd-status-fail' }, row.error === 'render' ? '公开 Slot 监督通道观察到渲染失败；不推断第三方已挂载或已恢复。' : '公开模块状态观察到加载或入口失败；错误正文未上传。') : null)),
          h('div', { className: 'dd-hint' }, '资源来自 Host fetchBundle，不代表浏览器已下载。入口仅证明模块工厂执行，不代表插件激活或组件注册。注册来自公开 Slot 台账或 Doctor 自身注册；第三方实际挂载保持未知。只有 Doctor 自身生命周期与侧栏 active 提供挂载、当前未选中证据。'),
          h('div', { className: 'dd-hint' }, '缺少公开 modules / Slot API 的宿主保留待核对；刷新按需回报，不上传异常正文、URL、聊天或页面内容。')))
    }

    /* --------------------------------- 主面板 --------------------------------- */
    function Panel() {
      const [payload, setPayload] = useState(readPayload)
      const [tab, setTab] = useState(null)
      const [reloading, setReloading] = useState(false)
      const [repairRevision, setRepairRevision] = useState(0)

      const request = useRef(null)
      const loadPayload = useCallback(async (force) => {
        if (request.current) request.current.abort()
        const controller = new AbortController()
        request.current = controller
        setReloading(true)
        try {
          await frontendReporter?.flush({ rebootstrap: true })
          if (controller.signal.aborted) return
          const next = await fetchPanelPayload({ force, signal: controller.signal })
          if (!controller.signal.aborted) setPayload(next)
        } catch (error) {
          if (!controller.signal.aborted) setPayload((previous) => ({ ...previous, pending: false, missing: false, stale: Boolean(previous && previous.report), error: String(error.message || '体检数据读取失败') }))
        } finally {
          if (!controller.signal.aborted) setReloading(false)
        }
      }, [])
      useEffect(() => {
        void loadPayload(false)
        return () => { if (request.current) request.current.abort() }
      }, [loadPayload])
      const refresh = useCallback(() => { setRepairRevision((n) => n + 1); void loadPayload(true) }, [loadPayload])

      // 采集结果在下一次请求前仍是快照：用会走的钟，让「这是 40 分钟前的数据」
      // 自己显形，而不是让人盯着一个看起来永远正确的分数。30 秒一跳，够用且不浪费。
      const [now, setNow] = useState(() => Date.now())
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000)
        return () => clearInterval(timer)
      }, [])

      const hasReport = Boolean(payload && payload.report)
      // Keep the five-page shell usable even without an injected HTML snapshot.
      const loadMessage = payload && payload.error ? '报告读取失败：' + payload.error
        : !hasReport ? '正在等待 Host 首轮体检，面板正在自动加载…' : null

      const model = resolveModel(payload)
      const tabs = (model.tabs && model.tabs.length ? model.tabs : TAB_ORDER.map((id) => ({ id, label: TAB_LABEL[id], badge: null })))
      const activeId = tab && tabs.some((item) => item.id === tab) ? tab : tabs[0].id
      const page = (model.pages && model.pages[activeId]) || {}
      const score = hasReport ? num(model.score, null) : null
      const runtime = model.runtime || {}
      const runtimeLine = [runtime.dsh ? 'DSH ' + runtime.dsh : null, runtime.node ? 'Node ' + runtime.node : null, runtime.os, runtime.profile ? 'profile ' + runtime.profile : null]
        .filter(Boolean)
        .join(' · ')

      // 快照年龄：model.generatedAt 是 Host 那一轮体检的时间戳。过期就明说，
      // 自动加载可命中缓存；点击刷新等待真实采集完成，仍区分旧快照与在途请求。
      const snapshotAt = model.generatedAt ? Date.parse(model.generatedAt) : NaN
      const ageMin = Number.isFinite(snapshotAt) ? Math.max(0, Math.round((now - snapshotAt) / 60000)) : null
      const staleByFlag = Boolean(payload && payload.stale)
      const staleByAge = Number.isFinite(snapshotAt) && now - snapshotAt >= (num(payload.staleAfterMs, 15000) || 15000)
      const snapshotText = model.generatedAt
        ? '快照：' + formatTime(model.generatedAt) + (ageMin === null ? '' : ageMin < 1 ? ' · 刚刚' : ' · ' + ageMin + ' 分钟前')
        : '快照时间未知'
      const snapshotLine = h(
        'div',
        { className: 'dd-hint dd-muted', title: '打开面板自动取数；点击刷新等待 Host 重新采集。时间戳对应最近一次成功报告。' },
        snapshotText,
        payload.refreshInFlight ? ' · Host 正在重新采集，当前仍显示上次结果' : '',
        staleByFlag || staleByAge ? h('span', { style: { marginLeft: 8, color: 'var(--dsw-alias-state-warn-primary)' } }, '⚠️ 快照已过期 — 点击刷新体检数据') : null,
      )

      const body =
        activeId === 'environment'
          ? h(EnvironmentPage, { page, model, payload })
          : activeId === 'plugins'
            ? h(PluginsPage, { page, model, payload })
            : activeId === 'issues'
              ? h(IssuesPage, { page, model, payload, repair: payload.repair, repairRevision, onChanged: () => loadPayload(true) })
              : activeId === 'logs'
                ? h(LogsPage, { page, model, payload })
                : h(OverviewPage, { page, model, payload, repair: payload.repair, repairRevision, onChanged: () => loadPayload(true), onShowIssues: () => setTab('issues') })

      return h(
        'div',
        { className: 'dd-root', role: 'region', 'aria-label': 'DSH Doctor 诊断面板', tabIndex: 0 },
        h('style', null, (payload && payload.styles) || FALLBACK_CSS),
        h(
          'div',
          { className: 'dd-head' },
          h(
            'div',
            { className: 'dd-toolbar' },
            h('div', { className: 'dd-brand' },
              h('span', { className: 'dd-brand-icon' }, h(Icon, { size: 24, active: true })),
              h('div', { className: 'dd-heading' },
                h('h2', { className: 'dd-title' }, 'DSH Doctor'),
                runtimeLine ? h('div', { className: 'dd-subtitle' }, runtimeLine) : null)),
            score === null
              ? null
              : h('div', { className: 'dd-scorecard', title: '综合得分' },
                  h('span', { className: 'dd-score-label' }, '综合得分'),
                  h('strong', { className: 'dd-score ' + statusClass(model.status) }, score + '%')),
            h('button', { type: 'button', className: 'dd-btn dd-btn-primary', onClick: refresh, disabled: reloading }, reloading ? '正在采集…' : '刷新体检数据'),
          ),
          h(
            'div',
            { className: 'dd-tabs', role: 'tablist' },
            tabs.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': item.id === activeId,
                  className: 'dd-tab' + (item.id === activeId ? ' dd-tab-active' : ''),
                  onClick: () => setTab(item.id),
                },
                item.label || TAB_LABEL[item.id] || item.id,
                typeof item.badge === 'number' && item.badge > 0 ? h('span', { className: 'dd-badge' }, String(item.badge)) : null,
              ),
            ),
          ),
          h('div', { className: 'dd-meta' }, snapshotLine),
        ),
        loadMessage ? h('div', { className: 'dd-notice', role: payload && payload.error ? 'alert' : 'status', 'aria-live': 'polite' }, loadMessage) : null,
        h('div', { className: 'dd-content' }, hasReport ? body : null, h(FrontendEvidence, { report: payload?.report, now }), hasReport && activeId === 'issues' ? h(RepairCenter, { key: repairRevision, repair: payload.repair, onChanged: () => loadPayload(true), historyOnly: true }) : null),
        h('div', { className: 'dd-foot' }, '面板自动读取体检数据 · 刷新会等待采集完成 · 准备方案不改配置 · 用户确认后备份、执行和复检'),
      )
    }

    /* ------------------------------- 侧边栏图标 ------------------------------- */
    function Icon(props) {
      const size = (props && props.size) || 18
      const active = props && props.active
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { display: 'block', opacity: active ? 1 : 0.8 },
          'aria-hidden': 'true',
        },
        // 听诊器
        h('path', { d: 'M6 3v5a4 4 0 0 0 8 0V3' }),
        h('path', { d: 'M10 12v3a5 5 0 0 0 5 5' }),
        h('circle', { cx: 18, cy: 18, r: 3 }),
        h('path', { d: 'M6 3H4.5M14 3h1.5' }),
      )
    }

    /* --------------------------------- 装配 --------------------------------- */
    function apply(ctx) {
      const reporter = createFrontendReporter(ctx)
      frontendReporter = reporter
      function ObservedPanel() {
        useEffect(() => { reporter.mount(true); return () => reporter.mount(false) }, [])
        return h(Panel)
      }
      function SidebarIcon(props) {
        useEffect(() => { reporter.select(props.active); return () => reporter.select(undefined) }, [props.active])
        return h(Icon, props)
      }
      ctx.effect(() => () => { reporter.dispose(); if (frontendReporter === reporter) frontendReporter = undefined })
      ctx.slots.inject('main', () => {
        const dispose = ctx.slots.register({ name: 'main', key: NAME }, ObservedPanel)
        reporter.registration(true)
        return () => { reporter.registration(false); return dispose() }
      })
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: NAME, order: 40, label: () => 'DSH Doctor' }, SidebarIcon),
      )
    }

    exports.name = NAME
    exports.inject = inject
    exports.apply = apply
    exports.fetchPanelPayload = fetchPanelPayload
    exports.PANEL_DATA_PATH = PANEL_DATA_PATH
    exports.REPAIR_PANEL_PATH = REPAIR_PANEL_PATH
    exports.requestRepair = requestRepair
    exports.RepairCenter = RepairCenter
    exports.createFrontendReporter = createFrontendReporter
    exports.FRONTEND_OBSERVATION_PATH = FRONTEND_OBSERVATION_PATH
    exports.FRONTEND_REPORT_PATH = FRONTEND_REPORT_PATH
    exports.FrontendEvidence = FrontendEvidence
    exports.Panel = Panel
    exports.Icon = Icon
    return exports
  },
})
