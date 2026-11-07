# 书源离线流程双端兼容测试

- 状态：approved
- 创建：2026-11-07
- 更新：2026-11-07
- 基线：legado-ts `9dcfd9a`，Android 参考提交 `32a87b253e7cc28273c3850de86242caac83f1fd`

## 方案

### 目标、范围与决策

在独立的 `packages/compatibility-tests` 中增加书源离线流程对照。两端读取同一份书源定义、搜索输入和固定响应，实际执行同一本书的搜索、详情、目录与正文。阶段之间传递本端执行产生的数据，比较结果、顺序、请求和继续或停止行为。第一阶段先交付一条来自现有快照的 HTML 流程，再扩展 JSON 分页和真实目录脚本。基础 API 用例由流程差异驱动，每个新用例要能单独复现一个已经定位的语义问题。

上一阶段有 484 条基础契约用例通过，另有 2 条参考端观察。这个分母继续单列。现有 `source-cross-runtime.test.ts` 已经能调用 TS 的真实工作流及 Node 宿主，但其旧夹具声明 Android `not-run`。本计划复用宿主接线和可用的响应素材，由现有双端执行器独立执行和比较。

- **样本**：首选固定快照中的「言情小说阁」。它有独立目录地址、相对链接、CSS 和正文替换，且无需登录。用规则原文和自制 HTML，不访问站点。JSON 分页用 `JSON-FLOW-001` 作素材，明确标为合成样本。目录脚本选同一快照中的「奇怪小说」，使用完整脚本原文。当前无需提供更多书源。
- **TS 执行端**：从 `source-core/src/index.ts` 调用 `importSources`、`searchBooks`、`loadBookDetails`、`loadTableOfContents` 和 `loadChapterContent`，使用 Node 的 `SourceRequestHost`、`SourceRuleHost`、每例独立的内存 Cookie 存储和离线 `NetworkHost`。替换点只在传输边界。
- **JVM 参考端**：继续使用纯 JDK 21、Maven、Kotlin/JVM、固定提交的原解析器及同一 Rhino。保留源码摘要，能独立编译的纯行为优先复用或从固定提交原样提取。应用层的最小流程由 Kotlin 驱动，逐段标记哪些算法执行原源码、哪些分支根据上游实现编排。参考 `BookList.kt`、`BookInfo.kt`、`BookChapterList.kt`、`BookContent.kt`、`WebBook.kt` 与用到的 URL、格式化代码。报告将这类证据单列为“固定上游解析器 + Kotlin 离线编排”，应用入口的设备验证另计。
- **最小交付**：阶段 A 本身即可使用。继续把 HTML 或 JSON 夹具只送入 TS 执行，改动较小，但无法发现 JVM 和 TS 的行为差异。直接移植 Android 应用依赖会突破纯 JVM 约束，且会放大参考端适配范围。
- **范围边界**：原 Android Git 仓库只读，所有测试与适配保存在 TS 仓库。设备、Android SDK、在线站点、动态登录、WebView、验证码、文件读写、并发分页与跨阶段脚本持久化属于独立验证范围。本计划只交付旧测试覆盖映射，删除由后续单独执行。

### 共享协议与比较规则

```text
固定书源、输入和响应
   ├─> Kotlin/JVM 参考端 ─┐
   └─> TS 真实运行时 ─────┴─> 现有比较器和报告
```

