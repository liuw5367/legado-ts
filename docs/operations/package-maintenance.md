# package 维护与迁移证据

## 事实来源

Android 行为基线来自 `LegadoTeam/legado` 的本地提交 `32a87b253e7cc28273c3850de86242caac83f1fd`。核对日期 2026-09-16；当日工作区已有旧 docs 迁移与 .gitignore 等差异，文档不把这些差异视为已提交的上游行为。实现前须确认对应源码是否有本地补丁。

源码引用采用“仓库 + 提交 + 相对路径 + 符号/测试名”，行号只辅助定位。例如 [BookSourceImport.kt](https://github.com/LegadoTeam/legado/blob/32a87b253e7cc28273c3850de86242caac83f1fd/app/src/main/java/io/legado/app/ui/association/BookSourceImport.kt) 的 parseBookSourceJson。该提交当前仅存在于父仓库本地分支 `codex/docs-source-runtime`，尚未推送远端。若该提交未发布或远端不可达，以保留该 Git 对象的源码快照核验，不假设链接可公开访问。

子仓库应可独立使用：不能要求工程师从 `../app` 自动寻找事实源；交付 fixture 时记录其来源快照与生成方式。示例文件目前位于父仓库 examples，不是子仓库已附带的测试资产。

## 版本与发布

- 原始源格式兼容策略、package API 版本、规则语义版本分开记录。源的 lastUpdateTime 不能替代任何一种版本。
- 公开输入输出或错误码不兼容变化需要迁移说明；修正规则结果也必须列出受影响语法、旧输出、新输出和回归案例。
- 构建应验证公开导出、类型声明、服务端入口及浏览器静态入口；浏览器入口不能间接打包 Node 宿主或秘密配置。
- 发布前从安装后的产物调用公开 API，核验版本、包含文件、fixture 支持范围和许可证；仓库源码单测通过不能替代包产物检查。
- 实施期才增加真实构建与测试命令。目前 package.json 的 test 为失败占位，无发布产物，不能在文档声称 pnpm test 已通过。

## 上游变更与回归

每次升级基线，比较实体、AnalyzeRule/AnalyzeUrl、WebBook、JS 引擎与宿主 API、编辑入口及测试。按能力 ID 标记新增、变化和移除；先保留旧案例，再加入新基线案例。改变基线不自动接受所有上游行为，也不静默删除原有能力。

回归处理顺序：收集脱敏最小源与输入 → 固定版本和操作 → 重现差异 → 判断源码事实或 Web 策略 → 增加具体断言 → 修复对应层 → 运行受影响组合测试 → 更新矩阵。失败站点不是规则引擎缺陷的充分证据。

每次能力或契约变更都记录以下维护条目：

| 字段 | 内容 |
| --- | --- |
| `capabilityId` | 受影响的 CAP/FLOW/API/DEP ID |
| `baseline` | Android 提交、TypeScript 文档版本和 fixture 基线 |
| `changeKind` | `behavior-fix`、`compatibility`、`design`、`host` 或 `breaking` |
| `evidence` | 源码符号、测试名、fixture/golden ID 和行号 |
| `verification` | `not-run`、`passed`、`failed`、`blocked` 及阻塞原因 |
| `rollback` | 旧语义、旧缓存命名空间和应用回退方式 |

未运行的案例必须标记 `execution=not-run`；能力清单中的“已登记”不能替代实现或执行证据。

## 来源和许可记录

父仓库 LICENSE 为 GNU GPL v3 文本。复制、翻译或改写代码、复用测试与文档材料时逐项记录来源、许可证和修改；发布前核查 package 许可证与分发要求，不能因改写为 TypeScript 就自行标成无来源的宽松许可。本章记录项目事实，不给出具体分发方式的法律结论。

第三方解析器、脚本引擎、字体/压缩库、fixture 页面与图片也须记录来源。真实账号、访问令牌、私有书源正文与有使用限制的样本不直接进入公开 fixture。

## 回退

应用可回退上一已验证 package 与语义版本；缓存使用版本命名空间，旧版不得读取不兼容的新结果。源原文和未知字段保持保留，回退不自动重写源配置。若未来状态 schema 变化，先定义旧版可读范围与迁移回退路径，再发布。

维护验收包括：公开产物导入、旧源 round-trip、既有 verified 案例、兼容矩阵变化、实际目标宿主验证，以及回退后读取旧版本缓存。运行结果随发布记录保存，不把本章设计清单当作通过证明。
