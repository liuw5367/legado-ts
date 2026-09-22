# 一致性测试基线

## 当前已有证据

仓库中与书源运行时直接相关的测试包括：

- `app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeByJSoupDomTest.kt`：自闭合链接、`textNodes`、链式选择、节点身份、正向/负向/排除索引和 DOM 非破坏性；
- `app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeRuleElementsNormalizationTest.kt`：JS 数组结果过滤 null；
- `app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeUrlNetworkOptionsTest.kt`：Cookie 域、timeout、布尔选项、DNS 字面量、代理冲突、重定向和客户端超时；
- `app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeUrlLoginHeaderContractTest.kt`：`url` 索引登录请求头契约；
- `app/src/androidTest/java/io/legado/app/model/webBook/SourceContentCompatibilityTest.kt`：正文 textNodes/替换、Base64 JS 内容和目录刷新顺序；
- `app/src/test/java/io/legado/app/model/webBook/SearchPaginationContractTest.kt`：搜索 page owner、回调时序和取消；
- `app/src/test/java/io/legado/app/model/jsSource/JsSourceConfigTest.kt`：配置抽取、必备函数、文件源、批量、发现、登录和脚本剥离；
- `app/src/test/java/io/legado/app/model/jsSource/JsSourceMarshallerTest.kt`：搜索/详情/章节返回值归一化；
- `app/src/test/java/io/legado/app/model/jsSource/JsSourceEngineTest.kt`：scope 绑定、脚本返回值、toJSON/getter、undefined 和取消；
- `app/src/test/java/io/legado/app/model/jsSource/JsSourceBookTest.kt`、`WebBookTest.kt`：卷节点、空正文和文件源；
- `app/src/test/java/io/legado/app/model/jsSource/JsSourceReviewTest.kt`：段评摘要、详情、回复和嵌套回复归一化；
- `app/src/test/java/io/legado/app/model/jsSource/JsSourceUpsertTest.kt`、`JsSourceDispatchSentinelTest.kt`、`JsSourceTocWriteBackSentinelTest.kt`：JS 源保存、流程分流和目录回写边界；
- `app/src/test/java/io/legado/app/ui/association/BookSourceImportTest.kt`：书源输入分类、远程导入和候选写入边界；
- `app/src/test/java/io/legado/app/api/JsSourceWebApiContractTest.kt`、`app/src/test/java/io/legado/app/help/config/JsSourceApiTokenTest.kt`：Node/API 访问令牌和 JS 源接口契约；
- `app/src/test/java/io/legado/app/ui/book/source/edit/JsSourceDirectDebugTest.kt`、`JsSourceEditRedirectTest.kt`：编辑器调试、重定向和保存流程；
- `app/src/test/java/io/legado/app/ui/book/read/JsSourceReviewDispatchSourceTest.kt`：段评运行时分流；
- `app/src/test/java/io/legado/app/api/ReviewWebApiContractTest.kt`：结构化段评 HTTP 入口、旧式页面桥接、nonce、CSP/sandbox 和脚本执行边界；
- `modules/web/tests/sourceEditor.test.js`：现有 Web 编辑器的响应式布局、脚本模板、状态恢复、保存和访问令牌行为。

当前没有与这些 Kotlin 规则结果直接对照的 TypeScript runtime 测试；需要新增独立 fixture 和 golden 输出。

外层 legado 仓库根目录（`typescript/` 的上一级）中的 `examples/rule-fixtures.json`、`examples/source-minimal.json` 和 `examples/source-js-minimal.js` 是脱敏的文档样例，不等同于 Android golden。它们不属于本子仓库，独立克隆 `typescript/` 时不会包含。这些样例是脱敏示意，不能直接作为 fixture 模板。例如，`rule-fixtures.json` 中的 `evidence` 字段是源码路径字符串且无 `spec`/`execution` 字段，与本章的枚举格式不同；在补齐 Android 实际输出和 TypeScript 断言前，不能用于宣称兼容。

## Fixture 格式

建议每个 fixture 记录：

```json
{
  "id": "rule-default-text-nodes-001",
  "evidence": "test-run",
  "spec": "defined",
  "implementation": "absent",
  "execution": "not-run",
  "priority": "required",
  "source": "https://fixture.invalid/source",
  "input": { "kind": "html", "body": "..." },
  "context": { "baseUrl": "https://fixture.invalid/book/" },
  "operation": { "kind": "string", "rule": "div@textNodes" },
  "expected": { "value": "..." },
  "events": [],
  "error": null,
  "writes": [],
  "androidEvidence": {
    "kind": "test",
    "path": "app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeByJSoupDomTest.kt",
    "case": "self closing links preserve legacy direct text nodes"
  },
  "tsAssertion": {
    "path": "packages/source-core/tests/rules/default-text-nodes.test.ts",
    "test": "rule-default-text-nodes-001"
  },
  "http": [],
  "lifecycle": {
    "expectedEvents": [],
    "expectedWrites": [],
    "cleanup": "not-applicable",
    "mustRelease": ["rule-scope"]
  }
}
```

字段约定：id 稳定且不可复用，source 为脱敏身份，input/context/operation/expected 为具体输入和期望。`implementation` 和 `priority` 必须与兼容性矩阵使用同一枚举；`events`、`error`、`writes` 和 `lifecycle` 用于断言轨迹、失败语义、领域写入和资源清理。androidEvidence 指明源码或实际执行测试；Web 新设计使用 designEvidence 指向规格。tsAssertion 在设计阶段为计划路径，只有实际存在并执行后才是验证证据。status 是旧摘要字段，新记录分别使用 evidence=source/test-run/design、spec=defined/blocked、implementation=absent/partial/implemented、execution=not-run/pass/fail、priority=required/host/later/verify；不把五个维度压成一个完成状态。上方 JSON 是格式示意，真实案例禁止用省略号作输入或期望。fixture 不保存秘密。

