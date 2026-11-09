# 兼容性矩阵

本矩阵同时记录目标承诺、Android 事实证据和 TypeScript 当前完成度。它是迁移验收清单，不是“已经兼容”的声明。当前仓库已包含 `@legado/source-core` / `@legado/source-node` 实现与自动测试；尚未标记为已验证的 TS 项仍不能被当作完成。完整能力类别及需要补写的规格见 [能力清单](capabilities.md)。

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

未完成项、差异项和完成后的删除线记录统一维护在[状态总览](status.md)。本矩阵继续维护五维兼容证据；`implementation=absent/partial` 和 `execution=not-run` 的含义以状态总览为准。

独立基础测试包记录固定上游 Kotlin/JVM、JDK 和当前 TS 的同输入执行证据。方法签名和用例关联见[基础覆盖表](../../packages/compatibility-tests/coverage.json)，真实规则组合及来源见[语料覆盖表](../../packages/compatibility-tests/corpus/coverage.json)。双端报告只证明所列签名与执行场景。应用级 Android 流程的执行状态仍由对应 fixture 记录。

当前 TS/Node 回归的执行证据集中在 `packages/source-core/tests/` 与 `packages/source-node/tests/`：构建后包入口、7 条 import manifest、5 条历史 conformance manifest 和 6 个真实规则离线回放 case 均已实际执行；2026-10-23 P38 的发现/工作流定向回归为 60/60，完整 source 回归为 186/186，根回归为 638/638，静态 corpus 为 20,226/20,231（5 条已知源文本错误），TypeScript conformance 为 6/6。比较器中的 6 条 Android 输出仍为 `not-run`。P38 只把发现 `exploreUrl` 成员验证更新为 `ts-passed`，方法清单仍为 259 个成员（82 `implemented`、133 `partial`、44 `simulated`），仍待处理 177 个；验证统计为 154 `ts-passed`、40 `ts-diff`、65 `unverified`。静态 corpus 审计覆盖 943 个候选源和 20,231 条规则，20,226 条编译成功，5 条仅按 manifest 的稳定 hash/诊断白名单归为已知源文本问题。Android 当前快照也已运行完整 app JVM 单测集，但 Android 同输入 golden 仍未逐条生成。因此本矩阵中的“实现见 source-core/source-node”只表示实现和 TS 证据存在，不能单独改写为 Android 兼容已验证。

2026-10-23 P38 新增的跨层事实是：Android 发现请求的分类 URL 由调用方传入，source-core 现在通过 `DiscoveryInput.url` 保留该边界；未传入时才读取 source 定义中的 `exploreUrl`。JSON/文本分类的 core 结果显式保留 `type: "url"`，Web 对外分类仍按原有安全投影隐藏可执行 URL。Node 书源式回归覆盖零地址不请求和分类 URL 选择；Android 同输入 golden 仍未生成。

2026-10-22 D34 当前方法清单为 27 个能力族、252 个成员：55 个 `implemented`、159 个 `partial`、38 个 `simulated`。本轮新增的 Java IO 流构造器、范围读写、transfer、单字节输出、CR/CRLF Reader 行语义和 `String.format/formatted` 常用 `%t/%T` 日期时间/周序号/纪元转换已有 `source-rule-host.test.ts` 书源式回归；它们仍属于受控 QuickJS 对象，日期时区名称和完整 Locale 规则保留近似，Android 同输入仍为 `not-run`。D14 的 JS 源 marshaller 另有 `source-host-flow.test.ts` 回归，覆盖 `BookType` 校验/回退、详情前类型重置、文件源按位合并、`downloadUrls` 过滤/相对地址/去重和文件源空下载失败；D45 继续覆盖详情、目录、正文和声明式目录重置时保留 Android 非媒体状态位。D46/D47 最初按通用 Gson 类型推断，P62 根据固定 Android `GsonExtensions.kt` 自定义 String/Int adapters 修正实现和预期，并新增 Kotlin/JVM 同输入流程 golden；具体语义和剩余平台边界见下方 P62 记录。

2026-10-22 P31 新增 `JS-011`：`JavaImporter(Packages.okhttp3, Packages.cn.hutool...)` 的受控 OkHttp/Hutool facade。TypeScript 侧验证 Builder 请求形态、POST body、重复 Header、响应 `body/code/headers/message/isSuccessful`、Base64、摘要、字符串/十六进制和 gzip 编码均通过；P31 完成时方法清单为 258 个成员（55 `implemented`、159 `partial`、44 `simulated`）。请求仍走既有预算、Cookie、重定向和取消 bridge；完整 OkHttp/Hutool/JVM 对象身份、Android 同输入 golden 和未注入 gzip 宿主均按能力边界记录。

