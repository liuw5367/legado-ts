# reader-web 架构

## 分层

```text
React Router 页面与组件
  -> src/lib/api.ts（认证令牌、JSON/SSE、错误 DTO）
  -> Hono API（鉴权、输入校验、状态码、流式响应）
  -> ReaderRuntime（书源 session、搜索/目录/正文编排）
  -> ReaderRepository（用户范围的 Postgres/Drizzle 或内存实现）
  -> source-core + source-node（规则、请求和 Node 宿主）
```

浏览器只处理脱敏领域 DTO，不接收 `RuntimeHost`、数据库连接、service key 或书源运行 Cookie。`src/router.tsx` 将公开认证页面和受保护账户页面分开；`ProtectedRoute` 只依据 Supabase Auth 会话决定是否进入账户路由。

## API 与认证

`server/app.ts` 创建 Hono 应用，并通过 `requireUser` 使用 Supabase Auth 校验 Bearer token，将可信 `userId` 放入请求上下文。除 `/api/health` 外的业务接口都先执行该校验。API 只接受领域输入，错误通过稳定 code 和 HTTP 状态返回；source-core 的 `capability-missing`、取消和上游失败不会被统一改写为空结果。

当前接口分为书源管理（列表、导入预览/确认、启用/禁用/删除）、设置、搜索（创建、查询、SSE、续页、取消）、书籍与来源版本、书架、目录、正文和阅读位置。页面通过 `apiFetch` 自动加入当前会话令牌，搜索流使用 `SseDecoder` 逐事件更新候选和进度。`source-result` 在来源首次命中时附带 `sourceSummary`，同一 SSE 响应内每个来源只发送一次摘要；两个页面只在用户提交搜索后，由创建搜索任务接口查询账号的全部可用书源；进入页面不预查搜索范围。流式摘要复用执行该来源时已读取的书源数据，不额外查询管理摘要。本书来源接口用一次按来源 ID 限定的摘要查询完成指纹校验和 `sourceSummaries` 展示信息组装，切换页展开域名时通过 `GET /api/source-management?all=true&domain=<sourceId>` 按账号查询该域名的版本。阅读摘要只包含展示、排序及版本切换需要的字段，不返回导入地址、导入时间和管理指纹。

## 运行时与会话

`server/runtime/reader-runtime.ts` 只从当前用户的 Repository 读取启用书源，再调用 `@legado/source-core` 的单源工作流。多源 fan-out、进度和搜索状态由 Web runtime 负责，规则解析和候选归并仍由共享 package 负责。每个来源执行期间获取五分钟运行状态租约，恢复加密的 Cookie/变量快照，操作完成后按 fingerprint、lease token 和版本条件保存快照并释放租约。保存失败会阻止旧 session 继续写入。

搜索状态保存 source states、候选、游标、操作身份和进度。`claimSearch` 防止同一搜索并发运行；更新时校验 operationId，迟到结果不能覆盖已取消或已替换的运行。SSE 只是传输层，数据库中的搜索记录才是可重新读取的状态。

## Repository 与持久化

`ReaderRepository` 为 runtime 提供用户范围的来源、搜索、书籍、目录、正文、书架、阅读位置、设置和运行状态方法。生产实现使用 Drizzle/Postgres，测试使用 `MemoryReaderRepository`。所有用户资源查询和写入都带 `userId`；全局 `sources` 只读取共享书源定义。写入源管理、导入确认和运行状态租约使用事务或条件更新。

数据库连接由 `server/db/client.ts` 创建，迁移由 `server/db/migrate.ts` 执行。应用不使用历史设计中的通用 `SourceApplicationService` 或 JobStore；订阅刷新、持久后台检测和 Android Web API 兼容仍属于未实现目标。

## 前端页面

受保护路由由账号范围的 `PageStack` 承载。React Router 管理 URL 和浏览器历史，`lib/page-stack.ts` 将已观察到的历史条目映射到有限数量的页面实例。每个实例使用固定 location 的 `Routes` 匹配页面参数，通过 React `Activity` 保留状态与 DOM；隐藏时清理 Effect，恢复时重新建立订阅。`AccountLayout` 使用稳定的容器结构切换账户导航与阅读外壳，避免跨外壳导航销毁保留页面。

`usePageLoadEffect` 将读取是否结算与可见生命周期分开，成功或失败的读取不因恢复而重复执行，取消的首次读取可以重新发起。`apiFetch` 在成功提交业务写入后按账号发布领域失效通知；活动页面按依赖刷新，隐藏页面在恢复时读取。位置写入由账号范围的 `ReadingPositionQueue` 顺序提交，页面隐藏或淘汰不取消已入队保存，切换账号停止尚未发送的任务。

书源选择、目录和阅读页通过 editionKey 区分同一本书的不同来源版本；每个域名只有一个账号默认实现，搜索和书籍来源页允许选择同域实现并更新这一默认值。查看其他来源目录不会切换本书的活动 edition，点击章节后才更新 edition。页面保留与返回规则见 [交互说明](interaction.md)，数据缓存与失效边界见 [存储与缓存](storage-and-cache.md)。

共享 package 的规则与请求契约见 [source-core 文档](../../../packages/source-core/README.md)，Web 的路由和具体用户操作见 [交互说明](interaction.md)。
