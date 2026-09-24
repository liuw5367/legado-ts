# 集成与兼容层

> 归档（2026-09-24）：本文描述的目标在当前仓库无对应实现，仅作历史设计保留；现行事实见 docs/README.md。

本目录描述独立 package 如何接入现有 Legado API、用户认证、数据库和部署运行时。这里记录的是适配边界与证据，不把 Android 的 HTTP/WebSocket 协议直接变成核心领域模型。

## 文档入口

- [Legado Web API 适配](./legado-web-api-bridge.md)：对照根目录 `api.md` 和 Android Controller，说明哪些行为需要兼容。
- [书源保存与状态持久化](source-persistence-flow.md)：应用如何把 package 产物保存到当前用户。
- [书源检测流程](../flows/source-check-flow.md)：应用如何组织异步检测任务。
- [Supabase 与存储](storage-and-supabase.md)：Vercel/Next.js/Node 部署下的持久化边界。

## 归属规则

核心 package 只包含书源格式、规则解析、请求/解析运行时接口、搜索/详情/目录/正文编排和结构化错误。用户认证、RLS、数据库、API 路由、WebSocket、任务队列、秘密存储和部署限制属于应用或 adapter。

上层仓库的 `api.md` 还覆盖书籍、阅读、RSS、替换、内容提供者和 MCP 等能力。本项目当前吸收书源导入、保存、查询、删除、调试搜索、书源检测和多 `BookSource` 订阅刷新；`RssSource`、`ReplaceRule` 的独立实体 CRUD 仍是待审核的扩展能力，其他 API 等应用需求另行建模。
