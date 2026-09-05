/**
 * vue 适配层单测(不挂载组件):effect + nextTick 断言 engine 事件后 state.value
 * 响应式更新,以及 useConnectionState 的状态流转。client 用纯 fake(engine.test.ts
 * 同款形状),聚焦响应式桥接本身。
 */
import { describe, expect, it, vi } from 'vitest'
import { effect, nextTick } from 'vue'
import { useChatRun, useConnectionState } from '../../src/vue.js'
import { EVENT_TYPES } from '../../src/protocol/eventTypes.js'

/** engine.test.ts 同款纯 fake client(rest 为 createChatRest 形状,rpc 为 ChatRpcClient 纯 fake)。 */
function makeClient() {
  const client = {
    rest: {
      createChatRun: vi.fn(async () => ({ data: { runId: 'r1', status: 'QUEUED' } })),
      getChatRun: vi.fn(async () => ({ data: null })),
      getChatRunState: vi.fn(async () => ({ data: null })),
      getActiveChatRun: vi.fn(async () => ({ data: null })),
      getLatestChatRun: vi.fn(async () => ({ data: null })),
      cancelChatRun: vi.fn(async () => ({ data: null })),
      confirmChatTool: vi.fn(async () => ({ data: null })),
      createChatWebSocketTicket: vi.fn(async () => ({ data: null })),
      getContextUsage: vi.fn(async () => ({ data: null })),
      rollbackLastTurn: vi.fn(async () => ({ data: null }))
    },
    rpc: {
      subscribe: vi.fn(async () => ({})),
      unsubscribe: vi.fn(async () => {}),
      subscribeSession: vi.fn(async () => ({})),
      unsubscribeSession: vi.fn(async () => {}),
      onConnectionState: vi.fn(() => () => {}),
      retain: vi.fn(() => () => {})
    },
    clientTools: null
  }
  return client as any
}

describe('useChatRun', () => {
  it('engine 事件后 state.value 响应式更新:effect 随 notify 重跑,status/loading 流转', async () => {
    const client = makeClient()
    const run = useChatRun(client, { onToolConfirm: async () => true })
    const seen: string[] = []
    effect(() => { seen.push(`${run.state.value.status}:${run.state.value.loading}`) })

    expect(seen).toEqual(['idle:false'])

    await run.send('hi', { sessionId: 's1' })
    await nextTick()
    // send 收口在 streaming(乐观轮已挂上活动 run)
    expect(run.state.value.status).toBe('streaming')
    expect(run.state.value.loading).toBe(true)
    expect(run.state.value.turns).toHaveLength(1)
    expect(seen).toContain('streaming:true')

    const onEvent = client.rpc.subscribe.mock.calls[0][2] as (event: any, envelope: any) => void
    onEvent({ type: EVENT_TYPES.DONE, status: 'SUCCEEDED', text: '答' }, { runId: 'r1', seq: 1 })
    await nextTick()

    expect(run.state.value.status).toBe('done')
    expect(run.state.value.loading).toBe(false)
    expect(run.state.value.turns[0].completed).toBe(true)
    expect(run.state.value.turns[0].steps.some(s => s.type === 'content' && s.text === '答')).toBe(true)
    // effect 确实随每次 notify 重跑,而不是停在初始快照
    expect(seen).toContain('done:false')
    expect(seen.length).toBeGreaterThan(2)
  })

  it('返回面:engine 方法可用,destroy 释放 retain 并摘除连接监听', async () => {
    const client = makeClient()
    const released = vi.fn()
    const offState = vi.fn()
    client.rpc.retain = vi.fn(() => released)
    client.rpc.onConnectionState = vi.fn(() => offState)
    const run = useChatRun(client, { onToolConfirm: async () => true })
    expect(typeof run.send).toBe('function')
    expect(typeof run.abort).toBe('function')

    run.destroy()

    // engine 的 onBeforeUnmount 等价物:retain 释放函数与 onConnectionState 的 off 各一次
    expect(released).toHaveBeenCalledTimes(1)
    expect(offState).toHaveBeenCalledTimes(1)
    expect(client.rpc.unsubscribeSession).not.toHaveBeenCalled()
  })

  it('options.clientTools 捎带给引擎首轮 declare', async () => {
    const client = makeClient()
    const clientTools = {
      declarePayloadFor: vi.fn(() => ({ clientType: 'browser_ext', capabilitiesVersion: '0.1.0+abc', clientTools: [{ name: 'pickDate', description: '', parameters: {} }] })),
      markDeclared: vi.fn()
    }
    const run = useChatRun(client, { clientTools: clientTools as any })

    await run.send('hi', { sessionId: 's1' })

    expect(clientTools.declarePayloadFor).toHaveBeenCalledWith('s1')
    expect(client.rest.createChatRun.mock.calls[0][0]).toMatchObject({ clientType: 'browser_ext', clientRequestId: expect.any(String) })
    expect(clientTools.markDeclared).toHaveBeenCalledWith('s1')
  })
})

describe('useConnectionState', () => {
  it('初始值取 isOpen,连接状态流转经 ref 响应', () => {
    let listener: ((s: string) => void) | null = null
    const client = {
      rpc: {
        isOpen: () => false,
        onConnectionState: vi.fn((l: (s: string) => void) => { listener = l; return () => {} })
      }
    } as any
    const state = useConnectionState(client)

    expect(state.value).toBe('closed')
    listener!('open')
    expect(state.value).toBe('open')
    listener!('reconnecting')
    expect(state.value).toBe('reconnecting')
  })
})
