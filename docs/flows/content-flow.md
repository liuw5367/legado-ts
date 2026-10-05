# 章节正文流程

## 入口和缓存

Android 的 `WebBook.getContentAwait` 只有在 `needSave=true` 且缓存 token 的 `version > 0` 时才读取正文缓存；命中并通过版本检查才直接返回。TypeScript 对应的 `loadStoredChapterContent` 把这段 cache-first 编排放在核心，`loadChapterContent` 仍是纯解析入口。未命中或 `refresh=true` 时：

- JS 源调用 `getContent(chapter, book, nextChapterUrl)`；
- 声明式源检查卷占位章节、正文规则和详情页缓存，再请求章节 URL。

## 声明式正文解析

1. 卷节点的占位 URL 以标题开头时不解析规则，直接返回空字符串；
2. 非卷节点的 `contentRule.content` 为空时直接返回章节 URL，这是当前兼容回退，不是错误；
3. 创建 `AnalyzeRule`，设置 body、章节、下一章 URL、baseUrl 和 redirectUrl；
4. 获取正文规则字符串，关闭默认 HTML unescape；
5. 对普通声明式书源正文（包括规则从 HTML、JSON 或 `@js` 求出的文本），在 `adaptSpecialStyle` 开启时先保护 `<usehtml>...</usehtml>`，再调用 `HtmlFormatter.formatKeepImg`、做 HTML4 unescape，最后还原占位内容；每页先处理，之后才合并分页和执行源级替换；
6. 音频和视频书把结果当资源 URL，不执行文本 HTML 格式化；`contentType` 是结果的呈现形态，不是是否执行内置正文格式化的开关；
7. `nextContentUrl` 获取当前章节的分页 URL。

正文分页只有一个 URL 时串行跟随；多个 URL 时并发解析后合并。分页循环会记录已访问 URL，并且当下一页等于下一章 URL 时停止，防止把下一章内容并入当前章。

## 副文、替换和标题

- `subContent` 使用首次正文响应的规则上下文提取。在线文本书（`BookType.text` 且非 local）无条件把副文原文追加进正文列表，即使它看起来像 `http` URL，也不再次请求；非在线类型会先 trim，副文以 `http` 开头（忽略大小写）时请求并取响应 body，否则保留 trim 后的原文。音频将结果写入章节变量 `lyric`，视频写入 `danmaku`，其他类型不追加；副文请求失败保留已取得的主正文并返回 `success`，同时附带结构化诊断；规则提取失败则正文失败。Android 把处理异常记录为日志，取消会终止整个流程（见 D11）；
- `replaceRegex` 在所有正文分页合并后执行；正文行会先 trim 再替换，在线文本替换后为每行增加缩进；
- `title` 在正文提取后执行，非空时覆盖章节标题；标题里包含图片 URL 时拆出 `imgUrl`，保留标题前缀或回退原章节标题；
- 非卷章节正文最终为空抛出 `ContentEmptyException`；卷章节允许空正文。

## 当前 source-core 的兼容边界

声明式正文已按上述次序格式化，`ContentInput.adaptSpecialStyle` 默认启用并允许调用方关闭；正文资源元数据从归一化后的图片 URL 生成，标题结果单独返回 `title` 和 `imgUrl`。JS 书源 `mainJs.getContent` 保持 Android 的原始返回路径，不经过声明式正文格式化。

source-core 已实现声明式正文的 `subContent`，Node 集成测试覆盖实际 CSS 规则提取和音频歌词变量回写。音频/视频结果通过 `ChapterContent.auxiliary` 便捷返回，持久化以返回章节副本中的 `variable.lyric` / `variable.danmaku` 为准；声明式工作流不修改调用方传入的章节对象。在线文本副文进入 `pages`、`raw` 与后续全文替换。核心不负责数据库写入，章节变量由调用方随结果保存。`mainJs.getContent` 使用其自身返回协议，不另跑声明式 `subContent`。

## 请求选项

首个章节请求把 `webJs` 和 `sourceRegex` 传给 `AnalyzeUrl`；`webJs` 用于页面脚本加载，`sourceRegex` 用于资源嗅探。Android 的串行和并发正文分页只把 `webJs` 传给后续 `AnalyzeUrl`，不会再次传入 `sourceRegex`，不能把首页参数推广到分页分支。JS 源由自身 `getContent` 函数决定请求参数。每次响应的最终 URL 用于正文中的相对图片/链接。

