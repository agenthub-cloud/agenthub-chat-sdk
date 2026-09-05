/**
 * createChatClient 装配单测:tokenProvider → ticketProvider(rest 走注入 http)→
 * 默认 wsUrlBuilder(baseUrl 推导)的完整握手链路,以及 chat.run.subscribe 的收发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatClient, type HttpClientLike } from '../src/index.js'
import { RPC_METHODS } from '../src/protocol/rpcMethods.js'
import { installMockWebSocket, MockWebSocket } from './transport/mockWebSocket.js'

/** 记录请求并按 url 路由的 http 替身。 */
function makeHttp() {
  const requests: any[] = []
  const http: HttpClientLike = {
    request: async config => {
      requests.push(config)
      if (config.url === '/ai/chat/ws-ticket') return { data: { ticket: 'tk-1' } }
      if (config.url === '/ai/chat/run') return { data: { runId: 'r1', status: 'QUEUED' } }
      return { data: null }
    }
  }
  return { http, requests }
}

function lastSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

describe('createChatClient', () => {
  let restoreWs: () => void
  beforeEach(() => {
    restoreWs = installMockWebSocket()
    vi.useFakeTimers()
  })
  afterEach(() => {
    restoreWs()
    vi.useRealTimers()
  })

  it('完整握手链路:token → ws-ticket(rest 走注入 http)→ 默认 ws 地址从 baseUrl 推导 → run.subscribe 收发', async () => {
    const { http, requests } = makeHttp()
    const client = createChatClient({ http, tokenProvider: () => 'tok-1', baseUrl: 'http://demo.local/api' })

    // 装配面:原样透出 http/baseUrl,rest/rpc 就绪
    expect(client.http).toBe(http)
    expect(client.baseUrl).toBe('http://demo.local/api')
    expect(typeof client.rest.createChatRun).toBe('function')
    expect(typeof client.rpc.subscribe).toBe('function')

    const events: any[] = []
    const subscribed = client.rpc.subscribe('r1', 0, e => events.push(e))
    await vi.advanceTimersByTimeAsync(0)

    // ticketProvider 收口到 rest.createChatWebSocketTicket,经注入 http 发出
    expect(requests).toContainEqual(expect.objectContaining({ url: '/ai/chat/ws-ticket', method: 'post' }))
    // 默认 wsUrlBuilder:baseUrl → ws 协议 + /ws/ai/chat + ticket 入 query
    const socket = lastSocket()
    expect(socket.url).toBe('ws://demo.local/api/ws/ai/chat?ticket=tk-1')

    socket.serverOpen()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.rpc.isOpen()).toBeTruthy()

    // chat.run.subscribe 可正常收发
    const req = socket.sent.find(m => m.method === RPC_METHODS.RUN_SUBSCRIBE)
    expect(req.params).toEqual({ runId: 'r1', afterSeq: 0 })
    socket.respond(req.id, {})
    await subscribed
    socket.serverMessage({ jsonrpc: '2.0', method: RPC_METHODS.EVENT, params: { runId: 'r1', seq: 1, event: { type: 'text', text: 'hi' } } })
    expect(events).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('rest 绑定注入 http:url/method/repeatSubmit 逐字透传', async () => {
    const { http, requests } = makeHttp()
    const client = createChatClient({ http, tokenProvider: () => 'tok-1', baseUrl: 'http://demo.local' })

    const response = await client.rest.createChatRun({ sessionId: 's1', inputText: 'hi' })

    expect(response).toMatchObject({ data: { runId: 'r1' } })
    expect(requests).toContainEqual(expect.objectContaining({
      url: '/ai/chat/run', method: 'post',
      data: { sessionId: 's1', inputText: 'hi' },
      headers: { repeatSubmit: false }
    }))
  })

  it('自定义 wsUrlBuilder 覆盖默认推导', async () => {
    const { http } = makeHttp()
    const client = createChatClient({
      http,
      tokenProvider: () => 'tok-1',
      baseUrl: 'http://ignored.local',
      wsUrlBuilder: ticket => `ws://custom.local/ws?ticket=${ticket}`
    })

    client.rpc.retain()
    await vi.advanceTimersByTimeAsync(0)

    expect(lastSocket().url).toBe('ws://custom.local/ws?ticket=tk-1')
  })

  it('无 token 不建连:装配照常,连接留待 token 就绪', async () => {
    const { http, requests } = makeHttp()
    const client = createChatClient({ http, tokenProvider: () => null, baseUrl: 'http://demo.local' })

    client.rpc.retain()
    await vi.advanceTimersByTimeAsync(0)

    expect(MockWebSocket.instances).toHaveLength(0)
    expect(requests).toHaveLength(0)
  })
})
