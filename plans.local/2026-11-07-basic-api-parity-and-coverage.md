# 基础 API 行为兼容修复与测试覆盖扩展
- 状态：approved
- 创建：2026-11-07
- 更新：2026-11-07
- 实施基线：b602ad0（独立 JVM/TS 差异测试机制）
- 参考源码基线：32a87b253e7cc28273c3850de86242caac83f1fd

## 方案

### 目标、范围与决策

#### 用户目标与验收原则

本计划只落实三项工作：核实当前差异、修复高价值基础函数、扩大基础 API 与规则样本覆盖。核心标准是 Android 能处理的规则，TS 也能处理，且在约定宿主能力和资源预算内，结果、顺序、空值、继续/终止行为及规则可见状态一致。JDK API 结果用于验证 Java bridge，Android 原 Kotlin/Java 规则实现用于验证书源规则；两类证据不得混用。

按用户提出的方向，本计划建议放宽不影响行为的报错差异。可以放宽异常类名、语言、堆栈、路径和非契约日志；前提是结果、终态和后续处理一致。Android 返回合法空值继续执行而 TS 抛错中断，不属于可放宽差异。脚本读取 exception.name/message 并据此分支时，这些字段成为可观察行为，不能直接忽略。

采用“先校准比较入口，再按根因修复，同时增加边界案例，最后扩展相邻 API”的方案。最小选项是只处理现有差异；它不能解决未覆盖重载，所以推荐本计划的三个独立交付阶段。第一阶段交付可运行的行为判定和差异台账。第二、三阶段均分为可以独立合并和回退的功能批次，不等待所有批次完成才交付。

#### 当前事实

规划开始时工作区干净，main 比 origin/main 领先一个本地提交。已保存报告 output/run-YJF6TX：114 例、78 一致、35 差异、1 未支持、0 执行器故障。35 个差异分别是 10 个返回值不同、9 个一端返回一端抛错、16 个双方抛错但异常信息不同。现有 19 个 operation，7 个功能族；15 项机制/参考协议回归通过。以上为已有执行证据，本轮规划没有重新运行双端测试。

已核实的实现位置：
- packages/compatibility-tests/ts/adapter.ts：JSON 列表转换使用 map(String)，可把 null 转为文本；Base64 当前直接调用 NodeEncodingHost，与 JDK 解码器不在同一兼容入口；regex.first 由多匹配结果投影，不是独立原 API。
- packages/source-core/src/rules/source-runtime.ts：legadoJavaSplit 使用 JS split 后按原 pattern 文本重组正数 limit 的尾段；URL 包装器 getHost 取 host（可能含端口）；初始 URL DTO 的 authority 排除了 userInfo；Packages.java.net 只有 URLEncoder，没有 URLDecoder。
- packages/source-core/src/rules/source-runtime.ts：jsonInput 在 JSON.parse 失败时保留原字符串；桥接 getStringList 具有区别于测试 map(String) 的空值转换。不能把测试侧现有字符串化直接视为产品缺陷。
- 原 AnalyzeByJSoup：legacy tag 路径使用 getElementsByTag；XML 文档模式不意味着这个方法与所有 CSS 标签选择器大小写规则相同。
- 原 AnalyzeByRegex.getElement 对未参与匹配的 group 使用非空断言；getElements 对该组使用空串，两者不同；Android AnalyzeRule.getElement 确实调用前者，需保留原方法和外层调用的证据区别。

#### 保留约束

不修改原 Android 仓库，不拆分原工程，不引入 Android SDK/运行环境，不新增后端服务、账号、API key 或生产凭证。保留现有 JDK/Maven/Kotlin 与解析库锁定版本，不通过依赖升级修正结果。保留现有 QuickJS、SSRF、协议、归档和执行预算边界。

“Android 能处理就应兼容”与现有兼容政策允许安全差异的范围有交集；本计划按既有安全政策保留限制、逐案例披露，不把一般解析差异包装成安全例外。如果后续某个有效书源必须突破明确安全边界，实施者单列该案例和影响后请求决定，不顺带移除安全限制。

完整书源流程、线上站点可用性、WebView、交互登录、付费、文件副作用、持久会话/缓存并发、通用 JVM 对象身份和旧测试删除不在本次范围。11 源固定集合用于提取规则样本，本轮不执行源脚本中的远程请求，不重新下载集合。

### 实施与验证

#### 一、统一判定与覆盖接口

在新测试包内增加两份有不同职责的数据：

