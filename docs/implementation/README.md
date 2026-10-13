# 当前实现

本目录记录跨应用的实现导航。source-core 和 source-node 的当前实现分别维护在各自 package；与 [Android 规则来源](../upstream/android/rules/README.md) 的不一致登记在 [兼容政策](../contracts/compatibility-policy.md) 和 [兼容性与验证](../compatibility/README.md)。应用级实现分别在 [reader-cli](../../apps/reader-cli/docs/README.md) 和 [reader-web](../../apps/reader-web/docs/README.md)。

- [@legado/source-core](../../packages/source-core/README.md)：当前导出、结果、宿主端口、codec、规则和工作流文档。
- [@legado/source-node](../../packages/source-node/README.md)：Node session、宿主装配、安全限制、字体和兼容性审计。
- [兼容性与验证](../compatibility/README.md)：未实现能力、已知差异和 Android/TypeScript 一致性证据的现行入口。

跨包接入从 [source-core](../../packages/source-core/README.md) 和 [source-node](../../packages/source-node/README.md) 开始；应用的用户范围、持久化和交互责任只在各自 docs 中维护。

## 应用实现

- [reader-cli 架构](../../apps/reader-cli/docs/architecture.md)
- [reader-cli 实现方案](../../apps/reader-cli/docs/implementation.md)
- [reader-web 架构](../../apps/reader-web/docs/architecture.md)
- [reader-web 实现方案](../../apps/reader-web/docs/implementation.md)

fixture、兼容审计和测试证据见 [兼容性与验证](../compatibility/README.md)。未实现的通用管理、任务、编辑器和统一接口目标见 [归档](../archive/README.md)，不能把历史目标当成当前 API。
