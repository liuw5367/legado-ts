# 兼容性矩阵

本矩阵同时记录目标承诺、Android 事实证据和 TypeScript 当前完成度。它是迁移验收清单，不是“已经兼容”的声明。当前仓库已包含 `@legado/source-core` / `@legado/source-node` 实现与自动测试；尚未标记为已验证的 TS 项仍不能被当作完成。完整能力类别及需要补写的规格见 [书源能力清单与审核决策](../standard/capability-inventory.md)。

状态含义：

- `目标必须兼容`：已确定的核心行为承诺。
- `声明存在时必须兼容`：书源声明该能力后，运行时必须保持其契约；没有声明时不强制启用。
- `目标宿主能力`：由宿主能力标记决定，核心库需要可诊断地降级；目标仍是完整支持。
- `低优先待实现`：排在后续实施，不代表决定放弃。
- `低优先待核实`：源码有字段，但尚无足够执行证据定义兼容行为。
- `目标设计`：上层产品能力，不是 Android 运行时兼容项。

## 五维记录格式

矩阵中的一行只是阅读摘要，不能把“有 Android 证据”误读为“TypeScript 已实现”。正式记录必须把下面五个维度分开保存；同一能力可以有 `evidence=source`，但仍然是 `implementation=absent`、`execution=not-run`。

| 维度 | 允许值 | 含义 |
| --- | --- | --- |
| `evidence` | `source` / `test-run` / `design` | 证据来自 Android 源码、已执行测试，或 Web/TypeScript 设计 |
| `spec` | `defined` / `blocked` | 兼容规则是否已经写成可执行规格；缺少关键事实时必须为 `blocked` |
| `implementation` | `absent` / `partial` / `implemented` | TypeScript runtime 或宿主适配器的实现程度 |
| `execution` | `not-run` / `pass` / `fail` | 对应 fixture/golden 是否实际执行，以及执行结果 |
| `priority` | `required` / `host` / `later` / `verify` | 兼容必需、宿主能力、后续实现或待核实 |

只有 `spec=defined`、`implementation=implemented` 且相关 fixture 的 `execution=pass`，才能在发布说明中称为“已验证兼容”。`target status` 仍用于表达产品承诺，但不替代上述字段。

未完成项、差异项和完成后的删除线记录统一维护在[书源运行时状态总览](../implementation/source-runtime-status.md)。本矩阵继续维护五维兼容证据；`implementation=absent/partial` 和 `execution=not-run` 的含义以状态总览为准。

当前 TS/Node 回归的执行证据集中在 `packages/source-core/tests/` 与 `packages/source-node/tests/`：构建后包入口、import/conformance manifest 和真实书源离线回放均已实际执行。Android 当前快照也已运行完整 app JVM 单测集，但 Android 同输入 golden 仍未逐条生成。因此本矩阵中的“实现见 source-core/source-node”只表示实现和 TS 证据存在，不能单独改写为 Android 兼容已验证。

2026-09-28 Android 执行证据使用页面快照提交 `32a87b253e7cc28273c3850de86242caac83f1fd`，Android Studio JBR 21，临时 SDK `platforms;android-36` / `build-tools;36.0.0`；`./gradlew :app:testDebugUnitTest` 共 1,948/1,948 通过（399 个测试类）。书源专项的规则 DOM、JS source、目录回写、批量正文和搜索分页测试共 48/48 通过。该证据只更新 Android `test-run` 状态；没有把未执行的跨端 fixture/golden 改为 `pass`。长期规则和源码引用仍以 `62003ce732a7e30602754d28996da7f98b9ea296` 为基线。

