# reader-cli 文档

这里记录命令行阅读器的当前实现。共享书源规则、运行时入口和兼容性证据在仓库根目录的 [`docs/`](../../../docs/README.md) 维护；本目录只说明 CLI 如何组织这些能力。

| 文档 | 回答的问题 |
| --- | --- |
| [架构](architecture.md) | 应用、source-core、source-node 和本地存储怎样分工 |
| [实现方案](implementation.md) | 启动、搜索、阅读、换源、检测和取消怎样执行 |
| [功能说明](features.md) | 用户可用的功能、限制和终态 |
| [交互设计](interaction.md) | 页面、导航、键位和终端布局是什么 |
| [存储与缓存](storage-and-cache.md) | 文件、版本、缓存身份和恢复边界是什么 |

文档中的“当前实现”以 `apps/reader-cli/src/` 和测试为准；目标能力、Android 行为和跨宿主差异分别链接到根目录文档，不在这里重新定义规则语义。
