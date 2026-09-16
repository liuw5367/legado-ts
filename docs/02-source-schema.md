# 书源数据模型

本文件是迁移时的字段总表。字段注释同时说明 Android 持久化形态和 TypeScript 运行时形态，不能只按 TypeScript 类型推断默认值、空值和覆盖规则。

## 1. 书源原始与规范化模型

外部 JSON 的规则字段允许是规则对象，也允许是序列化后的 JSON 字符串。导入层先保留原始字段，再生成规范化对象。未知字段默认保留，是否交给运行时执行由能力检查决定，不能在导入时静默删除。

```ts
type RuleObject<T> = T | string | null
type SourceVariables = Record<string, string>

export interface BookSource {
  /** 书源唯一地址，也是 Android 数据库中的主键。导入时必须是非空字符串。 */
  bookSourceUrl: string
  /** 书源显示名称。导入时必须是非空字符串。 */
  bookSourceName: string
  /** 书源分组；空值表示未分组。 */
  bookSourceGroup?: string | null
  /** 书源类型：0 文本、1 音频、2 图片、3 文件下载、4 视频。 */
  bookSourceType: 0 | 1 | 2 | 3 | 4
  /** 详情页 URL 正则。搜索响应 URL 命中时按详情页解析。 */
  bookUrlPattern?: string | null
  /** 手动排序值，默认 0。 */
  customOrder: number
  /** 是否参与普通搜索和详情流程，默认 true。 */
  enabled: boolean
  /** 是否参与发现流程，默认 true。 */
  enabledExplore: boolean
  /** 书源级 JavaScript 库文本。 */
  jsLib?: string | null
  /** 是否自动保存请求 Cookie；Kotlin 构造默认 true，数据库列默认 false，字段本身允许为空。 */
  enabledCookieJar?: boolean | null
  /** 并发率配置文本，由宿主限流器解释。 */
  concurrentRate?: string | null
  /** 默认请求头文本，通常是 JSON 对象。 */
  header?: string | null
  /** 登录入口地址。复杂登录 UI 不属于第一版核心运行时。 */
  loginUrl?: string | null
  /** 登录 UI 配置或兼容标记。 */
  loginUi?: string | null
  /** 登录状态检测脚本。 */
  loginCheckJs?: string | null
  /** 返回解密图片 bytes 的脚本。 */
  coverDecodeJs?: string | null
  /** 书源备注，不参与规则执行。 */
  bookSourceComment?: string | null
  /** 书源自定义变量的说明文本。 */
  variableComment?: string | null
  /** 书源最后更新时间，默认 0，用于导入比较和排序。 */
  lastUpdateTime: number
  /** 最近响应时间，Android 默认 180000，用于排序或统计。 */
  respondTime: number
  /** 智能排序权重，默认 0。 */
  weight: number
  /** 发现入口 URL。 */
  exploreUrl?: string | null
  /** 发现结果筛选表达式。 */
  exploreScreen?: string | null
  /** 发现列表规则；规范化后为 ExploreRule。 */
  ruleExplore?: RuleObject<ExploreRule>
  /** 搜索入口 URL。 */
  searchUrl?: string | null
  /** 搜索列表规则；规范化后为 SearchRule。 */
  ruleSearch?: RuleObject<SearchRule>
  /** 书籍详情页规则；规范化后为 BookInfoRule。 */
  ruleBookInfo?: RuleObject<BookInfoRule>
  /** 目录页规则；规范化后为 TocRule。 */
  ruleToc?: RuleObject<TocRule>
  /** 正文页规则；规范化后为 ContentRule。 */
  ruleContent?: RuleObject<ContentRule>
  /** 段评规则；第一版可以作为可选能力，但导入导出不能丢失。 */
  ruleReview?: RuleObject<ReviewRule>
  /** 纯 JavaScript 书源脚本。非空时优先走 JS 源流程。 */
  mainJs?: string | null
  /** 是否监听事件来执行正文回调规则，默认 false。 */
  eventListener: boolean
  /** 是否显示由书源控制的自定义按钮，默认 false。 */
  customButton: boolean
  /** 未知字段由导入层保留，运行时不对其做结构化假设。 */
  [key: string]: unknown
}
```

`bookSourceUrl` 和 `bookSourceName` 在数据库模型中可以有空字符串默认值，但导入协议仍要求它们非空。`bookSourceType` 必须限制在 0 到 4，非法值应进入诊断或回退策略，不能当作普通文本类型悄悄吞掉。

## 2. 列表与搜索规则

