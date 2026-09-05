/**
 * createChatEngine:useChatRun composable 的无头状态机外壳。
 *
 * 移植自 desktop/src/composables/useChatRun.js。与源的唯一结构性变换:
 * - Vue ref/composable 生命周期 → newEngineState() 纯对象 + destroy()(onBeforeUnmount 等价物)
 *   + subscribe()/notify() 变更通知(每个 mutating 方法末尾调 notify());
 * - 模块单例依赖(chatRpc、REST 函数、clientTools)→ createChatEngine(client, options) 构造注入,
 *   内部收敛为一份 ChatEngineDeps 传给 applyEvent;
 * - 判定口径:活动运行一律以 state.activeRunId 为准(setActiveRun 保持 state.activeRun 对象
 *   同步,仅作展示镜像;源全部读取点只消费 runId/存在性);
 * - send 的首轮 clientTools 清单捎带(declarePayloadFor/markDeclared)取自
 *   extension/src/composables/useChatRun.js 同名段(desktop 此处尚未同步该段,语义以
 *   docs/渠道工具与浏览器插件.md 为准),skillIds 盖章与 replaceRunTurn 的
 *   workspaceChanges/citations/skillIds 接力为 desktop 线上修复,逐字保留。
 *
 * resume/recoverRunGap/handleRunSnapshot/reconcileRun 内的局部变量 `state`(REST state 载荷)
 * 改名 runState,避免遮蔽引擎 state;其余逻辑逐字。
 *
 * 源中不移植(归属清单,无静默丢弃):
 * - confirmDanger/ElMessageBox、toast/ElMessage 的 UI 本体 → onToolConfirm/onNotice 构造注入;
 * - Vue ref 声明/onBeforeUnmount/对外 ref 返回 → newEngineState()/destroy()/subscribe()+notify();
 * - newTurn/buildTurns/collectKbCitationState/parseAttachments → engine/timeline.ts(Task 8 已移植);
 * - isTerminal/terminalLabel → protocol/status.ts 逐字同文(isTerminalRunStatus/terminalRunLabel)。
 */
import { EVENT_TYPES, STEP_TYPES, UI_ARTIFACT_NAMES } from '../protocol/eventTypes.js'
import { isTerminalRunStatus, terminalRunLabel } from '../protocol/status.js'
import { buildTurns, collectKbCitationState, newTurn, type TimelineStep, type TimelineTurn } from './timeline.js'
import { mergeWorkspaceChanges } from './workspaceChanges.js'
import {
  applyEvent, cleanUserText, completeTurnState, finishTurn, newEngineState, parseToolAttachments,
  promptPendingConfirms, readableError, setActiveRun, setStatus,
  type ChatEngineDeps, type ChatRpcLike, type EngineState
} from './applyEvent.js'
import type { ChatRest } from '../rest/chatRest.js'
import type { ClientToolRegistry } from '../clientTools/registry.js'

/**
 * createChatEngine 用到的 ChatRpcClient 结构子集:见 applyEvent.ts 的 ChatRpcLike
 * (deps 契约的一部分,单一定义避免两文件循环依赖)。
 */
export type { ChatRpcLike } from './applyEvent.js'

/** createChatEngine 的宿主注入:desktop 模块单例(chatRpc/REST/clientTools)的构造化替身。 */
export interface ChatEngineClient {
  rest: ChatRest
  rpc: ChatRpcLike
  clientTools?: ClientToolRegistry | null
}

/** 源 useChatRun(options) 的回调 + desktop confirmDanger/toast 的注入化。 */
export interface ChatEngineOptions {
  onToolConfirm?: (info: { name: string; argsPreview: string }) => Promise<boolean>
  onNotice?: (message: string, type?: 'info' | 'warning' | 'error') => void
  onDone?: (event: any) => void
  onError?: (error: Error) => void
  onEvent?: (event: any, envelope: any) => void
  onConnectionState?: (state: string) => void
  onRemoteTurn?: (sessionId: string) => void
}

export interface ChatEngine {
  state: EngineState
  send(message: string, payload?: any): Promise<any>
  resume(run: any): Promise<any>
  recoverSession(sessionId: string): Promise<any>
  watchSession(sessionId: string): Promise<void>
  reconcileRun(run: any): Promise<void>
  setTurns(turns?: TimelineTurn[] | null): void
  detach(): void
  abort(): Promise<void>
  /** 状态变更通知(新写):headless 下替代 Vue 响应式,同步推送 state 快照引用 */
  subscribe(listener: (state: EngineState) => void): () => void
  /** onBeforeUnmount 等价物:detach + 退订会话 + 释放长连接 + 摘除连接监听 */
  destroy(): void
}

const TERMINAL_EVENT_TYPES = [EVENT_TYPES.DONE, EVENT_TYPES.ERROR, EVENT_TYPES.CANCELLED, EVENT_TYPES.INTERRUPTED]

