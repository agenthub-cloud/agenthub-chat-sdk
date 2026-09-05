import { describe, expect, it } from 'vitest'
import { defaultWsUrlBuilder } from '../../src/transport/wsUrl.js'

describe('defaultWsUrlBuilder', () => {
  it('同源相对路径 http→ws', () => {
    expect(defaultWsUrlBuilder('http://localhost:8080', 'tk'))
      .toBe('ws://localhost:8080/ws/ai/chat?ticket=tk')
  })
  it('https→wss，保留已有上下文路径，ticket URL 编码', () => {
    expect(defaultWsUrlBuilder('https://a.com/agent', 't k'))
      .toBe('wss://a.com/agent/ws/ai/chat?ticket=t%20k')
  })
  it('base 带尾斜杠时去尾斜杠，不产生双斜杠', () => {
    expect(defaultWsUrlBuilder('https://a.com/agent/', 'tk'))
      .toBe('wss://a.com/agent/ws/ai/chat?ticket=tk')
  })
  it('空 base 回退 /（由调用方传入的 origin 参数兜底）', () => {
    expect(defaultWsUrlBuilder('', 'tk', 'http://x.local')).toBe('ws://x.local/ws/ai/chat?ticket=tk')
  })
})
