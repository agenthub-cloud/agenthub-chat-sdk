import { describe, expect, it, vi } from 'vitest'
import { createChatRest, type ChatRest } from '../../src/rest/chatRest.js'
import type { HttpClientLike } from '../../src/http/types.js'

function fakeHttp() {
  return { request: vi.fn(async (cfg: any) => ({ data: { ok: true }, config: cfg })) } as unknown as HttpClientLike
}

describe('chatRest', () => {
  it.each([
    ['createChatRun', (c: ChatRest) => c.createChatRun({ sessionId: 's1', inputText: 'hi' }), { url: '/ai/chat/run', method: 'post', data: { sessionId: 's1', inputText: 'hi' }, headers: { repeatSubmit: false } }],
    ['getChatRun', (c: ChatRest) => c.getChatRun('r1'), { url: '/ai/chat/run/r1', method: 'get' }],
    ['getChatRunState', (c: ChatRest) => c.getChatRunState('r1'), { url: '/ai/chat/run/r1/state', method: 'get' }],
    ['getActiveChatRun', (c: ChatRest) => c.getActiveChatRun('s1'), { url: '/ai/chat/run/active', method: 'get', params: { sessionId: 's1' } }],
    ['getLatestChatRun', (c: ChatRest) => c.getLatestChatRun('s1'), { url: '/ai/chat/run/latest', method: 'get', params: { sessionId: 's1' } }],
    ['cancelChatRun', (c: ChatRest) => c.cancelChatRun('r1'), { url: '/ai/chat/run/r1/cancel', method: 'post', headers: { repeatSubmit: false } }],
    ['confirmChatTool', (c: ChatRest) => c.confirmChatTool('r1', 'c1', true), { url: '/ai/chat/run/r1/tool-confirm', method: 'post', data: { confirmId: 'c1', approved: true }, headers: { repeatSubmit: false } }],
    ['createChatWebSocketTicket', (c: ChatRest) => c.createChatWebSocketTicket(), { url: '/ai/chat/ws-ticket', method: 'post', headers: { repeatSubmit: false } }],
    ['getContextUsage', (c: ChatRest) => c.getContextUsage('s1'), { url: '/ai/chat/session/s1/context', method: 'get', params: {} }],
    ['rollbackLastTurn', (c: ChatRest) => c.rollbackLastTurn('s1', 3), { url: '/ai/chat/session/s1/last-turn', method: 'delete', params: { agentId: 3 } }]
  ])('%s 的 url/method/参数与 desktop chat.js 一致', (_n, call, expected) => {
    const http = fakeHttp()
    const rest = createChatRest(http)
    call(rest)
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining(expected))
  })
})
