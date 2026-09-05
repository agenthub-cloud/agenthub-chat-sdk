/**
 * applyEvent:Run 事件 → 轮次状态机(无头、纯对象)。
 *
 * 移植自 desktop/src/composables/useChatRun.js,含四块源逻辑的合并:
 * 1. 源 applyEvent(turn, event) 的全部事件分支(逐字);
 * 2. 源 handleRunEvent 的状态半段(lastEventSeq 记账、tool_call_request 的信封 sessionId 透传、
 *    run_status/done/error/cancelled/interrupted 的收口)——引擎路径里它与 applyEvent 同点触发,合并为一;
 * 3. 源 completeActive 的状态半段(completeTurnState),订阅清理与 onDone/onError 留在 engine.ts;
 * 4. 私有助手 findStepById/findAgentStep/targetSteps/applyUiEvent/applyWorkspaceChanges/
 *    applyTokenUsage/applyKbReferences/promptToolConfirm/promptPendingConfirms/finishTurn/
 *    setFinalText/clearStreaming/parseToolAttachments/cleanUserText/readableError(逐字)。
 *
 * 与源的唯一行为偏离(三端合并统一,已注记在 promptToolConfirm):
 * tool 确认回调 resolve false(以及 reject)也必须回传 confirmChatTool(false)。
 * desktop 版只处理 then(其 confirmDanger 只 resolve 不 reject);ruoyi-ui 的取消/关闭回 false。
 * 不统一的话,onToolConfirm 返回 false 时工具线程在后端挂起到渠道超时。
 *
 * 其余变换均为机械替换:Vue ref → EngineState 字段(turns.value → state.turns、
 * activeRun.value?.runId → state.activeRunId 等);confirmDanger → cb.onToolConfirm;
 * toast/ElMessage → cb.onNotice;chatRpc/handleToolCallRequest/REST 模块单例 → cb.rpc/
 * cb.clientTools/cb.rest 注入。isTerminal/terminalLabel 与 protocol/status.ts 的
 * isTerminalRunStatus/terminalRunLabel 逐字同文,直接复用(Task 5/8 已定稿)。
 */
import { EVENT_TYPES, STEP_TYPES, UI_ARTIFACT_NAMES, isSupportedUiArtifact } from '../protocol/eventTypes.js'
import { mergeWorkspaceChanges } from './workspaceChanges.js'
import type { TimelineAttachments, TimelineStep, TimelineTurn, TimelineUsage } from './timeline.js'
import type { ChatRest } from '../rest/chatRest.js'
import type { ChatRpcClient } from '../transport/chatRpcClient.js'
import type { ClientToolRegistry } from '../clientTools/registry.js'

/** 引擎状态(源 composable 的 refs 平铺成纯对象;其余 ref 照原样放进索引签名)。 */
export interface EngineState {
  turns: TimelineTurn[]
  /** ≙ 源 status === 'streaming',由 setStatus 同步维护 */
  loading: boolean
  connectionState: string
  /** 活动运行 id;判定一律走它(activeRun 对象仅作展示镜像) */
  activeRunId: string | null
  /** 源 status ref:idle/streaming/error/done/cancelled/interrupted */
  status: string
  /** 源 activeRun ref:当前 run 对象,展示用镜像(setActiveRun 同步) */
  activeRun: any
  [key: string]: any
}

/** 传给 applyEvent 的事件信封(RPC chat.event 通知 params 的形状)。 */
export interface RunEventEnvelope {
  runId?: string
  seq?: number
  sessionId?: string
  event?: any
  [key: string]: any
}

/**
 * 引擎消费的 ChatRpcClient 结构子集(仅 subscribe/unsubscribe/会话监听/连接监听/retain)。
 * 收窄成接口便于纯 fake 注入;真实 ChatRpcClient 天然满足本形状(方法双变,结构兼容)。
 */
export interface ChatRpcLike {
  subscribe(runId: string, afterSeq: number, onEvent?: (event: any, params: any) => void, onRunState?: (run: any) => void, onGap?: (info: any) => number | null | Promise<number | null>): Promise<any>
  unsubscribe(runId: string): Promise<any>
  subscribeSession(sessionId: string, onSessionEvent?: (params: any) => void, onActiveRun?: (run: any) => void): Promise<any>
  unsubscribeSession(sessionId: string): Promise<any>
  onConnectionState(listener: (state: string) => void): () => any
  retain(): () => any
}

