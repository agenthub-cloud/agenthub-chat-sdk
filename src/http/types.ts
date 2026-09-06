/** 与三端现有 axios 封装兼容的最小契约。 */
export interface HttpResult<T = unknown> {
  data: T
  [key: string]: unknown
}

export type HttpParam = string | number | boolean | null | undefined

export interface HttpRequestConfig {
  url: string
  method: 'get' | 'post' | 'put' | 'delete'
  params?: Record<string, HttpParam | HttpParam[]>
  data?: unknown
  /** repeatSubmit 等防重标记为 boolean(三端 axios 拦截器约定),故值不止 string */
  headers?: Record<string, string | boolean>
  responseType?: 'json' | 'blob' | 'arraybuffer' | 'text'
  timeout?: number
  silent?: boolean
  signal?: AbortSignal
  onUploadProgress?: (event: { loaded: number; total?: number }) => void
  [key: string]: unknown
}

export interface HttpClientLike {
  request(config: HttpRequestConfig): Promise<unknown>
}

/** 在域服务边界集中声明响应类型，宿主的 axios/fetch 适配器无需实现泛型方法。 */
export function requestAs<T>(http: HttpClientLike, config: HttpRequestConfig): Promise<T> {
  return http.request(config) as Promise<T>
}
