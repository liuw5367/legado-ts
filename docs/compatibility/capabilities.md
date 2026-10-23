# 书源能力清单与审核决策

目标是完整移植 `BookSource` 的可观察行为。优先级表示实施顺序，不表示放弃。若某项收益低且显著增加架构成本，应先给出使用场景、原实现证据、替代方案和兼容损失，再由用户审核是否舍弃。未经审核的能力保留在清单中，未实现时必须返回能力状态和可识别的错误。

本清单以 BookSource、规则实体、WebBook、AnalyzeRule/AnalyzeUrl、JsSourceBook 及其调用者为证据入口。字段登记不等于逐调用点验证；兼容结论以 [证据矩阵](evidence-matrix.md) 和实际案例为准。下载多个 `BookSource` 的订阅属于书源导入范围；`RssSource` 与 `ReplaceRule` 是另一个实体体系，当前仅登记订阅 `type` 分支和兼容边界，独立 CRUD 是否纳入 package 必须单独审核，不能静默视为支持或放弃。

| 能力组 | 需要形成的行为规格 | 当前文档位置 | 优先级与待核对内容 |
| --- | --- | --- | --- |
| 导入、更新、导出 | JSON、JS、远程地址、替换、冲突、未知字段和原文保留 | [导入](../upstream/android/flows/import-protocol.md)、[编辑](../archive/source-editor.md) | 优先；核对更新后的缓存失效和版本身份 |
| 书源字段与类型 | `BookSource`、规则对象、文本/音频/图片/文件/视频类型 | [模型](../upstream/android/rules/source-schema.md) | 优先；各类型从列表到消费结果的行为需分开验收 |
| 规则语言 | CSS、XPath、JSONPath、正则、组合、变量、内嵌 JS、WebJS | [规则](../upstream/android/rules/rule-language.md) | 优先；WebJS 需浏览器宿主能力 |
| URL 与请求 | 参数、页码、Body、Header、Cookie、重试、重定向、代理和 DNS | [URL](../upstream/android/rules/url-request-rules.md) | 优先；Node 通过 `undici` 提供 HTTP/HTTPS/SOCKS/SOCKS5 代理和认证，代理/DNS 顺序、安全边界与 Android golden 继续验证 |
| 搜索与发现 | 多源搜索、精准搜索、分类入口、筛选状态、发现列表 | [搜索](../upstream/android/flows/search-flow.md)、[发现](../upstream/android/flows/explore-flow.md) | 优先；`exploreScreen` 和分类交互需要继续核对 |
| 详情与目录 | 字段覆盖、文件下载地址、目录刷新、分页、卷、VIP 和顺序 | [详情](../upstream/android/flows/book-info-flow.md)、[目录](../upstream/android/flows/chapter-list-flow.md) | 优先；文件类源需专门结果契约 |
| 正文与批量 | 正文分页、清洗、替换、缓存、批量、元数据保存 | [正文](../upstream/android/flows/content-flow.md) | `loadChapterContent` 与 `loadChapterContentBatch` 已实现；持久化/token 由宿主提供；Android golden 待执行 |
| JavaScript 书源 | 配置抽取、函数调用、返回值、同步兼容 API、变量和脚本 scope | [JS](../upstream/android/rules/javascript-source.md)、[宿主](../../packages/source-core/docs/host-ports.md) | 优先；核对 `JsExtensions` 中未列出的实际书源依赖 |
| 图片与封面解密 | `coverDecodeJs`、`imageDecode` 的字节/流输入、脚本输出与缓存 | [模型](../upstream/android/rules/source-schema.md) | `ImageUtils` 调用链已核对；`decodeImage` 已实现解密工作流，下载与缓存仍由宿主提供；Android golden 待跑 |
| 付费与受限章节 | VIP/购买标识、`payAction`、授权状态、执行后刷新 | [目录](../upstream/android/flows/chapter-list-flow.md)、[模型](../upstream/android/rules/source-schema.md) | core 已提供用户调用的 `executePayAction`，支持 JS/`{{js}}` URL、URL/真值结果和刷新类 workflow action；reader-web 已接入人工触发与操作 ID 幂等，购买后实际刷新、浏览器打开和多实例持久幂等仍由应用/宿主接入 |
| 段评读取与交互 | 结构化摘要、详情、回复，旧式段评页面桥接，以及点赞、发送和删除规则 | [段评流程](../upstream/android/flows/review-flow.md)、[JS](../upstream/android/rules/javascript-source.md)、[模型](../upstream/android/rules/source-schema.md) | 声明式/JS 读取已实现并接入 reader-web API；旧式页面桥接和写入目前保持明确缺口 |
| 登录与认证 | 静态 Header/Cookie、`loginCheckJs`、登录表单、验证码和动态登录 | [请求](../upstream/android/rules/url-request-rules.md)、[JS](../upstream/android/rules/javascript-source.md) | 静态 Header/Cookie、静态 RowUi、动态 loginUi v2、人工 action 和加密 session 已接入 reader-web；真实网页登录、验证码和 Android golden 仍需宿主 |
| 浏览器行为 | WebView 请求、`@webjs:`、资源嗅探和页面脚本 | [请求](../upstream/android/rules/url-request-rules.md)、[宿主](../../packages/source-core/docs/host-ports.md) | 后续宿主能力；不能把普通 HTTP 当成等价实现 |
| 书源交互与事件 | `eventListener`、`customButton`、正文回调和宿主 UI 动作 | [模型](../upstream/android/rules/source-schema.md) | core 已提供 `executeSourceCallback` 和 Android 事件名/超时上下文；reader-web 已接人工回调/payAction、源版本校验、结构化刷新动作和进程内 operationId 幂等；按钮默认动作、购买后刷新和多实例持久幂等仍由应用接入 |
| 书源编辑与诊断 | 字段编辑、未知字段保留、规则预览、保存冲突、导入导出 | [编辑](../archive/source-editor.md) | 优先；所有能力字段至少可见、可保留、可诊断 |
| 书源校验与健康状态 | 域名、搜索、发现、详情、目录、正文、会话、版本和结果写回 | [校验流程](../upstream/android/flows/source-check-flow.md)、[校验状态](../upstream/android/rules/source-check-state.md) | 优先；不能用一次搜索成功替代全流程校验 |
| 用户持久化与状态清理 | 用户归属、版本、源变量、Cookie、缓存、校验状态和删除副作用 | [管理状态目标](../archive/source-management-and-state.md)、[reader-web 存储](../../apps/reader-web/docs/storage-and-cache.md) | 优先；存储由应用适配器提供 |

