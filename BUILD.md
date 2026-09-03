# 构建与开发规范（BUILD GUIDE）

> 本文件记录本项目在 DSH 沙箱环境下的**成功构建指令**与注意事项，避免"同一命令时而成功时而失败"的困惑。

## 常用命令速查

| 命令 | 用途 | 沙箱内是否可跑 |
|------|------|--------------|
| `npm install` | 安装依赖 | ✅ 可跑（一次性） |
| `npm run typecheck` | 类型检查（web + node 双 tsconfig） | ✅ 可跑 |
| `npm run build` | 生产构建（编译到 `out/`） | ❌ 沙箱内被拒（见下） |
| `npm run dev` | 开发模式（electron-vite dev） | ⚠️ 需完整权限（同样会 spawn esbuild） |
| `npm run dist:win` | Windows 打包（产出 `release/`） | ⚠️ 需完整权限 |
| `npm run dist:mac` | macOS 打包 | 必须在 Mac 上执行，Windows 无法交叉编译 |

## ⚠️ 关键坑 2：`ELECTRON_RUN_AS_NODE` 导致 dev 启动崩溃

DSH 会话环境会注入 `ELECTRON_RUN_AS_NODE=1`。该变量使 electron 以**纯 Node 模式**运行，`require('electron').app` 为 undefined，报：

```
TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
```

**修复**：启动前清除该变量，再 `npm run dev`：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run dev
```

> 每次从 DSH 终端启动 dev/打包前建议先清；应用由玩家手动双击启动不受影响。

## ⚠️ 关键：`npm run build` 为何会被沙箱拒绝

**现象**：在 DSH 文件沙箱（workspace-write 或只读）下运行 `npm run build`，报：

```
Error: spawn EPERM
    at ChildProcess.spawn ... (esbuild/lib/main.js)
```

**原因**：electron-vite 构建时会 spawn 一个 **esbuild service 子进程**，通过管道/stdio 通信。DSH 沙箱禁止进程通过管道捕获另一程序输出 → 触发 `EPERM`。

**这是环境边界，不是代码或命令错误**。`npm run typecheck` 不派生此类子进程，所以始终能跑。

### 正确做法（构建三选一）

1. **推荐**：以**完整权限**（danger-full-access）执行：
   ```bash
   npm run build
   ```
   即调用方把该命令的 `sandbox_permissions` 设为 `danger-full-access`（这是沙箱规则允许的一次性升级重试）。

2. 先跑 `npm run typecheck` 做快速校验（不依赖构建产物）：
   ```bash
   npm run typecheck
   ```

3. 本地开发如需热更新，用 `npm run dev`（同样需完整权限）。

### 验证构建是否真的生效

构建产物在 `out/`（main / preload / renderer 三个子包）。改动源码后务必确认产物时间戳新于源码：

```bash
# 对比 src 与 out 的修改时间，确认产物已更新
(Get-Item src\main\store.ts).LastWriteTime
(Get-Item out\main\index.js).LastWriteTime
```

**改了源码但没重新构建 → 运行的还是旧逻辑**（典型坑：复制配置信息仍显示旧值）。

## 产物与运行

| 项 | 说明 |
|----|------|
| 构建产物目录 | `out/`（`main/index.js`、`preload/index.js`、`renderer/*`） |
| 打包产物目录 | `release/` |
| 应用数据目录 | `~/.dst-adapter/db.json`（MCP 服务配置、Provider、设置） |
| 生效方式 | 更新 `out/` 后需**重启应用**才加载新产物 |
| 自动更新 | `release/` 内自动生成 `latest.yml`(win) / `latest-mac.yml`(mac) + `*.blockmap`；打 tag 推远端后 CI 上传 GitHub Release，安装版应用即可联网更新 |

## 修改内置图片生成 MCP 服务要点

- 常量定义：`src/shared/types.ts` → `BUILTIN_MCP_IMAGE_DEFAULTS`
- 连接信息：`src/main/store.ts` → `getMcpConnectionInfo()`
- 设置弹窗 / 卡片 UI：`src/renderer/src/App.tsx`
- 约定：内置服务 **Base URL 固定内置**（`https://dst-ai.com`），**模型 ID 由请求参数决定**，设置仅填 API Key
- 该约定文档：本文件 + 各文件内注释，改需求时同步更新

## 提交前检查

```bash
npm run typecheck   # 必须通过
npm run build       # 完整权限下跑通，确认 out/ 产物更新
```
