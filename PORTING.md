# PORTING — 移植规范

后续从 AgentHub 主仓向本 SDK 移植模块（protocol/transport/engine/clientTools/rest/vue）时，所有任务必须遵守以下规则。

## 相对 import 必须写 `.js` 后缀

**src 内所有相对 import 必须写 `.js` 后缀（编译后指向同名 dist 产物），从 npm 包/裸模块名导入不用后缀；vitest 测试文件同样遵守。**

原因：本仓库 `tsconfig.json` 使用 `"module": "NodeNext"` + `"moduleResolution": "NodeNext"`，tsc 不会改写 import 描述符。若相对 import 不带扩展名，dist 产物在 Node ESM 下会报 `Cannot find module`。

```ts
// 正确：编译后 ./http/types.js 与 dist 产物一一对应
import type { HttpResult } from './http/types.js'

// 错误：Bundler 风格的无扩展名相对 import，dist 在 Node ESM 下无法解析
import type { HttpResult } from './http/types'
```
