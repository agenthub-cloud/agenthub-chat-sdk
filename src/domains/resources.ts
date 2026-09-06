import { requestAs, type HttpClientLike, type HttpParam } from '../http/types.js'
import type { EntityId } from './files.js'

export interface SkillResource {
  id?: EntityId
  skillId?: EntityId
  name?: string
  code?: string
  description?: string
  promptTemplate?: string
  visibility?: string
  [key: string]: unknown
}

export interface SkillResourceFile {
  fileId: EntityId
  relPath?: string
  fileSize?: number
  summary?: string
  [key: string]: unknown
}

export interface ResourceListResult {
  data?: SkillResource[]
  rows?: SkillResource[]
  [key: string]: unknown
}

export interface ResourcesApi {
  options(): Promise<unknown>
  desktop(): Promise<ResourceListResult>
  list(query?: Record<string, HttpParam | HttpParam[]>): Promise<ResourceListResult>
  get(skillId: EntityId): Promise<unknown>
  create(data: SkillResource): Promise<unknown>
  update(data: SkillResource): Promise<unknown>
  remove(skillIds: EntityId | EntityId[]): Promise<unknown>
  listFiles(skillId: EntityId): Promise<unknown>
  uploadFile(skillId: EntityId, file: Blob, summary?: string): Promise<unknown>
  removeFile(skillId: EntityId, fileId: EntityId): Promise<unknown>
}

const ids = (value: EntityId | EntityId[]) => Array.isArray(value) ? value.join(',') : value

/** 对话侧资源（技能）域，包含技能元数据与渐进披露参考文件。 */
export function createResourcesApi(http: HttpClientLike): ResourcesApi {
  return {
    options: () => http.request({ url: '/ai/skill/options', method: 'get' }),
    desktop: () => requestAs<ResourceListResult>(http, { url: '/ai/skill/desktop', method: 'get' }),
    list: (query = {}) => requestAs<ResourceListResult>(http, { url: '/ai/skill/list', method: 'get', params: query }),
    get: skillId => http.request({ url: `/ai/skill/${skillId}`, method: 'get' }),
    create: data => http.request({ url: '/ai/skill', method: 'post', data }),
    update: data => http.request({ url: '/ai/skill', method: 'put', data }),
    remove: skillIds => http.request({ url: `/ai/skill/${ids(skillIds)}`, method: 'delete' }),
    listFiles: skillId => http.request({ url: `/ai/skill/${skillId}/files`, method: 'get' }),
    uploadFile(skillId, file, summary) {
      const data = new FormData()
      data.append('file', file)
      if (summary) data.append('summary', summary)
      return http.request({
        url: `/ai/skill/${skillId}/files`, method: 'post', data,
        headers: { repeatSubmit: false }, timeout: 120000
      })
    },
    removeFile: (skillId, fileId) => http.request({
      url: `/ai/skill/${skillId}/files/${fileId}`, method: 'delete'
    })
  }
}
