# 书源运行时状态总览

本文是书源解析、宿主能力和 Android/TypeScript 一致性验证的唯一状态入口。详细行为仍分别记录在能力清单、差异登记和测试基线中；这些文档不再维护第二份状态表。

## 2026-10-22 P13 最终审核

本轮剩余可修复和可模拟的书源规则/请求能力已完成代码与 TypeScript 回归，Android 逐 fixture 对照单独标为受阻：

- TypeScript conformance runner：六条 workflow fixture 均逐条产生实际结果并通过 expected 比较（`6/6 pass`）。
- 发现/搜索流程、静态 corpus 和现有全套回归均已纳入最终命令；静态语料为 943 个候选源、20,231 条规则、20,226 条编译成功，5 条已知源文本错误，意外失败与过期白名单均为 0。
- Android preflight 检查到外层项目有 Gradle wrapper，但没有逐 fixture adapter、`local.properties` 或 golden 输出；`run-source-conformance-android.mjs` 返回 `not-run`/退出码 2，比较器的 `--require-android` 同样阻断。普通 Android JVM 单测仍只记为独立 `test-run` 证据。
- 因此本轮状态不能统一写成“双端完成”：可修复项是 `TS 已通过`，有 Android 同输入输出的项目才可改为 `双端已通过`；真实 WebView、浏览器、验证码、Activity、物理设备身份、跨进程存储和远程写入继续按 `需真实宿主` 或 `验证受阻` 记录。

## 2026-10-22 P31：JavaImporter 常见网络与 Hutool facade

本轮继续处理会让真实书源脚本在请求前直接失败的类导入缺口。QuickJS 现在按受控范围提供 `Packages.okhttp3` 的 `MediaType`、`RequestBody`、`Request.Builder`、`OkHttpClient/Call/Response`，以及 `cn.hutool` 常见的 `Base64`、`StrUtil`、`HexUtil`、`ZipUtil.gzip` 和 `DigestUtil`。OkHttp facade 不绕过现有请求预算、动态 Header、Cookie、重定向和取消链，而是把 Builder 物化为已有 `java.get/java.post/java.head/java.ajax` bridge；响应 body、bytes、headers、status 和 request 也沿用受控 DTO。

`packages/source-node/tests/source-rule-host.test.ts` 的 `JS-011` 书源式回归验证了 POST body/重复 Header、响应对象、Base64、摘要、字符串/十六进制工具和 gzip 编码；当前 TypeScript 证据为通过，Android 同输入 golden 仍为 `not-run`。方法 manifest 已从 252 个成员扩展到 258 个，新增 6 个成员均标记为 `simulated / ts-passed / simulatable / verify`。这一步只承诺常见 facade 的明确成员，不把它扩大为通用 JVM、完整 OkHttp 或完整 Hutool。

## 2026-10-23 P32：File 子对象包装和即时元数据

`java.getFile()` 与 `File.listFiles()` 现在统一复用受控 File 包装。父对象和 `listFiles()` 返回的子对象都提供 `getName/getPath/getAbsolutePath/exists/isFile/isDirectory/length/lastModified/canRead/canWrite/listFiles`，每次调用元数据方法都会向文件宿主刷新；子项不再退化成只含字段的 DTO，可以继续执行 Android 书源常见的方法链。`source-rule-host.test.ts` 的 FILE-004 回归覆盖父子对象、相对路径投影和动态元数据，定向 source 回归为 183/183，根全套回归为 626/626。清单仍有 258 个成员，状态统计为 62 个 `implemented`、152 个 `partial`、44 个 `simulated`；写入/删除竞态、真实绝对路径和 Android golden 继续保留边界。

## 2026-10-23 P33：AnalyzeUrl 登录检查重取上下文

Node 请求宿主现在把一次 AnalyzeUrl 请求的 URL、Header、方法、body、URL options 和响应请求元数据通过进程内全局 symbol 传给 `loginCheckJs`。登录检查调用 `java.getStrResponse/getResponse` 时会保留原请求的 POST/HEAD 方法、body、动态登录 Header 和 `bodyJs`，嵌套响应的 `raw().request()` 也能读取实际 URL、方法和请求 Header；跨 src/dist 模块实例的 symbol 身份保持一致。新增书源式回归覆盖登录后 POST 重取、响应二次处理和请求元数据，`source-host-flow` 37/37 通过。方法清单将 D22 的 `getStrResponse/getResponse/bodyJs/loginCheckJs` 更新为 `implemented/ts-passed`，当前统计为 66 个 `implemented`、148 个 `partial`、44 个 `simulated`。

`initUrl` 的完整 Android 重解析（原始 mUrl、模板、URL options 和页面生命周期）、WebView 默认路径、完整 OkHttp/Java 对象身份以及 Android 同输入 golden 仍保留差异边界。

## 2026-10-23 P34：AnalyzeRule 链式继承方法

按 Android `AnalyzeRule.kt` 的返回契约修正了 `setLocal`、`setBaseUrl` 和 `setRedirectUrl`：`setLocal`/`setBaseUrl` 返回当前 `AnalyzeRule`，可以继续调用方法；`setRedirectUrl` 返回受控 URL 对象，非法 URL 保留原地址，`data:*;base64,` 地址不覆盖当前重定向；`setContent(content, baseUrl)` 只更新 `baseUrl`，不再错误覆盖 `redirectUrl`。`source-rule-host.test.ts` 新增链式调用、基址、非法 URL 和 data URL 回归，定向规则宿主 106/106、source 全套 185/185、根全套 628/628 通过。

方法清单中这三个成员更新为 `implemented / ts-passed / fixable / verify`，当前 258 个成员统计为 **69 implemented、145 partial、44 simulated**。`setContent` 仍保持 `partial`，因为 Android 的 `isJSON` 标记、解析器缓存清理和完整对象生命周期尚未由同输入 golden 验证；Android conformance runner 仍为 `not-run`。

## 2026-10-23 P35：URL options 请求参数语义

按 Android `AnalyzeUrl.UrlOption` 和 `AnalyzeUrlNetworkOptions.kt` 修正了请求参数边界：`webView` 现在只把 `null`、空字符串、`false` 和精确的字符串 `"false"` 视为关闭，`0`、`"0"`、大小写不同或带空白的字符串不会静默降级到普通 HTTP；超时字符串只接受整数毫秒并限制在 `Int.MAX_VALUE`，POST 的 `body:null` 按空表单处理，headers 中的数组、对象和 null 按 Gson/Java `toString()` 形态转换。新增 2 组 source-request 回归覆盖 WebView 能力诊断、超时/body 和复杂 Header 值；URL options `type` 空白值仍待 Android Gson 反序列化路径验证。

