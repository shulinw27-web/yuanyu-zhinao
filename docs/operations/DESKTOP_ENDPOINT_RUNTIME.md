# 元域智脑 Endpoint Runtime v0.1

## 目标

Endpoint Runtime 为桌面工具增加独立的在线、版本和设备证明。服务端只有在当前用户、会话和设备存在新鲜心跳且通过环境策略时，才会派发本机操作。门禁发生在一次性确认凭据消费之前，因此心跳中断不会导致用户确认失效。

## 本机证明

桌面应用首次启动时在 Electron `userData` 目录生成 Endpoint ID 和 Ed25519 密钥对。Electron 正式运行时通过 `safeStorage` 使用当前操作系统用户绑定加密保存私钥；Windows 对应 DPAPI。已有明文密钥文件会在首次可用启动时原位迁移，Endpoint ID 与公钥保持不变。私钥不通过 preload、Renderer、API 或日志暴露。若开发环境没有可用的系统安全存储，会明确报告为 `file_system`，不能因此获得生产信任。每次心跳都包含：

- `endpoint-runtime.v1` 协议版本；
- 持久 Endpoint ID；
- 应用版本、操作系统和打包状态；
- 私钥保护级别：`os_user_bound` 或 `file_system`；
- 服务端允许列表对应的端侧能力清单 SHA-256；
- 观测时间；
- Ed25519 公钥及固定字段载荷签名。

Renderer 只能请求主进程生成当前心跳，不能读取私钥或自定义签名字段。能力清单发生变化时，清单指纹会同步变化。

## 服务端策略

心跳按租户、主体、会话和设备隔离，默认 75 秒过期，桌面工作台每 30 秒更新一次。服务端验证严格字段 Schema、时钟偏差、Ed25519 签名、最低版本和环境信任策略。

| 环境 | 放行条件 |
| --- | --- |
| 开发/测试 | 已认证桌面身份、有效签名、新鲜心跳、版本不低于 `ZHINAO_MIN_ENDPOINT_VERSION` |
| 生产 | 开发环境全部条件 + 正式打包 + `os_user_bound` 私钥保护 + 公钥指纹位于 `ZHINAO_TRUSTED_ENDPOINT_KEYS` + 能力指纹位于 `ZHINAO_TRUSTED_ENDPOINT_MANIFESTS` |

生产端点未使用系统用户绑定加密、未登记公钥或能力指纹时只显示状态，不允许派发。DPAPI/safeStorage 解决磁盘明文和跨用户直接复制问题，但不是硬件不可导出密钥。高对抗生产场景仍应升级为 Windows TPM/CNG、macOS Secure Enclave 或企业 EDR 设备证书。

## 失败关闭

以下状态都会拒绝桌面派发，但不会消费确认凭据：心跳缺失、心跳过期、设备或会话不匹配、签名无效、时钟异常、版本过低、开发构建进入生产、生产密钥未受操作系统保护、未登记公钥、未登记能力清单。

接口：

- `POST /api/agent/desktop-endpoint/heartbeat`：登记签名心跳并返回服务器信任判断。
- `GET /api/agent/desktop-endpoint`：查看当前身份绑定的端点状态。
