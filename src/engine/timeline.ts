/**
 * 时间线重建:扁平 ai_chat_message 行 → Turn[] 轮次/步骤树。
 *
 * 移植自主仓(逐函数逐字,注释保留):
 * - desktop/src/composables/useTurnBuilder.js(主体)
 * - desktop/src/chat/kbHits.js(parseKbHits → ./kbHits.ts)
 * - desktop/src/chat-ui/composables/workspaceChanges.js(mergeWorkspaceChanges → ./workspaceChanges.ts)
 *
 * 时间线重建语义以主仓 docs/聊天对话模块.md §3.3 为准:失败/取消/节点中断的一轮只留 USER 行、
 * 没有 ASSISTANT_FINAL,「这一轮结束没有」不能从消息账本推,只能用时间线接口带回的
 * ai_chat_run.status 对账(applyRunStates);查不到 run 状态的老数据(run_id 为空 / run 行已清理)
 * 退回结构性判据——uk_ai_chat_run_active 保证一个会话同时只有一个活动 run,
 * 后面还有轮次就说明前面那轮必然已结束。
 *
 * 口径差异注记:desktop 原文件自带一份 terminalRunLabel(「执行失败/已取消/节点中断」,
 * 历史重建口径),与 protocol/status.ts 的运行时口径(「对话执行失败，请重试/已停止生成/
 * 执行节点中断，可重新发起」)不同——desktop 原文如此,两套并存。此处改名为
 * terminalRunLabelForHistory 以免与运行时版混淆,函数体未改动。
 *
 * 与 desktop 的唯一行为差异(经确认的新增兜底):collectKbCitationState 对 searchKnowledge 的
 * toolResult 先尝试按 JSON 命中数组解析(parseJsonHits),失败再回退 parseKbHits 文本解析;
 * desktop 只认文本格式(JSON 命中只出现在实时 kb.references UI artifact 里)。
 *
 * TS 移植注记:buildTurns 内闭包处的 `current!` 断言对应源码运行时已保证的非空
 * (循环内 current 为 null 时会先补一空轮再继续)。
 */
import { STEP_TYPES, UI_ARTIFACT_NAMES, type ChatMessage, type Step } from '../protocol/eventTypes.js'
import { mergeWorkspaceChanges, type WorkspaceChange } from './workspaceChanges.js'
import { parseKbHits, type KbHit } from './kbHits.js'

/** 附件列表(JSON 字符串解析后或原样数组) */
export type TimelineAttachments = Array<Record<string, unknown>>

/**
 * 历史重建输入的扁平消息(对应 ai_chat_message 一行,宽松版)。
 * 在 protocol/eventTypes.ts 的 ChatMessage 之上补历史行字段;sessionId 不强制必填。
 */
export interface TimelineMessage extends Omit<ChatMessage, 'sessionId'> {
  sessionId?: string
  /** USER_INPUT / ASSISTANT_FINAL 等(历史行带 message_kind) */
  messageKind?: string
  /** 所属 run */
  runId?: string | null
  /** 步骤实例 id(agent 卡用它登记,子消息按 parentStepId 归位) */
  stepId?: string | null
  /** 父步骤 id(agent 子消息按它挂进对应 agent 卡) */
  parentStepId?: string | null
  toolCallId?: string | null
  promptTokens?: number
  completionTokens?: number
  modelName?: string | null
  usageSource?: string
  /** 附件(数组或 JSON 字符串) */
  attachments?: TimelineAttachments | string | null
  /** 工具结果/入参截断信息 */
  toolResultLength?: number
  toolArgsLength?: number
}

/**
 * 过程节点子步骤(宽松版):在 Step 之上补历史行字段,子步骤递归为 TimelineStep。
 */
export interface TimelineStep extends Step {
  /** agent 的子步骤(子智能体内部的思考/工具,嵌套展示) */
  steps?: TimelineStep[]
  stepId?: string | null
  parentStepId?: string | null
  /** 声明该步骤归属的子 agent id(reclaimOwnedSteps 依此回收先到的子消息) */
  ownerAgentId?: number | null
  messageId?: number | null
  sessionId?: string | null
  attachments?: TimelineAttachments | null
  hasFullToolResult?: boolean
  toolResultLength?: number
  toolArgsLength?: number
}

/** 一轮的 token 用量(ASSISTANT_FINAL 落轮) */
export interface TimelineUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  modelName: string | null
  usageSource: string
}

/** 按文档归并后的引用文件(legacyFilesFromHits 产出) */
export interface KbFile {
  docName: string
  kbId: string | number | null
  docId: string | number | null
  kbName: string
  chunkCount: number
  chunks: KbHit[]
}

