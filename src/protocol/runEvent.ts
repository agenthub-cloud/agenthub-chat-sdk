/**
 * 移植自 AgentHub 主仓 desktop/src/api/chatRpc.js，迁移期 legacy 与 v1 双投递，
 * 本函数把 v1 信封投影为现有视图模型。
 */

/** 标准 v1 事件信封(CloudEvents 风格);迁移期允许字段不完整(缺 specversion 时回退 legacy) */
export interface RunEventV1Envelope {
  specversion?: string
  type: string
  data?: Record<string, any>
}

/** 投影后的视图模型:legacy 事件字段 + 归一化的 type */
export type NormalizedRunEvent = Record<string, any> & { type: string }

/** 将标准 v1 信封投影为现有视图模型，迁移期保留 legacy 回退。 */
export function normalizeRunEvent(
  eventV1: RunEventV1Envelope | undefined | null,
  legacyEvent: Record<string, any> | null | undefined
): NormalizedRunEvent {
  if (!eventV1?.specversion || !eventV1?.type) return (legacyEvent || {}) as NormalizedRunEvent
  const typeMap: Record<string, string> = {
    'ai.run.status.changed': 'run_status',
    'ai.run.text.delta': 'text',
    'ai.run.reasoning.delta': 'reasoning',
    'ai.run.tool.started': 'tool_start',
    'ai.run.tool.confirmation.required': 'tool_confirm_required',
    'ai.run.tool.call.requested': 'tool_call_request',
    'ai.run.tool.completed': 'tool_end',
    'ai.run.agent.started': 'agent_start',
    'ai.run.agent.completed': 'agent_end',
    'ai.run.ui.published': 'ui',
    'ai.run.context.compacted': eventV1.data?.kind === 'overflow_trimmed'
      ? 'context_overflow_trimmed' : 'context_cleaned',
    'ai.run.completed': 'done',
    'ai.run.failed': 'error',
    'ai.run.cancelled': 'cancelled',
    'ai.run.interrupted': 'interrupted'
  }
  return { ...(eventV1.data || {}), type: typeMap[eventV1.type] || eventV1.type }
}