URL/options 的请求脚本按 Android 绑定边界接收当前 `book`；正文首请求另有只供 `java.get/put` 使用的内部章节作用域，脚本全局不会出现 `chapter`。正文分页和副内容请求只携带 `book`，不会把首页章节对象暴露给后续请求。脚本对 `book` 的 DTO 修改会回写到本次工作流的书籍快照，应用可在成功目录快照中持久化它；这套上下文由 source-core 传递，宿主只负责执行脚本和请求。

## 数据流和状态转换

正文流程的输入、请求和持久化顺序如下：

```text
BookSource + Book + BookChapter + nextChapterUrl
  -> 计算下一章保护 URL
  -> 按 ContentIdentity 读取最终正文和版本 token
  -> 缓存命中则返回
  -> 选择 JS 源或声明式源
  -> 请求章节页，得到 body、baseUrl、redirectUrl
  -> 规则解析和正文分页
  -> 副文、全文替换、标题和资源归一化
  -> 空正文检查
  -> reserve/write 条件提交正文、最终 URL 和章节元数据
  -> 提交后重读；stale/rejected/unknown 不覆盖较新正文
  -> 返回正文、章节更新和诊断
```

当前实现公开导出 `ContentIdentity`、`ContentSaveToken`、`ContentStore` 和 `StoredContentInput`；`loadStoredChapterContent` 使用它们完成 cache-first、条件提交和提交后重读。正文身份必须同时绑定 `sessionId`、`sourceId`、`bookUrl`、`chapterKey`、`resourceKind`、`sourceRevision`、`semanticVersion`、`tocRevision` 和 `chapterIndex`；保存 token 的 `identity`、`operationId`、`writeVersion` 和过期信息必须在同一原子边界校验。这样既不会把不同会话的缓存混用，也不会让旧目录的章节覆盖新目录。

```ts
export interface ContentOperationContext {
  sessionId: string
  identity: ContentIdentity
  tocRevision: string
  chapterIndex: number
}
```

当前 TypeScript 入口返回 `RuntimeResult<ChapterContent>`；下面的 `ContentResult` 是 Android/统一门面目标形状，实际 cache-first 调用请使用 `loadStoredChapterContent`，不是该接口的直接返回类型。

```ts
export interface ContentResult {
  /** `success`、`empty`、`partial`、`failed`、`cancelled`、`stale` 或 `unknown`。 */
  status: OperationStatus
  /** 本次正文操作身份，用于丢弃迟到分页和保存回调。 */
  operationId: string
  /** 结果基于的书源版本。 */
  sourceRevision: string
  /** 领域内容种类，由书籍类型和流程确定，不根据 URL 后缀猜测；image-content/file-links 分别映射为 image/file resourceKind。 */
  kind: 'text' | 'image-content' | 'audio' | 'video' | 'file-links'
  /** 归一化后的正文、资源 URL 或文件链接；二进制实体由 ResourceStore 保存。 */
  content: string
  /** 章节标题、图片、歌词和弹幕等章节更新。 */
  chapter: BookChapter
  /** 书籍和章节身份。 */
  book: Pick<Book, 'bookUrl' | 'origin'>
  /** 是否从有效正文缓存返回。 */
  cacheHit: boolean
  /** 最终响应 URL；缓存命中时使用缓存记录中的响应 URL。 */
  finalUrl: string
  /** 本次正文访问过的分页 URL。 */
  visitedUrls: string[]
  /** 正文保存是否成功；needSave=false 时为 false。 */
  saved: boolean
  /** needSave=true 时的存储结算；不能只依赖 saved 判断未知提交。 */
  saveResult?: StoreWriteResult
  /** 音频歌词或视频弹幕，与正文资源地址分开；不存在时省略。 */
  auxiliary?: { kind: 'lyrics' | 'danmaku'; content: string }
  /** 分阶段诊断，保存失败不能伪装为规则失败。 */
  diagnostics: RuntimeDiagnostic[]
  /** 尚未由应用提交的正文、章节和资源变更。 */
  changes: DomainChange[]
  /** 已发生的请求、Cookie 和存储副作用。 */
  effects: EffectRecord[]
  /** 请求、分页、脚本和保存资源的最终清理状态。 */
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
}
```

