/**
 * useChatRun:createChatEngine 的 vue 适配,对齐 desktop useChatRun 的返回面
 * (state 是 ref,方法原样透出),engine 已承担全部逻辑,这里只补响应式桥接。
 *
 * 响应式方案(经 test/vue/useChatRun.test.ts 最小验证后定稿):
 * engine 是纯对象状态机,state 在原地修改且 notify() 每次推送同一对象引用。
 * Vue 的 ref setter 会对新值做 toRaw 比较——直接 `state.value = s` 时新旧 _rawValue
 * 是同一个裸对象,不触发响应式。故订阅回调里整体替换为浅克隆
 * (`{ ...s, turns: [...s.turns] }`),每个通知都产生新引用:顶层字段/轮次数组的
 * 变更必然触发;轮内嵌套字段(如 step.text)由下次通知的整体替换兜底重渲染。
 */
import { onUnmounted, ref, type Ref } from 'vue'
import type { ChatClient } from '../client.js'
import { createChatEngine, type ChatEngine, type ChatEngineOptions } from '../engine/engine.js'
import type { EngineState } from '../engine/applyEvent.js'
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

export function useChatRun(client: ChatClient, options: UseChatRunOptions = {}): UseChatRunReturn {
  const { clientTools, ...engineOptions } = options
  const engine = createChatEngine(
    clientTools ? { ...client, clientTools } : client,
    engineOptions
  )
  const state = ref(engine.state)
  const off = engine.subscribe(s => {
    // 整体替换浅克隆:见文件头「响应式方案」注记
    state.value = { ...s, turns: [...s.turns] }
  })
  onUnmounted(off)
  return Object.assign(engine, { state })
}
