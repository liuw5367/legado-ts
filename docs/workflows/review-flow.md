# 段评流程

段评（书评/章评）有三条兼容入口：声明式规则、JavaScript 结构化函数和旧式网页段评桥接。结构化入口读取段评统计、详情和回复，不把评论内容写入正文缓存；旧式入口返回隔离的浏览器页面和桥接会话，不伪装成 `ReviewPage`。书籍、章节和书源上下文必须固定在同一次请求中。

## JavaScript 函数配对与终态

导入脚本时，如果声明了 `getReviewSummary` 或 `getReviewDetail`，两者必须同时存在且都是函数；只声明其中一个是导入错误。`getReviewReplies` 是可选的第三层函数，声明时必须是函数，并且摘要/详情函数已经成对存在。没有声明这组函数的脚本不具备结构化段评能力，不能在调用详情时伪造空成功。

运行时要区分函数缺失和函数返回空值：

- `getReviewSummary` 缺失、返回空值或非数组时返回合法空摘要；
- `getReviewDetail` 是详情入口的必需函数，缺失或调用异常返回可诊断的能力/脚本错误；函数返回空值、格式无法解析或缺少 `items` 数组时返回空页；
- `getReviewReplies` 缺失时返回合法空页并保留能力诊断，返回空值时返回空列表；返回值不是 `{ items: [] }` 形状时报告格式错误。

这些终态在 package 层分别映射为 `empty`、`capability-missing`/`failed` 和带诊断的空结果，不能统一吞成“没有评论”。

## 统计入口

声明式源要求 `ruleReview.enabled`、`reviewSummaryUrl`、`summaryListRule`、`summaryParagraphIndexRule` 和 `summaryCountRule` 都非空；任一缺失时返回空统计。请求以章节 URL 为 `baseUrl`，绑定 `book` 和 `chapter`，响应为空时返回空结果。

解析列表时，段索引优先取 `summaryParagraphIndexRule`，不能解析时回退为列表下标加一；计数规则缺失或不能解析时为 0。只保留 `paragraphIndex != 0 && count > 0` 的条目，段数据优先取 `summaryParagraphDataRule`，再回退到索引表达式结果或索引文本。同一段索引重复出现时，后一个条目覆盖前一个条目。

JavaScript 源调用可选的 `getReviewSummary({ chapter, book })`。函数缺失、返回空或不是数组时返回空统计；每个元素必须有可解析的正数段索引（兼容 `-1` 特殊段）和正数 `count`，`paraData` 缺失时使用段索引文本。

## 详情分页

声明式详情要求规则启用、`reviewDetailUrl`、`detailListRule` 和 `detailContentRule` 都非空。第 1 页不接受游标；后续页必须配置 `reviewDetailNextPageUrl`，并提交上一次响应签发的游标。游标绑定书籍 URL、章节索引、书源 key、规则哈希、段索引和段数据，跨书、跨章节、规则变化或页码不一致都拒绝使用。只有本页有条目且下一页地址非空时才签发下一游标，`hasMore` 同时要求这两个条件。

每次声明式请求都把 `paraIndex`、`paraData` 和 `page` 放入局部变量，并以章节 URL 解析相对地址。详情列表提取失败会记录规则错误；下一页规则为空则没有更多页。条目字段按 detail 规则逐项提取，头像相对当前响应 URL 转绝对地址，评论内容支持文本或协议对象；协议对象可以携带 `text`、`replyToName`、`img`、`audio`、`time`、`likeCount` 和 `replyCount`，只有媒体而无文本时仍保留该条目。

JavaScript 源不使用分页游标，调用 `getReviewDetail({ chapter, book, paraIndex, paraData, page })`。函数缺失或调用异常是能力/脚本错误；函数返回空值、无法解析的对象或缺少数组 `items` 时返回空页，可选 `nextPageUrl` 只用于结果内的下一页提示。详情项缺少非空 `content` 会被丢弃，`replies` 会在同一项中展开。JS 结构化结果中的相对头像、图片和音频地址按 `chapter.url` 解析，声明式响应则按本次响应的最终 URL 解析。

## 回复入口

声明式回复要求启用规则、`reviewQuoteUrl`、`replyListRule` 和 `replyContentRule`；条件不满足时返回空页。请求参数除 `paraIndex`、`paraData`、`page` 外，还必须包含非空 `reviewId`，并把这些参数传给 `AnalyzeUrl`。响应为空直接报错；列表规则为空返回空列表；列表非空但没有一个可解析回复时报告解析为空。`hasMore` 仅由本页是否有回复决定。

JavaScript 源调用可选的 `getReviewReplies({ chapter, book, paraIndex, paraData, reviewId, page })`。函数缺失返回空页并保留能力诊断，函数返回空值返回空列表；返回值必须是包含 `items` 数组的对象，否则报告格式错误。回复分页没有游标，是否继续由本页 `items` 非空决定；JS 回复中的相对媒体地址同样按 `chapter.url` 解析，声明式回复按响应最终 URL 解析。

## 结果与错误边界

结构化段评的空配置、合法空列表、摘要函数缺失和可选回复函数缺失是空结果；缺少必需详情函数、必需请求参数、无效游标、空的声明式回复 body、规则执行异常和错误的 JavaScript 返回形态必须保留为可诊断错误，不能统一吞成“没有评论”。详情游标使用有界缓存并在请求完成后保留已签发状态，适配器需要提供过期和并发访问保护。

结构化结果至少包含 `items`、`hasMore`、可选 `nextCursor`、段索引和请求诊断；媒体 URL 的基准地址必须随入口记录：声明式为 HTTP 响应最终 URL，JS 为章节 URL，旧式页面中的图片由书籍 URL 交给图片代理处理。段评读取不改变书籍、章节或正文的持久化状态。

## 旧式网页段评桥接

旧式入口只接受书源链接中的受支持点击脚本：`getDP(段索引, 段数据)` 或 `getZP(章节索引)`。宿主调用 `openLegacyReview` 时固定 `url`、`index`、`src` 和 frame origin，执行书源脚本并要求返回浏览器页面 HTML；空页面或不支持的点击脚本必须报错。页面中的 HEIF/HEIC 图片按书籍 URL 重写到图片代理。

成功打开后生成随机会话 `id` 和 `nonce`，会话绑定书籍 URL、章节索引、书源 key、frame origin 和页面内容，Android 兼容 TTL 为 2 小时，缓存最多保留 16 个会话。`legacyReviewPage?id&nonce` 只在会话有效且 nonce 匹配时返回页面，并注入受限桥接；页面响应使用 no-store、no-referrer 和 sandbox/CSP，不能把原始 HTML 直接塞进 `srcdoc`。

页面通过桥接调用 `runLegacyReview`。宿主必须限制脚本非空且不超过 64 KiB，重新校验会话、书源 key 和书籍/章节上下文，再以 `book`、`chapter` 和结果上下文执行脚本；返回的 HTML 或带 `html` 字段的 JSON 仍要经过图片重写。会话过期、nonce 不匹配、书源变更和脚本错误都返回可诊断错误，不得降级为空结构化评论页。
