# 本地开发与启动

更新：2026-10-11。以下命令在项目根目录执行；默认只用于开发和模拟数据，不用于生产。

## 环境

- Node.js：现有 CI 使用 22；本机验证环境为 24.14.1。桌面下载器要求至少 22.12.0，项目还使用 `node:sqlite`；不要切回旧版 Node。下载器升级和 D 盘打包缓存说明见[供应链安全基线](../operations/SOFTWARE_SUPPLY_CHAIN.md)。
- npm：使用根目录 `package-lock.json` 和 workspaces，在根目录执行 `npm ci`。
- Python：用于独立 Semantica 服务和文档工具。优先复用项目已有虚拟环境，缺失时再创建；依赖见 [requirements.txt](../../services/semantic-context/requirements.txt)。
- Windows Electron：开发依赖随 npm 安装；Tauri/移动原生打包另需相应平台工具链，Web 构建不等于原生发布。

```powershell
node --version
npm --version
python --version
npm ci
```

已有正在运行的环境不需要每次都重装依赖。`.env.example` 是配置说明，现有 npm 启动命令**不会自动加载根目录 `.env`**；可在终端设置环境变量，或明确使用 Node 的 `--env-file`。不要把真实密钥写入版本库。

## 最小体验与多端启动

先启动 API，再按需选择客户端。每条持续运行的命令分别占用一个终端。

| 入口 | 命令 | 默认地址/端口 |
| --- | --- | --- |
| 业务 API | `npm run dev:api` | `http://127.0.0.1:3001` |
| 元域智营 | `npm run dev:web` | `http://127.0.0.1:5173` |
| 元域智语 Web | `npm run dev:semantic-ops` | `http://127.0.0.1:5174` |
| 业务智脑 Web | `npm run dev:zhinao:web` | `http://127.0.0.1:5184` |
| 移动端 Web | `npm run dev -w @healthcare-ai/mobile-app` | `http://127.0.0.1:5175` |
| 业务智脑 Electron | `npm run dev:zhinao:electron` | 桌面窗口，启动脚本管理渲染器 |
| 元域智语 Electron | `npm run dev:semantic-ops:electron` | 独立桌面窗口，启动脚本管理渲染器 |

Electron 开发启动与同端 Web 可能争用端口；先确认已有实例。遇到端口占用不要直接终止所有 Node 进程，应核实对应服务后关闭该实例。

### API 默认端口被其他项目占用

不要停止其他项目。例如元域 API 改用 `15181` 时，在 API 终端设置 `$env:PORT='15181'` 后启动原配置入口。两端各自的启动终端还必须同时设置代理与 Electron 地址：只设置 `VITE_DEV_API_TARGET` 对网页有效，Electron preload 会优先使用独立配置，否则仍请求默认 `3001`。

```powershell
# 智脑启动终端
$env:VITE_DEV_API_TARGET='http://127.0.0.1:15181'
$env:ZHINAO_API_BASE_URL='http://127.0.0.1:15181/api'
npm run dev:zhinao:electron

# 语义运营启动终端
$env:VITE_DEV_API_TARGET='http://127.0.0.1:15181'
$env:SEMANTIC_OPS_API_BASE_URL='http://127.0.0.1:15181/api'
npm run dev:semantic-ops:electron
```

修改地址后须重启桌面窗口，刷新页面不会重新注入 preload 地址。若智脑 `5184` 渲染器已经运行且代理正确，不重复启动 Vite：设置上述智脑 API 地址及 `$env:ELECTRON_RENDERER_URL='http://127.0.0.1:5184'`，运行 `npm run start:electron -w @healthcare-ai/desktop-app` 复用渲染器。接口验证应包含业务初始化请求，不能仅根据网页 HTML 或健康接口成功判断桌面请求正确。

开发 Vite 页面会根据 `VITE_DEV_API_TARGET` 向 CSP 的 `connect-src` 加入该地址的精确 origin，允许本机 HTTP 或 HTTPS，拒绝非本机明文 HTTP、带凭据及控制字符的地址；不使用全端口通配符、不关闭 Electron `webSecurity`。该转换只用于开发服务，不修改生产构建的 CSP；打包桌面非默认明文端口仍需独立配置和验收，不能将本开发验证当作安装包验收。2026-10-13已复现并修复网页代理正常但桌面直连被 CSP 拦截的情况；浏览器直连15181返回200、真实Electron隔离启动无连接错误，运营端131/131、桌面组件11/11和架构10/10通过。

检查 API：

```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/health/live
Invoke-RestMethod http://127.0.0.1:3001/api/health/ready
```

登录和业务操作见 [智脑指南](../guides/ZHINAO_USER_GUIDE_V2.md)、[元域智语指南](../guides/元域智语-Agent操作指南-v1.0.md)。Demo 账号仅限本地演练，不允许用于生产。

## Semantica 与后台服务

已有 `.venv-semantica` 时，使用其中的 Python 启动服务；环境不可用时按项目依赖重建，不删除其他正在使用的虚拟环境。

```powershell
# 首次缺少环境时才执行前两条
python -m venv .venv-semantica
.\.venv-semantica\Scripts\python.exe -m pip install -r services/semantic-context/requirements.txt
.\.venv-semantica\Scripts\python.exe services/semantic-context/app.py
# 另一个终端检查
Invoke-RestMethod http://127.0.0.1:3011/health
```

