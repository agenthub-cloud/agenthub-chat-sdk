import { describe, expect, it } from 'vitest'
import { buildTurns, applyRunStates, applySpecialEventSummaries, newTurn, collectKbCitations, terminalRunLabelForHistory } from '../../src/engine/timeline.js'
import { terminalRunLabel } from '../../src/protocol/status.js'

const USER = (over: object) => ({ messageType: 'USER', content: 'hi', messageId: 1, runId: 'r1', ...over })

describe('buildTurns', () => {
  it('USER→TOOL→ASSISTANT_FINAL 聚合为单轮,usage 落轮', () => {
    const turns = buildTurns([
      USER({}),
      { messageType: 'TOOL', toolName: 'searchKnowledge', toolSource: 'builtin', toolArgs: '{}', toolResult: JSON.stringify([{ chunkId: 'c1', docName: 'D', content: 'x' }]), toolSuccess: '0', messageId: 2 },
      { messageType: 'ASSISTANT', messageKind: 'ASSISTANT_FINAL', content: '答案', runId: 'r1', promptTokens: 10, completionTokens: 5, messageId: 3 }
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].completed).toBe(true)
    expect(turns[0].steps.map(s => s.type)).toEqual(['tool', 'content'])
    expect(turns[0].usage).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
    expect(turns[0].citations!.length).toBe(1) // searchKnowledge 命中聚合
  })

  it('agent 子消息按 parentStepId/agentId 归位嵌套', () => {
    const turns = buildTurns([
      USER({}),
      { messageType: 'TOOL', toolName: 'research', toolSource: 'agent', toolArgs: '{}', toolResult: '', toolSuccess: '0', stepId: 'st1', subAgentId: 7, messageId: 2 },
      { messageType: 'THINKING', content: '子思考', agentId: 7, parentStepId: 'st1', messageId: 3 },
      { messageType: 'TOOL', toolName: 't2', toolSource: 'builtin', toolArgs: '{}', toolResult: '', toolSuccess: '0', agentId: 7, parentStepId: 'st1', messageId: 4 }
    ])
    const agent = turns[0].steps[0]
    expect(agent.type).toBe('agent')
    expect(agent.steps!.map(s => s.type)).toEqual(['reasoning', 'tool'])
  })

  it('agent 声明前先到的子消息按 subAgentId 回收嵌套(reclaimOwnedSteps)', () => {
    const turns = buildTurns([
      USER({}),
      { messageType: 'THINKING', content: '先想', agentId: 7, messageId: 2 },
      { messageType: 'TOOL', toolName: 'research', toolSource: 'agent', toolArgs: '{}', toolResult: '', toolSuccess: '0', subAgentId: 7, messageId: 3 },
      { messageType: 'TOOL', toolName: 'inner', toolSource: 'builtin', toolArgs: '{}', toolResult: '', toolSuccess: '0', agentId: 7, messageId: 4 }
    ])
    const agent = turns[0].steps[0]
    expect(agent.type).toBe('agent')
    expect(turns[0].steps).toHaveLength(1) // 顶层只剩 agent 卡,子步骤已回收
    expect(agent.steps!.map(s => s.type)).toEqual(['reasoning', 'tool'])
  })

  it('文本格式 KB 命中聚合:跨工具去重 + citationFiles 按文档归并', () => {
    const kbText = '[1] 《D》 p (c)\n    x\n\n[2] 《D》 p (c)\n    x'
    const turns = buildTurns([
      USER({}),
      { messageType: 'TOOL', toolName: 'searchKnowledge', toolSource: 'builtin', toolArgs: '{}', toolResult: kbText, toolSuccess: '0', messageId: 2 },
      { messageType: 'TOOL', toolName: 'searchKnowledge', toolSource: 'builtin', toolArgs: '{}', toolResult: '[1] 《D》 p (c)\n    y', toolSuccess: '0', messageId: 3 }
    ])
    expect(turns[0].citations!.length).toBe(2) // 相同 docName+content 去重
    expect(turns[0].citations![0]).toMatchObject({ docName: 'D', headingPath: 'p', channel: 'c', content: 'x' })
    expect(turns[0].citationFiles).toHaveLength(1)
    expect(turns[0].citationFiles![0]).toMatchObject({ docName: 'D', chunkCount: 2 })
    expect(turns[0].citationTotal).toBe(1) // citationCount 缺省 → files.length
    expect(collectKbCitations(turns[0].steps)).toHaveLength(2)
  })

  it('applyRunStates: 失败轮无 ASSISTANT_FINAL 时按 run 状态收终态', () => {
    const turns = buildTurns([USER({})])
    applyRunStates(turns, { r1: { status: 'FAILED', errorMessage: 'boom' } })
    expect(turns[0]).toMatchObject({ completed: true, runStatus: 'FAILED', terminalMessage: 'boom', skillIds: [] })
  })

  it('applyRunStates: 已完成轮次也挂 skillIds,但不写 runStatus(early-continue 时序)', () => {
    const turns = buildTurns([
      USER({}),
      { messageType: 'ASSISTANT', messageKind: 'ASSISTANT_FINAL', content: '答案', runId: 'r1', messageId: 2 }
    ])
    applyRunStates(turns, { r1: { status: 'SUCCEEDED', skillIds: [3, 9] } })
    expect(turns[0].skillIds).toEqual([3, 9])
    expect(turns[0].runStatus).toBeUndefined()
    expect(turns[0].terminalMessage).toBeUndefined()
  })

  it('applyRunStates: 查不到 run 状态时退回结构性判据(后面还有轮次即已结束)', () => {
    const turns = buildTurns([USER({}), USER({ messageId: 5 })])
    applyRunStates(turns, undefined)
    expect(turns[0].completed).toBe(true)
    expect(turns[1].completed).toBe(false)
  })

  it('applySpecialEventSummaries: kb.references 计数落轮,workspace.changes 跨事件归并(CREATE→DELETE 抵消)', () => {
    const turns = buildTurns([USER({})])
    applyRunStates(turns, undefined)
    applySpecialEventSummaries(turns, {
      '1': [
        { name: 'kb.references', fileCount: 2, chunkCount: 3 },
        { name: 'workspace.changes', files: [{ path: '/a', operation: 'CREATE' }, { path: '/b', operation: 'CREATE' }] },
        { name: 'workspace.changes', files: [{ path: '/b', operation: 'DELETE' }], truncated: true }
      ]
    })
    expect(turns[0]).toMatchObject({
      citationCount: 2,
      citationTotal: 2,
      citationChunkCount: 3,
      citations: [],
      workspaceChanges: [{ path: '/a', operation: 'CREATE' }],
      workspaceChangesTruncated: true,
      specialEvents: expect.any(Array)
    })
  })

  it('newTurn 造空轮(带附件)', () => {
    const turn = newTurn('问一句', [{ name: 'a.txt' }])
    expect(turn).toMatchObject({ completed: false, usage: null })
    expect(turn.userMsg).toMatchObject({ messageType: 'USER', content: '问一句' })
    expect(turn.attachments).toEqual([{ name: 'a.txt' }])
    expect(newTurn('无附件', null).attachments).toBeNull()
  })

  it('历史版 terminalRunLabelForHistory 与运行时 terminalRunLabel 口径并存不混淆', () => {
    expect(terminalRunLabelForHistory('FAILED')).toBe('执行失败')
    expect(terminalRunLabelForHistory('CANCELLED')).toBe('已取消')
    expect(terminalRunLabelForHistory('INTERRUPTED')).toBe('节点中断')
    expect(terminalRunLabelForHistory('SUCCEEDED')).toBe('SUCCEEDED')
    expect(terminalRunLabel('FAILED')).toBe('对话执行失败，请重试')
    expect(terminalRunLabel('CANCELLED')).toBe('已停止生成')
    expect(terminalRunLabel('INTERRUPTED')).toBe('执行节点中断，可重新发起')
  })
})
