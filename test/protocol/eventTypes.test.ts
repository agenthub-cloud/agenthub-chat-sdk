import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, STEP_TYPES, UI_ARTIFACT_NAMES, UI_ARTIFACT_SPECS, isSupportedUiArtifact } from '../../src/protocol/eventTypes.js'
import { isTerminalRunStatus, terminalRunLabel } from '../../src/protocol/status.js'

describe('eventTypes', () => {
  it('事件类型常量与后端 ChatEventJson 对齐', () => {
    expect(EVENT_TYPES).toMatchObject({ TEXT: 'text', TOOL_START: 'tool_start', TOOL_CONFIRM_REQUIRED: 'tool_confirm_required', TOOL_CALL_REQUEST: 'tool_call_request', CONTEXT_OVERFLOW_TRIMMED: 'context_overflow_trimmed', MEDIA_GATED: 'media_gated', AGENT_START: 'agent_start', DONE: 'done' })
    expect(STEP_TYPES).toMatchObject({ TOOL: 'tool', AGENT: 'agent', CONTENT: 'content' })
    expect(UI_ARTIFACT_NAMES.KB_REFERENCES).toBe('kb.references')
  })

  it.each([
    ['kb.references', 2, true],   // 恰好等于 schemaVersion
    ['kb.references', 1, false],  // 低于 minSchemaVersion
    ['kb.references', 3, false],  // 高于 schemaVersion
    ['run.tokenUsage', 1, true],
    ['unknown.artifact', 1, false],
    [undefined, 1, false]
  ])('isSupportedUiArtifact(%s, v%s) = %s', (name, version, expected) => {
    expect(isSupportedUiArtifact({ name, schemaVersion: version })).toBe(expected)
  })

  it('UI_ARTIFACT_SPECS 与 desktop types.js 一致', () => {
    expect(UI_ARTIFACT_SPECS['kb.references']).toEqual({ schemaVersion: 2, minSchemaVersion: 2 })
  })
})

describe('status', () => {
  it.each([
    ['QUEUED', false], ['RUNNING', false], ['FINALIZING', false],
    ['SUCCEEDED', true], ['FAILED', true], ['CANCELLED', true], ['INTERRUPTED', true]
  ])('isTerminalRunStatus(%s) = %s', (s, expected) => expect(isTerminalRunStatus(s)).toBe(expected))

  it('运行时兜底文案与 desktop 版一致', () => {
    expect(terminalRunLabel('CANCELLED')).toBe('已停止生成')
    expect(terminalRunLabel('INTERRUPTED')).toBe('执行节点中断，可重新发起')
    expect(terminalRunLabel('FAILED')).toBe('对话执行失败，请重试')
  })
})
