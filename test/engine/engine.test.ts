import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatEngine } from '../../src/engine/engine.js'
import { EVENT_TYPES } from '../../src/protocol/eventTypes.js'

/**
 * 纯 fake client:rest 为 createChatRest 形状的 vi.fn 集合,rpc 为 ChatRpcClient 的
 * 纯 fake(更快更稳)。响应形状按 desktop 源码的取数路径:rest 各函数 resolve
 * HttpResult,response.data 即业务对象(send 取 response.data 为 run,状态页取
 * response.data 为 { run, steps, snapshotSeq })。
 */
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
  // 用例会按场景替换个别 fake 实现,收口为 any 省去逐 mock 断言噪音
  return client as any
}

describe('createChatEngine', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('send 全链路:乐观轮插入 → createChatRun → rpc.subscribe → done 收口', async () => {
    const client = makeClient()
    const onDone = vi.fn()
    const engine = createChatEngine(client, { onDone })

    const returned = await engine.send('hi', { sessionId: 's1', agentId: 1, skillIds: [9] })

    // 乐观轮已插入,skillIds 盖章(clientRequestId 自动生成)
    expect(engine.state.turns).toHaveLength(1)
    expect(engine.state.turns[0].userMsg).toMatchObject({ messageType: 'USER', content: 'hi' })
    expect(engine.state.turns[0].skillIds).toEqual([9])
    expect(engine.state.turns[0].runStatus).toBe('QUEUED')
    const request = client.rest.createChatRun.mock.calls[0][0]
    expect(request).toMatchObject({ sessionId: 's1', agentId: 1, clientRequestId: expect.any(String) })
    expect(engine.state.loading).toBe(true)

    // rpc.subscribe 被调 runId='r1',afterSeq=0
    expect(client.rpc.subscribe).toHaveBeenCalledWith('r1', 0, expect.any(Function), expect.any(Function), expect.any(Function))
    expect(engine.state.activeRunId).toBe('r1')
    expect(returned).toMatchObject({ runId: 'r1' })

    // 经 applyEvent 推 done → 轮收口
    const onEvent = client.rpc.subscribe.mock.calls[0][2] as (event: any, envelope: any) => void
    onEvent({ type: EVENT_TYPES.DONE, status: 'SUCCEEDED', text: '答' }, { runId: 'r1', seq: 1 })
    const turn = engine.state.turns[0]
    expect(turn.completed).toBe(true)
    expect(turn.steps.some(s => s.type === 'content' && s.text === '答')).toBe(true)
    expect(engine.state.loading).toBe(false)
    expect(engine.state.activeRunId).toBeNull()
    expect(client.rpc.unsubscribe).toHaveBeenCalledWith('r1')
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ type: EVENT_TYPES.DONE }))
  })

  it('send 的 409/唯一键冲突路径:恢复真实活动 run 并撤掉乐观轮', async () => {
    const client = makeClient()
    client.rest.createChatRun = vi.fn(async () => { throw new Error('duplicate key') })
    // 源 resume 以 run.inputText 重建 USER 行,快照须带 inputText
    client.rest.getActiveChatRun = vi.fn(async () => ({ data: { runId: 'r-active', status: 'RUNNING', inputText: 'hi' } }))

    const engine = createChatEngine(client, {})
    const returned = await engine.send('hi', { sessionId: 's1' })

    expect(returned).toMatchObject({ runId: 'r-active' })
    // 乐观轮被撤掉,换成恢复出的真实轮
    expect(engine.state.turns).toHaveLength(1)
    expect(engine.state.turns[0].userMsg?.content).toBe('hi')
    expect(engine.state.activeRunId).toBe('r-active')
    expect(client.rpc.subscribe).toHaveBeenCalledWith('r-active', 0, expect.any(Function), expect.any(Function), expect.any(Function))
  })

  it('abort:activeRunId=r1 时走 cancelRun REST', async () => {
    const client = makeClient()
    const engine = createChatEngine(client, {})
    engine.state.activeRunId = 'r1'

    await engine.abort()

    expect(client.rest.cancelChatRun).toHaveBeenCalledWith('r1')
  })

  it('detach:只退订,不取消后端运行', () => {
    const client = makeClient()
    const engine = createChatEngine(client, {})
    engine.state.activeRunId = 'r1'

    engine.detach()

    expect(client.rpc.unsubscribe).toHaveBeenCalledWith('r1')
    expect(client.rest.cancelChatRun).not.toHaveBeenCalled()
    expect(engine.state.activeRunId).toBeNull()
    expect(engine.state.loading).toBe(false)
  })

  it('resume:恢复进行中的轮,snapshotSeq 作续传游标,接力既有 citations/skillIds', async () => {
    const client = makeClient()
    client.rest.getChatRunState = vi.fn(async () => ({
      data: {
        run: { runId: 'r1', status: 'RUNNING' },
        snapshotSeq: 3,
        steps: [],
        userMessage: { messageType: 'USER', content: 'hi', runId: 'r1' }
      }
    }))
    const engine = createChatEngine(client, {})
    engine.setTurns([{
      userMsg: { messageType: 'USER', content: 'hi', runId: 'r1' },
      steps: [], completed: false, usage: null,
      citations: [{ chunkId: 'c1' }], skillIds: [9]
    } as any])

    await engine.resume({ runId: 'r1', status: 'RUNNING' })

    expect(client.rpc.subscribe).toHaveBeenCalledWith('r1', 3, expect.any(Function), expect.any(Function), expect.any(Function))
    expect(engine.state.activeRunId).toBe('r1')
    // 实时轮替换时保留既有引用与技能快照(desktop 修复逐字移植)
    expect(engine.state.turns[0].citations).toEqual([{ chunkId: 'c1' }])
    expect(engine.state.turns[0].skillIds).toEqual([9])
  })

  it('subscribe 机制:状态变更推送快照,终态后 activeRunId 清空', async () => {
    const client = makeClient()
    const engine = createChatEngine(client, {})
    const snapshots: any[] = []
    engine.subscribe(state => snapshots.push({ count: state.turns.length, loading: state.loading, activeRunId: state.activeRunId }))

    await engine.send('hi', { sessionId: 's1' })
    const onEvent = client.rpc.subscribe.mock.calls[0][2] as (event: any, envelope: any) => void
    onEvent({ type: EVENT_TYPES.DONE, status: 'SUCCEEDED' }, { runId: 'r1', seq: 1 })

    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots[snapshots.length - 1]).toEqual({ count: 1, loading: false, activeRunId: null })
  })
})