```ts
export interface BookListRule {
  /** 列表节点规则；空值表示不能从列表提取。 */
  bookList?: string | null
  /** 书名字段规则。 */
  name?: string | null
  /** 作者字段规则。 */
  author?: string | null
  /** 简介字段规则。 */
  intro?: string | null
  /** 分类字段规则。 */
  kind?: string | null
  /** 最新章节字段规则。 */
  lastChapter?: string | null
  /** 更新时间字段规则。 */
  updateTime?: string | null
  /** 详情页地址字段规则。空值时由流程回退到当前基准 URL。 */
  bookUrl?: string | null
  /** 封面地址字段规则。相对地址按响应 URL解析。 */
  coverUrl?: string | null
  /** 字数文本字段规则。 */
  wordCount?: string | null
}

export interface ExploreRule extends BookListRule {
  /** 发现流程复用 BookListRule 字段，不增加额外字段。 */
}

export interface SearchRule extends BookListRule {
  /** 搜索结果校验关键字，具体筛选还受精准搜索设置影响。 */
  checkKeyWord?: string | null
}
```

`bookList` 的 `-`、`+` 前缀只属于流程控制，不是选择器语法。搜索流程中 `-` 会在列表解析完成后反转结果；目录流程的 `-` 语义不同，见目录文档，不能共用一条解释。

## 3. 详情、目录和正文规则

```ts
export interface BookInfoRule {
  /** 详情初始化规则，返回值替换后续字段的输入内容。 */
  init?: string | null
  /** 书名规则。是否覆盖已有书名由调用方的重命名开关决定。 */
  name?: string | null
  /** 作者规则。 */
  author?: string | null
  /** 简介规则。 */
  intro?: string | null
  /** 分类规则，列表结果最终以逗号连接。 */
  kind?: string | null
  /** 最新章节规则。 */
  lastChapter?: string | null
  /** 更新时间规则。 */
  updateTime?: string | null
  /** 封面地址规则，相对地址按详情响应 URL解析。 */
  coverUrl?: string | null
  /** 目录地址规则，使用 URL 模式读取，空值回退 baseUrl。 */
  tocUrl?: string | null
  /** 字数规则。 */
  wordCount?: string | null
  /** 非空即表示详情允许重命名，不执行这条规则求值。 */
  canReName?: string | null
  /** 文件源下载地址规则，使用 URL 列表读取。 */
  downloadUrls?: string | null
}

export interface TocRule {
  /** 请求目录前执行的 JavaScript。 */
  preUpdateJs?: string | null
  /** 章节列表节点规则，支持目录专用的 +/- 控制前缀。 */
  chapterList?: string | null
  /** 章节标题规则。 */
  chapterName?: string | null
  /** 章节地址规则。 */
  chapterUrl?: string | null
  /** 章节标题格式化脚本。index 从 1 开始，gInt 初始为 0。 */
  formatJs?: string | null
  /** 卷节点判断规则。 */
  isVolume?: string | null
  /** VIP 节点判断规则。 */
  isVip?: string | null
  /** 已购买节点判断规则。 */
  isPay?: string | null
  /** 章节更新时间或附加信息规则。 */
  updateTime?: string | null
  /** 下一目录页地址规则，可返回多个地址。 */
  nextTocUrl?: string | null
}

export interface ContentRule {
  /** 正文内容规则。 */
  content?: string | null
  /** 副文规则，可用于歌词、弹幕或正文附加内容。 */
  subContent?: string | null
  /** 从正文中提取并覆盖章节标题的规则。 */
  title?: string | null
  /** 正文下一页地址规则。 */
  nextContentUrl?: string | null
  /** 请求页面后在 WebView 中执行的脚本。 */
  webJs?: string | null
  /** WebView 资源嗅探正则。 */
  sourceRegex?: string | null
  /** 所有正文分页合并后的替换规则。 */
  replaceRegex?: string | null
  /** 图片样式配置。 */
  imageStyle?: string | null
  /** 返回图片 bytes 的二次解密脚本。 */
  imageDecode?: string | null
  /** 购买操作，可以是脚本或包含 {{js}} 的 URL。 */
  payAction?: string | null
  /** 事件回调脚本。 */
  callBackJs?: string | null
  /** 常规源批量正文规则。 */
  contentBatch?: string | null
  /** 批量正文上限；大于 1 才启用，运行时最多取 50。 */
  maxBatchSize?: number | null
}
```

## 4. 段评规则

