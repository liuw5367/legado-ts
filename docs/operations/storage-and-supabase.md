# 存储与 Supabase 部署方案

## 结论

书源 package 必须存储无关；在 Web 应用中，托管 Postgres（Supabase 可作为第一实现）是目标实现候选，用于保存用户书源、版本和状态。当前文档没有部署结果，不能把 Supabase 描述成已启用事实。Supabase client、RLS、认证和 Edge/Node 部署代码只能存在应用/adapter 层，不能进入核心 package。

Supabase 的 JSON/JSONB 适合保存规范化书源和未知字段，但 JSONB 不是完整的数据边界：用户归属、版本、检查状态、订阅关系和秘密仍应有独立字段/表。Supabase 官方说明见 [JSON 数据类型](https://supabase.com/docs/guides/database/json)、[Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) 和 [服务端认证包选择](https://supabase.com/docs/guides/auth/choosing-a-server-package)。

## 分层存储契约

```text
source-core package
    │ Repository / Runtime ports
    ▼
application service
    ├─ SourceRepository       书源、版本、用户覆盖
    ├─ SourceCheckRepository  检测会话、阶段结果、状态
    ├─ SubscriptionRepository 订阅与更新基线
    ├─ SecretStore             cookie、token、密码、请求头
    ├─ ContentStore            书籍、目录、正文和缓存
    ├─ ResourceStore           图片、音频、视频和文件 bytes
    └─ JobStore                异步检测/刷新任务
```

核心接口只依赖这些抽象，不依赖表名或 Supabase SDK。内存 Repository 用于单元测试；Postgres Repository 用于服务端运行；两者必须共享并发、清理和脱敏语义。

## 推荐的逻辑模型

| 逻辑实体 | 必要字段 | 说明 |
| --- | --- | --- |
| `source_records` | `user_id`, `source_id`, `source_revision`, `normalized_source`, `user_state`, timestamps | 当前用户可用的书源配置和用户状态；`user_id + source_id` 唯一 |
| `source_revisions` | `user_id`, `source_id`, `source_revision`, raw/normalized snapshot, origin, actor | 版本和审计；是否保留全部历史由容量策略决定 |
| `source_subscriptions` | `user_id`, `subscription_id`, URL, options, update metadata | 订阅自身，不与某一条书源混为一谈 |
| `source_subscription_items` | subscription/item identity, source_id, baseline revision, last result | 订阅条目与用户覆盖、基线分离 |
| `source_check_states` | `user_id`, `source_id`, `session_id`, `source_revision`, `check_revision`, status, summary, stage results, timestamps | 见[检测状态](../reference/source-check-state.md)；旧结果条件写入 |
| `source_runtime_state` | `user_id`, `source_id`, variables/cache refs, timestamps | 可失效、可重建，不能替代书源权威数据 |
| `source_secrets` | owner, source ref, encrypted value/secret provider ref, expiry | 只允许服务端使用，默认不随书源 JSON 导出 |
| `jobs` | owner, kind, `input_snapshot`, params, status, lease, error, output, cleanup | 检测和订阅刷新在无状态部署中的任务协调 |

## 实施基线

实际 SQL 仍在实施阶段编写，但以下约束现在就是设计契约：

- `source_records` 必须有唯一约束 `(user_id, source_id)`；所有 source、check、subscription、job 查询都带 `user_id` 条件。
- `source_revision`、`check_revision`、`write_version` 使用不透明文本或 UUID；不能用客户端时间戳代替 CAS 版本。
- 保存源配置、更新当前指针、写入审计和失效检查状态在同一数据库事务内完成；缓存清理和任务投递在 commit 后执行。
- RLS 至少覆盖源记录、版本、订阅、检查状态、任务和秘密引用；service role 只能在服务端 adapter 使用。
- `jobs` 必须有 `(idempotency_key, user_id)` 唯一约束、可索引的 `status/lease_until`，并按[任务执行与 Serverless 边界](job-and-execution.md)结算。
- 大正文和二进制资源使用对象存储或独立资源表，任务行只保存引用、摘要和版本，不保存无限大小的 payload。
- migration 必须按“表与约束 → RLS → 索引 → 数据回填 → adapter 双读校验”的顺序执行，并提供向前/回退说明。

## 用户隔离与授权

每一次读写都必须从服务端登录会话得到 `user_id`，而不是信任 body、query 或导入文件中的字段。数据库层使用 RLS 作为纵深防御；应用 service 仍要做资源授权和业务校验。公开查询不能返回其他用户的书源、检查状态、订阅 URL 或秘密存在性。

浏览器只调用应用 API。拥有 service role 或秘密解密能力的 client 不能打包到 SPA；Next.js/React Router 的 loader、action、route handler 或 Node/Edge function 负责服务端访问。SSR 读取也要经过当前请求用户的授权上下文。

## 版本与事务

保存书源时使用 `expectedSourceRevision` 做 CAS：只有当前 `sourceRevision` 与预期相等时才写入新版本。source、current pointer、check invalidation 和审计记录必须在同一事务完成；缓存失效和任务通知在提交后执行并可重试。

检测回写必须带 `user_id + source_id + session_id + source_revision + check_revision` 条件；数据库字段统一使用 `session_id`，应用 DTO 的 `sessionId` 在 adapter 边界转换。订阅刷新也必须走相同保存边界：远程失败保留上一次成功版本，部分有效条目可以逐项记录在刷新计划和诊断中，但默认原子模式不得提交这些条目、更新 baseline 或递增 subscriptionRevision；只有显式兼容模式并完成确认后才允许逐项保存，不得清空用户已有书源。

## 数据内容与秘密处理

- `raw_source` 用于重现和诊断，`normalized_source` 用于运行；两者都必须限制大小。
- 未知字段在规范化时保留，避免导入再导出丢失未来扩展；运行时只读取已支持字段。
- 用户覆盖（启用、排序、分组等）与订阅基线分开，避免下一次刷新覆盖用户选择。
- cookie、密码、token、Authorization、JS 私密配置不放在普通 `normalized_source` 或日志中；保存加密值或外部 Secret Manager 引用。
- 导出默认脱敏；测试 fixture、错误追踪和 URL 日志也要脱敏。

Repository 最小返回必须包含操作状态、是否已提交、sourceRevision、changes、effects 和 cleanup；数据库不可用、RLS 拒绝、CAS 冲突、SecretStore 失败和幂等键重复不能返回空列表或通用成功。保存草稿由应用保留，核心不把未提交候选写入权威表。

## Vercel、Next.js 与 Edge/Node

Vercel function 是无状态、可回收的执行实例，不能把 Map、临时文件或本地进程内存当成任务/书源的权威存储。检测和订阅刷新需要 JobStore、租约/幂等键和可重试状态；实时进度可使用 SSE/WebSocket adapter，但状态以数据库为准。

Edge 运行时优先承载轻量的解析、查询和短请求。需要 Node 专属 API、WebView/动态脚本、较长任务或大型响应时，路由到 Node function/worker；package 应在启动时暴露 capability 检查，使不支持的规则得到明确错误。数据库连接方式要遵循部署平台限制，Supabase 的连接建议见[数据库连接文档](https://supabase.com/docs/guides/database/connecting-to-postgres)。

Supabase 免费层可用于早期验证，但项目暂停、连接数、存储和请求限制会影响长期运行；上线前应查看[官方定价](https://supabase.com/pricing)和[免费项目暂停规则](https://supabase.com/docs/guides/platform/free-project-pausing)，并准备导出/迁移方案。不要把免费层当作队列、全文内容 CDN 或秘密管理的唯一保证。

## 替代方案

托管 Postgres（Supabase、Neon 等）是默认方案；如果已有独立认证和后端，Neon/其他 Postgres 也可替换。SQLite/Turso 适合本地或单一写入场景，需额外确认 Vercel 部署的一致性；Redis 只适合缓存、锁或短期队列，不应作为书源系统记录。

## 失败、恢复与迁移

- 数据库不可用：读取失败要明确返回服务暂不可用，不能回退到空书源列表；写入失败保留客户端草稿。
- 任务超时：JobStore 依据 lease 回收并重试，幂等键防止重复提交。
- 订阅响应损坏：保留旧基线和旧书源，记录诊断，等待下一次刷新。
- 删除误操作：默认保留 revision/audit 和用户阅读数据；真正的级联删除必须单独确认并有恢复窗口。
- 更换数据库：先导出版本化的脱敏格式，执行双读/校验，再切换写入；核心 package 不需要改变。

## 验收标准

- 能用内存 Repository 完成所有核心流程测试，并用 Postgres 集成测试验证事务和 RLS。
- 两个用户拥有相同 sourceId 时互不可见；旧 revision、旧检查任务和删除后的状态都不能越权回写。
- SPA 不包含数据库 service key 或秘密；Node/Edge 路由能力边界可被测试。
- 存储、队列、缓存和秘密服务可替换，且 package API 不发生泄漏。