/**
 * applyEvent 的回调依赖包。engine 内部由 createChatEngine 从 client+options 收敛出一份;
 * headless 使用方也可自建(此时 rest/rpc/cancelRun 字段仅为契约完整,applyEvent 不消费)。
 */
export interface ChatEngineDeps {
  /** 危险工具人工确认;resolve false / reject 都会回传 confirmChatTool(false),见文件头注记 */
  onToolConfirm: (info: { name: string; argsPreview: string }) => Promise<boolean>
  /** 源 toast/ElMessage 提示 */
  onNotice: (message: string, type?: 'info' | 'warning' | 'error') => void
  clientTools: ClientToolRegistry | null
  /** 源 confirmChatTool;失败在调用点吞掉(挂起态在服务端,本页抛出去也没人接) */
  sendToolConfirm: (runId: string, confirmId: string, approved: boolean) => Promise<void>
  /** 源 cancelChatRun 的意图封装;engine 自身按移植规则走 cb.rest.cancelChatRun 取原始响应 */
  cancelRun: (runId: string) => Promise<void>
  rest: ChatRest
  rpc: ChatRpcLike
}

export function newEngineState(): EngineState {
  return {
    turns: [],
    loading: false,
    connectionState: 'closed',
    activeRunId: null,
    status: 'idle',
    activeRun: null
  }
}

/** status 写入助手:loading ≙ status === 'streaming',两处同步免漂移。 */
export function setStatus(state: EngineState, value: string) {
  state.status = value
  state.loading = value === 'streaming'
}

/** 活动运行写入助手:activeRun 与 activeRunId 恒同步。 */
export function setActiveRun(state: EngineState, run: any) {
  state.activeRun = run ?? null
  state.activeRunId = run?.runId ?? null
}

/**
 * 单条 Run 事件应用到引擎状态。
 * 源语义:handleRunEvent 只处理活动 run 的事件(守卫在 engine.ts 的订阅回调里,
 * headless 直调无守卫);轮次按信封 runId 定位,找不到时退回最后一轮。
 */
export function applyEvent(state: EngineState, envelope: RunEventEnvelope | null | undefined, cb: ChatEngineDeps): void {
  const event = envelope?.event
  if (!event?.type) return
  const turn = turnForRun(state, envelope?.runId)
  if (!turn) return
  turn.lastEventSeq = envelope?.seq || turn.lastEventSeq || 0

  // 渠道工具在浏览器侧执行时也要知道它属于哪个会话。截图上传工作区必须取
  // 运行事件信封里的 sessionId，不能依赖用户此刻在界面上选中的会话。
  let ev = event
  if (ev.type === EVENT_TYPES.TOOL_CALL_REQUEST && !ev.sessionId && envelope?.sessionId) {
    ev = { ...ev, sessionId: envelope.sessionId }
  }

  switch (ev.type) {
    case EVENT_TYPES.RUN_STATUS: {
      turn.runStatus = ev.status
      // 源:activeRun.value.status = event.status(有活动 run 守卫;headless 直调需判空)
      if (state.activeRun) state.activeRun.status = ev.status
      return
    }
    case EVENT_TYPES.DONE: {
      turn.runStatus = ev.status || 'SUCCEEDED'
      if (typeof ev.text === 'string') setFinalText(turn, ev.text)
      if (ev.usage) turn.usage = { ...ev.usage, usageSource: '0' }
      completeTurnState(state, turn, 'done')
      return
    }
    case EVENT_TYPES.ERROR: {
      turn.runStatus = ev.status || 'FAILED'
      turn.terminalMessage = ev.message || '对话执行失败'
      completeTurnState(state, turn, 'error')
      return
    }
    case EVENT_TYPES.CANCELLED: {
      turn.runStatus = 'CANCELLED'
      turn.terminalMessage = ev.message || '已停止生成'
      completeTurnState(state, turn, 'cancelled')
      return
    }
    case EVENT_TYPES.INTERRUPTED: {
      turn.runStatus = 'INTERRUPTED'
      turn.terminalMessage = ev.message || '执行节点中断，可重新发起'
      completeTurnState(state, turn, 'interrupted')
      return
    }
  }
  applyTurnEvent(state, turn, ev, envelope, cb)
}

