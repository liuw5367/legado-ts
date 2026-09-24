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
| URL 页码、URL options、表单编码 | 目标必须兼容 | `AnalyzeUrl`、`AnalyzeUrlNetworkOptionsTest` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `concurrentRate` 书源级限流 | 目标必须兼容 | `ConcurrentRateLimiter`、`AnalyzeUrl` | 字段已在 codec 保留；限流窗口执行未实现，待窗口/取消 fixture |
| Cookie、静态登录头和最终域名 | 目标必须兼容 | `AnalyzeUrl`、网络选项测试 | 静态 header 与 `loginCheckJs` 检查已实现（`workflows/helpers.ts`）；Cookie 域与跨域登录头对照 fixture 待执行 |
| `@js` 改写登录 URL 后的跨域登录头 | 目标必须兼容 | `AnalyzeUrl` 登录头判断源码 | 未实现 runtime，需 golden |
| 复杂登录 UI、验证码和多步骤登录 | 低优先待实现 | `BookSource` 登录字段、WebView 流程 | 未实现 runtime，需登录交互规格 |
| 搜索、详情、目录、正文流程 | 目标必须兼容 | `WebBook`、四类流程测试 | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 目录和正文分页、循环保护 | 目标必须兼容 | `BookChapterList`、`WebBook` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 搜索精准匹配中的书名、作者和分类 | 目标必须兼容 | `SearchModel` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 目录 `-` 前缀和 `reverseToc` 组合 | 目标必须兼容 | `BookChapterList` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `canReName` 调用权限与非空配置判断 | 目标必须兼容 | `BookInfo` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 卷节点空正文和非卷空正文回退 | 目标必须兼容 | `WebBook`、`JsSourceBookTest` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| JS 源返回值和字段归一化 | 目标必须兼容 | `JsSourceMarshallerTest`、`JsSourceEngineTest` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `getContentBatch` 和 `contentBatch` | 声明存在时必须兼容 | `JsSourceConfig`、JS 源测试 | 未实现 runtime，待 fixture |
| 结构化段评摘要、详情和回复 | 声明存在时必须兼容 | `ReviewController`、`ReviewRuleParser`、`JsSourceReview` | 读取规格见[段评流程](../flows/review-flow.md)，runtime 未实现，待 fixture |
| 旧式段评网页桥接 | 受支持的 `getDP/getZP` 链接必须兼容 | `ReviewController`、`HttpServer`、`ReviewWebApiContractTest` | 会话 nonce、2 小时 TTL、64 KiB 脚本上限、CSP/sandbox 和图片重写见[段评流程](../flows/review-flow.md)，runtime 未实现，待安全 fixture |
| WebView 真实页面行为 | 目标宿主能力 | WebView 相关流程 | 需 adapter 和 capability error |
| 发现分类、`infoMap` 与发现列表 | 目标必须兼容 | `BookSourceExtensions`、`ExploreKind`、`WebBook.exploreBookAwait` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 图片与封面解密 | 目标宿主能力 | `ImageUtils`、`ContentRule.imageDecode`、`BookSource.coverDecodeJs` | 未实现 runtime，待字节流程规格 |
| 付费动作与购买后刷新 | 低优先待实现 | `ContentRule.payAction`、`ReadBookActivity.payAction` | 未实现 runtime，待交互规格 |
| 段评写入、投票和删除 | 低优先待核实（写入流程为目标设计） | `ReviewRule` 有字段；已核对的 `ReviewController` 入口主要是读取 | 写入流程为 Web 目标设计（见 conformance-tests ACTION-002），不宣称 Android 等价 |
| 书源事件和自定义按钮 | 目标宿主能力 | `SourceCallBack`、`BookSource.eventListener/customButton` | 未实现 runtime，待事件协议规格 |
| 音频、图片、视频和文件结果 | 目标必须兼容 | `BookSource.bookSourceType`、`Book`、`BookChapter`、相关调用点 | 未实现 runtime，待类型专属 fixture |
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
