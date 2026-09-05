/** 与三端现有 axios 封装兼容的最小契约。 */
export interface HttpResult<T = any> {
  data: T
  [key: string]: any
}

export interface HttpRequestConfig {
  url: string
  method: 'get' | 'post' | 'put' | 'delete'
  params?: Record<string, any>
  data?: any
  /** repeatSubmit 等防重标记为 boolean(三端 axios 拦截器约定),故值不止 string */
  headers?: Record<string, string | boolean>
  [key: string]: any
}

export interface HttpClientLike {
  request(config: HttpRequestConfig): Promise<HttpResult>
}
