# 书源数据模型

本文件是迁移时的字段总表。字段注释同时说明 Android 持久化形态和 TypeScript 运行时形态，不能只按 TypeScript 类型推断默认值、空值和覆盖规则。

本章列出的 `BookSource`、规则对象、`ExploreKind`、`ExploreStyle`、`SearchBook`、`BookChapter`、`Book`、`BookReadConfig` 和段评对象的每个公开字段都必须保留字段注释。注释至少说明业务含义、输入/输出类型、默认值或空值、是否持久化、覆盖权限和所属流程；未列入结构化模型的字段进入未知字段保留区，不得因为没有表单控件而丢失。

字段与实体的所有权、用户覆盖和订阅合并见[字段所有权与合并规则](source-field-ownership.md)；`BookSource` 的实体级方法行为和 RSS/替换规则边界见[书源相关实体边界](artifact-model.md)。字段表不能替代方法级兼容测试。

## 1. 书源原始与规范化模型

外部 JSON 的规则字段允许是规则对象，也允许是序列化后的 JSON 字符串。导入层先保留原始字段，再生成规范化对象。未知字段默认保留，是否交给运行时执行由能力检查决定，不能在导入时静默删除。

```ts
type RuleObject<T> = T | string | null
type SourceVariables = Record<string, string>

export interface BookSource {
  /** 书源唯一地址，也是 Android 数据库中的主键。导入时必须是非空字符串。 */
  bookSourceUrl: string
  /** 书源显示名称。JSON 导入允许缺省或空值并提示；JS 配置要求非空。构造默认空字符串。 */
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
  /** 登录入口地址；交互登录属于后续宿主能力，字段必须保留。 */
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
  /** 书源最后更新时间，毫秒时间戳，默认 0；不是应用保存版本。 */
  lastUpdateTime: number
  /** 最近响应时间，单位毫秒，Android 默认 180000，用于排序或统计。 */
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
  /** 段评规则；读取与交互均纳入完整能力清单，导入导出不能丢失。 */
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

```ts
export type NormalizedSource = Omit<
  BookSource,
  'ruleExplore' | 'ruleSearch' | 'ruleBookInfo' | 'ruleToc' | 'ruleContent' | 'ruleReview'