方法清单将 `network-options` 的 `body/headers/timeout` 更新为 `implemented / ts-passed / fixable / verify`，当前 258 个成员统计为 **72 implemented、142 partial、44 simulated**，待处理 186 个。`webView` 的真实页面请求仍属于宿主能力，Node 继续返回 `capability-missing`；Android conformance runner 仍为 `not-run`。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| `未实现` | 当前没有可用的 TypeScript runtime、宿主适配器或应用入口 |
| `部分实现` | 已覆盖部分路径，但仍缺少生命周期、重载、宿主能力或关键行为 |
| `差异待处理` | 已确认与 Android 或目标契约不同，尚未修复或完成取舍 |
| `已实现待验证` | TypeScript 已实现并有测试，但缺少 Android 同输入 golden |
| `有意保留` | 差异来自安全或产品边界，暂不按 Android 行为消除 |
| `待整理` | 实现或文档已经变化，需要同步事实来源 |
| `已完成` | 完成条件、日期、提交和测试证据均已记录 |

## 实现、验证和可行性分别记录

本轮逐方法族的机器清单位于 [`fixtures/compatibility/method-manifest.json`](../../fixtures/compatibility/method-manifest.json)，当前 version 2 清单包含 `memberCount` 和逐成员状态；其结构由同目录 `schema.json` 和 `packages/source-core/tests/compatibility-manifest.test.ts` 校验。清单只登记书源 runtime、请求处理和真实宿主边界；reader-web/reader-cli 页面交互不属于 Android 书源兼容证据。

`discoverBooks`/`searchBooks` 现在可在 `RuntimeResult.observations` 返回脱敏的请求与跳过轨迹，阶段包括 `planned`、`requested`、`response-received`、`parsed-empty`、`success`、`failed`、`capability-missing`、`cancelled` 和 `skipped`。声明式主请求、`mainJs` 的 `java.ajax`/`java.get` 等 bridge 子请求、URL/header/body 脚本的嵌套请求都沿同一调用链传递观测器；每个真实网络请求单独记录，避免把 JS 书源误报为“没有请求”。它只回答请求是否发出、响应是否收到和规则结果处于哪一阶段，不改变页面展示，也不把 Android golden 缺失标为通过；回归入口为 `packages/source-core/tests/runtime-observations.test.ts` 和 `packages/source-node/tests/source-session.test.ts`。

上表及“当前状态”列是历史汇总标签，不能用一个标签同时推断实现程度、是否验证和能否修复。尤其是“未实现”不等于“无法实现”，“已实现”不等于“与 Android 等价”，“未验证”也不等于“无法确定接口契约”。后续逐签名记录必须分开填写下列维度；复核中尚未证明的内容不能自动归为可修复。

| 维度 | 状态 | 判定规则 |
| --- | --- | --- |
| 实现 | 已实现、已模拟、部分实现、部分模拟、未实现 | 只回答指定 core/Node/Web 层的代码是否提供该能力；模拟必须有实际行为，按重载和返回对象细分 |
| 验证 | 未验证、TS 已通过、TS 已复现差异、双端已通过、验证受阻 | 写明实际执行范围；源码对比不算双端执行，环境受阻记录原因 |
| 可行性 | 可修复、可模拟、条件可修复或模拟、需真实宿主、无法确定、确实无法提供 | 依次评估直接实现、宿主复用、语义转换和受控模拟；只有均不适用且有具体约束时才列确实无法提供，不以当前缺少实现作为不可行证据 |
| 决策 | 本轮修复、待核实、建议保留待批准、另立宿主方案、已批准保留 | 建议不等于批准；保留差异仍计入兼容边界 |

### 本轮差异的可行性分组

此表只补充可行性和交付类型；具体实现程度、已执行验证和证据仍由下面逐项状态及差异登记维护。同一编号包含不同子能力时分开判定，不能以一个可修复成员代表整组都可完成。

处理原则已按用户要求调整为“能实现或者模拟都要尽量实现”。已模拟、部分模拟、未模拟和需真实宿主必须注明具体成员；缺少 Android 对照的模拟仍为未验证，不能被统计成双端已通过，也不能因未验证就默认排除实现目标。

| 范围 | 可行性 | 可以承诺的交付及限制 |
| --- | --- | --- |
| D18 已列出的 Jsoup 选择器；D22～D26 已列出的请求/规则对象、源方法和缓存接口 | 可修复 | 在现有分层中修复明确签名；完整库公开面仍按逐成员案例验收，不能直接扩大为任意 Jsoup/Java 对象兼容 |
| D28～D32：跨请求状态、文件隔离、下载、InfoMap、旧 AES 返回类型；D40～D43：选择版本、诊断、URL/File 对象 | 可修复 | 按固定 Android 契约修复；D29/D40 同时包含 Web 自身隔离和状态正确性要求，不是模拟 Android 单用户存储 |
| D19 HTML 全部修复/序列化行为；D20 Jayway 全部方言；D21 Java 全部正则语法 | 条件可修复或模拟 | 逐语法优先实现、转换或模拟；确实不能等价的子集给出反例和诊断。所有畸形 HTML/方言完全一致尚未验证，不能因此只输出支持表就停止可实现工作 |
| D27 Cookie 方法；D33 加密工厂；D35 字体对象；D36 日期格式 | 可修复与条件可修复并存 | 纯接口/对象和明确格式可修；Cookie 域合并取舍、全部算法/参数、字体轮廓及 locale 等价要按具体子项验证，不能用常见案例覆盖整组 |
| D36 繁简词库完全等价 | 无法确定；继续实现可证实差异 | 核对固定版本词库和同输入差分，能修复的字符/词组转换尽量修复；证据不足时不承诺零差异 |
| D34 StrResponse 构造与受控方法 | 可修复 | 修复明确的 JS 兼容对象；不因此提供通用 JVM |
| D34 常用 Java 类、Packages/JavaImporter、接口回调和字符串方法 | 可模拟或条件可模拟 | 按类族和公开成员提供受控兼容对象，复用现有宿主；通用 JVM 缺失不影响纯类模拟。以 Android 可访问契约为范围，不按书源命中率筛选 |
| D34 任意 JVM/Android 系统服务；D37 真实物理设备身份 | 需真实宿主；接口和值可部分模拟 | 可模拟的纯接口和稳定替代值仍要实现；真实 Activity/系统服务/物理标识无法仅由返回 DTO 产生，模拟结果必须明示非物理等价 |
| D37 账号稳定替代标识、阅读/主题设置；OPEN-03 和非网页 OPEN-04 | 可修复 | 应用可提供账号值、真实应用设置、表单/步骤及人工动作；仍不保证真实站点接受替代设备值 |
| OPEN-01、OPEN-04 中的真实 WebView/浏览器/验证码；代理、多实例文件/锁 | 条件可修复或模拟；部分需真实宿主 | 纯 UA/URL/已有 HTML 解析、交互协议和当前传输库能提供的代理能力优先实现；页面执行、站点验证、跨实例共享等继续列出真实宿主条件，不能用常量成功代替 |
| D39 声明式 jsLib 共享状态；D34 Java String 对象语义 | 可模拟与条件可模拟并存 | 可恢复数据状态、Java 来源字符串包装纳入实现；任意闭包/类实例保留评估受限会话 VM 及引用生命周期。不再默认保留整组差异，跨进程任意对象恢复须单独验证 |
| exploreScreen、serverID 的实际执行要求；教程旧接口；段评字段对应的完整写入流程 | 无法确定目标行为或尚无执行证据 | 当前未找到足够可达调用证据；不创造功能，也不标成“不可实现”。后续凭实际入口、版本或 Android 案例再决定 |

