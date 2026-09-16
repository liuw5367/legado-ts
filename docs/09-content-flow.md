# 章节正文流程

## 入口和缓存

`WebBook.getContentAwait` 先查询正文缓存。命中且版本有效时直接返回。未命中时：

- JS 源调用 `getContent(chapter, book, nextChapterUrl)`；
- 声明式源检查卷占位章节、正文规则和详情页缓存，再请求章节 URL。

## 声明式正文解析

1. 卷节点的占位 URL 以标题开头时不解析规则，直接返回空字符串；
2. 非卷节点的 `contentRule.content` 为空时直接返回章节 URL，这是当前兼容回退，不是错误；
3. 创建 `AnalyzeRule`，设置 body、章节、下一章 URL、baseUrl 和 redirectUrl；
4. 获取正文规则字符串，关闭默认 HTML unescape；
5. 文本书对 `<usehtml>...</usehtml>` 做占位保护，调用 `HtmlFormatter.formatKeepImg`，再做 HTML unescape，最后还原占位内容；
6. 音频和视频书把结果当资源 URL，不执行文本 HTML 格式化；
7. `nextContentUrl` 获取当前章节的分页 URL。

正文分页只有一个 URL时串行跟随；多个 URL时并发解析后合并。分页循环会记录已访问 URL，并且当下一页等于下一章 URL时停止，防止把下一章内容并入当前章。

## 副文、替换和标题

- `subContent` 在正文解析上下文中执行；文本书拼接到正文后，在线文本按其上层语义处理；音频保存为歌词，视频保存为弹幕；
- `replaceRegex` 在所有正文分页合并后执行；正文行会先 trim 再替换，在线文本替换后为每行增加缩进；
- `title` 在正文提取后执行，非空时覆盖章节标题；标题里包含图片 URL时拆出 `imgUrl`，保留标题前缀或回退原章节标题；
- 非卷章节正文最终为空抛出 `ContentEmptyException`；卷章节允许空正文。

## 请求选项

正文请求把 `webJs` 和 `sourceRegex` 传给 `AnalyzeUrl`。`webJs` 用于页面脚本加载，`sourceRegex` 用于资源嗅探。响应的最终 URL用于正文中的相对图片/链接。

## 保存和批量

需要保存时，正文和章节元数据一起写入宿主缓存；并发写入必须使用版本 token，避免旧请求覆盖新正文。这是 TypeScript Host 的目标约束，不代表当前文档已经有 TypeScript runtime 实现。批量正文：

- 常规源执行 `contentBatch`，脚本通过 `java.cacheContent(url, content)` 回存；
- JS 源执行 `getContentBatch(chapters, book)`，同样通过缓存接口回存；
- 当前批次未回存的章节返回给上层，按普通单章流程兜底；
- 批量数量必须大于 1，常规源需有 `contentBatch`，JS 源需有 `config.maxBatchSize` 和 `getContentBatch`，上限为 50。
