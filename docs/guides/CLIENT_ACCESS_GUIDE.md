# 元域智脑各端接入指南

版本：1.0｜核对日期：2026-09-08｜范围：业务智脑、元域智营、管理 Web、移动 H5、Windows Electron 及国内协同平台入口。

本文依据当前代码说明如何准备、部署、接入身份及验收。构建成功、页面能打开、身份验证成功、业务验收通过是四个不同阶段，不能相互替代。本文不包含海外协同平台。

## 1. 先选入口

| 入口 | 使用对象与用途 | 工程位置 | 当前边界 |
| --- | --- | --- | --- |
| 智脑 Web | 业务人员，对话、任务、材料分析 | `apps/desktop` 的 Web 构建 | 可部署；企业登录宿主需要接入 |
| 智脑 Windows 桌面端 | 需要受控本机文件操作的业务人员 | `apps/desktop` 的 Electron 宿主 | 有打包基线；签名、分发与企业登录仍需验收 |
| 智脑移动 H5 | 手机浏览器中的业务工作台 | `apps/mobile` | H5 可构建；不是已验收的 Android/iOS/鸿蒙原生 App |
| 钉钉手机/PC 工作台 | 从企业钉钉使用智脑 | `apps/dingtalk` | 专用 H5 及免登已有代码，待企业真机联调 |
| 元域智营 Web | 建模、人工校对、发布、巡检 | `apps/semantic-operations-console` | 独立运营入口，使用运营 IAM 权限 |
| 元域智营 Windows 桌面端 | 桌面建模及受控报告导出 | 同上，Electron 宿主 | 独立安装包；不等于业务端全部本机执行能力 |
| 管理 Web | 平台管理、权限配置、治理看板 | `frontend` | 已有 Bearer 接口桥接；没有完整多身份源登录选择界面 |

企业微信、飞书、WeLink、WPS 365 的入口方案及材料详见 [国内平台接入指南](DOMESTIC_PLATFORM_ACCESS_GUIDE.md)。这些平台的专用适配器尚未开发，不能直接把钉钉构建包改名使用。

## 2. 所有端共用的准备事项

### 环境与网络

- 可用的 API、持久化服务、模型网关及项目要求的其他后端依赖。模型不可用与登录失败分开排查。
- 企业可达的 HTTPS 站点、TLS 证书、DNS、反向代理、时间同步和经批准的网络出口。
- 手机、办公电脑、企业代理网络都能访问的地址。手机上的 `127.0.0.1` 指手机自己，不是开发机；本机开发端口不作为正式地址。
- 每个入口的精确 Origin、身份回调 URL、可信域名及应用可见范围。三者用途不同，不可只配其中一个。
- 测试与生产域名、企业应用、密钥、账号和模型配置分别管理。不要用测试免登直接打开生产业务。

### 账号与权限

- 核实员工外部身份标识，创建已启用的平台 IAM 账号，配置组织、角色和数据范围。
- 同一企业不同入口使用一致的平台租户及账号映射，才能延续该员工可见的任务和记忆。
- 准备普通业务用户、运营用户、管理员、未绑定用户、停用用户各一组。
- 确定离职停用、角色回收、临时访问到期及身份平台故障时的处置流程。外部平台管理员不自动成为平台管理员。

### 接入材料记录表

下表只记录标识及密钥保管位置，不填写密钥本身。

| 材料 | 需要确认的内容 |
| --- | --- |
| 入口 | 业务智脑/元域智营/管理端；Web/H5/Electron；目标终端版本 |
| 应用 | 国内平台名称、企业 ID、应用 ID、环境及测试可见范围 |
| 地址 | 应用首页、PC 首页（平台支持时）、准确回调地址、API Origin |
| 身份 | 身份源 ID、外部用户 ID 的类型、绑定的平台账号、平台租户 |
| 权限 | 登录需要的最小权限；通讯录、消息、文件和审批是否另行申请 |
| 密钥 | 受限配置文件或密钥中心的位置、读取服务账号、轮换方式 |
| 网络 | 域名解析、证书链、出口 IP、平台要求的白名单、手机访问方式 |
| 验收 | 测试设备、合成材料、预期拒绝场景、回滚版本及检查记录 |

## 3. 构建与部署

在仓库根目录运行所选入口的命令。依赖按锁文件安装，生产通过制品流水线构建；这里不要求重新安装当前开发机依赖。