2026-10-23 P32 将 D43 的 7 个 File 成员（`getName/getPath/getAbsolutePath/exists/isFile/isDirectory/listFiles`）更新为 `implemented / ts-passed / simulatable / verify`；父对象和 `listFiles()` 子项均能继续调用 File 方法，元数据按调用时宿主状态刷新。当前方法清单统计为 62 个 `implemented`、152 个 `partial`、44 个 `simulated`；Android golden 仍为 `not-run`。

2026-10-23 P34 将 D23 的 `setLocal/setBaseUrl/setRedirectUrl` 更新为 `implemented / ts-passed / fixable / verify`；Node 回归覆盖 AnalyzeRule 链式返回、`setContent` 的 baseUrl/redirectUrl 分离、受控 URL 返回、非法 URL 保留旧值和 data URL 不覆盖。P35 将 URL options 的 `body/headers/timeout` 更新为 `implemented / ts-passed / fixable / verify`；P37 又将 `method/charset/followRedirects/retry/dnsIp/proxy/type` 更新为 `implemented / ts-passed / fixable / verify`，并按 Android Gson 直接字段语义补齐标量转换、Int retry、空白 type/charset/dnsIp 和源级 proxy 分离。当前方法清单统计为 82 个 `implemented`、133 个 `partial`、44 个 `simulated`；Android golden 仍为 `not-run`。

