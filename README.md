# @agenthub-cloud/chat

AgentHub 聊天协议 SDK：WebSocket JSON-RPC 传输、Run 事件无头状态机、渠道工具协议与 chat REST 封装。框架无关（主入口零运行时依赖），Vue 3 适配层走 `@agenthub-cloud/chat/vue`。

> 协议语义的权威文档在 [AgentHub 主仓](https://github.com/980911302/agenthup)：
>
> - `docs/聊天执行引擎.md` —— Run 状态机、订阅/断线续传/对账
> - `docs/渠道工具与浏览器插件.md` —— 客户端工具声明、补发幂等、确认策略
> - `docs/流式与事件模块.md` —— 事件类型与 UI 产物契约
>
> 本 README 只放使用文档。

## 安装

```bash
npm install @agenthub-cloud/chat          # 框架无关核心
npm install @agenthub-cloud/chat/vue      # Vue 3 组合式函数(可选,peerDependency vue ^3)
```

## 快速开始（Vue 3）

```ts
import axios from 'axios'
import { createChatClient } from '@agenthub-cloud/chat'
import { useChatRun, useConnectionState } from '@agenthub-cloud/chat/vue'

// http 与宿主 axios 封装兼容；环境差异只剩这一个配置对象
const client = createChatClient({
  http: axios,
  tokenProvider: () => getToken(),      // 实时连接建连前读取
  baseUrl: import.meta.env.VITE_APP_BASE_API,
})

export default {
  setup() {
    const run = useChatRun(client, {
      // 危险工具人工确认：resolve true 放行,false/reject 拒绝(都会回传服务端)
      onToolConfirm: async ({ name, argsPreview }) => window.confirm(`允许执行 ${name}?`),
      onNotice: (message, type) => console[type ?? 'log'](message),
    })
    const connection = useConnectionState(client)

    async function ask(text: string) {
      await run.send(text, { sessionId: currentSessionId })
    }
    async function stop() {
      await run.abort()                   // 服务端取消并广播终态
    }
    // run.state.value.turns —— 轮次/步骤树,渲染气泡与过程卡片
    // run.detach()            —— 仅退订不打断执行;run.recoverSession(id) 断线续传
    return { state: run.state, connection, ask, stop }
  },
}
```

## Headless（不用 Vue）

```ts
import { createChatClient, createChatEngine } from '@agenthub-cloud/chat'

const client = createChatClient({ /* 同上 */ })
const engine = createChatEngine(client, { onToolConfirm: async () => true })

engine.subscribe(state => {
  // state.turns / state.status / state.activeRunId —— 每次变更整体推送
})
await engine.send('你好', { sessionId: 's1' })
```

## 渠道工具（执行体在客户端的工具）

```ts
import { createClientToolRegistry } from '@agenthub-cloud/chat'

const tools = createClientToolRegistry({ rpc: client.rpc, version: '1.0.0' })
tools.defineClientTool(
  { name: 'pickDate', description: '让用户选日期', parameters: { type: 'object', properties: {} } },
  async (args, ctx) => JSON.stringify(await showDatePicker(ctx.sessionId))
)

// 传给引擎:首轮 run.create 自动捎带声明清单;tool_call_request 由注册表幂等处理
useChatRun(client, { clientTools: tools, onToolConfirm: async () => true })
```

同一 `callId` 的补发（断线重连/重新订阅）不会重跑 handler，而是原样重发上次结果——写操作安全。

## 错误处理

传输层错误统一为 `ChatTransportError`（`code: 'no-ticket' | 'handshake-timeout' | 'handshake-failed' | 'disconnected' | 'closed' | 'request-timeout'`），可据此区分可重试与终态；JSON-RPC 业务错误保持普通 `Error` 并附 `code`/`data`。

## 兼容性

- 主入口 ESM + d.ts，Node 18+/现代浏览器；`./vue` 需要 Vue 3（peerDependency）。
- 与 AgentHub 后端的 WS RPC（15 个方法）与 `/ai/chat/*` REST 对齐；后端协议演进由 SDK 版本收敛，详见主仓协议文档。

## License

[MIT](./LICENSE)
