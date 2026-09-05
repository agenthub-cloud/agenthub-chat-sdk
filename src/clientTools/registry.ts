/**
 * 移植自 AgentHub 主仓 extension/src/chat/clientTools.js（5fdd8c89 时的 main），
 * 补发幂等/首轮捎带语义以主仓 docs/渠道工具与浏览器插件.md 为准。
 * 原文件为协议层副本（desktop/src/chat/clientTools.js，clientType 为 browser_ext）。
 * 唯一变换：模块级单例改为 createClientToolRegistry(options) 工厂闭包，
 * chatRpc/toast/__CLIENT_TOOLS_VERSION__ 全局/window.defineClientTool 挂载分别
 * 收口为构造注入 rpc/version/onNotice 与删除（resetClientToolsForTest → resetForTest）。
 * 类型层适配（运行时语义不变）：catch (e: any)、FIFO 淘汰处的非空断言、
 * RPC 方法名改用 RPC_METHODS 常量。
 */
import type { ChatRpcClient } from '../transport/chatRpcClient.js'
import { RPC_METHODS } from '../protocol/rpcMethods.js'

/** 注册一条客户端工具时的定义体。 */
export interface ClientToolDefinition {
  name: string
  description?: string
  parameters?: Record<string, any>
}

/** handler 的第二个参数只供客户端 handler 使用，不会混进模型生成的工具入参。 */
export interface ClientToolHandlerContext {
  sessionId: string | null
}

export type ClientToolHandler = (args: any, ctx: ClientToolHandlerContext) => any

/** snapshot()/clientTools 清单条目：只含声明给服务端的三个字段，不含 handler。 */
export interface ClientToolSnapshotEntry {
  name: string
  description: string
  parameters: Record<string, any>
}

/** declarePayloadFor 的载荷；首轮 run.create 把它捎给服务端补声明。 */
export interface ClientToolDeclarePayload {
  clientType: string
  capabilitiesVersion: string
  clientTools: ClientToolSnapshotEntry[]
}

/** tool_call_request 事件里注册表消费的字段。 */
export interface ToolCallRequestEvent {
  callId?: string | null
  name?: string | null
  args?: string | null
  sessionId?: string | null
}

export interface ClientToolRegistryOptions {
  /** 原模块直接引用的 chatRpc 单例；真实实现为 ChatRpcClient。 */
  rpc: ChatRpcClient
  /** 原 __CLIENT_TOOLS_VERSION__ 全局（插件包版本号）。 */
  version: string
  /** 默认 'browser_ext'。 */
  clientType?: string
  /** 原 toast()；declare 的 skipped 提示走它，默认 noop。 */
  onNotice?: (message: string, type?: 'info' | 'warning' | 'error') => void
}

export interface ClientToolRegistry {
  defineClientTool(def: ClientToolDefinition, handler: ClientToolHandler): void
  snapshot(): ClientToolSnapshotEntry[]
  declarePayloadFor(sessionId: string | null | undefined): ClientToolDeclarePayload | null
  markDeclared(sessionId: string): void
  declare(sessionId: string | null | undefined): Promise<any>
  handleToolCallRequest(runId: string, event: ToolCallRequestEvent): Promise<void>
  resetForTest(): void
}

/** 一次本地 handler 执行收敛出的可重发结局。 */
interface ToolCallOutcome {
  ok: boolean
  result?: string | null
  error?: string | null
  mediaFileId?: number | null
  workspacePath?: string | null
}

interface HandledRecord {
  outcome: ToolCallOutcome | null
}

interface RegistryEntry {
  name: string
  description: string
  parameters: Record<string, any>
  handler: ClientToolHandler
}

