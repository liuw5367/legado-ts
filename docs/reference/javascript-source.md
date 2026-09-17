# JavaScript 书源

## 配置和必备函数

导入器在受限 JavaScript runtime 中执行完整脚本，读取顶层 `config`；若 `config` 不完整则兼容旧版顶层 `source`。`bookSourceUrl` 和 `bookSourceName` 必须非空。

普通源要求顶层函数：

```js
function search(key, page) {}
function getChapters(book) {}
function getContent(chapter, book) {}
```

文件源（`bookSourceType == 3`）要求 `search` 和 `getBookInfo`，不要求普通目录和正文函数。配置 `exploreUrl` 时必须同时提供 `explore(url, page)`。

登录声明有两种互斥形式：`config.loginUi` 是静态登录表单配置时，脚本必须提供 `login(...)`；脚本提供 `loginUi(...)` 函数时，配置中不能再有 `loginUi`，并且必须同时提供 `loginAction(...)`。只有 `loginUi` 或只有 `loginAction` 都属于导入错误。复杂登录 UI、验证码和多步骤认证可以后续实施；尚未提供对应宿主能力时必须报告 capability error，不能把不支持认证误报成普通书源成功。

普通 JS 源的函数契约可以抽象为：

```ts
export interface JsSourceFunctions {
  /** 返回搜索结果 JSON 数组，调用方传入 1 起始的页码。 */
  search(key: string, page: number): Array<Partial<SearchBook>>
  /** 配置 exploreUrl 时必须存在，返回发现结果 JSON 数组。 */
  explore?(url: string, page: number): Array<Partial<SearchBook>>
  /** 可选的详情覆盖，返回允许覆盖字段的对象。 */
  getBookInfo?(book: Book): Partial<Book>
  /** 返回章节 JSON 数组。 */
  getChapters(book: Book): Array<Partial<BookChapter>>
  /** 返回正文文本、资源 URL 或空值。 */
  getContent(chapter: BookChapter, book: Book, nextChapterUrl?: string): string | null
  /** 声明 maxBatchSize 时必须存在，通过 java.cacheContent 回存章节正文。 */
  getContentBatch?(chapters: BookChapter[], book: Book): unknown
}

export interface JsLoginFunctions {
  /** 静态 loginUi 配置对应的提交函数；参数由宿主按登录表单配置注入。 */
  login?(...args: unknown[]): unknown
  /** 动态登录表单函数；与 loginAction 成对出现。 */
  loginUi?(...args: unknown[]): unknown
  /** 动态登录提交函数；与函数形式的 loginUi 成对出现。 */
  loginAction?(...args: unknown[]): unknown
}
```

这些是 JavaScript 脚本边界的逻辑类型，不表示脚本可以直接返回运行时实例。实际调用先执行脚本自身的 JSON 归一化，再由 marshaller 校验数组、对象、必需字段、来源身份、URL 和可覆盖字段。`search`、`explore` 返回数组以外的结果是调用错误；`getBookInfo` 的 `Partial<Book>` 只代表允许字段集合，不能覆盖 `bookUrl`、阅读状态或用户自定义字段。

配置中的声明式规则会从配置 JSON 中剥离，但完整脚本原文保存在 `mainJs`；编辑器导出时必须使用 `mainJs`，不能使用剥离后的对象重建脚本。对于 JS 源，`ruleReview` 也属于被剥离的声明式配置，但段评能力仍由脚本函数和运行时参数决定。

## 执行 scope

每次函数调用都创建新的调用 scope，绑定运行时 API、源对象和调用参数，再执行主脚本和函数表达式。源级共享 scope 如被宿主启用，必须显式声明共享键；默认迁移实现应按请求和调用隔离，防止 SSR 用户之间共享变量。

