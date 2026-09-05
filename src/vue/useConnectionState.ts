/**
 * useConnectionState:连接状态指示灯的 vue 适配。
 * 值域即 ChatRpcClient 的连接广播:connecting/reconnecting/open/closed。
 */
import { onUnmounted, ref } from 'vue'
import type { ChatClient } from '../client.js'

export function useConnectionState(client: ChatClient) {
  const state = ref<string>(client.rpc.isOpen() ? 'open' : 'closed')
  const off = client.rpc.onConnectionState(s => { state.value = s })
  onUnmounted(off)
  return state
}