1. triage.json：按原案例 ID 记录根因组、归类（runtime-fix / adapter-fix / error-equivalent / intentional-difference / reference-observation）、处理状态（open / resolved / deferred）、Android 或 JDK 来源、TS 入口、所需断言和证据路径。不复制双方输出正文或手填统计数字。35 个差异及 1 个未支持项均有唯一归属；新发现差异也纳入同一台账。
2. coverage.json：以 method/signature + 测试层级为键，记录 reference 种类、TS 被测入口、目标案例维度、caseIds 和状态（verified / different / unsupported / blocked）。可以引用既有 259 成员清单的 ID，但不能被它的粒度限制，也不能因新增覆盖表就改写旧清单完成度。覆盖率的分母必须明确；没有 JVM 结果、仅有 TS 单测或只有允许差异的项不计入原样一致数。

沿用已有 case/result 包络和 CLI；可选新增 case.contractScope=api/reference-observation，缺省 api。所有原案例保留 ID 和原始输入。reference-observation 仅用于无等价调用入口或仅描述内部算法的样本，不能用于隐藏用户能执行的规则。每个此类样本要有可执行公开规则案例关联，或者在台账明确 blocked。原始报告仍显示其差异/unsupported。

报告同时给出 rawComparison（原始字段比较）和 behaviorComparison（行为比较），原始结果保留。对 api 范围的行为差异或未执行，严格命令仍失败；已验证的纯异常表达差异可以行为通过，但报告单列 error-equivalent 数量。reference-observation 不算已覆盖或通过，只从产品兼容验收分母移出；原始总数和未支持数始终显示。不得通过改范围掩盖 Android 成功而 TS 失败的规则。

继续使用逐案例 errorEquivalence。补充可选的 jvmMessageIncludes / tsMessageIncludes 判别条件；映射为语义类别时同时检查方法、异常类别及指定标记。例如 TS 的 __LEGADO_PATTERN__invalid-pattern 可映射 invalid-pattern；同样为 Error 但实际是“方法不存在”不得映射成功。不新增全局消息忽略、错误吞掉、异常自动转空值或自动更新 golden 的逻辑。

比较数据流：

```text
共享案例与 API 覆盖表
    ├── JVM 原实现/JDK 调用 ── 原始结果 ──┐
    └── TS 真实入口          ── 原始结果 ──┤
                                         ▼
                              原始比较 / 行为比较
                                         ▼
                              差异台账关联与覆盖报告
```

#### 二、阶段一：校准 114 例并交付行为基线（1～2 人日）

目标：让每个差异有准确归属，修正错误的比较边界，并实现用户允许的报错语义放宽。此阶段不改产品解析算法。

文件：ts/adapter.ts、jvm/src/main/kotlin/compat/Main.kt、scripts/compare.mjs、scripts/common.mjs、scripts/run.mjs、schema/case.schema.json、schema/operations.json、tests/mechanism.test.mjs、tests/jvm.test.mjs，新增 triage.json、coverage.json，更新对应案例与 README。

具体交付：
- JVM String split/replace 操作使用对应 java.lang.String 方法，避免签名标注与实际调用 Pattern 的入口不一致；Pattern.split 作为单独 operation，不混用。
- Java Base64 对照改为 Packages.java.util.Base64 的基本编码/解码接口。NodeEncodingHost 的严格策略保留 TS 专属回归；不能因为 Node 层严格就直接要求所有 Java 包装器保持严格。
- JSON 字符串/列表操作明确对应原 AnalyzeByJSonPath 与 TS 实际 Java bridge 字符串入口；原始 JsonPathParserAdapter.evaluate 另设 json.read 观察原值，避免适配器先替结果决定 null/空串。适配器不自行修复非法 JSON/路径，真正的错误处理在产品入口实现或明确登记。
- rule.inner 保留原内部方法观察，增加同输入的 JSONPath 内嵌规则实际调用案例作为行为证据，不为测试新建产品 innerRule API。
- rule.split 的 code 参数在 TS 没有等价入口时明确报告，而不是静默忽略；19 个 operation 的每个输入字段都核对两端是否真正使用。
- 增加“同类业务错误可以等价”“错误方法的 TypeError 不能等价”“Android 返回空值而 TS 抛错不能等价”“报告原始差异仍可见”“观察样本不计通过”的机制回归。

阶段验收：114 例 ID 无删除；35+1 项全部分类并有证据/负责人（实施者）；零 runner-failed；已知错误表达差异按规则比较，不承诺此时全部行为通过。台账中的每个 resolved 项都有实际执行记录。

#### 三、当前差异的任务映射

下表是具体执行任务与当前证据下的处理方向。标为“核对外层”的项已给定保守默认：先保留当前产品行为和原始差异，不改变成功/错误语义；完成同层入口证据后按实际可观察行为修复或明确登记，不做猜测性改动。

