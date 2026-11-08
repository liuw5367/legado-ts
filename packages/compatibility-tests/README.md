# JVM / TypeScript 兼容测试

这个私有工作区包让 Kotlin/Java 参考端和当前 TypeScript 实现执行同一份 JSON 输入，逐字段报告结果差异。基础 API、解析器、执行器和案例都保存在本包；原 Android 仓库只提供固定提交的只读源码，不存放测试代码。

参考端使用普通 JDK 21、Maven 和 Kotlin/JVM，不使用 Android SDK、android.jar、Android Gradle Plugin、Robolectric 或设备。Maven 使用包内公开 Central 配置、包内依赖缓存和进程内 Kotlin 编译，避免读取个人镜像凭证或启动 Kotlin 后台服务。

## 执行

在已安装本仓库 Node 依赖的根目录执行：

```sh
pnpm --filter @legado/compatibility-tests prepare:jvm
pnpm --filter @legado/compatibility-tests test
pnpm --filter @legado/compatibility-tests test --family regex
pnpm --filter @legado/compatibility-tests test --case string.split.empty
```

`test` 先验证测试机制与 JVM 协议，再执行所选双端案例。首次 JVM 编译需要下载 Maven 依赖；后续在源码、编译设置和依赖摘要匹配时复用构建产物。准备源码默认读取本仓库父目录，也可给 `prepare:jvm` 或 `test` 传入 `--upstream /path/to/legado`。只要求该本地 Git 仓库含锁定提交，不要求工作树处于对应版本；未提交改动不进入参考端。

使用 `JAVA_HOME` 指定独立 JDK 21；本机默认候选为 `/Applications/Android Studio.app/Contents/jbr/Contents/Home`，只使用其中的 Java 可执行文件。其他机器需要设置 `JAVA_HOME`。Maven 的 `mvn` 需要在 PATH 中。

可以分别执行 `test:mechanism`、`test:reference`、`test:ts`、`test:jvm`。单端命令只生成该端结果，不报告跨端通过。本机当前 pnpm 的依赖状态检查会尝试重建现有 node_modules，尚未执行该清理；可使用 `pnpm --config.verifyDepsBeforeRun=false --filter @legado/compatibility-tests test`。也可以直接执行等价入口，使用现有依赖：

```sh
node --test packages/compatibility-tests/tests/*.test.mjs
node packages/compatibility-tests/scripts/run.mjs --family css
```

CLI 参数错误、空选择、来源失败或 API 执行不完整退出 2。API 行为差异退出 1，全部一致或符合逐例允许差异时退出 0。 `request-transport` 功能族使用 JVM 和 Node 各自的本机环回 HTTP 夹具，运行环境需允许监听并连接临时环回端口。报告单列参考端内部观察。方法覆盖表另行显示场景缺口。

## 输入和参考端

`cases/*.json` 中每条案例包含稳定 id、family、operation、input、reference 和 tags。输入形态由 `schema/operations.json` 声明，加载时校验；JSON Schema 供编辑器或其他执行器使用。规则、文本和字节都使用明确类型；字节结果为 `{ "type": "bytes", "base64": "AA==" }`，Long 为 `{ "type": "integer", "decimal": "9223372036854775807" }`，防止经过 JS number 丢失精度。UTF-16 代理代码单元保留为 JSON Unicode 转义。

`reference-sources.json` 固定上游提交、文件摘要、依赖版本和适配说明。准备脚本用 `git show` 读取白名单文件，校验后原样生成到 `jvm/target/reference/`。原源码的许可证声明保留，原项目许可证见来源仓库的 LICENSE；生成源码、依赖和编译产物不进入版本控制。

参考证据分为四类：

- `jdk-direct`：执行 JDK String、Pattern、Base64、URL、MessageDigest 等 API，只证明该 API，不扩大为 Android 包装器兼容。
- `upstream-original`：直接编译原源码，目前为 RuleAnalyzer。
- `upstream-guided-flow`：固定上游解析器与 Kotlin 离线流程编排，单列流程覆盖；原样执行与按源码编排的边界见下文。
- `upstream-adapted`：原算法保持原样，额外提供无运行行为的 Keep 注解或 stderr 调试日志适配；当前包括 Regex、CSS、JSONPath、XPath。XPath 额外使用仅含 Iterable join 的 TextUtils 测试适配，其空集合、null、Unicode 和顺序语义由独立 JVM 测试校验；适配不包含 Android 运行库。

书源脚本用例使用固定上游提交中的 Rhino 二进制，执行前验证摘要。JVM 参考按上游顺序组合解析、替换和脚本求值，节点与书籍变量来自离线夹具。纯章节数字方法从校验过摘要的上游文件提取并编译。

