# 桌面 Web 与 Electron 智脑说明

> 当前基线：`apps/desktop` 0.3.0  
> 适用范围：桌面 Web、Windows Electron、移动端共享智脑体验

## 1. 实现结论

桌面智脑提供两种交付形态，但只维护一套渲染代码：

1. **桌面 Web**：浏览器访问 `http://127.0.0.1:5184`。
2. **Electron 应用**：Electron 加载同一份 Vite 构建产物，增加安全窗口、隔离 preload 和 Windows 打包能力。

移动端与桌面端共同依赖 `@healthcare-ai/agent-workbench`。身份登录、对话、材料、告警、确认、执行回执和待办不再分别实现，从结构上避免三端功能与安全交互漂移。

## 2. 功能对齐

| 能力 | 移动端 | 桌面 Web | Electron |
| --- | --- | --- | --- |
| OA / 平台账号登录 | 支持 | 支持 | 支持 |
| 设备标识与身份会话 | 支持 | 支持 | 支持 |
| 智脑文字对话 | 支持 | 支持 | 支持 |
| 浏览器语音转写 | 环境支持时可用 | 环境支持时可用 | Chromium 支持时可用，否则提示接入企业 ASR |
| JPEG/PNG/WEBP/PDF 材料 | 最多 3 个、单个 4 MiB | 相同 | 相同 |
| 告警列表与转智脑分析 | 支持 | 支持 | 支持 |
| 受控确认卡与一次性 Token | 支持 | 支持 | 支持 |
| 执行回执与工作项 | 支持 | 支持 | 支持 |
| Agent 健康、审计和队列摘要 | 支持 | 支持 | 支持 |
| 原生窗口控制 | 不适用 | 不适用 | 最小化、最大化、关闭 |

三端都只调用服务端 Agent API。模型输出不能直接触发写操作；确认卡仍由服务端命令、原 run、主体、会话、设备和短期一次性 Token 共同约束。

## 3. 工程结构

```text
packages/agent-workbench/
├─ src/AgentWorkbench.vue       多端统一状态、交互和业务流程
└─ src/style.css                中性深色工作区视觉系统

apps/desktop/
├─ src/App.vue                  桌面 Web/Electron 宿主
├─ electron/main.cjs            Electron 主进程与安全策略
├─ electron/preload.cjs         最小窗口控制桥
├─ scripts/dev-electron.mjs     Vite + Electron 联合开发启动器
├─ scripts/build-icon.mjs       桌面图标生成
└─ package.json                 Web 构建和 Windows 打包配置

apps/mobile/
└─ src/App.vue                  移动宿主，使用同一个 Workbench
```

## 4. 本地运行

先启动 API：

```powershell
npm.cmd install
npm.cmd run dev:api
```

启动桌面 Web：

```powershell
npm.cmd run dev:zhinao:web
```

访问 `http://127.0.0.1:5184`。

启动 Electron 开发窗口：

```powershell
npm.cmd run dev:zhinao:electron
```

启动移动端统一工作台：

```powershell
npm.cmd run dev -w @healthcare-ai/mobile-app
```

访问 `http://127.0.0.1:5175`。

Demo 账号为 `admin@demo.local`、`production@demo.local`、`quality@demo.local`、`procurement@demo.local`、`market@demo.local`，密码统一为 `demo`。这些账号和 Demo Header 在生产环境必须关闭。

## 5. 构建与交付

```powershell
# 桌面 Web 静态产物
npm.cmd run build:desktop

# Windows 解包应用
npm.cmd run pack:electron

# Windows NSIS 安装包和便携版
npm.cmd run dist:electron
```

解包应用默认输出到：

```text
apps/desktop/release/v0.3.0/win-unpacked/元域智脑.exe
```

同目录下同时生成 `YuanyuZhinao-Setup-0.3.0-x64.exe` 安装包与 `YuanyuZhinao-Portable-0.3.0-x64.exe` 便携版。

生产发布还必须补充企业代码签名证书、签名流水线、安装包哈希与制品仓库。当前本地构建没有企业签名身份，不能直接作为正式生产安装包分发。

## 6. Electron 安全边界

当前 Electron 主进程执行以下约束：

- `nodeIntegration: false`；
- `contextIsolation: true`；
- `sandbox: true`；
- 禁止 `webview`、拖放导航和生产 DevTools；
- 主窗口只允许加载开发期 Vite 来源或打包后的唯一 `dist/index.html`；
- 新窗口一律拒绝，仅允许 HTTPS 链接交给系统浏览器；
- 下载默认拒绝；
- 权限默认拒绝，只对可信渲染来源开放音频媒体请求；
- preload 只暴露应用信息和最小化/最大化/关闭操作；
- 每个 IPC 调用重新验证发送方 URL；
- API Key、模型密钥和企业系统凭据不进入 Electron 代码、preload 或浏览器存储。

浏览器版本默认调用同源 `/api`，开发服务器通过 Vite 代理到本地 API；Electron 从经过协议校验的 `ZHINAO_API_BASE_URL` 接收服务地址，只允许企业 HTTPS，或在本地 Demo 使用 `localhost/127.0.0.1` HTTP。生产环境仍须配置企业 HTTPS / mTLS 网关、证书校验、设备信任、自动更新签名验证和安全版本淘汰策略。

## 7. 视觉规范

三端采用统一的中性深色工作区风格：低饱和黑灰画布、克制分隔线、单一黄绿色状态强调、左侧任务导航、中央对话工作区、右侧实时上下文与底部组合输入器。风格参考现代 Agent 开发工作台的信息密度与层级，但不使用 OpenAI/Codex 商标、图标或专有品牌素材。

## 8. 已完成验证

- 桌面 Web 和移动端 Vite 构建通过；
- 现有 20 项 Agent 安全、7 项 Evidence Trace 与 21 项权限/IAM/客户端权限代际回归全部通过；
- npm 生产/开发依赖审计为 0 个已知漏洞；
- 浏览器真实流程已验证登录、对话、告警转分析、图片材料、采购确认卡、一次性确认执行、回执与待办视图；
- Electron Windows 解包目录生成成功；
- Electron 启动烟测确认页面标题正确且 `.agent-workbench` 已挂载。

Windows 自动化截图组件对无边框 Electron 窗口返回 `0x80004002`，因此原生窗口使用 Electron 启动烟测验收；同一渲染代码的视觉与业务流程已在真实 Chromium 浏览器中完成截图和交互验证。