健康响应中的 `engine=semantica` 才表示 Semantica 导入成功；`projection-fallback` 是降级模式。图节点/关系数量取决于是否导入场景数据，不能只看到 HTTP 200 就判断演练闭环成功。导入与验证路径见 [Semantica 评估](SEMANTICA_MOCK_EVALUATION.md)。服务边界见 [独立语义服务](../operations/SEMANTIC_SERVICE.md)。

其他服务按测试目标启动，不要求每次全部运行：

| 命令 | 用途 |
| --- | --- |
| `npm run dev:key-center` | 独立 Key Center，默认 3010；不代表已接入企业 KMS |
| `npm run dev:event-worker` | 领域事件消费 |
| `npm run dev:agent-runtime-worker` | 长任务维护与超时回收 |
| `npm run dev:agent-run-transition-worker` | 长任务状态与 Agent Run 同步 |
| `npm run dev:agent-orchestration-worker` | 单次/周期任务编排 |
| `npm run dev:semantic-inspection-worker` | 语义巡检调度 |

Worker 与 API 要使用一致的存储和租户配置。生产启动顺序与开关见 [运行配置](../modules/11-runtime-platform/CONFIGURATION.md)。

## 使用本地大模型

### 智谱 GLM 私密输入（普通 API）

首选统一文件：`D:\wsl\private\yuanyu-zhinao\models.json`（仓库之外，当前用户限定 ACL）。`activeProvider` 选择 `glm`、`ark`、`deepseek`、`qwen`、`kimi` 或 `compatible`；在对应 `providers` 项填 `apiKey`，已有有效 `model`/`baseUrl` 时只需要填密钥，其他空项不影响当前选择。通义/Kimi/通用兼容项未预填型号和地址，首次使用还需明确已开通的型号与官方 HTTPS 网关，不能仅填 Key 就猜测路由。原有方舟/GLM 独立文件保留，统一入口不会读取或迁移其密钥。

`npm run check:models` 只检查配置，不调用大模型；通过后保留原 `PORT` 设置，使用 `npm run dev:models` 启动两端共用 API。修改文件后须重启 API（不会自动调用新供应商，不需要重装客户端）。选定模型严格固定，显式环境端点/密钥冲突或环境白名单拒绝时停止，不把文件密钥发送到其他环境端点；不回退到其他密钥。密钥仅由服务端使用，不发给 Renderer，也不输出原始 JSON/解析错误。文件为受限明文，不是加密密钥库；`models.json` 已加入 Git 忽略规则。以下独立 GLM 输入方式作为旧入口保留，今后优先使用统一文件。

运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\wsl\workspace\project\demo-platform\scripts\save-glm-config.ps1"`，在本机窗口输入已开通的精确模型 ID（回车默认 `glm-5`）和隐藏的 API Key。仅保存到仓库外 `D:\wsl\private\yuanyu-zhinao\glm\glm.json`，GLM 专用目录限制当前 Windows 用户，不修改方舟文件；已有 GLM 文件拒绝覆盖。不要把密钥发到聊天、命令参数或 Git。

`node scripts/glm-runtime.mjs --check-config` 只检查配置及模型白名单，不调用外部模型；配置有效后，可沿原 API 启动端口执行 `node scripts/glm-runtime.mjs`，两端共用后端 `compatible` 通道。启动明确选择该通道并保留脱敏、结构化回答、额度、权限门禁，不自动回退到方舟。默认地址限定为 `https://open.bigmodel.cn/api/paas/v4`，不接 Coding Plan；实际余额、模型权限与回答质量须在用户保存后单独联调，配置成功不是调用成功。依据：[智谱官方 GLM 接口](https://docs.bigmodel.cn/cn/guide/models/text/glm-5)。密钥保存在受限明文文件，不是 Windows 密钥库加密或企业 KMS。

先独立启动兼容接口，再在启动 API 的终端设置 `AGENT_RUNTIME_MODE=local`、`LOCAL_LLM_BASE_URL`、`LOCAL_LLM_MODEL` 和 `MODEL_ALLOWLIST_JSON`。具体变量示例见 [.env.example](../../.env.example)。

模型 ID 必须与推理服务返回的 ID、白名单完全一致；GGUF 文件路径与模型别名不能混用。API Key 按本地服务要求注入，不假定必须有或一定不需要。界面出现“模型未在白名单”“降级”时，应检查地址、ID、服务状态和响应协议，不能仅因有文字回答就判断模型接入成功。

## 回归与构建

```powershell
npm run docs:check
npm run quality
npm run build
npm run build:desktop
npm run build:mobile
npm run migrate:verify
```

`quality` 包含 lint、类型检查和 `test:all`；默认 Node 自动化测试不能替代真实 PostgreSQL 集群、Python 图引擎、Electron 系统集成或企业接口验收。专项命令可以在 [package.json](../../package.json) 中查到。非功能验证见 [测试指南](NONFUNCTIONAL_TEST_GUIDE.md)。

Windows 交付包按需执行 `npm run dist:electron` 或 `npm run dist:semantic-ops-electron`；生成包不等于已经完成代码签名和发布验收。

## 本地数据与退出

使用各终端的 Ctrl+C 停止对应进程。`backend/.data/`、`.runtime/`、虚拟环境和客户端 `release/` 目录不能当作无用文档清理。不要用重置数据库来掩盖问题；确需重置时先确认实例与数据路径并备份。正式说明统一放 `docs/`，临时测试报告放 `output/`。
