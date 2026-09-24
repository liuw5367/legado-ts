# 命令行阅读器应用架构

## 边界

应用 package 负责：

- 解析 `--source` 和 `LEGADO_READER_SOURCE`。
- 读取单文件、嵌套目录和远程来源，并过滤不支持的来源。
- 创建每个书源独立的网络、Cookie 和规则会话。
- 编排搜索、详情、目录、正文、已知书源和阅读状态。
- 保存书架、搜索记录、阅读记录、书籍文档和可删除缓存。
- 驱动 Ink 页面和键盘输入。

`@legado/source-core` 不读取文件、不管理书架，也不持有 TUI 状态。它只接收一次调用所需的不可变来源和宿主端口。

内部实现保留三个稳定门面：`ui.tsx` 负责页面状态、输入和动作编排，`application.ts` 负责跨书源用例和生命周期，`storage.ts` 负责搜索、阅读、书架和书籍持久化。纯页面模型与渲染位于 `ui-model.ts`/`ui-pages.tsx`，书源会话位于 `source-session.ts`；`search-results.ts` 只负责把 source-core 的分组映射为 CLI 页面模型并提供匹配标签。候选身份归并、匹配等级与排序由 `source-core` 实现。存储模型、版本化 JSON 文件和可删除缓存分别位于 `storage-model.ts`、`json-store.ts` 和 `cache-store.ts`。这些内部模块不改变三个门面的公开导出，也不各自创建写队列或进程锁。

## 数据流

```text
CLI 参数/环境变量
        |
        v
SourceCatalog -> SourceEntry -> SourceSessionRegistry
        |                       |
        v                       v
ReaderStorage <----------- ReaderApplication
        |                       |
        +-----------------------+
                    |
                    v
                Ink UI
```

每个 `SourceEntry` 使用 `bookSourceUrl` 作为 sourceId，使用 `sourceDefinitionFingerprint` 区分定义版本。冲突来源不进入默认搜索队列。每个来源会话共享自己的 `NodeCookieStore` 和 `NodeNetworkHost`，但每次搜索、详情、目录或正文调用都新建 `SourceRequestHost`/`SourceRuleHost`；这两个 Node 门面分别组合网络/字符集能力和解析器/QuickJS 等能力，再委托给 source-core 运行时。同一 sourceId 由 `KeyedConcurrencyHost` 串行执行。

UI 使用同文件私有 `PageShell` 和 `CommandBar` 渲染所有页面：单行上下文、按终端高度分配的正文区和固定命令栏；输入、状态和快捷键共用一行命令槽。`viewport.ts` 统一处理终端最小尺寸、正文行数、分页与边界；`source-order.ts` 将当前来源置顶并按搜索耗时稳定升序排列；`ui-actions.ts` 按终端显示宽度省略放不下的低优先级动作并测量 Unicode 字素簇，避免快捷键拆分或光标落在宽字符内部；`action-menu.ts` 固定四项动作及禁用原因，但 `o` 只由首页和搜索结果接入，弹窗使用居中覆盖层保留底层页面。真实导航栈保留页面、焦点、筛选和视口状态，目录筛选单独维护当前阅读章节身份。搜索和换源搜索通过 `SearchUpdateListener` 将已返回候选逐次推送到 UI，`AbortController` 只改变任务状态，不直接销毁当前页面。

用户可见通知带页面所有权，路由切换会清除旧页面的瞬时消息；持久化时间仍为 UTC ISO，展示层使用 `time-format.ts` 固定转换到 `Asia/Shanghai` 的 `YYYY-MM-DD HH:mm:ss`。正文由 `content-format.ts` 先将 text/html 转换为语义块，再交给 `content-layout.ts` 换行，因此阅读锚点基于段落和段内偏移，不依赖某次终端宽度的显示行号。

## 操作契约

1. 搜索创建 search history，按最多四个来源并发执行。每个来源完成后同时推送进度和不可变结果快照；快照包含分源状态、候选、来源耗时、总耗时、source-core 按书名+作者规则聚合的结果组和匹配等级。应用添加 CLI 来源信息并负责快照生命周期；`⎋`/退出会中止工作流并等待所有活动请求释放。
2. 打开候选时按 `(sourceId, bookUrl)` 复用已有 `bookId`，否则创建新的逻辑书籍。
3. 同次搜索的同书名同作者候选写入 `sources.json`，详情成功后补全简介、目录地址、最新章节、更新时间和原始字段；作者缺失时不跨来源强行合并。
4. 目录和正文通过核心公开工作流执行，命中带来源定义 fingerprint 的 `cache-v1` 命名空间时不访问网络；规则定义变化不会复用旧正文，阅读页刷新会跳过正文缓存读取并在成功后写回。
5. 正文加载成功后立即把目标来源与章节写入阅读记录，滚动位置再按节流策略保存；书籍元数据随后同步。元数据同步中断时，下次 `openStoredBook` 以阅读记录中的来源修复书籍活动来源。
6. 移出书架只删除书架关系，保留书籍、已知来源和阅读记录。

## 资源限制

来源目录最多读取 256 个 `.json`/`.js` 文件，单文件和远程响应最多 4 MiB。单次搜索每个来源最多保留 100 个候选，全局并发为 4。正文清洗输出最多 4 MiB，缓存总量默认 512 MiB。超过限制时返回可展示诊断，不用空结果掩盖失败。