本次新增的 `HTML-FLOW-001`、`JSON-FLOW-001`、`XPATH-CONTENT-001`、`JS-TOC-001`、`TOC-EDGE-001`、`CONTENT-EDGE-001` 仍记录为 `android=not-run`；它们是 TypeScript 离线执行证据，不是 Android 兼容结论。

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
| URL 页码、URL options、表单编码、URL JS 顺序和 XML 响应后处理 | 目标必须兼容 | `AnalyzeUrl`、`AnalyzeUrlNetworkOptionsTest` | `source-core` 请求运行时及测试覆盖页码、`@js` 先于 `{{}}`、origin `baseUrl`、未知 method 回退 GET、WebView option 真假边界、整数 timeout/Int.MAX_VALUE、POST null body、复杂 headers、Gson String/Int 字段转换、空白 type/charset/dnsIp、源级 proxy 与 options Header 分离和 XML 补声明优先于 `bodyJs`；Android golden 尚未执行 |
| `concurrentRate` 书源级限流 | 目标必须兼容 | `ConcurrentRateLimiter`、`AnalyzeUrl` | `SourceRateLimiter` 已支持普通请求固定窗口、取消、`putConcurrent` 更新及 `ajaxAll(..., true)` bridge 旁路；首次非法值按 Android 首次请求 fallback 并由 `SourceSession.diagnostics()` 报告，`SourceSession.close()`/`ReaderApplication.close()` 释放等待（`source-rate-limiter.test.ts`、`source-session.test.ts`）；Android golden 及未来源管理入口的编辑删除集成仍待执行 |
| 高频 JavaScript bridge（章节数字、字节数组、摘要/HMAC） | 目标必须兼容 | `JsExtensions.toNumChapter`、`strToBytes/bytesToStr`、`JsEncodeUtils` | `source-core`/Node 已实现 `toNumChapter`、字符集字节往返、Base64/Hex 字节数组、摘要 Base64、HMAC Hex/Base64、t2s/s2t，并有 QuickJS 回归；WebView、浏览器交互和 Android golden 尚未执行 |
| Cookie、普通 source header、已保存登录头和最终域名 | 目标必须兼容 | `AnalyzeUrl`、`BaseSource.getHeaderMap()`、登录头站点判断 | CookieJar、静态/动态 source header、`loginCheckJs` 和 `NetworkHost.getLoginHeaders(sourceId)` 已实现；core 按初始 URL 同站范围注入独立登录头，URL options 可覆盖，网络及文件/字体/归档 bridge 首层重算动态 source header、深层按 D9 有界跳过并沿用初始 URL 规则；SecretStore 持久化、删除清理和 Android golden 仍待 fixture |
| `@js` 改写 URL 后的 Android 登录头站点限制 | 目标必须兼容 | `AnalyzeUrl` 初始 URL 的登录头判断 | Android 与 TS 都只检查初始 URL；TS 由 `NetworkHost.getLoginHeaders(sourceId)` 提供凭据，core 默认精确主机名，Node/自定义宿主可提供 Public Suffix List 同站判断。URL 改写到跨站后仍沿用初始地址决定是否注入；SecretStore 持久化和 Android golden 仍待 fixture |
| 默认 User-Agent | 目标必须兼容 | `BaseSource.getHeaderMap()`、`AppConfig.userAgent` | 核心从 `NetworkHost.defaultUserAgent` 接收平台默认值；Node 未显式配置时使用当前 Android 基线 `Chrome/153.0.0.0`，显式 `NodeNetworkOptions.defaultUserAgent` 和 source/URL Header 仍按优先级覆盖；Android golden 尚未执行 |
| 复杂登录 UI、验证码和多步骤登录 | 目标宿主能力 | `BookSource` 登录字段、WebView 流程 | reader-web 已实现静态 RowUi、动态 loginUi v2、`key`/输入 action 防抖、按钮倒计时、人工 action、状态/版本校验和结构化纯动作；真实网页、验证码、浏览器跳转和 Android golden 仍需宿主 |
| 搜索、详情、目录、正文流程 | 目标必须兼容 | `WebBook`、四类流程测试 | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `preUpdateJs` 的 `refreshTocUrl()` / `reGetBook()` 与无详情字段规则回退 | 目标必须兼容 | `AnalyzeRule.kt`、`BookInfo.kt`、`WebBook.kt` | `source-core` 通过受限 workflow action 实现详情刷新、书名作者精确重搜、RuleData 变量回写及 book 回写；Node 集成用例已执行，Android golden 尚未执行；TS 助手预算 30 秒，Android 上限 30 分钟 |
| 目录和正文分页、循环保护 | 目标必须兼容 | `BookChapterList`、`WebBook` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 声明式正文内置格式、HTML4 解码、特殊样式保护和图片 URL 归一化 | 目标必须兼容 | `BookContent.kt`、`HtmlFormatter.kt`、`AppConfig.adaptSpecialStyle` | source-core 已实现格式化、图片资源和标题 `imgUrl` 投影；Android golden 尚未执行|
| `ruleContent.subContent` 在线文本追加、歌词和弹幕 | 声明存在时必须兼容 | `BookContent.kt` 的 `subContent` 分支 | source-core 按首次正文响应上下文提取；在线文本原文追加，音视频结果写入章节变量并通过 `ChapterContent.auxiliary` 返回。D11 双端 guided flow 已验证：可选副文请求取消后继续本地 replace/title 规则，最终仍取消且不交付正文；宿主 bridge 保留原取消信号。Android app 实际入口及取消时远程 jsLib/应用宿主状态仍未实测|
| 搜索精准匹配中的书名、作者和分类 | 目标必须兼容 | `SearchModel` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 目录 `-` 前缀和 `reverseToc` 组合 | 目标必须兼容 | `BookChapterList` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `canReName` 调用权限与非空配置判断 | 目标必须兼容 | `BookInfo` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| 卷节点空正文和非卷空正文回退 | 目标必须兼容 | `WebBook`、`JsSourceBookTest` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| JS 源返回值和字段归一化 | 目标必须兼容 | `JsSourceMarshallerTest`、`JsSourceEngineTest` | 实现见 source-core/source-node 与对应 tests；对照 fixture/golden 执行状态见测试基线|
| `getContentBatch` 和 `contentBatch` | 声明存在时必须兼容 | `JsSourceConfig`、`BookContent.kt`、`JsSourceBook.kt`、`BatchContentContext.kt` | `loadChapterContentBatch` 已实现 JS/声明式入口、50 章切批、index/唯一 URL 识别、replaceRegex、逐章宿主回存和缺章兜底；core 与 QuickJS 定向测试通过，Android golden 待执行 |
| 结构化段评摘要、详情和回复 | 声明存在时必须兼容 | `ReviewController`、`ReviewRuleParser`、`JsSourceReview` | source-core 已支持声明式/JS 读取、内容协议、嵌套回复和分页；reader-web 对声明式详情游标做用户/书源/书籍/章节/段评上下文 HMAC 绑定；`packages/source-core/tests/review.test.ts` 通过，Android golden 待执行 |
| 旧式段评网页桥接 | 受支持的 `getDP/getZP` 链接必须兼容 | `ReviewController`、`HttpServer`、`ReviewWebApiContractTest` | 会话 nonce、2 小时 TTL、64 KiB 脚本上限、CSP/sandbox 和图片重写见[段评流程](../upstream/android/flows/review-flow.md)，runtime 未实现，待安全 fixture |
| WebView 真实页面行为 | 目标宿主能力 | WebView 相关流程 | 需 adapter 和 capability error |
| 发现分类、`infoMap` 与发现列表 | 目标必须兼容 | `BookSourceExtensions`、`ExploreKind`、`WebBook.exploreBookAwait` | source-core/reader-web 已保留 JSON/文本/动态分类元数据和 `ERROR:` 诊断项；错误分类公开为不可请求的 `type:error`，列表请求零网络执行；对照 fixture/golden 执行状态见测试基线|
| 图片与封面解密 | 声明存在时必须兼容 | `ImageUtils`、`ContentRule.imageDecode`、`BookSource.coverDecodeJs` | `decodeImage` 已实现规则选择、QuickJS bytes 往返、封面流式输入兼容、错误和取消；下载/缓存由宿主负责，Android golden 待执行 |
| 付费动作与购买后刷新 | 部分实现 | `ContentRule.payAction`、`ReadBookActivity.payAction` | `executePayAction` 已支持 JS 和 `{{js}}` URL、URL/真值结果；reader-web 提供人工触发 API、源版本校验、结构化刷新动作和进程内 operationId 幂等；购买后实际刷新、浏览器打开和多实例幂等仍缺 |
| 段评写入、投票和删除 | 低优先待核实（写入流程为目标设计） | `ReviewRule` 有字段；已核对的 `ReviewController` 入口主要是读取 | 写入流程为 Web 目标设计（见 conformance-tests ACTION-002），不宣称 Android 等价 |
| 书源事件和自定义按钮 | 目标宿主能力 | `SourceCallBack`、`BookSource.eventListener/customButton` | `executeSourceCallback` 已保留事件名、book/source 级超时和上下文；自定义按钮去重、默认动作和 UI 宿主仍待接入 |
| 音频、图片、视频和文件结果 | 目标必须兼容 | `BookSource.bookSourceType`、`Book`、`BookChapter`、相关调用点 | 音视频声明式正文跳过文本格式化，`subContent` 歌词/弹幕已写入章节变量并返回辅助结果；图片解密由 `decodeImage` 执行，实际下载/缓存及文件下载由宿主负责 |
| 编辑器预览与诊断 | 目标设计 | `modules/web` 配置和测试 | 仅规划，未实现独立编辑器 |

