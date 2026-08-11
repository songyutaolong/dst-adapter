# 大算头适配器

跨平台桌面托盘应用：用 **CC Switch 模式**管理多个 AI 服务商（Provider），一键启用并写入本机客户端配置。

首版仅完整实现 **WorkBuddy**；Cursor / Continue / Cline / Cherry Studio / Claude 等仅预留适配器框架。

## 设计原则

- **与中转站解耦**：不绑定、不内嵌任何特定网关。你的中转站与其它 OpenAI 兼容服务一样，都是普通 Provider。
- **Provider 中心**：本地维护多套 endpoint + API Key + 模型，按应用启用。
- **托盘快切**：系统托盘可直接切换 WorkBuddy 下的 Provider。
- **原子写入 + 备份**：启用前备份目标配置到 `~/.dst-adapter/backups/`。

## 技术栈

因本机环境缺少 Rust / MSVC，首版使用 **Electron + React + TypeScript + Vite**（产品模式仍对齐 CC Switch）。数据存储为 `~/.dst-adapter/db.json`（原子写）。

## 开发

```bash
npm install
npm run dev
```

## 打包

```bash
npm run dist:win   # Windows（可在本机执行）
npm run dist:mac   # macOS（必须在 Mac 上执行）
```

产物在 `release/`。

> **注意**：Apple 不允许在 Windows 上交叉编译 macOS 应用。当前若在 Windows 开发，请任选其一：
> 1. 在 Mac 上拉代码后执行 `npm install && npm run dist:mac`
> 2. 把仓库推到 GitHub 后，在 Actions 里手动运行工作流 `Build macOS`，下载产物 `dasuantou-adapter-mac`（含 `.dmg`）
>
> 未配置 Apple 开发者签名时，Mac 上首次打开可能需到「系统设置 → 隐私与安全性」允许运行。

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
  settings（合入 db.json）
```

## 使用流程

1. 添加 Provider（任意服务商的 Endpoint + Key + 模型）
2. 可选：测速（请求 `{root}/models`）
3. 点击「启用」→ 写入 WorkBuddy `models.json`
4. 或从托盘直接快切
