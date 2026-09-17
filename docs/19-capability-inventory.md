# 书源能力清单与审核决策

目标是完整移植 `BookSource` 的可观察行为。优先级表示实施顺序，不表示放弃。若某项收益低且显著增加架构成本，应先给出使用场景、原实现证据、替代方案和兼容损失，再由用户审核是否舍弃。未经审核的能力保留在清单中，未实现时必须返回能力状态和可识别的错误。

本清单以 BookSource、规则实体、WebBook、AnalyzeRule/AnalyzeUrl、JsSourceBook 及其调用者为证据入口。字段登记不等于逐调用点验证；兼容结论以 [矩阵](13-compatibility-matrix.md) 和实际案例为准。RssSource 是另一个实体体系，本轮不纳入，不能与下载多个 BookSource 的书源订阅混淆。

| 能力组 | 需要形成的行为规格 | 当前文档位置 | 优先级与待核对内容 |
| --- | --- | --- | --- |
| 导入、更新、导出 | JSON、JS、远程地址、替换、冲突、未知字段和原文保留 | [导入](03-import-protocol.md)、[编辑](16-source-editor.md) | 优先；核对更新后的缓存失效和版本身份 |
| 书源字段与类型 | `BookSource`、规则对象、文本/音频/图片/文件/视频类型 | [模型](02-source-schema.md) | 优先；各类型从列表到消费结果的行为需分开验收 |
| 规则语言 | CSS、XPath、JSONPath、正则、组合、变量、内嵌 JS、WebJS | [规则](04-rule-language.md) | 优先；WebJS 需浏览器宿主能力 |
| URL 与请求 | 参数、页码、Body、Header、Cookie、重试、重定向、代理和 DNS | [URL](05-url-request-rules.md) | 优先；代理与 DNS 由宿主实现并验证 |
| 搜索与发现 | 多源搜索、精准搜索、分类入口、筛选状态、发现列表 | [搜索](06-search-flow.md)、[发现](17-explore-flow.md) | 优先；`exploreScreen` 和分类交互需要继续核对 |
| 详情与目录 | 字段覆盖、文件下载地址、目录刷新、分页、卷、VIP 和顺序 | [详情](07-book-info-flow.md)、[目录](08-chapter-list-flow.md) | 优先；文件类源需专门结果契约 |
| 正文与批量 | 正文分页、清洗、替换、缓存、批量、元数据保存 | [正文](09-content-flow.md) | 优先；音频、视频、图片和文件资源不能只按文本正文测试 |
| JavaScript 书源 | 配置抽取、函数调用、返回值、同步兼容 API、变量和脚本 scope | [JS](10-javascript-source.md)、[宿主](11-runtime-host-interfaces.md) | 优先；核对 `JsExtensions` 中未列出的实际书源依赖 |
| 图片与封面解密 | `coverDecodeJs`、`imageDecode` 的字节输入、脚本输出与缓存 | [模型](02-source-schema.md) | 后续规格；需核对 `ImageUtils` 及图片请求链 |
| 付费与受限章节 | VIP/购买标识、`payAction`、授权状态、执行后刷新 | [目录](08-chapter-list-flow.md)、[模型](02-source-schema.md) | 后续规格；需核对用户触发、凭据和失败恢复 |
| 段评读取与交互 | 摘要、详情、回复、点赞、发送和删除规则 | [JS](10-javascript-source.md)、[模型](02-source-schema.md) | 读取行为已发现；写入目前只有字段证据，先核实执行入口 |
| 登录与认证 | 静态 Header/Cookie、`loginCheckJs`、登录表单、验证码和动态登录 | [请求](05-url-request-rules.md)、[JS](10-javascript-source.md) | 静态能力优先；交互登录低优先级，保留完整目标 |
| 浏览器行为 | WebView 请求、`@webjs:`、资源嗅探和页面脚本 | [请求](05-url-request-rules.md)、[宿主](11-runtime-host-interfaces.md) | 后续宿主能力；不能把普通 HTTP 当成等价实现 |
| 书源交互与事件 | `eventListener`、`customButton`、正文回调和宿主 UI 动作 | [模型](02-source-schema.md) | 后续规格；需核对 `SourceCallBack` 和调用方事件协议 |
| 书源编辑与诊断 | 字段编辑、未知字段保留、规则预览、保存冲突、导入导出 | [编辑](16-source-editor.md) | 优先；所有能力字段至少可见、可保留、可诊断 |