`expected` 至少包含领域结果或明确的空结果；`error` 在成功案例中为 `null`，在失败/取消/超时案例中包含稳定 `code`、`stage`、`retryable` 和 `continue`；`writes` 记录是否提交、提交版本和拒绝原因；`events` 按发生顺序记录统一事件类型 `start`、`progress`、`source-success`、`source-error`、`saved`、`completed` 或 `cancelled`。`empty`、`partial`、`failed`、`stale` 和 `unknown` 是结果状态，不是事件类型，应记录在事件或最终结果的 `status` 字段中。有资源的案例必须填写 `lifecycle.cleanup` 和 `mustRelease`，纯值转换没有资源时使用 `cleanup=not-applicable`，不伪造释放事件。

网络 fixture 的每条记录至少包含 `method`、展开后的 `url`、请求头白名单、请求体、响应状态、最终 URL、脱敏响应头、响应体和模拟延迟。`retry` 用例还要记录每次尝试及最终错误；分页用例要记录请求启动顺序、响应完成顺序和最终收集顺序。golden 只保存稳定输出、稳定错误码、阶段、能力状态、事件顺序、写入结果和清理结果，不比较平台特有的堆栈文本。

错误 fixture 必须明确 `continue`、`partialResult` 和 `writes`。例如字段读取失败可以继续并留下空字段，必需函数缺失必须终止 JS 源导入，单个书源搜索失败可以继续其他书源，目录分页失败不能提交不完整目录，正文保存 token 过期不能覆盖新正文。每个有资源的流程都至少有成功、空值、失败、取消、超时和资源清理样本；纯值转换至少覆盖成功、空值和失败，并明确清理不适用。

## 用例目录和覆盖矩阵

以下 ID 是测试分组，不是单个完成断言。实现时按本章具体子案例使用 `父ID/场景`，每个子案例有独立输入和期望；同一 fixture 可在多个宿主复用，不用单元测试替代组合测试。