> & {
  /** 规范化后只允许对象或 null；原始字符串形态由 RawSource/codec 单独保留。 */
  ruleExplore?: ExploreRule | null
  ruleSearch?: SearchRule | null
  ruleBookInfo?: BookInfoRule | null
  ruleToc?: TocRule | null
  ruleContent?: ContentRule | null
  ruleReview?: ReviewRule | null
}
```

（设计契约，packages 尚无实现）`parseBookSourceJson` 只对 `bookSourceUrl` 调用非空校验；JSON 源缺名称不能误报为 Android 导入失败。JS 配置抽取同时要求 URL 与名称非空。URL 主键原样比较，不对尾斜杠、路径大小写或查询参数做规范化。`bookSourceType` 已知值为 0 到 4，未知值保留原文并报告能力诊断，未经兼容证据不静默改成文本类型。

### 字段通用约定

以下规则与逐字段注释共同构成契约，不只按 TypeScript 可选符号推断行为。

| 字段族 | 缺省、空值和类型 | 所有权、输出及保存 |
| --- | --- | --- |
| BookSource 可空文本 | 构造默认 null；raw 区分缺失和显式 null，执行时按字段判空 | 用户配置，导出保留；并非所有文本都是求值规则 |
| 六个 rule 对象 | 原始对象、JSON 字符串、null；执行快照仅对象或 null | codec 解析一次，保留原形态及未知字段 |
| 规则对象可空字符串 | 构造默认 null；空规则按[规则语言](rule-language.md)的具体入口转换 | 表单编辑、流程读取，不写回规则文本 |
| name/author/intro/kind/lastChapter/updateTime/wordCount 规则 | 产出文本或由流程连接的文本列表 | 按所属流程归一化和处理错误 |
| bookList/chapterList/summaryListRule/detailListRule/replyListRule | 节点或对象列表 | DOM 仅在本次解析使用 |
| bookUrl/coverUrl/tocUrl/chapterUrl/nextTocUrl/nextContentUrl/downloadUrls | 单 URL 或列表，空值回退由流程定义 | 使用 baseUrl/redirectUrl，网络策略由宿主执行 |
| isVolume/isVip/isPay | 规则结果使用 Android isTrue 转换，不能用 JS Boolean(string) 替代 | 写入章节布尔字段 |
| preUpdateJs/formatJs/webJs 等脚本 | 缺失不执行；非空需要相应宿主 | 参数和副作用由流程定义 |
| canReName | 非空配置开关，不求值，另需调用方权限 | 仅控制书名/作者覆盖 |
| ReviewRule.enabled / ContentRule.maxBatchSize | false / null；批量大于 1 启用，上限 50 | 其他段评字段构造默认 null |
| Book/Chapter 用户字段及阅读进度 | 应用提供，不制造阅读器默认设置 | 核心仅修改流程明确列出的字段 |
| infoHtml/tocHtml/origins | 临时响应 / 来源集合 | 不属于源导出；跨 HTTP 的 Set 变为有序数组 |

（设计契约，packages 尚无实现）`BookSource` 是交换模型；`NormalizedSource` 将 rule 字段限制为已解析对象或 null。`RawSource` 包含原文 text、输入 kind、来源 location 与诊断。未修改原文可逐字导出，修改后只承诺结构与未知值保留。

`BookSource` 不是全部书源数据。Android 的订阅实体 `RuleSub`、用户覆盖、source revision、检查状态、cookie/变量和缓存属于管理或运行时模型，不能塞进书源导出 JSON，也不能因未出现在本接口中而丢失。它们的所有权、保存和清理见 [书源状态与副作用](source-management-and-state.md)；检测状态见 [书源检测状态模型](source-check-state.md)。

ExploreKind 构造默认 title 为 `""`、type 为 `"url"`，其他可空字段为 null。ExploreStyle 默认值见字段注释；布局不影响规则结果。`ExploreStyle` 是 Android `FlexChildStyle`（`data/entities/rule/FlexChildStyle.kt`）的 TS 投影，字段名与默认值保持一致，跨端实现按能力解释，不承诺 Flexbox 行为。时间字段 time、latestChapterTime、lastCheckTime、durChapterTime、syncTime 使用毫秒；章节索引为零基，formatJs.index 为一基。非有限数值进入诊断，不能静默转成零。`Book.group`、`BookChapter.start/end` 与 `BookReadConfig.delTag` 在 Android 为 `Long`（`Book.kt` L508；`delTag` 为位掩码，实际值很小：hTag=2L/rubyTag=4L，L491-492）；TS `number` 可覆盖实际取值范围，但超过 2^53 的精确整数边界未在类型层提示，迁移和序列化需保留精度。

### 登录表单 RowUi

原实体 `data/entities/rule/RowUi.kt` 包含 name（显示名，默认空串）、type（text/password/button/label/toggle/select，默认 text）、action（动作）、chars（允许空成员的选项数组）、default（初值）、viewName（动态名称）、style（ExploreStyle，对应 Android `FlexChildStyle`）、key（提交键）、hint（提示）、value（值）、options（字符串列表）、countdown（倒计时整数）。除 name/type 外构造默认 null。原始 loginUi 完整保留；控件属于低优先级登录协议。countdown 单位和动态动作参数需要登录调用点对照后启用，不能仅从字段名推断。

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

export interface ExploreKind {
  /** 分类标题；普通文本格式的 :: 左侧。 */
  title: string
  /** 选中分类后交给发现流程的 URL；非 URL 控件或无链接分类可为空。 */
  url?: string | null
  /** 分类交互类型，Android 支持 url、text、button、toggle 和 select。 */
  type?: string
  /** 控件触发时使用的脚本或动作文本；执行由具备该能力的宿主负责。 */
  action?: string | null
  /** select、toggle 等控件可用的选项文本；允许空选项。 */
  chars?: Array<string | null> | null
  /** 控件的初始值；没有配置时由上层界面决定展示。 */
  default?: string | null
  /** 动态显示名规则或文本，是否执行取决于宿主能力。 */
  viewName?: string | null
  /** Android 分类控件的布局参数；跨端保留，Web 适配器按能力解释。 */
  style?: ExploreStyle | null
}

export interface ExploreStyle {
  /** Flex 增长比例，Android 默认 0。 */
  layout_flexGrow?: number
  /** Flex 收缩比例，Android 默认 1。 */
  layout_flexShrink?: number
  /** 交叉轴对齐方式，Android 默认 auto。 */
  layout_alignSelf?: string
  /** 基础宽度占比，Android 默认 -1。 */
  layout_flexBasisPercent?: number
  /** 当前控件前是否换行，Android 默认 false。 */
  layout_wrapBefore?: boolean
  /** 控件内部水平对齐方式，Android 默认 auto。 */
  layout_justifySelf?: string
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
  /** 书籍类型，使用 BookType；它与 BookSourceType 的取值语义不同。 */
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
  /** 创建或发现时间；Android 构造默认 System.currentTimeMillis()，数据库列无显式默认。 */
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
  /** 本地或 EPUB 章节起始位置；Android 为 Long，精度边界见 1 节末说明。 */
  start?: number | null
  /** 本地或 EPUB 章节结束位置；Android 为 Long，精度边界见 1 节末说明。 */
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
  /** 目录默认展开，Android 默认 true。 */
  tocExpanded?: boolean
  /** 翻页动画模式，null 表示跟随全局设置。 */
  pageAnim?: number | null
  /** 是否重新分段，Android 默认 false。 */
  reSegment?: boolean
  /** 图片样式，null 表示跟随全局。 */
  imageStyle?: string | null
  /** 正文是否使用净化替换规则；null 时按书源类型回退。 */
  useReplaceRule?: boolean | null
  /** 去除标签位掩码，Android 为 Long。 */
  delTag?: number
  /** TTS 引擎标识。 */
  ttsEngine?: string | null
  /** 超长章节拆分开关，Android 默认 true。 */
  splitLongChapter?: boolean
  /** 模拟阅读开关，Android 默认 false。 */
  readSimulating?: boolean
  /** 模拟阅读起始日期，ISO 文本。 */
  startDate?: string | null
  /** 模拟阅读起始章节。 */
  startChapter?: number | null
  /** 每日模拟章节数，Android 默认 3。 */
  dailyChapters?: number
  /** 音频片头秒数。 */
  openCredits?: number
  /** 音频片尾秒数。 */
  closeCredits?: number
  /** 音频播放模式。 */
  playMode?: number
  /** 音频播放速度。 */
  playSpeed?: number
  /** 是否使用全局音频跳过设置。 */
  useGlobalAudioSkip?: boolean
  /** 阅读页手动选择的替换规则 id。 */
  manualReplaceRuleIds?: number[]
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
  /** 自定义分组索引；Android 为 Long。 */
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
  /** 刷新书架时是否更新书籍信息，默认 true（Android 数据库默认 "1"）。 */
  canUpdate: boolean
  /** 手动排序值，默认 0。 */
  order: number
  /** 书源排序值，默认 0。 */
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
  /** 详情流程准备的目录响应临时缓存。 */
  tocHtml?: string | null
  /** 文件源下载地址，仅文件源流程使用。 */
  downloadUrls?: string[] | null
}
```

时间字段 `latestChapterTime`、`lastCheckTime`、`durChapterTime` 的 Android 构造默认是 `System.currentTimeMillis()`，而数据库列默认 `"0"`。`"不制造阅读器默认设置"`（字段通用约定表）约束的是核心库不要主动初始化这些字段，不是否定 Android 实体构造默认值；迁移时不能把任一默认当作权威。

JS 详情返回值只能覆盖明确允许的详情字段：`name`、`author`、`intro`、`coverUrl`、`kind`、`wordCount`、`latestChapterTitle`、`tocUrl`、`downloadUrls`、`variable` 和合法的 `type`。不得覆盖 `bookUrl`、阅读进度、用户自定义字段或缓存状态。