## 处理规则

每组能力都需要同一组可核验材料：原实现入口、字段与规则、输入、处理顺序、输出、状态变化、失败与取消、宿主依赖、应用调用点，以及成功、错误和边界 fixture。仅有字段注释或源码路径不能说明一项能力已经完整移植。

能力状态应分开记录：`已登记`、`行为已核对`、`规格已完成`、`TypeScript 已实现`、`目标宿主已验证`。此外记录优先级和宿主能力要求。若某个目标宿主缺少能力，仍可在其他宿主实现该能力；只有用户审核并明确同意后，才能把能力状态改为 `放弃`。低优先级不能写成永久不支持。

图片解密、付费、事件回调、媒体结果和段评交互的已核对调用关系见 [与书源关联的媒体和交互流程](20-adjacent-source-flows.md)。下一轮审查应继续追踪未核实的调用点，并把对应测试加入 [一致性测试基线](15-conformance-tests.md)。书源编辑器的字段覆盖也应按本清单反查，确保能导入、显示、保留和导出尚未执行的能力字段。

## 稳定能力索引

能力 ID 表示行为范围，不表示实现完成。字段级子 ID 使用 `父ID/字段路径`，宿主方法使用 `父ID/方法名/重载参数列表`；原字段表与方法列表是覆盖审计依据。证据基线见 [维护说明](30-package-maintenance.md)。

| ID | 范围与规格 | 测试组 | 证据成熟度 |
| --- | --- | --- | --- |
| CAP-IMPORT | 03 的 JSON/JS/远程/URI、替换及导出 | IMP、EDIT | JSON 校验和外层 sourceUrls 已核对源码 |
| CAP-SCHEMA | 02 的全部 BookSource/rule 字段、RowUi | IMP-005、EDIT-005 | 字段已核对；登录动态协议仍有待核实项 |
| CAP-RULE | 04 的模式、链、变量、替换及转换 | SCH、VAR | 核心源码与现有测试定位；golden 未运行 |
| CAP-REQUEST | 05 请求/响应/Cookie/DNS/代理 | URL | 有源码及测试定位 |
| CAP-SEARCH / CAP-EXPLORE | 06、17 | FLOW-001–003、EXP | 有调用源码；exploreScreen 仅保留 |
| CAP-INFO / CAP-TOC / CAP-CONTENT | 07–09 | FLOW-004–012 | 已核对排序、去重及 mapAsync；需运行对照 |
| CAP-JS | 10、11 的规则内 JS 和整源 JS | JS、IMP-008–010 | 函数与返回模型有证据；引擎适配未验证 |
| CAP-MEDIA / CAP-ACTION / CAP-LOGIN | 20、10 | MEDIA、ACTION、LOGIN | 混合：读取有入口，段评写入仅字段证据 |
| CAP-EDITOR | 16 | EDIT | Web 目标设计与现有 UI 证据分开 |
| CAP-STATE / CAP-SUBSCRIPTION | 27、28 | STATE、SUB | Web 目标设计 |
| CAP-HOST / CAP-DEPLOY | 11、12、29 | HOST、DEP | 目标契约，尚未实现或部署 |
| CAP-ENCODE / CAP-ARCHIVE / CAP-FONT / CAP-CONCURRENCY | 下表及 11、20 | EXT | 已登记实际宿主方法，细分语义成熟度见下表 |

## 宿主方法补充盘点

以下来自 `help/JsExtensions.kt` 及其继承的 JsEncodeUtils；不能因为 11 的示意接口没列出而视为放弃。每个方法的重载都需单独案例，尚未完成逐重载语义对照的方法不能标记“规格完成”。

