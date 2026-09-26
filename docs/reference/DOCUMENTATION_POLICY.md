# 文档维护规则

## 唯一存放位置

正式项目文档全部放 `docs/`；根目录 `README.md` 只作入口。服务、部署、脚本目录放实现文件，不再各自维护同内容的说明。第三方依赖自带的 README/许可证不属于项目文档，不移动、不删除。

- `overview`：全局状态和交接，只写概要并链接依据。
- `architecture`：跨模块架构、协议和安全边界。
- `modules`：各模块需求、API、数据归属和实现约束，不将有价值的模块契约视为重复资料删除。
- `development`：开发启动、联调准备、测试及近期路线。
- `operations`：部署、运行、故障处理与生产 Checklist。
- `guides`：面向用户的操作步骤。
- `reference/exports`：Word/PPT 等交付快照。
- `archive`：仍需追溯的历史验收记录，不堆放截图缓存和每次渲染中间稿。

## 内容与版本

1. 可持续维护的技术说明优先使用 Markdown，文件名稳定，日期写在正文，不按每天复制一份。
2. 当前状态由 `overview/PROJECT_STATUS.md` 导航，生产勾选项由 `operations/PRODUCTION_TODO_CHECKLIST.md` 维护，其他文档链接过去。
3. 区分“当前实现”“设计目标”“外部待验收”，不把 Mock 通过描述成真实接入或生产完成。
4. 只有代码、相关测试和文档证据齐全才更新完成状态。测试数量注明日期，不跨版本复用旧数字。
5. 可编辑源稿与 Word 快照用途不同，允许各保留一份；被明确替代的旧版和无用途的渲染缓存应移出项目。
6. 移动文件要更新链接、生成脚本和索引；不要留下仅用于旧路径兼容的文档副本。

## 文档生成

生成脚本统一放 [scripts/docs](../../scripts/docs/)，使用单独文档环境运行 `python -m pip install -r scripts/docs/requirements.txt`，不加入业务 Node 依赖；也可使用已提供 `python-docx` 的文档专用运行时。脚本输出统一为 `docs/reference/exports/`；执行前确认是否会覆盖已有交付文件。

| 生成器 | 来源或用途 |
| --- | --- |
| `build_zhinao_docs.py` | Agent 架构、智脑多端使用说明的 Markdown 转 Word |
| `build_semantic_ops_guide_doc.py` | 元域智语指南 Markdown 转 Word，复用 `word_helpers.py` |
| `build_platform_introduction_doc.py` | 平台介绍 Markdown 转 Word |
| `build_semantic_test_data_dictionary_docx.py` | 可复现模拟系统的数据字典 |
| 其他 `build_*_doc.py` / `build_deployment_guide.py` | 特定版本交付内容的生成源；重新使用前核对当前实现 |

本次整理迁移了已有 Word/PPT 并修正生成器路径；其中平台介绍 Word 因定位和现状过期而同步修订，完成渲染与版式检查，其余交付快照未重排。以后重新交付 Word/PPT 时，应重新生成、渲染并目视检查，不能只以保存成功为验收。

## 自动检查与清理边界

运行 `npm run docs:check`，检查本地 Markdown 文件链接、文档是否散落到源码目录、文档目录是否混入构建缓存。检查不访问外网、不验证远程 URL 或 Markdown 内的章节锚点，也不代替技术内容审查。

`output/` 存放可再生的检查报告；缓存、日志、临时截图不进入正式文档目录。运行数据库、虚拟环境、模型权重、安装包、用户产物不能仅凭“日期旧”删除。无 Git 或不能判断用途时，先保存项目外恢复备份，再清理。