“无法确定”的负责人是后续兼容性实施者，判定材料为固定版本 Android 调用链、依赖支持表或同输入输出；材料不足时保持待核实。构建环境不可用属于“验证受阻”，不能据此判定功能无法实现。D18～D43 不是 26 项均可无条件消除的差异承诺。

## 未完成项和差异项

| 编号 | 类型 | 事项 | 当前状态 | 详细事实和证据 | 完成条件 |
| --- | --- | --- | --- | --- | --- |
| OPEN-01 | 宿主能力 | `@webjs`、WebView、资源嗅探和浏览器交互 | 部分实现（core 已保留全部方法和可注入 platform；默认 Node 仍能力缺失） | [兼容矩阵](evidence-matrix.md)；[宿主接口](../../packages/source-core/docs/host-ports.md)；`source-runtime-platform.test.ts` | 真实浏览器/WebView/验证码执行器、Cookie 传递、暂停恢复和 Android fixture 齐备 |
| OPEN-02 | 书源能力 | 结构化段评读取、旧式段评网页桥接和段评写入 | 部分实现（声明式/JS 摘要、详情、回复和 Web API 已实现；旧式网页桥接与写入仍未实现） | [段评流程](../upstream/android/flows/review-flow.md)；`CAP-REVIEW`；`review.test.ts` | 网页桥接会话安全和写入协议分别完成或明确返回能力缺失，并补 Android golden |
| OPEN-03 | 书源能力 | 付费动作、购买后刷新、书源事件和自定义按钮 | 部分实现（core 已提供 payAction/callBackJs；reader-web 已提供人工触发 API、源版本校验、结构化结果和进程内 operationId 幂等保护） | [媒体和交互流程](../upstream/android/flows/adjacent-source-flows.md)；`review.test.ts`；`apps/reader-web/tests/source-actions.test.ts` | 购买后刷新、取消/失败 UI、多实例幂等和自定义按钮消费仍需应用接入；真实购买不在自动测试内 |
| OPEN-04 | 宿主能力 | 验证码、复杂登录 UI 和多步骤登录 | 部分实现（静态 RowUi、动态 loginUi v2、state 重绘、表单 key、输入 action 防抖、按钮倒计时、人工 action 和动作事件已提供；浏览器/验证码能力仍缺） | [Android URL 与请求规则](../upstream/android/rules/url-request-rules.md)；WebView 入口；`apps/reader-web/tests/source-login.test.ts` | 登录交互、凭据保存、清理和失败恢复的 Web 表单路径已覆盖；真实网页登录、验证码和 Android golden 仍需宿主验收 |
| OPEN-05 | 应用入口 | 多源 `ReaderApplication.search`、书源全流程 `checkSources` | 应用已实现待验证；core 不提供该门面 | [reader-cli 实现](../../apps/reader-cli/docs/implementation.md)；[校验流程](../upstream/android/flows/source-check-flow.md)；`apps/reader-cli/tests/source-check.test.ts` | 继续补齐 Android 同输入 golden，并在跨端验证后记录完成证据 |
| OPEN-06 | 应用状态 | `SourceApplicationService`、`SourceRepository`、`SecretStore`、`JobStore` | 未实现 | [架构边界](../architecture/goals-and-boundaries.md)；[归档设计](../archive/source-management-and-state.md) | 用户归属、版本冲突、凭据隔离、任务恢复和删除副作用有应用层契约 |
| OPEN-07 | 请求差异 | Android 独立登录凭据头与同站注入 | 部分实现（请求注入和 reader-web 登录 UI/action 已接入；凭据响应脱敏） | [差异登记](known-divergences.md)，D5；`source-request.test.ts`、`source-session.test.ts`、`apps/reader-web/tests/source-login.test.ts` | Android 同输入 golden；SecretStore 级删除清理、多实例恢复仍需应用契约 |
| OPEN-08 | 生命周期差异 | `concurrentRate` 非法配置和源生命周期清理 | core/Node 已实现待验证；应用删除边界分层记录 | [差异登记](known-divergences.md)，D7；`source-rate-limiter.test.ts`、`source-session.test.ts`、`application.test.ts` | Android 同输入 golden；各应用分别补齐源编辑、覆盖、删除和重建 session 的集成证据 |
| OPEN-09 | JavaScript bridge | 平台方法和逐重载兼容 | 部分实现（core/Node 已注册全量 Android 方法名并补齐纯计算、网络、状态、文件、字体、归档、繁简、设备/配置和跨执行并发入口；真实交互平台仍缺） | [差异登记](known-divergences.md)，D14；[宿主方法盘点](capabilities.md#宿主方法补充盘点)；`source-runtime-platform.test.ts`、`source-rule-host.test.ts`、`source-file-host.test.ts` | 真实书源方法逐重载通过 Android/TS golden；WebView、浏览器、验证码、媒体仍需平台验收或保持明确差异 |
| OPEN-10 | 跨端验证 | 已实现解析和工作流的 Android 同输入 golden | 部分实现（新增 `scripts/compare-source-conformance.mjs`；TS fixture 会实际执行，Android 输出缺失明确报告 `not-run`） | [一致性测试基线](conformance-tests.md)；`node scripts/compare-source-conformance.mjs`；TypeScript 已执行六条离线 case | 同一脱敏 fixture 在 Android 和 TypeScript 两侧通过稳定输出比较；当前 Android runner/输出仍为 `not-run`，不得将比较命令的缺失输出记为通过 |
| D1 | 接口差异 | 搜索与流程入口命名 | 有意保留 | [差异登记](known-divergences.md)，D1 | 入口统一，或文档完成迁移并通过包入口测试 |
| D2 | 接口差异 | 端口与宿主门面命名 | 有意保留 | [差异登记](known-divergences.md)，D2 | 宿主门面和结果契约统一，或所有现行入口完成文档迁移 |
| ~~D3~~ | 文档差异 | ~~能力清单中过时的“未实现”表述~~ | 已完成（2026-09-28，历史记录；本行不作为本轮验证证据） | [差异登记](known-divergences.md)，D3；兼容矩阵已区分真实未实现能力与已有实现待 golden 项 | 能力清单、矩阵和实现状态不再使用过时表述 |
| D4 | 能力差异 | 尚未实现的公开能力 | 按 core、宿主和应用分别登记 | [差异登记](known-divergences.md)，D4 | 每项缺失能力都有独立状态、宿主边界和可识别错误 |
| D5 | 请求差异 | Android 独立登录凭据头 | 部分实现、待 Android 验证 | [差异登记](known-divergences.md)，D5；`source-request.test.ts`、`source-session.test.ts`、`apps/reader-web/tests/source-login.test.ts` | Android 同输入 golden；SecretStore 级删除清理、多实例恢复仍不属于当前包 |
| D6 | 请求差异 | 默认 User-Agent | 已实现待验证 | [差异登记](known-divergences.md)，D6；`source-session.test.ts`、`network.test.ts`、`source-request.test.ts` | Android 同输入 golden；Node 默认值与显式覆盖、source/URL Header 优先级已有测试 |
| D7 | 生命周期差异 | `concurrentRate` 生命周期 | core/Node 已实现待验证 | [差异登记](known-divergences.md)，D7；`source-rate-limiter.test.ts`、`source-session.test.ts`、`application.test.ts` | Android 同输入 golden；按应用边界补编辑、覆盖、删除和重建源测试 |
| D8 | 安全差异 | HTTP、协议、本地地址和代理限制 | 部分实现、待 Android 验证 | [差异登记](known-divergences.md)，D8；`packages/source-node/tests/network.test.ts` | HTTP/HTTPS/SOCKS/SOCKS5 代理、URL/显式认证、代理失败不直连、`dnsIp` 冲突和 SSRF 边界有 Node 回归；待 Android 同输入 golden，安全限制继续保留 |
| D9 | 请求差异 | bridge 子请求的动态 Header 重入 | 已修正（Node 有界模拟） | [差异登记](known-divergences.md)，D9 | 首层网络、AnalyzeUrl、批量、响应及文件/字体/归档 bridge 重算动态头，深层跳过并共享 deadline/取消和最大深度；Android golden 与非 Node 宿主仍待验证 |
| D10 | 生命周期差异 | `preUpdateJs` 执行时限 | 有意保留差异（P07） | [差异登记](known-divergences.md)，D10；`source-request.test.ts`、`source-request-host.test.ts` | 请求链共享 30 秒默认绝对 deadline，显式值最多 30 分钟；JS action 仍保留 TS 30 秒安全上限，Android 30 分钟仅作为未验证差异 |
| D11 | 生命周期差异 | `subContent` 取消语义 | 差异待处理 | [差异登记](known-divergences.md)，D11 | 主正文、诊断和最终状态完成 Android 对照与取舍记录 |
| D12 | 二进制差异 | 封面解密 InputStream 互操作 | 部分实现 | [差异登记](known-divergences.md)，D12 | 所需重载和 bytes 边界都有跨端 fixture |
| D13 | 二进制差异 | 图片脚本执行预算 | 部分实现 | [差异登记](known-divergences.md)，D13 | 预算、取消、资源释放和大输入行为都有跨端 fixture |
| D14 | JavaScript bridge | JavaScript bridge 逐重载覆盖 | 部分实现 | [差异登记](known-divergences.md)，D14；SourceLoginJsExtensions 纯动作入口、book/chapter 媒体更新和变量已有 Node 回归；JS 源 marshaller 已补搜索/发现 `type` 校验回退、详情前重置类型、文件源类型合并和 `downloadUrls` 归一化 | 真实书源方法逐重载通过；剪贴板、搜索/书架、图片/导航 UI 仅记录结构化动作，平台 UI、浏览器和 Android golden 仍待验证 |
| D15 | 应用边界差异 | 目录统计标题的应用替换规则 | 有意保留 | [差异登记](known-divergences.md)，D15；`toc-reconcile.ts` | source-core 保持纯函数；应用提供标题替换规则快照或投影回调后再做跨端 fixture |
| D16 | JS 源行为差异 | JS 源 URL 的公开身份与脚本可见形式 | 已实现待 Android golden | [差异登记](known-divergences.md)，D16；`javascript-projection.ts`、`discovery.ts`、`reading.ts`、`source-host-flow.test.ts` | 已有 Node 回归覆盖 raw bookUrl/tocUrl/baseUrl 与详情身份字段白名单；待同输入 Android runner/golden |
| D17 | JS 源行为差异 | JS 详情 `updateTime` 扩展字段 | 有意保留 | [差异登记](known-divergences.md)，D17；`workflows.test.ts` | Android 当前 marshaller 不接收该字段；TypeScript 保留已有字段并按允许差异处理 |
| D18 | 规则解析 | Jsoup 扩展选择器 | 部分实现（P04/P16） | [重新核对](known-divergences.md#android-与教程重新核对2026-10-21)，D18；`html.ts` 将 XML 模式传给 css-select，保留 Jsoup `eq/lt/gt` 的同级原始索引语义（包括负数）、`containsOwn/matchesOwn`，文本 `:matches/:matchesOwn` 与属性 `~=` 均复用受控 Java Pattern 转换，并补 `:has/:not/:is`；无效选择器统一返回 `unsupported-selector`；`packages/source-node/tests/adapters.test.ts` 有 HTML/XML 双适配器回归 | 常用位置/文本伪类、Java 文本/属性正则和 XML 大小写已补；完整 Jsoup 版本、畸形 HTML、复杂 CSS 转义和 Android golden 仍待验证 |
| D19 | 规则解析 | HTML text/ownText/html/属性输出 | 部分实现（P04/P16） | D19；`html.ts` 按 Jsoup 归一化普通文本的 NBSP/换行/CRLF，对直接 `br` 的 `ownText` 补空格，对 `pre/textarea` 保留空白，并按 Jsoup DataNode 规则排除 script/style 正文；`xpath.ts` 对表格片段补容器、规范化文本节点、开启 XML CSS 大小写、从 XML `xmlns` 声明解析 XPath 前缀，并支持常用位置/文本/属性正则伪类和标准函数；Node adapter 回归通过 | `text/ownText/textNodes/html/all`、常见表格片段、XML CSS 伪类和常用命名空间 XPath 已覆盖；HTML 修复算法、属性去重、完整 XPath 命名空间轴/函数和 Android golden 仍待验证 |
| D20 | 规则解析 | Jayway JSONPath 方言 | 部分实现（已补函数、集合语义、根/当前项路径和函数参数，待 Android golden） | D20；`jsonpath.ts` 支持正则筛选、`in/nin/size/empty/anyof/noneof/subsetof` 的 safe evaluator 转换，集合运算的右值可使用受控字面量、`$`/`@root` 根路径和当前项路径，按 Jayway 处理数值/字符串等价、显式 null 与缺失字段，并适配 `length/size/keys/min/max/avg/sum/stddev/first/last/index/concat/append`；函数参数可按 Android 解析 `$`/`@`/`@root` 路径并参与 `concat` 和数值聚合；本轮补齐 `empty true/false` 的缺失路径边界、标量结果、空聚合失败、标量 `concat` 参数转换和非数组 `append` 返回；复杂集合、`length/size` 参数和解析异常返回稳定 `unsupported-jsonpath`；Node adapter 回归通过 | 完整 Android fixture、JsonPath provider 版本差异、复杂对象/嵌套集合参数和动态表达式仍需双端 golden；不支持语法不再静默为空 |
| D21 | 规则解析 | Java 正则、String/Matcher 重载与替换语义 | 部分实现（P15/P23/P24/P25/P26/P27/P29，已补命名组、替换、常见字符类运算、Unicode `\b/\B`、U 常用预定义类、局部 i/m/s/x/d/U/u flags、简单占有量词和单原子原子组） | D21；`pattern-guard.ts` 负责 Java Pattern 转换和安全诊断，全局/局部 i/m/s/x/d/U/u flags 会按作用域展开并保留启用/禁用语义；`d`（UNIX_LINES）只把 LF 当作点号和行锚点的行终止符，局部禁用会恢复外层语义；Java `\b/\B` 使用 Unicode word 集合，`U` 下常用 `\w/\W/\d/\D/\s/\S` 映射到 ECMAScript Unicode 属性；COMMENTS 模式按 Java 8 规则移除 ASCII 空白和 `#` 行注释，并保留字符类/转义边界；`u`（UNICODE_CASE）在未启用 `i` 时作为无副作用作用域标记，`U+i`/`u+i` 的完整大小写折叠仍返回 `unsupported-pattern`；Java `Pattern.UNICODE_CHARACTER_CLASS(256)` 已从 bridge 映射为 `(?U)`，`UNICODE_CASE(64)` 映射为 `(?u)`；简单字面量、字符类、转义原子的 `*+`/`++`/`?+`/`{m,n}+` 及只含单一简单原子贪婪量词的 `(?>...)` 使用同原子负向前瞻固定贪婪边界，不新增捕获组；复杂分组/交替、懒惰或零宽原子保持 `unsupported-pattern`；常见字符类交集/差集使用 lookahead 保持同一字符位置的集合语义；QuickJS bridge 已补 Java String、StringBuilder、Pattern/Matcher、命名组、`start/end`、`find/reset/region/matches/lookingAt`、`$0/$1/$10/${name}` 替换、`quoteReplacement`、Integer/Long、BigInteger/BigDecimal、增量 MessageDigest/Mac、字节流和 Base64 受控对象；Node core/bridge 规则回归通过 | U/u 与 i 联用的完整 Unicode 大小写折叠、复杂字符类集合、部分字符转义、复杂占有量词/原子组、完整 Java Pattern 边界规则和 Android golden 仍待验证；不安全或无法等价的语法继续返回 `unsupported-pattern`，安全长度/复杂度限制继续保留 |
| D22 | 请求脚本 | AnalyzeUrl 对象修改、响应包装与登录后重取 | 部分实现（P07/P33） | `java.url`/`headerMap`、`getHeaderMap`、受控 `getStrResponse/getResponse` 已接入 URL 脚本上下文；登录检查重取现在通过同一上下文保留 POST/HEAD、body、动态登录 Header、URL options 和 `bodyJs`，嵌套响应的 `raw().request()` 暴露实际请求 URL/方法/Header；响应对象补 `bytes/bodyAsBytes/errorBody/callTime/raw/headers` 等教程常用成员；`Headers` 已覆盖大小写查询、重复值、索引、`names/values/toMultimap/byteCount/toString` 和敏感头脱敏；`getDate/getInstant` 按 OkHttp 兼容的标准 HTTP-date 与 15 个回退格式受控解析，无时区的 asctime 格式固定按 UTC，非法或尾随文本返回 null；Node fixture 验证登录重取、POST body、bodyJs、请求元数据、递归上限、取消、共享 deadline 与响应对象方法/属性 | `initUrl` 的完整原始 URL 重解析、WebView 默认路径和 Android golden 仍待验证；`names`/`toMultimap` 是受控 JS 视图，日期结果使用 JS `Date` 表示 Java `Date/Instant`，不提供 Java 对象身份或完整时区数据库 |
| D23 | JS bridge | AnalyzeRule 继承成员和重载 | 部分实现（第三阶段，重载语义已补齐） | `source-runtime.ts` 已补 setContent/baseUrl/redirectUrl、setLocal/evalJS、刷新助手、`getString(rule, boolean)`、`getString(rule, content, isUrl)`、`getStringList(rule, content, isUrl)`；null 内容回退、null setContent 诊断、HTML unescape、URL 解析/空值回退和列表去重均有 Node 回归 | AnalyzeUrl 专属上下文仍单列于 D22；Android golden、全部规则对象/列表重载仍待双端逐签名验证 |
| D24 | JS 对象 | Map/List/Set/Jsoup 返回对象方法 | 部分实现（P05/P17） | 受控 Map/List/Set 扩展 `putIfAbsent/replace/computeIfAbsent/computeIfPresent/merge/removeAll/retainAll/listIterator/containsAll`、缺失键 null、回调参数顺序和迭代器异常等常用成员；Map `keySet/values/entrySet` 视图、entry `setValue`、Map `putAll`/构造和 List `subList` 父子传播已补；Element/Elements 补父子/兄弟、tag/id/class、`is`、`clone`、`remove`、属性修改和集合链；source 登录 Map、getStringList/getElements 列表已有教程式回归 | 受控端口不暴露原始 DOM；Map/List 视图只覆盖已登记的受控方法，结构性并发修改、全部 `Collection`/`Map` 默认方法、视图 fail-fast 和所有 null/修改组合仍待验证 |
| D25 | JS 源 | sourceApi 与源规则访问器 | 部分实现（P05） | `sourceApi` 与 source 兼容对象绑定，规则访问器和 Header/Login Map 已补；ParserNodeInfo/mutation 端口保持节点引用边界并支持链式规则回写；Node 回归通过 | 旧 source 配置全部字段、过期节点能力错误和 Android golden 仍待验证 |
| D26 | 缓存 | 对象/二进制/数值和 onlyDisk | 部分实现（P08） | CacheManager bridge 保留 JSON 对象、独立 ByteArray 命名空间、数值读取和 `get(key, onlyDisk)`；字符串/bytes 不互相污染，TTL、版本化快照、过期和损坏条目隔离已有 Node 回归；没有磁盘端口时 now 返回 `capability-missing`，不回退内存 | 任意 JVM 对象和跨宿主磁盘语义仍不等价 |
| D27 | Cookie | CookieStore 公开面及域语义 | 部分实现（第三阶段 C） | cookie 已补 getKey/replaceCookie/cookieToMap/mapToCookie/clear；Node CookieStore 解析多键 Cookie header、按有效域共享、按域清理，并保留 tough-cookie 的 path/expiry/same-site 约束 | WebView Cookie 同步、Android golden 和少数特殊公共后缀行为仍待验证 |
| D28 | 应用状态 | Web 跨请求源状态与 cache 恢复 | 部分实现（P08） | 差异登记 D28；Node 快照恢复源键值、登录信息、登录头、字符串缓存和 ByteArray，快照版本/超限/损坏输入不会清空当前状态；新快照绑定 `sourceKey`，跨源恢复被拒绝，关闭中的迟到变量快照不再写回 | 删除/换版、账号隔离、恢复失败和自定义缓存宿主仍需验证 |
| D29 | 文件隔离 | Web 默认共享文件目录 | 部分实现（P18） | 差异登记 D29；Web 通过部署密钥派生账号/源/版本命名空间并注入 `fileRoot`；reader-web 回归验证命名空间对用户、源、版本和部署密钥均稳定隔离，路径不泄漏原始身份 | 跨命名空间实际读写删除拒绝及无持久磁盘部署仍需组合验证 |
| D30 | 文件请求 | 下载认证/URL options/归档字符集/缓存失效 | 部分实现（P18） | Node session 的文件/字体/归档下载复用 SourceRequestHost，继承动态 Header、登录头、Cookie 和重定向；下载文件十六进制重载、归档 bytes 自动探测字符集、`cache.delete(md5Encode16(url))` 同步失效 `cacheFile` 映射；zip/gzip/外部 7z/rar 提取接受取消信号，归档临时目录在部分写入失败、取消和外部解包失败时清理；归档条目路径在拼接前保留 `..` 交给沙箱校验 | 受控 HTTP 仍不等于 WebView；真实 Android 归档/缓存 golden、RAR/7z 工具版本仍待验证 |
| D31 | 发现状态 | InfoMap 方法、保存时机和 TTL | 部分实现（第四阶段） | InfoMap 已补无参 get、putAll（普通对象和受控 Java Map）、containsValue、keys/values/entries/keySet live view、删除传播；Web 按 Android `save(time,need)`/`saveNow` 记录秒级 TTL，控件直接修改显式提交，`layout_wrapBefore` 已映射为 Web 换行 | 真实 Android golden、多实例保存竞争和所有 MutableMap 迭代器细节仍待验证 |
| D32 | 加密重载 | 已废弃 AES/DES/3DES API 的实际返回类型与行为 | 部分实现（P10） | `aesEncodeToString` 对齐 Android 历史 decryptStr；`aesEncodeToBase64ByteArray` 返回 UTF-8 Base64 bytes；AES、3DES、GCM/CCM legacy 重载和单 DES 的重复 key 等价路径已有固定 Node 向量；无 provider 时返回 capability code | DES/3DES 便捷重载与 Android provider 仍待逐项 golden；算法是否可用取决于 Node OpenSSL provider，不伪装成成功 |
| D33 | 加密对象 | 工厂状态、模式/padding/RSA 参数 | 部分实现（P10/P19） | 工厂在脚本执行内保持 key/IV 状态，支持 `setIv/getIv/getSecretKey`、null key、AES-GCM/CCM authentication tag、AAD 和可变 tag 长度、SM4 常用模式、SM3 摘要、RSA PKCS1/OAEP/NoPadding，以及 `SHA256withRSA/PSS`/`SHA256withRSAandMGF1` 的摘要长度盐值签名验签；Java `Cipher` 支持 `GCMParameterSpec/updateAAD`、`OAEPParameterSpec/MGF1ParameterSpec/PSource`，同摘要 MGF1 可透传；不支持的 transformation 或 Node provider 无法表达的独立 MGF1 摘要稳定返回 capability | Android provider/golden、全部 tag 长度边界和 key 编码仍待对照；Node 与 Android provider 差异保留 |
| D34 | JS 引擎 | StrResponse、Java 类、JavaImporter/Packages 和字符串身份 | 部分实现（P06/P17） | `JavaImporter/Packages/JavaAdapter`、MessageDigest/Mac、StringBuilder、Map/List/Set/Arrays/Collections、Java String、Pattern/Matcher、Integer/Long/BigInteger/BigDecimal、Base64、URLEncoder、DatatypeConverter、InputStream/OutputStream/Reader、`Packages.java.lang.System/Thread`、`Packages.java.util.UUID/Locale`、`java.util.zip.GZIPInputStream/InflaterInputStream/ZipInputStream（受限 ZIP 条目读取）`、`javax.crypto.Cipher/SecretKeyFactory`、`java.security.KeyFactory/Signature/KeySpec`、`android.text.TextUtils`、`android.os.Build`、`org.jsoup.Jsoup.parse`、可构造 StrResponse、StrResponse 方法/属性双形态和 OkHttp/Jsoup 常用 `Headers` 视图已补；StringBuilder 构造器容量、字符数组 append/insert、`appendCodePoint`、`setCharAt/replace`、code point 定位/范围、`getChars`、`substring/subSequence`、容量管理，Java String 的 `length/split/replace/getBytes` 常用重载、集合计算、批量修改、ListIterator、Map/List 实时视图、`Arrays.asList/copyOf/fill/sort/binarySearch`、`Collections.swap/max/min/unmodifiableList/unmodifiableMap/unmodifiableSet/copy/frequency/newSetFromMap`、`String.valueOf/copyValueOf` 字符数组重载、`String.lastIndexOf/codePointAt/codePointBefore/codePointCount/offsetByCodePoints/getChars/contentEquals/isBlank/strip/stripLeading/stripTrailing/repeat/join`、常用 `String.format/formatted` 数值/字符串/定位和日期时间格式、Locale 常量和语言标签、`String.lines/chars/codePoints` 的受控流视图、`String.indent/stripIndent/translateEscapes/transform/intern`、Integer/Long/BigInteger radix 解析、System.arraycopy/属性、Thread.sleep 可取消等待、AES/RSA/Signature、GZIP、受限 ZipInputStream 和 Jsoup 受控节点的教程路径回归通过；本轮继续补 `ByteArrayInputStream(byte[],offset,length)` 的范围读/`readNBytes`/`skipNBytes`/`transferTo`、`ByteArrayOutputStream.write(int)`（按低八位写入）/`writeBytes`/`writeTo`、InputStreamReader 的 read/skip/ready 和 BufferedReader 的 CR/CRLF/read/skip/lines | `Headers.names()` 返回可消费的受控列表而非不可变 Set，`toMultimap()` 返回可消费对象而非 Java Map，`getDate/getInstant` 使用受控 OkHttp HTTP-date 格式解析并以 JS Date 表示；这些是受控纯方法模拟，不加载通用 JVM/Rhino；`String.repeat`、`String.format`、`String.replace`、StringBuilder 和 ByteArrayOutputStream 有 16 MiB 运行时输出上限，`String.lines/chars/codePoints` 提供 eager 数组式 `toArray/count/iterator/forEach` 与有限 pipeline，不等价于惰性/并行 Java Stream；`String.transform` 执行 JS 回调，`String.intern` 不提供 JVM 常量池身份，`translateEscapes` 只覆盖常用转义和八进制；`String.format/formatted` 的常用日期、时间、周序号和纪元转换已实现，日期时区名称与完整 Locale 规则仍是近似，未支持的 Formatter 方言返回稳定 `rule-failed`；`System.nanoTime` 使用 Node 时钟近似、输出流只进入日志端口、Thread 锁/线程中断不等价，Cipher/Signature 依赖 Node provider，ZipFile/zip64/加密 ZIP 与完整 Jsoup DOM 仍报告能力边界；完整 Java 集合默认方法、全部数组类型重载、对象身份、任意系统类、真实接口回调和 ClassShutter 语义仍需真实宿主或逐成员模拟 |
| D35 | 字体对象 | 本地文件输入及 QueryTTF 公开对象 | 部分实现（第三阶段，3D 已补格式诊断） | 字体对象补 getGlyfById/unicodeToGlyph/glyphToUnicode/unicodeToGlyphId；文件路径下载复用源请求链；TTF/TrueType sfnt 正常解析，WOFF/WOFF2/CFF/TTC 与非法 glyph 输入分成 capability/invalid 诊断 | CFF/WOFF 实体解析、缺失 glyph 的 Android 返回值和 golden 仍待验证；当前不把格式错误降级成空字体 |
| D36 | 工具函数 | 日期格式和繁简词库 | 部分实现（P11） | Node 日期格式补 D/w/W/F/k/K/z/G，按 locale weekInfo 处理周边界，支持引号转义、非法 token 守卫和可注入 locale/timeZone；固定 UTC/Asia/Shanghai 回归通过；未知格式返回空结果 | SimpleDateFormat 全量 token、Android locale/时区规则和繁简词库版本仍待 Android golden；空结果是受控差异，不等同 Android 异常文本 |
| D37 | 宿主值 | 设备替代值和阅读/主题配置注入 | 部分实现（P11） | 差异登记 D37；getWebViewUA 已有默认字符串；`NodeSourceSessionOptions.platformOptions` 支持装配稳定 deviceSeed、阅读和主题配置 | 账号内稳定标识与真实应用设置映射；明确物理设备不等价 |
| D38 | 导入/请求 | 历史宽松 JSON | 部分实现（第三阶段 A） | D38；`codec/relaxed-json.ts` 严格 JSON 优先，宽松回退用状态扫描只在字符串外处理注释、单引号、未引号键和尾逗号，避免修改字符串内伪语法；导入、规则、URL options、发现分类及原型键安全回归通过 | 仅解析数据语法，不执行表达式；GSON 其他宽松选项和 Android golden 仍待验证 |
| D39 | JS 生命周期 | 声明式 jsLib 共享对象状态 | 部分实现（P12/P20，受限会话状态） | jsLib 状态键绑定 Node session、源定义指纹；跨操作和显式快照仅恢复可序列化 DTO，`refreshJSLib` 只清当前 scope；同一 session/source/jsLib 的并发执行按状态键串行提交，清理代次阻止外层旧快照覆盖嵌套刷新后的新状态；共享缓存不会串 session；函数/闭包/宿主对象不进入快照 | QuickJS 真实共享 VM、取消后的 handle 生命周期和 Android golden 仍未验证；整源 JS 继续每次重执行，函数/闭包状态仍以重新加载和可序列化状态模拟 |
| D40 | 发现请求 | 分页签名未绑定筛选/快照版本 | 部分实现（P18） | 差异登记 D40；游标签名同时绑定发现代次和 `infoMap` 的 128 位不可逆摘要，筛选值变化（包括没有 action 的控件）会使分类快照失效并刷新列表；游标不携带筛选原文，旧游标和摘要篡改在请求执行前拒绝；`discovery.test.ts` 覆盖旧代次、旧摘要和敏感筛选值不出现在游标中 | 迟到请求写回、跨实例 CAS/租约组合和 Android golden 仍需验证 |
| D41 | 诊断/证据 | 方法登记被误当兼容、缺失能力误报普通失败 | 部分实现，待 Android 对照 | 差异登记 D41；当前 TypeScript 证据为 `pnpm test:source` 185/185，根全套 628/628，Android golden 仍待最终门禁；静态语料 943 个候选源、20,231 条规则中 20,226 条编译，5 条已按 manifest 白名单归类为源文本错误，新增未编译规则会使审计失败；本轮新增 Java/Android 运行时类路径均有书源式回归 | 逐签名和返回对象覆盖、能力错误可判别；Android not-run 保留 |
| D42 | URL 对象 | IPv6、searchParams 和基准地址 | 部分实现（第四阶段 A） | toURL 补 get/getAll/has/set/append/delete/toString，保留重复 query 值、IPv6 authority 和已编码参数名；无 query 时保持 `searchParams === null`，并补齐 Java URL 常用 getter；无 base 时按 Android `URL(url)` 解析，显式 base 才做相对地址合并，非法解析统一为 `Malformed URL`，HTTP/HTTPS/FTP 默认端口已补齐；回归覆盖 IPv6 host/port/origin、无 query、getter、非法输入和 FTP 默认端口 | Android golden、非 HTTP 协议完整 handler 属性、URL 编码/异常对象细节仍待验证 |
| D43 | 文件对象 | File 方法和即时状态 | 部分实现（P09/P32） | File 补 getName/getPath/getAbsolutePath/length/lastModified/canRead/canWrite/listFiles；`listFiles()` 子项也包装为可调用 File 对象，exists/isFile/isDirectory 与元数据方法每次刷新宿主状态；`cache.delete` 会清理对应 `cacheFile` 映射；`source-rule-host.test.ts` 父子对象回归通过 | 写入/删除竞态、绝对路径投影和 Android golden 仍待验证 |
| D44 | 应用交互 | 登录 UI/action、书源事件和付费动作的应用入口 | 部分实现（第六阶段） | 差异登记 D44；reader-web 已提供静态/动态登录 API 与页面、动作事件、payAction/callBackJs 人工触发、源版本校验和进程内幂等；密码/token 脱敏；`source-login.test.ts`、`source-actions.test.ts` | 购买后刷新、自定义按钮消费、多实例幂等、真实网页登录/验证码和 Android golden 仍待验证；真实远程动作不自动执行 |
| D45 | JS 源行为差异 | JS 详情、目录和正文入口重置 `BookType` 时的状态位传播 | 已实现待 Android golden | [差异登记](known-divergences.md)，D45；`discovery.ts`、`reading.ts`、`source-host-flow.test.ts`；重置只清除 Android `allBookType` 媒体位，保留 `local/archive/notShelf/updateError` 状态位；声明式目录和 JS 详情/目录/正文回归已覆盖 | 同输入 Android golden；需要继续确认 `BookType` 非媒体状态位在文件源、缓存和本地书籍组合中的边界 |
| D46 | JS 源行为差异 | JS 源 `variable` 在搜索/发现与详情合并中的 Gson 类型语义 | 已实现待 Android golden | [差异登记](known-divergences.md)，D46；`discovery.ts`、`source-host-flow.test.ts`；搜索/发现只接受 Android `String?` 可读的字符串/数字/布尔，数组或对象跳过候选；详情只接受对象或对象 JSON 字符串，并按 `Map<String,String>` 归一化，嵌套对象/数组和非法 JSON 保留旧值 | 同输入 Android golden；继续确认 Gson 版本对极端数值和 null map value 的差异 |
| D47 | JS 源行为差异 | JS 搜索/发现返回值按 Android `SearchBook` Gson 字段类型反序列化 | 已实现待 Android golden | [差异登记](known-divergences.md)，D47；`discovery.ts`、`source-host-flow.test.ts`；已声明字符串字段接受 Gson 可转换的 primitive/null，整数/长整数接受 Gson 可精确转换的数值文本；对象、数组、布尔数值和溢出值按字段记录 `item-skipped` 并跳过整条候选，未知字段仍忽略 | 同输入 Android golden；Gson 版本对超大 Long、特殊数值文本和 Kotlin 非空字段为 null 的边界仍待验证 |

2026-10-22 D34/P21 更新后的机器清单统计：27 个能力族、252 个成员；成员实现状态为 55 个 `implemented`、159 个 `partial`、38 个 `simulated`。本次新增和修正的 String/StringBuilder、Locale、Stream 视图、文本变换、Java IO 流重载和局部 Pattern flags 均有 TS 书源式回归，但 `simulated` 只表示受控 QuickJS 对象，不等同完整 JVM，Android 同输入仍按 `not-run` 记录。

## 完成时如何更新

完成一项时，只在本文更新状态总览：

1. 将“当前状态”改为 `已完成（YYYY-MM-DD，提交，测试命令）`，或改为 `已完成（有意保留，YYYY-MM-DD，决策和测试）`。
2. 给同一行的“编号”和“事项”加删除线，保留该行以及详细证据链接。
3. 在对应详细文档中补充行为、实现和测试证据，不再创建第二份状态表。
4. 如果后续回归，恢复删除线和未完成状态，并在详细文档追加回归原因和新的验证结果。

例如：

```text
| ~~D7~~ | 生命周期差异 | ~~concurrentRate 生命周期~~ | 已完成（2026-10-01，abc123，pnpm run test:source） | ... | ... |
```

机器清单中的 fixture ID 保持稳定，不删除历史记录；它们的 `execution` 字段由[一致性测试基线](conformance-tests.md)维护。