/** 信封 runId 定位轮次(runId 直配或 userMsg.runId),找不到退回最后一轮;无轮可落则忽略。 */
function turnForRun(state: EngineState, runId?: string): TimelineTurn | null {
  if (runId) {
    const index = state.turns.findIndex(item => item.runId === runId || item.userMsg?.runId === runId)
    if (index >= 0) return state.turns[index]
  }
  return state.turns.length ? state.turns[state.turns.length - 1] : null
}

/** 源 completeActive 的状态半段:finishTurn + status/loading 收口 + 活动运行清空。 */
export function completeTurnState(state: EngineState, turn: TimelineTurn, nextStatus: string) {
  finishTurn(turn)
  setStatus(state, nextStatus)
  setActiveRun(state, null)
}

export function finishTurn(turn: TimelineTurn) {
  turn.completed = true
  clearStreaming(turn.steps)
}

function setFinalText(turn: TimelineTurn, text: string) {
  let content = [...(turn.steps || [])].reverse()
    .find(item => item.type === STEP_TYPES.CONTENT && item.stepId === 'answer')
  if (!content) {
    content = { type: STEP_TYPES.CONTENT, stepId: 'answer', text: '', streaming: false }
    turn.steps.push(content)
  }
  content.text = text
  content.streaming = false
}

function clearStreaming(steps?: TimelineStep[] | null) {
  for (const step of steps || []) {
    step.streaming = false
    if (step.steps?.length) clearStreaming(step.steps)
  }
}

// 归属键优先调用实例 invId(同一子 agent 一轮被调多次互不串卡),兼容旧事件的 agentCode
function findAgentStep(steps: TimelineStep[] | null | undefined, key?: string | null): TimelineStep | null {
  for (const step of steps || []) {
    if (step.type === STEP_TYPES.AGENT && (step.invId === key || step.agentCode === key)) return step
    const found = step.steps ? findAgentStep(step.steps, key) : null
    if (found) return found
  }
  return null
}

function findStepById(steps: TimelineStep[] | null | undefined, stepId?: string | null): TimelineStep | null {
  if (!stepId) return null
  for (const step of steps || []) {
    if (step.stepId === stepId) return step
    const found = step.steps ? findStepById(step.steps, stepId) : null
    if (found) return found
  }
  return null
}

/**
 * UI 产物不进时间线。先按 name 挂到产出工具(扩展点),再按 name 分发展示。
 * eventId 去重,回放不会叠两份。未知 name / 过高 schema 直接丢弃。
 */
function applyUiEvent(turn: TimelineTurn, event: any) {
  if (!isSupportedUiArtifact(event)) return
  const eventId = event.eventId || event.stepId
  if (!turn.uiEventIds) turn.uiEventIds = new Set()
  const seen = eventId && turn.uiEventIds.has(eventId)
  if (eventId) turn.uiEventIds.add(eventId)

  const payload = event.payload || {}
  const producerId = event.parentStepId
  const tool = producerId ? findStepById(turn.steps, producerId) : null
  if (tool) {
    if (!tool.uiArtifacts) tool.uiArtifacts = {}
    tool.uiArtifacts[event.name!] = payload
  }
  if (event.name === UI_ARTIFACT_NAMES.KB_REFERENCES) {
    applyKbReferences(turn, payload)
  } else if (event.name === UI_ARTIFACT_NAMES.RUN_TOKEN_USAGE) {
    applyTokenUsage(turn, payload)
  } else if (event.name === UI_ARTIFACT_NAMES.WORKSPACE_CHANGES) {
    if (!seen) applyWorkspaceChanges(turn, payload)
  } else if (seen) {
    return
  }
}

function applyWorkspaceChanges(turn: TimelineTurn, payload: any) {
  const files = Array.isArray(payload?.files) ? payload.files : []
  turn.workspaceChanges = mergeWorkspaceChanges(turn.workspaceChanges, files)
  turn.workspaceChangesTruncated = !!(turn.workspaceChangesTruncated || payload?.truncated)
}

function applyTokenUsage(turn: TimelineTurn, payload: any) {
  if (!payload) return
  // 源不写 modelName 键(turn.usage 为空时结果里该键不存在);cast 仅为 TS 适配,运行时形状与源一致
  turn.usage = {
    ...(turn.usage || {}),
    promptTokens: Number(payload.promptTokens) || 0,
    completionTokens: Number(payload.completionTokens) || 0,
    totalTokens: Number(payload.totalTokens) || 0,
    callCount: Number(payload.callCount) || 0,
    usageSource: '0'
  } as TimelineUsage
}