| 任务 | 当前案例 | 处理与验证 |
| --- | --- | --- |
| R01 | encoding.urlDecode.empty/normal/escaped/invalid，4 例 | URLDecoder 缺入口，增加同编码宿主的 form decode bridge；非法百分号仍抛参数错误，不能映射当前方法缺失 TypeError |
| R02 | string.split.empty，1 例 | 修复空输入结果，并一起修复捕获组污染、正 limit 的原文尾段与零宽边界 |
| R03 | url.parts.no-query/ipv6，2 例 | Java getHost 使用不含端口的主机；getAuthority 保留 userInfo；JS 属性 host 等原有接口分别验证，不能一起改成 Java 字段 |
| R04 | json.string.null / json.list.null，2 例 | 先排除 map(String) 的适配影响；真实字符串入口仍不同才修复 null 转换；同时验证实际字符串 "null" 不被清除 |
| R05 | json.string/list.invalid-json，2 例 | 对照 JSON 解析与外层调用的失败边界；Android 失败不能变为 TS 合法空结果，用户可观察终态不同需修复 |
| R06 | json.string/list.invalid-path，2 例 | 核对原类吞错返回空与外层规则预检的关系；Android 可继续时 TS 不得提前中止；保留其他模式预检和预算 |
| R07 | css.string/list.xml，2 例 | 按 legacy tag 与显式 CSS 分开验证；修正对应选择器路径，不全局取消 XML 大小写 |
| R08 | css.string/list.selfclose，2 例 | 核对 parseSourceHtml 与 htmlparser2 的 DOM；保持后续兄弟元素不被自闭合链接吞入；验证 textNodes 顺序 |
| R09 | encoding.base64Decode.tail-bits，1 例 | 改成 Java bridge 同层对照后验证；需要时在 Java 基本解码路径兼容 JDK，保留 Node 外部输入严格校验，不用全局放宽代替 |
| R10 | regex.first.optional，1 例 | 保留原 getElement 的 NPE 证据；验证 Android 调用者是否终止及规则是否成功。不能自动要求 TS 制造 NPE；如为可见失败则匹配失败终态，原异常类名不强求 |
| R11 | rule.split.escaped，1 例 | 单独验证原 RuleAnalyzer 结果与真实规则组合；低层 scanner 和完整规则入口分开，不全局移除反斜杠处理 |
| E01 | css.string/list.invalid，2 例 | 语义 invalid-selector；必须验证都失败且没有产出或继续行为差异 |
| E02 | encoding.base64Decode.invalid，1 例 | 同层 bridge 校准后映射 invalid-base64；拒绝把“缺方法”等价为非法输入 |
| E03 | regex.first/all.invalid，2 例 | 语义 invalid-pattern；记录原始 PatternSyntaxException 和 TS 编译诊断 |
| E04 | rule.split.unclosed，1 例 | 语义 unbalanced-rule；终态一致才放宽类别/文案 |
| E05 | string.split.invalid、string.replaceAll.invalid、string.replaceFirst.invalid，3 例 | 按具体调用识别 invalid-pattern；增加 limit=1 + 非法 pattern，不能提前返回掩盖错误 |
| E06 | string.replaceAll/replaceFirst.bad-group，2 例 | 语义 invalid-group；保留替换是否部分发生的断言 |
| E07 | integer.parseLong.overflow/invalid，2 例 | 分开映射 overflow 与 invalid-number；检查数值未被截断、返回或写入 |
| E08 | url.parts.invalid/empty，2 例 | 语义 malformed-url；无请求、副作用或旧值覆盖 |
| O01 | rule.inner.basic，1 个未支持项 | 内部方法观察保留；通过实际内嵌规则验证，不新增只供测试的公开 API |

R01～R11 覆盖 20 项根因任务（包含双方抛错但原因不同的 URLDecoder.invalid）；E01～E08 覆盖 15 项纯错误表达任务；O01 对应唯一 unsupported。归因校准可能改变其中归类，但必须记录证据与原因，不能删除原记录。

#### 四、阶段二：按根因修复基础行为（4～6 人日）

每批依次执行：现有失败案例在修复前失败 → 增加同类边界样本 → 最小修改实际 TS 入口 → 重跑该族 → 执行受影响旧测试与类型检查 → 全量报告核对无新行为回归。普通异常表述映射与运行时语义修复使用独立提交，便于核查。

