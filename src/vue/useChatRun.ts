/**
 * useChatRun:createChatEngine 的 vue 适配,对齐 desktop useChatRun 的返回面
 * (state 是 ref,方法原样透出),engine 已承担全部逻辑,这里只补响应式桥接。
 *
 * 响应式方案(经 test/vue/useChatRun.test.ts 最小验证后定稿):
 * engine 是纯对象状态机,state 在原地修改且 notify() 每次推送同一对象引用。
 * Vue 的 ref setter 会对新值做 toRaw 比较——直接 `state.value = s` 时新旧 _rawValue
 * 是同一个裸对象,不触发响应式。消息 UI 又会把单个 turn/step 继续作为 prop 下传，
 * 只替换顶层 state/turns 数组仍会让子组件收到相同对象引用，从而漏掉流式正文更新。
 * 因此每次通知都为 turn 和递归 steps 生成新的渲染快照；engine 的可写状态仍保持
 * 原对象，不把 Vue 的响应式代理或渲染副本反向写回无头状态机。
 */
import { onUnmounted, ref, type Ref } from 'vue'
import type { ChatClient } from '../client.js'
import { createChatEngine, type ChatEngine, type ChatEngineOptions } from '../engine/engine.js'
import type { EngineState } from '../engine/applyEvent.js'
import type { TimelineStep, TimelineTurn } from '../engine/timeline.js'
import type { ClientToolRegistry } from '../clientTools/registry.js'

/** desktop 源 options 的注入化超集:clientTools 在 engine 侧属于 client 注入,这里随 options 捎带。 */
export type UseChatRunOptions = ChatEngineOptions & {
  /** 渠道工具注册表;省略/为 null 时首轮不捎带声明清单,tool_call_request 落 ok:false */
  clientTools?: ClientToolRegistry | null
}

/**
 * 返回面 = engine 全部方法 + 响应式 state ref。
 * 注意 state 属性被 Object.assign 换成了 ref(对齐 desktop 返回面),故用 Omit 收窄,
 * 避免 `ChatEngine & { state }` 交叉出 `EngineState & Ref` 的编译期假象。
 */
export type UseChatRunReturn = Omit<ChatEngine, 'state'> & { state: Ref<EngineState> }

/**
 * 递归复制步骤树。step 的 UI 产物等附属对象只在事件处理时整体替换，真正会被
 * 流式原地修改的是 step 本身及其子 steps，因此这里保持有界的结构复制成本。
 */
function snapshotSteps(steps: TimelineStep[]): TimelineStep[] {
  return steps.map(step => ({
    ...step,
    steps: step.steps ? snapshotSteps(step.steps) : step.steps
  }))
}

/** 每次 notify 给 Vue 组件全新的 turn/step prop 引用。 */
function snapshotTurns(turns: TimelineTurn[]): TimelineTurn[] {
  return turns.map(turn => ({
    ...turn,
    userMsg: turn.userMsg ? { ...turn.userMsg } : null,
    steps: snapshotSteps(turn.steps)
  }))
}

export function useChatRun(client: ChatClient, options: UseChatRunOptions = {}): UseChatRunReturn {
  const { clientTools, ...engineOptions } = options
  const engine = createChatEngine(
    clientTools ? { ...client, clientTools } : client,
    engineOptions
  )
  const state = ref(engine.state)
  const off = engine.subscribe(s => {
    // 整体替换结构快照:见文件头「响应式方案」注记
    state.value = { ...s, turns: snapshotTurns(s.turns) }
  })
  onUnmounted(off)
  return Object.assign(engine, { state })
}