| 用例 ID | 范围 | 场景与必须断言 |
| --- | --- | --- |
| `IMP-001` | 导入 | 单对象、数组对象和非空 `bookSourceUrl`，输出候选顺序和诊断 |
| `IMP-002` | 导入 | JSON、绝对 URL、URI、JS 文本分类，记录 fetch/parse 阶段 |
| `IMP-003` | 导入 | sourceUrls 外层列表保持重复项和输入顺序；Web 逐项错误收集与原版事实分开 |
| `IMP-004` | 导入 | 远程内容再次包含 `sourceUrls`、空项、空响应和非法内容，拒绝写入 |
| `IMP-005` | 导入 | 规则对象与 JSON 字符串归一化，未知字段保留，原始字段可导出 |
| `IMP-006` | 导入 | 替换规则按名称和 URL 命中，严格 JSON、宽松 JSON、替换失败和原文回退 |
| `IMP-007` | 导入 | 同 URL 本地源的 new/update/same/conflict，用户字段覆盖策略和事务原子性 |
| `IMP-008` | JS 导入 | `config`、旧版 `source`、配置字段错误、脚本错误和必备函数错误 |
| `IMP-009` | JS 导入 | `exploreUrl/explore`、`loginUi/login/loginAction` 的成对校验 |
| `IMP-010` | JS 导入 | 段评函数配对、`maxBatchSize/getContentBatch` 配对、剥离规则与 `mainJs` 原文保留 |
| `EXP-001` | 发现分类 | 空入口、普通文本 `&&`/换行与 `::`、无 URL 项和输入顺序 |
| `EXP-002` | 发现分类 | JSON `ExploreKind` 的五类控件、未知字段保留与错误诊断 |
| `EXP-003` | 发现分类 | `@js:`/`<js>`、`infoMap`、分类缓存更新及跨会话隔离 |
| `EXP-004` | 发现列表 | 声明式 `ruleExplore`、`ruleSearch` 回退、响应最终 URL 和同源去重 |
| `EXP-005` | 发现列表 | JS 源 `explore(url, page)` 返回归一化、非法结果与取消 |
| `EXP-006` | 发现生命周期 | 换分类、换页、旧请求迟到、分类 URL 为空和宿主能力缺失 |
| `SCH-001` | 规则 | 默认 CSS、旧式 `class/tag/id/text`、`@CSS` 元素选择、字符串终端输出和模式前缀大小写不敏感 |
| `SCH-002` | 规则 | `@` 链、`text`、`textNodes`、`ownText`、`html`、`all`、属性输出 |
| `SCH-003` | 规则 | 正负索引、范围、负步长、排除、越界和 DOM 不被破坏 |
| `SCH-004` | 规则 | `@XPath`、XML 声明、表格片段补容器、节点/字符串/空结果归一化 |
| `SCH-005` | 规则 | `@Json`、自动 JSON、对象/数组/标量、嵌套插值和非法 JSONPath |
| `SCH-006` | 规则 | `&&`、`\|\|`、`%%` 在括号、引号、JSONPath、CSS 属性和代码中的平衡切分 |
| `SCH-007` | 规则 | 全规则 Regex、`$1` 捕获组、`##match##replace`、首个替换和非法正则回退 |
| `SCH-008` | 规则 | JS 先扫描、WebJS 后扫描的兼容顺序和 capability error，不擅自按原文排序 |
| `VAR-001` | 变量 | local、chapter、book、rule-data、source 的读取优先级；local 空值命中与其他作用域空值回退 |
| `VAR-002` | 变量 | `@put`、`@get`、`{{}}` 写入、读取、删除、序列化和请求隔离 |
| `URL-001` | URL | URL JS、`{{}}`、页码占位、URL options 的展开顺序和整数格式化 |
| `URL-002` | URL | GET/HEAD query、POST 表单/JSON/XML、charset、escape 和空字段保留 |
| `URL-003` | URL | headers、Cookie 合并、最终域名、登录头、跨域 `@js` 改写和 CDN 隔离 |
| `URL-004` | URL | timeout、call timeout、retry 次数、取消、重定向关闭/开启和循环保护 |
| `URL-005` | URL | DNS 字面量、非法地址、proxy 冲突、bodyJs、XML 补声明和 bytes 响应 |
| `URL-006` | URL | 已发出写请求后的 unknown 结果、幂等身份和禁止不安全自动重试 |
| `URL-007` | URL | `concurrentRate` 的空值/0、次数/毫秒语法、同源共享、窗口重置、非法配置和取消等待 |
| `FLOW-001` | 搜索 | 单源列表/详情页回退、书名丢弃、同源去重、精准搜索和分类组 |
| `FLOW-002` | 搜索 | 多源并发、30 秒超时、progress/callback 顺序、持久化先于成功事件 |
| `FLOW-003` | 搜索 | pause/resume、新请求取消旧 page owner、迟到结果和所有源失败 |
| `FLOW-004` | 详情 | infoHtml 命中、请求/重定向/loginCheckJs、init、新旧字段覆盖和 canReName |
| `FLOW-005` | 详情 | 字段级异常继续、目录缓存、文件下载 URL 为空、Book 提交和失败回滚 |
| `FLOW-006` | 目录 | tocHtml 命中、preUpdateJs、单页串行、多页并发、重复 URL 和循环停止 |
| `FLOW-007` | 目录 | 卷节点、空标题短路 VIP/购买、空 URL 占位、VIP/购买、字数、`-`/`+` 与 `readConfig.reverseToc` |
| `FLOW-008` | 目录 | 去重、重新编号、formatJs 失败、旧章节元数据合并、统计更新和事务边界 |
| `FLOW-009` | 正文 | 缓存命中/失效、下一章保护、单页/多页、空正文和资源类型 |
| `FLOW-010` | 正文 | subContent、replaceRegex、标题图片、歌词/弹幕、响应 URL 和清理 |
| `FLOW-011` | 正文 | save token、旧请求覆盖保护、保存失败、取消、章节元数据和保存事件 |
| `FLOW-012` | 批量 | contentBatch/getContentBatch、章节对象识别、重复 URL 歧义、锁、漏存兜底 |
| `JS-001` | JS | 每次调用 scope、绑定对象、共享 scope 显式开关、toJSON/getter/循环引用 |
| `JS-002` | JS | `ajax`、`ajaxAll`、`ajaxTestAll`、`connect` 的请求描述、错误兼容文本、取消传播和 `skipRateLimit` 绕过语义 |
| `JS-003` | JS | `cacheContent` 仅批量可用、版本 token、回调乱序、保存计数和关闭上下文 |
| `JS-004` | 段评 | 声明式/JS 摘要索引、详情游标、回复分页展平、内容协议、函数配对/缺失终态和媒体基准地址 |
| `REVIEW-001` | 旧式段评 | `getDP/getZP` 页面打开、nonce 会话、CSP/sandbox 桥接、脚本上限、书源变更和图片重写 |
| `MEDIA-001` | 媒体 | 文本、音频、图片、视频和文件类型从列表到详情的身份与结果类型 |
| `MEDIA-002` | 图片 | 封面和正文图片 bytes 解密、失败回退、Cookie 和缓存隔离 |
| `MEDIA-003` | 文件 | 下载地址归一化、空地址错误、下载能力缺失和资源清理 |
| `ACTION-001` | 购买 | VIP/已购买状态、用户触发 `payAction`、成功刷新与失败保留原状态 |
| `ACTION-002` | 段评写入 | 先核实 Android 是否存在执行入口；若只存在规则字段，测试保留与诊断，Web 新增写入流程另列目标设计测试，不宣称 Android 等价 |
| `ACTION-003` | 书源事件 | `eventListener`、`callBackJs`、`customButton` 的事件上下文、取消和权限 |
| `LOGIN-001` | 登录 | 静态 Header/Cookie、`loginCheckJs`、登录过期与重试边界 |
| `LOGIN-002` | 登录 | 静态和动态登录 UI、验证码/多步骤流程的宿主能力与隔离 |
| `HOST-001` | Host | Http/HTML/XPath/JSONPath/JS/Cookie/Cache 端口的空值、错误和资源释放 |
| `HOST-002` | Node | requestId、响应限制、来源白名单、错误到 HTTP DTO、Cookie 隔离和 abort |
| `HOST-003` | Next | SSR 请求隔离、动态缓存键、客户端断开、模块级状态扫描和响应脱敏 |
| `HOST-004` | Edge/Node | 同一公开入口在不同宿主的能力报告；缺失能力不能伪造成功 |
| `API-001` | package | 从导入候选确认到搜索、详情、目录和正文的公开入口组合流程 |
| `API-002` | package | 编辑保存后规则版本变更、旧请求迟到、缓存失效和用户字段保护 |
| `API-003` | adapter | `/saveBookSources` 的逐项无效跳过、accepted/skipped 结果和兼容直接保存语义 |
| `API-004` | adapter | JS source 的 `text/plain`、Content-Length/Transfer-Encoding、1 MiB/30 秒限制、body 前 token 校验、trim、`openedSourceUrl` 和重命名清理 |
| `API-005` | adapter | 已保存书源前置条件、用户鉴权、脱敏响应和 source check session/token |
| `API-006` | adapter | `/getBookSourcesForManagement` 的 `sources`/`states` 同快照、`urls` 去重筛选和跨用户隔离 |
| `API-007` | adapter | `searchBook` 首帧 `{key}`、`bookSourceDebug` 首帧 `{tag,key}`、唯一首帧、10 秒超时和连接清理 |
| `API-008` | adapter | `web-safe` 与 `android-compatible` 插入策略的域名拦截、排序修正和直接 DAO 差异 |
| `SUB-001` | 订阅 | 多 `BookSource` 订阅、RuleSub 时间/类型分支、三方差异、静默模式、失败保留和 subscriptionRevision 并发控制 |
| `MODEL-001` | 模型 | 源配置与用户状态分离、远程管理字段覆盖、原文/未知字段回写和改名冲突 |
| `MODEL-002` | 模型 | BookSource、RssSource、ReplaceRule 的类型边界和未知 artifact 诊断 |
| `REQUEST-001` | 运行时 | RequestPlan 的执行提示、bytes、requestCharset/responseCharset 分离和宿主物化边界 |
| `JOB-001` | 任务 | 幂等创建、租约竞争、恢复、取消、unknown 和旧源版本保护 |
| `RESOURCE-001` | 资源 | ContentStore/ResourceStore、MIME、bytes、文件链接、大小限制和清理 |
| `SECURITY-003` | 安全 | Cookie、变量、任务和资源的跨用户隔离及不存在性保护 |
| `CHECK-001` | 书源检测 | 配置开关、阶段依赖、空结果/规则缺失/网络错误/跳过状态和阶段统计 |
| `CHECK-002` | 书源检测 | 单源超时、批量部分失败、取消信号和 session 状态转换 |
| `CHECK-003` | 书源检测 | sourceRevision/checkRevision 条件回写，旧检测结果和删除后结果不能覆盖新状态 |
| `CHECK-004` | 书源检测 | 文件源、JS/登录能力缺失和 Edge capability error 的明确结果 |
| `REPO-001` | 存储 | 两个用户相同 sourceId 的读写隔离、source/check/subscription 关联隔离 |
| `REPO-002` | 存储 | expectedSourceRevision CAS、规则变更重置检查、纯用户字段变更不误重置 |
| `REPO-003` | 存储 | 批量导入原子提交、事务失败回滚和旧 baseline 保留 |
| `REPO-004` | 存储 | 删除后的变量/cookie 引用/检查/缓存清理以及书架和阅读进度保留策略 |
| `REPO-005` | 存储 | SourceHelp 插入策略与 Repository 保存边界分离；拒绝项无写入，兼容直接保存的差异可审计 |
| `SEC-001` | 安全 | RLS 与服务端授权双重校验；SPA 无 service key，越权读写和旧任务回写均拒绝 |
| `SEC-002` | 安全 | 导入、错误、调试、导出和数据库日志中的 cookie/token/password/header 脱敏 |
| `EDIT-001` | 编辑器 | JSON/JS 导入、规范化、字段诊断、未知字段和完整 `mainJs` 保留 |
| `EDIT-002` | 编辑器 | JSON/JS 切换、未保存保护、dirty 状态和原文回退 |
| `EDIT-003` | 编辑器 | fake 预览请求、逐步 trace、脱敏 header、capability error 和资源清理 |
| `EDIT-004` | 编辑器 | 导入导出 round-trip、版本冲突、覆盖确认和保存失败 |
| `EDIT-005` | 编辑器 | 所有 ReviewRule 字段保留、preserve-only 显示、移动端布局和访问令牌行为 |