| 批次 | 任务 | 主要实现文件 | 必须增加的边界 | 独立验收 |
| --- | --- | --- | --- | --- |
| B1 字符串/正则 | R02、R10、R11；E03～E07 | source-core/src/rules/source-runtime.ts、scanner.ts、pattern-guard.ts、必要的 evaluator.ts；先确定真正缺陷位置再修改 | 空输入、无匹配、limit 负/零/1/2、可变长度分隔符、捕获分隔符、零宽开头/中间/结尾、代理对、未参与组、非法组编号、不平衡/转义组合 | Android 成功的已选字符串/规则案例全部成功且输出一致；已确认的失败路径语义一致 |
| B2 URL/编码 | R01、R03、R09；E02、E08 | source-core/src/rules/source-runtime.ts、source-node/src/charset.ts/encoding.ts 中实际必要位置 | + 与 %20/%2B、多字节 UTF-8、GBK、非法 %/%Z/%ZZ、无效字节、显式/默认端口、IPv6、userInfo、相对地址、重复 query、无 query、URL-safe/Base64 基本模式区分 | 解码入口存在，合法输入一致；Java URL 方法一致，JS 属性回归不倒退；严格 Node 编码策略未被全局削弱 |
| B3 JSONPath | R04～R06 | source-core/src/rules/source-runtime.ts、source-node/src/jsonpath.ts；真实 bridge 转换层 | 缺失/null/字符串 null/空串/空数组/空对象、对象和数字输出、确定/不确定路径、空匹配、非法 JSON/路径、内嵌规则、组合后继续执行 | 合法查询结果与列表顺序一致；Android 可继续的空结果不被 TS 中止；解析失败不伪装成功 |
| B4 HTML/CSS | R07、R08；E01 | source-node/src/html.ts、source-core/src/rules/source-runtime.ts 的对应选择器分支 | HTML/XML、legacy tag 与显式 CSS、同名大小写、class/id 字面值、自闭合链接及嵌套/相邻节点、text/ownText/textNodes、缺属性、负索引/范围/排除、畸形 HTML | 结果与原解析器一致；未选中节点及后续兄弟不被错误包含；既有 DOM/选择器回归通过 |

实现约束：
- String.split 以匹配位置截取原文尾段，不能用 pattern 文本重新 join；捕获组不能作为拆分字段输出。
- URLDecoder 按 JDK 的 form 语义处理 + 与百分号字节，再使用当前 CharsetCodec 解码；不能仅用 decodeURIComponent 代替，因为不完整字符字节的处理可能不同。
- URL 的 Java 方法和现有 JS 属性分别定义测试；修复 getHost 不改变 host 属性中的端口含义。
- JSON 的 null/空值处理放在与原调用层等价的边界；不能把所有 RuleValue 的 null 全局删掉。
- legacy 标签查询与显式 CSS/XML 查询分别实现其既有语义；自闭合处理只影响需要兼容的 HTML 标签路径。
- 原 Android 自身抛出的内部异常只要求可观察失败行为一致，不为了异常类名引入 Java 异常继承体系。

阶段验收：R01～R11 的每项都变为有证据的 resolved 或带明确外部条件的 deferred；deferred 不计通过。基线中的 Android 成功案例不得存在未登记的 TS 失败；新发现的同根因差异一并修复。结果计数允许因适配和错误语义校准改变，不以固定“35→0”替代行为验收。

#### 五、阶段三：扩展基础 API 与真实规则覆盖（3～5 人日）

覆盖按方法、重载和行为维度统计，不按测试文件数或案例总量。以下为本轮有限清单；每个合法重载至少正常值、空/边界值，存在失败契约时增加非法输入，并用结果继续参与一次后续规则或脚本表达式，确认没有仅在隔离调用中通过。

| 批次 | 本轮明确覆盖范围 | 样本要求 |
| --- | --- | --- |
| C1 现有 19 个 operation 深化 | rule.split/inner 观察、regex.first/all、String split/replaceAll/replaceFirst、Pattern.quote、Long.parseLong、基本 Base64、URL 编解码、MD5、URL parts、CSS string/list、JSON string/list | 补齐 B1～B4 的边界；每个参数都在至少一个案例改变结果；给 limit、charset、base、code 和 regex patterns 增加忽略参数的反向检测 |
| C2 字符串与数字 | String.length、charAt、substring(start)、substring(start,end)、indexOf(text)、indexOf(text,start)、getBytes(charset)、codePointAt、codePointCount、offsetByCodePoints；Integer.parseInt(text,radix)、Long.parseLong(text,radix)、BigInteger(text,radix).toString(radix) | UTF-16/emoji、负索引/越界、空输入、UTF-8/GBK、radix 2/10/16/36、正负符号、Int/Long 上下界及越界、超安全整数文本 |
| C3 Pattern/Matcher | Pattern.compile(regex,flags)、matcher.matches、find、find(start)、group(index)、start(index)、end(index)、reset(input)、replaceAll | 命名/数字组、可选未匹配组、零宽匹配、连续 find 状态、reset 后状态、非法 pattern/索引、Java flags 中当前 bridge 声明支持的值；不支持值明确 unsupported |
| C4 编码与摘要 | String.getBytes 与 new String(bytes,charset) 往返；Base64 basic 与 URL-safe 的编码/解码、MIME 解码；MessageDigest MD5/SHA-256 | 0/127/128/255 字节、空 bytes、补位/无补位、URL-safe 字符、MIME 换行、非法字符、charset 差异、标准固定向量 |
| C5 有限集合 | HashMap.put/get/containsKey/remove/clear/size；ArrayList.add/get/set/remove(index)/subList/size | 缺失键与 null、旧值返回、插入顺序是否属于契约、父列表与子视图回写、越界；在一例脚本内验证连续调用，不扩大到并发/fail-fast/完整 Java 对象身份 |
| C6 解析规则 | CSS 组合/索引/属性/textNodes；JSONPath read、列表/过滤/聚合 length/sum；XPath getString/getStringList/getElements | 基础模式、合法空结果、异常、连续组合与上下文；XPath 只输出有定义的文本/属性或节点序列化，不比较跨语言节点身份 |
| C7 真实规则片段 | 遍历固定 11 源的 ruleSearch/ruleExplore/ruleBookInfo/ruleToc/ruleContent 中可执行字符串字段；保留完整规则文本 | 每个不同基础语法组合至少一个合成输入；相同规则按文本 hash 共享案例并保存所有 origin；含网络/登录/文件依赖的脚本列为后续流程依赖，不远程执行或静态猜测为通过 |

