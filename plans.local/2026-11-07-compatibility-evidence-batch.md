# 书源兼容性批量复测与修复

- 状态：completed
- 创建：2026-11-07
- 更新：2026-11-08
- 基线：legado-ts `fb87d93`，Android `32a87b253e7cc28273c3850de86242caac83f1fd`

## 方案

### 目标、范围与决策

完成 A1–F4 共 24 项。以固定 Android 参考验证受书源影响的具体行为，确认差异后逐根因修复并提交。保留基线 484 个基础契约、18 个完整流程、2 个目录阶段用例和 2 个独立参考观察。新增覆盖按行为和签名统计，已验证的子项不自动扩展到整条 D 编号。

- **执行边界**：沿用 `packages/compatibility-tests` 的 JSON、worker 和报告。TS 调用正常工作流、规则或请求宿主，替换不稳定边界；参考端用固定上游原代码、依赖或有明确出处的 Kotlin/JVM 编排。原 Android 仓库只读。设备、浏览器和公网可用性使用单独证据等级。全部离线测试可在普通 JDK/Maven/Node 环境运行。
- **证据分类**：分开记录 JDK 直接、上游源码、上游指导编排、Android 实测、TS 单端和缺证据。每个任务都要提交可运行的案例与结果，或者提交可重现的证据缺口。只有同输入双端执行且值、顺序、状态、后续请求均一致时标为一致。每例允许的异常映射必须精确，原始异常保留。
- **样本范围**：新集合原始 SHA-256 为 `0a1a4d9d7d628aab56893f7e6c298bf5eb4036740e72798cc4c4ce3a9962a58b`，15 条；排除「🎉起点中文网」后索引 14 条。「起点小说」作为独立条目保留索引，本轮仅保留元数据，因其同属 qidian.com 且原定义约 1.9 MB、需要宿主。对「文桑小说」保留与已有快照的 URL 关联及版本摘要。只收录当前任务实际使用且通过静态审查的规则或片段，保存来源、字段和摘要。用合成响应或脱敏响应测试，测试中不运行在线站点。
- **最小可交付**：第一批提交 A1、F1 和 A2，已有运行器立即可执行新来源的真实规则。单纯重跑全部旧测试可以验证当前版本回归，缺少旧问题与具体新证据的关联，因此本计划逐项记录映射。方案复用现有清单与执行入口，不增加测试包、服务或对外配置。
- **完成判定**：24 项都有可审查的交付物、判定及提交。真实宿主证据不具备时，F3 交付记录和执行协议，相关行为继续标为需宿主；F4 交付替代矩阵，有充分等价证据且符合删除授权才执行删减。B1 证据未达到条件时保留独立最小对照和待核实记录，停止产品改动。任何这些状态都单列在完成记录。

```text
快照与旧差异台账
   └─> 固定输入、响应、状态与预期
          ├─> 上游参考端 ─┐
          └─> TS 实际入口 ─┴─> 双端报告 ─> 对应台账条目
```

### 实施与验证

#### 1. 语料和证据底座

| 任务 | 实施位置与步骤 | 验收 |
| --- | --- | --- |
| **A1 固定新语料** | 在 `packages/compatibility-tests/corpus/` 新增 `yck-1298-manifest.json` 和已审查的选用定义。使用原响应摘要校验输入，记录每条索引、源 URL、原始规则摘要、选用或排除原因。在 `scripts/common.mjs` 扩展来源选择，沿用旧 manifest 作为默认，新增来源只读固定白名单。整源和字段片段校验原文。 | 15 条来源账目完整，起点中文明确排除，14 条索引含同 URL 版本记录。改一个选用规则字符、换错集合或错误摘要时，载入失败。原 Yiove 案例仍通过。 |
| **F1 重核 D1–D44** | 在 `docs/compatibility/status.md` 现有状态表登记 44 个原 ID，区分接口命名、过时文档、功能差异、仅缺双端证据和刻意保留差异。编号冲突时任务用 A1–F4，台账用 D 编号。 | 每个原 ID 可查到分支及当前状态。D1–D4 的接口和文档类单独分类；D8 等安全政策记录依据，已有 TS 测试的条目标为 TS 证据。 |

