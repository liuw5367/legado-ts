# 书源处理文档库

本目录是 Legado 书源运行时迁移的文档库，记录 Android/Kotlin 的可观察行为、TypeScript 独立 package 的目标契约、处理流程、应用接入方式、实施计划和验证要求。文档库面向实现、维护、集成和审查人员；它不是单一的 API 说明，也不是已经完成的 runtime。

当前仍只维护文档，不包含 TypeScript runtime、Node/Next.js adapter 或独立编辑器实现。文档中的“目标必须兼容”是后续验收承诺，只有同时具备 Android 事实证据、脱敏 fixture、golden 输出和 TypeScript 自动断言，才能标记为已验证。

## 按任务进入

| 任务 | 推荐路线 |
| --- | --- |
| 理解整体边界 | [概览](overview/README.md) → [参考规范](reference/README.md) |
| 实现书源 package | [参考规范](reference/README.md) → [处理流程](workflows/README.md) → [实施方案](implementation/README.md) |
| 组织应用调用 | [package 使用指南](guides/package-usage.md) → [API 适配](integration/legado-web-api-bridge.md) → [框架接入](guides/node-browser-nextjs.md) → [运行边界](operations/runtime-security-and-deployment.md) |
| 编辑、导入或刷新书源 | [导入流程](workflows/import-protocol.md) → [编辑指南](guides/source-editor.md) → [订阅流程](workflows/source-subscriptions.md) |
| 审查兼容性和发布 | [能力清单](reference/capability-inventory.md) → [测试基线](quality/conformance-tests.md) → [兼容矩阵](quality/compatibility-matrix.md) → [维护文档](operations/package-maintenance.md) |

## 文档分类

| 分类 | 负责回答的问题 | 入口 |
| --- | --- | --- |
| `overview` | 为什么做、范围是什么、各层怎样协作 | [概览](overview/README.md) |
| `reference` | 字段、规则、接口和状态语义是什么 | [参考规范](reference/README.md) |
| `workflows` | 书源处理按什么顺序运行、怎样提交结果 | [处理流程](workflows/README.md) |
| `guides` | 调用方怎样使用 package、编辑书源和接入 Web | [使用指南](guides/README.md) |
| `integration` | 原 Android/Web API 如何映射到独立 package 和应用服务 | [集成文档](integration/README.md) |
| `quality` | 有哪些证据、怎样测试、何时算完成 | [质量与验证](quality/README.md) |
| `implementation` | 按什么依赖和阶段实施 | [实施方案](implementation/README.md) |
| `operations` | 怎样处理安全、部署、发布、版本和回退 | [运维与维护](operations/README.md) |

分类按读者要解决的问题确定。主题交叉时只保留一个事实来源：规则语义属于 `reference`，搜索如何调用规则属于 `workflows`，如何实现规则引擎属于 `implementation`。分类 README 只做导航和边界说明，不复制长篇契约。

## 文档状态

- **源码事实**：可以从当前源码或已有测试核验的行为。
- **兼容要求**：TypeScript 实现必须保持的行为，包括已有书源依赖的历史语义。
- **目标设计**：为独立库、Node、浏览器或 SSR 增加的边界，不能改变规则结果。
- **待验证**：已经发现行为或提出目标，但还没有足够 fixture 和执行证据。
- **实施计划**：实现顺序、依赖和验收门槛，不代表功能已经存在。
- **验证记录**：测试、部署或发布实际执行后的结果和限制。

状态可以在同一篇文档中并存，阅读时以正文标注和 [质量与验证](quality/README.md) 为准。

## 事实来源规则

字段和默认值以 [书源数据模型](reference/source-schema.md) 为准；字段所有权以[字段所有权与合并规则](reference/source-field-ownership.md)为准；实体边界以[书源相关实体边界](reference/artifact-model.md)为准；规则语义以 [规则语言](reference/rule-language.md) 为准；请求行为以 [URL 与请求规则](reference/url-request-rules.md) 和[运行时统一契约](reference/runtime-contracts.md)为准；身份、版本和提交以 [状态与副作用](reference/state-and-effects.md) 为准。流程、指南和实施文档引用这些事实，不另建同名定义。

当前 Android 主要事实源是 `app/src/main/java/io/legado/app/model/analyzeRule/`、`app/src/main/java/io/legado/app/model/webBook/`、`app/src/main/java/io/legado/app/data/entities/` 和相关测试。`modules/web/` 是管理界面，不能替代运行时规则引擎。

当前文档已经登记主要书源能力和处理流程，但没有生成 Android golden、实现 TS 或完成部署测试。扩展宿主逐重载、字体、动态登录及 JS 引擎部署仍有验收阻塞，见 [能力清单](reference/capability-inventory.md#尚不能进入完整实现验收的项目)。不得将“文档覆盖”解释为“所有能力规格和兼容验证均完成”。

## 新增文档规则

新增文档时先判断它主要回答哪个问题，再放入唯一的主分类：稳定契约放 `reference`，完整处理顺序放 `workflows`，调用方法放 `guides`，证据放 `quality`，实施拆解放 `implementation`，运行维护放 `operations`。Android API、Supabase 和框架适配放入 `integration` 或 `operations`，不要写入核心规则规范。新增教程、ADR 或运行手册时保留其文档类型，并从总 README 或分类 README 增加入口；不要为了凑编号把不同类型的内容放在一起。
