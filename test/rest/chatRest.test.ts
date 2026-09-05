import { describe, expect, it, vi } from 'vitest'
import { createChatRest } from '../../src/rest/chatRest.js'
import { RPC_METHODS } from '../../src/protocol/rpcMethods.js'
import type { HttpClientLike } from '../../src/http/types.js'

function fakeHttp() {
  return { request: vi.fn(async (cfg: any) => ({ data: { ok: true }, config: cfg })) } as unknown as HttpClientLike
}

describe('rpcMethods', () => {
  it('15 个方法名与后端一致', () => {
    expect(Object.keys(RPC_METHODS)).toHaveLength(15)
    expect(RPC_METHODS).toMatchObject({ RUN_SUBSCRIBE: 'chat.run.subscribe', SESSION_CLIENT_DECLARE: 'chat.session.client.declare', TOOL_RESULT: 'chat.tool.result', PING: 'chat.ping' })
  })
})

describe('chatRest', () => {
  it.each([
    ['createChatRun', (c: ReturnType<typeof createChatRest>) => c.createChatRun({ sessionId: 's1', inputText: 'hi' }), { url: '/ai/chat/run', method: 'post', data: { sessionId: 's1', inputText: 'hi' } }],
    ['getChatRun', (c: ReturnType<typeof createChatRest>) => c.getChatRun('r1'), { url: '/ai/chat/run/r1', method: 'get' }],
    ['getChatRunState', (c: ReturnType<typeof createChatRest>) => c.getChatRunState('r1'), { url: '/ai/chat/run/r1/state', method: 'get' }],
    ['getActiveChatRun', (c: ReturnType<typeof createChatRest>) => c.getActiveChatRun('s1'), { url: '/ai/chat/run/active', method: 'get', params: { sessionId: 's1' } }],
    ['getLatestChatRun', (c: ReturnType<typeof createChatRest>) => c.getLatestChatRun('s1'), { url: '/ai/chat/run/latest', method: 'get', params: { sessionId: 's1' } }],
    ['cancelChatRun', (c: ReturnType<typeof createChatRest>) => c.cancelChatRun('r1'), { url: '/ai/chat/run/r1/cancel', method: 'post' }],
    ['confirmChatTool', (c: ReturnType<typeof createChatRest>) => c.confirmChatTool('r1', 'c1', true), { url: '/ai/chat/run/r1/tool-confirm', method: 'post', data: { confirmId: 'c1', approved: true } }],
    ['createChatWebSocketTicket', (c: ReturnType<typeof createChatRest>) => c.createChatWebSocketTicket(), { url: '/ai/chat/ws-ticket', method: 'post' }],
    ['getContextUsage', (c: ReturnType<typeof createChatRest>) => c.getContextUsage('s1'), { url: '/ai/chat/session/s1/context', method: 'get', params: {} }],
    ['rollbackLastTurn', (c: ReturnType<typeof createChatRest>) => c.rollbackLastTurn('s1', 3), { url: '/ai/chat/session/s1/last-turn', method: 'delete', params: { agentId: 3 } }]
  ])('%s 的 url/method/参数与 desktop chat.js 一致', (_n, call, expected) => {
    const http = fakeHttp()
    const rest = createChatRest(http)
    call(rest)
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining(expected))
  })
})
