# 当前实现

本目录记录跨应用的实现事实和迁移中的接入说明。source-core 的当前契约已经迁移到 [`@legado/source-core`](../../packages/source-core/README.md)；与 [书源规则标准](../standard/README.md) 的不一致登记在 [兼容性与验证](../compatibility/README.md)。应用级实现分别在 [reader-cli](../../apps/reader-cli/docs/README.md) 和 [reader-web](../../apps/reader-web/docs/README.md)。

- [@legado/source-core](../../packages/source-core/README.md)：当前导出、结果、宿主端口、codec、规则和工作流文档。
- [兼容性与验证](../compatibility/README.md)：未实现能力、已知差异和 Android/TypeScript 一致性证据的现行入口。

## 入口与契约

- [跨包与应用接入](package-usage.md)：迁移期间保留的 Node 集成、应用边界和接入维护约定。
- [字体映射与文字解码](font-decoding.md)：source-node 当前支持的字体解析和资源边界。

## 应用实现

- [reader-cli 架构](../../apps/reader-cli/docs/architecture.md)
- [reader-cli 实现方案](../../apps/reader-cli/docs/implementation.md)
- [reader-web 架构](../../apps/reader-web/docs/architecture.md)
- [reader-web 实现方案](../../apps/reader-web/docs/implementation.md)

fixture、兼容审计和测试证据见 [兼容性与验证](../compatibility/README.md)。未实现的通用管理、任务、编辑器和统一接口目标见 [归档](../archive/README.md)，不能把历史目标当成当前 API。