规则和源脚本可见绑定包括 `java`、`source`、`sourceApi`、`baseUrl`、`cookie`、`cache`，以及 `key`、`page`、`book`、`chapter`、`chapters`、`result`、`nextChapterUrl` 等流程变量。绑定名称和对象角色是兼容契约，脚本可调用方法、返回值、异常和能力开关见 [宿主接口](runtime-host-interfaces.md#javascript-书源宿主-api)。

## 返回值归一化

- `undefined`/`null`：归一化为空；
- 字符串：原样保留；
- 对象/数组：使用脚本引擎自身 JSON 序列化；
- `toJSON`、getter 和惰性字符串必须按 JavaScript 语义执行；
- 循环引用、序列化失败应抛明确错误；
- 取消必须原样传播。

### 搜索

`search`/`explore` 的 JSON 结果必须是数组。缺少 `name` 或 `bookUrl` 的条目丢弃，源身份由运行时重新注入，不能信任脚本返回的 `origin`。非法 type 回退书源类型。

### 详情

`getBookInfo` 返回对象，只合并允许的详情字段；`bookUrl`、阅读状态等字段不由脚本覆盖。变量支持对象或 JSON 字符串。下载 URL 必须是字符串数组，过滤空值、`javascript:`，转绝对 URL 并去重。

### 目录

`getChapters` 返回数组。缺少 `title`/`url` 的项丢弃；相对 URL 相对 `book.tocUrl` 解析；卷节点在标题等于 URL 时保留占位语义；索引、书籍 URL 和 base URL 由运行时注入。

### 正文和批量

`getContent` 返回文本或资源 URL。非卷章节的空结果是错误，卷章节允许空结果。`getContentBatch` 只在配置 `maxBatchSize` 且数量大于 1 时启用，实际批量数量上限为 50；它应通过 `java.cacheContent` 回存结果，未回存章节由调用方兜底。单独声明 `maxBatchSize` 而没有 `getContentBatch`，或单独声明 `getContentBatch` 而没有 `maxBatchSize`，都属于 JS 源导入错误，不能降级成普通单章流程。

### 段评函数

段评是 JS 源的独立扩展能力，不应混入普通正文返回值。函数签名和返回值契约如下：

```ts
export interface JsSourceReviewFunctions {
  /** 返回章节和正文段落的评论摘要。 */
  getReviewSummary(chapter: BookChapter, book: Book): ReviewParagraph[]
  /** 返回指定段落的评论分页。 */
  getReviewDetail(
    /** 当前章节快照。 */
    chapter: BookChapter,
    /** 所属书籍快照。 */
    book: Book,
    /** -1 为章评，正数为一基段落。 */
    paraIndex: number,
    /** 摘要阶段提供的站点上下文。 */
    paraData: string,
    /** 一基分页页码。 */
    page: number,
  ): ReviewPage
  /** 返回指定评论的回复分页；宿主在支持时才注入。 */
  getReviewReplies?(
    /** 当前章节快照。 */
    chapter: BookChapter,
    /** 所属书籍快照。 */
    book: Book,
    /** 章评或段落索引，沿用详情输入。 */
    paraIndex: number,
    /** 站点段落上下文。 */
    paraData: string,
    /** 详情返回的评论身份，保持字符串精度。 */
    reviewId: string,
    /** 一基回复页码。 */
    page: number,
  ): ReviewRepliesPage
}
```

```ts
export interface ReviewParagraph {
  /** -1 表示章节评论，正数表示从 1 开始的正文段落索引，0 和其他负数会被忽略。 */
  paraIndex: number
  /** 当前段落的评论数量。 */
  count: number
  /** 详情请求所需的段落上下文或站点标识。 */
  paraData?: string
}

export interface ReviewPage {
  /** 当前页评论的结构化对象数组；非对象项会被丢弃。 */
  items: ReviewItemInput[]
  /** 下一页 URL；不存在或为空表示分页结束。 */
  nextPageUrl?: string
}

export interface ReviewRepliesPage {
  /** 当前页回复对象数组；嵌套 replies 会由运行时展平。 */
  items: ReviewItemInput[]
}

export interface ReviewItemInput {
  /** 评论或回复 ID，按字符串处理以避免大整数精度损失。 */
  id?: string
  /** 头像地址，可为相对地址。 */
  avatar?: string
  /** 发布者昵称。 */
  name?: string
  /** 被回复者昵称。 */
  replyToName?: string
  /** 徽章字符串或字符串数组。 */
  badge?: string | string[]
  /** 内容文本或段评内容协议 JSON。 */
  content?: string | Record<string, unknown>
  /** 图片地址，可为相对地址。 */
  img?: string
  /** 音频地址，可为相对地址。 */
  audio?: string
  /** 评论发布时间文本。 */
  time?: string
  /** 点赞数量。 */
  likeCount?: number
  /** 回复数量。 */
  replyCount?: number
  /** 详情项可以带嵌套回复，回复分页返回后由运行时递归展平。 */
  replies?: ReviewItemInput[]
}
```

`getReviewSummary` 必须返回数组。运行时只接受 `paraIndex == -1` 或正数且 `count > 0` 的项目；缺少 `paraData` 时以段落索引文本作为回退键。非法项目和无效数量被忽略，脚本返回空值或不能解析为数组时得到空摘要。

`getReviewDetail` 返回评论项分页对象，至少包含 `items` 数组，可以包含 `nextPageUrl`；缺少或不是数组时该详情页结果为无结果。每个项目至少需要有内容、昵称、图片或音频之一，否则会被丢弃。`content` 如果是包含 `text`、`replyToName`、`img`、`audio`、`time`、`likeCount` 或 `replyCount` 的协议对象，运行时会解析协议并将图片、音频相对当前响应 URL 转换为绝对地址。

`getReviewReplies` 返回 `{ items }`，没有独立的 `nextPageUrl` 字段；运行时会把嵌套 `replies` 展平成回复列表，并清除回复项继续嵌套的结构。返回值不是对象、缺少 `items` 或 `items` 不是数组时属于返回格式错误。回复函数只有在摘要和详情函数都存在时才允许导入，调用时由宿主传入 `reviewId`，不是由脚本自行从全局变量读取。

导入校验必须区分以下情况：段评函数声明存在但不是函数、摘要函数缺失、摘要存在但详情缺失、回复函数单独存在。摘要和详情构成一对基本能力，回复是可选的第三层能力。函数缺失不能被当作空评论成功，宿主不支持该能力时应返回明确的 capability error。

段评函数的参数由运行时统一注入，不能要求脚本自行从全局变量猜测当前章节。`paraIndex`、`paraData`、`reviewId` 和 `page` 必须在摘要、详情、回复之间保持稳定。Android 侧的校验和调用入口以 `JsSourceConfig`、`JsSourceReview` 为行为依据。

JS 源导入完成后，配置对象中的声明式规则会被剥离，`mainJs` 保留完整原文。运行时每次函数调用都重新创建调用 scope，执行主脚本，再调用目标函数；书源共享 scope 只有在宿主明确启用并按书源身份隔离时才允许存在。脚本执行期间的网络、缓存、Cookie、文件和浏览器操作都必须经过宿主 API，不能直接访问 Node 全局对象。

## 安全边界

不能使用宿主 `eval` 或 Node 全局对象执行不可信书源。`JavaScriptRuntime` 至少需要脚本超时、内存/递归限制、AbortSignal、允许的网络 API 和日志接口；浏览器和 SSR 的 Cookie、文件、进程能力默认不可见。

规则内 JS、URL 插值、jsLib 和 loginCheckJs 同样需要这套执行能力，不只 mainJs 源需要。基础配置抽取和同步网络兼容在实施阶段 B 建立，主函数在 C 接入，不能全部推迟到 D。具体候选引擎、同步桥接验收及尚未解决的 Rhino 互操作限制见 [运行边界](../operations/runtime-security-and-deployment.md)。Java 类访问不能默认映射为 Node require；必须登记实际依赖并通过受控兼容方法提供，缺失时给出具体方法诊断。

主脚本顶层代码在每次函数调用重新执行，可能产生网络或缓存副作用；不能未经证据改成只初始化一次。持久 source/cache 操作与临时 scope 释放不同，见 [状态契约](state-and-effects.md)。数据跨引擎边界时必须序列化或受控复制，不暴露宿主对象原型和函数引用。
