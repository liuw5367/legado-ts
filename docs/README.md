# Legado 书源运行时迁移文档

本文档体系记录当前 Legado Android/Kotlin 实现的可观察行为，并将这些行为整理为 TypeScript 独立库的实现契约。目标是完整登记书源能力，并为每项能力定义处理流程、宿主条件和验证依据。目标读者是实现或维护书源 package 的工程师。

当前交付阶段只生成和修订文档，不包含 TypeScript runtime、Node/Next.js adapter 或独立编辑器实现。文档中的“目标必须兼容”是待实现的验收承诺，只有在 Android 事实证据、脱敏 fixture、golden 输出和 TypeScript 自动断言都具备后，才能标记为已验证。

## 阅读顺序

按任务选择入口：实现 package 从 19 能力索引、02 字段、27 状态、04/05 语义到 21 实施路线；应用使用者从 18 调用契约、12 框架入口、29 部署边界开始；书源维护者从 03 导入、16 编辑、28 订阅、15 案例开始。每项事实只在所属主题定义，实施文档引用它。

1. [目标与边界](00-goals-and-boundaries.md)
2. [架构与职责映射](01-architecture.md)
3. [书源数据模型](02-source-schema.md)
4. [导入协议](03-import-protocol.md)
5. [规则语言与解析器](04-rule-language.md)
6. [URL 与请求规则](05-url-request-rules.md)
7. [搜索流程](06-search-flow.md)
8. [书籍详情流程](07-book-info-flow.md)
9. [章节目录流程](08-chapter-list-flow.md)
10. [章节正文流程](09-content-flow.md)
11. [JavaScript 书源](10-javascript-source.md)
12. [宿主接口](11-runtime-host-interfaces.md)
13. [Node、浏览器和 Next.js](12-node-browser-nextjs.md)
14. [兼容性矩阵](13-compatibility-matrix.md)
15. [迁移实施顺序](14-migration-guide.md)
16. [一致性测试基线](15-conformance-tests.md)
17. [书源编辑器规划](16-source-editor.md)
18. [发现流程与分类规则](17-explore-flow.md)
19. [独立 package 的调用契约](18-package-usage.md)
20. [书源能力清单与审核决策](19-capability-inventory.md)
21. [与书源关联的媒体和交互流程](20-adjacent-source-flows.md)
22. [实施总路线与阶段交付](21-implementation-roadmap.md)
23. [阶段 A：模型、导入与编辑基础](22-implement-codec-editor.md)
24. [阶段 B：规则引擎与请求计划](23-implement-rules-request.md)
25. [阶段 C：发现、搜索、详情、目录与正文](24-implement-workflows.md)
26. [阶段 D：批量、媒体与交互扩展](25-implement-extended-capabilities.md)
27. [阶段 E：应用接入、部署验证与 package 维护](26-implement-integration-verification.md)
28. [身份、状态与副作用](27-state-and-effects.md)
29. [订阅与刷新](28-source-subscriptions.md)
30. [运行边界与部署验收](29-runtime-security-and-deployment.md)
31. [package 维护与迁移证据](30-package-maintenance.md)

## 证据标记

- **现状行为**：可以从当前源码或已有测试直接核验。
- **兼容要求**：TypeScript 实现必须保持的行为，包括看起来不理想但已有书源依赖的历史语义。
- **目标设计**：为独立库、Node、浏览器和 SSR 增加的接口边界；它不能改变规则结果。
- **待验证**：当前源码已经显示出行为，但还没有足够 fixture 固化，迁移前必须补测试。

当前 Android 实现的主要事实源是 `app/src/main/java/io/legado/app/model/analyzeRule/` 和 `app/src/main/java/io/legado/app/model/webBook/`。`modules/web/` 是管理界面，不能替代运行时规则引擎。

当前文档已区分目标契约与源码证据，并提供具体案例设计，但没有生成 Android golden、实现 TS 或完成部署测试。扩展宿主逐重载、字体、动态登录及 JS 引擎部署仍有明确验收阻塞，见 [能力清单](19-capability-inventory.md#尚不能进入完整实现验收的项目)。不得将“文档覆盖”解释为“所有能力规格和兼容验证均完成”。
