import { describe, expect, it } from 'vitest'
import { normalizeRunEvent, RUN_EVENT_TYPE_MAP, type RunEventV1Envelope } from '../../src/protocol/runEvent.js'

const cases: Array<[string, string]> = [
  ['ai.run.started', 'run_status'],
  ['ai.run.status.changed', 'run_status'],
  ['ai.run.text.delta', 'text'],
  ['ai.run.reasoning.delta', 'reasoning'],
  ['ai.run.tool.started', 'tool_start'],
  ['ai.run.tool.confirmation.required', 'tool_confirm_required'],
  ['ai.run.tool.call.requested', 'tool_call_request'],
  ['ai.run.tool.completed', 'tool_end'],
  ['ai.run.agent.started', 'agent_start'],
  ['ai.run.agent.completed', 'agent_end'],
  ['ai.run.ui.published', 'ui'],
  ['ai.run.media.gated', 'media_gated'],
  ['ai.run.completed', 'done'],
  ['ai.run.failed', 'error'],
  ['ai.run.cancelled', 'cancelled'],
  ['ai.run.interrupted', 'interrupted']
]

describe('normalizeRunEvent', () => {
  it('完整登记 17 个 Java v1 事件类型', () => {
    expect(Object.keys(RUN_EVENT_TYPE_MAP)).toHaveLength(17)
    expect(new Set(Object.keys(RUN_EVENT_TYPE_MAP))).toEqual(new Set(cases.map(([type]) => type).concat('ai.run.context.compacted')))
  })

  it.each(cases)('%s → %s', (v1, legacy) => {
    expect(normalizeRunEvent({ specversion: '1.0', type: v1, data: {} }, {})).toMatchObject({ type: legacy })
  })

  it('context.compacted 按 data.kind 分流', () => {
    expect(normalizeRunEvent({ specversion: '1.0', type: 'ai.run.context.compacted', data: { kind: 'overflow_trimmed' } }, {}))
      .toMatchObject({ type: 'context_overflow_trimmed' })
    expect(normalizeRunEvent({ specversion: '1.0', type: 'ai.run.context.compacted', data: {} }, {}))
      .toMatchObject({ type: 'context_cleaned' })
  })

  it('data 字段展开进结果且 legacy 不参与合并（合并属调用方,见主仓 deliverRunEvent 的 { ...rawEv, ...v1Ev }）', () => {
    const out = normalizeRunEvent({ specversion: '1.0', type: 'ai.run.text.delta', data: { text: 'hi', seq: 7 } }, { type: 'text', text: '', runId: 'r1' })
    expect(out).toEqual({ type: 'text', text: 'hi', seq: 7 })
  })

  it('无 specversion/type 时回退 legacy', () => {
    expect(normalizeRunEvent(undefined, { type: 'text', text: 'x' })).toEqual({ type: 'text', text: 'x' })
    expect(normalizeRunEvent({ type: 'ai.run.text.delta' }, { type: 'text' })).toEqual({ type: 'text' })
  })

  it('v1 未知 type 透传', () => {
    expect(normalizeRunEvent({ specversion: '1.0', type: 'ai.run.something.new', data: { x: 1 } }, {})).toEqual({ x: 1, type: 'ai.run.something.new' })
  })

  it('有 specversion 缺 type 时回退 legacy', () => {
    expect(normalizeRunEvent({ specversion: '1.0' } as RunEventV1Envelope, { type: 'text' })).toEqual({ type: 'text' })
  })
})
