# 软件供应链安全基线

> 版本：v1.1　更新日期：2026-10-11

仓库在 Pull Request、主分支推送和每周计划任务中执行依赖/Secret 门禁、CodeQL、SBOM/许可证检查、容器镜像和 IaC 扫描。`npm run security:gate` 对源码凭据模式、高危生产依赖漏洞、中等级及以上全依赖漏洞、桌面下载器兼容回归失败及禁用许可证失败关闭；`npm run security:sbom` 输出 CycloneDX SBOM。默认许可证扫描仍允许 UNKNOWN，不能代替人工确认；严格检查使用 `npm run security:licenses -- --registry --require-known`。

生产 API 使用 `deploy/Dockerfile.api` 多阶段构建，固定 Node 基础版本、仅安装生产依赖并以 `node` 非 root 用户运行。部署平台还应设置只读根文件系统、最小 Linux capabilities、seccomp、资源限额、网络策略和固定镜像 digest。

上线制品必须能关联源码提交、CI Run、SBOM、扫描报告、镜像 digest、签名/证明和发布单。未知许可证需要人工确认；高危/严重漏洞不得仅因“无修复版本”自动豁免，风险接受必须写明补偿措施与到期时间。

## 2026-10-11 开发依赖告警修复与验证

完整依赖审计此前有 8 项中等级告警，来自同一传递链：`app-builder-lib → @electron/get@3.1.0 → global-agent → roarr → sprintf-js@1.1.3`。这些是打包工具链告警，不是 8 个独立业务漏洞。上游 [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) 描述格式精度参数导致拒绝服务，检查时未列出修复版本。

根配置通过 `overrides` 固定 `@electron/get@5.1.0`，移除旧下载器依赖链，不屏蔽告警、不禁用校验和。运行时 Electron 原已使用该版本；锁文件中只有打包器的下载器从 3.1.0 变为 5.1.0，其余已有包版本未改。参考 [官方 5.1.0 发布记录](https://github.com/electron/get/releases/tag/v5.1.0)。该下载器要求 Node ≥22.12.0；本机验证为 Windows / Node 24.14.1。

| 验证 | 本轮结果 |
| --- | --- |
| 完整 `npm audit` | 0 漏洞，含开发依赖；只是本次注册表审计结果，不是系统无漏洞证明 |
| `test:electron-toolchain` | 2/2；实际打包器加载下载器 API、本机 HTTP 合成文件下载、SHA256 不匹配拒绝 |
| lint / typecheck / test:all | 均退出 0；其中本体专项 178/178，不把该数字当全仓总数 |
| 两端 `pack:electron` | 智脑、语义运营 Windows x64 目录包均成功 |
| `test:packaged-electron` | 2/2；隔离新用户目录启动、渲染挂载和未登录认证边界检查 |
| `security:gate` / `docs:check` | 均退出 0；文档 170 份、1345 个本地链接通过 |
| 许可证精确版本核对 | 清单548项；默认离线93项 UNKNOWN，经 `--registry --require-known` 核对后 UNKNOWN 0、禁用声明0；不是法律合规审定 |

新增下载器测试纳入 `test:nonfunctional` 和 `test:all`；原本独立的本地文档阅读器测试也纳入常规回归。`security:dev-audit` 和下载器测试进入安全门禁，防止只审计生产依赖而漏掉这类复发。

打包复验使用已有 `D:\wsl\cache\electron-builder` 工具缓存；默认缓存首次尝试出现网络下载失败，不能据此声称冷缓存 GitHub 下载或企业代理已验证。需要使用该机器缓存时，可在打包终端临时设置：

```powershell
$env:ELECTRON_BUILDER_CACHE = 'D:\wsl\cache\electron-builder'
npm run pack:electron
npm run pack:semantic-ops-electron
npm run test:packaged-electron
```

本轮未验证代理下载、其他 Node/操作系统矩阵、安装/升级/卸载、企业证书签名或生产发布；未重建便携及 NSIS 安装包。新版下载器的代理初始化依赖可选 `undici`，使用代理前需按上游文档配置并另行复验，不能假定旧 `global-agent` 配置直接等价。
