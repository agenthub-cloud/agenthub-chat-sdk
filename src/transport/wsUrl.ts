/**
 * 环境无关的默认 WS 地址构造。
 * 移植自主仓 `desktop/src/api/chatRpc.js` 的 `buildWebSocketUrl`,唯一变换:
 * 不再读 `import.meta.env.VITE_APP_BASE_API` 与 `window.location.origin`——
 * base 与 origin 改由调用方显式传入(浏览器端由 createChatClient 注入);
 * `base || '/'` 兜底、https→wss、pathname 去尾斜杠 + `/ws/ai/chat`、
 * search `?ticket=` + encodeURIComponent、hash 清空,均与源实现逐行一致。
 */

/** 环境无关的默认 WS 地址构造: baseUrl + /ws/ai/chat?ticket=。base 为空或相对路径时用 origin 解析。 */
export function defaultWsUrlBuilder(base: string, ticket: string, origin = 'http://localhost'): string {
  const url = new URL(base || '/', origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = url.pathname.replace(/\/$/, '') + '/ws/ai/chat'
  url.search = '?ticket=' + encodeURIComponent(ticket)
  url.hash = ''
  return url.toString()
}
