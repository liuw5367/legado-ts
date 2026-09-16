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

正文分页只有一个 URL 时串行跟随；多个 URL 时并发解析后合并。分页循环会记录已访问 URL，并且当下一页等于下一章 URL 时停止，防止把下一章内容并入当前章。

## 副文、替换和标题

- `subContent` 在正文解析上下文中执行；文本书拼接到正文后，在线文本按其上层语义处理；音频保存为歌词，视频保存为弹幕；
- `replaceRegex` 在所有正文分页合并后执行；正文行会先 trim 再替换，在线文本替换后为每行增加缩进；
- `title` 在正文提取后执行，非空时覆盖章节标题；标题里包含图片 URL 时拆出 `imgUrl`，保留标题前缀或回退原章节标题；
- 非卷章节正文最终为空抛出 `ContentEmptyException`；卷章节允许空正文。

## 请求选项

正文请求把 `webJs` 和 `sourceRegex` 传给 `AnalyzeUrl`。`webJs` 用于页面脚本加载，`sourceRegex` 用于资源嗅探。响应的最终 URL 用于正文中的相对图片/链接。

## 数据流和状态转换

正文流程的输入、请求和持久化顺序如下：

```text
BookSource + Book + BookChapter + nextChapterUrl
  -> 计算下一章保护 URL
  -> 读取正文缓存和版本 token
  -> 缓存命中则返回
  -> 选择 JS 源或声明式源
  -> 请求章节页，得到 body、baseUrl、redirectUrl
  -> 规则解析和正文分页
  -> 副文、全文替换、标题和资源归一化
  -> 空正文检查
  -> 版本校验后保存正文及章节元数据
  -> 返回正文、章节更新和诊断
```

```ts
export interface ContentIdentity {
  /** 书籍的稳定身份。 */
  bookUrl: string
  /** 章节在当前书籍目录中的稳定索引。 */
  chapterIndex: number
}

export interface ContentSaveToken {
  /** 书籍和章节的稳定身份。 */
  key: ContentIdentity
  /** 当前书籍缓存目录身份，防止书籍重命名后误写旧文件。 */
  folderName: string
  /** 请求开始时的版本，提交时必须使用比较并交换语义。 */
  version: number
}

export interface ContentResult {
  /** 归一化后的正文或音频/视频资源 URL。 */
  content: string
  /** 章节标题、图片、歌词和弹幕等章节更新。 */
  chapter: BookChapter
  /** 书籍和章节身份。 */
  book: Pick<Book, 'bookUrl' | 'origin'>
  /** 是否从有效正文缓存返回。 */
  cacheHit: boolean
  /** 本次正文访问过的分页 URL。 */
  visitedUrls: string[]
  /** 正文保存是否成功；needSave=false 时为 false。 */
  saved: boolean
  /** 分阶段诊断，保存失败不能伪装为规则失败。 */
  diagnostics: RuntimeDiagnostic[]
}
```

状态转换为 `created -> cache-check -> loading -> parsing -> paginating -> normalized -> validated -> saving -> completed`。缓存命中直接从 `cache-check -> completed`；请求、规则、分页或非卷空正文错误进入 `failed`；取消可以从任意活动状态进入 `cancelled`。失败和取消都不能发布“正文已保存”事件，也不能用本次失败正文覆盖旧缓存。

`nextChapterUrl` 未显式传入时，Android 依次使用当前章节下一索引 URL，再回退到目录首章 URL；实现必须在请求正文前完成这一步。正文分页只把当前章节的页面加入 `contentList`，当下一页等于下一章节 URL 时停止，不能继续请求下一章。串行分页按规则返回的第一个 URL 继续；多 URL 分页按实际任务完成顺序合并，因此 fixture 必须同时固定输入 URL、响应延迟和收集顺序。

正文归一化完成后，核心库返回 `content`、章节标题和 `imgUrl` 更新、音频歌词或视频弹幕附加数据、最终响应 URL、已访问分页 URL 以及诊断。`source-core` 不直接写文件或数据库，宿主通过正文存储端口提交结果；Android 的 `BookHelp.saveContent` 行为由适配器复现。

## 保存和批量

### 正文缓存提交

每次正文请求开始时生成 `ContentSaveToken`，至少包含 `bookUrl`、章节索引、书籍缓存目录身份和版本号。缓存读取必须验证书籍、章节和版本；只使用章节 URL 不能区分同 URL 多章节，也不能阻止旧请求覆盖新请求。

提交顺序固定为：

1. 校验 token 仍属于当前书籍、章节和缓存目录；
2. 在同一提交边界内写正文文件或缓存值；
3. 按需要写入章节标题、图片等元数据；
4. 只有正文和元数据都通过当前版本校验后，才发布保存事件；
5. token 过期返回未保存结果，保留较新的缓存，不能抛出普通规则错误。

保存失败必须返回 `storage-error`，并保留章节原有元数据。取消、超时和流程失败必须释放临时分页结果、脚本 scope、请求监听器和批量上下文。

### 批量正文

需要保存时，正文和章节元数据一起写入宿主缓存；并发写入必须使用版本 token，避免旧请求覆盖新正文。这是 TypeScript Host 的目标约束，不代表当前文档已经有 TypeScript runtime 实现。批量正文：

- 常规源执行 `contentBatch`，脚本通过 `java.cacheContent(url, content)` 回存；
- JS 源执行 `getContentBatch(chapters, book)`，同样通过缓存接口回存；
- 当前批次未回存的章节返回给上层，按普通单章流程兜底；
- 批量数量必须大于 1，常规源需有 `contentBatch`，JS 源需有 `config.maxBatchSize` 和 `getContentBatch`，上限为 50。

批量上下文必须按 `BookChapter.index` 识别章节。URL 字符串只有在本批次唯一命中时才能回存；多个章节共用 URL 时，脚本必须传章节对象，否则返回明确的章节歧义错误。回存操作需要在锁或等价的原子边界内完成“识别、替换、版本校验、保存、标记已保存”，并支持脚本乱序回调。批量脚本结束后，未标记已保存的章节进入普通单章兜底；批量脚本抛错时，已成功保存的章节可以保留，但剩余章节必须明确返回，不能整批伪装成功。