function applyKbReferences(turn: TimelineTurn, payload: any) {
  const files: any[] = Array.isArray(payload?.files) ? payload.files : []
  turn.citationFiles = files
  turn.citationCount = Number(payload?.fileCount) || files.length
  turn.citationTotal = turn.citationCount
  turn.citationChunkCount = Number(payload?.chunkCount) || 0
  turn.citations = files.flatMap(f => f && f.chunks ? f.chunks : [])
}

/** 危险工具人工确认(bash 等)。源取 activeRun.value?.runId,移植后由调用点传 runId。 */
export function promptToolConfirm(runId: string | null | undefined, event: any, cb: ChatEngineDeps) {
  const confirmId = event?.confirmId
  if (!runId || !confirmId) return
  const name = event.name || '工具'
  let argsPreview = String(event.args || '')
  if (argsPreview.length > 280) argsPreview = argsPreview.slice(0, 280) + '…'
  const send = (approved: boolean) => cb.sendToolConfirm(runId, confirmId, approved).catch(() => {})
  // 源(desktop):confirmDanger(...).then(ok => confirmChatTool(runId, confirmId, !!ok).catch(() => {})) —— 只处理 then。
  // 三端合并统一:onToolConfirm resolve false(ruoyi-ui 取消/关闭分支)或 reject 时,
  // 也必须回传 sendToolConfirm(runId, confirmId, false),否则工具线程在后端挂起到渠道超时。
  cb.onToolConfirm({ name, argsPreview }).then(send, () => send(false))
}

export function promptPendingConfirms(steps: TimelineStep[] | null | undefined, runId: string | null | undefined, cb: ChatEngineDeps) {
  for (const step of steps || []) {
    if (step.type === STEP_TYPES.TOOL && step.pendingConfirm && step.confirmId) {
      promptToolConfirm(runId, step, cb)
    }
    if (step.steps?.length) promptPendingConfirms(step.steps, runId, cb)
  }
}

function targetSteps(turn: TimelineTurn, owner?: string | null): TimelineStep[] {
  if (!owner) return turn.steps
  const agent = findAgentStep(turn.steps, owner)
  if (!agent) return turn.steps
  if (!agent.steps) agent.steps = []
  return agent.steps
}