## 处理规则

每组能力都需要同一组可核验材料：原实现入口、字段与规则、输入、处理顺序、输出、状态变化、失败与取消、宿主依赖、应用调用点，以及成功、错误和边界 fixture。仅有字段注释或源码路径不能说明一项能力已经完整移植。

能力状态应分开记录：`已登记`、`行为已核对`、`规格已完成`、`TypeScript 已实现`、`目标宿主已验证`。此外记录优先级和宿主能力要求。若某个目标宿主缺少能力，仍可在其他宿主实现该能力；只有用户审核并明确同意后，才能把能力状态改为 `放弃`。低优先级不能写成永久不支持。

后续新增或更新能力记录必须使用分开的字段，不能把多个事实压缩在“证据成熟度”一句话中：

| 字段 | 允许内容 |
| --- | --- |
| `status` | `registered`、`behavior-checked`、`spec-complete`、`implemented`、`host-verified`、`pending-review`、`abandoned-approved` |
| `priority` | `high`、`medium`、`low` |
| `evidence` | 稳定源码/测试路径、行号、fixture 或 golden ID |
| `verification` | 尚缺的宿主、样本、执行或用户决策 |

现有能力索引中的“证据成熟度”仅作为历史摘要；更新某一行时应同时填入上述四项，避免把“已登记”“已实现”和“已执行”混为同一状态。

未完成能力的状态、完成条件和删除线记录统一维护在[状态总览](status.md)。本清单继续维护能力定义、Android 事实和实现边界，不重复维护状态表。

图片解密、付费、事件回调、媒体结果和段评交互的已核对调用关系见 [与书源关联的媒体和交互流程](../upstream/android/flows/adjacent-source-flows.md)。下一轮审查应继续追踪未核实的调用点，并把对应测试加入 [一致性测试基线](conformance-tests.md)。书源编辑器的字段覆盖也应按本清单反查，确保能导入、显示、保留和导出尚未执行的能力字段。

