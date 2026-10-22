# 书源运行时状态总览

本文是书源解析、宿主能力和 Android/TypeScript 一致性验证的唯一状态入口。详细行为仍分别记录在能力清单、差异登记和测试基线中；这些文档不再维护第二份状态表。

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

本轮逐方法族的机器清单位于 [`fixtures/compatibility/method-manifest.json`](../../fixtures/compatibility/method-manifest.json)，其结构由同目录 `schema.json` 和 `packages/source-core/tests/compatibility-manifest.test.ts` 校验。清单只登记书源 runtime、请求处理和真实宿主边界；reader-web/reader-cli 页面交互不属于 Android 书源兼容证据。

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
| D8 | 安全差异 | HTTP、协议和本地地址限制 | 有意保留 | [差异登记](known-divergences.md)，D8 | 安全审查完成并明确兼容边界 |
| D9 | 请求差异 | bridge 子请求的动态 Header 重入 | 差异待处理 | [差异登记](known-divergences.md)，D9 | 重入次数、请求顺序和有界策略有 Android 对照 |
| D10 | 生命周期差异 | `preUpdateJs` 执行时限 | 差异待处理 | [差异登记](known-divergences.md)，D10 | 取消、超时和有界预算完成 Android 对照与取舍记录 |
| D11 | 生命周期差异 | `subContent` 取消语义 | 差异待处理 | [差异登记](known-divergences.md)，D11 | 主正文、诊断和最终状态完成 Android 对照与取舍记录 |
| D12 | 二进制差异 | 封面解密 InputStream 互操作 | 部分实现 | [差异登记](known-divergences.md)，D12 | 所需重载和 bytes 边界都有跨端 fixture |
| D13 | 二进制差异 | 图片脚本执行预算 | 部分实现 | [差异登记](known-divergences.md)，D13 | 预算、取消、资源释放和大输入行为都有跨端 fixture |
| D14 | JavaScript bridge | JavaScript bridge 逐重载覆盖 | 部分实现 | [差异登记](known-divergences.md)，D14；SourceLoginJsExtensions 纯动作入口、book/chapter 媒体更新和变量已有 Node 回归 | 真实书源方法逐重载通过；剪贴板、搜索/书架、图片/导航 UI 仅记录结构化动作，平台 UI、浏览器和 Android golden 仍待验证 |
| D15 | 应用边界差异 | 目录统计标题的应用替换规则 | 有意保留 | [差异登记](known-divergences.md)，D15；`toc-reconcile.ts` | source-core 保持纯函数；应用提供标题替换规则快照或投影回调后再做跨端 fixture |
| D16 | JS 源行为差异 | JS 源 URL 的公开身份与脚本可见形式 | 已实现待 Android golden | [差异登记](known-divergences.md)，D16；`javascript-projection.ts`、`discovery.ts`、`reading.ts`、`source-host-flow.test.ts` | 已有 Node 回归覆盖 raw bookUrl/tocUrl/baseUrl 与详情身份字段白名单；待同输入 Android runner/golden |
| D17 | JS 源行为差异 | JS 详情 `updateTime` 扩展字段 | 有意保留 | [差异登记](known-divergences.md)，D17；`workflows.test.ts` | Android 当前 marshaller 不接收该字段；TypeScript 保留已有字段并按允许差异处理 |
| D18 | 规则解析 | Jsoup 扩展选择器 | 部分实现（第三阶段 A） | [重新核对](known-divergences.md#android-与教程重新核对2026-10-21)，D18；`html.ts` 将 XML 模式传给 css-select，保留 `eq/lt/gt/containsOwn/matchesOwn`，无效选择器统一返回 `unsupported-selector`；`packages/source-node/tests/adapters.test.ts` 有回归 | 常用位置/文本伪类和 XML 大小写已补；完整 Jsoup 版本、畸形 HTML 和 Android golden 仍待验证 |
| D19 | 规则解析 | HTML text/ownText/html/属性输出 | 部分实现（第三阶段 A） | D19；`html.ts` 保留 Jsoup 风格空白、块节点分隔、script/style 排除和 HTML/XML 序列化；Node adapter 回归通过 | `text/ownText/textNodes/html/all` 常用语义已覆盖；HTML 修复算法、属性去重和 Android golden 仍待验证 |
| D20 | 规则解析 | Jayway JSONPath 方言 | 部分实现（第三阶段 A） | D20；`jsonpath.ts` 支持聚合函数、正则筛选及 `in/nin/size/empty/anyof/noneof` 的安全转换；`subsetof` 和解析异常返回稳定 `unsupported-jsonpath`；Node adapter 回归通过 | 完整 Jayway 函数、null/缺失、确定/不确定路径和嵌套集合仍需 Android golden；不支持语法不再静默为空 |
| D21 | 规则解析 | Java 正则、String/Matcher 重载与替换语义 | 部分实现（第三阶段 A + 3B） | D21；`pattern-guard.ts` 负责 Java Pattern 转换和安全诊断；QuickJS bridge 已补 Java String 的 split/limit、replaceAll/replaceFirst、matches/compareTo/regionMatches，StringBuilder、Pattern/Matcher、Integer/Number 与 Base64 受控对象；66 条 Node 书源式回归通过 | 作用域 flags、字符类交集、部分字符转义、Matcher 替换字符串细节和 Android golden 仍待验证；安全长度/复杂度限制继续保留 |
| D22 | 请求脚本 | AnalyzeUrl 对象修改、响应包装与登录后重取 | 部分实现（第四阶段） | `java.url`/`headerMap`、`getHeaderMap`、`initUrl`、受控 `getStrResponse/getResponse` 已接入 URL 脚本上下文；响应对象补 `bytes/bodyAsBytes/errorBody/callTime/raw/headers` 等教程常用成员；Node fixture 验证重取顺序和头部 | WebView 默认路径仍能力缺失；完整 loginCheckJs 人工登录重取、递归/取消/Android golden 仍待验证 |
| D23 | JS bridge | AnalyzeRule 继承成员和重载 | 部分实现（第三阶段，重载语义已补齐） | `source-runtime.ts` 已补 setContent/baseUrl/redirectUrl、setLocal/evalJS、刷新助手、`getString(rule, boolean)`、`getString(rule, content, isUrl)`、`getStringList(rule, content, isUrl)`；null 内容回退、null setContent 诊断、HTML unescape、URL 解析/空值回退和列表去重均有 Node 回归 | AnalyzeUrl 专属上下文仍单列于 D22；Android golden、全部规则对象/列表重载仍待双端逐签名验证 |
| D24 | JS 对象 | Map/List/Jsoup 返回对象方法 | 部分实现（第三阶段 + 3B） | 受控 Map/List 扩展 `add/addAll/remove/removeAt/subList/containsAll` 等常用成员；source 登录 Map、getStringList/getElements 列表、Java String/StringBuilder/Pattern 包装已有教程式回归 | Jsoup 全部链式成员及完整公开对象清单仍待验证；Map/List 只承诺已列出的受控成员 |
| D25 | JS 源 | sourceApi 与源规则访问器 | 部分实现（第三阶段） | `sourceApi` 与 source 兼容对象绑定，规则访问器和 Header/Login Map 已补；Node 回归通过 | 旧 source 配置全部字段和 Android golden 仍待验证 |
| D26 | 缓存 | 对象/二进制/数值和 onlyDisk | 部分实现（第三阶段 C） | CacheManager bridge 保留 JSON 对象、独立 ByteArray 命名空间、数值读取和 `get(key, onlyDisk)`；字符串/bytes 不互相污染，TTL、版本化快照、过期和损坏条目隔离已有 Node 回归 | 任意 JVM 对象和跨宿主磁盘语义仍不等价 |
| D27 | Cookie | CookieStore 公开面及域语义 | 部分实现（第三阶段 C） | cookie 已补 getKey/replaceCookie/cookieToMap/mapToCookie/clear；Node CookieStore 解析多键 Cookie header、按有效域共享、按域清理，并保留 tough-cookie 的 path/expiry/same-site 约束 | WebView Cookie 同步、Android golden 和少数特殊公共后缀行为仍待验证 |
| D28 | 应用状态 | Web 跨请求源状态与 cache 恢复 | 部分实现（第一阶段 + 第三阶段 C） | 差异登记 D28；Node 快照恢复源键值、登录信息、登录头、字符串缓存和 ByteArray，快照版本/超限/损坏输入不会清空当前状态 | 删除/换版、账号隔离、恢复失败和自定义缓存宿主仍需验证 |
| D29 | 文件隔离 | Web 默认共享文件目录 | 部分实现（第一阶段） | 差异登记 D29；Web 通过部署密钥派生账号/源/版本命名空间并注入 `fileRoot` | 跨命名空间读写删除拒绝及无持久磁盘部署仍需组合验证 |
| D30 | 文件请求 | 下载认证/URL options/归档字符集/缓存失效 | 部分实现（第四阶段 + 第三阶段 C/D） | Node session 的文件/字体/归档下载复用 SourceRequestHost，继承动态 Header、登录头、Cookie 和重定向；下载文件十六进制重载、归档 bytes 自动探测字符集、`cache.delete(md5Encode16(url))` 同步失效 `cacheFile` 映射；zip/gzip/外部 7z/rar 提取接受取消信号并清理临时目录 | 受控 HTTP 仍不等于 WebView；真实 Android 归档/缓存 golden、RAR/7z 工具版本仍待验证 |
| D31 | 发现状态 | InfoMap 方法、保存时机和 TTL | 部分实现（第四阶段） | InfoMap 已补无参 get、putAll、containsValue、keys/values/entries、删除传播；Web 按 Android `save(time,need)`/`saveNow` 记录秒级 TTL，控件直接修改显式提交，`layout_wrapBefore` 已映射为 Web 换行 | 真实 Android golden、多实例保存竞争和所有 MutableMap 迭代器细节仍待验证 |
| D32 | 加密重载 | 已废弃 AES/DES/3DES API 的实际返回类型与行为 | 部分实现（第三/第五阶段，3D 已补固定向量） | `aesEncodeToString` 对齐 Android 历史 decryptStr；`aesEncodeToBase64ByteArray` 返回 UTF-8 Base64 bytes；AES、3DES legacy 重载和 GCM 返回类型已有固定 Node 向量；Node OpenSSL 不提供 DES 时返回 capability code | DES/3DES 便捷重载与 Android provider 仍待逐项 golden；DES 是否可用取决于 Node OpenSSL provider，不伪装成成功 |
| D33 | 加密对象 | 工厂状态、模式/padding/RSA 参数 | 部分实现（第五阶段，3D 已补 GCM） | 工厂在脚本执行内保持 key/IV 状态，支持 `setIv/getIv/getSecretKey`、null key、AES-GCM authentication tag、常用对称模式和 RSA PKCS1/OAEP/NoPadding；CCM/SM 系列明确返回 provider capability | GCM AAD、CCM/SM、OAEP MGF 全参数和 Android provider 行为仍待 golden；Node 与 Android 的 provider/key 编码差异保留 |
| D34 | JS 引擎 | StrResponse、Java 类、JavaImporter/Packages 和字符串身份 | 部分实现（第三阶段 + 3B） | `JavaImporter/Packages/JavaAdapter`、MessageDigest、StringBuilder、Map/List、Java String、Pattern/Matcher、Base64、URLEncoder、DatatypeConverter、HMAC/SecretKeySpec、ByteArrayInputStream 和可构造 StrResponse 已补；教程脚本回归通过 | 这些是受控纯方法模拟，不加载通用 JVM/Rhino；完整对象身份、任意系统类、真实接口回调和 ClassShutter 语义仍需真实宿主或逐成员模拟 |
| D35 | 字体对象 | 本地文件输入及 QueryTTF 公开对象 | 部分实现（第三阶段，3D 已补格式诊断） | 字体对象补 getGlyfById/unicodeToGlyph/glyphToUnicode/unicodeToGlyphId；文件路径下载复用源请求链；TTF/TrueType sfnt 正常解析，WOFF/WOFF2/CFF/TTC 与非法 glyph 输入分成 capability/invalid 诊断 | CFF/WOFF 实体解析、缺失 glyph 的 Android 返回值和 golden 仍待验证；当前不把格式错误降级成空字体 |
| D36 | 工具函数 | 日期格式和繁简词库 | 部分实现（第三阶段，3D 已补非法格式守卫） | Node 日期格式补 D/w/W/F/k/K/z/G 常用 token；固定 UTC/locale 回归继续通过；未知 SimpleDateFormat 字母不再静默输出字面量，而是返回空结果 | SimpleDateFormat 全量 token、设备 locale/时区、引号和繁简词库版本仍待 Android golden；空结果是受控差异，不等同 Android 异常文本 |
| D37 | 宿主值 | 设备替代值和阅读/主题配置注入 | 部分实现 | 差异登记 D37；getWebViewUA 已有默认字符串 | 账号内稳定标识与真实应用设置映射；明确物理设备不等价 |
| D38 | 导入/请求 | 历史宽松 JSON | 部分实现（第三阶段 A） | D38；`codec/relaxed-json.ts` 严格 JSON 优先，宽松回退只处理字符串外注释、单引号、未引号键和尾逗号；导入、规则、URL options、发现分类及原型键安全回归通过 | 仅解析数据语法，不执行表达式；GSON 其他宽松选项和 Android golden 仍待验证 |
| D39 | JS 生命周期 | 声明式 jsLib 共享对象状态 | 部分实现（第三阶段） | jsLib 按源指纹恢复可序列化全局状态，`refreshJSLib` 清除状态并有跨执行回归；函数/闭包/宿主对象不进入快照 | 并发、取消、跨进程和非序列化对象生命周期仍需明确边界 |
| D40 | 发现请求 | 分页签名未绑定筛选/快照版本 | 部分实现（第一阶段） | 差异登记 D40；游标签名加入发现代次，刷新后旧游标有回归测试 | 动态 URL/infoMap 摘要、迟到请求写回和多实例组合仍需验证 |
| D41 | 诊断/证据 | 方法登记被误当兼容、缺失能力误报普通失败 | 差异待处理 | 差异登记 D41；当前 TypeScript 证据为 `pnpm test:source` 132/132、根全套 531/531、reader-web 137/137，但仍需逐签名返回对象覆盖和 Android golden | 逐签名和返回对象覆盖、能力错误可判别；Android not-run 保留 |
| D42 | URL 对象 | IPv6、searchParams 和基准地址 | 部分实现（第四阶段） | toURL 补 get/getAll/has/set/append/delete/toString，保留重复 query 值、IPv6 authority 和已编码参数名；回归覆盖 IPv6 host/port/origin | 无 base/非法输入、默认端口和完整 URL 属性仍待 Android golden |
| D43 | 文件对象 | File 方法和即时状态 | 部分实现（第四阶段） | File 补 getName/getPath/getAbsolutePath/length/lastModified/canRead/canWrite/listFiles，并每次刷新宿主元数据；`cache.delete` 会清理对应 `cacheFile` 映射；Node 文件回归通过 | 写入/删除竞态、绝对路径投影和 Android golden 仍待验证 |
| D44 | 应用交互 | 登录 UI/action、书源事件和付费动作的应用入口 | 部分实现（第六阶段） | 差异登记 D44；reader-web 已提供静态/动态登录 API 与页面、动作事件、payAction/callBackJs 人工触发、源版本校验和进程内幂等；密码/token 脱敏；`source-login.test.ts`、`source-actions.test.ts` | 购买后刷新、自定义按钮消费、多实例幂等、真实网页登录/验证码和 Android golden 仍待验证；真实远程动作不自动执行 |

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
