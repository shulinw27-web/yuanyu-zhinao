# WeKnora 本地部署（D 盘）

第七批复测：Docker 引擎停止会使项目检索返回503，不能据此推断 Key 失效或模型欠费。2026-09-13 恢复已安装 Docker/原容器后，`npm run evaluate:weknora -- --live-synthetic` 13/13；包括新业务目录隔离检查。未改密钥、权限或数据，本轮没有追加模型/Embedding 调用。浏览器测试 API 使用内存存储并在测试后关闭，不是业务常驻服务。

2026-09-13：已按用户确认创建并保存专用只读 Key，限定唯一合成库，项目仅绑定演示管理员及一份合成制度。恢复 Docker/现有容器后，双端真实读取、引用、越权拒绝和混合检索通过；两端各三轮方舟回答通过。没有重新拉取镜像或改变数据库内容、原模型密钥。默认私有配置为关键词，Embedding 与知识模型出网测试仅显式开启。[最新验收](../development/WEKNORA_UPGRADE_ACCEPTANCE.md) · [启动与复现](../guides/KNOWLEDGE_WORKSPACE_GUIDE.md)。下面“待确认”属于历史记录。

2026-09-12 第四批项目更新：来源问答与 Wiki 已用现有方舟 Key 完成四个合成用例验证，配置及数据仅在隔离进程。未改变 WeKnora 容器、模型密钥或现有账户。项目专用 Key 的 API 集成表单已限定唯一合成库及只读检索，等待创建确认；项目真实绑定仍未完成。新增仓库外配置助手，见 [知识工作区指南](../guides/KNOWLEDGE_WORKSPACE_GUIDE.md) 第6节。勿把 Ark 生成验证当成 WeKnora 适配器联通。

2026-09-12 最新：独立合成库已完成文档解析、索引、摘要及三轮同会话 RAG 验证。修复内置“快速问答”未绑定主对话模型，现使用已验证的方舟模型。项目新增私有配置和可选混合检索代码，但未配置项目只读 Key/资源绑定。见 [最新验收](../development/WEKNORA_UPGRADE_ACCEPTANCE.md) 和 [配置指南](../guides/KNOWLEDGE_WORKSPACE_GUIDE.md)。下文为此前部署阶段记录，未验收范围以本段及最新报告为准。

[返回运维目录](README.md) · [参考 WeKnora 升级](../architecture/WEKNORA_UPGRADE_REFERENCE.md)

更新日期：2026-09-12。

## 当前状态

独立实例已在 D 盘部署并启动，访问 `http://127.0.0.1:18080/` 可进入中文登录页。五个容器、数据库迁移及重启冒烟验证已完成，用户已自行创建账号。当前空间已配置方舟聊天模型和 `doubao-embedding-vision-251215` 向量模型，两者均通过 WeKnora 原生调用测试。向量本次返回 2048 维，此前 403 暂未复现。知识库问答尚未验证，本实例尚未接入智脑与语义运营端。

