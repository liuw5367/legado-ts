# 当前实现

本目录记录 TypeScript 仓库中已经存在的书源运行时入口、宿主契约和按主题整理的实现说明。公开 API 以 `packages/source-core/src/index.ts` 为准；与 [书源规则标准](../standard/README.md) 的不一致登记在 [已知差异](../divergence/known-divergences.md)。应用级实现分别在 [reader-cli](../../apps/reader-cli/docs/README.md) 和 [reader-web](../../apps/reader-web/docs/README.md)。

- [书源运行时状态总览](source-runtime-status.md)：未实现能力、已知差异和 Android/TypeScript 一致性验证的唯一状态入口。

## 入口与契约

- [package 使用指南](package-usage.md)：公开入口、调用方式与结果形状。
- [运行时统一契约](runtime-contracts.md)：请求计划、结果终态、副作用与错误命名。
- [宿主接口](runtime-host-interfaces.md)：核心与 Node 宿主之间的端口和错误契约。
- [字体映射与文字解码](font-decoding.md)：source-node 当前支持的字体解析和资源边界。

## 应用实现

- [reader-cli 架构](../../apps/reader-cli/docs/architecture.md)
- [reader-cli 实现方案](../../apps/reader-cli/docs/implementation.md)
- [reader-web 架构](../../apps/reader-web/docs/architecture.md)
- [reader-web 实现方案](../../apps/reader-web/docs/implementation.md)

fixture、兼容审计和测试证据见 [质量与验证](../quality/README.md)。未实现的通用管理、任务、编辑器和 Android 兼容目标见 [归档](../archive/README.md)，不能把历史目标当成当前 API。