TS 侧使用真实 scanner、规则编译器/evaluator、SourceRuleHost、QuickJS Java bridge 与 JsonPathParserAdapter。JSON 字符串/列表通过真实 Java bridge 转换；CSS 字段列表按对应接口合并或保留条目顺序；正则链直接调用实际 java.getElement/getElements，覆盖首个与全部匹配及失败终态。不能在参考执行器中重新实现待比较算法。独立 `innerRule` 在 TS 无对应入口，当前显式报告 unsupported；JSONPath 内嵌规则另有双端案例。

`date-bridge` 族通过固定 Rhino 调用锁定 `JsExtensions.kt` 的 `timeFormat/timeFormatUTC`，TS 则执行实际 QuickJS `java.timeFormat/timeFormatUTC` bridge 和 Node formatter。每条案例固定 JVM 默认 Locale/TimeZone，并在 TS 配置相同值；它比较 pattern 输出及 JS `catch` 后续行为，不把 JDK 结果外推为所有 Android 设备 Locale、时区或 WebView Java bridge 的 golden。

本包初期只覆盖纯函数和轻依赖解析器。AnalyzeRule、AnalyzeUrl、WebBook 等应用入口没有被整体编译。JVM 与 TS 的可观察入口不同，输出差异需要结合适配边界判断，不能将报告中的全部条目直接视为已确认缺陷。

## 输出和比较

每次运行在 `output/run-*` 下生成独立目录：

- `cases.json`：实际所选输入。
- `metadata.json`：输入摘要、双方源码身份、Node 版本、命令和时间。
- `jvm.json` / `ts.json`：实际结果与各端元数据；JVM 记录 JDK、原源码、适配、依赖及编译产物摘要。
- `*.stderr.log`：参考库或执行器的原始日志。
- `report.json` / `report.md`：总体统计、每例状态、JSON 路径和双方值。基础机制先报告结果和异常，原库吞掉的异常可能只出现在 stderr。

结果先区分 `completed`、`unsupported`、`runner-failed`，正常执行再区分 `return` 和 `throw`。每例超时 5 秒；超时、异常退出或协议损坏后关闭进程，下一例重新启动。普通函数异常保留为被测结果并继续后续案例。函数族适配器为每例创建新宿主；持久缓存、全局状态和并发 API 尚不在此隔离承诺内。构建命令应串行执行，不同时修改或准备同一包的 JVM 构建目录。

默认只忽略对象键顺序；保留数组顺序、query、null、缺失、空串、空数组及错误原始类别和文本。双方类别名不同的异常仍报告差异；需要比较错误语义时，在具体案例声明 `errorEquivalence.category/jvm/ts`，原始输出仍保留。

允许差异通过 `allowedDifferences` 指定 JSON 路径、jvm 值、ts 值及原因，三者必须精确匹配才生效；没有全局忽略项。`expected` 为可选的额外独立断言，使用 `{ "outcome": "return", "value": ... }` 形态。两端执行器不读取它。当前 MD5 固定向量及真实书源规则案例有额外断言。失败案例仍保留实际输出。

每次双端运行都重新生成结果，比较前核对输入与实现摘要，不复用任意旧输出。构建缓存还会校验实际 class 文件与依赖 JAR 摘要。`output/` 和 `jvm/target/` 可在停止测试后清理，运行命令会重新生成。

## 书源语料和后续流程

`corpus/manifest.json` 保存用户提供的 Yiove 集合来源、采集日期、原始/处理后摘要及字段处理记录。`yiove-11-sources.json` 保存 11 个书源定义。`corpus.source-*` 案例使用规则原文和合成 HTML，`origin` 指回书源及具体字段。节点案例比较标签、文本和 ID，并校验顺序及独立预期值。

运行 `node packages/compatibility-tests/scripts/corpus-rules.mjs` 可生成规则清单。命令校验快照摘要，按完整原文的 SHA-256 合并重复规则，并保留每个字段的位置、用途和已关联的案例 ID。用例的规则原文必须与来源字段逐字一致。

`corpus/coverage.json` 将基础语法组合与原文用例关联，并记录配置字段及 WebView 依赖。执行器生成 `corpus-coverage.json` 以区分本次通过、差异和未运行。

### 离线书源流程

在仓库根目录执行：

```sh
node packages/compatibility-tests/scripts/run.mjs --family flow
node packages/compatibility-tests/scripts/run.mjs --case flow.yiove.html.success
```

`flow.book` 让两端用同一书源、关键字和 UTF-8 响应字节执行。TS 调用真实搜索、详情、目录和正文入口，网络由夹具提供。JVM 直接执行固定的 Jsoup/JSONPath 解析器、Rhino 和从上游提取的格式化、字数、布尔规则代码；其余阶段顺序、回退和分页终止由 `BookFlow.kt` 按锁定的上游文件编排。证据记录在 `reference-sources.json` 的 `files`、`flowEvidence` 与产物 JVM 元数据中。Android 应用本体、线上站点、动态登录、WebView、跨阶段脚本持久化及并发分页属于独立证据范围。

