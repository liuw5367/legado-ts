# 实施方案

本目录回答“未来如何把参考规范实现为独立 TypeScript package”。[路线图](roadmap.md) 是阶段定义的唯一来源；其他阶段文档只说明该阶段的实现顺序、依赖、公开边界和验收门槛，不复制规则语义。

- [迁移实施顺序概览](migration-guide.md)：按依赖和任务理解整体迁移。
- [实施总路线与阶段交付](roadmap.md)：A–E 阶段、独立交付和变更原则。
- [阶段 A：模型、导入与编辑基础](phase-a-codec-editor.md)
- [阶段 B：规则引擎与请求计划](phase-b-rules-request.md)
- [阶段 C：发现、搜索、详情、目录与正文](phase-c-workflows.md)
- [阶段 D：批量、媒体与交互扩展](phase-d-extended-capabilities.md)
- [阶段 E-1：书源持久化、订阅刷新与书源检测](phase-e-storage-and-check.md)
- [阶段 E-2：应用接入、部署验证与 package 维护](phase-e-integration.md)

阶段完成状态以 [质量与验证](../quality/README.md) 的矩阵和测试证据为准。能力取舍仍需用户单独审核。
