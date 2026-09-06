import { describe, expect, it, vi } from 'vitest'
import { applyEvent, newEngineState } from '../../src/engine/applyEvent.js'
import { EVENT_TYPES } from '../../src/protocol/eventTypes.js'

function run() {
  const state = newEngineState()
  state.turns.push({ userMsg: { messageType: 'USER', content: 'hi' }, steps: [], completed: false, usage: null, citations: [], workspaceChanges: [] } as any)
  const cb = {
    onToolConfirm: vi.fn(async () => true),
    onNotice: vi.fn(),
    clientTools: null,
    sendToolConfirm: vi.fn(async () => {}),
    cancelRun: vi.fn(async () => {}),
    rest: {} as any,
    rpc: {} as any
  }
  const apply = (event: any, envelope: any = { runId: 'r1', sessionId: 's1' }) => applyEvent(state, { ...envelope, event }, cb as any)
  return { state, cb, apply, turn: state.turns[0] as any }
}

describe('applyEvent', () => {
  it('text 追加 content 步骤;reasoning 同 stepId 建/续思考条', () => {
    const { turn, apply } = run()
    // 源逻辑按 stepId 归并思考条;不带 stepId 的事件各建一条(与 desktop 逐字一致)
    apply({ type: EVENT_TYPES.REASONING, stepId: 'think', text: '思' })
    apply({ type: EVENT_TYPES.REASONING, stepId: 'think', text: '考' })
    apply({ type: EVENT_TYPES.TEXT, text: '答' })
    expect(turn.steps[0]).toMatchObject({ type: 'reasoning', stepId: 'think', text: '思考' })
    expect(turn.steps[1]).toMatchObject({ type: 'content', stepId: 'answer', text: '答' })
  })

  it('run_status 更新轮状态', () => {
    const { turn, apply } = run()
    apply({ type: 'run_status', status: 'RUNNING' })
    expect(turn.runStatus).toBe('RUNNING')
  })

  it('上下文溢出和媒体门控产生可见摘要', () => {
    const { turn, apply } = run()
    apply({ type: EVENT_TYPES.CONTEXT_OVERFLOW_TRIMMED, tokensBefore: 12000, tokensAfter: 8000, turnsDropped: 3 })
    apply({ type: EVENT_TYPES.MEDIA_GATED, accepted: 1, rejected: [{ modality: 'video', label: '视频', count: 2 }] })
    expect(turn.steps[0]).toMatchObject({ type: 'summary', text: expect.stringContaining('已移除最早 3 轮') })
    expect(turn.steps[1]).toMatchObject({ type: 'summary', text: expect.stringContaining('2 个媒体附件未进入模型上下文：视频') })
  })

  it('tool_start/tool_end 同 stepId 复用卡片', () => {
    const { turn, apply } = run()
    apply({ type: EVENT_TYPES.TOOL_START, stepId: 's1', name: 'shell', args: '***' })
    apply({ type: EVENT_TYPES.TOOL_END, stepId: 's1', result: 'out', ms: 12, ok: true })
    expect(turn.steps[0]).toMatchObject({ type: 'tool', name: 'shell', args: '***', result: 'out', ms: 12, ok: true, streaming: false })
  })

  it('agent_start/agent_end 同 invId 配对,第二次调用不串卡', () => {
    const { turn, apply } = run()
    apply({ type: EVENT_TYPES.AGENT_START, stepId: 'a1', name: 'research', agentCode: 'r1code', invId: 'i1' })
    apply({ type: EVENT_TYPES.AGENT_END, stepId: 'a1', result: 'R1' })
    apply({ type: EVENT_TYPES.AGENT_START, stepId: 'a2', name: 'research', agentCode: 'r1code', invId: 'i2' })
    apply({ type: EVENT_TYPES.AGENT_END, stepId: 'a2', result: 'R2' })
    expect(turn.steps.map((s: any) => s.result)).toEqual(['R1', 'R2'])
  })

  it('tool_confirm_required 建 pendingConfirm 卡片,拒绝也回传 false', async () => {
    const { cb, turn, apply } = run()
    cb.onToolConfirm = vi.fn(async () => false)
    apply({ type: EVENT_TYPES.TOOL_CONFIRM_REQUIRED, stepId: 't1', confirmId: 'c1', name: 'shell', args: '{}' })
    expect(turn.steps[0]).toMatchObject({ type: 'tool', stepId: 't1', name: 'shell', pendingConfirm: true, confirmId: 'c1' })
    await vi.waitFor(() => {
      expect(cb.onToolConfirm).toHaveBeenCalled()
      expect(cb.sendToolConfirm).toHaveBeenCalledWith('r1', 'c1', false)
    })
  })

  it('tool_confirm_required 同意回传 true', async () => {
    const { cb, apply } = run()
    apply({ type: EVENT_TYPES.TOOL_CONFIRM_REQUIRED, stepId: 't2', confirmId: 'c2', name: 'shell', args: '{}' })
    await vi.waitFor(() => {
      expect(cb.onToolConfirm).toHaveBeenCalledWith({ name: 'shell', argsPreview: '{}' })
      expect(cb.sendToolConfirm).toHaveBeenCalledWith('r1', 'c2', true)
    })
  })

  it('tool_call_request 透传信封 sessionId 给 clientTools', () => {
    const { cb, apply } = run()
    const handleToolCallRequest = vi.fn(async () => {})
    cb.clientTools = { handleToolCallRequest } as any
    apply({ type: EVENT_TYPES.TOOL_CALL_REQUEST, callId: 'k1', name: 'screenshot', args: '{}' })
    expect(handleToolCallRequest).toHaveBeenCalledWith('r1', { type: EVENT_TYPES.TOOL_CALL_REQUEST, callId: 'k1', name: 'screenshot', args: '{}', sessionId: 's1' })
  })

  it('ui 事件按白名单过滤:kb.references 引用归位,workspace.changes 按 eventId 去重,未知 name 不进步骤', () => {
    const { turn, apply } = run()
    apply({ type: EVENT_TYPES.UI, name: 'kb.references', payload: { files: [{ docName: '设计文档', chunks: [{ chunkId: 'c1' }] }], fileCount: 1, chunkCount: 2 }, schemaVersion: 2, messageId: 1 })
    expect(turn.citations).toEqual([{ chunkId: 'c1' }])
    expect(turn.citationFiles).toHaveLength(1)
    expect(turn.citationCount).toBe(1)
    expect(turn.citationTotal).toBe(1)
    expect(turn.citationChunkCount).toBe(2)

    apply({ type: EVENT_TYPES.UI, name: 'workspace.changes', payload: { files: [{ path: 'a.ts', operation: 'CREATE' }] }, schemaVersion: 1, eventId: 'w1', messageId: 2 })
    expect(turn.workspaceChanges).toEqual([{ path: 'a.ts', operation: 'CREATE' }])
    // 同 eventId 回放不叠两份(seen 去重在 mergeWorkspaceChanges 之前)
    apply({ type: EVENT_TYPES.UI, name: 'workspace.changes', payload: { files: [{ path: 'b.ts' }] }, schemaVersion: 1, eventId: 'w1', messageId: 3 })
    expect(turn.workspaceChanges).toEqual([{ path: 'a.ts', operation: 'CREATE' }])

    apply({ type: EVENT_TYPES.UI, name: 'unknown.thing', payload: {}, messageId: 4 })
    // ui 产物不进时间线;未知 name 也不污染既有引用
    expect(turn.steps.filter((s: any) => s.type === 'ui')).toHaveLength(0)
    expect(turn.citations).toEqual([{ chunkId: 'c1' }])
  })

  it('终态 done 收口 loading,重复 done 不重建轮', () => {
    const { state, turn, apply } = run()
    apply({ type: EVENT_TYPES.DONE, status: 'SUCCEEDED' })
    expect(turn.completed).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.activeRunId).toBeNull()
    const n = state.turns.length
    apply({ type: EVENT_TYPES.DONE, status: 'SUCCEEDED' })
    expect(state.turns.length).toBe(n)
  })

  it('error 终态写 terminalMessage 并收口', () => {
    const { state, turn, apply } = run()
    apply({ type: EVENT_TYPES.ERROR, status: 'FAILED', message: '模型超时' })
    expect(turn.completed).toBe(true)
    expect(turn.runStatus).toBe('FAILED')
    expect(turn.terminalMessage).toBe('模型超时')
    expect(state.loading).toBe(false)
  })
})