## 稳定能力索引

能力 ID 表示行为范围，不表示实现完成。字段级子 ID 使用 `父ID/字段路径`，宿主方法使用 `父ID/方法名/重载参数列表`；原字段表与方法列表是覆盖审计依据。证据基线见 [维护说明](../operations/package-maintenance.md)。

| ID | 范围与规格 | 测试组 | 证据成熟度 |
| --- | --- | --- | --- |
| CAP-IMPORT | 03 的 JSON/JS/远程/URI、替换及导出 | IMP、EDIT | `importSources`/`exportSource` 已实现（codec）；JSON 校验和外层 sourceUrls 已核对 |
| CAP-SCHEMA | 02 的全部 BookSource/rule 字段、RowUi | IMP-005、EDIT-005 | 字段已核对；登录动态协议仍有待核实项 |
| CAP-RULE | 04 的模式、链、变量、替换及转换 | SCH、VAR | `compileRule`/`evaluateRule` 已实现；golden 对照未全量运行 |
| CAP-REQUEST | 05 请求/响应/Cookie/DNS/代理 | URL、REQUEST-003、`packages/source-node/tests/network.test.ts` | `createRequestPlan`、Node HTTP/HTTPS/SOCKS/SOCKS5 代理、认证、重试/重定向和失败不直连已实现；代理 provider 与 Android 同输入仍待对照 |
| CAP-SEARCH / CAP-EXPLORE | 06、17 | FLOW-001 至 003、EXP、OBS-001 至 004 | `searchBooks`/`discoverBooks`、动态分类和五类控件已有实现；声明式请求、`mainJs` bridge 子请求及 URL/header/body 脚本的嵌套请求均可返回脱敏请求阶段和跳过原因；InfoMap 保存和选择快照差异见 D31/D40；exploreScreen 仅保留，当前未发现 Android 执行入口 |
| CAP-INFO / CAP-TOC / CAP-CONTENT | 07 至 09 | FLOW-004 至 012 | `loadBookDetails`/`loadTableOfContents`/`loadChapterContent`/`loadChapterContentBatch` 已实现；Node 批量测试通过，需跑 Android 对照 |
| CAP-JS | 10、11 的规则内 JS 和整源 JS | JS、IMP-008 至 010 | QuickJS 宿主已接入规则内 JS；Rhino 逐返回值对照与引擎互操作未全量验收 |
| CAP-MEDIA / CAP-ACTION / CAP-LOGIN | 20、10 | MEDIA、ACTION、LOGIN | 混合：读取、`executePayAction`、`executeSourceCallback`、reader-web 登录 API/页面和结构化动作已有入口；购买刷新、段评写入、真实网页交互和持久多实例幂等仍缺 |
| CAP-REVIEW | 段评流程的声明式摘要/详情/回复、JS 函数及旧式网页桥接 | JS-004、REVIEW-001、`packages/source-core/tests/review.test.ts`、[段评流程](../upstream/android/flows/review-flow.md) | 声明式/JS 结构化读取与 reader-web API 已实现；旧式桥接、写入和 Android golden 仍待完成 |
| CAP-EDITOR | 16 | EDIT | Web 目标设计与现有 UI 证据分开；独立 TS 编辑器见 [归档](../archive/source-editor.md) |
| CAP-STATE / CAP-SUBSCRIPTION | [兼容政策](../contracts/compatibility-policy.md)、[订阅流程](../upstream/android/flows/source-subscriptions.md) | STATE、SUB | `refreshSubscription` 已实现 diff 计划；应用持久化仍为目标设计 |
| CAP-ARTIFACT | [Android 实体边界](../upstream/android/rules/artifact-model.md) | SUB、MODEL | BookSource 已纳入；RssSource/ReplaceRule 需独立 adapter 验收 |
| CAP-HOST / CAP-DEPLOY | [宿主接口](../../packages/source-core/docs/host-ports.md)、[source-node 安全与部署](../../packages/source-node/docs/security-and-deployment.md) | HOST、DEP | 宿主端口已在 source-node 实现部分能力（`SourceRuleHost`/`SourceRequestHost`/QuickJS）；部署与统一 `RuntimeHost` 门面仍是目标契约 |
| CAP-JOB | [任务执行与 Serverless 边界](../archive/job-and-execution.md) | JOB、DEP | 目标契约，尚未实现执行器 |
| CAP-ENCODE / CAP-ARCHIVE / CAP-FONT / CAP-CONCURRENCY | 下表及 11、20 | EXT | 编码、加密、字体、zip/gzip 及可选 bsdtar RAR/7z、跨执行 SourceLock 已在 source-node 实现；外部命令缺失、平台交互和 Android golden 仍是明确边界 |

