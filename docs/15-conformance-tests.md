# 一致性测试基线

## 当前已有证据

仓库中与书源运行时直接相关的测试包括：

- `app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeByJSoupDomTest.kt`：自闭合链接、`textNodes`、链式选择、节点身份、正向/负向/排除索引和 DOM 非破坏性；
- `app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeRuleElementsNormalizationTest.kt`：JS 数组结果过滤 null；
- `app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeUrlNetworkOptionsTest.kt`：Cookie 域、timeout、布尔选项、DNS 字面量、代理冲突、重定向和客户端超时；
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
- `modules/web/tests/sourceEditor.test.js`：现有 Web 编辑器的响应式布局、脚本模板、状态恢复、保存和访问令牌行为。

当前没有与这些 Kotlin 规则结果直接对照的 TypeScript runtime 测试；需要新增独立 fixture 和 golden 输出。

当前仓库中的 `examples/rule-fixtures.json`、`examples/source-minimal.json` 和 `examples/source-js-minimal.js` 是脱敏的文档样例，不等同于 Android golden。它们可以作为 fixture 模板，但在补齐 Android 实际输出和 TypeScript 断言前，不能用于宣称兼容。

## Fixture 格式

建议每个 fixture 记录：

```json
{
  "id": "rule-default-text-nodes-001",
  "status": "ts-pending",
  "source": "https://fixture.invalid/source",
  "input": { "kind": "html", "body": "..." },
  "context": { "baseUrl": "https://fixture.invalid/book/" },
  "operation": { "kind": "string", "rule": "div@textNodes" },
  "expected": { "value": "..." },
  "androidEvidence": {
    "kind": "test",
    "path": "app/src/test/java/io/legado/app/model/analyzeRule/AnalyzeByJSoupDomTest.kt",
    "case": "textNodes-and-index-normalization"
  },
  "tsAssertion": {
    "path": "packages/source-core/tests/rules/default-text-nodes.test.ts",
    "test": "rule-default-text-nodes-001"
  },
  "http": [],
  "lifecycle": {
    "expectedEvents": [],
    "expectedWrites": [],
    "mustRelease": ["rule-scope"]
  }
}
```

字段约定：`id` 是稳定且不可复用的用例标识；`status` 使用 `android-verified`、`android-source-only`、`ts-pending` 或 `verified`；`source` 是脱敏后的书源身份；`input` 是解析器或流程输入；`context` 是显式注入的运行上下文；`operation` 描述调用类型和原始规则；`expected` 是稳定输出；`androidEvidence` 指向事实来源；`tsAssertion` 指向一个实际存在的 TypeScript 测试文件；`http` 是脱敏且可重复的请求记录；`lifecycle` 固定事件、写入和清理断言。真实 fixture 不得写入 Cookie、Token、密码或账号。

网络 fixture 的每条记录至少包含 `method`、展开后的 `url`、请求头白名单、请求体、响应状态、最终 URL、脱敏响应头、响应体和模拟延迟。`retry` 用例还要记录每次尝试及最终错误；分页用例要记录请求启动顺序、响应完成顺序和最终收集顺序。golden 只保存稳定输出、稳定错误码、阶段、能力状态、事件顺序、写入结果和清理结果，不比较平台特有的堆栈文本。

错误 fixture 必须明确 `continue`、`partialResult` 和 `writes`。例如字段读取失败可以继续并留下空字段，必需函数缺失必须终止 JS 源导入，单个书源搜索失败可以继续其他书源，目录分页失败不能提交不完整目录，正文保存 token 过期不能覆盖新正文。每个流程都至少有成功、空值、失败、取消、超时和资源清理样本。

## 用例目录和覆盖矩阵

以下 ID 是实现前必须建立的最小目录。每个 ID 对应一个独立 fixture 和一个自动断言；同一 fixture 可以被 Node 和 Next adapter 复用，但不能用单元测试替代流程组合测试。

