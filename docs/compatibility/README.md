# 兼容性与验证

本目录集中维护“当前实现了什么、与 Android 有哪些差异、证据是否执行”。它不定义书源字段或规则语义，也不替代 package 和应用文档。

## 唯一职责

| 文档 | 负责回答 |
| --- | --- |
| [状态总览](status.md) | 每项能力在 core、Node、CLI 或 Web 的实现程度和未满足条件 |
| [能力清单](capabilities.md) | 能力定义、优先级、Android 证据入口和审核边界 |
| [已知差异](known-divergences.md) | Android、项目契约和当前实现之间已核对的差异及策略 |
| [证据矩阵](evidence-matrix.md) | Android 来源、TypeScript 测试、fixture/golden 和执行状态的对应关系 |
| [一致性测试基线](conformance-tests.md) | fixture 结构、断言、验证层级和完成门槛 |
| [真实书源 fixture](source-fixtures.md) | 语料来源、脱敏、manifest 和离线/在线测试边界 |

状态总览只维护实现程度；能力清单不复制状态；差异登记不替代实现状态；证据矩阵不把源码存在误写成执行通过。`execution=not-run` 必须保留，Android 同输入 golden 未执行时不能称为跨端兼容。

上游 Android 页面、规则和流程来源见 [上游资料索引](../upstream/README.md)；当前 core 和 Node 的实现入口见 [当前实现](../implementation/README.md)、[source-core](../../packages/source-core/README.md) 和 [source-node](../../packages/source-node/README.md)。