## 宿主方法补充盘点

以下主要来自 `help/JsExtensions.kt` 及其继承的 JsEncodeUtils，键值 get/put 等源方法定义在 `BaseSource`（见源方法行）；不能因为 11 的示意接口没列出而视为放弃。每个方法的重载都需单独案例，尚未完成逐重载语义对照的方法不能标记“规格完成”。

| 能力 | 方法族 | 处理要求与核实状态 |
| --- | --- | --- |
| 网络 | ajax、ajaxAll、ajaxTestAll、connect、get、head、post | 网络 get 与单参数键值 get 是不同重载；`ajaxAll/ajaxTestAll` 的 `skipRateLimit` 可绕过书源限流但不绕过宿主并发上限，`ajaxTestAll` 始终携带 Android 测试模式；返回 StrResponse/Connection.Response 不能混成同一未经适配对象 |
| 编码 | strToBytes、bytesToStr、base64Decode、base64DecodeToByteArray、base64Encode、hexDecodeToByteArray、hexDecodeToString、hexEncodeToString、encodeURI | core/Node 保留 charset、flags、null 和 bytes 返回差异；文件文本无显式 charset 时使用 BOM/`chardet`/UTF-8/GB18030 探测；逐重载 Android fixture 仍待执行 |
| 加密 | md5Encode、md5Encode16、createSymmetricCrypto、createAsymmetricCrypto、createSign；aesDecodeToByteArray/aesDecodeToString/aesDecodeArgsBase64Str/aesBase64DecodeToByteArray/aesBase64DecodeToString；aesEncodeToByteArray/aesEncodeToString/aesEncodeToBase64ByteArray/aesEncodeToBase64String/aesEncodeArgsBase64Str；desDecodeToString/desBase64DecodeToString/desEncodeToString/desEncodeToBase64String；tripleDESDecodeStr/tripleDESDecodeArgsBase64Str/tripleDESEncodeBase64Str/tripleDESEncodeArgsBase64Str；digestHex/digestBase64Str/HMacHex/HMacBase64 | Node 实现 AES/DES/3DES 的常见 CBC/ECB PKCS5/PKCS7、GCM/CCM AAD 与可变 tag、RSA PKCS1/OAEP/NoPadding、同摘要 MGF1 OAEP 和 RSA-PSS 签名工厂；Java Cipher 的 GCMParameterSpec/updateAAD/OAEPParameterSpec 已接入；不支持的 transformation 或独立 MGF1 摘要明确失败，算法、padding、key/IV 编码仍需 Android 向量逐项核对 |
| 文本/时间 | timeFormatUTC、timeFormat、htmlFormat、t2s、s2t、toNumChapter、toURL | `timeFormat`、`timeFormatUTC`、`htmlFormat`、`toNumChapter`、`toURL`、t2s/s2t 已接入 Node 平台；词库来自 quick-chinese-transfer Apache 2.0 数据并有平台回归 |
| 文件/脚本 | importScript、cacheFile、downloadFile、getFile、readFile、readTxtFile、deleteFile、getTxtInFolder | `NodeSourceFileHost` 使用受控 root、目录穿越/符号链接保护、下载预算和跨操作 cacheFile TTL；`File` 父对象和 `listFiles()` 子项提供受控的 `getName/getPath/getAbsolutePath/exists/isFile/isDirectory/length/lastModified/canRead/canWrite` 方法，并保持即时宿主元数据刷新；`File.absolutePath` 保持受控相对元数据，不暴露真实路径 |
| 归档 | unzipFile、un7zFile、unrarFile、unArchiveFile、getZipStringContent/getZipByteArrayContent、getRarStringContent/getRarByteArrayContent、get7zStringContent/get7zByteArrayContent | `NodeArchiveHost` 已实现 gzip/zip 的限制解包；RAR/7z 通过宿主 `bsdtar`/`archiveCommand` 执行并沿用路径、条目、输出和压缩比预算，命令缺失返回明确能力错误 |
| 字体 | queryBase64TTF、queryTTF、replaceFont | `NodeFontHost` 与 `replaceFont` 桥已实现；获取字体 → 解析轮廓 → Unicode 映射 → 替换；当前仅 TrueType/sfnt cmap 0/4/6 与 glyf，WOFF/WOFF2/CFF 仍明确不支持 |
| 并发 | singleFlight、lock、tick | `NodeSourceConcurrency` 在 session 内跨 QuickJS execution 共享等待队列、singleFlight 跳过、取消/超时、tick 溢出和 4096 LRU；跨进程/多实例锁仍由应用宿主决定 |
| 浏览器/交互 | webView、webViewGetSource、webViewGetOverrideUrl、startBrowser、startBrowserAwait、showBrowser、getVerificationCode、openVideoPlayer、openUrl；纯值 getWebViewUA | 浏览器/交互需要真实宿主协议，不能以 fetch 等价替代；getWebViewUA 已提供可覆盖的默认字符串，不需要浏览器 |
| 日志/设备/应用 | toast、longToast、log、logType、randomUUID、androidId、refreshBookInfo、refreshBookToc、refreshContent、getReadBookConfig、getReadBookConfigMap、getThemeMode、getThemeConfig、getThemeConfigMap | Node 平台提供受 seed 派生的非物理 deviceID、阅读/主题配置和 source 导航上下文；日志、刷新和 UI 动作由 `capabilities` 注入，未注入时明确诊断 |
| 源方法 | BaseSource 的 getHeaderMap、getLoginHeaderMap、getLoginInfoMap、setVariable/putVariable/getVariable、get/put、refreshExplore、refreshJSLib、putConcurrent、evalJS、evalLoginUiV2/evalLoginActionV2（登录 UI/action 的宿主方法名） | Node session 已提供源级请求头、登录头/Cookie、登录信息、变量和键值的会话隔离；动态 loginUi 默认值按 Android 调用链执行并缓存；`putConcurrent` 更新源限流，编辑/覆盖/删除后清理 source key 仍属应用生命周期 |