/** 时间线接口带回的 run 终态快照(含该轮技能快照) */
export interface RunStateSnapshot {
  status: string
  errorMessage?: string
  skillIds?: number[]
}

/** ui special event 汇总项(kb.references / workspace.changes 等,宽松版) */
export interface SpecialEventSummary {
  name?: string
  count?: number
  fileCount?: number
  chunkCount?: number
  truncated?: boolean
  files?: WorkspaceChange[] | null
  payload?: { files?: WorkspaceChange[] | null; truncated?: boolean } | null
  [key: string]: unknown
}

/**
 * 一轮对话(宽松版 Turn:镜像 protocol/eventTypes.ts 的 Turn 结构并补历史重建字段;
 * 因 userMsg 的 sessionId 不强制必填而无法直接 extends,Task 9 的实时/历史路径统一用本类型)。
 */
export interface TimelineTurn {
  /** 用户消息(无 USER 行的残轮为 null) */
  userMsg: TimelineMessage | null
  /** 助手过程(思考/工具/子agent/文本) */
  steps: TimelineStep[]
  /** 是否已出最终文本(或被 run 终态对账收口) */
  completed: boolean
  runId?: string | null
  /** token 用量 */
  usage?: TimelineUsage | null
  attachments?: TimelineAttachments | null
  /** workspace 变更汇总(applySpecialEventSummaries 归并) */
  workspaceChanges?: WorkspaceChange[]
  workspaceChangesTruncated?: boolean
  /** run 终态对账出的状态(仅失败/取消/中断轮写) */
  runStatus?: string
  terminalMessage?: string
  /** 该轮 @ 过的技能快照(时间线接口随 run 终态带回) */
  skillIds?: number[]
  /** searchKnowledge 命中聚合(去重后) */
  citations?: KbHit[]
  citationFiles?: KbFile[]
  citationTotal?: number
  citationCount?: number
  citationChunkCount?: number
  specialEvents?: SpecialEventSummary[]
}

/** collectKbCitationState 的返回:去重命中 + 按文档归并的文件 + 声明总数 */
export interface KbCitationState {
  hits: KbHit[]
  files: KbFile[]
  total: number
}

export function isTerminalRunStatus(status: string): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(status)
}

/**
 * 非成功终态的兜底文案——历史重建口径(desktop useTurnBuilder 原名 terminalRunLabel,函数体逐字)。
 * 注意与 protocol/status.ts 的运行时口径不同,勿混用。
 */
export function terminalRunLabelForHistory(status: string): string {
  const map: Record<string, string> = {
    FAILED: '执行失败',
    CANCELLED: '已取消',
    INTERRUPTED: '节点中断'
  }
  return map[status] || status
}

/**
 * 扁平 messages[] -> Turn[] 聚合。
 *
 * @param messages - 按 message_id/time 升序的扁平消息
 * @param specialEventsByMessage - messageId -> special event 汇总项
 * @param runStates - 时间线接口带回的 run 终态(含该轮技能快照)
 * @returns 聚合后的轮次
 */
