# 元域智脑

企业 Agent 工作台与独立语义运营平台。业务端处理对话、业务分析和受控日常任务；语义运营端负责对象建模、人工校对、版本发布和巡检。二者共用服务端权限、执行与审计能力，但不共用业务授权边界。

当前是可运行的开发与 Mock 演练基线，**不是已验收的生产系统**。默认演练数据覆盖供应链、生产、质量、库存与审批；真实企业系统接入仍需沙箱、接口契约和授权材料。

## 文档入口

全部项目文档集中在 **[docs 文档中心](docs/README.md)**；本页仅保留项目入口。

- 初次接手：[项目交接](docs/overview/PROJECT_HANDOFF.md)、[当前状态](docs/overview/PROJECT_STATUS.md)
- 开始开发：[本地开发与启动](docs/development/GETTING_STARTED.md)、[开发准备事项](docs/development/DEVELOPMENT_READINESS.md)
- 理解设计：[整体架构](docs/architecture/ARCHITECTURE.md)、[模块与 API](docs/modules/README.md)
- 操作体验：[智脑使用说明](docs/guides/ZHINAO_USER_GUIDE_V2.md)、[语义运营指南](docs/guides/元域智脑-语义运营Agent操作指南-v1.0.md)
- 准备上线：[生产 Checklist](docs/operations/PRODUCTION_TODO_CHECKLIST.md)
- 源码托管：[GitHub 私有仓库与提交基线](docs/operations/GITHUB_REPOSITORY.md)
- 钉钉接入：[手机与 PC 接入指南](docs/guides/DINGTALK_INTEGRATION.md)
- 身份与权限：[多平台身份源适配](docs/guides/IDENTITY_PROVIDER_ADAPTERS.md)
- 各端接入：[客户端接入](docs/guides/CLIENT_ACCESS_GUIDE.md)、[国内协同平台接入](docs/guides/DOMESTIC_PLATFORM_ACCESS_GUIDE.md)

## 工程分工

| 目录 | 用途 |
| --- | --- |
| `frontend/` | 管理 Web：运营看板、配置与权限管理 |
| `apps/desktop/` | 智脑 Web 与 Electron 桌面工作台 |
| `apps/semantic-operations-console/` | 独立语义运营 Agent，支持 Web 与 Electron |
| `apps/mobile/` | 移动端智脑 |
| `apps/dingtalk/` | 钉钉手机与 PC 的 H5 智脑入口，企业免登待联调 |
| `backend/` | 业务 API、Agent 编排、授权与持久化 |
| `packages/` | 共享契约、SDK、工作台与客户端运行时 |
| `services/` | 语义服务、密钥中心及后台 Worker |
| `deploy/`、`examples/` | 部署模板和集成示例 |
| `scripts/` | 验证、供应链报告及文档生成工具 |
| `docs/` | 唯一项目文档目录，包括交付文件与必要历史记录 |
| `output/` | 自动生成的检查报告，不放正式说明文档 |

## 最小启动

在项目根目录运行，两个服务分别占用一个终端：

```powershell
npm ci
npm run dev:api
# 另一个终端：业务智脑 Web
npm run dev:zhinao:web
```

打开 `http://127.0.0.1:5184`。默认 Mock 不调用真实大模型，也不连接企业生产系统；完整多端启动、Semantica 与模型配置见 [开发指南](docs/development/GETTING_STARTED.md)。

```powershell
npm run docs:check
npm run quality
```

不要删除 `backend/.data/`、`.runtime/` 或把真实凭据写进仓库。确认、审批和执行回执是三个不同阶段；模型回答不能代替执行结果。