状态为 `created -> cache-check -> loading -> parsing -> paginating -> normalized -> validated -> saving/completed`。只有满足 Android 缓存读取条件的命中才直接 `completed`；needSave=false 跳过 cache read 和 saving，错误和取消不启动新保存；已完成提交如实记录，不能因后续取消否认已保存事件。文件源从详情返回下载链接，不强行进入 ContentResult。

`nextChapterUrl` 未显式传入时，Android 查询下一索引 URL，再回退目录首章 URL。Web 调用方提供目录快照/保护 URL，核心不能直接查数据库。分页遇到下一章即停止。多 URL 分支使用 FlowExtensions.mapAsync，按输入 URL 顺序收集，不能按响应完成顺序合并；测试必须设置后页先返回，断言正文仍按输入顺序组成。

正文归一化完成后，核心库返回 `content`、章节标题和 `imgUrl` 更新、音频歌词或视频弹幕附加数据、最终响应 URL、已访问分页 URL 以及诊断。`source-core` 不直接写文件或数据库，宿主通过正文存储端口提交结果；Android 的 `BookHelp.saveContent` 行为由适配器复现。`finalUrl` 是结果字段的一部分，不能只在说明文字中承诺。

## 保存和批量

### 正文缓存提交

`loadStoredChapterContent` 在 `refresh` 未开启时按 ContentIdentity 读取缓存；命中有效记录直接返回，未命中才 reserve 新 ContentSaveToken。缓存记录必须同时包含正文、`finalUrl`、章节更新和歌词/弹幕附加数据，旧的只有字符串正文的记录按未命中处理。读取不能改变代次。token 同时绑定会话、源及语义版本、目录修订和 operation；文件目录名属于 adapter，不进入核心身份。详情见 [状态契约](../standard/state-and-effects.md)。

提交顺序固定为：

1. 原子校验 token 的身份、源/目录版本、operation 资格和写入代次；
2. 在同一提交边界内写正文文件或缓存值；
3. 按需要写入章节标题、图片等元数据；
4. 只有正文和元数据都通过当前版本校验后，才发布保存事件；
5. token 过期返回未保存结果，保留较新的缓存，不能抛出普通规则错误。Android 单章保存此时优先返回新缓存，取不到则抛 `正文缓存已更新,请重试`。

保存失败返回 storage-error 并保留原元数据；token 过期返回 saved=false 与 stale-write 诊断。取消与提交竞争按宿主原子结果记录，已提交结果不能被“取消”抹除。needSave=false 返回可提交变更但不 reserve 或写入；所有路径释放分页、scope 和监听器。

### 批量正文

批量工作流由 `loadChapterContentBatch` 编排；调用方先按阅读/缓存状态挑出需要请求的非卷章节，保存仍通过宿主回调执行。应用可在回调闭包中使用章节版本 token，避免旧请求覆盖新正文；source-core 不访问文件系统或数据库。批量正文：

- 常规源执行 `ruleContent.contentBatch`，JS 源执行 `getContentBatch(chapters, book)`；两者都通过 `java.cacheContent(chapter, content)` 回调宿主。常规源全局 `baseUrl` 使用目录 URL、缺省时回退书源 URL；JS 源沿用 Android 的书源 URL 默认值。
- `maxBatchSize` 大于 1 时启用批量，每次最多 50 章；较大的输入由核心按顺序切批，单章尾项直接走单章流程。
- 对象按本批唯一的 `index` 识别，数字下标不接受；URL 仅在本批唯一时接受，重复 URL 必须传章节对象。
- 核心先应用 `replaceRegex`，再调用缓存适配器。回调接受写入后该章标记完成；未回存、函数缺失或脚本失败的章节走普通 `loadChapterContent` 兜底，先前成功项保留。
- 缓存适配器返回 `false` 时按版本冲突或拒绝写入处理，该章不会再执行单章兜底，以免覆盖较新的正文。未提供缓存适配器时跳过批量脚本，返回单章解析结果供应用处理，不产生持久化。

Node 的 `java.cacheContent` 在批量调用期间通过有序宿主 action 串行提交；其他上下文调用会得到能力缺失错误。平台适配器负责 token 校验和持久化原子性，并且应将 `false` 保留给过期或拒绝写入的情况。若写入抛错，核心记录 `cache-failed` 并保守跳过该章兜底；其他缺失章节仍可继续回退。Android 对照执行仍未完成，因此目前只能称为 TypeScript 实现及 Node 测试通过。
