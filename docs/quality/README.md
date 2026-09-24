# 质量与验证

本目录记录“目前有什么证据、目标如何验收、哪些能力仍未验证”。它区分 Android 源码事实、TypeScript 目标契约、设计用例和真实执行结果，不能用文档覆盖率代替运行时兼容证明。

- [兼容性矩阵](compatibility-matrix.md)：能力、目标状态、Android 证据和 TypeScript 完成度。
- [一致性测试基线](conformance-tests.md)：fixture、用例、断言、验证层级和完成门槛。

测试用例应覆盖成功、空结果、错误、边界、取消、并发、缓存、提交和清理。新增能力先登记到 [能力清单](../standard/capability-inventory.md)，再在本目录定义证据和验收状态。
