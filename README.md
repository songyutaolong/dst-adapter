# 大算头适配器

跨平台桌面托盘应用：用 **CC Switch 模式**管理多个 AI 服务商（Provider），一键启用并写入本机客户端配置。

当前完整实现 **WorkBuddy** 与 **Codex**；Cursor / Continue / Cline / Cherry Studio / Claude 等预留适配器框架。

## 设计原则

- **与中转站解耦**：不绑定、不内嵌任何特定网关。你的中转站与其它 OpenAI 兼容服务一样，都是普通 Provider。
- **Provider 中心**：本地维护多套 endpoint + API Key + 模型，按应用启用。
- **托盘快切**：系统托盘可直接切换 WorkBuddy / Codex Provider。
- **原子写入 + 备份**：启用前备份目标配置到 `~/.dst-adapter/backups/`。

## 技术栈

因本机环境缺少 Rust / MSVC，首版使用 **Electron + React + TypeScript + Vite**（产品模式仍对齐 CC Switch）。数据存储为 `~/.dst-adapter/db.json`（原子写）。

## 开发

### 普通启动

```bash
npm install
npm run dev          # 开发模式（main 进程代码变更后需完全重启 dev 才生效）
npm run typecheck    # 类型检查（tsconfig.web + tsconfig.node 两份）
```

启动成功的标志：日志出现 `dev server running ... http://127.0.0.1:5310/` 与 `start electron app...`，且出现多个来自 `node_modules\electron\dist` 的 `electron.exe`。

### DSH 沙箱环境启动（重要，避免重复踩坑）

在 DeepSeek Harness 会话内启动时，环境会注入 `ELECTRON_RUN_AS_NODE=1`，导致 electron 被强制以 Node 模式运行、启动即崩溃：

```
TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
```

必须先清除该变量：

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run dev
```

> 若报 `Error: spawn EPERM`（esbuild 启动失败）：是沙箱禁用了子进程管道通信，非代码问题，需以完整权限重新执行同一命令。

### 完全重启

旧实例不退出会占用单实例锁（新实例直接 quit），先停再启：

```powershell
Get-Process -Name electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*dstAdapter*' } | Stop-Process -Force
# 再执行上面的 npm run dev
```

## 打包

```bash
npm run dist:win   # Windows（可在本机执行）
npm run dist:mac   # macOS（必须在 Mac 上执行）
```

产物在 `release/`。

> **注意**：Apple 不允许在 Windows 上交叉编译 macOS 应用。当前若在 Windows 开发，请任选其一：
> 1. 在 Mac 上拉代码后执行 `npm install && npm run dist:mac`
> 2. 把仓库推到 GitHub 后，在 Actions 里手动运行工作流 `Build macOS`，下载产物 `dasuantou-adapter-mac`（含 `.dmg`、`.zip`）
>
> 未配置 Apple 开发者签名时，Mac 上首次打开可能需到「系统设置 → 隐私与安全性」允许运行。

## 联网更新（electron-updater）

应用内置自动更新，更新源为 GitHub Releases（`latest.yml` / `latest-mac.yml` 元数据 + 安装包 + blockmap）。

### 发布流程（发新版）

1. 本地改版本号 `package.json` → `version`
2. 打 tag 并推送（`Build macOS` / `Build Windows` 两个 workflow 自动构建并发布到 GitHub Release）：
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. 或在 Actions 页手动 `Run workflow`（不打 tag 时只上传 artifact 附件，不创建 Release）

### 应用内行为

| 场景 | 行为 |
|------|------|
| 启动（打包版） | 不联网，不自动检查 |
| 手动检查 | 左下角版本号旁的 `↻` 按钮，联网检查；发现新版本后点「下载更新」→「重启安装」 |
| 下载完成 | 系统通知「点击重启安装」 |
| 开发模式 | 不初始化更新（UI 提示「当前版本不支持自动更新」） |

### 已知限制

- **Windows portable 版不支持自动更新**，请使用 NSIS 安装版（安装到新目录前先卸载旧版）。
- **macOS 自动更新依赖代码签名**：当前未签名包可通过安装流程使用，但自更新会被系统签名校验拦截。要启用 mac 自动更新需配置 Apple Developer 签名（`CSC_LINK` + `CSC_KEY_PASSWORD`），未签名前 Mac 用户需手动下载新包。
- 使用旧版安装包覆盖安装时，Windows 会把新版本装到默认安装目录（不迁移自定义目录），属 electron-builder NSIS 已知行为。

## WorkBuddy 集成

- 配置目录：`~/.workbuddy/`
- 写入文件：`~/.workbuddy/models.json`
- 启用时按模型 `id` upsert 一条记录：

```json
{
  "id": "your-model",
  "name": "your-model",
  "vendor": "Custom",
  "url": "https://any-provider.example.com/v1/chat/completions",
  "apiKey": "sk-...",
  "supportsToolCall": true,
  "supportsImages": false,
  "supportsReasoning": false,
  "useCustomProtocol": false
}
```

Endpoint 可填 Base URL 或完整 `.../v1/chat/completions`；保存时会规范化。

## Codex 纯 API 与界面增强

- 下载页：<https://openai.com/zh-Hans-CN/codex/>
- 配置：`~/.codex/config.toml`、`~/.codex/auth.json`
- 纯 API 模式写入 `requires_openai_auth = false`，使用自定义 Endpoint + Key，不依赖 OpenAI / ChatGPT 账号。
- Responses 上游可直连；Chat Completions 上游通过仅监听 `127.0.0.1` 的本机转换服务接入 Codex。
- 「打开应用」会尝试带 CDP 调试参数启动 Codex，并注入本项目独立编写的插件入口解锁、基础中文与纯文本粘贴增强。
- Microsoft Store 版若禁止直接启动包内程序，会回退到系统应用激活；纯 API 仍生效，但该次启动无法注入 UI 增强。

> UI 增强依赖官方 Codex 页面结构，官方更新后可能暂时失效。此项目未复制或打包 Codex++ 源码；Codex++ 是独立的 AGPL-3.0 项目。

## Deep Link（通用）

```
dstadapter://v1/import?resource=provider&app=workbuddy&name=MyProvider&endpoint=https%3A%2F%2Fapi.example.com&apiKey=sk-xxx&model=gpt-4o
```

任意工具都可生成该链接，不依赖特定控制台。

## 数据目录

```
~/.dst-adapter/
  db.json
  backups/workbuddy/
  backups/codex/
  settings（合入 db.json）
```

## 使用流程

1. 添加 Provider（任意服务商的 Endpoint + Key + 模型）
2. 可选：测速（请求 `{root}/models`）
3. 点击「启用」→ 写入目标应用配置
4. 或从托盘直接快切
