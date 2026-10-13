# 书源处理文档库

这里记录 Legado TS 的共享书源规则、TypeScript 实现、Android 对照、处理流程、质量证据和运行边界。根目录 [README](../README.md) 负责项目介绍和最短启动路径；本目录负责需要反复查阅的技术事实。

仓库已包含四个可运行单元：`packages/source-core`（平台无关核心）、`packages/source-node`（Node 宿主）、`apps/reader-cli`（交互式终端阅读器）和 `apps/reader-web`（React + Hono Web 应用）。文档中的“目标必须兼容”是验收承诺；只有同时具备 Android 事实证据、脱敏 fixture、golden 输出和 TypeScript 自动断言，才能标记为已验证。

## 仓库实现现状

| 单元 | 说明 |
| --- | --- |
| [`packages/source-core`](../packages/source-core) | 书源导入/导出、规则编译与求值、请求计划、发现/搜索/详情/目录/正文流程；零运行时依赖，宿主能力经端口注入 |
| [`packages/source-node`](../packages/source-node) | HTTP、Cookie、字符集、解析器、QuickJS、字体、归档、并发与兼容性 CLI 等 Node 宿主实现 |
| [`apps/reader-cli`](../apps/reader-cli) | `legado-reader` 交互式 CLI：书源加载、搜索、详情、目录、正文、书架、本地阅读状态和书源管理/检测 |
| [`apps/reader-web`](../apps/reader-web) | React Router SPA、Hono API、Supabase Auth 和 Postgres/Drizzle 阅读应用：书源管理、搜索、来源版本、目录、正文、书架和阅读位置 |

应用自身文档分别在 [`reader-cli docs`](../apps/reader-cli/docs/README.md) 和 [`reader-web docs`](../apps/reader-web/docs/README.md)，本库只维护共享规则、流程、质量和运行边界。

## 按任务进入

| 任务 | 推荐路线 |
| --- | --- |
| 使用终端阅读器 | [CLI README](../apps/reader-cli/README.md) → [CLI 文档](../apps/reader-cli/docs/README.md) |
| 使用 Web 阅读器 | [Web README](../apps/reader-web/README.md) → [开发与部署](../apps/reader-web/docs/development-and-deployment.md) |
| 集成共享运行时 | [source-core 文档](../packages/source-core/README.md) → [跨包与应用接入](implementation/package-usage.md) → [运行边界](operations/runtime-security-and-deployment.md) |
| 理解整体边界 | [架构](architecture/README.md) → [书源规则标准](standard/README.md) |
| 实现或修改书源 package | [书源规则标准](standard/README.md) → [处理流程](flows/README.md) → [当前实现](implementation/README.md) → [兼容性与验证](compatibility/README.md) |
| 查看书源运行时状态 | [状态总览](compatibility/status.md) |
| 导入、编辑或刷新书源 | [导入流程](flows/import-protocol.md) → [订阅流程](flows/source-subscriptions.md) |
| 对照 Android 页面行为 | [Android 功能对照](upstream/android/README.md) |
| 审查兼容性和发布 | [能力清单](compatibility/capabilities.md) → [测试基线](compatibility/conformance-tests.md) → [证据矩阵](compatibility/evidence-matrix.md) → [维护文档](operations/package-maintenance.md) |
| 查阅未实现的历史设计 | [归档](archive/README.md) |
| 查看后续待办 | [后续待办事项](pending-work.md) |
| 查阅上游与外部教程 | [上游资料索引](upstream/README.md) |

## 文档分类

| 分类 | 负责回答的问题 | 入口 |
| --- | --- | --- |
| `standard` | 书源规则与 Android 行为标准是什么 | [书源规则标准](standard/README.md) |
| `upstream` | Android 页面、规则来源和外部教程是什么 | [上游资料索引](upstream/README.md) |
| `architecture` | 各层怎样划分、当前仓库怎样协作 | [架构](architecture/README.md) |
| `flows` | 书源处理按什么顺序运行、怎样提交结果 | [处理流程](flows/README.md) |
| `implementation` | 当前 TypeScript 实现的入口、契约与阶段记录是什么 | [当前实现](implementation/README.md) |
| `compatibility` | 标准与实现有哪些差异、证据怎样验证、何时算完成 | [兼容性与验证](compatibility/README.md) |
| `operations` | 怎样处理安全、部署、发布、版本和回退 | [运维与维护](operations/README.md) |
| `archive` | 哪些目标尚未实现或已被现状取代 | [归档](archive/README.md) |

