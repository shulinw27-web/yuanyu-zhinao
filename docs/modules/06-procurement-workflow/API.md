# 采购协同 API

| 方法 | 路径 | 权限/说明 |
| --- | --- | --- |
| GET | `/api/procurement/scenario` | `page.agent.view`，当前 Demo 场景 |
| POST | `/api/procurement/launch` | `procurement.launch`；申请 `create_procurement_draft` 租约 |
| POST | `/api/procurement/approve` | `procurement.approve`；申请 `approve_procurement` 租约 |

当前 POST 不接收业务 body，使用 Demo 场景状态。目标契约：

```json
{
  "requestId": "business-request-id",
  "items": [{ "materialId": "material-id", "quantity": 100, "unit": "kg" }],
  "supplierId": "supplier-id",
  "organizationId": "org-id",
  "reason": "风险补货",
  "expectedVersion": 2
}
```

返回 `procurementId`、`status`、`mode`、`connectorReceipt`、`evidenceRefs`、`version`。错误码：`CORE_OBJECT_BINDING_INVALID`、`PROCUREMENT_PERMISSION_DENIED`、`KEY_LEASE_DENIED`、`VERSION_CONFLICT`、`CONNECTOR_UNAVAILABLE`。
