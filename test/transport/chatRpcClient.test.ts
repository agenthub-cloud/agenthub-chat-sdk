/**
 * ChatRpcClient 六关键场景单测：无 token 不建连、按序投递/旧 seq 丢弃、
 * seq 缺口恢复（缓存不投递 + onGap 检查点）、断线重连自动补订阅、
 * retain/release 引用计数、ping 保活与半开重建。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatRpcClient, type ChatRpcClientDeps } from '../../src/transport/chatRpcClient.js'
import { ChatTransportError } from '../../src/transport/errors.js'
import { installMockWebSocket, MockWebSocket } from './mockWebSocket.js'

function makeDeps(overrides: Partial<ChatRpcClientDeps> = {}): ChatRpcClientDeps {
  return {
    ticketProvider: async () => ({ data: { ticket: 't-1' } }),
    tokenProvider: () => 'tok-1',
    wsUrlBuilder: ticket => `ws://mock/${ticket}`,
    ...overrides
  }
}

function lastSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

function runEvent(runId: string, seq: number, event: object) {
  return { jsonrpc: '2.0', method: 'chat.event', params: { runId, seq, event } }
}

async function handshake(
  client: ChatRpcClient,
  subscribeResult: any = {},
  onGap: (...args: any[]) => any = () => Promise.resolve(0)
) {
  const events: any[] = []
  const runStates: any[] = []
  const p = client.subscribe('r1', 0, e => events.push(e), s => runStates.push(s), onGap)
  await vi.advanceTimersByTimeAsync(0)
  const socket = lastSocket()
  socket.serverOpen()
  await vi.advanceTimersByTimeAsync(0)
  const req = socket.sent.find(m => m.method === 'chat.run.subscribe')
  socket.respond(req.id, subscribeResult)
  await vi.advanceTimersByTimeAsync(0)
  await p
  return { client, socket, events, runStates }
}

describe('ChatRpcClient（移植自 desktop chatRpc.js）', () => {
  let restoreWs: () => void
  beforeEach(() => {
    restoreWs = installMockWebSocket()
    vi.useFakeTimers()
  })
  afterEach(() => {
    restoreWs()
    vi.useRealTimers()
  })

  it('场景1: 无 token 不建连——retain 后无 socket 实例且广播 closed', async () => {
    const states: string[] = []
    const client = new ChatRpcClient(makeDeps({ tokenProvider: () => null }))
    client.onConnectionState(s => states.push(s))
    client.retain()
    await vi.advanceTimersByTimeAsync(0)
    expect(MockWebSocket.instances).toHaveLength(0)
    expect(states).toContain('closed')
  })

  it('场景2: chat.event 按序投递，旧 seq/重复 seq 丢弃', async () => {
    const { socket, events } = await handshake(new ChatRpcClient(makeDeps()))
    socket.serverMessage(runEvent('r1', 1, { type: 'text', text: 'a' }))
    expect(events).toEqual([{ type: 'text', text: 'a' }])
    // 旧 seq（0）与已收过的 seq（重复 1）都不得投递
    socket.serverMessage(runEvent('r1', 0, { type: 'text', text: 'stale' }))
    socket.serverMessage(runEvent('r1', 1, { type: 'text', text: 'dup' }))
    expect(events).toEqual([{ type: 'text', text: 'a' }])
  })

  it('场景3: seq 缺口先缓存不投递，onGap 检查点被询问，后续事件按序补齐', async () => {
    const onGap = vi.fn(() => Promise.resolve(0))
    const { socket, events } = await handshake(new ChatRpcClient(makeDeps()), {}, onGap)
    // 缺口：期望 seq 1，却先到 seq 2——缓存，不投递
    socket.serverMessage(runEvent('r1', 2, { type: 'text', text: 'b' }))
    expect(events).toHaveLength(0)
    // gapRecovery 首次 delay=0，向 onGap 询问持久化 Run State 检查点
    await vi.advanceTimersByTimeAsync(1)
    expect(onGap).toHaveBeenCalledTimes(1)
    expect(onGap).toHaveBeenCalledWith({ runId: 'r1', afterSeq: 0, expectedSeq: 1, receivedSeq: 2 })
    // 检查点未推进（0 <= afterSeq 0）→ 不替换订阅；seq 1 到达后缓存按序补齐
    socket.serverMessage(runEvent('r1', 1, { type: 'text', text: 'a' }))
    socket.serverMessage(runEvent('r1', 3, { type: 'text', text: 'c' }))
    expect(events.map(e => e.text)).toEqual(['a', 'b', 'c'])
  })

  it('场景3b: onGap 检查点确实前进后才替换订阅（重订阅携带新 afterSeq）', async () => {
    const onGap = vi.fn(() => Promise.resolve(2))
    const { client, socket, events } = await handshake(new ChatRpcClient(makeDeps()), {}, onGap)
    socket.serverMessage(runEvent('r1', 1, { type: 'text', text: 'a' }))
    socket.serverMessage(runEvent('r1', 3, { type: 'text', text: 'c' }))
    expect(events.map(e => e.text)).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(onGap).toHaveBeenCalledWith({ runId: 'r1', afterSeq: 1, expectedSeq: 2, receivedSeq: 3 })
    // 新游标 2 之后缓存仍有效：seq 3 先补投，随后以新游标重订阅
    expect(events.map(e => e.text)).toEqual(['a', 'c'])
    const subscribes = socket.sent.filter(m => m.method === 'chat.run.subscribe')
    expect(subscribes).toHaveLength(2)
    expect(subscribes[1].params).toEqual({ runId: 'r1', afterSeq: 3 })
    socket.respond(subscribes[1].id, {})
    await vi.advanceTimersByTimeAsync(0)
    socket.serverMessage(runEvent('r1', 4, { type: 'text', text: 'd' }))
    expect(events.map(e => e.text)).toEqual(['a', 'c', 'd'])
    expect(client.isOpen()).toBeTruthy()
  })

  it('场景4: 断线重连后按最新 seq 自动补订阅', async () => {
    const { client, socket, events } = await handshake(new ChatRpcClient(makeDeps()))
    socket.serverMessage(runEvent('r1', 1, { type: 'text', text: 'a' }))
    expect(events).toHaveLength(1)
    socket.serverDrop()
    expect(client.isOpen()).toBeFalsy()
    // 首次退避 1s + 抖动上限 300ms
    await vi.advanceTimersByTimeAsync(1000 + 300)
    await vi.advanceTimersByTimeAsync(0)
    const next = lastSocket()
    expect(next).not.toBe(socket)
    next.serverOpen()
    await vi.advanceTimersByTimeAsync(0)
    const req = next.sent.find(m => m.method === 'chat.run.subscribe')
    expect(req.params).toEqual({ runId: 'r1', afterSeq: 1 })
  })

  it('场景5: retain/release 引用计数——最后一个持有者释放才关闭', async () => {
    const client = new ChatRpcClient(makeDeps())
    const release1 = client.retain()
    const release2 = client.retain()
    await vi.advanceTimersByTimeAsync(0)
    const socket = lastSocket()
    socket.serverOpen()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.isOpen()).toBeTruthy()
    release1()
    expect(client.isOpen()).toBeTruthy()
    release2()
    // close 事件为异步派发（对齐真实 WS），先让微任务落地再断言
    await vi.advanceTimersByTimeAsync(0)
    expect(client.isOpen()).toBeFalsy()
    expect(socket.readyState).toBe(MockWebSocket.CLOSED)
  })

  it('场景6: ping 保活——超时后 close(4000) 并自动重建连接', async () => {
    const { client, socket, events } = await handshake(new ChatRpcClient(makeDeps()))
    socket.serverMessage(runEvent('r1', 1, { type: 'text', text: 'a' }))
    expect(events).toHaveLength(1)
    // 25s 心跳间隔
    await vi.advanceTimersByTimeAsync(25000)
    const pings = socket.sent.filter(m => m.method === 'chat.ping')
    expect(pings).toHaveLength(1)
    expect(pings[0].params).toEqual({})
    // ping 5s 超时 → close(4000) 半开重建
    await vi.advanceTimersByTimeAsync(5001)
    expect(socket.readyState).toBe(MockWebSocket.CLOSED)
    expect(client.isOpen()).toBeFalsy()
    // 首次退避 1s + 抖动上限 300ms → 连接已重建
    await vi.advanceTimersByTimeAsync(1000 + 300)
    const rebuilt = lastSocket()
    expect(rebuilt).not.toBe(socket)
    rebuilt.serverOpen()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.isOpen()).toBeTruthy()
    const req = rebuilt.sent.find(m => m.method === 'chat.run.subscribe')
    expect(req.params).toEqual({ runId: 'r1', afterSeq: 1 })
  })

  it('场景7: 退避窗口内手动 connect 失败后，自动重连不停摆', async () => {
    let ticketCalls = 0
    const client = new ChatRpcClient(makeDeps({
      ticketProvider: async () => {
        ticketCalls += 1
        if (ticketCalls === 1) return { data: { ticket: 't-1' } }
        if (ticketCalls === 2) throw new Error('ticket 服务暂不可用')
        return { data: { ticket: 't-2' } }
      }
    }))
    const release = client.retain()
    await vi.advanceTimersByTimeAsync(0)
    const socket = lastSocket()
    socket.serverOpen()
    await vi.advanceTimersByTimeAsync(0)
    socket.serverDrop()
    // 退避窗口内用户动作（订阅新一轮）触发手动 connect → 票据获取失败
    await expect(client.subscribe('r2', 0, () => {})).rejects.toThrow('ticket 服务暂不可用')
    expect(ticketCalls).toBe(2)
    // 失败后 scheduleReconnect 仍会安排下一次重连（定时器最终触发新握手）
    await vi.advanceTimersByTimeAsync(2000 + 300)
    await vi.advanceTimersByTimeAsync(0)
    expect(ticketCalls).toBe(3)
    const rebuilt = lastSocket()
    expect(rebuilt).not.toBe(socket)
    expect(rebuilt.url).toBe('ws://mock/t-2')
    rebuilt.serverOpen()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.isOpen()).toBeTruthy()
    release()
  })

  it('场景8: subscribeSession 断线重连自动补订，首订交付 activeRun', async () => {
    const client = new ChatRpcClient(makeDeps())
    const sessionEvents: any[] = []
    const activeRuns: any[] = []
    const p = client.subscribeSession('s1', e => sessionEvents.push(e), r => activeRuns.push(r))
    await vi.advanceTimersByTimeAsync(0)
    const socket = lastSocket()
    socket.serverOpen()
    await vi.advanceTimersByTimeAsync(0)
    let req = socket.sent.find(m => m.method === 'chat.session.subscribe')
    expect(req.params).toEqual({ sessionId: 's1' })
    // 首次订阅与断线重连同路：服务端回的活动运行必须交给 onActiveRun
    socket.respond(req.id, { activeRun: { runId: 'r9', status: 'running' } })
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect(activeRuns).toEqual([{ runId: 'r9', status: 'running' }])
    socket.serverMessage({ jsonrpc: '2.0', method: 'chat.session.event', params: { sessionId: 's1', kind: 'run_started' } })
    expect(sessionEvents).toEqual([{ sessionId: 's1', kind: 'run_started' }])
    socket.serverDrop()
    await vi.advanceTimersByTimeAsync(1000 + 300)
    await vi.advanceTimersByTimeAsync(0)
    const next = lastSocket()
    expect(next).not.toBe(socket)
    next.serverOpen()
    await vi.advanceTimersByTimeAsync(0)
    req = next.sent.find(m => m.method === 'chat.session.subscribe')
    expect(req.params).toEqual({ sessionId: 's1' })
    next.respond(req.id, {})
    await vi.advanceTimersByTimeAsync(0)
    expect(client.isOpen()).toBeTruthy()
    expect(activeRuns).toHaveLength(1)
  })

  it('场景9: JSON-RPC 错误响应传播，code/data 保留且不是 transport 错误', async () => {
    const client = new ChatRpcClient(makeDeps())
    const p = client.request('chat.run.get', { runId: 'r1' }, 5000)
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    const socket = lastSocket()
    socket.serverOpen()
    await vi.advanceTimersByTimeAsync(0)
    const req = socket.sent.find(m => m.method === 'chat.run.get')
    expect(req.params).toEqual({ runId: 'r1' })
    socket.respondError(req.id, 'run 不存在')
    const err = await p.catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ChatTransportError)
    expect(err.message).toBe('run 不存在')
    expect(err.code).toBe(-1)
    expect(err.data).toBeUndefined()
  })

  it('场景10: 请求超时 reject ChatTransportError(request-timeout)', async () => {
    const client = new ChatRpcClient(makeDeps())
    const p = client.request('chat.run.get', { runId: 'r1' }, 20000)
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    const socket = lastSocket()
    socket.serverOpen()
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.sent.some(m => m.method === 'chat.run.get')).toBe(true)
    await vi.advanceTimersByTimeAsync(20000 + 1)
    await expect(p).rejects.toBeInstanceOf(ChatTransportError)
    await expect(p).rejects.toMatchObject({ code: 'request-timeout', message: 'JSON-RPC 请求超时: chat.run.get' })
  })
})
