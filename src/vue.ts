/**
 * vue 适配层入口(`@agenthub/chat/vue`)。
 * vue 为可选 peerDependency:主入口保持框架无关,用到 vue 的组合式函数只从这里导出。
 */
export { useChatRun, type UseChatRunOptions, type UseChatRunReturn } from './vue/useChatRun.js'
export { useConnectionState } from './vue/useConnectionState.js'