| 案例组 | 来源与比较范围 |
| --- | --- |
| `flow.synthetic.main-js.*` | 复用旧整源目录脚本并增加搜索、发现、详情及正文。JVM 使用固定 Rhino、原 JsSourceMarshaller 和离线实体，比较交付、字段、请求与终态 |
| `flow.yiove.wensang.discovery-empty-page` | 「文桑小说」原始发现分类和字段规则。比较两个有序结果、空页终态和实际请求顺序 |
| `flow.synthetic.content-fallback.*` | 合成正文响应。分别验证主规则命中、合法为空后回退、两边均空的终态 |
| `flow.yiove.html.*` | 「言情小说阁」原始规则与合成 HTML。验证搜索顺序、相对链接、独立目录地址、正文替换、合法空搜索和空正文失败 |
| `flow.synthetic.json.*` | 从 `JSON-FLOW-001` 复制规则和素材。验证过滤、VIP 标记、两个正文页的拼接，以及无下一页、下一章、重复地址三类停止条件 |
| `flow.yiove.js.*` | 「奇怪小说」原始目录脚本与合成 HTML。验证详情响应复用、排除“最新章节”组、保留节点顺序、读取脚本选中的章节和空目录失败 |
| `flow.yiove.post.*` 与 `flow.yiove.html-paging.*` | 「顶点小说」「得奇小说网」原始规则。验证静态 UTF-8 POST、请求体字节、Header 及 HTML 串行正文分页的三种停止条件 |
| `flow.synthetic.detail.*` 与 `flow.synthetic.toc.*` | 合成夹具。验证重定向后的详情识别和响应复用、目录分页、原始 URL 去重、倒序、卷节点与正文选择 |
| `flow.yiove.toc-variable.*` 与 `flow.synthetic.book-variable.*` | 「穿越小说🎃」原始目录规则。验证初始变量、详情写入后目录读取、选章和同一 worker 中的案例隔离 |

`flow.toc` 只运行目录阶段，显式输入书籍身份与初始变量。`flow.discover` 根据固定书源的分类标题选择原地址，通过真实 TS 发现入口分页。报告分列完整流程和阶段用例。请求案例通过 `requestEvidence` 比较离线传输边界的请求体 Base64 和响应最终地址。变量用例通过 `variableKeys` 比较指定键的实际阶段快照，保留未设置与空字符串的区别。

响应按方法、完整 URL 和请求体匹配。请求超限或缺夹具会报告执行失败。逐阶段比较身份、已声明的书籍字段、章节顺序及标记、正文标题、页数、最终正文和请求轨迹。原始中间 HTML 的序列化字节及 TS 专有的元数据投影不属于流程断言，例如当前固定上游未读取的 `updateTime`。逐例的错误等价只映射指定阶段的精确类别和文案，仍比较终态和后续请求，并保留原始结果。

旧测试继续保留。新机制稳定后，按旧断言到新案例的覆盖映射分批删除重复测试；独有安全、取消、资源释放和历史缺陷回归必须保留或迁移，删除前执行受影响验证。

## 行为兼容判定与覆盖台账

`triage.json` 为原始差异的处理记录，`coverage.json` 按方法和重载列出案例与必要维度。每次运行生成 `output/run-*/coverage.json`，其中 `dimensionEvidence` 引用本次双端一致的案例，`missingDimensions` 列出缺口。选中案例不完整时状态为 `not-run`，已执行但场景不足时为 `incomplete`。

报告分别显示 rawComparison 与 behaviorComparison。错误语义映射可带 jvmMessageIncludes / tsMessageIncludes，要求相应异常类别与消息标记同时匹配；方法不存在与非法输入不能等价。异常等价案例单独统计，原始差异和原始异常不丢失。Android 合法返回而 TS 中止始终是行为差异。

`contractScope=reference-observation` 仅用于没有等价产品入口的内部观察，必须填写 observationReason 与 relatedCases。观察项保持原始状态，不计 API 通过；可执行的关联规则案例继续严格验收。观察项的执行器故障仍会导致整体失败，不支持仅从产品契约分母分离，不隐藏。

JSON 字符串/列表直接调用实际 Java bridge；json.read 使用 Jayway ALWAYS_RETURN_LIST 与真实 TS JsonPath adapter 观察原值。Java Base64 对照使用 Packages.java.util.Base64，NodeEncodingHost 的严格输入策略由原 TS 测试单独验证。新增 operation 后运行 `node packages/compatibility-tests/scripts/sync-case-schema.mjs` 同步编辑器 schema；一致性测试验证它与 operations.json 无漂移。

TS 执行前会使用仓库本地 TypeScript 编译 core，保证 SourceRuleHost 包导出加载的是当前源码的 dist；metadata.coreBuildHash 记录实际构建产物摘要。core 构建失败时退出 2，不使用旧 dist 继续比较。
