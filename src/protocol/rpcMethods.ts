/**
 * WS JSON-RPC 方法名常量,后端方法名全集(已逐一核实,共 15 个)。
 * 与后端 `ruoyi-admin/.../websocket/chat/` 对齐。
 */
export const RPC_METHODS = {
  SESSION_SUBSCRIBE: 'chat.session.subscribe',
  SESSION_UNSUBSCRIBE: 'chat.session.unsubscribe',
  RUN_CREATE: 'chat.run.create',
  RUN_GET: 'chat.run.get',
  RUN_SUBSCRIBE: 'chat.run.subscribe',
  RUN_UNSUBSCRIBE: 'chat.run.unsubscribe',
  RUN_CANCEL: 'chat.run.cancel',
  /** 服务端推送:会话级事件 */
  SESSION_EVENT: 'chat.session.event',
  /** 服务端推送:run 级 JSON-RPC 事件信封 */
  EVENT: 'chat.event',
  /** 客户端回传工具执行结果 */
  TOOL_RESULT: 'chat.tool.result',
  /** 客户端声明自身可处理的工具清单 */
  SESSION_CLIENT_DECLARE: 'chat.session.client.declare',
  PING: 'chat.ping',
  READY: 'chat.ready',
  USERNAME: 'chat.username',
  ADMIN: 'chat.admin'
} as const