两项各自提交。已有测试可继续运行，后续各批次在同一个台账中更新证据。

#### 2. 真实书源流程

共享离线案例放在 `cases/flow-yck-1298.json`。TS 复用 `ts/book-flow.ts` 的请求轨迹、章节索引和阶段投影，JVM 复用 `BookFlow.kt`、`FlowRequest.kt` 与锁定解析器。每项加入至少一个使用原规则的正例和一个判别边界，输入和独立预期均来自夹具与上游行为。

| 任务 | 夹具和步骤 | 验收 |
| --- | --- | --- |
| **A2 思路客** | 原 URL 脚本先经 `java.ajax` 请求固定 HTML，再据其中变量生成 POST；POST 返回 `$.data.search`，两条不同 URL 的书、一个 `null` 可选字段和一个缺失可选字段；选第一条进入详情。另给空搜索数组。 | 记录请求体字节、候选顺序及字段投影。空列表按 Android 的实际回退分支执行或结束，额外请求必须可解释。关联 D20、D22。 |
| **A3 错层小说** | 保留 `text.下一@href` 与 `#linkNext@href`，目录两页各提供不同章，正文两页内容不同。第二例让正文下一页指向目录中的下一章。 | 目录两页按顺序，指定索引读取正确正文，终态和精确请求一致；第二例没有下一章请求。 |
| **A4 抖音小说** | 原 POST 搜索，目录和正文各两页，原 `:has` / `:contains` 选择器。第二例在分页尾部保留一个样式相似但文案不匹配的链接。 | 比较实际请求、规则筛选、目录顺序、正文合并，尾部无意外请求。关联 D18、D22。 |

#### 3. 请求与地址

JVM 纯请求行为放 `FlowRequest.kt`，JDK URL 成员复用现有 API 案例；TS 通过实际 `SourceRequestHost` 或 `source-request.ts`。比较点为传输边界，比较原始请求体 Base64、方法、完整 URL、案例声明的头、响应最终 URL，以及执行下一阶段的条件。

| 任务 | 夹具和步骤 | 验收 |
| --- | --- | --- |
| **B1 仅查询串相对地址** | 基准 `https://fixture.test/toc` 和 `https://fixture.test/toc/`，输入 `?page=2`、`?`、`toc?page=2`。先保留桌面 JDK/TS 结果，核对固定 Android `NetworkUtils.getAbsoluteURL` 及该平台使用的 URL 解析实现。优先复现可独立运行的 Android 解析代码；如依赖平台运行时，用固定 Android 版本的同输入产物。 | 有 Android 证据时按该证据处理 TS 差异并锁定回归；只有桌面 JDK 时发布三方矩阵中的缺证据状态，不据此改变 TS。关联 D22、D42。 |
| **B2 非 UTF-8** | 用合成 `charset=GBK` 请求规则，关键词“星 河+”，固定包含空格和加号的搜索 query 与表单 POST，另测不受支持字符集。JVM 执行原编码纯算法与对应 charset。 | 比较编码后的 URL、实际 body 字节、空格和加号区分；无有效编码器时单列明确能力结果。 |
| **B3 动态请求和重入** | 用固定 Rhino 和同一脚本验证请求头计算、bridge 子请求和 `bodyJs` 改写响应正文。原上游的 `bodyJs` 在收到响应后执行。夹具令首层与嵌套头各有可辨识的值，再设深层有界案例。沿用 TS 请求宿主和预算。 | 首层、嵌套的请求分别比较，动态脚本运行次数可查。平台无法证实的重入边界单列，安全预算按既定策略验证。关联 D9、D22。 |
| **B4 登录检查重取** | 初始 POST 的离线响应包含可识别的未登录标识；`loginCheckJs` 使用固定的虚构凭据头重取，第二响应为合法数据。另给重取失败结果。通过可注入传输记录两次方法、字节、头、最终 URL 和状态。 | 正常路径继续解析，失败路径按上游终态停止或保留结果。真实站点、Cookie 持久化和网页登录由 F3 单列。关联 D5、D22、D27。 |