| 用例 ID | 范围 | 场景与必须断言 |
| --- | --- | --- |
| `IMP-001` | 导入 | 单对象、数组对象和非空 `bookSourceUrl`，输出候选顺序和诊断 |
| `IMP-002` | 导入 | JSON、绝对 URL、URI、JS 文本分类，记录 fetch/parse 阶段 |
| `IMP-003` | 导入 | `sourceUrls` 外层远程列表，重复 URL 去重、输入顺序、取消和失败项隔离 |
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
| `SCH-001` | 规则 | 默认 CSS、旧式 `class/tag/id/text`、`@CSS` 元素选择和字符串终端输出 |
| `SCH-002` | 规则 | `@` 链、`text`、`textNodes`、`ownText`、`html`、`all`、属性输出 |
| `SCH-003` | 规则 | 正负索引、范围、负步长、排除、越界和 DOM 不被破坏 |
| `SCH-004` | 规则 | `@XPath`、XML 声明、表格片段补容器、节点/字符串/空结果归一化 |
| `SCH-005` | 规则 | `@Json`、自动 JSON、对象/数组/标量、嵌套插值和非法 JSONPath |
| `SCH-006` | 规则 | `&&`、`||`、`%%` 在括号、引号、JSONPath、CSS 属性和代码中的平衡切分 |
| `SCH-007` | 规则 | 全规则 Regex、`$1` 捕获组、`##match##replace`、首个替换和非法正则回退 |
| `SCH-008` | 规则 | `<js>`、`@js:`、`@webjs:` 连续混合块的源文本顺序和 capability error |
| `VAR-001` | 变量 | local、chapter、book、rule-data、source 的读取优先级和空字符串继续查找 |
| `VAR-002` | 变量 | `@put`、`@get`、`{{}}` 写入、读取、删除、序列化和请求隔离 |
| `URL-001` | URL | URL JS、`{{}}`、页码占位、URL options 的展开顺序和整数格式化 |
| `URL-002` | URL | GET/HEAD query、POST 表单/JSON/XML、charset、escape 和空字段保留 |
| `URL-003` | URL | headers、Cookie 合并、最终域名、登录头、跨域 `@js` 改写和 CDN 隔离 |
| `URL-004` | URL | timeout、call timeout、retry 次数、取消、重定向关闭/开启和循环保护 |
| `URL-005` | URL | DNS 字面量、非法地址、proxy 冲突、bodyJs、XML 补声明和 bytes 响应 |
| `FLOW-001` | 搜索 | 单源列表/详情页回退、书名丢弃、同源去重、精准搜索和分类组 |
| `FLOW-002` | 搜索 | 多源并发、30 秒超时、progress/callback 顺序、持久化先于成功事件 |
| `FLOW-003` | 搜索 | pause/resume、新请求取消旧 page owner、迟到结果和所有源失败 |
| `FLOW-004` | 详情 | infoHtml 命中、请求/重定向/loginCheckJs、init、新旧字段覆盖和 canReName |
| `FLOW-005` | 详情 | 字段级异常继续、目录缓存、文件下载 URL 为空、Book 提交和失败回滚 |
| `FLOW-006` | 目录 | tocHtml 命中、preUpdateJs、单页串行、多页并发、重复 URL 和循环停止 |
| `FLOW-007` | 目录 | 卷节点、空 URL 占位、VIP/购买、字数、`-`/`+` 与 `readConfig.reverseToc` |
| `FLOW-008` | 目录 | 去重、重新编号、formatJs 失败、旧章节元数据合并、统计更新和事务边界 |
| `FLOW-009` | 正文 | 缓存命中/失效、下一章保护、单页/多页、空正文和资源类型 |
| `FLOW-010` | 正文 | subContent、replaceRegex、标题图片、歌词/弹幕、响应 URL 和清理 |
| `FLOW-011` | 正文 | save token、旧请求覆盖保护、保存失败、取消、章节元数据和保存事件 |
| `FLOW-012` | 批量 | contentBatch/getContentBatch、章节对象识别、重复 URL 歧义、锁、漏存兜底 |
| `JS-001` | JS | 每次调用 scope、绑定对象、共享 scope 显式开关、toJSON/getter/循环引用 |
| `JS-002` | JS | `ajax`、`ajaxAll`、`connect` 的请求描述、错误兼容文本和取消传播 |
| `JS-003` | JS | `cacheContent` 仅批量可用、版本 token、回调乱序、保存计数和关闭上下文 |
| `JS-004` | 段评 | 摘要索引、详情分页、回复展平、内容协议和函数配对错误 |
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

测试命令和门槛必须随 runtime 一起提交：纯规则、流程组合、Node adapter、Next adapter 和编辑器分别可独立执行，全部 `verified` fixture 还要有一次全量命令。任何用例缺少 Android 证据、golden、TypeScript 断言或资源清理断言时，状态只能是 `ts-pending`，兼容矩阵不能标记已验证。

覆盖审计按以下关系执行：`02-source-schema.md` 的每个可执行字段至少映射一个 schema/import 用例；`04-rule-language.md` 和 `05-url-request-rules.md` 的每个模式、组合符号、选项和错误至少映射一个规则/URL 用例；发现、搜索、详情、目录、正文、JS、宿主和编辑器的每个状态、分支、输出和能力至少映射一个对应流程用例。`19-capability-inventory.md` 的每一行都要指向规格与测试 ID；没有测试设施的能力也要记录输入、预期结果和未验证原因。审计结果记录为表格，不以“已有某个测试文件”代替覆盖证明。

## 必须覆盖的规则样本

### 解析器

- 默认选择、`@CSS:`、`@XPath:`、`@Json:` 和自动 JSON 识别；
- `&&` 拼接、`||` 首个成功、`%%` 按索引交错；
- 选择器和 JSONPath 中含 `&&`/`||` 的平衡切分；
- `@` 链、`text`、`textNodes`、`ownText`、`html`、`all` 和属性；
- 正索引、负索引、范围、负步长、排除和越界；
- `:regex`、`$1`、`##match##replace`、首个替换；
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

测试资源必须在每个用例结束时释放。网络真实站点只用于人工诊断，不作为稳定 golden 来源。任何兼容性结论都要同时注明 Android 证据和 TypeScript 断言，不能只依赖文档示例或人工截图。