```ts
export interface ReviewRule {
  /** 段评入口地址。 */
  reviewUrl?: string | null
  /** 段评发布者头像规则。 */
  avatarRule?: string | null
  /** 段评内容规则。 */
  contentRule?: string | null
  /** 段评发布时间规则。 */
  postTimeRule?: string | null
  /** 获取段评回复地址规则。 */
  reviewQuoteUrl?: string | null
  /** 点赞地址规则，属于可选交互能力。 */
  voteUpUrl?: string | null
  /** 点踩地址规则，属于可选交互能力。 */
  voteDownUrl?: string | null
  /** 发送段评地址规则，属于可选交互能力。 */
  postReviewUrl?: string | null
  /** 发送回复地址规则，属于可选交互能力。 */
  postQuoteUrl?: string | null
  /** 删除段评地址规则，属于可选交互能力。 */
  deleteUrl?: string | null
  /** 是否启用段评统计与详情读取，Android 默认 false。 */
  enabled: boolean
  /** 段评统计请求地址。 */
  reviewSummaryUrl?: string | null
  /** 段评统计列表规则。 */
  summaryListRule?: string | null
  /** 段落索引规则，-1 表示章评，正数从 1 表示正文段落。 */
  summaryParagraphIndexRule?: string | null
  /** 段落数据规则。 */
  summaryParagraphDataRule?: string | null
  /** 段评数量规则。 */
  summaryCountRule?: string | null
  /** 段评详情请求地址。 */
  reviewDetailUrl?: string | null
  /** 段评详情下一页地址规则。 */
  reviewDetailNextPageUrl?: string | null
  /** 段评详情列表规则。 */
  detailListRule?: string | null
  /** 段评 ID 规则。 */
  detailIdRule?: string | null
  /** 段评头像规则。 */
  detailAvatarRule?: string | null
  /** 段评昵称规则。 */
  detailNameRule?: string | null
  /** 段评徽章规则。 */
  detailBadgeRule?: string | null
  /** 段评内容协议规则。 */
  detailContentRule?: string | null
  /** 子评论列表规则。 */
  replyListRule?: string | null
  /** 子评论 ID 规则。 */
  replyIdRule?: string | null
  /** 子评论头像规则。 */
  replyAvatarRule?: string | null
  /** 子评论昵称规则。 */
  replyNameRule?: string | null
  /** 子评论徽章规则。 */
  replyBadgeRule?: string | null
  /** 子评论内容协议规则。 */
  replyContentRule?: string | null
}
```

## 5. 运行时输出模型

`SearchBook` 的持久化字段、临时 HTML 缓存和合并来源集合必须分开标记。`variable` 在 Android 实体中是 JSON 字符串，在 TypeScript 运行时可规范化为对象，但导出时必须能还原原始兼容形态。

```ts
export interface SearchBook {
  /** 详情页地址，也是同一书源内去重键。 */
  bookUrl: string
  /** 书源地址。 */
  origin: string
  /** 书源名称。 */
  originName: string
  /** 书籍类型，使用 BookType，而不是 BookSourceType。 */
  type: number
  /** 书名，缺失时条目被丢弃。 */
  name: string
  /** 作者。 */
  author: string
  /** 分类。 */
  kind?: string | null
  /** 封面地址。 */
  coverUrl?: string | null
  /** 简介。 */
  intro?: string | null
  /** 字数文本。 */
  wordCount?: string | null
  /** 最新章节标题。 */
  latestChapterTitle?: string | null
  /** 目录地址。 */
  tocUrl: string
  /** 创建或发现时间。 */
  time: number
  /** 书源变量，Android 持久化为 JSON 字符串。 */
  variable?: string | SourceVariables | null
  /** 书源排序值。 */
  originOrder: number
  /** 章节字数原始文本。 */
  chapterWordCountText?: string | null
  /** 当前章节字数，缺省为 -1。 */
  chapterWordCount: number
  /** 响应时间，缺省为 -1。 */
  respondTime: number
  /** 详情页响应临时缓存，不进入持久化导出。 */
  infoHtml?: string | null
  /** 目录页响应临时缓存，不进入持久化导出。 */
  tocHtml?: string | null
  /** 合并来源集合，保留首次来源并追加其他来源地址。 */
  origins: Set<string>
}

export interface BookChapter {
  /** 章节地址；卷节点可以是标题加零基索引的占位地址。 */
  url: string
  /** 章节标题。 */
  title: string
  /** 是否为卷节点。 */
  isVolume: boolean
  /** 拼接相对地址时使用的基准地址。 */
  baseUrl: string
  /** 所属书籍地址。 */
  bookUrl: string
  /** 目录中的零基索引。 */
  index: number
  /** 是否 VIP。 */
  isVip: boolean
  /** 是否已购买。 */
  isPay: boolean
  /** 音频真实地址。 */
  resourceUrl?: string | null
  /** 更新时间或其他附加信息。 */
  tag?: string | null
  /** 本章节字数。 */
  wordCount?: string | null
  /** 本地或 EPUB 章节起始位置。 */
  start?: number | null
  /** 本地或 EPUB 章节结束位置。 */
  end?: number | null
  /** EPUB 当前章节 fragmentId。 */
  startFragmentId?: string | null
  /** EPUB 下一章节 fragmentId。 */
  endFragmentId?: string | null
  /** 章节变量，Android 持久化为 JSON 字符串。 */
  variable?: string | SourceVariables | null
  /** 标题段评图片或视频封面地址。 */
  imgUrl?: string | null
}
```