export function buildTurns(messages?: TimelineMessage[] | null, specialEventsByMessage?: Record<string, SpecialEventSummary[]> | null, runStates?: Record<string, RunStateSnapshot> | null): TimelineTurn[] {
  const turns: TimelineTurn[] = []
  let current: TimelineTurn | null = null
  let agentStepByChildId = new Map<number, TimelineStep>()
  let agentStepByStepId = new Map<string, TimelineStep>()

  function containerOf(m: TimelineMessage): TimelineStep[] {
    const stableOwner = m.parentStepId ? agentStepByStepId.get(m.parentStepId) : undefined
    if (stableOwner) {
      if (!stableOwner.steps) stableOwner.steps = []
      return stableOwner.steps
    }
    const owner = m.agentId != null ? agentStepByChildId.get(m.agentId) : undefined
    if (owner) {
      if (!owner.steps) owner.steps = []
      return owner.steps
    }
    return current!.steps
  }

  function reclaimOwnedStepId(parentStepId: string) {
    const owned: TimelineStep[] = []
    for (let i = current!.steps.length - 1; i >= 0; i--) {
      if (current!.steps[i].parentStepId === parentStepId) owned.unshift(current!.steps.splice(i, 1)[0])
    }
    return owned
  }

  function reclaimOwnedSteps(childAgentId: number) {
    const owned: TimelineStep[] = []
    for (let i = current!.steps.length - 1; i >= 0; i--) {
      if (current!.steps[i].ownerAgentId === childAgentId) {
        owned.unshift(current!.steps.splice(i, 1)[0])
      }
    }
    return owned
  }

  for (const m of messages || []) {
    const type = m.messageType
    if (type === 'USER' && (!m.messageKind || m.messageKind === 'USER_INPUT')) {
      current = {
        userMsg: m,
        runId: m.runId || null,
        steps: [],
        completed: false,
        usage: null,
        workspaceChanges: [],
        attachments: parseAttachments(m)
      }
      agentStepByChildId = new Map()
      agentStepByStepId = new Map()
      turns.push(current)
      continue
    }

    if (!current) {
      current = { userMsg: null, steps: [], completed: false, usage: null, workspaceChanges: [] }
      agentStepByChildId = new Map()
      turns.push(current)
    }

    if (type === 'THINKING') {
      containerOf(m).push({
        type: STEP_TYPES.REASONING,
        text: m.content || '',
        streaming: false,
        stepId: m.stepId || null,
        parentStepId: m.parentStepId || null,
        ownerAgentId: m.agentId
      })
    } else if (type === 'TOOL') {
      const isAgent = m.toolSource === 'agent'
      const step: TimelineStep = {
        type: isAgent ? STEP_TYPES.AGENT : STEP_TYPES.TOOL,
        name: m.toolName || '',
        source: m.toolSource || 'builtin',
        agentCode: isAgent ? m.toolName : undefined,
        args: m.toolArgs || '',
        result: m.toolResult || '',
        attachments: parseAttachments(m),
        ok: m.toolSuccess !== '1',
        ms: m.toolDurationMs || 0,
        streaming: false,
        stepId: m.stepId || m.toolCallId || null,
        parentStepId: m.parentStepId || null,
        ownerAgentId: m.agentId,
        hasFullToolResult: !!m.hasFullToolResult,
        toolResultLength: m.toolResultLength || 0,
        toolArgsLength: m.toolArgsLength || 0,
        messageId: m.messageId,
        sessionId: m.sessionId
      }
      if (isAgent) {
        step.steps = m.stepId ? reclaimOwnedStepId(m.stepId)
          : (m.subAgentId != null ? reclaimOwnedSteps(m.subAgentId) : [])
        if (m.subAgentId != null) agentStepByChildId.set(m.subAgentId, step)
        if (m.stepId) agentStepByStepId.set(m.stepId, step)
      }
      containerOf(m).push(step)
    } else if (type === 'ASSISTANT' && m.messageKind === 'ASSISTANT_FINAL') {
      current.steps.push({
        type: STEP_TYPES.CONTENT,
        text: m.content || '',
        streaming: false,
        stepId: m.stepId || 'answer'
      })
      current.runId = m.runId || current.runId
      current.completed = true

      const p = m.promptTokens || 0
      const c = m.completionTokens || 0
      if (p || c || m.tokens) {
        current.usage = {
          promptTokens: p,
          completionTokens: c,
          totalTokens: (p + c) || m.tokens || 0,
          modelName: m.modelName || null,
          usageSource: m.usageSource || '1'
        }
      }
    } else if (type === 'SUMMARY') {
      current.steps.push({
        type: STEP_TYPES.SUMMARY,
        text: m.content || '',
        streaming: false
      })
    }
  }

  applyRunStates(turns, runStates)
  applySpecialEventSummaries(turns, specialEventsByMessage)

  for (const t of turns) {
    const refs = collectKbCitationState(t.steps)
    if (refs.hits.length) {
      t.citations = refs.hits
      t.citationFiles = refs.files
      t.citationTotal = t.citationCount || refs.files.length || refs.total
    } else if (!t.citations) {
      t.citations = []
      t.citationTotal = t.citationCount || 0
    }
  }
  return turns
}

/**
 * 用 ai_chat_run 的终态修正历史轮次。
 */
export function applyRunStates(turns?: TimelineTurn[] | null, runStates?: Record<string, RunStateSnapshot> | null): TimelineTurn[] {
  const list = turns || []
  for (let i = 0; i < list.length; i++) {
    const t = list[i]
    const runId = t.runId || (t.userMsg && t.userMsg.runId) || null
    const state: RunStateSnapshot | null = runId && runStates ? runStates[runId] : null
    // 该轮 @ 过的技能快照:必须挂在下面的 early-continue 之前。
    // 「重新生成」只作用于已完成的轮次,而 completed 的轮次会被直接 continue 掉,
    // 放到后面赋值就正好在唯一需要它的场景里拿不到。
    if (state) t.skillIds = Array.isArray(state.skillIds) ? state.skillIds : []
    if (t.completed) continue
    if (state) {
      if (!isTerminalRunStatus(state.status)) continue
      t.runId = runId
      t.runStatus = state.status
      t.completed = true
      if (state.status !== 'SUCCEEDED' && !t.terminalMessage) {
        t.terminalMessage = state.errorMessage || terminalRunLabelForHistory(state.status)
      }
      continue
    }
    // 查不到状态时(老数据 run_id 为空 / run 行已被清理)退回结构性判据:
    // 后面还有别的轮次，说明前面那轮必然已经结束！
    if (i < list.length - 1) t.completed = true
  }
  return list
}