/** 源 applyEvent(turn, event) 的全部事件分支(逐字,仅注入 cb)。 */
function applyTurnEvent(state: EngineState, turn: TimelineTurn, event: any, envelope: RunEventEnvelope | null | undefined, cb: ChatEngineDeps) {
  if (!event?.type) return
  const parentStepId = event.parentStepId || event.owner
  const steps = targetSteps(turn, parentStepId)
  const stepId = event.stepId || event.toolCallId || event.invId
  switch (event.type) {
    case EVENT_TYPES.REASONING: {
      let step = findStepById(turn.steps, stepId)
      if (!step) {
        step = { type: STEP_TYPES.REASONING, stepId, parentStepId, text: '', streaming: true }
        steps.push(step)
      }
      step.text = (step.text || '') + (event.text || '')
      break
    }
    case EVENT_TYPES.TOOL_CALL_REQUEST: {
      // 源:turn.runId || activeRun.value?.runId;headless 直调时以信封 runId 兜底
      const runId = turn.runId || state.activeRunId || envelope?.runId
      cb.clientTools?.handleToolCallRequest(runId!, event)
      break
    }
    case EVENT_TYPES.TOOL_CONFIRM_REQUIRED: {
      let step: TimelineStep | null = findStepById(turn.steps, stepId)
      if (!step) {
        // 源字面量不含 streaming 字段,由下方 Object.assign 补齐;此 cast 仅为 TS 适配,运行时形状与源一致
        step = { type: STEP_TYPES.TOOL, stepId, parentStepId } as TimelineStep
        steps.push(step)
      }
      Object.assign(step, {
        name: event.name || '', source: event.source || 'builtin',
        args: event.args || '', result: '', ok: true, ms: 0, streaming: true,
        pendingConfirm: true, confirmId: event.confirmId || ''
      })
      // 弹窗确认:工具线程在后端阻塞等待,用户点允许/拒绝后唤醒
      promptToolConfirm(state.activeRunId || envelope?.runId, event, cb)
      break
    }
    case EVENT_TYPES.CONTEXT_CLEANED: {
      // 不插入过程步骤,避免时间线噪音;用一条轻量提示标在最后一步旁
      const note = {
        type: STEP_TYPES.SUMMARY,
        text: `已精简早期工具记录（约 ${event.tokensBefore || '?'} → ${event.tokensAfter || '?'} token，清 ${event.pairsCleared || 0} 对）`,
        streaming: false
      }
      steps.push(note)
      break
    }
    case EVENT_TYPES.TOOL_START: {
      let step: TimelineStep | null = findStepById(turn.steps, stepId)
      if (!step) {
        step = { type: STEP_TYPES.TOOL, stepId, parentStepId, result: '', ok: true, ms: 0 } as TimelineStep
        steps.push(step)
      }
      Object.assign(step, {
        name: event.name || step.name || '', source: event.source || step.source || 'builtin',
        args: event.args || step.args || '', streaming: true
      })
      break
    }
    case EVENT_TYPES.TOOL_END: {
      let step: TimelineStep | null = findStepById(turn.steps, stepId)
      if (!step) {
        step = { type: STEP_TYPES.TOOL, stepId, parentStepId, name: event.name || '' } as TimelineStep
        steps.push(step)
      }
      Object.assign(step, {
        args: event.args || step.args || '', result: event.result || '', ok: event.ok !== false,
        ms: event.ms || 0, pendingConfirm: false, streaming: false,
        source: event.source || step.source || 'builtin',
        attachments: parseToolAttachments(event.attachments)
      })
      break
    }
    case EVENT_TYPES.UI: {
      applyUiEvent(turn, event)
      break
    }
    case EVENT_TYPES.AGENT_START: {
      let step: TimelineStep | null = findStepById(turn.steps, stepId)
      if (!step) {
        step = { type: STEP_TYPES.AGENT, stepId, parentStepId, steps: [] as TimelineStep[] } as TimelineStep
        steps.push(step)
      }
      Object.assign(step, {
        name: event.name || '', agentCode: event.agentCode || '',
        invId: event.invId || stepId || '',
        result: '', ok: true, ms: 0, streaming: true, steps: step.steps || []
      })
      break
    }
    case EVENT_TYPES.AGENT_END: {
      let step: TimelineStep | null = findStepById(turn.steps, stepId)
      if (!step) {
        step = { type: STEP_TYPES.AGENT, stepId, parentStepId, name: event.name || '', steps: [] as TimelineStep[] } as TimelineStep
        steps.push(step)
      }
      step.result = event.result || ''
      step.ok = event.ok !== false
      step.ms = event.ms || 0
      step.streaming = false
      if (step.steps?.length) clearStreaming(step.steps)
      break
    }
    case EVENT_TYPES.TEXT: {
      if (parentStepId) {
        const agent = findAgentStep(turn.steps, stepId || parentStepId)
        if (agent) {
          agent.result = (agent.result || '') + (event.text || '')
          for (const item of agent.steps || []) {
            if (item.type === STEP_TYPES.REASONING) item.streaming = false
          }
        }
        break
      }
      for (const item of steps) {
        if (item.type === STEP_TYPES.REASONING) item.streaming = false
      }
      let content = findStepById(turn.steps, stepId || 'answer')
      if (!content) {
        content = { type: STEP_TYPES.CONTENT, stepId: stepId || 'answer', text: '', streaming: true }
        steps.push(content)
      }
      content.text = (content.text || '') + (event.text || '')
      content.streaming = true
      break
    }
  }
}

/** tool_end 事件里的附件：与历史消息 parseAttachments 同语义。 */
export function parseToolAttachments(raw: any): TimelineAttachments | null {
  if (!raw) return null
  if (Array.isArray(raw)) return raw.length ? raw : null
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) && arr.length ? arr : null
  } catch (_) {
    return null
  }
}

export function cleanUserText(text: any): string {
  const marker = '\n\n[本次上传的文件'
  const index = String(text || '').indexOf(marker)
  return index >= 0 ? String(text).slice(0, index) : String(text || '')
}

export function readableError(error: any): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error !== 'error') return error
  return '对话执行失败，请重试'
}
