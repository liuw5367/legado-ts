# 架构

本目录说明书源处理的分层边界，以及当前仓库中 source-core、source-node、reader-cli 与 reader-web 的协作方式。Android 调用关系作为标准侧行为事实保留；TypeScript 分层以代码现状为准，目标设计须标注状态。

- [目标与边界](goals-and-boundaries.md)：为什么做、范围是什么、包如何划分。
- [架构与调用关系](architecture.md)：分层、端口、统一流程与副作用边界。
- [reader-cli 应用架构](../../apps/reader-cli/docs/architecture.md)：终端 UI、本地存储和多源调度。
- [reader-web 应用架构](../../apps/reader-web/docs/architecture.md)：React、Hono、Repository 和用户数据隔离。

阅读完本目录后，按任务进入 [书源规则标准](../standard/README.md)、[处理流程](../flows/README.md) 或 [当前实现](../implementation/README.md)。
