# 归档文档

本目录只保留仍有独立参考价值、但尚未实现或已被现状取代的历史目标。它们供后续设计和兼容分析使用，不能作为当前应用契约；当前行为以 package、应用 docs、流程和质量文档为准。

## 本目录文档

| 文档 | 归档原因 |
| --- | --- |
| [source-management-and-state.md](source-management-and-state.md) | `SourceRepository` 等持久化端口未实现 |
| [legado-web-api-bridge.md](legado-web-api-bridge.md) | HTTP/WebSocket API 适配层未实现 |
| [job-and-execution.md](job-and-execution.md) | JobStore、租约与 Serverless worker 未实现 |
| [source-editor.md](source-editor.md) | TypeScript 书源编辑器未实现；当前只有导入预览和管理 |

现行事实入口见 [docs/README.md](../README.md)。历史文档只在讨论目标设计、兼容差异或后续决策时引用。