#### 4. 解析器及规则组合

在 `cases/css.json`、`xpath.json`、`json.json`、`pattern-matcher.json` 或现有组合案例中追加最小输入，复用固定 Jsoup、Jayway 和 JDK Pattern。仅在产品行为差异可复现时改动 TS 解析器或规则引擎。

| 任务 | 增量测试 | 验收 |
| --- | --- | --- |
| **C1 Jsoup 选择器** | 表格片段中放有效行、缺属性行与同名属性重复行。对照 `:has/:not/:eq`、缺失属性和多 class token，保留节点顺序。 | 选择结果、提取及去重与上游一致，关联 D18。 |
| **C2 HTML 与 XPath 投影** | 同一 DOM 含内联节点、`br`、NBSP、`pre` 和脚本，分别执行 `text/ownText/html` 与 XPath 的元素、属性、`text()`。 | 比较投影原值、换行及去掉脚本的行为；仅对历史已经明确的展示差异按具体路径登记。关联 D19。 |
| **C3 Jayway 值与聚合** | 同组 JSON 含缺失、显式 null、空列表、数字字符串。执行实际用到的过滤和 `sum/avg`，关联 A2 的真实规则与 API 复现。 | 类型、顺序、合计的字符串形态、空值和失败后是否继续均一致。关联 D20。 |
| **C4 Pattern 与 Matcher** | 复查现有局部标志、捕获组和零宽替换证据，补一个混合局部标志与捕获组案例，以及 `CANON_EQ` 与非法标志的区分。 | JDK 与 TS 的支持能力或差异分类明确。受控正则的安全预算继续有独立断言。关联 D21。 |

#### 5. JS 状态、生命周期和二进制

优先复用 `CorpusRules.kt`、固定 Rhino、`ts/adapter.ts` 和实际 bridge。只有现有操作无法表达真实输入与输出时增加 operation，并同步 schema。TS 文件、网络和存储测试使用受控响应、内存状态或临时目录。

| 任务 | 增量测试 | 验收 |
| --- | --- | --- |
| **D1 AnalyzeRule 重载** | 同一节点含 HTML 实体和相对 URL；分别走 `getString(rule, boolean)`、空内容回退、URL 模式和 `getStringList`，同时保留原始类型和顺序。 | 布尔参数、null 回退及 URL 化不串用，关联 D23。 |
| **D2 返回对象后续调用** | 按 Map、List、节点、StrResponse 各建一例，分别验证缺键及插入、顺序和索引、节点再次选取、重复 Header 的读取和响应 body。 | 脚本可以按目标签名使用结果，不能以返回字符串或仅检查方法存在代替。关联 D24、D34。 |
| **D3 jsLib 作用域** | 「魔丸小说」的详情/目录调用 `Api` 与 `formatDate`。先核对函数依赖，取可隔离的原始 `formatDate` 片段配固定时间与时区；合成计数库独立验证同源调用两次、切源、刷新以及重新调用。原片段和合成状态证据分开。 | 真实函数输入输出一致；计数案例能检测状态丢失、串源及刷新残留。库若包含必须执行的宿主依赖，记录原片段阻塞并保留计数双端验收。关联 D39。 |
| **D4 缓存与变量** | 在两个源中使用相同键，依次写入空字符串、字节、覆盖及删除，再从同源快照恢复。缓存键与变量键分别断言。 | 同源状态与版本恢复符合已核定契约，跨源无泄漏，缺失和空值可区分。关联 D26、D28。 |
| **E1 subContent 取消** | 主正文成功，副内容请求开始后通过受控信号取消；另给主正文阶段取消和副内容普通失败。TS 使用实际正文入口，JVM 按固定 `BookContent` 的调用顺序与取消边界执行。 | 记录主正文是否交付、诊断、终态以及活动请求归零，区分取消和普通失败。关联 D11。 |
| **E2 封面解密 InputStream** | 用固定字节和空输入，调用单字节、缓冲区带偏移读取，脚本返回流并用跟踪包装观察关闭；另测抛错后的关闭。 | 读取值、EOF、返回 bytes 与关闭次数一致，关联 D12。 |
| **E3 下载与归档字符集** | 同一受控下载重定向到固定 ZIP，UTF-8 与有 BOM 的文本各一份，另外提供不存在条目与损坏 ZIP。保留认证继承与传输失败输出，测试使用虚构头及临时目录。 | 比较请求、正文、缺失和损坏时的终态，并核对文件清理。关联 D30。 |
| **E4 历史加密与工厂状态** | 固定 key、IV 和明文，对照 legacy AES 解码方向与 Base64 文本字节；同一脚本对工厂调用两次并更改 IV，再检查密文和解密结果。 | 用固定向量验证真实返回字节、类型和状态；依赖 provider 的缺项按实际环境报告。关联 D32、D33。 |

