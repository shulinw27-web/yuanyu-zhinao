# 企业沙箱身份初始化与运行准入

更新：2026-09-17。适用范围是本地沙箱，不是正式商业开通。本文配合[门户申请与预检](PORTAL_RUNTIME_PROVISIONING.md)、[身份源指南](IDENTITY_PROVIDER_ADAPTERS.md)使用。

## 已实现的流程

客户在门户提交预检申请；部署人员准备企业组织、人员和身份源映射清单，运行预览，核对人员、角色、期限、配额后用预览摘要确认。后端把IAM和运行准入记录放在同一事务中保存，失败时不出现“只授予权限但没有准入记录”的半成品。

注册、付费、门户owner/admin角色都不会自动变成业务管理员。清单中的业务角色必须由部署人员明确选择；角色策略以平台角色模板为基础，数据范围收窄到当前组织，不复制Demo人员和组织。已有、未纳入本流程的IAM工作区不能被覆盖。

### 当前开放的受控功能

| 功能代码 | 允许的入口 | 边界 |
| --- | --- | --- |
| `iam` | `/api/permission-management`及其子路径 | 仍需本租户IAM页面/按钮权限 |
| `semantic` | `/api/meta-models/oa-governance`及其子路径、受控语义巡检 | 语义实例另行配置，不自动创建或发布 |
| `knowledge` | 双端`knowledge-library`及子路径 | 仍需资料ACL、来源复验和原有确认 |

没有通过租户隔离验收的通用业务连接器、桌面执行、后台业务Agent等路径不会因为清单审批成功而开放。`runtimeConnected=false`保持不变；普通开发态、未纳入准入控制的旧测试租户仍按既有路径运行，不得用于企业上线。

## 部署准备

在后端进程及相关Worker中使用相同的运行库和准入配置。将门户数据库以只读权限提供给后端；门户仍由门户进程写入。路径来自服务端环境，不能由请求指定。

```powershell
$env:RUNTIME_STORE_DRIVER = 'sqlite'
$env:RUNTIME_SQLITE_PATH = 'D:\wsl\private\yuanyu-zhinao\sandbox-runtime.db'
$env:TENANT_PORTAL_DB = 'D:\wsl\private\yuanyu-zhinao\sandbox-portal.db'
$env:IDENTITY_PROVIDERS_FILE = 'D:\wsl\private\yuanyu-zhinao\identity-providers.local.json'
$env:TENANT_RUNTIME_CONTROL_REQUIRED = 'true'
```

以上为路径示例，必须指向此次部署的实际数据库。不要把测试库替换为正在运行的真实业务库来试命令。`REQUIRED=true`会拒绝未登记的非Demo租户，应在合成环境验证后再切换。生产环境拒绝使用沙箱审批；本CLI只支持显式SQLite沙箱路径。PostgreSQL使用同一异步事务接口，但尚未完成真实部署验收。

初始化清单要求已配置的OIDC身份源与不可变subject，或者已启用的钉钉身份源与企业userId。钉钉使用`providerId: "dingtalk"`，`subject`填企业userId；还需部署钉钉私有配置，并在身份源清单中启用钉钉。企业corpId、应用clientId、租户和成员映射共同绑定，clientSecret不写入审核结果或运行库。不要用昵称代替userId，也不要将企业tenant改为Demo。

## 清单与审核

将清单放在仓库外的`enrollment.local.json`。从门户`/me`读取本租户ID、版本、申请ID和成员ID；外部subject从企业身份源取得，不能用昵称推测。字段示意如下，`expiresAt`须替换为未来30天内的毫秒时间戳。

```json
{
  "version": 1,
  "tenantId": "替换为门户租户ID",
  "provisioningId": "替换为有效申请ID",
  "expectedPortalVersion": 2,
  "expiresAt": 0,
  "dailyRequests": 1000,
  "features": ["iam", "semantic", "knowledge"],
  "organizations": [{ "id": "company", "name": "企业名称", "parentId": null }],
  "users": [{
    "portalUserId": "替换为已加入本空间的人员ID",
    "account": "reviewer@example.test",
    "name": "企业校对员",
    "orgUnitId": "company",
    "roleIds": ["quality_manager"],
    "primaryRoleId": "quality_manager",
    "providerId": "enterprise-sso",
    "subject": "替换为企业不可变subject"
  }]
}
```

