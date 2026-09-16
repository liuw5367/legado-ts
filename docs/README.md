# Legado 书源运行时迁移文档

本文档体系记录当前 Legado Android/Kotlin 实现的可观察行为，并将这些行为整理为 TypeScript 独立库的实现契约。目标读者是需要实现书源导入、规则解释、网络请求、搜索、详情、目录和正文流程的工程师。

当前交付阶段只生成和修订文档，不包含 TypeScript runtime、Node/Next.js adapter 或独立编辑器实现。文档中的“目标必须兼容”是待实现的验收承诺，只有在 Android 事实证据、脱敏 fixture、golden 输出和 TypeScript 自动断言都具备后，才能标记为已验证。

## 阅读顺序

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

## 证据标记

- **现状行为**：可以从当前源码或已有测试直接核验。
- **兼容要求**：TypeScript 实现必须保持的行为，包括看起来不理想但已有书源依赖的历史语义。
- **目标设计**：为独立库、Node、浏览器和 SSR 增加的接口边界；它不能改变规则结果。
- **待验证**：当前源码已经显示出行为，但还没有足够 fixture 固化，迁移前必须补测试。

当前 Android 实现的主要事实源是 `app/src/main/java/io/legado/app/model/analyzeRule/` 和 `app/src/main/java/io/legado/app/model/webBook/`。`modules/web/` 是管理界面，不能替代运行时规则引擎。