| 入口 | 构建命令 | 静态产物/打包目录 |
| --- | --- | --- |
| 智脑 Web | `npm run build:desktop` | `apps/desktop/dist` |
| 移动 H5 | `npm run build:mobile` | `apps/mobile/dist` |
| 钉钉 H5 | `npm run build:dingtalk` | `apps/dingtalk/dist` |
| 元域智营 Web | `npm run build:semantic-ops` | `apps/semantic-operations-console/dist` |
| 管理 Web | `npm run build -w frontend` | `frontend/dist` |
| 智脑 Windows 安装包 | `npm run dist:electron` | `apps/desktop/release/v0.3.0` |
| 元域智营 Windows 安装包 | `npm run dist:semantic-ops-electron` | `apps/semantic-operations-console/release/v0.2.0` |

当前 Electron 发布配置为 Windows x64；不要据此声明已经具备 macOS、Linux 或国产桌面系统的安装验收。移动工程中的 Tauri 依赖也不代表已有通过签名分发的原生应用。

建议各 Web/H5 入口使用独立站点根目录，而非未经验证的多级子路径。例如业务 `https://agent.example.com/`、运营 `https://semantic.example.com/`、管理 `https://admin.example.com/`。示例域名不是已部署服务。

每个站点的 `/api/` 代理到同一套受控 API，保留必要身份头，不记录 Authorization、免登码或登录请求体。业务与运营是不同应用入口，不应仅靠菜单隐藏来隔离权限。

本地调试可使用 `npm run dev:zhinao:web`、`npm run dev:semantic-ops`、`npm run dev:dingtalk`、`npm run dev:web`；移动端使用 `npm run dev -w @healthcare-ai/mobile-app`。以启动日志中的端口为准，已有启动脚本可能覆盖默认端口。

## 4. 各端身份接入步骤

### 4.1 智脑 Web

1. 先部署静态站点及同源 API 代理，确认未登录时受保护 API 拒绝访问。
2. 选择钉钉专用免登或国内企业身份服务。通用 OIDC 接入采用 [身份源适配指南](IDENTITY_PROVIDER_ADAPTERS.md) 的托管配置。
3. 企业宿主完成登录、授权回调及必要的令牌续期，向 SDK 提供 `getAccessToken`。项目目前没有包办所有身份平台的浏览器登录流程。
4. 初始化之前设置运行时配置，或创建已注入身份能力的共享客户端。切换身份源时销毁旧客户端并重新登录。
5. 使用低权限账号检查对话、文件材料与任务列表，再做越权和停用测试。

以下是宿主集成示意，不是复制后即可运行的登录代码：

```javascript
// enterpriseLogin 是企业自行接入的登录模块，项目没有内置该变量。
globalThis.__ZHINAO_RUNTIME_CONFIG__ = {
  apiBaseUrl: 'https://agent.example.com/api',
  identityProviderId: 'company-sso',
  getAccessToken: () => enterpriseLogin.getValidAccessToken()
};
// 应在应用初始化前设置；不要把固定 Token 或应用 Secret 写在这里。
```

### 4.2 智脑 Windows 桌面端

1. 使用企业 HTTPS API 地址。Electron 主进程读取 `ZHINAO_API_BASE_URL`，再经受限预加载桥交给页面；开发回环地址只用于本机演练。
2. 当前桌面预加载主要提供 API 和受控本机操作能力。企业登录的浏览器回调、令牌桥、续期和全局注销还需按选定国内身份源接入，设置 API 地址本身不会完成 SSO。
3. 构建安装包，补齐企业代码签名、制品校验和分发渠道；不把本地未签名构建当成正式包。
4. 验证本机操作的目标路径、权限确认、取消、回执与失败状态。网页免登不能绕过这些确认。
5. 断网、重启、切换员工后重新核对身份与任务归属。安装参数和日志中不得放应用 Secret 或访问令牌。

受控文件操作范围详见 [桌面说明](DESKTOP_ZHINAO.md) 与 [执行协议](DESKTOP_WORKBENCH_EXECUTION.md)。

### 4.3 智脑移动 H5

1. 部署 `apps/mobile/dist`，通过企业允许的网络在真机打开 HTTPS 地址。
2. 普通手机浏览器由企业登录宿主提供身份；钉钉中使用专门的 `apps/dingtalk`，不直接替换为移动 H5 包。
3. 验证软键盘弹起、旋转屏幕、文件选择、网络切换和会话恢复。原生录音、扫码、相册等 JSAPI 需要单独接入及授权。
4. 不承诺手机网页写电脑桌面、执行电脑程序或读取任意本地文件。需要电脑端执行时，应明确引导到已授权的独立桌面端。

