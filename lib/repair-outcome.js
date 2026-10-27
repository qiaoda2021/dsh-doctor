/** Content-free display facts. These labels never grant permission or change an execution verdict. */
export function describeRepairOutcome(result = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) result = {}
  const status = typeof result.status === 'string' ? result.status : ''
  const record = result.record && typeof result.record === 'object' ? result.record : {}
  const application = record.application
  const verification = record.verification || {}
  const verified = verification.status === 'pass' || (verification.complete === true && verification.remaining === 0)
  let tone = 'warn', label = '结果待核对', detail = '尚未取得完整回执，请读取执行记录后核对目标状态。'
  if (status === 'refused') {
    label = '未执行'; detail = '本次没有执行目标修改；处理提示原因后重新准备方案。'
  } else if (status === 'prepared') {
    tone = 'skip'; label = '方案待确认'; detail = '只准备了方案，尚未执行目标修改。'
  } else if (status === 'cancelled') {
    label = '操作已取消'; detail = '取消不等于自动回滚；是否已有修改请以执行记录为准。'
  } else if (status === 'noop') {
    tone = 'skip'; label = '没有目标改动'; detail = '本次没有需要写入的目标改动，执行记录或备份仍可能保留。'
  } else if (status === 'failed') {
    tone = 'fail'; label = '执行未完成'; detail = '部分修改可能已经发生；请核对执行记录，不代表目标保持原样。'
  } else if (status === 'restored') {
    tone = 'ok'; label = '已回滚'; detail = '已按回执恢复目标状态；页面显示仍需按实际情况核对。'
  } else if (['applied', 'partial'].includes(status)) {
    if (application === 'restart-required' || result.restartRequired === true || record.restartRequired === true) {
      label = '已保存，待重启核对'; detail = '回执要求重启后再核对；磁盘保存不等于当前进程已采用，Doctor没有代你重启。'
    } else if (status === 'partial') {
      label = '部分完成，仍需核对'; detail = '尚有步骤、覆盖范围或复检未完整，请查看回执中未完成的事项。'
    } else if (record.kind === 'plugin-enable') {
      label = verified ? 'Host复检通过，页面待核对' : '启用已请求，结果待核对'
      detail = 'Host加载和资源检查不代表浏览器已经挂载；请刷新页面并核对实际显示。'
    } else if (verified) {
      tone = 'ok'; label = '修改完成，复检通过'; detail = '回执确认目标修改及对应复检通过；不扩大到未检查的范围。'
    } else {
      label = '已执行，复检待核对'; detail = '已收到执行回执，但缺少完整复检证据，请查看记录。'
    }
  }
  if (result.refreshFailed === true) {
    tone = 'warn'; label = '回执已返回，页面结果待刷新'
    detail += ' 结果刷新失败，当前展示可能是旧数据；请重新取数并核对记录，不凭此提示判断目标改没改。'
  }
  return { tone, label, explanation: detail }
}
