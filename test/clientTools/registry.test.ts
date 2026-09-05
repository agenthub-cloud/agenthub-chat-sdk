import { describe, expect, it, vi } from 'vitest'
import { createClientToolRegistry } from '../../src/clientTools/registry.js'
import type { ChatRpcClient } from '../../src/transport/chatRpcClient.js'

function fakeRpc() {
  return { request: vi.fn(async (method: string, params: any) => ({ method, params, skipped: [] })) } as unknown as ChatRpcClient
}

describe('clientTools registry', () => {
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

  it('handler 卡死被 watchdog 截断为 ok:false', async () => {
    vi.useFakeTimers()
    const rpc = fakeRpc()
    const reg = createClientToolRegistry({ rpc, version: '1' })
    reg.defineClientTool({ name: 'slow' }, () => new Promise(() => {}))
    const p = reg.handleToolCallRequest('r1', { callId: 'c2', name: 'slow' } as any)
    await vi.advanceTimersByTimeAsync(100001)
    await p
    expect(rpc.request).toHaveBeenCalledWith('chat.tool.result', expect.objectContaining({ ok: false, error: expect.stringMatching(/超过 100 秒/) }))
    vi.useRealTimers()
  })
})