移动工程包版本当前为 0.1.0，但页面上报客户端协议版本为 0.3.0。接入时以协议门禁为准，不要把 package 版本误用为请求版本。

### 4.4 元域智营 Web 与 Windows 桌面端

1. 独立部署运营站点或安装包，不复用业务用户入口的高权限登录态。
2. 运营 SDK `createSemanticOperationsClient` 支持 `identityProviderId` 和 `accessTokenProvider`；宿主须真正提供登录及有效 Token。
3. 运营 Electron API 地址使用 `SEMANTIC_OPS_API_BASE_URL`；现有预加载不包含完整企业 SSO 流程。
4. 逐项验证对象建模、校对、草稿、校验、发布和回滚。登录成功不代表允许发布。
5. 平台内嵌运营入口属于后续宿主集成。优先在 PC 验收完整建模；手机先按查看、轻量校对范围设计，不能把业务端的手机布局验收套用于建模画布。

### 4.5 管理 Web

1. 部署 `frontend/dist`。API 地址可以由同源 `/api`、运行时 `apiBaseUrl` 或构建变量 `VITE_API_BASE_URL` 指定。
2. 登录宿主可通过运行时 `getAccessToken` 或 `setAdminAccessTokenProvider` 提供令牌。
3. 当前管理 Web 不会自动读取 `identityProviderId` 并发送选择头。可先对接服务端的单一 `defaultBearerProviderId`；若要在管理端切换多个身份源，仍需补充请求头和登录界面适配。
4. 不使用开发角色选择器作为生产授权来源。托管身份模式会拒绝 Demo 角色回退。

## 5. 联通检查顺序

```text
入口能加载 → API 可达 → 身份源配置有效 → 登录身份已绑定
          → IAM 允许 → 数据连接器可用 → 模型可用 → 业务完成并可核验
```

`GET /api/auth/providers` 只证明服务端读到了适配配置，不证明企业平台已允许登录。`/api/health` 返回成功也不代表所有真实业务系统已接入。

受保护请求需保留 `x-client-platform`、`x-client-version`、`x-client-device-id`。业务 Web 使用 `desktop`，管理 Web 使用 `web`；其他协议标识见 [兼容矩阵](../development/CLIENT_COMPATIBILITY_MATRIX.md)。不要为尚未开发的平台随意发送新标识，否则生产版本门禁可能拒绝。

## 6. 各端验收清单

| 检查 | 验收要求 |
| --- | --- |
| 登录失败 | 不显示业务数据，不降级为演示账号或管理员 |
| 账号切换 | 不复用前一员工的会话、可见任务或材料缓存 |
| 权限回收 | 平台停用/撤销绑定后，后续受保护请求被拒绝 |
| 双端隔离 | 业务用户不能因登录成功获得语义发布或平台管理权限 |
| 文件理解 | 上传合成表格/文档后可追问；受限材料按策略拦截 |
| 桌面差异 | Web/H5 不宣称已经写入电脑；Electron 显示真实回执 |
| 数据与模型 | 区分 Mock 数据、真实接口、模型失败及受控降级 |
| 多设备 | Android/iOS 与目标 Windows 客户端分别验收，不以浏览器模拟代替 |
| 长期使用 | 休眠、令牌到期、弱网、刷新页面和重新登录后状态合理 |

运行代码回归可使用 `npm run test:clients`、`npm run test:identity-providers`、`npm run test:dingtalk`；这些仍不能替代企业应用真实验收。发布要求见 [生产 Checklist](../operations/PRODUCTION_TODO_CHECKLIST.md)。

## 7. 常见问题

| 表现 | 优先排查 |
| --- | --- |
| 手机打不开，本机能打开 | 是否用了回环地址；企业网络、DNS 与证书是否可达 |
| 401 | 身份是否过期、是否绑定、身份源是否正确、是否混用了其他平台 Token |
| 403 | 区分平台应用权限与本项目 IAM；不要通过扩大全部权限试错 |
| 426 | 实际发送的客户端协议标识/版本与服务端门禁是否一致 |
| CORS 错误 | Origin 精确配置、代理是否保留认证头；不要直接设通配符 |
| 页面打开但无 SSO | 是否仅配置了首页，尚未完成宿主免登和服务端验码 |
| 模型不智能或回答失败 | 查看模型状态、上下文及数据连接，不把登录成功当成模型已接通 |
| 浏览器称不能写电脑文件 | 属于入口能力边界，使用已部署并授权的独立 Electron 端 |

本文仅新增接入说明，没有创建企业应用、启用真实身份配置、发布安装包或改变现有运行入口。