1. 新增 `family: flow`、`operation: flow.book`，以现有案例文件和 worker 协议传输。每例包含 `source`、`keyword`、`responses` 和固定的最大发出请求数。书源导入后取首个结果，再取首个章节，夹具排列使二者的身份可断言。缺少目标时按阶段终态停止。真实来源按书源 URL 精确选取原快照对象，案例加载校验原对象及快照摘要，报告记录涉及的规则字段。合成素材复制到新案例时记录原 fixture ID 和相对路径，旧 fixture 继续运行。
2. 响应由请求方法、完整 URL（保留 query）和请求体精确匹配，响应包含状态、最终 URL、头和字节内容。本轮响应统一 UTF-8。请求轨迹按实际发出顺序保存阶段、方法、完整 URL、请求体及案例声明的书源请求头，比较头名称时统一小写。未声明的宿主默认头不进入比较。缺响应、请求重复超限和越过预算都报告执行失败，离线宿主记录该错误并在流程结束时核验，避免被业务代码捕获后误报通过。每端每例隔离，保持现有 worker 超时；网络访问不会从夹具回退到真实宿主。
3. 按阶段输出 `status` 和约定字段。搜索保存有序候选及 URL，详情保存元数据和目录 URL，目录保存有序章节及可观测标记，正文保存标题、有效分页、最终正文和停止后的请求轨迹。必需字段、空数组、空串、null、缺失、阶段顺序及数组顺序精确比较。请求消费完毕后校验真实选中书和章节，避免同值夹具掩盖传递错误。结果投影由各端基于实际值生成，执行器不读取 `expected`。
4. 空结果、业务失败和执行器故障分开。业务失败比对失败阶段、语义类别、可见结果和后续请求。例外只允许逐例映射原始异常类型或文案，双方原始异常和字段差异保留在产物内。缺证据、缺能力、超时和意外请求不能进入允许差异。已有逐字段 diff、输入/实现摘要校验和退出码继续使用；报告增加独立流程计数，基础方法覆盖的分母及原有两条观察不变。
5. 在 `reference-sources.json` 和 JVM 流程文件注释中记录实际执行的上游文件/符号及摘要，以及每个手工编排分支对应的固定源码。优先覆盖可以核对的分支。例如 `BookInfo.analyzeBookInfo` 的目录 URL 选择、`BookList.analyzeBookList` 的列表为空时尝试详情、`BookContent.analyzeContent` 的下一章停止和空正文异常。JVM 编排如果遇到声明范围外的规则或分支，显式返回 unsupported，阻止该案例验收。

### 实施与验证

每阶段以一个可独立验证的测试能力结束。发生产品差异时，先在本阶段确认参考行为和实际 TS 差异，按根因增加最小复现及修复，一个根因一个提交，保留最终流程案例。发现夹具或适配错误时，修正参考或夹具并复验，产品改动须有独立证据。

| 阶段 | 文件及工作 | 通过条件 | 提交顺序 |
| --- | --- | --- | --- |
| A. HTML 离线流程 | `schema/operations.json`、生成的案例 schema、`scripts/common.mjs`、`scripts/run.mjs`、比较器及机制测试；`ts/adapter.ts` 加入流程入口，流程实现独立置于 `ts/book-flow.ts`；`compat/Main.kt` 分派到 `compat/BookFlow.kt`，登记上游证据；新增 `cases/flow-html.json` | 三个案例通过，严格匹配请求，报告能指出第一个差异阶段和 JSON 路径；缺夹具会报告执行器失败 | `test(compatibility): 增加 HTML 书源离线流程对照`；如有缺陷，先在本阶段把复现与修复按根因拆分，再启用整阶段验收 |
| B. JSON 正文分页 | 增加 `cases/flow-json.json`，基于旧 `JSON-FLOW-001` 的合成规则保留过滤、顺序、VIP；复用已固定的 JSONPath 解析器扩展 JVM 已声明分支 | 两个正文页按顺序拼接。分别验证没有下一页、下一页指向下一章、下一页重复三种停止原因及精确请求；下一章地址通过现有 `nextChapterUrlFor` 从本端目录结果取得并传入正文入口 | `test(compatibility): 覆盖 JSON 正文分页与停止条件`，如有缺陷先按根因修复 |
| C. 真实 JS 目录与验收 | 增加 `cases/flow-js.json`，复用 `CorpusRules.kt` 的固定 Rhino 与安全作用域，流程边界保留可继续解析的节点身份；更新包 README 和已有兼容测试文档入口，汇总旧夹具映射 | 两种目录结构的脚本分支行为一致，目录仅含完整目录项且顺序一致，正文请求来自脚本保留的章节；全量回归通过，记录每项旧断言的替代证据 | `test(compatibility): 对照真实书源的目录脚本与正文选择`，如有缺陷先按根因修复；`docs(compatibility): 记录离线流程证据与旧夹具映射` |

#### 案例和独立断言

