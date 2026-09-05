/**
 * chat 域 REST 封装。
 * 移植自主仓 `desktop/src/api/chat.js`(10 个函数),唯一变换:
 * 模块级 `request` 依赖改为 `createChatRest(http)` 工厂闭包绑定注入的 HttpClientLike;
 * url/method/params/data 与 `headers: { repeatSubmit: false }`(三端 axios 拦截器的防重标记)逐字保留。
 */
import type { HttpClientLike } from '../http/types.js'

export function createChatRest(http: HttpClientLike) {
  function createChatRun(data: any) {
    return http.request({
      url: '/ai/chat/run',
      method: 'post',
      data,
      headers: { repeatSubmit: false }
    })
  }

  function getChatRun(runId: string) {
    return http.request({ url: '/ai/chat/run/' + runId, method: 'get' })
  }

  function getChatRunState(runId: string) {
    return http.request({ url: '/ai/chat/run/' + runId + '/state', method: 'get' })
  }

  function getActiveChatRun(sessionId: string) {
    return http.request({ url: '/ai/chat/run/active', method: 'get', params: { sessionId } })
  }

  function getLatestChatRun(sessionId: string) {
    return http.request({ url: '/ai/chat/run/latest', method: 'get', params: { sessionId } })
  }

  function cancelChatRun(runId: string) {
    return http.request({
      url: '/ai/chat/run/' + runId + '/cancel',
      method: 'post',
      headers: { repeatSubmit: false }
    })
  }

  function confirmChatTool(runId: string, confirmId: string, approved?: boolean) {
    return http.request({
      url: '/ai/chat/run/' + runId + '/tool-confirm',
      method: 'post',
      data: { confirmId, approved: !!approved },
      headers: { repeatSubmit: false }
    })
  }

  function createChatWebSocketTicket() {
    return http.request({
      url: '/ai/chat/ws-ticket',
      method: 'post',
      headers: { repeatSubmit: false }
    })
  }

  function getContextUsage(sessionId: string, agentId?: number) {
    return http.request({
      url: '/ai/chat/session/' + sessionId + '/context',
      method: 'get',
      params: agentId != null ? { agentId } : {}
    })
  }

  function rollbackLastTurn(sessionId: string, agentId?: number) {
    return http.request({
      url: '/ai/chat/session/' + sessionId + '/last-turn',
      method: 'delete',
      params: agentId != null ? { agentId } : {}
    })
  }

  return { createChatRun, getChatRun, getChatRunState, getActiveChatRun, getLatestChatRun, cancelChatRun, confirmChatTool, createChatWebSocketTicket, getContextUsage, rollbackLastTurn }
}

export type ChatRest = ReturnType<typeof createChatRest>
