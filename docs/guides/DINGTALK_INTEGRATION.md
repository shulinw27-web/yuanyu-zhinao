# 钉钉智脑工作台接入指南

2026-09-17：免登验证后改为查询服务端配置租户内的人员和角色，不能再匹配全局Demo账号。没有本企业IAM账号时拒绝登录；旧会话需要重新登录。企业IAM初始化尚未接入门户，正式切换前请阅读[身份源与权限适配指南](IDENTITY_PROVIDER_ADAPTERS.md#租户绑定与升级注意事项)。本轮为合成协议与本地HTTP回归，未调用真实钉钉。

2026-09-14：共用H5工作台新增[异常助手](ANOMALY_ASSISTANT.md)，支持人工/模拟汇报、AI解读与分析、@提报人消息预览及本站本人回复/版本确认。@尚未发送到钉钉，回复身份为本站提交者。未接入机器人Stream、全群消息、原生语音或群卡片；不能把H5入口可用理解为已监听群聊或已完成平台发送者校验。

更新：2026-09-08。当前已完成代码接入及模拟协议验证，尚未在真实企业钉钉中发布或验收。

身份接入现已支持统一适配器。仅使用钉钉可保留本文配置；需要与其他企业身份源共存时，使用 [身份源清单](IDENTITY_PROVIDER_ADAPTERS.md)，并在清单中启用 `dingtalk`。清单未列出的钉钉接入不会生效，不能用旧登录接口绕过。

## 接入方式

其他终端部署见 [各端指南](CLIENT_ACCESS_GUIDE.md)；与企业微信、飞书等国内入口的区别见 [国内平台指南](DOMESTIC_PLATFORM_ACCESS_GUIDE.md)。

采用企业内部 H5 微应用。手机钉钉与电脑钉钉打开同一个响应式工作台，共用现有 Agent、会话、文件理解及权限服务。`apps/dingtalk/` 只负责钉钉宿主适配；不复制业务逻辑，也不把元域智营端放进业务入口。

应用首页地址和 PC 端首页地址均可配置为同一个 HTTPS 站点。例如 `https://zhinao.example.com/`。该站点部署 `apps/dingtalk/dist/`，同源 `/api/` 反向代理到业务 API。

| 能力 | 手机钉钉 | 电脑钉钉 |
| --- | --- | --- |
| 企业身份免登 | 已有代码，待企业联调 | 已有代码，待企业联调 |
| 对话、任务窗口、材料续问 | 复用业务工作台 | 复用业务工作台 |
| 图片和文档上传 | H5 文件选择器，实际格式支持需真机确认 | H5 文件选择器 |
| 待办、告警、业务确认 | 按平台权限访问，保留确认步骤 | 同左 |
| 会话和长期记忆 | 使用服务端租户及账号范围 | 同一租户和账号可访问相同记录；不保证实时推送同步 |
| 写用户电脑文件、端侧 Worker | 不提供 | 不提供，仍需独立 Electron 客户端 |
| 钉钉消息推送、钉盘、钉钉审批 | 本期未接入 | 本期未接入 |
| 原生录音、扫码、相机 JSAPI | 本期未接入，网页能力以宿主许可为准 | 本期未接入 |

钉钉是工作台入口，不会自动把原有 Mock ERP/OA 变成真实企业数据。模型能力与出网规则沿用现有模型网关。

## 企业需要准备的内容

1. 企业 CorpId，企业内部 H5 微应用的 Client ID（原 AppKey）、Client Secret（原 AppSecret）。记录 AgentId 供后台配置及后续工作通知接入使用；本期免登代码不使用 AgentId。
2. 应用可见范围及测试成员。根据实际使用接口申请最小权限，不默认申请全部通讯录、审批或钉盘权限。
3. 测试成员的企业 userid，以及对应的现有平台账号。先在平台 IAM 中建好账号、组织、角色与数据范围，再配置一对一映射。不能用昵称或手机号猜测身份。
4. 一个手机和电脑都能访问的 HTTPS 域名、TLS 证书、DNS 与反向代理。内网站点须确保手机已有企业批准的网络通道。手机上的 `127.0.0.1` 不是开发电脑。
5. 服务端访问 `api.dingtalk.com`、`oapi.dingtalk.com` 的网络出口及所需平台出口白名单。生产密钥只给 API 服务账号读取。
6. Android、iOS、Windows、macOS 的目标钉钉版本与测试设备，明确实际部署网络和应用授权范围。

本轮没有自动创建企业应用、发布可见范围、开公网隧道或读取企业通讯录。

## 服务端配置

参考 [配置模板](../../config/dingtalk.example.json)，复制到项目外的受限目录，例如 `D:\wsl\private\yuanyu-zhinao\dingtalk.json`。模板占位符不能直接用于登录。不要把真实配置放入 `public/`、前端环境变量、源码或聊天消息。

| 配置字段 | 用途 |
| --- | --- |
| `corpId` | 唯一允许的钉钉企业 |
| `clientId`、`clientSecret` | 企业应用凭据，仅服务端使用 secret |
| `tenantId` | 平台逻辑租户 ID；跨端共用记录必须使用同一租户及同一 IAM 账号 |
| `allowedOrigins` | 精确来源列表，例如 `https://zhinao.example.com`，不带路径或末尾斜杠 |
| `userBindings` | `{userId, account}` 数组，不允许多人共用一个平台账号 |

开发终端示例（不是完整生产启动配置）：

```powershell
$env:DINGTALK_ENABLED = 'true'
$env:DINGTALK_CONFIG_FILE = 'D:\wsl\private\yuanyu-zhinao\dingtalk.json'
$env:OA_AUTH_MODE = 'dingtalk'
$env:ACCOUNT_AUTH_MODE = 'enterprise'
$env:DEMO_ALLOW_ROLE_HEADER = 'false'
$env:CORS_ALLOWED_ORIGINS = 'https://zhinao.example.com'
npm run dev:api
```

生产采用 `NODE_ENV=production`，仍须满足项目既有 KMS、持久化、模型和 HTTPS 配置要求。选用 `OA_AUTH_MODE=dingtalk` 时由有效钉钉配置代替强制 OIDC 配置，不会开放 OA Mock 或本地演示登录。本期登录挑战存于单 API 进程，生产须 `SINGLE_NODE_DEPLOYMENT=true`；多副本部署前应将挑战和重放记录迁入支持原子消费的共享存储。

开发可在配置的 `allowedOrigins` 和 `CORS_ALLOWED_ORIGINS` 中同时增加 `http://127.0.0.1:15194`；非生产仅放行回环 HTTP，不能用通配符或任意内网 HTTP 替代 HTTPS。

## 构建与钉钉后台操作

```powershell
npm ci
npm run dev:dingtalk
# 本机界面入口 http://127.0.0.1:15194/
npm run build:dingtalk
```

构建产物为 `apps/dingtalk/dist/`。生产部署到独立站点根目录，并把 `/api/` 代理到同一套业务后端；不要把开发 Vite 服务直接当生产服务器。保留请求 Origin 和客户端身份头，禁用登录接口缓存，访问日志不记录授权码、请求体或凭据。静态站点的 HTTPS、安全头及 CSP 按实际钉钉 WebView 验收，禁止使用 `frame-ancestors *` 之类的全放行配置。

钉钉开发者后台中完成：创建企业内部 H5 微应用 → 配置应用首页与 PC 首页 → 按后台要求配置可信域名、接口权限与出口白名单 → 设置测试可见范围 → 发布测试版本 → 手机和 PC 各自从企业工作台进入。不同后台版本的配置名称以实际界面为准。

普通浏览器会提示从钉钉进入，不提供“模拟钉钉登录”按钮。缺失配置、非成员、未映射账号或授权失败时停止登录，不能回退为管理员或演示用户。

## 身份及权限链路

钉钉 SDK 就绪 → 服务端签发短期挑战 → `runtime.permission.requestAuthCode` 获取一次性免登码 → 服务端用企业应用 token 校验免登码 → 企业 userid 映射平台账号 → 签发绑定设备的平台会话 → 业务接口执行既有 IAM 校验。

- 企业和映射来自服务端配置，不相信 URL、浏览器角色、钉钉昵称或管理员标识。
- 挑战绑定来源、设备、平台及配置快照，120 秒有效且一次性消费；免登码不自动重试，日志不输出授权码或 token。
- 钉钉入口只在内存保存平台会话。重新打开页面会重新验证宿主身份，不恢复上一个员工的 localStorage 会话。
- 平台账号停用、IAM 权限版本变化、钉钉绑定删除或企业/租户配置变化后，后续请求会拒绝旧会话。
- 钉钉侧员工离职和权限变更尚无事件订阅同步。应同时停用平台账号或删除绑定；钉钉内切换账号后需重新打开应用，不承诺已打开页面能实时检测宿主账号变化。
- 用户能登录不等于能读全部公司数据；敏感写入仍须鉴权、确认和业务审批。

## 联调验收

先验证一个低权限成员，再验证未绑定、停用、不同企业及管理员账号。覆盖免登失败、重放、网络超时、切换账号、重新打开页面和应用可见范围外成员。业务场景至少执行文件上传与两轮追问、会话切换、拒绝越权读取、取消写入确认，以及“保存到电脑桌面”被提示使用独立客户端。

浏览器已用合成 SDK/API 检查手机、平板和 PC 布局及前端登录链路；不代表钉钉 JSAPI 真机、生产权限、真实企业数据或大模型效果已验收。测试细节见 [钉钉接入测试报告](../development/DINGTALK_ACCEPTANCE_2026-09-08.md)。

## 官方参考

- [钉钉官方 H5 企业内部应用免登示例](https://github.com/open-dingtalk/h5app-auth-demo)
- [获取企业内部应用 access_token](https://open.dingtalk.com/document/orgapp-server/obtain-orgapp-token)
- [通过免登码获取用户信息](https://open.dingtalk.com/document/orgapp-server/obtain-the-userid-of-a-user-by-using-the-log-free)
- [新版微应用免登接口支持范围](https://open.dingtalk.com/tools/explorer/jsapi?id=11723)

本期使用官方示例中的 `runtime.permission.requestAuthCode`，SDK 固定为 `dingtalk-jsapi@3.2.9`；不是新版顶层同名接口。不要将两套接口的参数及回调直接混用。