C6 的纯 JVM XPath 接入采用明确的最小适配：白名单加入固定提交 AnalyzeByXPath.kt；其唯一 Android 行为依赖 TextUtils.join 用测试专用、仅提供 join 的纯 JVM 适配实现，保持分隔符、元素 toString/null 与顺序语义，记录适配路径/hash。先独立断言 join 的空集合、null 元素、Unicode 和顺序，再执行原 XPath 解析代码；不引入 android.jar、不创建通用 Android 模拟层、不改 XPath 算法。该证据必须标 upstream-adapted，不能宣传为未经适配的 Android 平台执行。

新增 operation 的输入定义同步 operations.json 与 case.schema.json；增加一致性回归，防止两份声明漂移。按函数族扩展现有适配器，确实因文件长度需要时才拆分，不创建插件注册系统、通用 JVM RPC 或自动反射任意方法。

coverage.json 的 verified 需要双端实际完成且 api 行为通过；error-equivalent、allowed-difference、unsupported、blocked 分别统计。报告列出缺少的场景维度和关联原方法签名；既有 259 成员表只关联真实覆盖的成员，不按能力族整体改成兼容完成。

阶段验收：本表声明的每个方法/重载都有案例或明确 blocked 依赖；Android 成功的本轮 required 样本全部双端成功、结果一致，禁止将暂未实现的新 API 直接改成观察项。新发现但不同根因的问题登记台账，优先完成会使成功规则失败的项；确实超出本轮纯 JVM/基础能力边界的标 deferred，保留严格报告，不宣布全量兼容。

#### 六、文件范围、命令与交付

预计涉及超过 8 个文件。主要是新测试包内的适配器、比较器、schema、案例、coverage/triage、参考 Kotlin 入口与 XPath join 适配；产品改动限定 source-core/src/rules/source-runtime.ts、scanner.ts、pattern-guard.ts、evaluator.ts 和 source-node/src/html.ts/jsonpath.ts/charset.ts/encoding.ts 中证据指向的位置，不预先修改所有这些文件。

每批同步 docs/README.md 的要求摘要；长期允许差异只登记 docs/compatibility/known-divergences.md；方法实现状态在现有 status/机器清单登记，实际执行证据在 evidence-matrix 或测试包报告登记，不多处复制同一事实。删除旧测试和无关重构不随修复提交。

验证命令：

