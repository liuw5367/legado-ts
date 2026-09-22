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

每个 `SourceEntry` 使用 `bookSourceUrl` 作为 sourceId，使用 `sourceDefinitionFingerprint` 区分定义版本。冲突来源不进入默认搜索队列。每个来源会话共享自己的 `NodeCookieStore` 和 `NodeNetworkHost`，但每次搜索、详情、目录或正文调用都新建 `SourceRequestHost`/`SourceRuleHost`，避免并发操作覆盖 `key/book/chapter` 绑定。同一 sourceId 由 `KeyedConcurrencyHost` 串行执行。

## 操作契约

1. 搜索创建 search history，按最多四个来源并发执行，向 UI 推送总数、完成数、活动来源、候选数和分源状态；`Esc`/退出会中止工作流并等待所有活动请求释放。
2. 打开候选时按 `(sourceId, bookUrl)` 复用已有 `bookId`，否则创建新的逻辑书籍。
3. 同次搜索的同名候选写入 `sources.json`，详情成功后补全简介、目录地址和原始字段。
4. 目录和正文通过核心公开工作流执行，命中带来源定义 fingerprint 的 `cache-v1` 命名空间时不访问网络；规则定义变化不会复用旧正文。
5. 正文可展示且阅读位置成功写入后，才更新 `lastReadAt`。
6. 移出书架只删除书架关系，保留书籍、已知来源和阅读记录。

## 资源限制

来源目录最多读取 256 个 `.json`/`.js` 文件，单文件和远程响应最多 4 MiB。单次搜索每个来源最多保留 100 个候选，全局并发为 4。正文清洗输出最多 4 MiB，缓存总量默认 512 MiB。超过限制时返回可展示诊断，不用空结果掩盖失败。