| 能力 | 目标状态 | Android 证据 | TypeScript 当前状态 |
| --- | --- | --- | --- |
| 书源 JSON 对象和数组 | 目标必须兼容 | `BookSourceImport`、`BookSource.kt` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `sourceUrls` 外层展开和远程来源限制 | 目标必须兼容 | `BookSourceImport`、导入流程 | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `RuleSub` 自动刷新时间与类型分支 | 目标设计；兼容 adapter 需保留 Android 事实 | `RuleSub.kt`、`RuleUpdate.kt` | `type=0/1/2` 已登记；`type=3` 注释/实现有差异，待决策与 fixture |
| `RuleSub.silentUpdate` 直接采用与 Web 三方确认 | 目标设计；两种模式必须可区分 | `RuleUpdate.kt`、`SourceHelp.kt`、订阅流程 | Android-compatible 与 web-safe 均未实现，待对照 fixture |
| JS 源 `config` 和旧版 `source` | 目标必须兼容 | `JsSourceConfigTest` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 默认旧式选择器 | 目标必须兼容 | `AnalyzeByJSoupDomTest`、`AnalyzeByJSoup` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `@CSS:`、`@XPath:`、`@Json:` | 目标必须兼容 | `AnalyzeRule`、规则测试 | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| CSS、XPath、JSONPath 规则链 | 目标必须兼容 | `AnalyzeRule`、解析器源码 | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `&&`、`\|\|`、`%%` | 目标必须兼容 | `AnalyzeRule.splitRule`、规则测试 | 规则链求值已实现（`compileRule`/`evaluateRule`）；对照 fixture/golden 执行状态见测试基线 |
| 索引、负索引、范围、负步长和排除 | 目标必须兼容 | `AnalyzeByJSoupDomTest`、`AnalyzeRule` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `$n`、`##match##replace`、`@put/@get`、`{{}}` | 目标必须兼容 | `AnalyzeRule`、变量规则源码 | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 连续 `<js>` 和 `@js:` | 目标必须兼容 | `AnalyzeRule`、JS 规则测试 | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `@webjs:` | 目标宿主能力 | `AnalyzeRule`、WebView 相关流程 | 未实现 runtime，需 capability 设计 |
| URL 页码、URL options、表单编码、URL JS 顺序和 XML 响应后处理 | 目标必须兼容 | `AnalyzeUrl`、`AnalyzeUrlNetworkOptionsTest` | `source-core` 请求运行时及测试覆盖页码、`@js` 先于 `{{}}`、origin `baseUrl`、未知 method 回退 GET、XML 补声明优先于 `bodyJs`；Android golden 尚未执行 |
| `concurrentRate` 书源级限流 | 目标必须兼容 | `ConcurrentRateLimiter`、`AnalyzeUrl` | `SourceRateLimiter` 已支持普通请求固定窗口、取消、`putConcurrent` 更新及 `ajaxAll(..., true)` bridge 旁路（`source-rate-limiter.test.ts`、`source-request-host.test.ts`）；Android 首次非法值 fallback/诊断和源编辑删除生命周期仍未对齐 |
| 高频 JavaScript bridge（章节数字、字节数组、摘要/HMAC） | 目标必须兼容 | `JsExtensions.toNumChapter`、`strToBytes/bytesToStr`、`JsEncodeUtils` | `source-core`/Node 已实现 `toNumChapter`、字符集字节往返、Base64/Hex 字节数组、摘要 Base64、HMAC Hex/Base64，并有 QuickJS 回归；繁简词库、WebView、浏览器交互和登录状态返回显式 `capability-missing`，Android golden 尚未执行 |
| Cookie、普通 source header、已保存登录头和最终域名 | 目标必须兼容 | `AnalyzeUrl`、`BaseSource.getHeaderMap()`、登录头站点判断 | CookieJar、静态/动态 source header 与 `loginCheckJs` 已实现；bridge 子请求跳过动态 source header。TS 没有 Android 独立登录凭据存储及同站自动注入，Cookie 域和登录凭据隔离仍待 fixture |
| `@js` 改写 URL 后的 Android 登录头站点限制 | 目标必须兼容 | `AnalyzeUrl` 初始 URL 的登录头判断 | Android 只检查初始 URL；TS 当前不持有独立登录头，因此没有等价自动注入/隔离。未来实现时应单独评估 Android 行为与更严格安全策略 |
| 默认 User-Agent | 目标必须兼容 | `BaseSource.getHeaderMap()`、`AppConfig.userAgent` | 核心从 `NetworkHost.defaultUserAgent` 接收平台默认值，Node 可用 `NodeNetworkOptions.defaultUserAgent` 配置；未配置时仍使用 HTTP 客户端默认值，未做 Android golden |
| 复杂登录 UI、验证码和多步骤登录 | 低优先待实现 | `BookSource` 登录字段、WebView 流程 | 未实现 runtime，需登录交互规格 |
| 搜索、详情、目录、正文流程 | 目标必须兼容 | `WebBook`、四类流程测试 | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `preUpdateJs` 的 `refreshTocUrl()` / `reGetBook()` 与无详情字段规则回退 | 目标必须兼容 | `AnalyzeRule.kt`、`BookInfo.kt`、`WebBook.kt` | `source-core` 通过受限 workflow action 实现详情刷新、书名作者精确重搜、RuleData 变量回写及 book 回写；Node 集成用例已执行，Android golden 尚未执行；TS 助手预算 30 秒，Android 上限 30 分钟 |
| 目录和正文分页、循环保护 | 目标必须兼容 | `BookChapterList`、`WebBook` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 声明式正文内置格式、HTML4 解码、特殊样式保护和图片 URL 归一化 | 目标必须兼容 | `BookContent.kt`、`HtmlFormatter.kt`、`AppConfig.adaptSpecialStyle` | source-core 已实现格式化、图片资源和标题 `imgUrl` 投影；Android golden 尚未执行|
| `ruleContent.subContent` 在线文本追加、歌词和弹幕 | 声明存在时必须兼容 | `BookContent.kt` 的 `subContent` 分支 | source-core 按首次正文响应上下文提取；在线文本原文追加，音视频结果写入章节变量并通过 `ChapterContent.auxiliary` 返回；Node 集成用例已执行，Android golden 尚未执行；TS 取消语义差异见 D11|
| 搜索精准匹配中的书名、作者和分类 | 目标必须兼容 | `SearchModel` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 目录 `-` 前缀和 `reverseToc` 组合 | 目标必须兼容 | `BookChapterList` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `canReName` 调用权限与非空配置判断 | 目标必须兼容 | `BookInfo` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 卷节点空正文和非卷空正文回退 | 目标必须兼容 | `WebBook`、`JsSourceBookTest` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| JS 源返回值和字段归一化 | 目标必须兼容 | `JsSourceMarshallerTest`、`JsSourceEngineTest` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `getContentBatch` 和 `contentBatch` | 声明存在时必须兼容 | `JsSourceConfig`、`BookContent.kt`、`JsSourceBook.kt`、`BatchContentContext.kt` | `loadChapterContentBatch` 已实现 JS/声明式入口、50 章切批、index/唯一 URL 识别、replaceRegex、逐章宿主回存和缺章兜底；core 与 QuickJS 定向测试通过，Android golden 待执行 |
| 结构化段评摘要、详情和回复 | 声明存在时必须兼容 | `ReviewController`、`ReviewRuleParser`、`JsSourceReview` | 读取规格见[段评流程](../flows/review-flow.md)，runtime 未实现，待 fixture |
| 旧式段评网页桥接 | 受支持的 `getDP/getZP` 链接必须兼容 | `ReviewController`、`HttpServer`、`ReviewWebApiContractTest` | 会话 nonce、2 小时 TTL、64 KiB 脚本上限、CSP/sandbox 和图片重写见[段评流程](../flows/review-flow.md)，runtime 未实现，待安全 fixture |
| WebView 真实页面行为 | 目标宿主能力 | WebView 相关流程 | 需 adapter 和 capability error |
| 发现分类、`infoMap` 与发现列表 | 目标必须兼容 | `BookSourceExtensions`、`ExploreKind`、`WebBook.exploreBookAwait` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 图片与封面解密 | 声明存在时必须兼容 | `ImageUtils`、`ContentRule.imageDecode`、`BookSource.coverDecodeJs` | `decodeImage` 已实现规则选择、QuickJS bytes 往返、封面流式输入兼容、错误和取消；下载/缓存由宿主负责，Android golden 待执行 |
| 付费动作与购买后刷新 | 低优先待实现 | `ContentRule.payAction`、`ReadBookActivity.payAction` | 未实现 runtime，待交互规格 |
| 段评写入、投票和删除 | 低优先待核实（写入流程为目标设计） | `ReviewRule` 有字段；已核对的 `ReviewController` 入口主要是读取 | 写入流程为 Web 目标设计（见 conformance-tests ACTION-002），不宣称 Android 等价 |
| 书源事件和自定义按钮 | 目标宿主能力 | `SourceCallBack`、`BookSource.eventListener/customButton` | 未实现 runtime，待事件协议规格 |
| 音频、图片、视频和文件结果 | 目标必须兼容 | `BookSource.bookSourceType`、`Book`、`BookChapter`、相关调用点 | 音视频声明式正文跳过文本格式化，`subContent` 歌词/弹幕已写入章节变量并返回辅助结果；图片解密由 `decodeImage` 执行，实际下载/缓存及文件下载由宿主负责 |
| 编辑器预览与诊断 | 目标设计 | `modules/web` 配置和测试 | 仅规划，未实现独立编辑器 |