- node --test packages/compatibility-tests/tests/*.test.mjs
- node packages/compatibility-tests/scripts/run.mjs --case string.split.empty
- node packages/compatibility-tests/scripts/run.mjs --family string（其余族按同一已存在 family 参数执行）
- node packages/compatibility-tests/scripts/run.mjs（每批最终全量，核对行为与原始差异双统计）
- node --test packages/source-core/tests/rules.test.ts packages/source-node/tests/source-rule-host.test.ts packages/source-node/tests/adapters.test.ts
- pnpm --config.verifyDepsBeforeRun=false typecheck
- git diff --check

修复时针对性的回归先执行，组合修改完成后再执行上述受影响集合；没有新改动、失败或未解决疑点时不反复扩大测试。适配器校准提交不顺带修改产品运行代码。建议交付顺序为 A 行为判定与台账 → B1～B4 各自修复提交 → C1～C7 按族独立扩展；提交需有本轮授权，push/发布不包含在本计划授权内。

时间估计为 8～13 人日；CSS DOM 与 XPath 原源码隔离是主要不确定性。估计不包含线上书源流程、完整 259 成员修复和 Android 平台能力。

### 风险与回滚

最脆弱的假设：现有低层方法对照足以代表 Android 规则行为。如果调用层不同，可能修错产品边界；因此第一阶段强制记录入口，低层观察与公开规则分开，修复依据必须来自同层调用或有明确推导的外层源码与实际输入输出，不用测试侧字符串转换替代事实。

不为了兼容去掉正则预算/协议/SSRF 等已有安全边界；若此类限制命中真实正常规则，记录具体样本后单独评估受限支持，不能在本轮自动开放任意 Java 或本地文件。

Maven/上游本地源码不可用时，报告 runner-failed 或 blocked，不改用 TS 输出生成参考结果。已缓存且摘要一致的依赖可复用，无可用证据不计通过。案例扩大到十倍仍以进程批量执行、每例隔离为准；暂不增加并行 JVM 构建，防止共享构建目录冲突。

每个批次可独立 revert；没有数据库迁移、部署或外部业务写入。台账、案例和原始报告可保留供复现，回退某个运行时修复不需要删除对应失败案例。异常语义放宽须能回退为 rawComparison 检查，历史原始信息不丢失。

## 完成记录
- C2 首批方法/重载测试已建立：字符串族 118 例中 117 行为一致，新增 String/数字方法含 Unicode、边界、radix、返回值继续使用；发现 C2-UTF8 未配对代理字符的 getBytes 差异，作为独立问题保持失败并登记。覆盖表已细分方法签名，尚未将此族全部计 verified。报告 output/run-ddSF7M。
- B1/R10 已修复：适配器切换真实 getElement/getElements 后暴露首个/全部匹配与正则链错误，现 12/12 一致，累计预算回归及原回归 135/135 通过。阶段二合并执行 193 例，其中 192 API 全部行为一致、1 内部观察不计通过、28 项错误语义等价、0 执行器故障；18 项机制测试通过。报告 output/run-IFYm3y。原 35+1 项已全部归因并处置；阶段三仍待完成。
- B1/R11 已修复：真实 JSONPath 反斜杠字段组合在 Android 返回甲/乙、旧 TS 返回空，现两端一致；JSON 族 43/43、规则 API 7/7（另 1 内部观察仍不计通过）、原回归 134/134。报告 output/run-ZgBRnu → output/run-yw78Ex / run-F7wifc。
- B4/R08 已修复：规则 HTML parser 开启自闭合识别，自闭合链接/div 不吞后续兄弟，textNodes 保持顺序。CSS 族 41/41、原回归 164/164 与根类型检查通过。报告 output/run-fMxfCI。
- B4/R07 已修复：原解析器证据确认 XML 的 legacy 与显式 CSS 标签查询均忽略大小写，属性名/DOM 保留大小写，legacy 根元素参与匹配；纠正对应旧断言后 164 项回归通过。41 例 CSS 族的 35 例一致，余 6 例均为单独 R08 自闭合问题；报告 output/run-UqDuxv → output/run-QZIG4E。
- B3/R04～R06 已修复：41 个 JSON 族案例一致，含标量/数组 null、Java Map 文本、非法输入与路径后继续执行、原 Jayway 接受的单引号/未引号键/尾逗号；164 项原规则/宿主/adapter 回归通过。调整一个旧空规则回归的输入为合法 JSON，使其 @put 的 JSONPath 不再依赖错误输入被吞掉。报告 output/run-czHTcO → output/run-Gn82X4。
- B2/R09 已修复：Java 基本 Base64 与 Node 严格宿主解码分离；31 个编码族案例行为一致（含两类尾位、非法补位/空白），148 项宿主/adapter 回归通过。报告 output/run-zWcPVn。
- B2/R03 已修复：URL 方法 12/12 行为一致，含 userInfo、IPv6、端口、空 query/ref；保留 JS 属性语义。修正一个旧宿主断言，其 getAuthority 预期遗漏用户信息，独立 JDK 证据确认后更新；118 项回归通过。报告 output/run-AElWIJ → output/run-SLgG2e。
- B2/R01 已修复：新增 URLDecoder 与指定字符集表单解码。修复前缺入口，修复后 10 个解码案例通过，含 GBK 和不完整 UTF-8 的替换语义；编码族剩余 Base64 尾位一项属于下一问题。原宿主 118 项回归通过。报告 output/run-bjlAQq → output/run-JRhHMR。
- B1/R02 已修复：String.split 与 Pattern.split 共 46 个案例行为通过；旧 helper 在当前构建入口复现 14 个行为差异，修复后为 0。SourceRuleHost 既有 118 项回归通过。报告 output/run-stQAaf → output/run-71mZvL。
- 校准后发现 SourceRuleHost 通过包名加载 core/dist，原执行入口可能使用旧产物。新增 TS 执行前 core 构建与实际产物摘要；后续修复验证必须经过此入口，不接受旧 dist 结果。
- 阶段一已实现：保留原 114 例并增加 7 例，校准 String/Pattern、Java Base64、JSON bridge/read 的比较入口；增加 triage/coverage、原始与行为双比较及窄错误标记。121 例执行为 98 一致、22 待修行为差异、1 内部观察未支持、0 执行器故障，15 项异常语义等价；报告 output/run-aY0Xdr/report.md。已确认 String null 为适配影响，List null 仍需产品修复。
- 规划阶段（实施前）：完成源码只读核查与详细草稿，随后按批准范围实施；最新阶段状态见上方执行记录。
- 已核对本地提交、最新 114 例报告、19 个操作契约和实际调用实现；没有修改运行代码、测试或原 Android 仓库。
- 官方行为参考：[JDK 21 String](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/String.html)、[JDK 21 URL](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/URL.html)、[JDK 21 URLDecoder](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/URLDecoder.html)。JDK 规范只用于 Java API；Android 规则以固定源码实际行为为准。

## 变更记录
- 2026-11-07：按用户要求细化差异核实、基础兼容修复与测试扩展；增加“Android 成功规则优先、无行为影响的错误表达可语义放宽”的验收原则。

## 批准记录
- 2026-11-07：用户明确要求将规划写入 plan 文档，并按阶段、按修复问题 commit、完成所有内容；批准本计划全部三阶段及其范围内的实现、验证和本地提交，不包含 push。

- C2-UTF8 已修复：Java bridge 的 UTF-8 字节编码在编码前将孤立代理字符替换为 JDK 的问号，保留有效代理对；String.getBytes 与 URLEncoder 共用入口。新增 URL 编码三例在修复前全部失败（output/run-0oHxHu），修复后全量 267 个 API 行为一致、1 个内部观察未支持、0 执行器故障（output/run-ZUqpYS）；18 项机制测试和类型检查通过。C3～C7 仍未完成。

- C3 首批 25 例已执行：14 一致、11 差异、0 执行器故障（output/run-fBBDNu）。已复现 find(start)、reset(input)、匹配状态与替换后状态缺口，登记 C3-MATCHER，尚未修复。

- C3-MATCHER 已修复：find(start) 与 reset(input) 使用实参并重置区域；matches/lookingAt 更新搜索位置；group/start/end 校验有效匹配与组索引；replaceAll 恢复完整输入并保留替换后无有效匹配的状态。25 个新案例全部行为一致（output/run-98XhzV），全量 292 个 API 行为一致、1 个内部观察未支持、0 执行器故障（output/run-ZdUy98）；18 项机制测试、119 项宿主回归和类型检查通过。C3 方法覆盖清单细化及 C4～C7 仍需继续。

- C4 首批新增 45 例：编码族 79 例中 57 一致、22 差异，缺少 Java Base64 URL 编解码与 MIME 解码入口（output/run-RXj08j）。MD5/SHA-256 固定字节向量及 digest 后重置继续使用通过；尚未宣告 C4 全部完成。

- C4-BASE64 已修复：增加 getUrlEncoder/getUrlDecoder/getMimeDecoder，URL 模式拒绝基本模式字母表，MIME 保留补位结构且允许终止后的非数据字节；共享 encoder 支持重复 withoutPadding。额外六个 MIME 边界中复现两项差异（output/run-Lyt9Bm），修复后全量 343 个 API 行为一致、1 个内部观察未支持、0 执行器故障（output/run-SHLeN1）；119 项宿主回归、18 项机制测试、类型检查通过。覆盖表已按 Base64 工厂/编解码签名细分，字符集往返与 C5～C7 仍需继续。

- C5 首批 18 个序列案例已建立；首批含列表及视图的 16 例通过（output/run-IOuTRv / run-BzKP0n），新增 Map 的 null 与字符串 null 区分、方法同名键复现 2 项差异。根因是键强制 String 且数据与方法共用对象，登记 C5-MAPKEY。

- C5-MAPKEY 已修复：数据与方法分离，null 键独立于字符串 null，保持字符串属性访问及 Map 视图回写。18 个集合序列行为一致（output/run-ehsyMN），全量 361 个 API 一致、1 个内部观察未支持（output/run-UVSWhV）；119 项宿主回归、18 项机制测试和类型检查通过。没有引入并发或 fail-fast 语义，C6/C7 及最终逐方法覆盖审计仍待完成。

- C6 XPath 参考端已接入原样固定源码；TextUtils.join 仅测试适配，4 项 JVM 机制测试含独立 join 边界通过。27 例校准后 23 一致、4 差异（output/run-5xBQqO）：元素字符串序列化、自闭合标签、空节点表达式。节点接口直接调用真实 XPathParserAdapter，与上游解析器接口比较，避免套用 AnalyzeRule 的空规则保持结果语义；非法表达式双端失败按窄错误映射比较，保留原始差异。

- C6-XPATH 原 4 项差异已修复。自闭合标签和空节点表达式分别由 31c0763、83c1414 提交。元素字符串按节点类型读取外部 HTML 或节点值，原 27 例行为一致（output/run-uf4aRQ）。旧宿主的祖先上下文断言改为显式选择后代文本节点。嵌套元素的 Jsoup 缩进序列化另有实测差异，需补共享案例并单独修复。

- C6 新增 18 个组合与聚合案例。CSS 组合、索引、属性和 textNodes 全部一致。校准 json.read 的聚合参考配置后，JSON 52 例中 50 一致、2 项 sum() 字符串差异（output/run-FkOitC）。嵌套 XPath 元素的 Jsoup 外部 HTML 缩进仍不同（output/run-EszpKa）。两项均登记为待修。

- C6-JSON-SUM 已修复。sum() 的文本输出保留 Double 小数位和科学计数法表示，55 个 JSON 用例一致（output/run-KUhZ8W）。全量 411 个 API 用例中 410 一致，剩余 1 项嵌套 XPath 元素序列化差异，另有 1 个内部观察项（output/run-Qf9GoX）。19 项机制检查、119 项宿主回归与类型检查通过。

- C6-XPATH-SERIALIZE 已修复。参考 Jsoup 1.23.2 的标签分组和格式规则处理 XPath 元素字符串，覆盖嵌套块、行内片段、预格式化文本、HTML 空元素和 XML 自闭合标记。6 个用例修复前不同（output/run-qJNicm），修复后 33 个 XPath 用例全部一致（output/run-ORetHs）。全量 416 个 API 用例全部一致，另有 1 个内部观察项（output/run-mMvuUE）。19 项机制检查、149 项宿主与适配器回归及类型检查通过。

- C7 已建立固定语料遍历入口。核对快照摘要后，五个规则区段共扫描 234 处非空字符串，按原文 SHA-256 合并为 177 条，保留字段位置、用途和已有案例 ID。机制测试验证多来源合并和原文关联。此清单用于选择各语法组合的正例，未关联项仍需按覆盖范围继续分类与验证。

- C7 新增 14 个原文规则正例，覆盖五个区段中的节点选择、属性、分组回退、合并、索引顺序、排除索引、后缀属性和 textNodes。节点结果比较标签、文本、ID 与顺序。首轮 textNodes 断言误将同一元素内的文本拆成多项，JVM 与 TS 均返回一个换行拼接项（output/run-oCyAxy），已按接口契约更正。全量 430 个 API 一致，另有 1 个内部观察项（output/run-KwJpjx），20 项机制检查与类型检查通过。含正则替换、插值、脚本的真实规则组合及最终覆盖审计仍待完成。

- C7 新增 10 个选择、替换、插值组合，含章节节点上下文。JVM 适配按固定 AnalyzeRule 的顺序组合原 AnalyzeByJSoup 和 Kotlin Regex。24 个语料用例中 23 一致，唯一剩余差异为 Java 正则 \h 被 JS 解释为字面 h（output/run-1u34kP），登记 C7-REGEX-HSPACE。

- C7-REGEX-HSPACE 已修复。Java \h 按水平空白集合转译，字符类中的转义及字面反斜杠均有 JDK 对比。443 个 API 用例全部一致，另有 1 个内部观察项（output/run-DHjdRZ）。119 项宿主回归和 20 项机制检查通过。

- C7 已锁定并校验原仓库 Rhino 二进制，纯 JVM 参考使用其安全作用域，原章节数字方法按固定源文件的行区间原样编译。7 条包含 JS 的语料规则均有离线用例。TS 改用工作流实际使用的 SourceRuleHost.evaluate，节点选择结果仅投影标签、文本和 ID。31 个语料用例中 27 一致、4 差异，分别为 JS 替换后缀和节点字符串（output/run-m2rBgq）。初次将完整规则套在嵌套 Java bridge 的结果另存 output/run-2I07j3，不能代替工作流入口证据。

- C7-JS-REPLACE 已修复。脚本先插值，再分离 ## 后缀，运行后按原正则守卫替换。工作流字段明确按文本结果传入脚本，保留节点阶段的列表。语料正例实际触发替换并通过（output/run-DZL2TJ），161 项宿主及流程回归通过。两条章节脚本进入 JS 后揭示 toNumChapter 返回范围差异（output/run-WGhS0R），作为独立问题继续。

- C7-CHAPTER-NUMBER 已修复。toNumChapter 匹配后仅返回转换后的第…章片段，未匹配保持输入。6 个双端用例修复前 3 项不一致（output/run-Lz4QiH），修复后全部一致（output/run-tzLaZT）。119 项宿主回归通过，旧断言按固定上游行为更新。
