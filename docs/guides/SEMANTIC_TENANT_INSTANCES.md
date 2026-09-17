# Semantica 独立租户实例接入

更新日期：2026-09-17。适用范围：本机 Node API 到独立 Python Semantica 进程的受控接入及单实例持久化。

## 已实现与未实现

门户侧现已提供[开通申请及实例预检子流程](PORTAL_RUNTIME_PROVISIONING.md)，可核验受保护的持久化实例，但不会自动启动Python进程或授予业务权限。

一个租户绑定一个独立进程、端口、部署标识和服务密钥。API 从已认证租户上下文选择实例；客户端不能传入目标地址或用请求体切换租户。实例在读写前校验服务身份，API 在发送模型前核对实例回执，收到结果后再次核对。

本次已用两个真实 Semantica 进程验证独立发布、图数据隔离、重置隔离、错误绑定拒绝、停用及密钥轮换后旧密钥拒绝。没有修改当前用户服务的运行配置，也没有开通实际企业租户。

2026-09-17 补充：已提供按租户/部署绑定的 SQLite 原子快照。开启后，模型及发布回执、图、来源事实、运行记录和去重索引在重启后恢复；写盘成功之后才返回操作成功。内存模式仍用于本地兼容测试，不冒称持久化。

以下能力仍未完成：

- 定时/在线备份、异地加密备份、保留与清理策略、故障迁移、数据库升级迁移。已实现停机校验、手动备份和恢复到新文件，并完成合成恢复演练；不是集群容灾能力。
- 门户开通到执行面 IAM、成员映射、权益和在途任务撤权。`runtimeConnected` 仍为 false。
- 企业真实源数据的租户来源证明及接入。平台共享 Demo 演练库不能自动导入其他租户。
- 容器/操作系统隔离、生产存储隔离、远程 TLS/mTLS 接入与多实例压力验收。进程隔离不是抵御本机管理员的安全边界。

## 配置归属

| 使用方 | 配置 | 内容与边界 |
| --- | --- | --- |
| Node API | `SEMANTIC_INSTANCES_FILE` | 绝对路径，平台部署人员管理；保存租户到端点及密钥的绑定 |
| 每个 Python 实例 | `SEMANTIC_INSTANCE_CONFIG_FILE` | 各自独立的绝对路径；只含本实例的租户、部署标识和密钥 |
| 每个 Python 实例 | `SEMANTIC_CONTEXT_PORT` | 本机独立端口，服务只监听 127.0.0.1 |
| 每个 Python 实例 | `SEMANTIC_INSTANCE_DB` | 租户独立SQLite文件绝对路径；父目录须预先存在，不能复用其他租户/部署的数据文件 |
| 每个 Python 实例 | `SEMANTIC_REQUIRE_DURABLE_STORAGE=true` | 缺数据库配置时拒绝启动；`NODE_ENV=production` 同样强制要求数据库 |

文件应保存在仓库外，例如 `D:\wsl\private\yuanyu-zhinao\semantic`，通过文件系统权限仅允许对应服务账号读取。密钥不要提交 Git、粘贴进聊天或放进前端环境变量。每个密钥使用加密随机生成器生成至少32字节，再编码为 base64url；长度43～128字符，不同实例不得复用。

Node 注册表格式如下。占位密钥必须替换，不可直接启动：

```json
{
  "version": 1,
  "instances": [
    {
      "tenantId": "company-a",
      "deploymentId": "semantic-company-a-01",
      "enabled": true,
      "endpoint": "http://127.0.0.1:3031",
      "token": "<独立随机密钥A>"
    },
    {
      "tenantId": "company-b",
      "deploymentId": "semantic-company-b-01",
      "enabled": true,
      "endpoint": "http://127.0.0.1:3032",
      "token": "<独立随机密钥B>"
    }
  ]
}
```

`tenantId` 必须与服务端认证身份的租户标识一致，不是任意企业名称。注册表不会创建身份、成员或权限。租户/部署标识目前只接受字母数字开头及字母数字、下划线、点、冒号、短横线，最长120字符。

实例 A 的配置格式如下，密钥与注册表中 A 的值一致；实例 B 使用自己的值：

```json
{
  "version": 1,
  "tenantId": "company-a",
  "deploymentId": "semantic-company-a-01",
  "token": "<独立随机密钥A>"
}
```

## 启动顺序

先以各自服务环境启动独立实例。下面为 PowerShell 中实例 A 的示例；B 使用3032端口和独立配置文件。项目目录下已有安装 Semantica 的虚拟环境时可使用：

