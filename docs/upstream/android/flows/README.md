# Android 流程来源

这里集中保存 Android 书源处理流程的来源整理。每篇文档保留输入、前置条件、执行顺序、输出、空值、失败、取消和可观察副作用；字段和规则语义分别引用 [`Android 规则主题`](../rules/README.md)。

文中明确标记为 TypeScript、CLI、Web 或“目标设计”的段落只是迁移边界和证据索引，不能当作 Android 的实现事实，也不能当作当前 package API。当前 core 行为以 [`source-core 工作流`](../../../../packages/source-core/docs/workflows.md)、[`codec 与订阅`](../../../../packages/source-core/docs/codec-and-subscriptions.md) 为准；应用行为以 [reader-cli 实现](../../../../apps/reader-cli/docs/implementation.md) 和 [reader-web 实现](../../../../apps/reader-web/docs/implementation.md) 为准；差异和证据以 [`兼容性与验证`](../../../compatibility/README.md) 为准。

- [书源导入协议](import-protocol.md)
- [书源订阅与刷新](source-subscriptions.md)
- [书源检测流程](source-check-flow.md)
- [搜索流程](search-flow.md)
- [发现流程与分类规则](explore-flow.md)
- [书籍详情流程](book-info-flow.md)
- [章节目录流程](chapter-list-flow.md)
- [章节正文流程](content-flow.md)
- [段评流程](review-flow.md)
- [书源关联的媒体和交互流程](adjacent-source-flows.md)

流程来源和当前实现必须保持分层：Android 行为需要固定来源或测试支持；TypeScript 事实需要源码、导出和测试支持；尚未实现的统一接口只能放在 [`归档`](../../../archive/README.md)，不能从本目录的迁移注记推导为已实现能力。
