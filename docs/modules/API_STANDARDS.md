# API 设计与协作标准

## 1. 基本约定

- 当前基地址：`http://<host>:3001/api`；生产环境由网关提供同源 `/api`。
- JSON 使用 UTF-8，时间使用 ISO 8601 UTC，ID 是不透明字符串。
- 读取使用 `GET`，有副作用的操作使用 `POST`；新增资源成功优先返回 `201`。
- 当前兼容期保留既有路径；目标契约使用复数资源名和明确动作子资源。
- 客户端必须发送稳定设备 ID；智脑客户端还发送平台与版本头。

## 2. 认证与授权

受保护请求优先使用统一身份会话头（兼容 `x-identity-session` 与 `x-oa-session`），也支持经企业 OIDC 验证的 `Authorization: Bearer <token>`。两者存在时会话优先；`x-demo-role` 只允许非生产演示，不是生产认证方案。客户端不得同时发送 Bearer 与 Demo 角色头，也不得从 JWT 自行推导平台权限。

授权顺序：认证 → 租户/主体 → 页面权限 → 按钮/API 权限 → 组织数据域 → 业务门禁 → 工作流/确认。前端显示与禁用不构成安全边界。

## 3. 标准响应

成功响应返回资源或结果对象。列表目标格式：

```json
{
  "items": [],
  "page": { "cursor": null, "nextCursor": null, "limit": 50 },
  "requestId": "request-id"
}
```

错误格式：

```json
{
  "message": "用户可理解的信息",
  "code": "STABLE_MACHINE_CODE",
  "requestId": "request-id",
  "details": {}
}
```

当前部分旧接口仍返回 `{ error }`，迁移时必须同时保留 `message`，SDK 只应依赖 `message/code`。

## 4. 状态码

| 状态 | 含义 |
| --- | --- |
| 200/201 | 成功 |
| 400 | Schema 或业务输入错误 |
| 401 | 未认证、会话失效、设备不匹配 |
| 403 | 页面、按钮、数据域或业务权限拒绝 |
| 404 | 资源不存在或为防泄露而不可见 |
| 409 | `expectedVersion` 冲突、幂等冲突 |
| 413 | 请求体或附件超限 |
| 429 | 限流 |
| 500/503 | 内部错误或依赖不可用 |

## 5. 并发与幂等

- 可编辑策略必须携带 `expectedVersion`，冲突返回 `409 VERSION_CONFLICT`。
- 写操作目标增加 `Idempotency-Key`；服务端按 `tenant + subject + operation` 去重。
- Agent 命令继续使用 run、command、一次性 confirmation token 的强绑定，不以普通幂等键代替安全确认。

## 6. 分页、过滤和数据域

新增列表不得无界返回。分页和过滤在服务端执行，任何 `organizationId` 过滤条件都必须与当前有效 `allowedOrgIds` 求交，不能由客户端扩大范围。

## 7. 契约单一事实源

已新增 `packages/api-contracts`，当前包含共享错误码、Agent 新旧请求体规范化和覆盖 30 个核心操作的 `openapi.yaml`；契约测试会解析 YAML、检查 operationId 唯一性与关键权限扩展字段。目标结构继续扩展为：

```text
openapi.yaml
schemas/*.json
errors.json
events/*.json
generated/admin-client.d.ts
generated/agent-client.d.ts
```

CI 应检查 OpenAPI、SDK 和路由实现一致；每个模块至少包含成功、认证失败、权限失败、Schema 失败和版本冲突契约测试。

## 8. 事件契约

领域事件至少包含：

```json
{
  "eventId": "uuid",
  "type": "risk.case.raised",
  "version": 1,
  "tenantId": "tenant",
  "organizationId": "org",
  "occurredAt": "2026-08-21T00:00:00.000Z",
  "correlationId": "request-or-trace-id",
  "payload": {}
}
```

事件消费者必须幂等；事件只表达已发生事实，不允许消费者根据事件自行扩大权限。
