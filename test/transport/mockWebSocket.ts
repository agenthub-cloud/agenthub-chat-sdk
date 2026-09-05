/** 手工驱动的 WebSocket 测试替身。 */
export class MockWebSocket {
  static instances: MockWebSocket[] = []
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
  readyState = MockWebSocket.CONNECTING
  sent: any[] = []
  onopen: (() => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  constructor(public url: string) { MockWebSocket.instances.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close(code = 1000, reason = '') {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }
  /* 测试驱动 */
  serverOpen() { this.readyState = MockWebSocket.OPEN; this.onopen?.() }
  serverMessage(msg: object) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  serverDrop() { this.readyState = MockWebSocket.CLOSED; this.onclose?.({ code: 1006, reason: '' }) }
  lastRequest(): { id: string; method: string; params: any } { return this.sent[this.sent.length - 1] }
  respond(id: string, result: unknown) { this.serverMessage({ jsonrpc: '2.0', id, result }) }
  respondError(id: string, message: string) { this.serverMessage({ jsonrpc: '2.0', id, error: { code: -1, message } }) }
}

export function installMockWebSocket() {
  const RealWS = (globalThis as any).WebSocket
  MockWebSocket.instances = []
  ;(globalThis as any).WebSocket = MockWebSocket
  return () => { (globalThis as any).WebSocket = RealWS }
}
