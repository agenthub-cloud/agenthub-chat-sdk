/**
 * createChatClient:对外 API 的装配点(收口一切环境耦合)。
 *
 * http 实例、token 来源、baseUrl、ws 地址构造与重连退避参数都在这里注入,
 * 产出 { rest, rpc } 供 createChatEngine / vue 适配层直接消费——
 * 业务侧不再接触 ChatRpcClientDeps / createChatRest 等内部构造细节。
 */
import { ChatRpcClient } from './transport/chatRpcClient.js'
import { defaultWsUrlBuilder } from './transport/wsUrl.js'
import { createChatRest, type ChatRest } from './rest/chatRest.js'
import type { HttpClientLike } from './http/types.js'
import { createUserFilesApi, type UserFilesApi } from './domains/files.js'
import { createKnowledgeBasesApi, type KnowledgeBasesApi } from './domains/knowledgeBases.js'
import { createResourcesApi, type ResourcesApi } from './domains/resources.js'

/** WebSocket 重连退避参数(透传 ChatRpcClient;缺省 { maxDelayMs: 20000, giveUpAfter: 3 })。 */
export interface ReconnectOptions {
  maxDelayMs?: number
  giveUpAfter?: number
}

/** createChatClient 的环境注入:三端宿主各自的差异面只剩这一份。 */
export interface ChatClientConfig {
  /** 与宿主 axios 封装兼容的 http 实例(rest 走它发请求) */
  http: HttpClientLike
  /** 实时连接建连前读取 token;返回空值时不建连 */
  tokenProvider: () => string | null | undefined
  /** 服务 base 地址(默认 ws 地址由它推导) */
  baseUrl: string
  /** 覆盖默认 ws 地址构造(默认 defaultWsUrlBuilder(baseUrl, ticket)) */
  wsUrlBuilder?: (ticket: string) => string
  reconnect?: ReconnectOptions
  /** 非浏览器或测试环境可注入 fetch；知识库文档进度 SSE 使用。 */
  fetchImpl?: typeof fetch
}

/** 装配产物:rest 与 rpc 共享同一 http 实例,业务侧直接喂给 createChatEngine/useChatRun。 */
export interface ChatClient {
  http: HttpClientLike
  baseUrl: string
  rest: ChatRest
  rpc: ChatRpcClient
  files: UserFilesApi
  knowledgeBases: KnowledgeBasesApi
  resources: ResourcesApi
}

/** 装配 ChatRpcClient 与 chat REST:环境耦合(http/token/baseUrl/ws 地址/退避)的唯一收口。 */
export function createChatClient(config: ChatClientConfig): ChatClient {
  const wsUrlBuilder = config.wsUrlBuilder ?? ((ticket: string) => defaultWsUrlBuilder(config.baseUrl, ticket))
  const rest = createChatRest(config.http)
  const rpc = new ChatRpcClient({
    tokenProvider: config.tokenProvider,
    ticketProvider: () => rest.createChatWebSocketTicket(),
    wsUrlBuilder,
    reconnect: config.reconnect
  })
  const files = createUserFilesApi(config.http)
  const knowledgeBases = createKnowledgeBasesApi(config.http, config)
  const resources = createResourcesApi(config.http)
  return { http: config.http, baseUrl: config.baseUrl, rest, rpc, files, knowledgeBases, resources }
}
