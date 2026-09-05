/** transport 层统一错误:code 供 engine 区分可重试/终态。 */
export type ChatTransportErrorCode =
  | 'no-ticket' | 'handshake-timeout' | 'handshake-failed'
  | 'disconnected' | 'closed' | 'request-timeout'
export class ChatTransportError extends Error {
  constructor(public readonly code: ChatTransportErrorCode, message: string) {
    super(message)
    this.name = 'ChatTransportError'
  }
}