```powershell
$env:SEMANTIC_CONTEXT_PORT = '3031'
$env:SEMANTIC_INSTANCE_CONFIG_FILE = 'D:\wsl\private\yuanyu-zhinao\semantic\company-a.json'
$env:SEMANTIC_REQUIRE_INSTANCE_AUTH = 'true'
$env:SEMANTIC_INSTANCE_DB = 'D:\wsl\private\yuanyu-zhinao\semantic\state\company-a.db'
$env:SEMANTIC_REQUIRE_DURABLE_STORAGE = 'true'
.\.venv-semantica\Scripts\python.exe services/semantic-context/app.py
```

启动前先创建并限制 `state` 目录的文件权限，B使用自己的数据库路径；不要使用项目源文件或其他应用数据库。然后在 Node API 的服务环境设置以下变量，按现有 API 启动流程重新加载后端：

```powershell
$env:SEMANTIC_INSTANCES_FILE = 'D:\wsl\private\yuanyu-zhinao\semantic\instances.json'
$env:SEMANTICA_DEMO_BRIDGE_ENABLED = 'true'
```

不要把配置文件或 Python 启动命令交给最终业务用户。当前没有从门户自动启动进程的功能。

## 拒绝与回执规则

- 注册表一旦配置即为唯一依据：未知、停用、文件缺失或格式错误都拒绝，不回退到 Demo。即使是 Demo 租户，也需要显式登记；生产 Node 环境始终要求显式绑定。
- 租户、部署标识、规范化后的端点及密钥不能重复。其他租户不能占用隐式 Demo 的地址。只允许无路径、无凭据、无查询参数的本机 HTTP 根地址；不跟随重定向。
- Python 在配置读取失败时拒绝启动；`NODE_ENV=production` 或 `SEMANTIC_REQUIRE_INSTANCE_AUTH=true` 时缺配置也拒绝启动。未配置时保留原本地 Demo 兼容模式，不能把该模式当生产认证。
- Python 对所有已有 GET/POST 业务接口和健康检查校验 Bearer 密钥、租户与部署标识；重复身份头、错租户、错部署或错密钥均403，拒绝响应不含实例数据。
- API 先访问受保护的 `/instance` 核对三个响应头，再发送模型；操作响应再次核对 `X-Semantic-Tenant`、`X-Semantic-Deployment` 和 `X-Semantic-Protocol: 1`。验证后的发布结果附带安全的实例标识，不返回密钥。
- 预检失败且未发送发布 POST 时，发布状态是“未尝试”，配置修复后可以重试。POST 已发出但回执丢失或不匹配时保持不确定状态，只能对账，不自动重发。
- 共享 Mock 场景库没有完整租户来源证明，因此非 Demo 的自动图同步仍返回 `tenant_fixture_unavailable`。进程测试直接向各自临时实例写合成事实，不代表企业连接器已经接入。

Node 每次操作重新读取注册表，但操作开始后使用其绑定快照。停用影响后续请求，不取消已经派发的在途请求。Python 配置只在启动时读取；轮换密钥需要重启实例并同步更新注册表，旧密钥随后失效。开启持久化后，在租户/部署标识和数据库路径不变的情况下轮换密钥会恢复原状态；密钥不写入数据库。未开启持久化的本地内存模式仍会在重启后丢失状态。

## 持久化及故障处理

- 每次成功发布、事实接收或图重置，在实例锁内保存完整快照；SQLite事务提交成功后才返回成功，使用 `synchronous=FULL`。读请求不会看到写入尚未提交的中间状态。
- 启动时校验数据库归属、快照版本、校验和及结构，恢复 Semantica 图和来源索引后才开始监听。原有文件损坏、归属不同、快照缺失或不支持的版本均拒绝启动，不创建空图掩盖问题。
- 一个数据库只能由一个本服务进程打开；跨进程文件锁阻止第二实例使用同一文件。锁随进程结束释放，不需要手工删除 `.lock` 文件。这不是防止有磁盘权限的外部程序修改数据库的机制。
- 快照上限32MiB，每次完整重写。适用于当前合成验证规模，尚未完成大图、长时间运行和生产负载验收。校验和用于检测意外损坏，不是对抗管理员篡改的密码学签名。
- 写盘失败、容量超限或提交结果不确定时，内存尝试回滚并将实例标记为失败，后续读写返回503。先排查磁盘/权限，再重启从最后一次已提交快照恢复；不能手工把状态改为成功。若恢复仍失败，应保留原文件排查，不删除重建。
- 图重置清空图、事实和运行记录，保留已发布模型；此结果也持久化。事实ID、场景ID与已接收内容冲突时返回409，不覆盖既有来源。
- `/instance` 返回 `storage=sqlite-snapshot`、`durable=true` 和快照修订号；内存模式为 `process-memory`、`durable=false`。这只表示本机持久化已启用，不是备份、高可用或生产安全认证。

