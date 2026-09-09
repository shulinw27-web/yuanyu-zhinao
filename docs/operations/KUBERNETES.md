# Kubernetes 生产模板

部署文件位于 [deploy/k8s](../../deploy/k8s/)。它们是安全部署基线，不含真实地址或 Secret。发布流水线必须替换镜像 digest，创建受控 ConfigMap/Secret，并按企业网络清单补齐最小 egress；占位 digest 或空 egress 的模板不能直接发布。

API 默认三副本，非 root、只读根文件系统、禁用 ServiceAccount Token、丢弃 Linux capabilities，使用 RuntimeDefault seccomp，并配置资源限制、探针和 HPA。生产 PostgreSQL、Redis、Broker、Key Center、语义服务及 Worker 应分别使用独立清单和工作负载身份。
