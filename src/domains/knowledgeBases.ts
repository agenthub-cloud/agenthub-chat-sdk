import type { HttpClientLike, HttpParam } from '../http/types.js'
import type { EntityId } from './files.js'

export interface KnowledgeBase {
  kbId: EntityId
  kbName: string
  description?: string
  visibility?: string
  status?: string
  [key: string]: unknown
}

export interface KnowledgeDocument {
  docId: EntityId
  docName?: string
  fileName?: string
  fileSize?: number
  status?: string
  createTime?: string | number
  createBy?: string
  [key: string]: unknown
}

export interface KnowledgeGraphExploreInput {
  query?: string
  depth?: number
  limit?: number
  edgeLimit?: number
  docIds?: EntityId[]
  [key: string]: unknown
}

export interface KnowledgeDocumentEventOptions {
  signal?: AbortSignal
  onEvent?: (event: Record<string, unknown>) => void
  onConnected?: () => void
}

export interface KnowledgeBasesApi {
  options(query?: Record<string, HttpParam | HttpParam[]>): Promise<unknown>
  desktop(query?: Record<string, HttpParam | HttpParam[]>): Promise<unknown>
  create(data: Partial<KnowledgeBase>): Promise<unknown>
  update(data: Partial<KnowledgeBase>): Promise<unknown>
  remove(kbIds: EntityId | EntityId[]): Promise<unknown>
  listDocuments(kbId: EntityId, query?: Record<string, HttpParam | HttpParam[]>): Promise<unknown>
  getDocument(kbId: EntityId, docId: EntityId): Promise<unknown>
  subscribeDocumentEvents(kbId: EntityId, options?: KnowledgeDocumentEventOptions): Promise<void>
  uploadDocument(kbId: EntityId, data: FormData, onDuplicate?: 'skip' | 'force'): Promise<unknown>
  reprocessDocument(kbId: EntityId, docId: EntityId): Promise<unknown>
  renameDocument(kbId: EntityId, docId: EntityId, docName: string): Promise<unknown>
  removeDocuments(kbId: EntityId, docIds: EntityId | EntityId[]): Promise<unknown>
  graphDocuments(kbId: EntityId): Promise<unknown>
  exploreGraph(kbId: EntityId, data?: KnowledgeGraphExploreInput): Promise<unknown>
  graphEntity(kbId: EntityId, name: string): Promise<unknown>
  graphRelation(kbId: EntityId, source: string, target: string, label?: string): Promise<unknown>
  previewDocument(kbId: EntityId, docId: EntityId): Promise<unknown>
  downloadDocument(kbId: EntityId, docId: EntityId): Promise<Blob>
}

export interface KnowledgeBasesApiOptions {
  baseUrl: string
  tokenProvider: () => string | null | undefined
  fetchImpl?: typeof fetch
}

const ids = (value: EntityId | EntityId[]) => Array.isArray(value) ? value.join(',') : value
const blobOf = (value: unknown) => value instanceof Blob ? value : new Blob([value as BlobPart])

async function consumeSse(response: Response, options: KnowledgeDocumentEventOptions) {
  if (!response.ok || !response.body) {
    throw new Error(response.status === 401 ? '登录已过期，请重新登录' : '文档状态连接失败')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      let eventName = 'message'
      const dataLines: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (eventName === 'connected') options.onConnected?.()
      else if (dataLines.length) {
        try {
          const parsed: unknown = JSON.parse(dataLines.join('\n'))
          if (parsed && typeof parsed === 'object') options.onEvent?.(parsed as Record<string, unknown>)
        } catch (_) { /* 无效事件不应中断后续状态推送 */ }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

/** 知识库域，含文档管理、处理进度 SSE、解析预览与知识图谱。 */
export function createKnowledgeBasesApi(http: HttpClientLike, config: KnowledgeBasesApiOptions): KnowledgeBasesApi {
  return {
    options: (query = {}) => http.request({ url: '/ai/kb/options', method: 'get', params: query }),
    desktop: (query = {}) => http.request({ url: '/ai/kb/desktop', method: 'get', params: query }),
    create: data => http.request({ url: '/ai/kb/desktop', method: 'post', data }),
    update: data => http.request({ url: '/ai/kb', method: 'put', data }),
    remove: kbIds => http.request({ url: `/ai/kb/${ids(kbIds)}`, method: 'delete' }),
    listDocuments: (kbId, query = {}) => http.request({
      url: `/ai/kb/${kbId}/document/list`, method: 'get', params: query
    }),
    getDocument: (kbId, docId) => http.request({
      url: `/ai/kb/${kbId}/document/${docId}`, method: 'get', silent: true
    }),
    async subscribeDocumentEvents(kbId, options = {}) {
      const fetcher = config.fetchImpl ?? globalThis.fetch
      if (!fetcher) throw new Error('当前运行环境未提供 fetch，无法订阅文档状态')
      const token = config.tokenProvider()
      const base = config.baseUrl.replace(/\/$/, '')
      const response = await fetcher(`${base}/ai/kb/${encodeURIComponent(String(kbId))}/document/events`, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        cache: 'no-store', signal: options.signal
      })
      await consumeSse(response, options)
    },
    uploadDocument: (kbId, data, onDuplicate = 'skip') => http.request({
      url: `/ai/kb/${kbId}/document?onDuplicate=${onDuplicate === 'force' ? 'force' : 'skip'}`,
      method: 'post', data, headers: { repeatSubmit: false }, timeout: 120000
    }),
    reprocessDocument: (kbId, docId) => http.request({
      url: `/ai/kb/${kbId}/document/${docId}/reprocess`, method: 'post'
    }),
    renameDocument: (kbId, docId, docName) => http.request({
      url: `/ai/kb/${kbId}/document/${docId}/name`, method: 'put', data: { docName }
    }),
    removeDocuments: (kbId, docIds) => http.request({
      url: `/ai/kb/${kbId}/document/${ids(docIds)}`, method: 'delete'
    }),
    graphDocuments: kbId => http.request({ url: `/ai/kb/${kbId}/graph/docs`, method: 'get' }),
    exploreGraph: (kbId, data = {}) => http.request({
      url: `/ai/kb/${kbId}/graph/explore`, method: 'post', data,
      headers: { repeatSubmit: false }
    }),
    graphEntity: (kbId, name) => http.request({
      url: `/ai/kb/${kbId}/graph/entity`, method: 'get', params: { name }
    }),
    graphRelation: (kbId, source, target, label) => http.request({
      url: `/ai/kb/${kbId}/graph/relation`, method: 'get', params: { source, target, label }
    }),
    previewDocument: (kbId, docId) => http.request({
      url: `/ai/kb/${kbId}/document/${docId}/preview`, method: 'get'
    }),
    async downloadDocument(kbId, docId) {
      return blobOf(await http.request({
        url: `/ai/kb/${kbId}/document/${docId}/download`, method: 'get',
        responseType: 'blob', timeout: 120000
      }))
    }
  }
}
