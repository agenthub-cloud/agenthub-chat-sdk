import { requestAs, type HttpClientLike, type HttpParam } from '../http/types.js'

export type EntityId = string | number

export interface UserFile {
  fileId: EntityId
  name: string
  size?: number
  mime?: string
  image?: boolean
  createTime?: string | number
  [key: string]: unknown
}

export interface UserFileListResult {
  files: UserFile[]
  storageEnabled?: boolean
  [key: string]: unknown
}

export interface UserFileQuota {
  usedBytes: number
  quotaBytes: number
  fileCount: number
  maxFiles?: number
  maxFileBytes?: number
  storageEnabled?: boolean
  [key: string]: unknown
}

export interface AttachedUserFile {
  name: string
  path: string
  mime?: string
  size?: number
  [key: string]: unknown
}

export interface UserFilesApi {
  list(params?: Record<string, HttpParam | HttpParam[]>): Promise<UserFileListResult>
  quota(): Promise<UserFileQuota>
  upload(file: Blob, onProgress?: (percent: number) => void): Promise<unknown>
  rename(fileId: EntityId, name: string): Promise<unknown>
  remove(fileId: EntityId): Promise<unknown>
  previewUrl(fileId: EntityId, download?: boolean): Promise<{ url?: string; [key: string]: unknown }>
  attach(fileId: EntityId, sessionId: string, projectId?: EntityId): Promise<AttachedUserFile>
  saveFromWorkspace(sessionId: string, path: string, projectId?: EntityId): Promise<unknown>
  download(fileId: EntityId): Promise<Blob>
  readText(fileId: EntityId, maxBytes?: number): Promise<string | null>
}

function asBlob(value: unknown): Blob {
  if (value instanceof Blob) return value
  return new Blob([value as BlobPart])
}

/** 个人文件域。返回 Blob 而不触碰 DOM，浏览器/桌面/插件可自行决定如何保存。 */
export function createUserFilesApi(http: HttpClientLike): UserFilesApi {
  const download = async (fileId: EntityId) => {
    const response = await http.request({
      url: `/ai/files/${fileId}/download`, method: 'get', responseType: 'blob'
    })
    return asBlob(response)
  }

  return {
    list: (params = {}) => requestAs<UserFileListResult>(http, { url: '/ai/files', method: 'get', params }),
    quota: () => requestAs<UserFileQuota>(http, { url: '/ai/files/quota', method: 'get' }),
    upload(file, onProgress) {
      const data = new FormData()
      data.append('file', file)
      return http.request({
        url: '/ai/files/upload', method: 'post', data,
        headers: { repeatSubmit: false }, timeout: 300000,
        onUploadProgress(event) {
          if (onProgress && event.total) onProgress(Math.round(event.loaded * 100 / event.total))
        }
      })
    },
    rename: (fileId, name) => http.request({
      url: `/ai/files/${fileId}/name`, method: 'put', data: { name }
    }),
    remove: fileId => http.request({ url: `/ai/files/${fileId}`, method: 'delete' }),
    previewUrl: (fileId, shouldDownload = false) => requestAs<{ url?: string; [key: string]: unknown }>(http, {
      url: `/ai/files/${fileId}/preview-url`, method: 'get',
      params: shouldDownload ? { download: true } : {}
    }),
    attach: (fileId, sessionId, projectId) => requestAs<AttachedUserFile>(http, {
      url: `/ai/files/${fileId}/attach`, method: 'post',
      params: projectId == null ? { sessionId } : { sessionId, projectId }
    }),
    saveFromWorkspace: (sessionId, path, projectId) => http.request({
      url: '/ai/files/save-from-workspace', method: 'post',
      params: projectId == null ? { sessionId, path } : { sessionId, path, projectId }
    }),
    download,
    async readText(fileId, maxBytes = 200 * 1024) {
      const blob = await download(fileId)
      return blob.size > maxBytes ? null : blob.text()
    }
  }
}
