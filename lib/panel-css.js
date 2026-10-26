/**
 * DSH Doctor · 面板样式（纯数据模块，零副作用）
 *
 * 面板组件把 `PANEL_CSS` 作为 `<style>{PANEL_CSS}</style>` 放进自己的 React 子树，
 * 不是注入 document.head——所以这份 CSS 必须自己承担全部隔离责任：
 *
 *   1. 所有选择器都以 .dd- 开头，作用域收敛在面板内部，不碰宿主页面任何节点；
 *   2. 没有 @import、没有 url()、没有任何外部字体/图片/网络资源（离线可用）；
 *   3. 不写全局选择器（根元素、文档元素一概不碰），也不写优先级强升；
 *   4. 不写动画/过渡——诊断面板一旦有动效，用户会以为它卡住了。
 *
 * 主题策略（宿主可能是深色也可能是浅色，且会用 --dsw-alias-* 切换两套取值）：
 *   - 容器**不写背景色**，文字一律 `inherit` / `currentColor`；
 *   - 分隔线走 `--dsw-alias-border-l1`（面内细线）/ `--dsw-alias-border-l2`
 *     （卡片、胶囊、按钮、虚线占位的外轮廓）；
 *   - 底纹走 `--dsw-alias-bg-layer-2`：宿主自己的 `--dsw-alias-settings-card-fill`
 *     就是指向这一档，面板里"抬起一层的浅底"跟它保持同一层级；
 *   - 弱化文字走 `--dsw-alias-label-secondary`，不再用 opacity 硬压对比度；
 *   - 状态色走 `--dsw-alias-state-*-primary`，语义跨主题一致：
 *     ok→success、warn→warn、fail→error、skip→idle；unknown 没有对应 state
 *     token，回落 `--dsw-alias-label-secondary`（不用未定义变量）。
 *
 *   整个文件**不出现任何颜色字面量**（没有 hex、没有 rgb()/hsl()、没有命名色）：
 *   面板只引用 token 名，宿主换肤/换深浅时自动跟随，不需要这份 CSS 再改一次。
 *   唯一允许的颜色写法是 `inherit` / `currentColor` / `transparent` / `var(--dsw-alias-*)`。
 *
 * 纵向滚动合同：面板高度由宿主给定（父容器 `height: 100%` 链路），
 * `dd-root` 是**唯一**的纵向原生滚动视口（有界 + `overflow-y: auto`），
 * 内层 `dd-content` 只加内边距、不抢滚动；不使用 wheel 事件或 JS 滚动，
 * 也不用 `overflow: hidden` 把整块面板裁掉。
 *
 * 窄面板策略：
 *   - `dd-root` 的 `min-width: 0` 让 flex/grid 父容器可以把它压窄；
 *   - `dd-item` / `dd-row` 用 flex + gap，长文本 `overflow-wrap: anywhere`；
 *   - 表格允许横向滚动：外层容器（`dd-section` / `dd-card-body`）给 `overflow-x: auto`。
 *
 * `CLASSES` 与 CSS 必须严格同构：测试会双向校验（清单里的类都在 CSS 里出现，
 * CSS 里出现的类也都在清单里），任何一边漏一项都会让单测失败。
 */

