# 处理流程

本目录描述书源处理的业务与数据流程。每篇流程文档都应明确输入、前置状态、请求和解析顺序、输出、失败与空结果、取消、资源清理以及最终提交边界；字段和规则语义引用 [参考规范](../reference/README.md)。

- [书源导入协议](import-protocol.md)：单个书源、数组、远程来源、JS 源和候选保存。
- [书源持久化流程](source-persistence-flow.md)：用户归属、保存事务、版本和删除副作用。
- [书源校验流程](source-check-flow.md)：域名、搜索、发现、详情、目录、正文校验及取消。
- [搜索流程](search-flow.md)：单源、多源搜索、并发、合并和取消。
- [书籍详情流程](book-info-flow.md)：详情请求、字段归一化、缓存和提交。
- [章节目录流程](chapter-list-flow.md)：目录分页、顺序、去重、刷新和回写。
- [章节正文流程](content-flow.md)：正文分页、格式化、缓存、批量和保存。
- [段评流程](review-flow.md)：结构化段评统计、详情分页、回复，旧式网页桥接和 JavaScript/声明式源差异。
- [发现流程与分类规则](explore-flow.md)：分类入口、发现列表和筛选状态。
- [与书源关联的媒体和交互流程](adjacent-source-flows.md)：媒体、解密、付费、事件和交互。
- [书源订阅与刷新](source-subscriptions.md)：订阅链接、多书源刷新、差异和确认。

典型调用会从导入或订阅开始，经搜索、详情、目录到正文；实际应用如何组织这些调用见 [package 使用指南](../guides/package-usage.md)。
