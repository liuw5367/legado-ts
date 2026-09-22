# 命令行阅读器功能说明

## 功能范围

| 功能 | 默认行为 | 持久化或副作用 |
| --- | --- | --- |
| 书源加载 | 从 `--source` 或 `LEGADO_READER_SOURCE` 加载 JSON/JavaScript，目录递归导入并过滤不可用能力 | 远程来源成功响应写入 `~/.config/reader-cli/cache-v1/source-input` |
| 首页 | 分为书架、最近阅读、搜索记录三个区域；书架和最近阅读使用不同过滤条件 | 只读 `bookshelf.json`、`reading-history.json`、`search-history.json`、`books/*` |
| 搜索 | 最多四个来源并发；显示 `completed/total`、活动来源、候选数和分源状态 | 新增一条搜索历史；打开候选后回填 `openedBookIds` |
| 详情 | 对选中候选请求详情，显示作者、简介、当前书源和书架状态 | 写入 `books/<bookId>/book.json`，并合并本次搜索中的同名 `sources.json` |
| 已知书源 | 首次进入只读取本地候选；`m` 才对未记录或规则已变化的来源执行额外搜索 | 只将匹配当前书名的候选合并到 `sources.json`，不自动切换活动版本 |
| 目录 | 使用当前活动书源加载章节，打开阅读记录时定位上次章节 | 目录结果进入可删除的 `~/.config/reader-cli/cache-v1/toc` |
| 正文 | 以终端宽度换行，按段落锚点恢复位置，支持上一章/下一章和翻页 | 正文进入 `~/.config/reader-cli/cache-v1/content`；成功保存后更新 `reading-history.json` |
| 书架 | `a` 添加或移出书架；移出不删除书籍、书源和阅读记录 | 只改写 `bookshelf.json` |
| 取消与退出 | `Esc` 取消当前输入或异步工作流；`q`/`Ctrl+C` 先取消再退出 | 应用等待工作流、写队列和缓存索引释放后删除锁 |

## 异步状态约定

每个 UI 异步操作都有一个递增的操作 ID 和 `AbortController`。启动新操作或按 `Esc` 时，旧操作失效；旧 Promise 即使稍后完成，也只能释放自身资源，不能写入已离开的页面。应用层继续等待已启动的操作完成，确保网络连接、规则宿主和文件写入不会在退出后悬挂。

搜索进度回调是只读通知，字段含义如下：

- `total`：本次实际纳入队列的可用来源数。
- `completed`：已结束的来源数，取消前未开始的来源不会虚报完成。
- `activeSources`：正在请求或执行规则的来源名称。
- `candidates`：已经返回的候选累计数量。
- `success`、`partial`、`empty`、`failed`、`capabilityMissing`、`cancelled`：按来源统计的终态数量。

## 书源切换

如果当前阅读页已有目录，选择目标来源后先加载目标目录，并按规范化章节标题计算映射；找不到同名章节时回退到相同索引并要求用户确认。确认后才更新 `activeEditionKey`。如果当前没有目录，则详情加载成功后直接切换。规则 fingerprint 不匹配、来源被移除或来源冲突时，候选只能重新搜索，不能直接请求。

## 页面预览

当前页面的静态终端预览见[交互设计中的页面预览](interaction.md#页面预览)，对应 SVG 资产位于 `docs/screenshots/`。预览与当前 Ink 页面保持相同的页面标题、搜索进度、取消提示和主要键位；运行时数据仍以本地来源和终端尺寸为准。