## 2026-11-09 P2：JSONPath 函数与对象键顺序

固定 Android Java/Kotlin 源码和 Jayway JsonPath 3.0.0 依赖的 Kotlin/JVM 参考端，对 TypeScript 执行相同输入。首批 25 个 JSONPath 案例覆盖常用函数和对象键顺序；后续增加 29 个案例覆盖 `stddev/first/last/index/concat/append`、数组参数扫描、Java 数值截断，以及 `getString/getStringList` 的 append 列表转换。`coverage.json` 逐项关联 `read/filter` 与 15 个路径函数成员，`method-manifest.json` 中这 15 个成员均为 `ts-passed`。JSON family 总计 **134/134 行为相等**；空聚合、空序列和索引越界两端均失败，错误类或文案差异按显式等价类别记录，原始输出保存在报告中。

| 范围 | evidence | spec | implementation | execution | priority |
| --- | --- | --- | --- | --- | --- |
| D20 `read/filter` 与 15 个路径函数成员 | Android source + 固定 Kotlin/JVM 与 TS 同输入执行 | defined（coverage 所列案例） | partial | JSON family 134/134 行为相等；完整 JSONPath 方言、复杂集合和动态表达式仍未覆盖；Android app/设备仍 not-run | required |

## Android 证据索引

能力 ID 以 [能力清单的稳定索引](capabilities.md#稳定能力索引) 为准。上表是阅读摘要，不能替代逐字段/逐方法审计。TypeScript 实现已存在；未跑的对照案例仍为 `execution=not-run`。“目标必须兼容”不等于规格已完整。订阅、状态隔离与部署策略是 Web 目标设计，分别由 SUB、STATE、DEP 案例验证。

补充能力 CAP-ENCODE、CAP-ARCHIVE、CAP-FONT、CAP-CONCURRENCY 已登记原方法，其逐重载完成度及阻塞条件见[能力清单](capabilities.md)；不因原表缺行而排除。每项记录五个独立维度：evidence（source/test-run/design）、spec（defined/blocked）、implementation（absent/implemented）、execution（not-run/pass/fail，按宿主）、priority。evidence=source 表示 Android 源码证据，test-run 表示测试已执行，design 表示目标设计。只有具体案例实际通过才写 pass。

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

## 2026-10-21 代码与教程核对证据

本轮代码、教程 hash 和完整差异事实见[差异登记 D18～D43](known-divergences.md#android-与教程重新核对2026-10-21)。历史测试总数不是本轮执行结果；本轮没有新增已通过的 Android golden，也没有把现有 manifest 的 `android=not-run` 改为通过。

| 案例范围 | evidence | spec | implementation | execution | priority |
| --- | --- | --- | --- | --- | --- |
| D18/D19/D20：Jsoup 选择器、HTML 文本和 JSONPath 函数/正则过滤 | Android source + 固定 Kotlin/JVM 与 TS 同输入执行 | defined（表中列出的输入） | partial | D18 已确认 CSS `:eq/:lt/:gt` 的负数在 Jsoup 解析期被拒绝并覆盖正数位置；D19 已补文本空白、节点边界及 XPath 函数/轴语义，XPath family 186/186；D20 的固定 JVM JSON family 现为 134/134，逐项覆盖 15 个 JSONPath 成员。Android app/设备仍 not-run | required |
| D22/D23：java.url/ruleUrl/headerMap、响应 Headers、getString 布尔重载和缺失成员 | Android source/内置帮助 + TS 请求桩/脚本执行 | defined（列出的成员、Headers 重复值/索引和重载） | D22 的 `url/headerMap/getHeaderMap/getStrResponse/getResponse/bodyJs/loginCheckJs` 已有 TS 实现，`ruleUrl/initUrl` 为部分实现；D23 overload semantics implemented | D22 的 response/StrResponse 方法与属性、OkHttp/Jsoup Headers 查询、重复值、索引、映射、敏感头脱敏和 HTTP-date `getDate/getInstant` 已有 `source-rule-host` 回归；P36 新增 `ruleUrl`、`initUrl` 地址恢复、Java Map 常用方法和 loginCheckJs 上下文回写回归；完整 Android URL 生命周期重解析、Map live view、WebView 和 Android golden not-run；D23 的 `unescape` 布尔重载、`content`/`isUrl` 位置、null 内容回退、HTML 解码、URL 解析和 list 去重已有 TS 回归 | required |
| D24～D28/D31/D32/D34：对象方法、重建 session、InfoMap、AES 返回类型和 StrResponse 构造 | Android source + TS 脚本/session 执行 | defined（具体差异输入） | D31 的 InfoMap 缺失键、set/save/saveNow 返回值和保存 TTL 已由 P40 收口；缓存对象身份、其余 Java 对象和跨端状态仍为 partial | P40 Node 回归通过；Android not-run | required |
| D29/D30/D35～D40：文件命名空间、下载、字体、工具、宿主配置、导入、库状态和游标签名 | source | 部分 defined；完整语言/平台等价仍 blocked | partial 或 absent，详见状态表 | 组合路径 not-run，不能写 pass | required/host |
| D42/D43：URL 和 File 对象 | Android source + TS URL 最小输入执行；File 为源码确认和 `source-rule-host.test.ts` FILE-004 父子对象回归 | defined（列出的成员） | partial | D42 URL 已有 TS 回归；D43 父子 File 方法、`listFiles()` 子项包装和即时元数据刷新已通过 TS；Android golden 仍 not-run | required |
| 既有规则宿主、平台、session 回归 | test-run | defined（已有测试） | 按测试范围 | P38 后 `pnpm test:source` 186/186；根全套 `pnpm test` 638/638；不能覆盖 Android golden 或真实宿主 | verify |

本轮已执行命令：`node --test packages/source-node/tests/source-rule-host.test.ts packages/source-node/tests/source-runtime-platform.test.ts packages/source-node/tests/source-session.test.ts`。最小探针直接调用 SourceRuleRuntime/SourceRuleHost、使用固定 `.invalid` 地址和请求桩，没有访问公网、真实账户、购买或其他远程写入。探针属于差异发现证据，正式回归与共享 golden 要在对应修复时加入版本控制。

2026-10-23 P56～P59 的新增证据：`containsOwn`/`text.*` 的 Jsoup 空白与大小写归一化、文本/数据/whole/blank 伪类、HTML/XML `matchText` 伪元素、同级位置后缀和嵌套 `has` 已加入 adapter 与规则宿主回归；当前定向 adapter **30/30**、source-rule-host **118/118**、`pnpm typecheck` 和构建通过。HTML `matchText` 回归还确认 script/style DataNode 不会被误包装，文本伪类参数中的字面量 `:matchText` 不会误触发伪元素转换。Android 同输入 golden、完整 Jsoup 修复算法和复杂伪元素变换仍为 `not-run`/待验证，不改变方法清单的 partial/conditional 状态。

环境只读核验：Android Studio JBR `21.0.4` 可以启动，默认 Java 为 `1.8.0_504`；常规 Android SDK 目录未发现 API 36/build-tools 36.0.0。本轮没有验证 Gradle 编译、SDK 下载和真实 WebView。后续 Android runner 必须使用独立 checkout，不能更改父仓已有工作树。

## 2026-10-22 P13 最终执行证据

`node scripts/run-source-conformance-typescript.mjs` 对六条跨运行时 fixture 逐条生成实际输出并完成 `6/6` expected 比较；`node scripts/compare-source-conformance.mjs` 记录六条 `typescript=pass`、`android=not-run`。`node scripts/run-source-conformance-android.mjs` 只完成前置检查：外层项目有 `gradlew`，但没有 `local.properties`、逐 fixture adapter 或输出目录，返回 `not-run`/退出码 2。因而本矩阵中所有 Android 同输入项仍保持 `execution=not-run`，没有把普通 Android 单测或 Node 结果提升为双端通过。

同次静态语料审计为 943 个候选源、20,231 条规则、20,226 条编译成功、5 条已知源文本错误，`unexpectedUncompiledRules=0`、`staleKnownBrokenRules=0`。P13 新增的 runner、比较器和每条实际结果输出属于 TS 验证证据；Android adapter 仍是后续唯一阻塞的跨端执行项。

2026-10-23 P36 新增 AnalyzeUrl 上下文回归：`loginCheckJs` 可读取已完成内嵌 JS/模板/页码展开的 `java.ruleUrl`，用 `java.initUrl()` 恢复该地址，并通过 `java.getHeaderMap().putAll()` 修改重取请求 Header；缺失 Map 值按 Java `null` 语义返回，修改后的上下文会回写请求宿主。`packages/source-node/tests/source-host-flow.test.ts` 该组为 38/38；完整 `initUrl` 重跑 Android URL 生命周期、Java Map live view、WebView 和 Android golden 仍未验证。

2026-10-23 P37 完成 URL options 网络字段的 TS 对齐：`method/charset/followRedirects/retry/dnsIp/proxy/type` 均更新为 `implemented / ts-passed / fixable / verify`。`source-request.test.ts` 23/23 覆盖 Android Gson String 数字/布尔/对象转换、Int retry 字符串与小数、空白 type/charset/dnsIp、followRedirects、源级 lowercase proxy 与 URL options Header 分离；`pnpm test:source` 186/186、根全套 `pnpm test` 635/635、静态语料 20,226/20,231、TypeScript conformance 6/6 通过。Android 同输入 golden 仍为 `not-run`，Node 的 SSRF/代理 provider 和 Gson 版本极端值继续保留差异。

2026-11-09 P60 对齐正则替换异常回退：依据固定 Android `AnalyzeRule.kt:544–560`，全量替换异常按正则文本字面回退，首项替换的无效 replacement 在命中时返回 replacement 原文、未命中时返回空串。新增 6 条 `AnalyzeRule.replaceRegex` 与 5 条 JDK `Pattern/Matcher` 双端案例；regex **22/22**、Pattern **40/40**。reader-web 的 `getOrLoadContent → loadChapterContent → SourceRuleRuntime` 正文路径有端到端回归。完整集 **791 项（780 相等、11 条已登记允许差异、0 未登记差异/unsupported/runner failure）**，流程 **81/81**；source tests **208/208**、根 tests **711/711**、reader-web **343/343**、typecheck 通过。参考端是锁定 Android 源码和依赖上的 Kotlin/JVM 执行，不是 Android app/设备实测；redirect fixtures 使用 loopback HTTP。

2026-11-09 P61 验证 `Pattern.CANON_EQ` 的字面模式子集：新增 7 条 JBR 21/Kotlin/JVM 与 QuickJS 对照，覆盖组合/分解字符、原文下标、部分匹配、`LITERAL` 组合、Matcher 的 `lookingAt/region/reset/replaceFirst/replaceAll` 与 `Pattern.split`；Pattern family **47/47** 相等。完整兼容集 **798 项（787 完全相等、11 条已登记允许差异、0 未登记差异/unsupported/runner failure）**，流程 **81/81**；根测试 **711/711**、reader-web **343/343**，根与 Web TypeScript 类型检查、JSON fixture 校验和 `git diff --check` 通过。报告见 `packages/compatibility-tests/output/run-DqXl7Y/report.md`。Android app/设备 golden 尚未运行；regex 运算符、其他 flags、需要规范重排的输入和超过 1 MiB 的匹配输入仍是明确边界。

2026-11-09 P62 修正 D46/D47 的 Android Gson 行为假设并补齐 JVM/TS 同输入验证：参考端使用固定 Android `SearchBook` 字段和 `GsonExtensions.kt` 的 `StringJsonDeserializer`/`IntJsonDeserializer` 语义。String 对象/数组转紧凑 JSON 文本；详情 Map 中嵌套值转文本、null 项在默认 `GSON.toJson` 时省略；Int 非数字输入保留实体默认值，`type` 单独按 `JsonElement.asInt()` 处理，布尔无效、数字遵循 Java `Number.intValue()` 截断和 32 位回绕；`time(Long)` 解析失败则跳过条目。显式 null `name/bookUrl` 令搜索/发现解析失败，`author/tocUrl` 在 `SearchBook.toBook()` 阶段按 Android 抛错。6 条 `flow.mainJs` Kotlin/JVM 与 TS 完整流程案例 **6/6 一致**，整个 flow **87/87**；`source-host-flow.test.ts` **45/45**。完整兼容集 **804 项（793 相等、11 条登记允许差异、0 未登记差异/unsupported/runner failure）**；根测试 **714/714**、reader-web **343/343**，根与 Web TypeScript 类型检查通过，JSON 校验和 `git diff --check` 通过。报告见 `packages/compatibility-tests/output/run-k70rjC/report.md`。固定参考端为 Kotlin/JVM 上的锁定 Android 源码和 Gson 2.14.0，不是 Android app/设备实测；Gson 极端数值和 app/设备 golden 仍待验证。

2026-11-09 P63 对齐 XPath XML QName、通配属性轴和 Android JsoupXpath 2.5.3 的函数边界：固定参考端执行 Android `AnalyzeByXPath.kt` 与锁定依赖的 Kotlin/JVM。新增 25 条 XPath 对照案例，覆盖前缀选择/谓词/子路径/属性、`//*/@attr` 对缺失属性输出空项、独立属性轴、默认命名空间、未声明前缀的 HTML/XML 片段，以及 `count()` 在元素/属性节点上的转换错误和 `string()` / `local-name()` 不支持。TS 移除标准 XPath 命名空间扩展与 Android 不符的投影；未声明前缀仅在 DOM 构造时临时绑定，随后移除，不作为属性暴露。原 6 条 namespace allowlist 删除，XPath family **75/75 全等**；11 条异常 transport 差异按稳定异常类别映射，成功值仍逐项精确比较。历史离线 `XPATH-CONTENT-001` 改为无前缀 XML XPath，使流程 fixture 与 Android 行为一致。完整 JVM/TS 集 **829 项（824 一致、5 条其他已登记允许差异、0 未登记差异/unsupported/runner failure）**，流程 **87/87**；根测试 **714/714**、reader-web **343/343**、compatibility mechanism **33/33**，根与 Web TypeScript 检查通过。完整报告：`packages/compatibility-tests/output/run-cWqU1z/report.md`；XPath family 报告：`packages/compatibility-tests/output/run-Zjj7Ag/report.md`。redirect fixture 只监听 loopback，并按用户授权运行。固定 Kotlin/JVM 参考不是 Android app/设备实测；XPath 的其他函数、轴、谓词组合和 Android app/设备 golden 仍待覆盖。

2026-11-09 P64 对齐 Android Jsoup HTML parser 为 XPath 片段建立的文档结构：TypeScript 在 XML DOM 构造前将无根 HTML 内容放入 `html/head/body`，避免多个顶层节点触发 `HierarchyRequestError`；已有 `<html>` 文档中位于 `<body>` 外的正文节点也会归入 body。新增 JVM/TS 案例验证 `//body/div` 文档根、该归并行为，以及语料「2K小说」的 `//*[@id="bookcon"]//tr[position()>1 and position() < 12]` 位置规则；reader-web 使用同一规则搜索合成 HTML，验证书名和相对详情地址。XPath family **78/78 行为一致**，11 条异常传输差异按已登记类别比较。source-node build 通过，adapter **33/33**、compatibility mechanism **33/33**、reader-web **344/344**。固定参考端是锁定 Android 源码和依赖的纯 Kotlin/JVM 执行，不代表 Android app/设备实测。完整函数、轴、复杂谓词和畸形 HTML 修复仍待扩展；报告见 `packages/compatibility-tests/output/run-qCAKmE/report.md`。

2026-11-09 P65 对齐 Android JsoupXpath 2.5.3 的 `substring-before-last` 与 `substring-after-last`：JVM/TS 新增 11 条同输入案例，覆盖重复、缺失及空分隔符、元素序列 ownText 拼接、属性序列逗号转换和空选择。Fontoxpath 的自定义函数入口拒绝 attribute node，因此 TS 在调用前仅把纯属性选择转换为 `string-join(..., ',')`；元素节点仍传入自定义函数并按 Android `XValue.asString()` 读取 ownText。XPath family **89/89 一致**，原有 11 条异常传输差异仍按稳定类别比较；reader-web 搜索 fixture 使用 `@xpath:substring-before-last(...)` 验证书名字段。source-node build、根测试 **714/714**、reader-web 测试 **345/345**、compatibility mechanism **33/33**、根与 Web 类型检查通过。报告：`packages/compatibility-tests/output/run-x5ZNNY/report.md`。参考端是锁定 Android 源码/依赖上的 Kotlin/JVM 执行，不代表 Android app/设备实测；D19 仍为 partial。

2026-11-09 P66 对齐 Android JsoupXpath 2.5.3 的三参数 `substring-ex`：新增 14 条 JVM/TS 案例，覆盖 Commons Lang 负索引/越界和 UTF-16 截取、XPath number 的 Java long 截断、字符串 `BigDecimal` HALF_UP、int 回绕、ownText 元素序列、逗号连接属性序列、空选择、非法索引转换，以及锁定 Android 双参数实现当前抛出的索引错误。reader-web 搜索测试通过 `@xpath:substring-ex(...)` 验证书名字段。XPath family **103/103 一致**；完整兼容集 **857 项（852 完全相等、5 条已登记允许差异、0 未登记差异/unsupported/runner failure）**，流程 **87/87**；source-node build、根测试 **714/714**、reader-web **346/346**、compatibility mechanism **23/23** 和根/Web 类型检查通过。报告：`packages/compatibility-tests/output/run-iPZbTM/report.md`。loopback HTTP fixture 按用户授权仅在本机运行；Kotlin/JVM 参考端不是 Android app/设备实测，D19 仍保持 partial。

2026-11-09 P67 对齐 Android JsoupXpath 2.5.3 的 `first()`/`last()`：固定参考端确认 Android `First.call` 返回整数 `1`，`Last.call` 依据当前元素和同父作用域内同标签兄弟的数量计算；两者即使收到多余参数也先由 XPath processor 求值参数表达式，再由函数忽略值。TS 注册自定义 `first()` 并保留参数求值/错误顺序；Fontoxpath 的 `last()` 在固定谓词矩阵中与 Android 一致。新增 7 条 JVM/TS 案例，覆盖首/末节点谓词、逐父节点的末节点、普通多余参数及参数表达式报错；reader-web 搜索流程另验证 `bookList: '@xpath://article[first()]'` 只接受首个候选。XPath family **110/110 行为一致**；完整兼容集 **864 项（859 相等、5 条已登记允许差异、0 未登记差异/unsupported/runner failure）**，流程 **87/87**（50 完整流程、37 阶段流程）。source-node build、根测试 **714/714**、reader-web **347/347**、compatibility mechanism **23/23**、根/Web 类型检查通过。报告：`packages/compatibility-tests/output/run-yNkAg9/report.md`。固定参考端为 Android 源码/依赖上的 Kotlin/JVM 执行，不代表 Android app/设备实测；D19 仍为 partial，其他 XPath 函数、轴和谓词组合仍待覆盖。
2026-11-09 P68 对齐 JsoupXpath 2.5.3 的 `format-date()`：固定 JVM/TS 案例实测 Android 两参数 `FastDateFormat` 与三参数 locale `SimpleDateFormat` 的差异，覆盖常见日期/时间字段、相邻数字字段、AM/PM、locale 月名、年内日序与周序、GMT/ISO 时区、引号、日期/毫秒溢出、尾随输入、缺参和额外参数求值；并修正 `java.util.Date.toString()` 个位日期必须补零。reader-web 搜索规则另有 format-date 书名入口测试。XPath family **133/133**；完整兼容集 **887 项（882 相等、5 条已登记允许差异、0 未登记差异/unsupported/runner failure）**，流程 **87/87**。根测试 **714/714**、reader-web 搜索入口 **18/18**、compatibility mechanism **23/23**、source-node build 与根类型检查通过。完整报告：`packages/compatibility-tests/output/run-c9C2Si/report.md`。环回 HTTP 夹具经用户明确授权在本机执行；参考端是固定 Android 源码与依赖上的 Kotlin/JVM，不代表 Android app/设备实测；D19 保持 partial。

2026-11-09 P71 对齐 Android JsoupXpath 2.5.3 的 `concat()` 参数转换：固定 JVM 参考确认函数逐项调用 `XValue.asString()` 后拼接，支持零参数；元素序列按各元素 `ownText()` 连接，属性/文本节点序列以逗号连接，普通字符串参数按 Android 行为先 trim。TS 注册兼容函数，并在 FontoXPath 边界转换属性节点序列。新增 4 条 JVM/TS 案例覆盖混合多节点序列、零参数、单节点序列和普通字符串参数 trim；XPath family **184/184 行为一致**。全量兼容集 **938 项（933 相等、5 项已登记允许差异、0 未登记差异/unsupported/runner failure）**，流程 **87/87**；source-node build、根类型检查、根测试 **714/714**、reader-web 搜索入口 **19/19**、compatibility mechanism **33/33** 通过。报告：`packages/compatibility-tests/output/run-MGKd4E/report.md`。固定 Kotlin/JVM 参考是锁定 Android 源码/依赖的同输入执行，不代表 app/设备实测；D19 保持 partial。

2026-11-09 P72 对齐 XPath 数值的 Android `XValue.asString()` 转换：固定 JsoupXpath 2.5.3 的数值分支使用 Java `String.valueOf(value).trim()`，XPath 数字按 `Double` 输出；JS `String(number)` 会把 `1` 输出成 `1`、把 `10000000/0.0001/-0` 输出成非 Android 形式。TS 现按 Java Double 文本布局输出整数小数位、`E` 科学计数法阈值及负零。新增 JVM/TS 案例验证 concat 的整数/小数、`1e7`、`1e-4`、`1e-3`、`1e-7`、`-0`，以及 `string-length(1)`。XPath family **186/186 行为一致**；全量兼容集 **940 项（935 相等、5 项既有允许差异、0 未登记差异/unsupported/runner failure）**，流程 **87/87**；根测试 **714/714**、reader-web 搜索入口 **19/19**、compatibility mechanism **33/33**、source-node build 和根类型检查通过。完整报告 `packages/compatibility-tests/output/run-TxurCv/report.md`，XPath family 报告 `packages/compatibility-tests/output/run-eNpOhg/report.md`。固定参考端是锁定 Android 源码/依赖上的 Kotlin/JVM 执行，不代表 app/设备实测；D19 保持 partial。
