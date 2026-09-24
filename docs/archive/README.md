# 归档文档

本目录存放未在当前仓库实现、或已被实现现状取代的历史文档。归档不等于删除：正文保留原设计意图与 Android 事实（如有），但不得作为现行契约引用。

## 归档判据

正文主体描述 TypeScript 目标功能，且 `packages/`、`apps/` 无对应实现，且不含大段可独立成立的 Android 行为事实。

## 本目录文档

| 文档 | 归档原因 |
| --- | --- |
| [roadmap.md](roadmap.md) | 实施前总路线；「尚无实现」陈述已被 source-core / source-node / reader-cli 现状取代 |
| [migration-guide.md](migration-guide.md) | 实施前迁移阅读顺序；「交付物只是规格」陈述已过时 |
| [phase-e-integration.md](phase-e-integration.md) | 阶段 E-2 框架接入与部署验证未实施 |
| [phase-e-storage-and-check.md](phase-e-storage-and-check.md) | 阶段 E-1 Repository、检测与 JobStore 未实施 |
| [source-management-and-state.md](source-management-and-state.md) | `SourceRepository` 等持久化端口未实现 |
| [source-persistence-flow.md](source-persistence-flow.md) | 书源保存事务流未实现（应用内仅有 reader-cli 本地 JSON 存储） |
| [source-editor.md](source-editor.md) | TypeScript 书源编辑器未实现（原指向 Android `modules/web`） |
| [node-browser-nextjs.md](node-browser-nextjs.md) | Next.js / SPA / Edge 接入未实现 |
| [legado-web-api-bridge.md](legado-web-api-bridge.md) | HTTP/WebSocket API 适配层未实现 |
| [integration.md](integration.md) | 原 `integration/` 分类 README；分类已取消 |
| [job-and-execution.md](job-and-execution.md) | JobStore、租约与 Serverless worker 未实现 |
| [storage-and-supabase.md](storage-and-supabase.md) | Supabase 未进入本仓库依赖与部署 |

## 恢复步骤

1. 将文档 `git mv` 回目标分类（标准 / 实现 / 流程等），删除文首归档横幅。
2. 修正入站与出站相对链接，跑 `docs` 链接检查。
3. 按代码现状重写实现状态与公开入口名称，状态未经核验不得标为已实现。
4. 更新本表与主 `docs/README.md` 分类表。

现行事实入口见 [docs/README.md](../README.md)。