分类按读者要解决的问题确定。主题交叉时只保留一个事实来源：Android 页面和外部教程属于 `upstream`，规则语义属于 `standard`，搜索如何调用规则属于 `flows`，当前代码入口属于 `implementation`，不一致处登记在 `compatibility`，证据与执行状态也属于 `compatibility`。分类 README 只做导航和边界说明，不复制长篇契约。

## 正文完整性规则

核心标准、流程和实现文档必须在正文中写出理解当前主题所需的最小契约：输入字段及所有权、处理顺序、输出结构、合法空结果、状态变化、错误、取消、超时、清理和提交边界。引用源码、测试或其他文档时，引用只承担以下职责：

- 说明 Android 事实、版本差异或证据位置；
- 提供对比实现、测试定位和排查入口；
- 链接到一个已经在当前主题中以最小结构说明过的共享事实源。

读者不打开引用目标时，也必须能够完成当前主题的实现或审查。目录 README 只负责导航；质量文档可以以证据索引为主，但 fixture 和断言仍须定义本地最小结构。

不同层的结果不能混用：source-core 工作流使用 `success`、合法空结果 `empty`、`partial`、`failed`、`cancelled` 和 `capability-missing`；应用或存储提交可以另外报告 `stale`、`unknown`、`storage-error` 等状态。具体领域可以增加阶段状态，但必须说明它与所属层结果的映射。

## 文档状态

- **源码事实**：可以从当前源码或已有测试核验的行为。
- **兼容要求**：TypeScript 实现必须保持的行为，包括已有书源依赖的历史语义。
- **目标设计**：为独立库、Node、浏览器或 SSR 增加的边界，不能改变规则结果。
- **待验证**：已经发现行为或提出目标，但还没有足够 fixture 和执行证据。
- **实施计划**：实现顺序、依赖和验收门槛，不代表功能已经存在。
- **验证记录**：测试、部署或发布实际执行后的结果和限制。

状态可以在同一篇文档中并存；运行能力的实现程度以[兼容性状态总览](compatibility/status.md)为准，兼容差异以[兼容性与验证](compatibility/README.md)为准，fixture 的执行字段以兼容性目录和机器清单为准。详细行为仍分别见对应主题文档。

## 事实来源规则

字段和默认值以 [书源数据模型](standard/source-schema.md) 为准；字段所有权以 [字段所有权与合并规则](standard/source-field-ownership.md) 为准；实体边界以 [书源相关实体边界](standard/artifact-model.md) 为准；规则语义以 [规则语言](standard/rule-language.md) 为准；请求行为以 [URL 与请求规则](standard/url-request-rules.md) 为准；身份、版本和提交以 [状态与副作用](standard/state-and-effects.md) 为准；当前代码入口以 [source-core 文档](../packages/source-core/README.md)、[跨包与应用接入](implementation/package-usage.md) 与 `packages/source-core/src/index.ts` 为准。流程和实现文档引用这些事实，不另建同名定义。

Android 上游仓库、两个基线提交及其用途见 [上游资料索引](upstream/README.md)；取证策略与长期基线维护见 [package 维护与迁移证据](operations/package-maintenance.md)。当前 Android 主要事实源是 `app/src/main/java/io/legado/app/model/analyzeRule/`、`app/src/main/java/io/legado/app/model/webBook/`、`app/src/main/java/io/legado/app/data/entities/` 和相关测试。`modules/web/` 是管理界面，不能替代运行时规则引擎。

当前文档已登记主要书源能力和处理流程，且仓库已有 source-core / source-node / reader-cli 实现与自动测试；扩展宿主逐重载、动态登录及部分能力仍有验收阻塞，见 [能力清单](compatibility/capabilities.md#尚不能进入完整实现验收的项目)。不得将“文档覆盖”或“存在实现”解释为“所有能力规格和兼容验证均完成”。

## 新增文档规则

新增文档时先判断它主要回答哪个问题，再放入唯一的主分类：上游 Android 页面、规则来源和外部教程放 `upstream`，稳定规则与字段语义放 `standard`，完整处理顺序放 `flows`，当前代码契约与阶段记录放 `implementation`，标准与实现的不一致以及验证证据放 `compatibility`，运行维护放 `operations`，架构协作放 `architecture`。未实现目标或已被现状取代的历史文档放 `archive`，当前待办放在 `docs/pending-work.md`，不要把它放入历史归档。新增教程、ADR 或运行手册时保留其文档类型，并从总 README 或分类 README 增加入口；不要为了凑编号把不同类型的内容放在一起。
