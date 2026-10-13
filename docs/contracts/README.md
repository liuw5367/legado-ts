# 项目兼容契约

本目录只记录跨 package、跨应用必须共同遵守的政策，不复制 `BookSource` 字段、规则语法、请求默认值或数据库 schema。上游 Android 字段和流程见 [`docs/upstream/android`](../upstream/android/README.md)；当前 core/node API 见各自 package 文档；未实现的统一接口见 [`docs/archive`](../archive/README.md)。

- [兼容政策](compatibility-policy.md)：兼容对象、证据等级、允许差异、能力缺失和变更门槛。
- [兼容性与验证](../compatibility/README.md)：实现状态、差异登记、fixture 和执行证据。
- [source-core](../../packages/source-core/README.md) 与 [source-node](../../packages/source-node/README.md)：当前代码事实和公开入口。

政策文档不能覆盖源码事实：源码和测试说明“现在做什么”，上游快照说明“Android 做什么”，兼容政策说明“本项目接受什么边界”。三者冲突时进入兼容性差异登记，不在本目录偷偷修改某一方。
