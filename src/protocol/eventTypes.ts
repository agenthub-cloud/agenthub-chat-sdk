/**
 * 通用聊天组件类型定义(§5/§6)。
 * 与后端 ChatEventJson 的事件结构对齐。
 */

/**
 * 扁平消息(对应 ai_chat_message 一行)
 */
export interface ChatMessage {
  /** message_id */
  messageId?: number
  sessionId: string
  agentId?: number
  conversationId?: string
  /** agent 调用时非空 */
  subAgentId?: number
  /** USER/ASSISTANT/THINKING/TOOL/SUMMARY */
  messageType: string
  /** 正文 */
  content?: string
  /** '0' 参与 LLM / '1' 只给前端 */
  visibleToLlm?: string
  toolName?: string
  toolArgs?: string
  toolResult?: string
  hasFullToolResult?: boolean
  /** builtin / mcp / agent */
  toolSource?: string
  toolDurationMs?: number
  /** '0' 成功 / '1' 失败 */
  toolSuccess?: string
  tokens?: number
  /** 时间戳(ms) */
  createTime?: number
  /** 前端标记,流式中 */
  streaming?: boolean
}

/**
 * 一轮对话
 */
export interface Turn {
  /** 用户消息 */
  userMsg: ChatMessage | null
  /** 助手过程(思考/工具/子agent/文本) */
  steps: Step[]
  /** 是否已出最终文本 */
  completed: boolean
}

/**
 * 过程节点子步骤
 */
export interface Step {
  type: 'reasoning' | 'tool' | 'agent' | 'content' | 'summary'
  /** content/reasoning 的累积文本 */
  text?: string
  /** tool/agent 的名称 */
  name?: string
  /** builtin/mcp(tool 用) */
  source?: string
  /** agent 的 code(身份,嵌套事件靠它匹配归属) */
  agentCode?: string
  /**
   * 调用实例 id,同一子 agent 一轮被调多次时用它区分串卡
   * (后端 agent_start/agent_end 携带,前端优先按 invId 归属)
   */
  invId?: string
  /** tool 的入参 */
  args?: string
  /** tool/agent 的返回(agent 为子智能体回答,流式累积) */
  result?: string
  /** 是否成功 */
  ok?: boolean
  /** 耗时 */
  ms?: number
  /** 该 step 是否还在流式 */
  streaming: boolean
  /** 出错标记 */
  error?: boolean
  /** agent 的子步骤(子智能体内部的思考/工具,嵌套展示) */
  steps?: Step[]
}

/**
 * JSON-RPC chat.event 中的领域事件(与后端 ChatEventJson 对齐)。
 */
export interface ChatEvent {
  /** 见 EVENT_TYPES */
  type: string
  /**
   * 直接包裹该事件的子智能体 code;非空时事件嵌进对应 agent step,
   * 缺省则为顶层事件。agent_start 的 owner 表示这个 agent step 本身嵌进谁。
   */
  owner?: string
  /**
   * agent_start/agent_end 携带的调用实例 id;同一子 agent 一轮被调
   * 多次时用它精确配对 start/end,避免串到上一张卡。
   */
  invId?: string
  /** ui 事件的产物名(如 kb.references) */
  name?: string
  /** ui 事件幂等键 */
  eventId?: string
  /** ui 事件载荷 */
  payload?: object
}

/** 事件类型常量(与后端 ChatEventJson 对齐) */
export const EVENT_TYPES = {
  TEXT: 'text',
  REASONING: 'reasoning',
  TOOL_START: 'tool_start',
  TOOL_END: 'tool_end',
  TOOL_CONFIRM_REQUIRED: 'tool_confirm_required',
  TOOL_CALL_REQUEST: 'tool_call_request',
  CONTEXT_CLEANED: 'context_cleaned',
  AGENT_START: 'agent_start',
  AGENT_END: 'agent_end',
  RUN_STATUS: 'run_status',
  UI: 'ui',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted'
}

/** 后端 UiArtifactNames 白名单,与 ChatEventJson.ui 的 name 对齐 */
export const UI_ARTIFACT_NAMES = {
  KB_REFERENCES: 'kb.references',
  RUN_TOKEN_USAGE: 'run.tokenUsage',
  WORKSPACE_CHANGES: 'workspace.changes'
}

/**
 * 前端支持的产物规格。schemaVersion 为可理解的最高版本;
 * 更高版本忽略,避免乱解析。新增产物只加一行。
 */
export const UI_ARTIFACT_SPECS: Record<string, { schemaVersion: number; minSchemaVersion?: number }> = {
  [UI_ARTIFACT_NAMES.KB_REFERENCES]: { schemaVersion: 2, minSchemaVersion: 2 },
  [UI_ARTIFACT_NAMES.RUN_TOKEN_USAGE]: { schemaVersion: 1 },
  [UI_ARTIFACT_NAMES.WORKSPACE_CHANGES]: { schemaVersion: 1 }
}

export function isSupportedUiArtifact(event?: { name?: string; schemaVersion?: number } | null): boolean {
  if (!event || !event.name) return false
  const spec = UI_ARTIFACT_SPECS[event.name]
  if (!spec) return false
  const version = Number(event.schemaVersion)
  if (spec.minSchemaVersion && (!Number.isFinite(version) || version < spec.minSchemaVersion)) {
    return false
  }
  return !Number.isFinite(version) || version <= spec.schemaVersion
}

/** step 类型常量 */
export const STEP_TYPES = {
  REASONING: 'reasoning',
  TOOL: 'tool',
  AGENT: 'agent',
  CONTENT: 'content',
  SUMMARY: 'summary',
  UI: 'ui'
}