## Android 证据索引

能力 ID 以 [能力清单的稳定索引](../standard/capability-inventory.md#稳定能力索引) 为准。上表是阅读摘要，不能替代逐字段/逐方法审计。TypeScript 实现已存在；未跑的对照案例仍为 `execution=not-run`。“目标必须兼容”不等于规格已完整。订阅、状态隔离与部署策略是 Web 目标设计，分别由 SUB、STATE、DEP 案例验证。

补充能力 CAP-ENCODE、CAP-ARCHIVE、CAP-FONT、CAP-CONCURRENCY 已登记原方法，其逐重载完成度及阻塞条件见[能力清单](../standard/capability-inventory.md)；不因原表缺行而排除。每项记录五个独立维度：evidence（source/test-run/design）、spec（defined/blocked）、implementation（absent/implemented）、execution（not-run/pass/fail，按宿主）、priority。evidence=source 表示 Android 源码证据，test-run 表示测试已执行，design 表示目标设计。只有具体案例实际通过才写 pass。

矩阵中的简称按以下索引解析。建立 fixture 时，除了填写索引键，还必须填写具体源码行或测试用例名称；仅填写类名不能证明某一条行为已经被验证。

| 索引 | 行为源码 | 可执行测试 |
| --- | --- | --- |
| `import` | `app/src/main/java/io/legado/app/ui/association/BookSourceImport.kt`、`ImportBookSourceViewModel.kt`、`app/src/main/java/io/legado/app/help/source/SourceHelp.kt` | `app/src/test/java/io/legado/app/ui/association/BookSourceImportTest.kt` |
| `schema` | `app/src/main/java/io/legado/app/data/entities/BookSource.kt`、`Book.kt`、`BookChapter.kt`、`SearchBook.kt` 及 `data/entities/rule/` | 对应实体测试和流程测试 |
| `rule` | `app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt`、`AnalyzeByJSoup.kt`、`AnalyzeByXPath.kt`、`AnalyzeByJSonPath.kt` | `AnalyzeByJSoupDomTest.kt`、`AnalyzeRuleElementsNormalizationTest.kt` |
| `url` | `app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeUrl.kt` | `AnalyzeUrlNetworkOptionsTest.kt`、`AnalyzeUrlLoginHeaderContractTest.kt` |
| `workflow` | `app/src/main/java/io/legado/app/model/webBook/WebBook.kt`、`SearchModel.kt`、`BookInfo.kt`、`BookChapterList.kt`、`BookContent.kt` | `SearchPaginationContractTest.kt`、`WebBookTest.kt`、`SourceContentCompatibilityTest.kt` |
| `js-config` | `app/src/main/java/io/legado/app/model/jsSource/JsSourceConfig.kt`、`JsSourceUpsert.kt` | `JsSourceConfigTest.kt`、`JsSourceUpsertTest.kt` |
| `js-runtime` | `app/src/main/java/io/legado/app/model/jsSource/JsSourceEngine.kt`、`JsSourceBook.kt`、`JsSourceMarshaller.kt`、`JsSourceReview.kt` | `JsSourceEngineTest.kt`、`JsSourceMarshallerTest.kt`、`JsSourceReviewTest.kt` |
| `js-dispatch` | `app/src/main/java/io/legado/app/model/jsSource/JsSourceBook.kt` 和 `WebBook.kt` | `JsSourceDispatchSentinelTest.kt`、`JsSourceTocWriteBackSentinelTest.kt` |
| `js-api` | `app/src/main/java/io/legado/app/help/JsExtensions.kt`、`BaseSource.kt`、`CacheManager.kt`、`http/CookieStore.kt` | `JsSourceWebApiContractTest.kt`、`JsSourceApiTokenTest.kt` |
| `editor` | `modules/web/src/views/SourceEditor.vue`、`modules/web/src/config/bookSourceEditConfig.ts`、`modules/web/src/components/JsSourceEditor.vue` | `modules/web/tests/sourceEditor.test.js`、`JsSourceDirectDebugTest.kt`、`JsSourceEditRedirectTest.kt` |

## 证据等级

测试名默认位于 `app/src/test/java/io/legado/app/` 或 `app/src/androidTest/java/io/legado/app/`。fixture 还必须记录具体行号或测试用例名称、输入、期望输出和错误路径，避免只写一个无法定位的类名。

Android 证据也需要分级：测试文件是可执行行为证据，流程源码是可追踪行为证据，单纯类型或字段声明只能证明数据存在，不能证明完整运行时语义。TS 项只有在独立 fixture、golden 输出和自动断言都存在时，才能从“待 fixture”改为“已验证”。

兼容性决策：当 TypeScript 解析器与 Jsoup、JsoupXpath、JsonPath 或 Rhino 结果不一致时，以 fixture 中固化的 Android 结果为准；若 Android 行为不稳定，先记录差异，再通过明确的版本能力标记处理，不能静默改变书源结果。