- 已克隆官方稳定版 [v0.8.0](https://github.com/Tencent/WeKnora/releases/tag/v0.8.0)，提交 `1edcd54b43606d9079bb36650efe3f68707a79ea`。
- 已通过 Compose 配置校验，核对生效服务仅 frontend、app、docreader、postgres、redis。
- 已随机生成本地数据库密码、Redis 密码、JWT 密钥和 32 字节 AES 密钥，未采用上游示例密码；`.env` 已确认被 Git 忽略。
- 已核对生效端口仅绑定 IPv4 回环地址，数据库、Redis、Docreader 不发布宿主端口。
- 已核对 Docker 设置 `CustomWslDistroDir` 和实际 VHDX 均在 D 盘。
- app、Docreader、Postgres 的健康探针通过；前端 HTTP 200，Redis 正常运行（上游未定义其独立健康探针）。
- 已修复本地只读技能挂载与上游入口脚本写入行为的冲突：不挂载宿主技能目录，使用版本镜像内自带目录；业务配置文件仍只读。

## 目录与访问地址

| 用途 | 位置 |
| --- | --- |
| 独立部署根目录 | `D:\wsl\services\weknora` |
| 上游源码、Compose、私密 .env | `D:\wsl\services\weknora\source` |
| 本机覆盖配置 | `D:\wsl\services\weknora\source\compose.override.yaml` |
| 上传文件 | `D:\wsl\services\weknora\data\files` |
| 镜像、Postgres/Redis 命名卷、解析临时卷 | `D:\wsl\workspace\DockerData\disk\docker_data.vhdx` 内 |
| Docker 运行时虚拟磁盘 | `D:\wsl\workspace\DockerData\main\ext4.vhdx` |
| 管理脚本 | `D:\wsl\services\weknora\manage.ps1` |
| 启动后网页 | `http://127.0.0.1:18080/` |
| 启动后 API / 健康探针 | `http://127.0.0.1:18081/health` |

不是只把源码放到 D 盘：大体积镜像与数据库也使用已配置的 D 盘 Docker 数据盘。Docker Desktop 自身少量 AppData 配置和日志仍可能写 C 盘，不能保证 C 盘零写入。

## 启动与停止

先手动打开 Docker Desktop，等待引擎运行。在 PowerShell 中执行：

```powershell
& 'D:\wsl\services\weknora\manage.ps1' -Action Start
& 'D:\wsl\services\weknora\manage.ps1' -Action Status
& 'D:\wsl\services\weknora\manage.ps1' -Action Stop
```

如果本机策略不允许运行脚本，不更改系统执行策略；可以在 PowerShell 或 CMD 中使用以下原生命令（同样要求 Docker 已启动且数据盘仍在 D 盘）：

```text
docker compose --project-directory D:\wsl\services\weknora\source config --quiet
docker compose --project-directory D:\wsl\services\weknora\source pull
docker compose --project-directory D:\wsl\services\weknora\source up -d --no-build --wait --wait-timeout 240
docker compose --project-directory D:\wsl\services\weknora\source ps
docker compose --project-directory D:\wsl\services\weknora\source stop
```

不得使用 `down -v`、`volume prune` 或删除 DockerData 清理本实例；这些操作可能删除资料或影响其他 Docker 项目。升级先备份、阅读目标版本迁移说明，再同步上游源码版本和 `.env` 中的镜像版本。

## 配置取舍

- 保留官方 Postgres/ParadeDB 检索存储、Redis 队列和 Docreader；数据库使用 Docker 管理的 Linux 文件系统，避免直接在 Windows NTFS 目录上运行数据库。
- Redis 增加持久卷和 AOF；上传文件单独绑定 D 盘，便于备份。
- 内存上限：app 2 GiB、Docreader 4 GiB、Postgres 2 GiB、Redis 512 MiB、前端 256 MiB。上限不是预分配，解析大文档仍需实测调整。
- 调低并发，限制日志轮转；关闭模型全文调试日志。
- 不启动 Neo4j、MinIO、Langfuse、MCP 服务及 Docker 沙箱，不挂载 Docker socket。
- 首次注册仅供本机初始化；账号已由用户创建，建议后续关闭注册。未自动创建或提升管理员身份。
- 不重新安装 Ollama；经用户授权复用智脑项目的方舟密钥，原始配置文件未改动。聊天和 Embedding 调用已验证，Rerank、VLM 未配置。

## 验收与剩余事项

| 项目 | 本轮状态 |
| --- | --- |
| 版本、源码、路径、私密配置 | 完成 |
| Compose 语法与生效端口/挂载检查 | 完成 |
| Docker 引擎运行 | Docker Engine 29.6.2 已运行 |
| 镜像拉取、容器健康检查 | 五个镜像已下载；三个上游健康探针通过，前端 HTTP 200、Redis 正常运行 |
| 账号初始化、模型配置 | 用户已创建账号；聊天模型 1 个、Embedding 模型 1 个，均通过原生调用；向量维度 2048 |
| 测试资料上传、解析、检索与带引用问答 | 未执行 |
| 重启后数据保持、实际资源占用 | 五个容器重启恢复；D 盘测试文件可读，数据库迁移状态保持，已测空载资源；业务数据与大文档负载未测 |
| 与智脑/语义运营的鉴权及 API 集成 | 已开发服务端只读适配器并通过 Mock HTTP；真实资源绑定、API Key 与实例集成未启用，双端聊天未接入 |

## 本轮实际验证结果

| 检查 | 结果 |
| --- | --- |
| 后端 `/health` | HTTP 200，重启前后均通过 |
| 前端 `/` 与反向代理 `/api/v1/auth/config` | HTTP 200 |
| 浏览器实际页面 | 自动进入 `/login`，中文登录表单及创建账户入口可见 |
| 未认证访问 `/api/v1/knowledge-bases` | HTTP 401 |
| app 普通用户写权限 | `appuser` 对 `/data/files` 可写 |
| D 盘文件重启后可见 | 放置无业务数据的测试标记，重启全部五个容器后，从 app 容器读回一致；测试标记已清除 |
| 数据库迁移 | `schema_migrations` 为版本 90，`dirty=false`；重启后保持 |
| 检索扩展 | PostgreSQL 已安装 `vector`、`pg_search`、`pg_trgm` 等扩展 |
| 端口与卷 | 18080/18081 仅绑定 127.0.0.1；app 上传目录实际绑定 D 盘，Postgres/Redis/Docreader 卷属于 weknora-local 项目 |

首次启动后的单次空载快照：app 177.6 MiB、Docreader 127.9 MiB、Postgres 73.59 MiB、Redis 5.508 MiB、前端 12.07 MiB，合计约 397 MiB，不含 Docker/WSL 自身开销，不能代表文档解析或问答峰值。

下一步使用虚构材料验证知识库上传、解析分块、向量入库、检索引用与连续追问，再验证双端身份和资源绑定。不要拿聊天或向量模型连通成功代替 RAG 能力验收。

## 方舟接入与真实调用记录

用户明确授权将智脑现有方舟密钥配置到本机 WeKnora，并允许少量收费 API 测试。

- 密钥来源为 D 盘原有私密 `ark.json`；未输出密钥，未修改原文件或其模型白名单。
- 模型：`doubao-seed-2-1-pro-260628`，显示名“方舟 · 豆包 Seed 2.1 Pro”，provider 为 `volcengine`。
- 范围：仅用户当前空间 10000；`is_builtin=false`，不向其他空间共享。配置行 ID 为 `local-ark-chat-20260912`，可通过当前空间模型管理界面维护。
- 使用本地部署管理脚本 `D:\wsl\services\weknora\configure-ark.mjs`，先进行合成请求探测，通过后通过部署端 SQL 写入空间模型。密钥按上游 `enc:v1:` AES-256-GCM 格式加密后入库；没有伪造登录令牌或新建管理 API Key。此次是部署端配置，不宣称产生了模型创建 API 的审计事件。
- 测试部署采用 32K 上下文预算、4096 输出预算，未开启视觉标记；这些是保守配置上限，不是对供应商最大上下文或视觉能力的验收。

| 调用 | 结果 |
| --- | --- |
| Windows 直连聊天第一次 | 连接/响应异常，未获得成功结果 |
| Windows 直连聊天重试 | HTTP 200，3347 ms，回答 `ARK_OK`，usage 56 tokens |
| WeKnora 原生模型测试第一次 | 8009 ms 失败：容器 DNS 解析方舟域名超时，SSRF 校验拒绝继续 |
| DNS 修复后原生模型测试 | 3522 ms 成功，流式回答 `WEKNORA_ARK_OK`，finish_reason=stop，usage 72 tokens |
| Embedding 探测 | `doubao-embedding-vision-250615`，`/embeddings/multimodal`，HTTP 403，AccessDenied；未返回向量、未保存模型 |

上述初次成功请求报告的 usage 合计 128 tokens；下述授权后聊天回归另报告 56 tokens。失败请求无可用计费用量，实际费用以方舟账单为准。未执行真实用户资料上传、知识库 RAG、多轮记忆、图片理解或性能压力测试。

### 向量权限调整与回归（2026-09-12）

用户明确确认后，编辑现有 `yuanyu-zhinao` API Key，仅新增 Doubao-embedding-vision 模型访问权限。保存后重新打开编辑页，确认 Model ID 数为 2：Doubao-Seed-2.1-pro 与 Doubao-embedding-vision 均选中；默认全选仍关闭，IP 白名单开关及其他设置未改动。没有修改其他密钥，没有新建全权限密钥，也没有修改原始 `ark.json` 或业务端模型白名单。

开通管理中 Doubao-embedding-vision 已显示“已开通”，因此没有重复开通或购买套餐。此前确实缺少密钥模型权限，但补充后仍被拒绝，不能将它认定为唯一根因，也没有证据认定为欠费。

| 授权后复测 | 实际结果 |
| --- | --- |
| Windows，`doubao-embedding-vision-250615` | HTTP 403 AccessDenied；一次响应 1673 ms |
| Windows，`doubao-embedding-vision-251215` | HTTP 403 AccessDenied，1858 ms |
| Docker Docreader，`doubao-embedding-vision-251215` | HTTP 403 AccessDenied，2084 ms；说明拒绝不只发生在 Windows 网络路径 |
| 原聊天模型回归 | HTTP 200，2443 ms，回答 `ARK_OK`，usage 56 tokens |
| 向量模型入库及原生 UI 测试 | 未执行：没有获得有效向量，安装脚本按失败关闭原则不写入模型 |

`251215` 版本依据 [火山引擎 OpenViking 官方接入指南](https://github.com/volcengine/OpenViking/blob/main/docs/zh/guides/02-volcengine-purchase-guide.md) 补充测试；这不代表已完成该版本效果验收。Windows 同时存在间歇性约 10.6 秒连接失败，已与返回 HTTP 403 的服务端鉴权拒绝分开记录。

部署脚本增加脱敏错误摘要及 `--container` 探测选项，只向官方方舟地址发送凭证，禁止重定向，凭证仅经标准输入传入本实例容器，不打印密钥或请求正文。该次失败时仅有一个已验证聊天模型；后续向量恢复见下一节，历史失败记录保留。

### 向量重试成功（2026-09-12）

用户要求重新尝试后，本次未更改方舟权限、密钥、网络配置或购买套餐，直接重试成功。不能仅凭恢复就认定此前 403 是网络故障或确定权限传播延迟。

| 检查 | 实际结果 |
| --- | --- |
| Docker Docreader 直连方舟 | HTTP 200，2719 ms；`doubao-embedding-vision-251215` 返回 2048 个有限数值，usage 30 tokens，均为文本输入 |
| WeKnora 模型配置 | 保存 `local-ark-embedding-20260912`，类型 Embedding、provider=volcengine、维度 2048；限定当前空间 10000，`is_builtin=false`，密钥 AES-256-GCM 加密 |
| WeKnora 原生模型测试 | 页面显示“调用成功”，2461 ms，向量维度 2048，并返回数值数组 |
| 已配置模型复核 | 聊天 1 个、Embedding 1 个，两条凭证均为加密存储；聊天配置未改动 |

原生测试文本为“模拟测试：原料采购入库后进入生产环节，异常批次需追溯关联订单。”，没有真实业务或个人数据。直连探测报告 30 tokens；原生 Embedding 测试页面未显示 usage，不能把它算成零费用，实际账单以方舟为准。

本次验证仅覆盖多模态向量模型的**文本输入**和应用连通性，未验收图片/视频向量、知识库入库与检索质量。未调用 `250615` 旧版本，不能据此宣称所有版本均已恢复；没有把模型配置成功标记为双端知识服务已接入。

### DNS 修复

Docker 默认解析器 `127.0.0.11` 向宿主转发时出现超时，容器内路由器 DNS 测试也超时。实测 [阿里公共 DNS](https://alidns.com/) `223.5.5.5` 和 `223.6.6.6` 均可返回方舟域名的公网地址，故仅在本实例 app、docreader 的 Compose 覆盖配置增加这两个 DNS。未修改 Windows、其他 Docker 项目、SSRF 白名单或 TLS 校验；没有固定方舟 IP。重建相关容器后，未带凭证探测方舟返回预期 HTTP 401，DNS 耗时约 0.255 秒，随后已保存模型的原生调用通过。

若后续接入企业内网域名，应配置可解析企业域名且可达的 DNS，不能盲目沿用公共 DNS，也不能通过放宽 SSRF 来掩盖解析故障。

## 暂停模型重试后的开发进展

上一开发轮按用户要求暂停向量重试，完成了双端个人资料接口、精确修订引用与原文摘录；WeKnora v0.8.0 只读关键词适配器通过模拟 HTTP 验证，该轮没有创建管理 Key、上传资料或调用模型。本轮向量模型已恢复并保存，但知识库问答仍未完成。双端启用还需要独立 WeKnora 只读凭证和服务端企业/主体/角色到知识库及文档白名单的映射，详见 [第二批实施记录](../development/WEKNORA_UPGRADE_ACCEPTANCE.md)。

## 备份与隐私

备份需要包含私密 `.env`、上传文件、数据库逻辑备份和必要 Redis 状态；AES 密钥丢失会导致已加密凭证无法恢复。不要在 Docker 运行时直接复制 VHDX 充当一致性备份。`.env`、数据库备份与用户文档不提交 GitHub，不公开输出完整 `docker compose config`（会展开密钥）。
