import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClientToolRegistry } from '../../src/clientTools/registry.js'
import type { ChatRpcClient } from '../../src/transport/chatRpcClient.js'

function fakeRpc() {
  return { request: vi.fn(async (method: string, params: any) => ({ method, params, skipped: [] })) } as unknown as ChatRpcClient
}

describe('clientTools registry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('defineClientTool 校验名字与 handler', () => {
    const reg = createClientToolRegistry({ rpc: fakeRpc(), version: '1' })
    expect(() => reg.defineClientTool({ name: '9bad' }, () => '')).toThrow()
    expect(() => reg.defineClientTool({ name: 'ok_name' }, 'x' as any)).toThrow()
    reg.defineClientTool({ name: 'readPage' }, () => 'ok')
    expect(reg.snapshot().map(t => t.name)).toEqual(['readPage'])
  })

  it('空清单不声明(防止洗掉别的端已声明的清单)', async () => {
    const rpc = fakeRpc()
    const reg = createClientToolRegistry({ rpc, version: '1' })
    expect(reg.declarePayloadFor('s1')).toBeNull()
    await expect(reg.declare('s1')).resolves.toBeNull()
    expect(rpc.request).not.toHaveBeenCalled()
  })

  it('declarePayloadFor 首轮捎带 + markDeclared 幂等', () => {
    const reg = createClientToolRegistry({ rpc: fakeRpc(), version: '1' })
    reg.defineClientTool({ name: 'screenshotTab', description: 'd', parameters: { type: 'object' } }, () => 'x')
    const p1 = reg.declarePayloadFor('s1')
    expect(p1).toMatchObject({ clientType: 'browser_ext', clientTools: [{ name: 'screenshotTab' }] })
    expect(p1!.capabilitiesVersion).toMatch(/^1\+/)
    reg.markDeclared('s1')
    expect(reg.declarePayloadFor('s1')).toBeNull()
  })

  it('同 callId 补发:不重跑 handler,原样重发结局', async () => {
    const rpc = fakeRpc()
    const reg = createClientToolRegistry({ rpc, version: '1' })
    const handler = vi.fn(async () => 'result-A')
    reg.defineClientTool({ name: 'click' }, handler)
    const event = { callId: 'c1', name: 'click', args: '{"x":1}', sessionId: 's1' }
    await reg.handleToolCallRequest('r1', event as any)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(rpc.request).toHaveBeenCalledWith('chat.tool.result', expect.objectContaining({ callId: 'c1', ok: true, result: 'result-A' }))
    vi.mocked(rpc.request).mockClear()
    await reg.handleToolCallRequest('r1', event as any) // 补发
    expect(handler).toHaveBeenCalledTimes(1) // 不重跑
    expect(rpc.request).toHaveBeenCalledWith('chat.tool.result', expect.objectContaining({ callId: 'c1', result: 'result-A' }))
  })

  it('handler 运行中收到补发:不重跑也不抢答', async () => {
    const rpc = fakeRpc()
    const reg = createClientToolRegistry({ rpc, version: '1' })
    let release!: (value: string) => void
    const gate = new Promise<string>(resolve => { release = resolve })
    const handler = vi.fn(() => gate)
    reg.defineClientTool({ name: 'slow' }, handler)
    const event = { callId: 'c3', name: 'slow', args: '{}', sessionId: 's1' }
    const first = reg.handleToolCallRequest('r1', event as any)
    // 此时 handler 已被受理但尚未返回;补发同一 callId 到达
    await reg.handleToolCallRequest('r1', event as any)
    expect(handler).toHaveBeenCalledTimes(1) // 不重跑
    expect(rpc.request).not.toHaveBeenCalled() // 不抢答:等首次执行自己回传
    release('late-result')
    await first
    expect(rpc.request).toHaveBeenCalledTimes(1) // 原执行恰好回传一次
    expect(rpc.request).toHaveBeenCalledWith('chat.tool.result', expect.objectContaining({ callId: 'c3', ok: true, result: 'late-result' }))
  })

  it('handler 卡死被 watchdog 截断为 ok:false', async () => {
    vi.useFakeTimers()
    const rpc = fakeRpc()
    const reg = createClientToolRegistry({ rpc, version: '1' })
    reg.defineClientTool({ name: 'slow' }, () => new Promise(() => {}))
    const p = reg.handleToolCallRequest('r1', { callId: 'c2', name: 'slow' } as any)
    await vi.advanceTimersByTimeAsync(100001)
    await p
    expect(rpc.request).toHaveBeenCalledWith('chat.tool.result', expect.objectContaining({ ok: false, error: expect.stringMatching(/超过 100 秒/) }))
  })

  it('handler 抛异常:回传 ok:false 与异常 message', async () => {
    const rpc = fakeRpc()
    const reg = createClientToolRegistry({ rpc, version: '1' })
    reg.defineClientTool({ name: 'boom' }, () => {
      throw new Error('炸了')
    })
    await reg.handleToolCallRequest('r1', { callId: 'c4', name: 'boom' } as any)
    expect(rpc.request).toHaveBeenCalledWith('chat.tool.result', expect.objectContaining({ callId: 'c4', ok: false, error: '炸了' }))
  })

  it('未知工具名:立刻回传 ok:false', async () => {
    const rpc = fakeRpc()
    const reg = createClientToolRegistry({ rpc, version: '1' })
    await reg.handleToolCallRequest('r1', { callId: 'c5', name: 'nope' } as any)
    expect(rpc.request).toHaveBeenCalledWith('chat.tool.result', expect.objectContaining({ callId: 'c5', ok: false, error: expect.stringContaining('本端没有名为') }))
  })

  it('declare skipped:经 onNotice 以 warning 提示', async () => {
    const rpc = { request: vi.fn(async () => ({ skipped: ['x'] })) } as unknown as ChatRpcClient
    const onNotice = vi.fn()
    const reg = createClientToolRegistry({ rpc, version: '1', onNotice })
    reg.defineClientTool({ name: 't' }, () => 'ok')
    await reg.declare('s9')
    expect(onNotice).toHaveBeenCalledWith('部分客户端工具未生效：x', 'warning')
  })
})