| 能力 | 方法族 | 处理要求与核实状态 |
| --- | --- | --- |
| 网络 | ajax、ajaxAll、ajaxTestAll、connect、get、head、post | 网络 get 与单参数键值 get 是不同重载；返回 StrResponse/Connection.Response 不能混成同一未经适配对象 |
| 编码 | strToBytes、bytesToStr、base64Decode、base64DecodeToByteArray、base64Encode、hexDecodeToByteArray、hexDecodeToString、hexEncodeToString、encodeURI | 保留 charset、flags、null 和 bytes 返回差异；逐重载 fixture 由阶段 B 完成 |
| 加密 | md5Encode、md5Encode16、createSymmetricCrypto、createAsymmetricCrypto、createSign；aesDecodeToByteArray/aesDecodeToString/aesDecodeArgsBase64Str/aesBase64DecodeToByteArray/aesBase64DecodeToString；aesEncodeToByteArray/aesEncodeToString/aesEncodeToBase64ByteArray/aesEncodeToBase64String/aesEncodeArgsBase64Str；desDecodeToString/desBase64DecodeToString/desEncodeToString/desEncodeToBase64String；tripleDESDecodeStr/tripleDESDecodeArgsBase64Str/tripleDESEncodeBase64Str/tripleDESEncodeArgsBase64Str；digestHex/digestBase64Str/HMacHex/HMacBase64 | JsEncodeUtils 有实现；算法、padding、key/IV 编码及工厂返回方法尚需逐项契约，不假设 WebCrypto 同名即等价 |
| 文本/时间 | timeFormatUTC、timeFormat、htmlFormat、t2s、s2t、toNumChapter、toURL | locale、时区、格式语法和 Unicode 需固定，宿主缺能力不能返回原文假成功 |
| 文件/脚本 | importScript、cacheFile、downloadFile、getFile、readFile、readTxtFile、deleteFile、getTxtInFolder | 只允许宿主私有命名空间；返回 Java File 需适配，不暴露真实路径 |
| 归档 | unzipFile、un7zFile、unrarFile、unArchiveFile、getZipStringContent/getZipByteArrayContent、getRarStringContent/getRarByteArrayContent、get7zStringContent/get7zByteArrayContent | 下载/读取 → 限制解包 → 选择路径 → bytes/解码文本；不存在条目与损坏归档分开；阶段 D 对照 |
| 字体 | queryBase64TTF、queryTTF、replaceFont | 获取字体 → 解析轮廓 → Unicode 映射 → 替换；不能用普通字符串替换冒充字体解码，阶段 D 对照 |
| 并发 | singleFlight、lock、tick | 默认等待 15000ms，允许 0–300000ms；名称非空且不超过 256；源身份隔离，详见下段 |
| 浏览器/交互 | webView、webViewGetSource、webViewGetOverrideUrl、startBrowser、startBrowserAwait、showBrowser、getVerificationCode、openVideoPlayer、openUrl、getWebViewUA | 需要真实宿主协议；低优先级保留，不能以 fetch 等价替代 |
| 日志/设备/应用 | toast、longToast、log、logType、randomUUID、androidId、refreshBookInfo、refreshBookToc、refreshContent、getReadBookConfig、getReadBookConfigMap、getThemeMode、getThemeConfig、getThemeConfigMap | 可映射宿主事件或受控配置；androidId 的 Web 替代语义未决定，缺能力明确诊断 |
| 源方法 | BaseSource 的 getHeaderMap、getLoginHeaderMap、getLoginInfoMap、setVariable/putVariable/getVariable、get/put、refreshExplore、refreshJSLib、putConcurrent、evalJS、登录 UI/action 方法 | 源配置对象继承 JsExtensions，不仅是 11 中少数 getter；按会话隔离持久状态 |

SourceLock.singleFlight 让同批等待者在一次成功执行后跳过 action，并非给所有调用者返回相同 Promise 值；同线程重入直接跳过。lock 每个调用都执行 action。tick 返回递增前值，初次 0，达到 Int.MAX_VALUE 后归零，4096 项 LRU。Web 多实例范围必须由宿主说明，不能把 Android 进程内锁误称为分布式锁。

## 尚不能进入完整实现验收的项目

- JS 引擎同步桥接、Rhino 互操作及部署：阶段 B 负责人按 29 的专项案例验证；未通过前不承诺完整 JS 兼容。
- 编码/加密工厂返回对象、字体与归档逐重载：对应 B/D 负责人核对实现和样本后补全原子案例；当前登记不等于规格完成。
- exploreScreen、RowUi 动态动作细节、段评写入：对应 D 负责人追踪调用点；无入口则保持字段保留，不擅自新增请求语义。
- 设备与阅读器绑定的替代行为：应用需求尚未定义，保留 capability-missing；任何舍弃须用户审核。
