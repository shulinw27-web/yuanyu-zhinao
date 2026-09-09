# 智脑桌面工作台执行协议 v0.1

## 当前范围

当前开放六个 L1 工具：`desktop.artifact.create_text` 新建 Markdown、文本或 CSV；`desktop.artifact.create_docx` 新建 Word 草稿；`desktop.artifact.create_xlsx` 新建 Excel 工作簿；`desktop.browser.open_https` 打开无内嵌凭据的 HTTPS 地址；`desktop.workspace.read_text` 读取专属工作区内不超过 512 KiB 的 Markdown/TXT/CSV；`desktop.clipboard.write_text` 把智脑输出写入剪贴板但不读取原剪贴板。本地产物会解析用户在自然语言中指定的桌面、文档或下载位置，并写入对应位置下的“元域智脑工作区”；未指定位置时默认桌面。六个工具都必须经过本人确认；不允许覆盖文件、传入绝对路径、使用子目录跳转、读取链接文件、访问其他目录、非 HTTPS 协议、发送邮件、提交表单或删除文件。

桌面端右侧“本机工作区”显示端侧执行器状态与最近 5 个受控产物。列表只读取文件名、扩展名、大小和修改时间，不读取文件正文；用户点击后由操作系统打开该产物。

## 执行链

```text
用户自然语言目标
  -> Agent 安全校验与本地工具规划
  -> 服务端持久化 Run 和一次性确认令牌
  -> 用户本人确认（绑定 tenant/subject/session/device）
  -> Endpoint Runtime 新鲜心跳、Ed25519 签名、系统用户绑定密钥保护、最低版本和环境信任校验
  -> 用户确认只创建持久化长任务；排队阶段可暂停、恢复或取消
  -> 当前设备 Worker 原子领取任务，创建不可重复领取的执行租约
  -> 服务端生成两分钟有效的 desktop-execution.v1 派发
  -> Electron 主进程重新校验工具、风险、路径、大小和过期时间
  -> 在专属工作区使用排他创建方式写入文件
  -> Electron 返回相对路径、字节数和 SHA-256
  -> 服务端绑定派发 ID 和身份接收回执
  -> Run 与 Evidence Trace 完成闭环
  -> 仅在用户已开启学习授权时生成最小化成功工作流信号
```

Renderer 不能访问 Node.js、文件系统或工作区绝对路径。`contextIsolation=true`、`nodeIntegration=false` 和 `sandbox=true` 保持不变；唯一端侧能力通过受信任 preload IPC 暴露，Electron 主进程拥有独立的严格允许列表。

## 风险策略

| 等级 | 当前策略 | 示例 |
| --- | --- | --- |
| L0 | 已用于工作台本地产物索引，不读取正文 | 列出智脑工作区产物 |
| L1 | 已开放六个工具；本人确认、严格输入约束 | 新建文档/表格、打开 HTTPS、读取专属工作区文本、写入剪贴板 |
| L2 | 默认关闭 | 发邮件、上传、提交表单 |
| L3 | 明确禁止 | 删除本地文件、支付、签署 |

## 协议对象

- 服务端派发：`protocolVersion`、`dispatchId`、`runId`、`toolId`、严格 `input`、`riskLevel`、`workspaceScope`、`expiresAt`。
- 端侧回执：`status`、`dispatchId`、`toolId`、相对路径、字节数、SHA-256、完成时间；失败只返回清洗后的错误，不返回本机绝对路径或文件内容。
- `dispatchId` 必须与原 Run 中的端侧动作一致；回执继续绑定原角色、租户、主体、会话和设备。

## 下一步

1. 当前已使用 Electron safeStorage/Windows DPAPI 消除磁盘明文；下一步迁移到不可导出的 TPM/CNG、Secure Enclave 或企业设备证书，并接入正式代码签名校验。
2. 增加 Word/Excel 模板选择、公式约束和更丰富的表格语义，但仍以新建草稿为边界。
3. 已完成持久化长任务队列、当前设备执行 Worker、独立超时回收 Worker、单活租约和运维指标告警；生产下一步把维护租约迁移到 PostgreSQL，并接入 Prometheus/SIEM 告警通道。
4. L2 工具必须增加 step-up/MFA；正式发送、提交和业务写入仍由现有审批链处理。