#### 6. 证据收口与旧测试

| 任务 | 实施步骤 | 验收 |
| --- | --- | --- |
| **F2 逐项关联证据** | 随每一项更新既有 `status.md`、`known-divergences.md` 或包内 `coverage.json` 各自负责的事实。逐条关联问题编号、分支、参考版本和案例 ID。执行器输出留在 `output/`，计划保存报告位置。 | 可追溯到一次实际运行。仅 TS、缺参考、已确认差异和双端通过有不同状态。 |
| **F3 宿主证据协议** | 在 `docs/compatibility/conformance-tests.md` 增加 WebView、验证码、真实登录、设备值、跨进程状态取证表，列输入、Android 版本、可见输出、采集限制及导回离线报告的方法。 | 无设备时仍可验收取证协议。真实平台行为继续标明缺证据，账号数据和凭据从产物排除。 |
| **F4 旧断言映射** | 从上一轮已记录的 `HTML-FLOW-001`、`JSON-FLOW-001`、`JS-TOC-001` 开始，逐断言列新案例和原独有断言。只有等价覆盖、受影响回归和删除授权齐备才分批移除完全重复的测试。 | 各条可判定为可替代、部分替代或保留；安全、取消、资源释放和历史缺陷断言有明确归属。移除后复跑旧入口及双端套件。 |

### 提交与验收

- 顺序为 **A1 → F1 → A2/A3/A4 → B1–B4 → C1–C4 → D1–D4 → E1–E4 → F2 汇总、F3、F4**。F2 的逐项证据随对应任务提交。B1 缺 Android 证据时，先提交可复现记录并继续其余工作。每项提交已通过的机制、案例或证据；确认的产品差异按根因单独提交 `fix(<包>): <行为>`，保留修复前报告与修复后验证。旧测试删减使用单独提交。
- 各批次以固定输入与独立预期核对真实双端输出，记录原始差异。预期不从 TS 或 JVM 实际输出生成。报告分别计数 API、完整流程、阶段、内部观察和宿主证据。请求缺失、预算、超时、能力缺失与业务失败分开。CLI 退出码保持现有契约。
- 最终每个 ID 都有结论，基线持续通过。新增离线套件复跑两次，核对逐例结果、请求、状态和证据摘要，忽略运行时间与目录身份。所有源规则及脱敏响应均可复核来源。旧能力台账应能辨识本轮确认差异和未验证边界。

在仓库根目录串行执行 JVM 及双端检查。测试文件改动后先跑相关单测，再执行完整门槛：

