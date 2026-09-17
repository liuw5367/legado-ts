# 使用指南

本目录回答“调用方如何使用 package、编辑书源、接入 Web 宿主”。指南只组织调用和接入，不重新实现规则，也不把尚未验证的能力描述成已支持。

- [独立 package 的调用契约](package-usage.md)：公开入口、调用上下文、结果和应用组织方式。
- [书源编辑器规划](source-editor.md)：字段编辑、预览、诊断、导入导出和冲突处理。
- [Node、Edge、浏览器和框架入口](node-browser-nextjs.md)：Node、SPA、Next.js 和 React Router 的边界。

运行时安全、平台限制、部署验收和发布回退属于 [运维文档](../operations/README.md)；实现顺序属于 [实施文档](../implementation/README.md)。
