# 本地开发与启动

更新：2026-09-03。以下命令在项目根目录执行；默认只用于开发和模拟数据，不用于生产。

## 环境

- Node.js：现有 CI 使用 22；本次整理验证环境为 24.14.1。项目使用 `node:sqlite`，请使用包含该能力的版本，不要切回旧版 Node。
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
| 管理 Web | `npm run dev:web` | `http://127.0.0.1:5173` |
| 语义运营 Web | `npm run dev:semantic-ops` | `http://127.0.0.1:5174` |
| 业务智脑 Web | `npm run dev:zhinao:web` | `http://127.0.0.1:5184` |
| 移动端 Web | `npm run dev -w @healthcare-ai/mobile-app` | `http://127.0.0.1:5175` |
| 业务智脑 Electron | `npm run dev:zhinao:electron` | 桌面窗口，启动脚本管理渲染器 |
| 语义运营 Electron | `npm run dev:semantic-ops:electron` | 独立桌面窗口，启动脚本管理渲染器 |

Electron 开发启动与同端 Web 可能争用端口；先确认已有实例。遇到端口占用不要直接终止所有 Node 进程，应核实对应服务后关闭该实例。

检查 API：

```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/health/live
Invoke-RestMethod http://127.0.0.1:3001/api/health/ready
```

登录和业务操作见 [智脑指南](../guides/ZHINAO_USER_GUIDE_V2.md)、[语义运营指南](../guides/元域智脑-语义运营Agent操作指南-v1.0.md)。Demo 账号仅限本地演练，不允许用于生产。

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