```sh
node packages/compatibility-tests/scripts/prepare-jvm.mjs
node --test packages/compatibility-tests/tests/*.test.mjs
node packages/compatibility-tests/scripts/run.mjs --family flow
node packages/compatibility-tests/scripts/run.mjs
node packages/compatibility-tests/scripts/run.mjs --family flow
pnpm --config.verifyDepsBeforeRun=false run test:source
pnpm --config.verifyDepsBeforeRun=false run typecheck
pnpm --config.verifyDepsBeforeRun=false run test
pnpm --config.verifyDepsBeforeRun=false run build
git diff --check
```

### 风险与回滚

- 最大风险是把桌面 JDK 或 Kotlin 编排当成 Android 实测。以证据类型和方法出处限制判定，优先保留最小原算法。Android 运行库、版本或实际宿主不可取得时，按任务记录缺口；已验证阶段可继续交付。
- 新集合约 2 MB，包含大量脚本。先静态审查选用片段，检查是否携带凭据、设备或网络访问、写入动作以及分发条件。原集合暂存只用于取证；无固定可提交来源时，提交摘要、公开来源位置和自制夹具，具体真实样本标为缺持久证据。离线运行只开放案例声明的 bridge 和网络响应。
- 不引入第三方账号、密钥或新生产服务。当前已核对新集合暂存响应、原仓库提交与测试包入口；实施沿用已通过的 JDK 21、Maven 与 pnpm 环境。现有仓库网络夹具需要本机环回端口。
- 预计涉及超过 8 个文件。首批语料、台账与第一条流程预计 2–4 个工作日，后续每组约 2–4 个工作日，复杂修复及外部取证单列。按逆序回退各任务提交，无部署或数据迁移。

## 完成记录

- A1 `eaee1d5` 固定来源索引、3 条选用原定义及来源校验；[原流程基线](../packages/compatibility-tests/output/run-7jCG4E/report.md)通过。
- F1 `11dbd41` 为 D1–D44 逐项登记复测分类。
- A2 `fbf4037` 增加思路客正常和空结果案例。[修复前](../packages/compatibility-tests/output/run-bGqJlc/report.md)显示默认 UTF-8 表单编码耗尽宿主桥接预算；`7dac5d7` 单独修复，[修复后 22/22](../packages/compatibility-tests/output/run-BnD3O7/report.md)。
- A3 `0dbcc31` 增加错层小说目录与正文双分页、下一章停止用例，[24/24](../packages/compatibility-tests/output/run-CxKhk2/report.md)。
- A4 增加抖音小说 POST、两个分页及尾部不匹配链接用例，[26/26](../packages/compatibility-tests/output/run-FTlpEm/report.md)。