export const PANEL_CSS = `
/* ── 根容器：唯一的纵向滚动视口；只定字号、行高、宽度策略，不定底色 ── */
.dd-root {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  height: 100%;
  min-height: 0;
  max-height: 100%;
  font-size: 12px;
  line-height: 1.55;
  color: inherit;
  overflow-wrap: anywhere;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  scrollbar-gutter: stable;
}

.dd-root *,
.dd-root *::before,
.dd-root *::after {
  box-sizing: border-box;
}

/* 原生 details/summary 在面板里要可点、可键盘聚焦（不引入 JS） */
.dd-root summary {
  cursor: pointer;
}

.dd-root :focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}

/* ── 内容层：只加内边距，不设高度、不接管纵向滚动 ──────────────────── */
.dd-content {
  min-width: 0;
  padding: 10px 14px 20px;
}

/* ── 头部：纵向堆叠（标题工具行自己保持横向 flex）──────────────────── */
.dd-head {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.dd-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 1.08em;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.dd-score {
  flex: none;
  font-size: 1.28em;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* ── 页签：按钮观感，选中态只用底线，不整块高亮 ──────────────────── */
.dd-tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  min-width: 0;
  margin: 6px 0;
  padding: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  overflow-x: auto;
  overflow-y: hidden;
}

.dd-tab {
  flex: none;
  margin: 0;
  padding: 4px 8px;
  border: 0;
  border-radius: 4px 4px 0 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: inherit;
  white-space: nowrap;
  cursor: pointer;
  appearance: none;
}

.dd-tab-active {
  font-weight: 600;
  box-shadow: inset 0 -2px 0 currentColor;
}

/* ── 徽章与小标签 ────────────────────────────────────────────────── */
.dd-badge {
  display: inline-block;
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dd-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ── 底部工具条 ──────────────────────────────────────────────────── */
.dd-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 8px;
  padding: 6px 14px 10px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  opacity: .82;
}

/* ── 按钮：描边 + 透明底，颜色继承宿主 ───────────────────────────── */
.dd-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin: 0;
  padding: 3px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: inherit;
  white-space: nowrap;
  cursor: pointer;
  appearance: none;
}

/* ── 区块与卡片 ──────────────────────────────────────────────────── */
.dd-section {
  min-width: 0;
  max-width: 100%;
  margin-top: 10px;
  overflow-x: auto;
}

.dd-section-title {
  margin: 0 0 4px;
  font-size: 1em;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.dd-card {
  min-width: 0;
  max-width: 100%;
  margin-top: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  overflow: hidden;
}

.dd-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  padding: 5px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  font-weight: 600;
}

.dd-card-body {
  min-width: 0;
  padding: 6px 8px;
  overflow-x: auto;
}

/* ── 键值行 ──────────────────────────────────────────────────────── */
.dd-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 1px 0;
}

.dd-label {
  flex: 0 0 auto;
  max-width: 45%;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.dd-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}

.dd-hint {
  font-size: .92em;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

/* ── 列表：每条一张浅底小板（底 + 描边配对，浅色主题下也立得住）──── */
.dd-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dd-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2);
}

.dd-item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.dd-item-title {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.dd-evidence {
  display: block;
  margin: 0;
  font-size: .94em;
  opacity: .82;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.dd-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dd-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.dd-muted {
  color: var(--dsw-alias-label-secondary);
}

.dd-empty {
  padding: 10px 8px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: 4px;
  opacity: .7;
  text-align: center;
  overflow-wrap: anywhere;
}

/* ── 表格：窄面板下由外层滚，不撑破布局 ──────────────────────────── */
.dd-table {
  width: 100%;
  min-width: 0;
  border-collapse: collapse;
  border-spacing: 0;
  font-variant-numeric: tabular-nums;
}

.dd-th {
  padding: 4px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-weight: 600;
  text-align: left;
  vertical-align: bottom;
  white-space: nowrap;
}

.dd-td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.dd-table tr:last-child .dd-td {
  border-bottom: 0;
}

/* ── 状态：只染文字色，可与 dd-chip / dd-badge 叠加在同一元素上 ──────
   规则顺序很重要：状态块必须排在 dd-chip 之后，同权重下后者不会盖掉它。
   五个取值里四个是宿主主题的 state token：深底/浅底各有一套，语义一致
   （ok=success / warn=warn / fail=error / skip=idle）；unknown 没有对应
   的 state token，回落 label-secondary。所以这里不需要、也不允许再写死
   任何具体颜色。 */
.dd-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.dd-status::before {
  content: "";
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.dd-status-ok {
  color: var(--dsw-alias-state-success-primary);
}

.dd-status-warn {
  color: var(--dsw-alias-state-warn-primary);
}

.dd-status-fail {
  color: var(--dsw-alias-state-error-primary);
}

.dd-status-unknown {
  color: var(--dsw-alias-label-secondary);
}

.dd-status-skip {
  color: var(--dsw-alias-state-idle-primary);
}
`

/** CSS 里定义的每一个类名（与 PANEL_CSS 双向同构，测试会校验）。 */
export const CLASSES = [
  // 结构
  'dd-root',
  'dd-content',
  'dd-head',
  'dd-title',
  'dd-score',
  'dd-tabs',
  'dd-tab',
  'dd-tab-active',
  'dd-badge',
  'dd-foot',
  'dd-btn',
  'dd-chip',
  // 区块
  'dd-section',
  'dd-section-title',
  'dd-card',
  'dd-card-head',
  'dd-card-body',
  'dd-row',
  'dd-label',
  'dd-value',
  'dd-hint',
  // 列表
  'dd-list',
  'dd-item',
  'dd-item-head',
  'dd-item-title',
  'dd-evidence',
  'dd-actions',
  'dd-mono',
  'dd-muted',
  'dd-empty',
  // 表格
  'dd-table',
  'dd-th',
  'dd-td',
  // 状态
  'dd-status',
  'dd-status-ok',
  'dd-status-warn',
  'dd-status-fail',
  'dd-status-unknown',
  'dd-status-skip',
]

export default { PANEL_CSS, CLASSES }