Node QuickJS 通过 `NodeSourceConcurrency` 在同一 source session 的不同 execution 之间共享 `singleFlight`/`lock` 等待和 `tick` LRU；它仍不是跨进程或跨实例分布式锁。多实例 Web 部署必须由应用宿主明确锁的范围，不能把 Android 进程内锁误称为分布式锁。

## 尚不能进入完整兼容验收的项目

- 方法名、继承成员、重载和返回对象必须分开核验。本轮具体缺口见[差异登记 D18～D43](known-divergences.md#android-与教程重新核对2026-10-21)，涵盖解析器方言、对象成员、请求实例、跨请求状态和文件隔离；仅验证 `typeof method === 'function'` 不能关闭能力项。
- QuickJS 的同步 bridge 已存在；JavaImporter、通用 Packages/JavaAdapter、Java String 身份和完整 JVM 互操作仍不等价。受控对象可单独实现，真实 JVM/Android 服务不能用 DTO 代替。常见书源依赖的 `Packages.okhttp3`（MediaType/RequestBody/Request.Builder/OkHttpClient/Response）和 `cn.hutool` 的 Base64、摘要、字符串/十六进制、gzip 入口已按 `JS-011` 提供受控模拟，并复用既有请求 bridge；完整 OkHttp/Hutool 重载和 JVM 对象身份仍不在 core 承诺内。
- 文件、字体、加密及 zip/gzip 已有实现；RAR/7z 有可选 bsdtar/archiveCommand 路径，外部命令不可用时仍为能力缺失。下载请求语义、文件账号隔离及嵌套返回对象仍须分别验收。
- 动态发现和五类控件已存在，但 InfoMap 保存、删除/TTL 和分页选择版本仍有差异。登录表单、应用动作和受控刷新已提供无浏览器路径；旧式段评网页桥接、验证码、真实网页交互和段评写入继续保留目标边界；不能根据字段存在自行推断 Android 写入流程。
- 设备/配置已有 Node 替代值，getWebViewUA 已有默认值；替代值与真实设备或当前阅读配置不同，应用未注入不能写为宿主已验证。Android 同输入 golden 未运行的能力继续标记待验证。