export function applySpecialEventSummaries(turns?: TimelineTurn[] | null, specialEventsByMessage?: Record<string, SpecialEventSummary[]> | null) {
  if (!specialEventsByMessage) return
  for (const t of turns || []) {
    const id = t.userMsg && t.userMsg.messageId
    if (id == null) continue
    const items = specialEventsByMessage[String(id)] || specialEventsByMessage[id]
    if (!items || !items.length) continue
    t.specialEvents = items
    const kb = items.find(s => s && s.name === UI_ARTIFACT_NAMES.KB_REFERENCES)
    if (kb) {
      const fileCount = Number(kb.fileCount != null ? kb.fileCount : kb.count) || 0
      t.citationCount = fileCount
      t.citationTotal = fileCount
      t.citationChunkCount = Number(kb.chunkCount) || 0
    }
    const workspaceEvents = items.filter(s => s && s.name === UI_ARTIFACT_NAMES.WORKSPACE_CHANGES)
    for (const event of workspaceEvents) {
      const files = event.files || (event.payload && event.payload.files) || []
      t.workspaceChanges = mergeWorkspaceChanges(t.workspaceChanges, files)
      t.workspaceChangesTruncated = !!(t.workspaceChangesTruncated || event.truncated || (event.payload && event.payload.truncated))
    }
  }
}

export function collectKbCitationState(steps?: TimelineStep[] | null): KbCitationState {
  const out: KbHit[] = []
  const seen = new Set<string>()
  let declaredTotal = 0
  function addHit(h: KbHit) {
    if (!h) return
    const key = h.chunkId != null && h.chunkId !== ''
      ? 'id:' + h.chunkId
      : (h.docName || '') + '|' + (h.content || '')
    if (seen.has(key)) return
    seen.add(key)
    out.push(h)
  }
  function walk(list?: TimelineStep[] | null) {
    for (const s of list || []) {
      if (s.type === STEP_TYPES.TOOL && s.name === 'searchKnowledge' && s.result) {
        const parsed = parseJsonHits(s.result) ?? parseKbHits(s.result)
        declaredTotal += parsed.length
        for (const h of parsed) addHit(h)
      }
      if (s.steps && s.steps.length) walk(s.steps)
    }
  }
  walk(steps)
  return {
    hits: out,
    files: legacyFilesFromHits(out),
    total: Math.max(declaredTotal, out.length)
  }
}

/**
 * JSON 兜底(SDK 相对 desktop 的新增,经确认):toolResult 为命中对象数组
 * (kb.references 风格的 chunk 列表)时直接用作 hits;不是 JSON 数组或解析失败返回 null,
 * 回退 parseKbHits 文本解析。文本格式虽以 `[` 开头但 JSON.parse 必失败,行为不受影响。
 */
function parseJsonHits(result: string): KbHit[] | null {
  const trimmed = result.trim()
  if (!trimmed.startsWith('[')) return null
  let arr: unknown
  try {
    arr = JSON.parse(trimmed)
  } catch (e) {
    return null
  }
  if (!Array.isArray(arr)) return null
  const hits = arr.filter((h): h is KbHit => !!h && typeof h === 'object')
  return hits.length ? hits : null
}

function legacyFilesFromHits(hits?: KbHit[] | null): KbFile[] {
  const map = new Map<string, KbFile>()
  for (const hit of hits || []) {
    if (!hit) continue
    const docName = hit.docName || '未知文档'
    let file = map.get(docName)
    if (!file) {
      file = {
        docName,
        kbId: hit.kbId || null,
        docId: hit.docId || null,
        kbName: hit.kbName || '',
        chunkCount: 0,
        chunks: []
      }
      map.set(docName, file)
    }
    if (!file.kbId && hit.kbId) file.kbId = hit.kbId
    if (!file.docId && hit.docId) file.docId = hit.docId
    file.chunks.push(hit)
    file.chunkCount = file.chunks.length
  }
  return Array.from(map.values())
}

export function collectKbCitations(steps?: TimelineStep[] | null): KbHit[] {
  return collectKbCitationState(steps).hits
}

export function newTurn(userText: string, attachments?: TimelineAttachments | null): TimelineTurn {
  return {
    userMsg: { messageType: 'USER', content: userText },
    steps: [],
    completed: false,
    usage: null,
    attachments: attachments && attachments.length ? attachments : null
  }
}

function parseAttachments(m: TimelineMessage): TimelineAttachments | null {
  const raw = m.attachments
  if (!raw) return null
  if (Array.isArray(raw)) return raw.length ? raw : null
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) && arr.length ? arr : null
  } catch (e) {
    return null
  }
}