```powershell
node scripts/tenant-runtime-control.mjs prepare 'D:\wsl\private\yuanyu-zhinao\enrollment.local.json'
node scripts/tenant-runtime-control.mjs apply 'D:\wsl\private\yuanyu-zhinao\enrollment.local.json' '<核对后粘贴approvalDigest>'
node scripts/tenant-runtime-control.mjs inspect '<租户ID>'
node scripts/tenant-runtime-control.mjs revoke '<租户ID>' '<inspect返回的revision>'
```

预览不创建人员或准入记录；首次打开一个全新SQLite路径会建立存储表结构。摘要绑定清单、门户版本、成员授权、身份源和现有IAM数据。任何变化都需重新预览；相同有效确认重试不会重复授权。申请必须仍有效，申请人与列出的成员必须有效。席位不能超过当前沙箱套餐。人员列表不能重号、组织不能成环、未知字段或角色拒绝。

撤销后需要重新预览和确认才能恢复，不能重放旧确认摘要恢复权限。重新确认递增IAM及准入版本，旧会话不复活。审计只保留最近200条操作元数据；这不是生产不可篡改审计档案。

## 运行时检查与限额

- 会话签发、会话验证和HTTP授权都核对准入。门户暂停、成员移除、账号停用、身份源变化、申请取消或版本变化，在下一次验证时拒绝。
- 门户账号授权版本持久化递增；即使“停用后恢复”发生在两次请求之间，旧准入也不会静默恢复。门户租户版本变化同样需要重新审核，包含成员变化或测试订阅变化。
- 受控HTTP响应在发送前再次核验准入；在等待数据期间撤权，不返回已准备的业务响应。此检查不能撤回已经完成的数据库写入或已发出的网络请求。
- 任务步骤恢复可信租户的IAM与语义上下文；执行前检查，完成后核对准入及IAM版本。撤权后的结果不作为成功回执采纳，后续依赖步骤停止。没有证明安全的业务Agent后台步骤直接拒绝。
- 配额是**按UTC自然日计算的已准入请求/巡检次数**，在运行库原子累计。失败的已准入请求不退额，重新审核不清空当天用量。它不是Token账单、模型成本扣费、支付收款或供应商对账。
- 门户库或身份源不可读时拒绝，不使用旧缓存放行。入口守卫不能替代连接器逐条数据授权、在途外部动作取消或源系统幂等/补偿。
- 桌面确认、领取与回执服务以及业务确认入口自身检查准入，直接服务调用不能绕过沙箱功能限制；领取指令返回前再次检查租户与设备策略，失败不交付。尚未提供已下发动作的远程撤回，也未关闭全部Worker撤权事项。详见[终端运行说明](../operations/DESKTOP_ENDPOINT_RUNTIME.md)。

## 客户中心操作

在“概览与开通”中，空间所有者/管理员先勾选确认，再提交“申请运行环境预检”。刷新查看检查结果，也可以取消申请后重新申请。普通成员仅看到联系管理员的提示，不返回申请明细。切换租户、状态变化或申请变化会重置确认，不能沿用上一空间的勾选。

运维仍使用原`--check-provisioning`检查命令。现有预检是**完整企业开通**门禁，不会因为只完成沙箱初始化便全部通过；正式业务身份、完整商业权益和全执行面撤权的生产验收仍阻断。

## 验证及剩余项

专项覆盖审核摘要、原子回滚、重复申请、账号停用/恢复、同名账号、配额竞争、会话版本和在途结果丢弃；另用真实SQLite进程运行CLI、并发累计及撤销，并验证门户源库字节不变。浏览器使用独立合成服务，不修改在用账号或门户库。具体数量见[多租户报告第15节](../development/MULTITENANT_VALIDATION.md#15-沙箱初始化运行准入与门户申请界面2026-09-17)。

仍待开发/验收：完整业务数据链的租户隔离、商业Token计量、全Worker撤权、企业资源自动部署与补偿、生产数据库RLS、真实企业SSO和支付验收。以上不能用当前沙箱能力勾选为已完成。