- `flow.yiove.html.success`：关键词“离线样书”，搜索表保留两条结果，首条用 `/book/123456.html` 命中源规则的封面替换。详情使用原规则所需的 meta 字段，提供与书籍地址不同的 `/book/123456/toc/`。目录两章的链接用 `1.html`、`2.html`，正文只访问第一章。正文包含两段自制文字与替换规则所需的四连空格实体，独立断言有序字段、精确正文、清洗结果和四次请求。目标正文以固定源码格式化结果核定，避免用 TS 结果生成预期。
- `flow.yiove.html.search-empty`：同样的搜索请求只返回表头，且没有可供详情回退的书名字段。独立断言搜索合法为空、没有后续阶段请求。
- `flow.yiove.html.content-empty`：前三阶段同成功案例，第一章正文节点存在但内容为空。断言正文业务失败、失败类别及没有尝试下一章。夹具传输正常，执行器故障由机制测试另行覆盖。
- `flow.synthetic.json.page-end`、`flow.synthetic.json.next-chapter`、`flow.synthetic.json.repeated-page`：把旧夹具中的后续正文放到 `/book/1/chapter/1?page=2`，与目录第二章 `/book/1/chapter/2` 分开。三例均只允许五次请求，保留“正文一”“正文二”，第二页分别无下一页、指向下一章、指向自身。保留旧夹具原有的过滤与 VIP 断言；新案例独立核定 Android 参考的分页终止与拼接语义。
- `flow.yiove.js.full-toc`、`flow.yiove.js.no-full-toc`：目录 HTML 用同一个 `dl` 的 `dt/dd` 表示“最新章节”和“全部章节”。成功例包含两组，断言排除最新组、保留全量组的原顺序、从第一条保留项读取正文。另一例仅有最新组，断言空目录对应的上游业务终态以及无正文请求。脚本按固定原文执行，结果节点交给原章节字段规则。
- 机制测试额外验证 URL 查询不同会查找失败、重复请求预算会中止、失败被业务层捕获仍报告执行失败、相同输入连续执行不共享宿主状态、篡改任一阶段值或请求顺序会生成差异。负向机制用例检查退出码，避免依赖人工阅读报告。

#### 运行命令与验收记录

阶段内串行准备 JVM，避免同时写入构建目录。从仓库根目录执行：

```sh
node packages/compatibility-tests/scripts/prepare-jvm.mjs
node --test packages/compatibility-tests/tests/*.test.mjs
node packages/compatibility-tests/scripts/run.mjs --family flow
node packages/compatibility-tests/scripts/run.mjs --case flow.yiove.html.success
node packages/compatibility-tests/scripts/run.mjs
pnpm --config.verifyDepsBeforeRun=false run test:source
pnpm --config.verifyDepsBeforeRun=false run typecheck
pnpm --config.verifyDepsBeforeRun=false run test
pnpm --config.verifyDepsBeforeRun=false run build
git diff --check
```

- A/B/C 各次运行分别有 3、6、8 条流程案例，全部达到行为一致，独立预期断言通过，无差异、未支持或执行失败。最终重复运行流程，核对两次语义结果与请求轨迹一致，运行时间和目录身份单独记录。
- 最终基础用例至少保持原有 484 条契约一致和 2 条参考端观察；增加的基础回归单列。记录 JVM/TS 版本、产物路径、固定上游身份、原始差异和等价映射。根测试若因受限环境的环回端口失败，独立复验并注明实际执行条件。
- 实施记录附旧 `HTML-FLOW-001`、`JSON-FLOW-001`、`JS-TOC-001` 逐断言映射，区分完全替代、部分替代和保留。例如取消、资源关闭、安全约束及没有等价证据的异常仍由旧测试验证。新增外部书源的触发条件是已存在无法由当前样本覆盖的具体规则分支，或实际发现 Android 成功而 TS 失败。

### 风险与回滚

- 主要风险是 JVM 编排与 Android 应用实际顺序发生偏离。控制流由固定源码定位，关键分支附独立断言；如果一个行为必须依赖 Android 宿主且无法保持可核对语义，停止该阶段的验收，保留已通过阶段和具体阻塞证据。不得通过用 TS 生成参考或扩大允许差异来关闭阻塞。
- 固定响应在测试阶段没有第三方账号、凭证或站点依赖。首次构建沿用已有 Maven Central 依赖，使用现有缓存策略。只读核对确认本机存在 Node 26.12.1、Maven 3.9.9、JDK 21.0.4（现有脚本选取的 JBR）以及上游提交。直接执行 `mvn -v` 默认显示 Java 8，构建沿用准备脚本选定的 JDK 21。规划阶段未重建或执行新用例。
- 预计涉及超过 8 个文件，集中在现有测试包、文档和按实证定位的 TS 缺陷文件；无新服务或对外配置。预计 A 为 1–2 个工作日，B/C 各约 1 个工作日，发现独立兼容缺陷时按根因单独估算。
- 提交按阶段和根因拆分。若要回退，按逆序回退相关提交；夹具、测试适配及产物均无数据迁移。原 Android 仓库、线上书源及用户数据不会发生写入。

## 完成记录

规划草稿。执行和验收记录在实施后追加。

## 变更记录

- 2026-11-07 建立 HTML、JSON 分页、真实脚本三阶段草稿，基于固定书源快照、当前双端包、旧流程夹具和固定上游源码。

## 批准记录

2026-11-07 用户要求开始实施，并按阶段和任务提交。