## 6. Book 与覆盖边界

`Book` 同时包含书源数据、用户覆盖数据、阅读进度和缓存状态。`source-core` 只需要其中的书源流程字段，不能通过通用对象合并覆盖用户字段和阅读状态。

```ts
export interface BookReadConfig {
  /** 刷新和持久化目录时使用的顺序开关。 */
  reverseToc?: boolean
  /** 只改变目录界面展示顺序，不改变刷新输入顺序。 */
  reverseTocDisplay?: boolean
  /** 阅读器或应用层的其他配置，核心库只透传。 */
  [key: string]: unknown
}

export interface Book {
  /** 详情页地址。 */
  bookUrl: string
  /** 目录页地址。 */
  tocUrl: string
  /** 书源地址或本地书源标记。 */
  origin: string
  /** 书源名称。 */
  originName: string
  /** 书名。 */
  name: string
  /** 作者。 */
  author: string
  /** 书源分类。 */
  kind?: string | null
  /** 用户自定义分类。 */
  customTag?: string | null
  /** 书源封面。 */
  coverUrl?: string | null
  /** 用户自定义封面。 */
  customCoverUrl?: string | null
  /** 书源简介。 */
  intro?: string | null
  /** 用户自定义简介。 */
  customIntro?: string | null
  /** 本地书籍字符集。 */
  charset?: string | null
  /** BookType 类型。 */
  type: number
  /** 自定义分组索引。 */
  group: number
  /** 最新章节标题。 */
  latestChapterTitle?: string | null
  /** 最新章节标题更新时间。 */
  latestChapterTime: number
  /** 最近一次更新书籍信息的时间。 */
  lastCheckTime: number
  /** 最近一次发现新章节的数量。 */
  lastCheckCount: number
  /** 目录总数。 */
  totalChapterNum: number
  /** 当前阅读章节标题。 */
  durChapterTitle?: string | null
  /** 当前阅读章节索引。 */
  durChapterIndex: number
  /** 当前卷索引。 */
  durVolumeIndex: number
  /** 当前章节在卷内的索引。 */
  chapterInVolumeIndex: number
  /** 当前阅读位置，通常是首行字符索引。 */
  durChapterPos: number
  /** 最近一次打开正文的时间。 */
  durChapterTime: number
  /** 字数文本。 */
  wordCount?: string | null
  /** 刷新书架时是否更新书籍信息。 */
  canUpdate: boolean
  /** 手动排序值。 */
  order: number
  /** 书源排序值。 */
  originOrder: number
  /** 书籍变量，Android 持久化为 JSON 字符串。 */
  variable?: string | SourceVariables | null
  /** 阅读器设置，由上层应用拥有；目录顺序使用其中的 reverseToc，展示顺序使用 reverseTocDisplay。 */
  readConfig?: BookReadConfig
  /** 同步时间。 */
  syncTime: number
  /** 保存到本地的网络封面地址。 */
  persistedCoverUrl?: string | null
  /** 详情和目录响应的临时缓存。 */
  infoHtml?: string | null
  tocHtml?: string | null
  /** 文件源下载地址，仅文件源流程使用。 */
  downloadUrls?: string[] | null
}
```

JS 详情返回值只能覆盖明确允许的详情字段：`name`、`author`、`intro`、`coverUrl`、`kind`、`wordCount`、`latestChapterTitle`、`tocUrl`、`downloadUrls`、`variable` 和合法的 `type`。不得覆盖 `bookUrl`、阅读进度、用户自定义字段或缓存状态。
