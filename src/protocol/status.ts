/** 运行终态集合(与后端 ChatRunStatus.TERMINAL 对齐) */
const TERMINAL_RUN_STATUS = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED']

/** run 是否已到终态。非终态(QUEUED/RUNNING/FINALIZING)才允许界面继续显示「执行中」。 */
export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUS.includes(status)
}

/**
 * 非成功终态的兜底文案(后端没带 errorMessage 时用)。
 * 实时路径与历史重建共用一份,避免同一次失败在刷新前后显示成两种说法。
 */
export function terminalRunLabel(status: string): string {
  if (status === 'CANCELLED') return '已停止生成'
  if (status === 'INTERRUPTED') return '执行节点中断，可重新发起'
  return '对话执行失败，请重试'
}
