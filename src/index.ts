/**
 * 主入口 barrel(`@agenthub/chat`,框架无关)。vue 组合式函数走 `@agenthub/chat/vue`。
 *
 * 导出面原则(宁缺勿滥):任务清单显式项 + 已导出值的签名直接可达的命名类型。
 * 内部助手一律不导出——applyEvent 的 setStatus/setActiveRun/completeTurnState/
 * finishTurn/promptToolConfirm/promptPendingConfirms/readableError 等,timeline 的
 * newTurn/collectKbCitationState/applySpecialEventSummaries/terminalRunLabelForHistory,
 * kbHits/workspaceChanges 全家,以及 ChatRpcClient 类(经 ChatClient.rpc 结构可达,
 * headless 注入用收窄的 ChatRpcLike)。
 */
// —— 装配(client)——
export { createChatClient, type ChatClient, type ChatClientConfig, type ReconnectOptions } from './client.js'
export { requestAs, type HttpClientLike, type HttpResult, type HttpRequestConfig, type HttpParam } from './http/types.js'
export type { ChatRest, ChatRunView, ChatRunStateView, CreateChatRunInput } from './rest/chatRest.js'

// —— 文件 / 知识库 / 资源域 ——
export {
  createUserFilesApi,
  type UserFilesApi,
  type UserFile,
  type UserFileListResult,
  type UserFileQuota,
  type AttachedUserFile,
  type EntityId
} from './domains/files.js'
export {
  createKnowledgeBasesApi,
  type KnowledgeBasesApi,
  type KnowledgeBasesApiOptions,
  type KnowledgeBase,
  type KnowledgeDocument,
  type KnowledgeGraphExploreInput,
  type KnowledgeDocumentEventOptions
} from './domains/knowledgeBases.js'
export {
  createResourcesApi,
  type ResourcesApi,
  type SkillResource,
  type SkillResourceFile,
  type ResourceListResult
} from './domains/resources.js'

// —— transport ——
export { defaultWsUrlBuilder } from './transport/wsUrl.js'
export { ChatTransportError, type ChatTransportErrorCode } from './transport/errors.js'

// —— engine:无头状态机与 headless 高级用法 ——
export {
  createChatEngine,
  type ChatEngine,
  type ChatEngineClient,
  type ChatEngineOptions,
  type ChatRpcLike
} from './engine/engine.js'
export {
  applyEvent,
  newEngineState,
  type EngineState,
  type ChatEngineDeps,
  type RunEventEnvelope
} from './engine/applyEvent.js'
export {
  buildTurns,
  applyRunStates,
  type TimelineTurn,
  type TimelineStep,
  type TimelineMessage,
  type TimelineUsage,
  type TimelineAttachments,
  type RunStateSnapshot,
  type SpecialEventSummary
} from './engine/timeline.js'

// —— clientTools:渠道工具注册表 ——
export {
  createClientToolRegistry,
  type ClientToolRegistry,
  type ClientToolRegistryOptions,
  type ClientToolDefinition,
  type ClientToolHandler,
  type ClientToolSnapshotEntry,
  type ClientToolDeclarePayload,
  type ToolCallRequestEvent
} from './clientTools/registry.js'

// —— protocol:运行时常量与事件归一 ——
export { EVENT_TYPES, STEP_TYPES, UI_ARTIFACT_NAMES, UI_ARTIFACT_SPECS, isSupportedUiArtifact } from './protocol/eventTypes.js'
export { RPC_METHODS } from './protocol/rpcMethods.js'
export { isTerminalRunStatus, terminalRunLabel } from './protocol/status.js'
export { normalizeRunEvent, type RunEventV1Envelope, type NormalizedRunEvent } from './protocol/runEvent.js'
