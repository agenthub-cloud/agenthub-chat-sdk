/**
 * 集成冒烟:MockWebSocket + 真实 ChatRpcClient + 真实 createChatClient + createChatEngine
 * 全链路一条——send → 握手 → run.create 响应 runId → 订阅后推 text/done 事件 →
 * 断言 state.turns 收口与 notify 计数器。补 Task 9 纯 fake 引擎测试的时序缺口
 * (真实 rpc 的握手/订阅时序、rest 票据链路在这里都是真实路径)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatClient, type HttpClientLike } from '../../src/index.js'
import { createChatEngine } from '../../src/engine/engine.js'
import { EVENT_TYPES } from '../../src/protocol/eventTypes.js'
import { RPC_METHODS } from '../../src/protocol/rpcMethods.js'
import { installMockWebSocket, MockWebSocket } from '../transport/mockWebSocket.js'

function lastSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

describe('集成冒烟(createChatClient + createChatEngine 全链路)', () => {
  let restoreWs: () => void
  beforeEach(() => {
    restoreWs = installMockWebSocket()
    vi.useFakeTimers()
  })
  afterEach(() => {
    restoreWs()
    vi.useRealTimers()
  })

  it('send → 握手 → run.create → run.subscribe → text/done 推送 → turns 收口 + notify 触发', async () => {
    const requests: any[] = []
    const http: HttpClientLike = {
      request: async config => {
        requests.push(config)
        if (config.url === '/ai/chat/ws-ticket') return { data: { ticket: 'tk-1' } }
        if (config.url === '/ai/chat/run') return { data: { runId: 'r1', status: 'QUEUED' } }
        if (config.url === '/ai/chat/run/r1/state') {
          return { data: { run: { runId: 'r1', status: 'RUNNING', inputText: '你好' }, snapshotSeq: 0, steps: [] } }
        }
        return { data: null }
      }
    }
    const client = createChatClient({ http, tokenProvider: () => 'tok-1', baseUrl: 'http://demo.local/api' })
    const notices: Array<[string, string?]> = []
    const engine = createChatEngine(client, { onNotice: (message, type) => notices.push([message, type]) })
    let notifyCount = 0
    engine.subscribe(() => { notifyCount += 1 })

    // 创建引擎即建连(retain):token → ws-ticket → 默认 builder 从 baseUrl 推导 ws 地址
    await vi.advanceTimersByTimeAsync(0)
    const socket = lastSocket()
    expect(socket.url).toBe('ws://demo.local/api/ws/ai/chat?ticket=tk-1')
    socket.serverOpen()
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.state.connectionState).toBe('open')

    // 发送:乐观轮 → createChatRun(runId=r1)→ 真实 rpc 订阅
    const sendPromise = engine.send('你好', { sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(requests).toContainEqual(expect.objectContaining({ url: '/ai/chat/run', method: 'post' }))
    const subReq = socket.sent.find(m => m.method === RPC_METHODS.RUN_SUBSCRIBE)
    expect(subReq.params).toEqual({ runId: 'r1', afterSeq: 0 })
    socket.respond(subReq.id, {})
    const returned = await sendPromise
    expect(returned).toMatchObject({ runId: 'r1' })
    expect(engine.state.activeRunId).toBe('r1')
    expect(engine.state.loading).toBe(true)

    // 服务端推送:text → done(经真实 handleMessage → deliverRunEvent → applyEvent)
    socket.serverMessage({
      jsonrpc: '2.0', method: RPC_METHODS.EVENT,
      params: { runId: 'r1', seq: 1, event: { type: EVENT_TYPES.TEXT, stepId: 'answer', text: '你好' } }
    })
    socket.serverMessage({
      jsonrpc: '2.0', method: RPC_METHODS.EVENT,
      params: { runId: 'r1', seq: 2, event: { type: EVENT_TYPES.DONE, status: 'SUCCEEDED', text: '你好，世界' } }
    })

    // 收口:轮完成、最终文本落位、活动运行清空、自动退订、notify 全程触发
    const turn = engine.state.turns[0]
    expect(turn.userMsg).toMatchObject({ messageType: 'USER', content: '你好' })
    expect(turn.completed).toBe(true)
    expect(turn.steps.some(s => s.type === 'content' && s.text === '你好，世界')).toBe(true)
    expect(engine.state.activeRunId).toBeNull()
    expect(engine.state.loading).toBe(false)
    expect(engine.state.status).toBe('done')
    expect(notifyCount).toBeGreaterThan(0)
    expect(socket.sent.some(m => m.method === RPC_METHODS.RUN_UNSUBSCRIBE && m.params.runId === 'r1')).toBe(true)
    expect(notices).toEqual([])

    engine.destroy()
  })
})