## 测试目录、断言和执行门槛

建议的子仓库测试资源布局如下，目录建立后 fixture、golden 和断言必须一一对应：

```text
fixtures/
  import/
  rules/
  url/
  workflows/
  javascript/
  explore/
  media/
  actions/
  login/
  package-api/
  editor/
goldens/android/
goldens/typescript/
packages/source-core/tests/
packages/source-node/tests/
packages/source-next/tests/
packages/source-editor/tests/
```

每个测试至少断言四类结果：

1. 领域结果，包括字段值、列表顺序、去重、来源集合、章节索引和正文内容；
2. 处理轨迹，包括请求顺序、规则阶段、分页完成顺序、回调顺序、缓存命中和持久化写入；
3. 失败语义，包括稳定错误码、阶段、是否继续、是否允许部分结果和 capability 状态；
4. 生命周期，包括 AbortSignal 传播、超时后不再重试、旧请求不能回写、scope/Cookie/变量/监听器/批量上下文已释放。

fixture 生成器必须支持从 Android 输出生成 golden，并对 Cookie、Token、密码、Authorization、私有请求体和真实账号做脱敏。golden 的比较应采用结构化比较，集合只有在契约声明无序时才允许排序，事件和网络记录必须按顺序比较。时间、随机数、堆栈、线程名和平台路径使用占位断言，不能写死到兼容结果中。

真实测试命令随 runtime 提交。书源解析运行时的兼容测试拆分为两个任务：`07-A` 负责 schema、规则、请求、解析器、QuickJS、工作流和宿主能力的无公网 conformance；`07-B` 负责读取 `fixtures/source` 下的真实书源文件，并验证集合导入与单个导入的一致性。任务 11 保留跨模块集成、存储、编辑器和发布门禁，不再把书源文件回归测试混在其中。兼容案例须有 Android 证据、golden、TS 断言及相关清理断言；Web 新设计只要求对应设计证据与目标断言，不强迫虚构 Android golden。纯值转换无资源时标注清理不适用。未执行的案例一律 execution=not-run。

覆盖审计按以下关系执行：`reference/source-schema.md` 的每个可执行字段至少映射一个 schema/import 用例；`reference/rule-language.md` 和 `reference/url-request-rules.md` 的每个模式、组合符号、选项和错误至少映射一个规则/URL 用例；发现、搜索、详情、目录、正文、JS、宿主和编辑器的每个状态、分支、输出和能力至少映射一个对应流程用例。`reference/capability-inventory.md` 的每一行都要指向规格与测试 ID；没有测试设施的能力也要记录输入、预期结果和未验证原因。审计结果记录为表格，不以“已有某个测试文件”代替覆盖证明。

## 必须覆盖的规则样本

### 解析器

- 默认选择、`@CSS:`、`@XPath:`、`@Json:` 和自动 JSON 识别；三种显式模式前缀大小写不敏感；
- `&&` 拼接、`||` 首个成功、`%%` 按索引交错；
- 选择器和 JSONPath 中含 `&&`/`||` 的平衡切分；
- `@` 链、`text`、`textNodes`、`ownText`、`html`、`all` 和属性；
- 正索引、负索引、范围、负步长、排除和越界；
- `:regex` 的完整匹配/捕获组列表、`$1`、`##match##replace` 的省略替换文本和首个替换；
- `@put`、`@get`、规则型/JS 型 `{{}}`、多个变量和变量优先级；
- 空规则、空列表、字段缺失、null、非法 JSON、非法正则和不平衡括号；
- 连续 `<js>`/`@js:`/`@webjs:` 混合块的顺序。
- 纯 CSS 元素选择与 CSS 字符串输出的边界：`@CSS:div.book` 可用于元素选择，字符串读取需要 `@text`、`@href` 等终端输出。