export function createClientToolRegistry(options: ClientToolRegistryOptions): ClientToolRegistry {
  const clientType = options.clientType ?? 'browser_ext'

  const registry = new Map<string, RegistryEntry>()

  /**
   * 已受理的调用：callId -> { outcome }。outcome 为 null 表示 handler 还在跑。
   *
   * 不能只记「见过就跳过」：服务端在客户端重新订阅这一轮时会补发尚未回传的请求
   * (侧边栏关掉再打开、断线重连、序号缺口恢复都会走到)，而补发的目标恰恰是
   * 结果没送达的那些调用 —— 见过就跳过等于让补发对本页永远空转。
   * 直接重跑也不行：click / fillInput / navigate / closeTabs 都是写操作，
   * 重跑一次就多点一次。所以记住结局，补发时把当时的结果原样重发。
   */
  const handled = new Map<string, HandledRecord>()
  const HANDLED_LIMIT = 200
  let lastDeclaredSessionId: string | null = null

  /**
   * 注册一条客户端工具。只维护页面内 Map，不发 RPC。
   * handler(args) 返回值非字符串会 JSON.stringify。
   */
  function defineClientTool(def: ClientToolDefinition, handler: ClientToolHandler) {
    if (!def || typeof def.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(def.name)) {
      throw new Error('非法的客户端工具名')
    }
    if (typeof handler !== 'function') {
      throw new Error('客户端工具 handler 必须是函数')
    }
    registry.set(def.name, {
      name: def.name,
      description: String(def.description || '').trim(),
      parameters: def.parameters && typeof def.parameters === 'object' ? def.parameters : { type: 'object', properties: {} },
      handler
    })
  }

  function snapshot(): ClientToolSnapshotEntry[] {
    return [...registry.values()]
      .map(({ name, description, parameters }) => ({ name, description, parameters }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  function capabilitiesVersion() {
    const pkg = options.version || '0'
    return pkg + '+' + shortHash(JSON.stringify(snapshot()))
  }

  function shortHash(s: string) {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }

  /**
   * 会话落库后声明一次。版本相同服务端不写库。
   */
  // 已成功声明过的会话。首轮 run.create 要不要捎上清单看它。
  const declared = new Set<string>()

  /**
   * 首轮补声明用的载荷。
   *
   * declare 只能在会话落库后才发得出去（服务端 declareClient 要求会话已存在），
   * 而新会话的第一轮 run 就在落库的同一次调用里装配 —— 不把清单捎在 run.create 上，
   * 新对话的第一轮永远没有客户端工具。
   * 已声明过的会话返回 null，不重复占请求体。
   */
  function declarePayloadFor(sessionId: string | null | undefined): ClientToolDeclarePayload | null {
    if (!sessionId || declared.has(sessionId)) return null
    const tools = snapshot()
    // 没有工具就什么都别声明：会话行只存得下一份清单，空清单发过去就是把别的端
    // （比如插件刚声明的 15 个浏览器工具）原地抹掉。desktop 一个工具都不注册，
    // 每开一个会话就会这么洗一次。
    if (!tools.length) return null
    return {
      clientType,
      capabilitiesVersion: capabilitiesVersion(),
      clientTools: tools
    }
  }

  /** run.create 已把清单带过去了，标记为已声明。 */
  function markDeclared(sessionId: string) {
    if (sessionId) declared.add(sessionId)
  }

  async function declare(sessionId: string | null | undefined) {
    if (!sessionId) return null
    const tools = snapshot()
    // 同 declarePayloadFor：空清单不发，否则等于替别的端把清单清了。
    if (!tools.length) return null
    lastDeclaredSessionId = sessionId
    try {
      const res = await options.rpc.request(RPC_METHODS.SESSION_CLIENT_DECLARE, {
        sessionId,
        clientType,
        capabilitiesVersion: capabilitiesVersion(),
        tools
      })
      declared.add(sessionId)
      const skipped = res?.skipped || []
      if (skipped.length) {
        options.onNotice?.('部分客户端工具未生效：' + skipped.join('、'))
      }
      return res
    } catch (e) {
      console.warn('声明客户端工具失败', e)
      return null
    }
  }

  /**
   * 处理 tool_call_request。同一 callId 只执行一次；找不到 handler 立刻 ok:false。
   *
   * 收到补发(同一 callId 再来一次)时不重跑 handler，只把上次的结局重发一遍。
   */
  async function handleToolCallRequest(runId: string, event: ToolCallRequestEvent) {
    const callId = event?.callId
    const name = event?.name
    if (!callId || !runId) return
    const seen = handled.get(callId)
    if (seen) {
      // handler 还在跑就等它自己回；已经跑完则补一次回传(上一次多半是没送出去)
      if (seen.outcome) await sendResult(runId, callId, seen.outcome)
      return
    }
    const record: HandledRecord = { outcome: null }
    remember(callId, record)
    const outcome = await runHandler(name, event)
    record.outcome = outcome
    await sendResult(runId, callId, outcome)
  }

  /** 跑一次本地 handler，把成功与失败都收敛成可重发的 outcome。 */
  async function runHandler(name: string | null | undefined, event: ToolCallRequestEvent): Promise<ToolCallOutcome> {
    const entry = name ? registry.get(name) : null
    if (!entry) {
      return { ok: false, error: '本端没有名为 ' + (name || '?') + ' 的客户端工具' }
    }
    let args: any = {}
    try {
      args = event.args ? JSON.parse(event.args) : {}
    } catch (_) {
      args = {}
    }
    try {
      // 第二个参数只供客户端 handler 使用，不会混进模型生成的工具入参。
      const raw = await withWatchdog(name, entry.handler(args, {
        sessionId: event.sessionId || null
      }))
      // 截图等工具回工作区路径引用；图片本体不走 WebSocket，服务端按当前工作区读取。
      // mediaFileId 继续兼容旧版本插件。
      const hasMedia = raw && typeof raw === 'object' && !Array.isArray(raw)
        && ('workspacePath' in raw || 'mediaFileId' in raw)
      const payload = hasMedia ? raw.text : raw
      const mediaFileId = hasMedia && raw.mediaFileId != null ? Number(raw.mediaFileId) : null
      const workspacePath = hasMedia && typeof raw.workspacePath === 'string'
        ? raw.workspacePath : null
      const result = payload == null ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload))
      return { ok: true, result, mediaFileId, workspacePath }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  }

  /** 有界记录，长会话下不无限增长；淘汰的是最早的调用，补发只可能落在最近几条上。 */
  function remember(callId: string, record: HandledRecord) {
    handled.set(callId, record)
    if (handled.size > HANDLED_LIMIT) {
      // 刚 set 过必然还有更早的 key，非空断言只为过 strict 类型检查。
      handled.delete(handled.keys().next().value!)
    }
  }

  // 最后一道兜底：无论 handler 卡在哪，都要在服务端渠道超时(120s)之前给出结果。
  // 否则模型白等两分钟才拿到一句「等待客户端执行超时」，既慢又没有可用信息。
  const HANDLER_TIMEOUT_MS = 100000

  function withWatchdog(name: string | null | undefined, promise: any) {
    let timer: ReturnType<typeof setTimeout>
    return Promise.race([
      Promise.resolve(promise).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`客户端工具 ${name} 超过 ${HANDLER_TIMEOUT_MS / 1000} 秒未返回，已放弃。`)),
          HANDLER_TIMEOUT_MS
        )
      })
    ])
  }

  /**
   * 回传结果。失败只记日志不抛：这一轮的挂起态在服务端，本页抛出去也没人接。
   * 真正的兜底是服务端补发 —— 客户端下次订阅这一轮时会把这条请求再发一遍，
   * 那时 {@link handleToolCallRequest} 认得出 callId，直接重发这里没送出去的结果。
   */
  async function sendResult(runId: string, callId: string, outcome: ToolCallOutcome | null) {
    const mediaFileId = outcome?.mediaFileId
    const workspacePath = outcome?.workspacePath
    try {
      await options.rpc.request(RPC_METHODS.TOOL_RESULT, {
        runId,
        callId,
        ok: !!outcome?.ok,
        result: outcome?.result ?? null,
        error: outcome?.error ?? null,
        ...(Number.isFinite(mediaFileId) ? { mediaFileId } : {}),
        ...(workspacePath ? { workspacePath } : {})
      })
    } catch (e) {
      console.warn('回传客户端工具结果失败', e)
    }
  }

  function resetForTest() {
    registry.clear()
    handled.clear()
    lastDeclaredSessionId = null
  }

  return {
    defineClientTool,
    snapshot,
    declarePayloadFor,
    markDeclared,
    declare,
    handleToolCallRequest,
    resetForTest
  }
}
