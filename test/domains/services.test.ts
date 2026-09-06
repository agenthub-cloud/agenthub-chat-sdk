import { describe, expect, it, vi } from 'vitest'
import {
  createKnowledgeBasesApi,
  createResourcesApi,
  createUserFilesApi,
  type HttpClientLike,
  type HttpRequestConfig
} from '../../src/index.js'

function fakeHttp(result: unknown = { ok: true }) {
  const requests: HttpRequestConfig[] = []
  const http: HttpClientLike = {
    async request(config) {
      requests.push(config)
      return result
    }
  }
  return { http, requests }
}

describe('files domain', () => {
  it('封装列表、工作区投递与下载，且下载保持无 DOM', async () => {
    const { http, requests } = fakeHttp(new Blob(['hello']))
    const files = createUserFilesApi(http)
    await files.list({ keyword: 'readme' })
    await files.attach(7, 's1', 2)
    expect(await (await files.download(7)).text()).toBe('hello')
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/ai/files', method: 'get', params: { keyword: 'readme' } }),
      expect.objectContaining({ url: '/ai/files/7/attach', method: 'post', params: { sessionId: 's1', projectId: 2 } }),
      expect.objectContaining({ url: '/ai/files/7/download', responseType: 'blob' })
    ]))
  })
})

describe('knowledge-base domain', () => {
  it('封装文档与图谱路由', async () => {
    const { http, requests } = fakeHttp()
    const kb = createKnowledgeBasesApi(http, { baseUrl: '/dev-api', tokenProvider: () => 'token' })
    await kb.listDocuments(3, { pageNum: 1 })
    await kb.exploreGraph(3, { query: 'AgentHub', depth: 2 })
    await kb.renameDocument(3, 9, '新版文档')
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/ai/kb/3/document/list', params: { pageNum: 1 } }),
      expect.objectContaining({ url: '/ai/kb/3/graph/explore', method: 'post' }),
      expect.objectContaining({ url: '/ai/kb/3/document/9/name', data: { docName: '新版文档' } })
    ]))
  })

  it('解析 SSE connected 与文档事件，并通过请求头传 token', async () => {
    const body = 'event: connected\ndata: {}\n\ndata: {"docId":9,"status":"READY"}\n\n'
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }))
    const connected = vi.fn()
    const onEvent = vi.fn()
    const kb = createKnowledgeBasesApi(fakeHttp().http, {
      baseUrl: 'https://demo.test/api/', tokenProvider: () => 'secret', fetchImpl
    })
    await kb.subscribeDocumentEvents(3, { onConnected: connected, onEvent })
    expect(fetchImpl).toHaveBeenCalledWith('https://demo.test/api/ai/kb/3/document/events', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer secret' })
    }))
    expect(connected).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith({ docId: 9, status: 'READY' })
  })
})

describe('resources domain', () => {
  it('封装技能与参考文件路由', async () => {
    const { http, requests } = fakeHttp()
    const resources = createResourcesApi(http)
    await resources.desktop()
    await resources.remove([1, 2])
    await resources.removeFile(1, 8)
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: '/ai/skill/desktop', method: 'get' }),
      expect.objectContaining({ url: '/ai/skill/1,2', method: 'delete' }),
      expect.objectContaining({ url: '/ai/skill/1/files/8', method: 'delete' })
    ]))
  })
})