### URL

- 相对 URL、query、已编码参数、UTF-8/escape、POST 表单/JSON/XML；
- `<...>` 页码替换、`{{}}` 与 URL `@js` 顺序；
- options 的 method/header/body/type/charset/retry/webView/bodyJs/timeout/followRedirects；
- Cookie 合并优先级、最终域名、跨域登录头；
- 非法 timeout、布尔值、DNS、proxy + dnsIp、数据 URL、302。
- `origin` 字段的导入导出保留，以及当前请求实现不使用该字段的事实。

### 流程

- 搜索列表、详情页回退、去重、精准合并和取消；
- 详情 `init`、字段覆盖、简介特殊标记、目录缓存和文件下载 URL；
- 目录分页、重复 URL、重复章节、卷节点、VIP/购买、formatJs 和顺序；
- 正文分页、下一章保护、HTML 清洗、副文、标题图片、空正文、缓存和批量兜底。
- 卷节点空正文、非卷章节空正文回退、目录 `-` 前缀与 `reverseToc` 组合、`canReName` 非空配置和调用权限。
- 精准搜索按书名、作者和分类命中，且分类命中进入分类结果组。
- 段评摘要、详情、回复的函数配对、段落索引和分页返回值。

## 验证层级

1. 规则纯函数测试：词法拆分、模式和组合；
2. parser adapter 测试：同一 DOM/JSON 的输出；
3. 流程组合测试：用 fake HTTP 保留完整请求和解析链；
4. Node/Next adapter 测试：真实 fetch 入口、AbortSignal、Cookie 隔离和响应限制；
5. 编辑器测试：诊断、预览、未保存修改、导入导出和移动端布局。

测试资源必须在每个需要资源的用例结束时释放；纯值转换应记录 `cleanup=not-applicable`。网络真实站点只用于人工诊断，不作为稳定 golden 来源。任何兼容性结论都要同时注明 Android 证据和 TypeScript 断言，不能只依赖文档示例或人工截图。

## 具体状态与交叉案例

下表全部为设计案例，当前未执行。`fixture.invalid` 由 fake HTTP 提供，A/B 为两个不同 sourceId，s1/s2 为不同会话，v1/v2 为保存版本。缺省前置条件：预算充足、无预存数据、无用户凭据；表中“无写入”指领域存储，网络已发生等事实另外记录。有资源的案例结束均断言 operation closed、无在途请求与脚本句柄；纯值转换案例改为断言 `cleanup=not-applicable`。