- B1 从 [Android 15 libcore 固定版本](https://android.googlesource.com/platform/libcore/+/refs/tags/android-15.0.0_r1/ojluni/src/main/java/java/net/URLStreamHandler.java) 取证，源码 SHA-256 为 `eeaff8bfe6a809c67e973dd356deadc28949e554cc390f24eaa6916c6a18490e`。用桌面 JDK 的自定义 URL handler 原样执行该文件的 `parseURL` 方法，单列 Android 原方法证据。基准 `/toc` 下 Android 保留 `/toc?page=2` 与 `/toc?`，桌面 JDK 得到 `/?page=2` 与 `/?`；基准 `/toc/` 下两端保留相同路径。普通 `toc?page=2` 分别得到 `/toc?page=2` 与 `/toc/toc?page=2`，两端一致。该取证未执行 Android 应用。
- B1 的 [修复前报告](../packages/compatibility-tests/output/run-Kd83M2/report.md) 显示 TS 只在显式空查询时丢掉 `?`，导致目录第二页被识别为已访问。修复 `d784fec` 单独提交，六个 `flow.synthetic.android15-query.*` 及 [32/32 流程对照](../packages/compatibility-tests/output/run-7Kqd9M/report.md) 通过。

- B2 的 `flow.synthetic.gbk.get/post` 验证“星 河+”的 query、表单和请求体 Base64；未知字符集分别验证 JVM 未支持和 TS 能力缺失且无请求。[34/34 流程对照](../packages/compatibility-tests/output/run-rW2eNu/report.md)，32 条机制及参考端测试通过。

- B3 的 `flow.synthetic.dynamic-body.*` 验证动态 Header、bridge 子请求与 `bodyJs` 响应改写，[36/36 流程](../packages/compatibility-tests/output/run-HBb8Br/report.md)。另执行现有 TS 深层重入限界测试。更深层的 Android 比较证据单列。

- B4 `flow.synthetic.login-check.*` 验证两次 POST 的同 URL、同字节请求体、头变化、401→200/503 及详情继续条件。原样返回正常 StrResponse 的序列化问题由 `fa4a886` 单独修复，[修复前](../packages/compatibility-tests/output/run-QleLG9/report.md)及[修复后 38/38](../packages/compatibility-tests/output/run-tOeBHb/report.md)。

- C1 `97e3d70` 验证表格选择器及缺失/重复属性，[CSS 报告](../packages/compatibility-tests/output/run-iGHdnL/report.md)。
- C2 验证混合 DOM 的文本与 XPath。原始 `@html` 的 `br` 前换行有精确差异，`flow.synthetic.html-br.display` 验证该输入直接进入正文时结果相同；脚本或正则直接消费序列化字符串未取得等价证据。[正文](../packages/compatibility-tests/output/run-nv7JZd/report.md) · [CSS](../packages/compatibility-tests/output/run-KweGbX/report.md) · [XPath](../packages/compatibility-tests/output/run-MsOROm/report.md)。

- C3 `dcac0bb` 验证 Jayway 过滤、sum/avg 文本和空值后继续；`53d4863` 单独修复 avg 整数丢失小数位，[JSON 报告](../packages/compatibility-tests/output/run-7yh8qE/report.md)。
- C4 混合局部标志复现命名组编译失败，修复后组名和值一致，[Pattern 报告](../packages/compatibility-tests/output/run-jBXv5a/report.md)。CANON_EQ 继续返回明确能力缺失。

- D1 的 `rule.bridgeString.batch-*` 验证布尔重载、null 回退、首项 URL 和 URL 列表；产品修复使 HTML URL 字符串重载遵循上游 getString0。[修复前](../packages/compatibility-tests/output/run-4ppvuI/report.md)与[复验](../packages/compatibility-tests/output/run-36Hp2E/report.md)。

- D2 的 `rule.bridgeObjects.batch-*` 验证 JDK Map/List、固定上游 Jsoup 节点和原始 StrResponse 配固定 OkHttp 的后续方法调用。规则桥接族 [6/6 一致](../packages/compatibility-tests/output/run-bZpber/report.md)，机制与参考协议 32/32。覆盖范围限于该组具体方法和返回值。

- D3 固定 YCK 魔丸小说 `jsLib.formatDate` 的原文位置与摘要，UTC 下对照默认格式、自定义格式和非法输入。原样执行 `ScriptBindings.kt` 和 `ConcurrentNativeObject.java`，验证同源累加、切源隔离与刷新复位。相同库的跨源刷新由 `rule.scriptLibrary.batch-peer-refresh` 精确记录 Android 清零而 TS 保持隔离的差异。[两例一致、一例允许差异](../packages/compatibility-tests/output/run-CCqbkI/report.md)。

- D4 `rule.sourceState.batch-*` 比较普通缓存、字节、变量及源键值的缺失、空值、覆盖、删除与恢复。Node 实际序列化并恢复会话快照，JVM 按 CacheManager 和 BaseSource 原键语义使用内存存储。原始对照复现缺失缓存读取返回 undefined，`fdc5211` 修复为 null。[修复前](../packages/compatibility-tests/output/run-GzGgcO/report.md) · [一例一致、一例允许差异](../packages/compatibility-tests/output/run-hghUH4/report.md)。CacheManager 定向回归 5/5，应用级缓存和 Node 默认会话隔离差异精确登记。

- E1 `flow.synthetic.content-lifecycle.*` 验证主正文请求取消、歌词请求取消和普通失败。TS 夹具等待实际请求预算的 AbortSignal，JVM 用固定上游同版本 Kotlin 协程按 WebBook/BookContent 调用顺序执行。主正文取消和普通副文失败一致；副文取消时参考函数尝试标题但外层 Deferred 不交付正文，TS 在标题前返回取消，精确登记该路径差异。[流程 42 例，41 一致、1 项允许差异](../packages/compatibility-tests/output/run-A4g1ky/report.md)。

- E2 `rule.coverStream.batch-*` 由固定 Rhino 和 JDK ByteArrayInputStream 与实际 TS `decodeImage` 执行同一脚本。验证单字节、偏移缓冲区、空输入 EOF、输出字节与正常或异常的脚本 close。Android 参考按 ImageUtils 将脚本 ByteArray 包成输出流，TS 直接交付字节。原始下载流和 Glide 清理未在此验证。[封面流 3/3 一致](../packages/compatibility-tests/output/run-9bk8hH/report.md)，既有封面回归 9/9，类型检查通过。

- E3 从固定 JsExtensions 原样提取 ZIP 条目循环，使用同一上游 ICU 实现探测原始字节。TS 经真实 Node 会话和文件脚本入口访问受控传输，断言 GET、虚构认证、允许重定向、最终地址与目录无残留；文件宿主专项另验证部分写入后失败/取消的清理。BOM 和缺条目分别由 `a25dce5`、`dc57a10` 修复。[修复前](../packages/compatibility-tests/output/run-OiLxGh/report.md) · [5/5 一致](../packages/compatibility-tests/output/run-sO4wNF/report.md)。重定向在传输边界模拟，未执行真实 HTTP 或 Android 应用。

- E4 原样提取 JsEncodeUtils 的历史 AES 和工厂方法，编译原始 SymmetricCryptoAndroid 与固定 Hutool 5.8.22、BC 1.85.2。独立 OpenSSL 向量验证解密方向、Base64 文本 bytes、同对象更新 IV、另一个对象保持初始状态及解密回读。[两例一致](../packages/compatibility-tests/output/run-iC8onq/report.md)。仅用默认桌面 provider 时参考端出现 InvalidKeyException，锁定上游 provider 后消失；其他模式和 provider 单列。

- F2 核对 D1–D44 的历史行及本批分类，按可执行分支关联稳定案例 ID、参考文件和任务报告。已比较的范围限于对应案例；真实宿主、仅 TS、计划外枚举和已确认差异保留独立状态。Android 基线与原算法、编排和依赖类型由 `reference-sources.json` 及实际报告记录。

- F3 [真实 Android 宿主取证协议](../docs/compatibility/conformance-tests.md#真实-android-宿主取证) 列出五类宿主边界、固定输入、版本、可观察输出、脱敏和离线导入方法。用空产物目录验证 preflight 与 `--require-android` 均返回退出码 2，现有六例保持 `not-run`。未执行设备采集。


- F4 复验 `source-cross-runtime.test.ts` 的六个 manifest 案例。以下三条旧夹具均保留，保留理由按原断言拆分。

| 旧夹具 | 旧断言 | 本批复核与迁移判定 |
| --- | --- | --- |
| `HTML-FLOW-001` | 搜索书名、作者、详情 URL；详情书名、作者、独立目录 URL；目录标题、章节 URL；四次请求顺序 | `flow.yiove.html.success` 双端验证对应契约，但源与原规则不同。旧输入及其精确字段投影仍保留。 |
| `HTML-FLOW-001` | `contentType: html`、原响应清洗后的精确正文 | 新流程验证正文展示，`flow.synthetic.html-br.display` 额外覆盖换行。原 fixture 的 HTML 类型、选择器及清洗产物无同输入替代。 |
| `JSON-FLOW-001` | 搜索与详情字段、JSONPath 目录筛选、顺序及 VIP 标记 | `flow.synthetic.json.page-end` 复用同组规则，行为层可替代；旧地址和响应身份仍由旧 fixture 验证。 |
| `JSON-FLOW-001` | `contentType: text`、两页原始 `pages` 数组和五次精确请求 | `flow.synthetic.json.*` 对照页数、合并正文和停止条件。原类型、逐页内容及原地址仍保留。 |
| `JS-TOC-001` | 整源 JS 函数返回卷节点、普通章节、VIP 与购买字段 | `flow.yiove.js.*` 对照声明式目录脚本。整源函数、卷身份及购买字段仍只由旧 fixture 验证。 |
| `JS-TOC-001` | 正文接收下一章地址、类型为 text、清洗内容与零请求 | `flow.yck.cuoceng.next-chapter` 对照声明式下一章停止，仍需保留整源函数参数与完全不发网络请求的断言。 |
| 三条共有 | 可导入书源、工作流终态和活动请求归零 | 新双端案例对照终态，E1 单独验证取消释放。保留旧输入的导入及逐例资源断言，原路径越权、清理和历史缺陷的 Node 回归也继续执行。 |


### 最终批次验收

24 项均有独立任务提交或对应的差异判定。

| 阶段 | 任务提交 |
| --- | --- |
| A | A1 `eaee1d5` · A2 `fbf4037` · A3 `0dbcc31` · A4 `3c210eb` |
| B | B1 `ffad8de` · B2 `ac32507` · B3 `8e93665` · B4 `e27637d` |
| C | C1 `97e3d70` · C2 `13ebc41` · C3 `dcac0bb` · C4 `cd75cd7` |
| D | D1 `2f58c4a` · D2 `0396ecc` · D3 `0226991`、`2419872` · D4 `b89214c` |
| E | E1 `85b62c0` · E2 `3830115` · E3 `a0af31c`、`f6aee8a` · E4 `9e6bb70` |
| F | F1 `11dbd41` · F2 `307bbe2` · F3 `e0196ed` · F4 `8749da5` |

- [全量双端报告](../packages/compatibility-tests/output/run-LgkZvM/report.md) 共 564 例。基础 API 520 例，517 一致、3 例允许差异；离线流程 42 例，41 一致、1 例允许差异，其中完整流程 25 例、阶段 17 例；另有 2 个未支持的参考内部观察。无未登记差异和执行失败。
- 两次离线流程 [第一次](../packages/compatibility-tests/output/run-1Npvc5/report.md) · [第二次](../packages/compatibility-tests/output/run-MOGGSV/report.md) 的 JVM 与 TS 逐例结果和报告案例完全一致。比较保留请求、状态和引用，仅排除运行元数据。
- JDK 21 参考准备、机制测试 32/32、书源专项 207/207、根回归 700/700、类型检查、构建和 `git diff --check` 均通过。按原计划使用本机环回端口运行 HTTP 夹具。上游 Android 参考源码与锁定依赖路径保持只读。
- Android 应用和真实设备的结果仍按 F3 取证。差异台账保留未核实的 HTML 序列化下游影响、ZIP 逐条枚举、其他 provider，以及逐项声明的宿主和隔离边界。F4 三个旧夹具保留，现有 Android 旧入口缺产物仍为 `not-run`。

## 变更记录

- 2026-11-07 建立 24 项任务草稿，明确取证条件、提交边界和回归门槛。

## 批准记录

2026-11-07 用户批准实施，并要求按阶段和任务提交。