现有运行中的内存实例不会被自动迁移。首次开启数据库从新实例初始状态开始；如需保留原内存数据，应先另行设计并验证受控导出/导入，不能直接重启并假定数据已迁移。已有数据库的租户/部署标识不可随意改动；自动重绑定和跨部署迁移尚未实现。

## 复现验证

### 停机备份与恢复

运维工具为 `services/semantic-context/manage_instance_store.py`，没有开放到业务端或模型工具箱。它只接受已有实例配置和绝对路径；数据库必须属于该租户及部署。源库按只读方式打开，若实例仍在使用源库则拒绝操作，不强行解锁或终止进程。

先按维护流程停止目标租户实例，保留原库。为备份目录配置与业务数据同等级的访问控制，再执行以下示例；目录应事先存在，目标文件必须是新文件：

```powershell
$semanticPython = '.\.venv-semantica\Scripts\python.exe'
$instanceConfig = 'D:\wsl\private\yuanyu-zhinao\semantic\company-a.json'
& $semanticPython services/semantic-context/manage_instance_store.py verify --config $instanceConfig --source 'D:\wsl\private\yuanyu-zhinao\semantic\state\company-a.db'
& $semanticPython services/semantic-context/manage_instance_store.py backup --config $instanceConfig --source 'D:\wsl\private\yuanyu-zhinao\semantic\state\company-a.db' --target 'D:\wsl\private\yuanyu-zhinao\semantic\backups\company-a-20260917.db'
& $semanticPython services/semantic-context/manage_instance_store.py restore --config $instanceConfig --source 'D:\wsl\private\yuanyu-zhinao\semantic\backups\company-a-20260917.db' --target 'D:\wsl\private\yuanyu-zhinao\semantic\state\company-a-restored-20260917.db'
```

备份和恢复均执行源校验、SQLite复制、目标再次校验，保留租户、部署、快照修订号及数据，不写入服务密钥。只有校验通过后才发布新目标文件；使用同目录临时文件和不覆盖目标的原子硬链接发布，不支持该机制的文件系统会拒绝，不降级为覆盖式复制。已有目标、源目标同名及目标在操作期间被其他程序创建时均不覆盖。

成功输出仅包含操作、状态、租户、部署和修订号；失败返回非零退出码。发生不确定失败时，目标文件可能已创建，应先用 `verify` 校验并核对记录，不能靠覆盖重跑消除不确定性。工具不删除源库、不切换环境变量、不重启业务服务，也不解除授权限制。

恢复后的库应先在维护环境用原租户/部署身份启动，检查模型版本、指纹、来源记录和图；同时核对Node侧已发布模型是否与备份一致。恢复旧语义库不会同步回滚应用侧草稿、会话、成员或账单，不能因为健康检查200就直接恢复生产流量。正式切换由运维审核后修改目标实例的 `SEMANTIC_INSTANCE_DB`，原库保留用于排查。

备份文件包含该实例的数据，当前未加密，也没有自动保留期限或异地副本。同磁盘备份不能抵御整盘损坏；合成演练不代表真实断电恢复或生产RPO/RTO已经验收。未对用户现有数据库执行备份或恢复。

### 自动化回归

```powershell
npm run test:multitenant
npm run test:semantic-instances
.\.venv-semantica\Scripts\python.exe -m unittest discover -s services/semantic-context -p 'test_*.py'
```

第二条命令分别以内存和SQLite模式启动两租户临时真实 Python/Semantica 进程，用动态端口和随机测试密钥，经 Node 适配器调用真实 HTTP；每种模式都终止并重启两个实例，验证旧密钥拒绝、模型/图恢复差异和重置不复活。测试结束关闭自己的进程并删除自己的临时配置和合成数据库，不操作现有业务实例。不调用方舟或收费接口。

默认查找项目 `.venv-semantica`；可用 `SEMANTIC_TEST_PYTHON` 指定已安装 Semantica 的 Python 绝对路径。环境缺失会失败，不会悄悄跳过。测试还断言服务引擎确实为 Semantica，而不是投影回退。

最终结果和未关闭项见[多租户回归报告](../development/MULTITENANT_VALIDATION.md)及[生产待办](../operations/PRODUCTION_TODO_CHECKLIST.md)。
