# 消费端接入(@agenthub/chat 私有包)

包发布在 **GitHub Packages**(`https://npm.pkg.github.com`,restricted 私有),不在 npmjs.com。
npm / pnpm 通用,按下面三步接。

## 1. 项目级 `.npmrc`(提交进各前端仓库)

```ini
@agenthub:registry=https://npm.pkg.github.com
always-auth=true
```

只影响 `@agenthub/*` scope,其余依赖照常走默认 registry(npmmirror/npmjs 均不受影响)。

## 2. 本机 token(用户级 `~/.npmrc`,不要提交)

到 GitHub → Settings → Developer settings → **Personal access tokens (classic)** 生成一个只勾 `read:packages` 的 token,然后:

```ini
//npm.pkg.github.com/:_authToken=<你的 read:packages token>
```

生成入口:https://github.com/settings/tokens/new?scopes=read:packages&description=agenthub-chat-sdk

## 3. 安装

```bash
npm install @agenthub/chat        # 或 pnpm add @agenthub/chat
# Vue 适配层: @agenthub/chat/vue(同包的子路径,无需单独安装)
```

## Jenkins CI

同第 1、2 步:把 read:packages token 存为 Jenkins credentials(如 `github-packages-token`),
Pipeline 里在 install 前写入临时 `~/.npmrc`:

```groovy
withCredentials([string(credentialsId: 'github-packages-token', variable: 'GP_TOKEN')]) {
  sh '''
    echo "//npm.pkg.github.com/:_authToken=${GP_TOKEN}" >> ~/.npmrc
    echo "@agenthub:registry=https://npm.pkg.github.com" >> ~/.npmrc
    npm ci   # 或 pnpm install
  '''
}
```

## 版本与更新

- 版本随 git tag 走:SDK 仓打 `v*` tag → Actions 自动 typecheck/test/build → 发布 restricted 包;
- 升级:`npm up @agenthub/chat`,CHANGELOG 看 SDK 仓 Releases。

## 常见问题

- **401/403**:token 没配或没勾 `read:packages`;`always-auth=true` 缺失时 npm 偶尔不发鉴权头。
- **404**:scope 行没配(`@agenthub:registry=...`),npm 去默认 registry 找 `@agenthub/chat` 当然找不到。
- **GitHub Actions 内安装**:无需 PAT,用 `GITHUB_TOKEN`(勾 `packages: read` 权限)即可。