| 子案例 | 具体输入/调度 | 必须断言 |
| --- | --- | --- |
| IMP-001/no-name | JSON `{"bookSourceUrl":"A"}` | 一个候选，名称缺省诊断，不误报缺 URL |
| IMP-001/invalid-member | `[{"bookSourceUrl":"A"},{}]` | 数组整体失败，无可保存成功数组 |
| IMP-001/empty | `[]` | 零候选成功，无网络无写入 |
| IMP-003/repeated | sourceUrls 为 `[u,u]`，u 每次返回 A | 保留两个输入位置；保存冲突显式表达，不静默去重 |
| IMP-004/nested | 外层 u，u 响应 `{"sourceUrls":["v"]}` | parse 失败，不请求 v |
| IMP-005/roundtrip | A 含未知对象 x={a:1}，ruleSearch 为 JSON 字符串 | 未编辑导出原文；改分组后 x 与规则形态仍保留 |
| IMP-008/js-name | JS config 仅 bookSourceUrl=A，必需函数齐全 | 缺名称配置错误，与 JSON 名称规则不同 |
| SCH-001/prefix-case | HTML `<div class="book">A</div>`、JSON `{"book":"A"}`，分别比较 `@CSS:`/`@css:`、`@XPath:`/`@xPaTh:` 和 `@Json:`/`@JSON:` | 前缀大小写不影响模式识别；规范写法与混合大小写写法输出一致 |
| SCH-002/text-nodes | `<div>A<b>B</b>C</div>`，`tag.div@textNodes` | 直接文本 `A\nC`，不包含 B；对照原测试确认实体细节 |
| SCH-003/nonmutating | 三个 a 的文本为 A/B/C，先排除索引 0，再读全部 | 首次 B/C，第二次仍 A/B/C |
| SCH-006/bracket | `a[href="x\|\|y"]@text` | 属性中的组合符不切断 |
| SCH-007/capture-zero | 输入 `abc123`，`:([a-z]+)(\\d+)`，另测可选捕获组未命中的情况 | 返回列表第 0 项为完整匹配，后续项为捕获组；缺失捕获组以空字符串保留；链式正则只使用前一阶段完整匹配文本 |
| SCH-007/literal-fallback | 已取值 `a[b`，替换 pattern=`[`、replacement=`X` | 非法正则按原字面回退得到 aXb |
| SCH-007/replace-optional | 已取值 `a1b2`，分别使用 `规则##数字`、`规则##数字##X##extra` 和无匹配规则 | 省略 replacement 时删除全部匹配；第四段只在首个完整匹配片段内替换并丢弃前后缀，得到 `X`；无匹配返回空字符串 |
| SCH-007/invalid-first | 已取值 `a1b2`，首个匹配分支使用非法 pattern `[`，非首个分支也使用 `[` | 首个分支直接返回 replacement；非首个分支按字面执行完整替换 |
| VAR-001/empty-local | local.k=""，book.k="B"，source.k="S" | get k 立即返回空串，不回退到 B/S；写 local.k=L 后为 L |
| VAR-001/missing-local | local 未定义，book.k="B"，source.k="S" | get k 回退到 B；book 未定义时再回退 source |
| VAR-002/context-bindings | 同一 key 分别存在 chapter/book/rule-data/source；声明式规则、URL 规则、BaseSource 和 JS 源各执行一次 `java.get/put` | 声明式按 AnalyzeRule 局部变量和作用域写入；source get/put 只改书源命名空间；JS 源只看到注入的 JsExtensions，未注入方法报告 capability-missing |
| URL-001/page | URL `/p/<a,b>`，page=3 | 选最后项 b，生成 /p/b |
| URL-003/redirect-policy | 公网初始地址重定向到 127.0.0.1 | 宿主拒绝第二跳，无内网请求，policy-denied |
| URL-004/cancel-retry | retry=2，第一次请求未完成时取消 | 不启动第 2/3 次，cancelled 而非空成功 |
| URL-006/request-unknown | POST 已发出，响应前连接断开 | 返回 `unknown`/`request-unknown`，不自动重发；保留 operationId 和 idempotencyKey |
| FLOW-001/nameless | 列表两项 name="" 与 name="书" | 丢弃第一项；只返回后一项 |
| FLOW-002/partial | A 返回一本书，B 超时 | 保留 A，B 有错误；sink 完成先于 A 的 source-success |
| FLOW-003/all-failed | A/B 均请求失败 | 无结果但有两个失败，区别于两个合法空列表 |
| FLOW-004/rename | 已有 name=旧，规则 name=新；canReName 配置 `false` 非空、调用权限 false | 保留旧；权限 true 时按非空开关可覆盖，不能求值配置字符串 |
| FLOW-004/name-author-cleanup | 搜索/详情分别输入 `作者：甲`、`乙 著` 和清洗后空串 | 先按 `formatBookName`/`formatBookAuthor` 清洗再过滤或覆盖；清洗为空的搜索项丢弃，详情不覆盖已有值 |
| FLOW-005/atomic | 文件源解析到新名称但 downloadUrls=[] | 失败且旧 Book 未修改 |
| FLOW-006/input-order | nextUrls=[u1,u2]，u2 先返回，u1 后返回，各产出 C1/C2 | 收集顺序 C1/C2，响应顺序 u2/u1；最终再执行目录反转规则 |
| FLOW-007/empty-title | 目录元素标题规则返回空串，VIP/购买规则脚本记录是否被执行 | 丢弃该节点且不执行 `isVip`/`isPay`；其他节点仍正常解析 |
| FLOW-008/duplicate | `P=[(u,旧),(v,V),(u,新)]`，无前缀、reverseToc=false | 反转→按 URL 去重→反转，结果 `[(v,V),(u,新)]` |
| FLOW-008/format-state | 两章，formatJs 增加 gInt 后返回 String(gInt) | 标题为 1、2，gInt 不逐章归零 |
| FLOW-009/next-chapter | 当前 /c1，下一章 /c2，nextContentUrl=/c2 | 不请求 /c2，不把下一章拼入正文 |
| FLOW-009/cache-gate | `needSave=false`、缓存 token.version=0、version>0 各运行一次 | Android-compatible 路径前两种不读缓存并执行规则，version>0 命中才直接返回；检测/预览不被旧正文短路 |
| FLOW-010/input-order | 正文分页 [u1,u2]，u2 先返回 B、u1 后返回 A | 拼接顺序 A 后 B，不能按到达顺序 |
| FLOW-010/sub-content | 在线文本副文为 `https://x/sub`；音频副文为 URL；普通离线文本副文为原文 | 在线文本不发额外请求且追加 URL 原文；音频请求后保存歌词；提取异常传播，处理异常只记录诊断 |
| FLOW-010/cache-record | 缓存记录缺少 `finalUrl` 或章节附加数据 | 按未命中重新获取；命中记录同时恢复 content、finalUrl、章节更新和歌词/弹幕 |
| FLOW-010/request-hints | 首页配置 `webJs` 与 `sourceRegex`，串行/并发分页各有下一页 | 首页同时传递两项；Android 后续页只传 `webJs`，JS 源按函数自身行为处理，不能假设所有分页都做资源嗅探 |
| FLOW-012/partial-save | 批量 3 章，第 1 章回存成功后脚本抛错 | 第 1 章保留 committed，2/3 为剩余，兜底不重复保存 1 |
| FLOW-013/event-taxonomy | 多源 A 成功、B 解析失败、A sink 保存完成 | 依次只能使用 `source-success`/`source-error`/`saved` 等统一事件；`partial` 是结果状态，不作为事件类型；completed 只发布一次 |
| JS-001/serialization | 返回带 toJSON 的对象；另例循环对象 | 调用 toJSON 的结果被使用；循环对象序列化失败 |
| JS-002/sync-network | 脚本 `java.ajax(u).length`，u 延迟返回 abc | 得到 3 而非 Promise 属性；取消等待后不恢复脚本 |
| JS-003/late-save | 批量上下文关闭后回调 cacheContent | 拒绝写入，原缓存不变 |
| EDIT-002/preview-clean | rawText=baseText，预览成功或失败 | dirty 仍 false；诊断/预览状态可改变 |
| EDIT-004/conflict | 编辑基于 v1，外部先保存 v2，再提交 v1 | conflict，保留草稿及 v2，不静默覆盖 |
| CHECK-001/config | `domain=false, content=false`，搜索成功但无结果，详情规则缺失 | 关闭阶段无请求；搜索为空与规则缺失分别记录；阶段为 `SKIPPED`/diagnostic |
| CHECK-001/gates | 域名失败；info=false；已有 tocUrl；category=false；文件源；仅一条可读章和卷占位章 | 域名失败短路该源；info=false 不进详情/目录/正文；已有 tocUrl 跳过详情；category=false/文件源不进目录正文；跳过卷占位并用下一可读章保护正文，只有一章时用自身 URL |
| CHECK-002/partial | A 搜索成功，B 超时，用户在 content 阶段发送 abort | A 结果保留，B 为 timeout，任务为 `CANCELLED`；不产生虚假 `PASSED` |
| CHECK-003/stale | 检测固定 v1，执行中保存源 v2 后检测完成 | 回写被拒绝或标为 stale；v2 的 NEEDS_CHECK/STALE 不被 v1 覆盖 |
| CHECK-004/file-source | 文件型源无目录网络入口，登录源无凭据 | category/content 为 `SKIPPED` 或 `UNSUPPORTED`；不把能力缺失报为规则失败 |
| API-003/batch-skip | 数组含有效 A、缺 URL B、规则类型错误 C | 兼容 adapter 保存 A，明确返回 B/C 的 skipped 诊断；不声称整批均成功 |
| API-004/js-limit | `text/plain` 恰好上限、超过上限、错误 Content-Length、Transfer-Encoding、读取超过 30 秒 | 上限内继续解析；传输约束、大小或超时失败时拒绝；不写入半截脚本 |
| API-005/precondition | 未保存 sourceId 调用搜索/调试；旧 check token 调用 stop | 返回 SOURCE_NOT_FOUND 或 session unauthorized；不产生缓存和任务副作用 |
| API-006/management-snapshot | 同一事务中源 A 的 revision 与状态同时读取；`urls=[A,A,B]`，B 属于其他用户 | 返回去重后的授权源及匹配状态；不泄露 B；源和状态不能来自不同提交 |
| API-007/ws-first-frame | search 首帧 `{key:"x"}`；debug 首帧 `{tag:"A",key:"x"}`；新协议首帧 `hello`；空帧、第二帧和超过 10 秒 | 旧帧只在 adapter 转换为内部 hello 后进入核心；sessionId 由服务端生成；非法/迟到/重复帧关闭并释放任务 |
| API-008/insert-policy | `customOrder` 越界/重复、配置拦截域名、旧 API 直接保存同一候选 | web-safe 拒绝或修正且无拒绝写入；android-compatible 保留直接 DAO 结果；两种结果带模式记录 |
| REPO-001/isolation | u1/u2 保存相同 sourceId=A，分别读、改、删 | 只能看到自己的 A；一方删除不影响另一方及其检查状态 |
| REPO-002/cas | 两次编辑都基于 v1；先提交 v2，后提交 v1 | 后者返回 revision conflict；规则变更重置检查，纯分组变更不重置 |
| REPO-003/atomic | 三个候选保存到第 2 个时事务失败 | A/B/C 均不成为部分新版本；旧源、旧 baseline 和旧状态保持一致 |
| REPO-004/delete | 删除 A，存在变量、cookie 引用、check state、缓存和书架书 | A 的派生状态清理；默认保留书架/进度；秘密不可再读 |
| REPO-005/source-help-policy | A 命中域名拦截，B 的 `customOrder` 越界，C 与旧 API 相同 | web-safe 的 A 不写入、B 按策略修正；android-compatible 仅执行 Controller 最小校验和直接 DAO 语义；策略差异可追踪 |
| REPO-006/unknown-write | 保存响应前数据库连接中断，随后用同一 idempotencyKey 查询 | 结果为 unknown 时不重复写入；查询能区分已提交、未提交和清理待处理 |
| SEC-001/rls | u1 请求带 u2 sourceId，或伪造 body.userId=u2 | DB/app 至少一层拒绝；不返回存在性差异；旧任务也不能越权写入 |
| SEC-002/redaction | 错误 URL/header/body 含 cookie、token、password | 响应、日志、fixture、导出均不含秘密明文，仅保留脱敏摘要 |
| STATE-001/read-version | 缓存命中且已有在途写入 token=t1 | 读取不改变 t1 代次 |
| STATE-002/stale-write | 同资源先 reserve t1，再 reserve t2；t2 先写成功 | t1 写入拒绝，内容仍为 t2 |
| STATE-003/session | s1 写 Cookie X=1，s2 请求相同源 | s2 不含 X；s1 下次调用仍能读 X |
| STATE-004/cleanup | 一次请求结束关闭视图，再发同会话请求 | 会话 Cookie/源变量保留，局部变量消失 |
| STATE-005/source-edit | v1 请求在途，源保存 v2，再返回 v1 | v1 不能覆盖 v2 缓存或领域结果 |
| STATE-006/toc-revision | r1 第 0 章=A，r2 第 0 章=B，r1 正文迟到 | 不能保存为 B 正文 |
| STATE-007/callback | 第一个进度订阅器抛错，第二个正常 | 第二个仍收到事件，核心结果不变 |
| MEDIA-002/decode-fail | bytes=[1,2]，图片解密脚本抛错 | 无损坏输出缓存，返回解码错误 |
| ACTION-001/no-confirm | payAction 存在，confirmed=false | 不执行脚本、不请求购买、不清正文 |
| ACTION-003/late-event | 页面操作已失效后返回 open-url | 应用不执行旧页面导航 |
| EXT-001/tick | 新命名空间连续 tick 两次 | 返回 0、1；另一源第一次为 0 |
| EXT-002/lock-name | name="" 或 257 个字符 | 参数错误，不执行 action |
| EXT-003/archive-path | 归档项名为 ../outside | policy-denied，不写命名空间外文件 |
| EXT-004/encoding | bytes [0x41] UTF-8 解码；abc Base64 编码/解码 | A；YWJj/abc，二进制与字符串返回型保持区别 |
| MODEL-001/user-state | 远程更新规则并携带 enabled=false、customOrder=9 | 源配置更新，用户状态保持本地值，并记录远程管理字段被忽略 |
| MODEL-002/export-precedence | rawText 未改动、显式 null、未知字段对象和规则字符串 | 原文优先逐字导出；编辑后未知字段、null 和规则形态仍可重建 |
| MODEL-003/rename-conflict | 当前 sourceId=A 改名为 B，B 已存在 | 返回目标冲突，不删除 A、不覆盖 B；明确改名所需事务 |
| MODEL-004/artifact-type | 订阅同时返回 BookSource、RssSource、ReplaceRule 和未知 type | 三类分别解析；未知类型保留原文并返回 UNSUPPORTED_ARTIFACT_TYPE |
| MODEL-005/name-baseline | 本地名称分别等于 baseline、已被编辑、无 baseline，远端均改名 | 前者可随远端更新，中者保留本地并报告差异，后者保留当前名称；显式覆盖才采用远端 |
| REQUEST-001/plan-hints | URL options 同时包含 bodyJs、dnsIp、proxy、webView、serverID | RequestPlan 保留执行提示；宿主不把代理/DNS/WebView 静默丢失或改写成普通 Header |
| REQUEST-002/body-bytes | 非 UTF-8 body、bytes 响应、Content-Type 和 request/response charset 不一致 | 参数与响应分别按契约处理；原始 bytes 保留，不能先固定 UTF-8 |
| JOB-001/idempotency | 相同 userId/idempotencyKey 重复 enqueue | 只创建一个任务，重复请求返回同一任务身份 |
| JOB-002/lease-race | 两个 worker 同时 claim；租约过期后再次 claim | 只有一个 worker 获得当前租约；过期任务可恢复且旧 worker 不能 complete |
| JOB-003/unknown | 外部请求已发出，worker 在响应前崩溃 | 任务进入 unknown 或人工确认路径，不自动重复不可证明幂等的写入 |
| JOB-004/old-revision | 任务固定 sourceRevision=v1，执行期间源变为 v2 | 任务不写入 v1 结果，状态为 stale/unknown，v2 检测状态保持有效 |
| CHECK-005/stage-persistence | 检测各阶段分别产生通过、跳过、失败和能力缺失 | SourceCheckState 的阶段结果可恢复；整体状态不把 SKIPPED/UNSUPPORTED 当 PASSED |
| CHECK-006/aliases-and-defaults | 配置使用 Android `info/category`，省略 keyword，另测显式 keyword | 阶段结果统一为 `book-info/toc`；省略值固定使用“我的”；显式关键字覆盖默认值 |
| CHECK-006/keyword-filter | `checkKeyWord` 分别为合法词、空串、含 `http`/`::`/`++`/`--` | 合法非空值优先；其他全部回退“我的” |
| JS-004/summary-declarative | 声明式摘要索引不可解析、count=0、重复段索引 | 索引回退下标+1；只保留正 count；重复索引后值覆盖前值 |
| JS-004/detail-cursor | 声明式详情第 1 页、后续页无 cursor、跨章节 cursor、JS 源后续页 | 第 1 页不接受 cursor；后续页校验上下文和页码；JS 源不使用 cursor；无效游标返回可诊断错误 |
| JS-004/replies | 声明式回复 body 为空、列表为空、列表非空但解析为空；JS 回复缺函数、返回空值或缺 items | 空 body/解析为空保留错误；合法空列表为空结果；JS 缺函数为空页并带能力诊断，缺 items 为格式错误；hasMore 按各自分支规则计算 |
| JS-004/function-state | JS 只声明摘要、只声明详情、回复单独存在、函数声明但不是函数；运行时详情函数缺失或返回 null | 导入阶段按函数配对规则失败；详情缺失是 capability/脚本错误；详情空返回是合法空页；回复缺失是可诊断空页 |
| JS-004/media-base | 声明式请求发生重定向，JS 返回相对头像/图片/音频，旧式页面返回 HEIF 图片 | 声明式按响应最终 URL，JS 按 `chapter.url`，旧式页面按书籍 URL 交给图片代理；三条路径不能共用错误基准 |
| REVIEW-001/legacy-bridge | `src` 含 `getDP(1,2)` 或 `getZP(3)`，分别测试空 HTML、过期/错误 nonce、书源变更、>64 KiB 脚本和 HEIF 图片 | open 返回 id/nonce；页面只在 nonce 有效时返回并带 no-store/CSP/sandbox；run 重新校验源上下文、拒绝超长脚本并重写图片 |
| URL-007/rate-window | `concurrentRate=2/1000`，同源三次请求，跨源一次，等待期间取消；另测首次非法配置 | 同源前两次立即通过，第三次等待窗口；异源不共享；跨窗口重置计数；取消不再启动请求；已有记录更新保留旧值，首次非法值按 Android fallback 并有诊断 |
| URL-007/rate-bypass | `ajaxAll(urls,true)`、`ajaxTestAll(urls,timeout,true)`、普通 ajax/connect、源编辑覆盖和删除 | bypass 只跳过书源限流，不跳过宿主并发上限；普通请求仍限流；更新/删除后 source key 记录被清理 |
| RESOURCE-001/binary | 图片解密返回 bytes，文件返回 file-links，正文返回 text | ContentStore 与 ResourceStore 分工正确；MIME、bytes、文件链接和正文类型不混淆 |
| RESOURCE-002/size | 二进制恰好上限、超过上限、解密后超过上限 | 超限资源不写缓存；流和脚本句柄释放，返回 resource/budget 错误 |
| RESOURCE-003/kind-collision | 同一章节同时产生 text、image、audio 和 file 资源 | ContentIdentity.resourceKind 使四类资源使用不同 resourceKey；不能互相覆盖 |
| SECURITY-003/cross-user-state | u1 的 Cookie、变量、任务和资源 key 被 u2 请求复用 | u2 不可读取或写入 u1 状态；不存在性不能通过错误差异泄露 |

SUB-001 至 019 在 [订阅文档](../workflows/source-subscriptions.md#验收)，DEP-001 至 007 在 [部署文档](../operations/runtime-security-and-deployment.md#实际部署验收) 定义，不复制另一份期望。

## 覆盖完成的判定

上表解决高风险路径，不能代表所有重载已完善。CAP-ENCODE 加密工厂、CAP-FONT、动态登录等已登记未完整定义的项，必须保留 spec=blocked，不能以存在 EXT 分组标为完成。每个字段至少映射 `IMP-005/字段路径` 的往返案例；每个可执行规则字段再映射对应流程案例。父组通过比例不能代替子案例状态。

有限资源测试采用最小值、恰好上限、超过上限三例；字符串位置另含代理对。并发事件只断言契约要求的先后关系（例如保存先于成功），不强制不同源回调总顺序；分页收集顺序则是固定契约。时间与随机数由测试宿主注入，真实站点波动不进入 golden。
