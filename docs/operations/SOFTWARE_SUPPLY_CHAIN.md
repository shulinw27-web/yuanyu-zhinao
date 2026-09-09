# 软件供应链安全基线

> 版本：v1.0　更新日期：2026-09-01

仓库在 Pull Request、主分支推送和每周计划任务中执行依赖/Secret 门禁、CodeQL、SBOM/许可证检查、容器镜像和 IaC 扫描。`npm run security:gate` 对源码凭据模式、高危生产依赖漏洞及禁用许可证失败关闭；`npm run security:sbom` 输出 CycloneDX SBOM。

生产 API 使用 `deploy/Dockerfile.api` 多阶段构建，固定 Node 基础版本、仅安装生产依赖并以 `node` 非 root 用户运行。部署平台还应设置只读根文件系统、最小 Linux capabilities、seccomp、资源限额、网络策略和固定镜像 digest。

上线制品必须能关联源码提交、CI Run、SBOM、扫描报告、镜像 digest、签名/证明和发布单。未知许可证需要人工确认；高危/严重漏洞不得仅因“无修复版本”自动豁免，风险接受必须写明补偿措施与到期时间。