/**
 * 持久化对话运行引擎。
 * 页面只订阅 run；刷新、切页、WebSocket 重连都不会拥有或终止后端 Agent 生命周期。
 */
export function createChatEngine(client: ChatEngineClient, options: ChatEngineOptions = {}): ChatEngine {
  const state = newEngineState()
  /** 引擎内部收敛出的回调依赖包:applyEvent 与全部方法共用一份。 */
  const deps: ChatEngineDeps = {
    // 未提供确认 UI 时默认拒绝(false → confirmChatTool(false)),不让工具线程挂起。
    onToolConfirm: info => options.onToolConfirm ? options.onToolConfirm(info) : Promise.resolve(false),
    onNotice: (message, type) => { options.onNotice?.(message, type) },
    clientTools: client.clientTools ?? null,
    // 确认回传失败吞掉:这一轮的挂起态在服务端,本页抛出去也没人接(源调用点 .catch(() => {}) 同义)。
    sendToolConfirm: (runId, confirmId, approved) =>
      client.rest.confirmChatTool(runId, confirmId, approved).then(() => undefined, () => undefined),
    // 契约类型为 Promise<void>;engine 自身按移植规则 4 走 cb.rest.cancelChatRun 取原始响应。
    cancelRun: runId => client.rest.cancelChatRun(runId).then(() => undefined),
    rest: client.rest,
    rpc: client.rpc
  }
  let currentTurn: TimelineTurn | null = null
  let reconcileTimer: ReturnType<typeof setInterval> | null = null
  let reconciliationPending = false
  let viewGeneration = 0
  let pendingCreate: { cancelRequested: boolean } | null = null
  let watchedSessionId: string | null = null
  // 本页已经自己挂载过的 run。终态在 run 通道和会话通道上会各来一次，
  // 没有这层记录就会在自己发完消息后又整表重建一遍，白闪一下。
  const handledRunIds = new Set<string>()
  const listeners = new Set<(state: EngineState) => void>()

  function notify() {
    for (const listener of listeners) listener(state)
  }

  const removeConnectionListener = client.rpc.onConnectionState(connectionState => {
    state.connectionState = connectionState
    options.onConnectionState && options.onConnectionState(connectionState)
    // 连接中断不代表运行失败；保留 streaming，重连后会从 last seq 回放。
    if (state.activeRunId && (connectionState === 'reconnecting' || connectionState === 'connecting')) {
      setStatus(state, 'streaming')
    }
  })

  // 监听器注册后立刻建连：刷新页面时即使没有活动 run 也要在线，
  // 否则连接要等到下一次发送才懒建立，指示灯也无从反映真实状态。
  const releaseConnection = client.rpc.retain()

  /** 有界记录，避免长会话下无限增长。 */
  function rememberHandledRun(runId?: string | null) {
    if (!runId) return
    handledRunIds.add(runId)
    if (handledRunIds.size > 50) handledRunIds.delete(handledRunIds.values().next().value!)
  }

  function setTurns(nextTurns?: TimelineTurn[] | null) {
    detach()
    state.turns = nextTurns || []
    setStatus(state, 'idle')
    notify()
  }

  async function send(message: string, payload?: any) {
    if (state.activeRunId || pendingCreate) return
    const targetGeneration = viewGeneration
    state.turns.push(newTurn(message, payload?.attachments))
    // 源注:必须取数组里的响应式代理(Vue 专属理由);headless 下同位取数组尾部引用,行为一致。
    const turn = state.turns[state.turns.length - 1]
    currentTurn = turn
    // 发出去的瞬间就把本轮技能盖章在 turn 上:实时路径不经过 applyRunStates
    // (那个只在时间线加载时跑),而「重新生成」要复现这一轮当时用的技能。
    // 必须拷贝一份:chat.skillIds 发送成功后会被清空,持引用会被连带清掉。
    turn.skillIds = Array.isArray(payload?.skillIds) ? [...payload.skillIds] : []
    turn.runStatus = 'QUEUED'
    setStatus(state, 'streaming')

    // 新会话的第一轮：declare 还发不出去（服务端要求会话已存在），
    // 而这一轮就在落库的同一次调用里装配。清单捎在这里，服务端会在装配前写进会话行。
    const firstTurnDeclare = deps.clientTools?.declarePayloadFor(payload?.sessionId) || null
    const request = {
      ...payload,
      ...(firstTurnDeclare || {}),
      clientRequestId: payload?.clientRequestId || generateId()
    }
    const createAttempt = { cancelRequested: false }
    pendingCreate = createAttempt
    try {
      const response = await deps.rest.createChatRun(request)
      if (firstTurnDeclare) deps.clientTools?.markDeclared(payload?.sessionId)
      // 用户已切到别的会话：运行仍在后端继续，但旧回调不能污染新页面。
      if (targetGeneration !== viewGeneration) return response.data
      return await attachCreatedRun(response.data, turn, createAttempt, targetGeneration)
    } catch (error) {
      if (targetGeneration !== viewGeneration) return null
      // 两个页面并发发送时唯一活动键会拒绝后到请求；恢复真实活动 run，而不是留下假消息。
      try {
        const activeResponse = await deps.rest.getActiveChatRun(payload.sessionId)
        if (targetGeneration !== viewGeneration) return activeResponse.data || null
        if (activeResponse.data) {
          const optimistic = state.turns.indexOf(turn)
          if (optimistic >= 0) state.turns.splice(optimistic, 1)
          await resume(activeResponse.data)
          if (createAttempt.cancelRequested) await abort()
          return activeResponse.data
        }
      } catch (_) {
        // 下面按原始错误收尾
      }
      if (targetGeneration !== viewGeneration) return null
      turn.runStatus = 'FAILED'
      turn.terminalMessage = readableError(error)
      finishTurn(turn)
      setStatus(state, 'error')
      options.onError && options.onError(new Error(turn.terminalMessage))
      return null
    } finally {
      if (pendingCreate === createAttempt) pendingCreate = null
      notify()
    }
  }

  /** 创建请求返回前收到停止意图时，优先取消，再决定是否还需要订阅最终状态。 */
  async function attachCreatedRun(run: any, turn: TimelineTurn, createAttempt: { cancelRequested: boolean }, targetGeneration: number) {
    if (!createAttempt.cancelRequested) {
      await attach(run, turn, 0)
      return run
    }

    let snapshot = run
    try {
      const response = await deps.rest.cancelChatRun(run.runId)
      snapshot = response.data || run
    } catch (error) {
      options.onError && options.onError(new Error(readableError(error)))
    }
    // 取消请求仍然有效，但用户已经切走时不能把旧运行重新挂回新视图。
    if (targetGeneration !== viewGeneration) return snapshot
    if (!isTerminalRunStatus(snapshot.status)) {
      await attach(snapshot, turn, 0)
      return snapshot
    }

    setActiveRun(state, snapshot)
    currentTurn = turn
    turn.runId = snapshot.runId
    turn.runStatus = snapshot.status
    await handleRunSnapshot(snapshot.runId, turn, snapshot)
    return snapshot
  }

  /** 切回/刷新会话时，先恢复一致性步骤快照，再从 snapshotSeq 增量回放。 */
  async function resume(run: any) {
    if (!run || isTerminalRunStatus(run.status)) return null
    detach()
    const targetGeneration = viewGeneration
    const response = await deps.rest.getChatRunState(run.runId)
    // 会话监听的 activeRun 回调与切换会话的主动查询可能同时命中同一轮。
    // 后发的恢复/切换拥有视图，旧请求返回后必须静默退出，不能重新挂回陈旧 turn。
    if (targetGeneration !== viewGeneration) return null
    const runState = response.data
    const snapshotRun = runState?.run || run
    const turn = turnFromRunState(runState, snapshotRun)
    const replaced = replaceRunTurn(turn, snapshotRun)
    currentTurn = replaced
    if (isTerminalRunStatus(snapshotRun.status)) {
      setStatus(state, 'idle')
      notify()
      return snapshotRun
    }
    await attach(snapshotRun, replaced, Number(runState?.snapshotSeq) || 0)
    if (targetGeneration !== viewGeneration) return null
    promptPendingConfirms(replaced.steps, state.activeRunId, deps)
    notify()
    return snapshotRun
  }

  async function recoverSession(sessionId: string) {
    const response = await deps.rest.getActiveChatRun(sessionId)
    if (response.data) await resume(response.data)
    notify()
    return response.data || null
  }

  /**
   * 监听整个会话：同一会话在另一个标签页/浏览器里发起新一轮时，本页据此实时跟上。
   * 切会话时调用，内部负责退订上一个会话。
   */
  async function watchSession(sessionId: string) {
    if (watchedSessionId === sessionId) return
    const previous = watchedSessionId
    watchedSessionId = sessionId || null
    if (previous) client.rpc.unsubscribeSession(previous).catch(() => {})
    if (!sessionId) return
    try {
      await client.rpc.subscribeSession(sessionId,
        (params: any) => handleSessionEvent(sessionId, params),
        (run: any) => adoptRemoteRun(sessionId, run))
    } catch (_) {
      // 断线时订阅留在客户端注册表里，重连后会自动补订。
    }
  }

  function handleSessionEvent(sessionId: string, params: any) {
    if (watchedSessionId !== sessionId) return
    const runId = params?.runId
    const type = params?.event?.type
    if (!runId || !type) return
    // 本页已经在管这一轮(正在跑、或刚跑完)，会话通道上的同一条通知要忽略：
    // 否则不但会重复插入用户消息，自己发完消息后还会被终态通知触发一次整表重建。
    // pendingCreate 覆盖「已发出创建请求、还没拿到 runId」的窗口。
    if (pendingCreate || state.activeRunId === runId || handledRunIds.has(runId)) return
    if (type === 'run_status' && !isTerminalRunStatus(params.event.status)) {
      adoptRemoteRun(sessionId, { runId })
      return
    }
    if (['done', 'error', 'cancelled', 'interrupted'].includes(type)) {
      // 别处结束了一轮而本页没跟上(例如刚切进来)：以消息事实表为准重建。
      options.onRemoteTurn && options.onRemoteTurn(sessionId)
    }
  }

  /** 挂载一轮由别处发起的运行：补齐 run 快照后按常规 resume 流程重建并订阅。 */
  async function adoptRemoteRun(sessionId: string, run: any) {
    if (watchedSessionId !== sessionId || pendingCreate) return
    if (!run?.runId || state.activeRunId === run.runId || handledRunIds.has(run.runId)) return
    try {
      const snapshot = run.status ? run : (await deps.rest.getChatRun(run.runId)).data
      if (watchedSessionId !== sessionId || pendingCreate) return
      if (!snapshot || isTerminalRunStatus(snapshot.status)) {
        options.onRemoteTurn && options.onRemoteTurn(sessionId)
        return
      }
      if (state.activeRunId === snapshot.runId) return
      await resume(snapshot)
    } catch (_) {
      // 拉不到快照就交给会话终态通知兜底，不打断本页已有内容。
    }
  }

  /** 没有活动运行时，用最近终态修正“只有 USER、没有 ASSISTANT”的历史轮，杜绝永久处理中。 */
  async function reconcileRun(run: any) {
    if (!run || !isTerminalRunStatus(run.status)) return
    const response = await deps.rest.getChatRunState(run.runId)
    const runState = response.data
    // 清空记忆/回滚后 Run 事实仍保留用于统计，但它已不再代表一条可展示消息。
    if (!runState?.userMessage && !runState?.finalMessage && !(runState?.steps || []).length) return
    replaceRunTurn(turnFromRunState(runState, runState?.run || run), runState?.run || run)
    setStatus(state, 'idle')
    notify()
  }

  function replaceRunTurn(turn: TimelineTurn, run: any): TimelineTurn {
    let index = state.turns.findIndex(item => item.runId === run.runId || item.userMsg?.runId === run.runId)
    if (index < 0) {
      const lastIndex = state.turns.length - 1
      const last = state.turns[lastIndex]
      if (last && !last.completed && cleanUserText(last.userMsg?.content || '') === (run.inputText || '')) {
        index = lastIndex
      }
    }
    if (index >= 0) {
      const existing = state.turns[index]
      if (existing) {
        if ((!turn.workspaceChanges || !turn.workspaceChanges.length) && existing.workspaceChanges?.length) {
          turn.workspaceChanges = existing.workspaceChanges
          turn.workspaceChangesTruncated = existing.workspaceChangesTruncated
        }
        if ((!turn.citations || !turn.citations.length) && existing.citations?.length) {
          turn.citations = existing.citations
          turn.citationFiles = existing.citationFiles
          turn.citationTotal = existing.citationTotal
          turn.citationCount = existing.citationCount
          turn.citationChunkCount = existing.citationChunkCount
        }
        // 本轮技能快照只存在于前端(ChatRunView 不下发 effective_skill_ids),
        // 这里整个对象被 splice 换掉,不接力就会丢,「重新生成」又拿不到技能了。
        if (!turn.skillIds && existing.skillIds) turn.skillIds = existing.skillIds
      }
      state.turns.splice(index, 1, turn)
    } else {
      state.turns.push(turn)
      index = state.turns.length - 1
    }
    return state.turns[index]
  }

  async function attach(run: any, turn: TimelineTurn, afterSeq: number) {
    if (!run) throw new Error('创建运行失败')
    rememberHandledRun(run.runId)
    setActiveRun(state, run)
    currentTurn = turn
    turn.runId = run.runId
    turn.runStatus = run.status
    setStatus(state, 'streaming')
    // 先启动控制面兜底；即使 WebSocket 握手被网络设备挂起也能恢复终态。
    startReconcilePolling(run.runId, turn)
    try {
      await client.rpc.subscribe(run.runId, afterSeq, (event, envelope) => {
        handleRunEvent(run.runId, turn, event, envelope)
      }, snapshot => {
        handleRunSnapshot(run.runId, turn, snapshot).catch(() => {})
      }, gap => {
        return recoverRunGap(run.runId, turn, gap)
      })
    } catch (_) {
      // 订阅仍保留在客户端注册表中，后续会自动重连；不能把 Agent 标为失败。
      // connectionState 只由 WebSocket 自身驱动；单次订阅失败不等于物理连接断开。
    }
    notify()
  }

  /**
   * 实时序号出现缺口时，以持久化步骤快照替换当前过程视图并返回新的续传游标。
   * 快照尚未推进时返回旧游标，RPC 层会退避重试，不会把数据缺口误报成连接断开。
   */
  async function recoverRunGap(runId: string, turn: TimelineTurn, gap: any) {
    if (state.activeRunId !== runId) return null
    const response = await deps.rest.getChatRunState(runId)
    const runState = response.data
    const snapshotSeq = Number(runState?.snapshotSeq) || 0
    const appliedSeq = Math.max(Number(gap?.afterSeq) || 0, Number(turn.lastEventSeq) || 0)
    if (snapshotSeq <= appliedSeq) return snapshotSeq
    if (state.activeRunId !== runId) return null

    const run = runState?.run || state.activeRun
    const restored = turnFromRunState(runState, run)
    Object.assign(turn, restored)
    setActiveRun(state, { ...state.activeRun, ...run })
    if (isTerminalRunStatus(run.status)) {
      await handleRunSnapshot(runId, turn, runState)
    }
    return snapshotSeq
  }

  /**
   * 数据库运行状态是控制面的事实源。WebSocket/Redis 负责低延迟与过程回放，
   * 这里的低频对账兜住终态事件丢失，保证页面不会永久停在执行中。
   */
  function startReconcilePolling(runId: string, turn: TimelineTurn) {
    stopReconcilePolling()
    reconcileTimer = setInterval(async () => {
      if (reconciliationPending || state.activeRunId !== runId) return
      reconciliationPending = true
      try {
        const response = await deps.rest.getChatRunState(runId)
        await handleRunSnapshot(runId, turn, response.data)
      } catch (_) {
        // 网络恢复后下一轮继续；连接异常本身不改变运行状态。
      } finally {
        reconciliationPending = false
      }
    }, 5000)
  }

  function stopReconcilePolling() {
    if (reconcileTimer) clearInterval(reconcileTimer)
    reconcileTimer = null
  }

  async function handleRunSnapshot(runId: string, turn: TimelineTurn, snapshot: any) {
    if (!snapshot || state.activeRunId !== runId) return
    // REST state 返回 {run,steps,...}；WebSocket 控制面返回裸 run。
    let runState = snapshot.run ? snapshot : null
    let run = snapshot.run || snapshot
    setActiveRun(state, { ...state.activeRun, ...run })
    turn.runStatus = run.status
    if (!isTerminalRunStatus(run.status)) {
      notify()
      return
    }

    stopReconcilePolling()
    if (!runState) {
      try { runState = (await deps.rest.getChatRunState(runId)).data } catch (_) { /* done 事件正文仍可兜底 */ }
    }
    if (runState) {
      const restored = turnFromRunState(runState, runState.run || run)
      Object.assign(turn, restored)
      run = runState.run || run
    }
    if (run.status === 'SUCCEEDED') {
      if (state.activeRunId !== runId) return
      completeActive(turn, 'done', {
        type: EVENT_TYPES.DONE,
        status: run.status,
        recovered: true
      })
      notify()
      return
    }

    turn.terminalMessage = run.errorMessage || terminalRunLabel(run.status)
    const type = run.status === 'CANCELLED'
      ? EVENT_TYPES.CANCELLED
      : run.status === 'INTERRUPTED' ? EVENT_TYPES.INTERRUPTED : EVENT_TYPES.ERROR
    completeActive(turn, type, {
      type,
      status: run.status,
      message: turn.terminalMessage,
      recovered: true
    })
    if (run.status === 'FAILED' || run.status === 'INTERRUPTED') {
      options.onError && options.onError(new Error(turn.terminalMessage))
    }
    notify()
  }

  /** 订阅回调:活动 run 守卫 + onEvent 转发 + applyEvent(状态半段,含终态收口) + 订阅清理。 */
  function handleRunEvent(runId: string, turn: TimelineTurn, event: any, envelope: any) {
    if (!state.activeRunId || state.activeRunId !== runId) return
    // 源在 onEvent 前记账;applyEvent 内部亦记同一表达式(headless 直调兜底),此处保留源顺序
    turn.lastEventSeq = envelope?.seq || turn.lastEventSeq || 0
    options.onEvent && options.onEvent(event, envelope)
    applyEvent(state, { ...envelope, event }, deps)
    notify()
    if (!TERMINAL_EVENT_TYPES.includes(event.type)) return
    // 源 completeActive 的订阅/回调半段(状态半段已在 applyEvent 的终态分支收口)
    stopReconcilePolling()
    if (runId) client.rpc.unsubscribe(runId)
    currentTurn = null
    options.onDone && options.onDone(event)
    if (event.type === EVENT_TYPES.ERROR || event.type === EVENT_TYPES.INTERRUPTED) {
      options.onError && options.onError(new Error(turn.terminalMessage))
    }
  }

  /** 源 completeActive:状态半段(completeTurnState)+ 订阅清理 + onDone。快照/REST 兜底的终态收口走这里。 */
  function completeActive(turn: TimelineTurn, nextStatus: string, event: any) {
    const runId = state.activeRunId
    completeTurnState(state, turn, nextStatus)
    stopReconcilePolling()
    currentTurn = null
    if (runId) client.rpc.unsubscribe(runId)
    options.onDone && options.onDone(event)
  }

  /** 停止按钮是显式业务取消，不是关闭 WebSocket。 */
  async function abort() {
    // 源以 activeRun.value 为准;移植后判定收口到 activeRunId(二者由 setActiveRun 恒同步)
    const run = state.activeRun || (state.activeRunId ? { runId: state.activeRunId } : null)
    if (!run) {
      if (pendingCreate) {
        pendingCreate.cancelRequested = true
        if (currentTurn) currentTurn.runStatus = 'CANCELLING'
        notify()
      }
      return
    }
    try {
      const response = await deps.rest.cancelChatRun(run.runId)
      const cancelled = response?.data
      if (cancelled && isTerminalRunStatus(cancelled.status) && state.activeRunId) {
        currentTurn!.runStatus = cancelled.status
        currentTurn!.terminalMessage = cancelled.errorMessage || '已停止生成'
        completeActive(currentTurn!, 'cancelled', {
          type: EVENT_TYPES.CANCELLED,
          status: cancelled.status,
          message: currentTurn!.terminalMessage
        })
      }
    } catch (error) {
      options.onError && options.onError(new Error(readableError(error)))
    }
    notify()
  }

  /** 离开当前会话只退订，不取消后端运行。 */
  function detach() {
    viewGeneration += 1
    stopReconcilePolling()
    if (state.activeRunId) client.rpc.unsubscribe(state.activeRunId)
    pendingCreate = null
    setActiveRun(state, null)
    currentTurn = null
    setStatus(state, 'idle')
    notify()
  }

  function subscribe(listener: (state: EngineState) => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  /** 源 onBeforeUnmount 的等价物(Vue 生命周期不移植,收口为显式方法)。 */
  function destroy() {
    detach()
    if (watchedSessionId) client.rpc.unsubscribeSession(watchedSessionId).catch(() => {})
    watchedSessionId = null
    releaseConnection()
    removeConnectionListener()
    listeners.clear()
  }

  return {
    state,
    send,
    resume,
    recoverSession,
    watchSession,
    reconcileRun,
    setTurns,
    detach,
    abort,
    subscribe,
    destroy
  }
}

/** 后端 RunStep 快照 -> 前端步骤树。所有归属只按 stepId/parentStepId。 */
function turnFromRunState(state: any, run: any): TimelineTurn {
  const rows = Array.isArray(state?.steps) ? state.steps : []
  const byId = new Map<string, TimelineStep>()
  const ordered: TimelineStep[] = []
  for (const row of rows) {
    const step = snapshotStep(row, run?.sessionId)
    if (!step) continue
    byId.set(step.stepId!, step)
    ordered.push(step)
  }
  const roots: TimelineStep[] = []
  const uiSteps: TimelineStep[] = []
  const pendingWorkspacePayloads: any[] = []
  for (const step of ordered) {
    // parent !== step:节点不能是自己的父。放行的话它会被 push 进自己的 steps 而永远进不了
    // roots，该子智能体连同挂在它下面的工具一起从时间线消失（只在刷新/重进时暴露，
    // 实时路径按 owner 归位不建父指针树）。写入侧已收口，这里挡的是库里已存在的历史脏行。
    if (step.type === STEP_TYPES.UI) {
      uiSteps.push(step)
      continue
    }
    const parent = step.parentStepId ? byId.get(step.parentStepId) : null
    if (parent && parent !== step && parent.type === STEP_TYPES.AGENT) {
      if (!parent.steps) parent.steps = []
      parent.steps.push(step)
    } else {
      roots.push(step)
    }
  }
  for (const ui of uiSteps) {
    const parent = ui.parentStepId ? byId.get(ui.parentStepId) : null
    if (parent && parent.type === STEP_TYPES.TOOL) {
      if (!parent.uiArtifacts) parent.uiArtifacts = {}
      parent.uiArtifacts[ui.name!] = ui.payload
    }
    if (ui.name === UI_ARTIFACT_NAMES.WORKSPACE_CHANGES) {
      // 源此处直接写 turn.workspaceChanges,而 turn 在下方才 const 初始化——快照一旦含
      // workspace.changes 的 ui 步骤必抛 ReferenceError(desktop/extension 两份副本同病,
      // 且被订阅回调的 .catch(() => {}) 吞掉,静默丢恢复)。按意图移植为构建 turn 后归并。
      pendingWorkspacePayloads.push(ui.payload)
    }
  }

  const finalMessage = state?.finalMessage
  if (finalMessage) {
    let answer = roots.find(step => step.type === STEP_TYPES.CONTENT && step.stepId === 'answer')
    if (!answer) {
      answer = { type: STEP_TYPES.CONTENT, stepId: 'answer', text: '', streaming: false }
      roots.push(answer)
    }
    answer.text = finalMessage.content || ''
    answer.streaming = false
  }

  const user = state?.userMessage || {
    messageType: 'USER', messageKind: 'USER_INPUT', runId: run?.runId,
    content: run?.inputText || '', attachments: run?.attachments || null
  }
  const completed = isTerminalRunStatus(run?.status || '')
  const turn: TimelineTurn = {
    userMsg: user,
    runId: run?.runId || user.runId || null,
    runStatus: run?.status || 'RUNNING',
    lastEventSeq: Number(state?.snapshotSeq) || 0,
    steps: roots,
    completed,
    usage: usageFromMessage(finalMessage),
    attachments: parseToolAttachments(user.attachments),
    terminalMessage: completed && run?.status !== 'SUCCEEDED'
      ? (run?.errorMessage || terminalRunLabel(run?.status || '')) : null
  }
  // 快照内 workspace.changes ui 步骤的归并(见上方 uiSteps 循环的 TDZ 注记),与实时
  // applyWorkspaceChanges 同语义:合并进轮、truncated 只置位不清除。
  for (const payload of pendingWorkspacePayloads) {
    const files = Array.isArray(payload?.files) ? payload.files : []
    turn.workspaceChanges = mergeWorkspaceChanges(turn.workspaceChanges, files)
    turn.workspaceChangesTruncated = !!(turn.workspaceChangesTruncated || payload?.truncated)
  }
  // RunStep 快照没有「思考阶段结束」这个信号：后端只在整个 run 终态时才统一收口，
  // 运行中途 resume（刷新/重进正在跑的会话）拿到的 reasoning 行会一直是 STREAMING，
  // 哪怕模型早已经在吐正文或跑第 5 个工具——面板因此被强制展开。
  // 与实时路径（applyEvent 收到 TEXT/AGENT_END 时反向清空同级 REASONING.streaming）
  // 对齐同一条推导规则：同层只要出现别的产出，说明这轮思考已经翻篇。
  closeReasoningWithSiblings(turn.steps)

  // 终态恢复以 ai_chat_message 不可变事实账本为主，RunStep 快照为补充。
  // 这样即使某次实时投影更新丢失，重进会话也不会少工具调用；
  // 进行中仍以 RunStep 为主，保留流式 checkpoint 和待确认状态。
  if (completed && Array.isArray(state?.messages) && state.messages.length) {
    const ledgerTurns = buildTurns(state.messages)
    const ledger = ledgerTurns.find(item => item.runId === run?.runId || item.userMsg?.runId === run?.runId)
      || ledgerTurns[ledgerTurns.length - 1]
    if (ledger) {
      mergeStepTrees(ledger.steps, turn.steps)
      ledger.userMsg = ledger.userMsg || turn.userMsg
      ledger.runId = turn.runId
      ledger.runStatus = turn.runStatus
      ledger.lastEventSeq = turn.lastEventSeq
      ledger.completed = true
      ledger.usage = ledger.usage || turn.usage
      ledger.workspaceChanges = ledger.workspaceChanges?.length
        ? ledger.workspaceChanges : (turn.workspaceChanges || [])
      ledger.workspaceChangesTruncated = ledger.workspaceChangesTruncated
        || turn.workspaceChangesTruncated
      ledger.attachments = ledger.attachments || turn.attachments
      ledger.terminalMessage = turn.terminalMessage
      if (turn.citationFiles && turn.citationFiles.length) {
        ledger.citationFiles = turn.citationFiles
        ledger.citationCount = turn.citationCount
        ledger.citationTotal = turn.citationTotal
        ledger.citations = turn.citations
      } else {
        const ledgerRefs = collectKbCitationState(ledger.steps)
        ledger.citations = ledgerRefs.hits
        ledger.citationFiles = ledgerRefs.files
        ledger.citationTotal = ledgerRefs.files.length || ledgerRefs.total
      }
      return ledger
    }
  }
  if (!turn.citationFiles || !turn.citationFiles.length) {
    const refs = collectKbCitationState(turn.steps)
    turn.citations = refs.hits
    turn.citationFiles = refs.files
    turn.citationTotal = turn.citationCount || refs.files.length || refs.total
  }
  return turn
}

/**
 * 递归清掉「过时的思考中」：同一层（顶层 steps，或某个 agent 自己的 steps）
 * 只要存在非 REASONING 类型的节点，就说明这层的思考阶段已经结束——
 * 不管它当前的 streaming 字段（来自 RunStep 快照的原始 status）写的是什么。
 * 只有「这一层至今只有思考、什么产出都还没有」时才保留后端给的 streaming 值，
 * 那种情况下模型确实可能还卡在思考阶段。
 */
function closeReasoningWithSiblings(list?: TimelineStep[] | null) {
  if (!Array.isArray(list) || !list.length) return
  const hasOtherOutput = list.some(step => step.type !== STEP_TYPES.REASONING)
  for (const step of list) {
    if (step.type === STEP_TYPES.REASONING && hasOtherOutput) step.streaming = false
    if (step.steps?.length) closeReasoningWithSiblings(step.steps)
  }
}

/**
 * 以消息账本的步骤树为主，按 RunStep 的同层顺序补齐缺失节点。
 * 已有节点只补空字段，避免覆盖 messageId/完整工具结果标记等按需拉取信息。
 */
function mergeStepTrees(primary: TimelineStep[], fallback: TimelineStep[]) {
  function mergeLevel(target: TimelineStep[], source: TimelineStep[]) {
    for (let i = 0; i < (source || []).length; i++) {
      const candidate = source[i]
      let existing = target.find(item => item.stepId && item.stepId === candidate.stepId)
      if (!existing) {
        existing = { ...candidate, steps: [] }
        let insertAt = target.length
        for (let p = i - 1; p >= 0; p--) {
          const previous = target.findIndex(item => item.stepId === source[p].stepId)
          if (previous >= 0) {
            insertAt = previous + 1
            break
          }
        }
        if (insertAt === target.length) {
          for (let n = i + 1; n < source.length; n++) {
            const next = target.findIndex(item => item.stepId === source[n].stepId)
            if (next >= 0) {
              insertAt = next
              break
            }
          }
        }
        target.splice(insertAt, 0, existing)
      } else {
        for (const [key, value] of Object.entries(candidate)) {
          if (key !== 'steps' && ((existing as any)[key] === undefined || (existing as any)[key] === null || (existing as any)[key] === '')) {
            (existing as any)[key] = value
          }
        }
      }
      if (candidate.steps?.length) {
        if (!Array.isArray(existing.steps)) existing.steps = []
        mergeLevel(existing.steps, candidate.steps)
      }
    }
  }
  mergeLevel(primary, fallback)
}

function snapshotStep(row: any, sessionId?: string | null): TimelineStep | null {
  const common = {
    stepId: row.stepId,
    parentStepId: row.parentStepId || null,
    streaming: ['STREAMING', 'RUNNING', 'WAITING'].includes(row.status)
  }
  if (!common.stepId) return null
  if (row.stepType === 'content') {
    return { ...common, type: STEP_TYPES.CONTENT, text: row.outputData || '' }
  }
  if (row.stepType === 'reasoning') {
    return { ...common, type: STEP_TYPES.REASONING, text: row.outputData || '' }
  }
  if (row.stepType === 'tool') {
    return {
      ...common, type: STEP_TYPES.TOOL, name: row.name || '', source: row.source || 'builtin',
      args: row.inputData || '', result: row.outputData || '',
      attachments: parseToolAttachments(row.attachments), ok: row.success !== '1',
      ms: row.durationMs || 0, pendingConfirm: row.status === 'WAITING', confirmId: row.confirmId || '',
      messageId: row.messageId || null, sessionId: sessionId || ''
    }
  }
  if (row.stepType === 'agent') {
    return {
      ...common, type: STEP_TYPES.AGENT, name: row.name || '', agentCode: row.source || '',
      invId: row.stepId, result: row.outputData || '', ok: row.success !== '1',
      ms: row.durationMs || 0, steps: []
    }
  }
  if (row.stepType === 'context') {
    return { ...common, type: STEP_TYPES.SUMMARY, text: '已调整本轮上下文', streaming: false }
  }
  if (row.stepType === 'ui') {
    return {
      ...common,
      type: STEP_TYPES.UI,
      name: row.name || '',
      payload: parseJsonObject(row.outputData),
      streaming: false
    }
  }
  return null
}

function parseJsonObject(raw: any): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

function usageFromMessage(message: any) {
  if (!message) return null
  const prompt = Number(message.promptTokens) || 0
  const completion = Number(message.completionTokens) || 0
  if (!prompt && !completion && !message.tokens) return null
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion || Number(message.tokens) || 0,
    modelName: message.modelName || null,
    usageSource: message.usageSource || '1'
  }
}

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12)
}
