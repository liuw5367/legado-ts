# 书源请求、目录与脚本状态兼容验证

- 状态：completed
- 创建：2026-11-07
- 更新：2026-11-07
- 基线：legado-ts `96b6ecb`，Android `32a87b253e7cc28273c3850de86242caac83f1fd`

## 方案

### 目标、范围与决策

沿用独立的 `packages/compatibility-tests`，从现有 484 个基础契约、2 个参考观察和 8 个离线流程案例扩展到请求、目录与书籍变量。前三阶段各加入 4 个流程或阶段案例，最终共有 20 个流程类案例。按固定上游行为确认差异，按根因修复，保留最小回归与完整流程。旧测试及历史观察继续运行。

- **样本**：现有快照即可执行。请求用「顶点小说」「得奇小说网」的原始定义，目录和跨阶段写入用自制响应与合成规则。原始目录脚本取自「穿越小说🎃」，以阶段入口验证。标明真实规则和合成响应的来源，真实案例整源定义校验快照摘要，片段案例额外校验字段原文。外部样本只在发现明确缺失分支或拿到 Android 成功、TS 失败的复现时加入。
- **执行**：保留 TS 的正常入口和 Node 规则、请求宿主，只替换传输。Kotlin/JVM 继续使用固定提交的解析器、Rhino 及可独立编译的纯方法。请求和目录编排中有应用依赖的部分，按固定上游方法、分支和输入标注来源。使用 Git 只读读取上游，Android 仓库、依赖清单和用户数据无写入。
- **证据边界**：参考端支持不足记为 unsupported，夹具未命中或超限记为执行器失败，JVM 与 TS 真实输出不一致记为行为差异。当前阶段收录的案例必须完成验证。设备、WebView、在线登录、验证码、真实 Cookie 跨域策略、并发分页、跨进程持久化和整源 JS 继续单列。纯 JVM 分支无需 Android SDK。
- **最小交付**：阶段 A 独立交付两种 POST 与 HTML 正文分页。仅增加更多普通 GET/HTML 样本可以扩大语料数量，但无法触及当前参考端的请求边界。这里先扩展既有 worker 和案例协议，继续使用同一条 CLI 和报告，不建新的测试包或服务。
- **已有能力与待验差异**：TS 已有表单请求、目录分页和变量相关测试。新增双端用例用于确认 Android 同输入行为。广泛改动只有在独立复现同一根因时才进入本轮。

```text
固定书源、关键词、响应和初始状态
   ├─> Kotlin/JVM 原算法与可追溯编排 ─┐
   └─> TS 真实请求与流程入口 ──────────┴─> 现有逐字段比较与报告
```

### 实施与验证

#### A. POST 搜索与 HTML 串行正文分页

**实施位置**为 `jvm/src/main/kotlin/compat/BookFlow.kt`、新建 `FlowRequest.kt`、`ts/book-flow.ts`、`scripts/common.mjs`、`schema/operations.json` 和 `cases/flow-request-html.json`。用现有 `reference-sources.json` 锁定 `AnalyzeUrl.kt`、`UrlOption` 及 URL 解析和编码所依赖的纯函数。参考按固定代码的 URL options 分隔、关键词展开、Header 合并和表单编码顺序执行。可提取的编码段保持原样；依赖宿主的选项继续显式排除。实现普通 GET、静态 POST 和 UTF-8 表单；保留已有 GET/HTTP 200 行为。本阶段的响应状态均为 200，阶段 B 才验证重定向后的最终地址。

比较请求时保留原 URL、实际方法、原始请求体字节、该案例声明的请求头和实际响应地址。沿用现有的请求体字符串字段以兼容旧案例；新增可选的 Base64 预期字节，由适配器基于实际请求计算，不使用预期值生成请求。显式覆盖 URL options 中配置的 Content-Type。在 JVM 请求机制测试中另建同名 Header 输入，验证 options 按固定上游规则覆盖源级 Header；真实书源定义保持原样。用 `AnalyzeRule.getStringList(..., isUrl=true)` 对应的列表路径提取 HTML 下一页，按实际响应地址解析相对 URL。循环时保留已取页面并停止，请求预算只承担夹具失配保护。

| 案例 | 固定输入与断言 |
| --- | --- |
| `flow.yiove.post.explicit-header` | 「顶点小说」以“星河”为关键词，使用原始 POST 和显式 Content-Type。通过独立预期校验请求体字节、Content-Type、无意外 query，以及从搜索候选继续到正文。原 `sourceRegex` 所需节点出现在夹具中。原 `bookUrlPattern` 只匹配详情 URL，搜索响应仍为 `/s.php`。阶段 A 允许该模式存在且不匹配，但命中详情的执行路径由阶段 B 实现。 |
| `flow.yiove.html-paging.page-end` | 「得奇小说网」以“星河”为关键词，验证原规则没有显式 Content-Type 时的表单编码和默认头。首章正文有相对“下一页”，第二页无链接。详情响应内含目录，目录第二章另有独立 URL。核对书名与章名、两页合并后的正文和四次实际请求，确认目录复用详情响应。 |
| `flow.yiove.html-paging.repeated-page` | 复用「得奇小说网」相同规则，第二页指回自身。断言保留两页正文、没有第五个请求、终态与 Android 一致。 |
| `flow.yiove.html-paging.next-chapter` | 第二页的链接指向目录第二章。断言保留本章两页，且目录第二章从未被请求。 |

机制测试使用可辨识的两种方法、同 URL 不同请求体、错误 query 和请求超限，确保匹配失败能被报告。阶段 A 完成时 12/12 流程类案例一致。提交 `test(compatibility): 对照静态 POST 与 HTML 正文分页`。

#### B. 搜索直达详情、目录分页和卷节点

**实施位置**为 `BookFlow.kt`、`ts/book-flow.ts`、`schema/operations.json` 和 `cases/flow-toc-navigation.json`。参考 `WebBook.searchBookAwait`、`BookList.analyzeBookList/getInfoItem`、`BookInfo.analyzeBookInfo` 和 `BookChapterList.analyzeChapterList`。响应夹具沿用请求地址、最终地址和响应体。新增可选 `chapterIndex` 选择每端实际目录中的同一索引，旧案例继续取首章。若用例只需验证终态，按终态停止，保留请求记录。

目录仅做串行分页。按上游顺序验证页内提取、跨页合并、倒序标记、按章节身份去重和索引重排。重复条目使用不同标题和相同 URL，预期明确保留哪一个。卷节点测试使用无 href 的卷和后续正常章节，比较卷标、索引、VIP、购买标记和章节 URL。对于搜索直达详情，以最终响应 URL 判断模式，断言命中时复用搜索响应；存在模式但不命中时，不走仅适用于未声明模式的空列表回退。

| 案例 | 固定输入与断言 |
| --- | --- |
| `flow.synthetic.detail.redirect-match` | 合成 GET 搜索响应声明最终地址 `/book/7`，源模式匹配该地址。响应只有详情字段，目录另有地址。断言命中书籍身份，详情不重新请求，目录和正文按真实结果请求。 |
| `flow.synthetic.detail.redirect-miss` | 相同响应结构，最终地址改为 `/results/7`，模式保持原值。断言搜索合法为空，没有详情、目录或正文请求。 |
| `flow.synthetic.toc.paged-volume` | 复用 `TOC-EDGE-001` 的素材。页一含卷和第一章，页二含同 URL 不同标题的第一章及 VIP 第二章。加入指回已读目录页的链接。固定选择排序后的一条正常章节，断言两页目录请求、重复保留项、卷占位地址、索引与选章。 |
| `flow.synthetic.toc.paged-reversed` | 同一响应顺序，`chapterList` 使用原上游支持的负号反序标记。选择明确的正常章索引，断言反序与去重的组合结果及对应正文请求。 |

阶段 B 完成时 16/16 流程类案例一致。提交 `test(compatibility): 对照搜索直达详情与多页目录`。

#### C. 书籍变量影响选章与跨阶段传递

**实施位置**为 `CorpusRules.kt`、`BookFlow.kt`、`compat/Main.kt`、`ts/adapter.ts`、`ts/book-flow.ts`、案例协议和 `cases/flow-book-variables.json`。继续使用固定 Rhino 和节点身份。阶段用例新增 `flow.toc`，读共享书籍元数据、初始变量、原始目录规则和离线响应，TS 直接调用 `loadTableOfContents`。完整流程用例使用已有 `flow.book`。参考核对 `AnalyzeRule` 的变量优先级、`Book/RuleData` 的变量读写和 `BookInfo` 的 JS 绑定。适配器只开放该阶段需要的 book 读写，沿用每例独立作用域。变量快照只比较声明的业务键，原始空串与未设置分开保留；阶段之间传递实际生成的状态。

| 案例 | 固定输入与断言 |
| --- | --- |
| `flow.yiove.toc-variable.unset` | 阶段用例。使用「穿越小说🎃」的原始目录脚本和四条有唯一标题、链接的章节。初始无 `custom`，断言四章及其顺序。 |
| `flow.yiove.toc-variable.trim-tail` | 同一目录及脚本，初始 `custom="2"`。断言保留前两章，核对状态没有被脚本额外改写。 |
| `flow.synthetic.book-variable.write-read` | 完整流程。详情字段脚本执行 `book.putVariable("custom", "2")` 并返回正常字段，目录按同样的截尾语义读取变量。断言详情写入、目录读取的真实中间状态和对应的章节列表，正文使用保留的章节。 |
| `flow.synthetic.book-variable.no-write` | 使用相同书源标识和离线页面，详情脚本只返回同一字段值。断言没有 `custom`、保留四章。机制测试在同一 worker 内按“写入 → 无写入 → 写入”顺序执行，要求第三次结果与第一次一致。 |

阶段 C 完成时 20/20 流程类案例一致。提交 `test(compatibility): 对照书籍变量与目录选章`。

#### 差异处理与验收

1. 每阶段先提交可核对的用例和参考依据。遇到行为差异，保留修复前报告。先排查夹具、参考适配、TS 三类原因，再按根因最小修复并提交。对重复出现的基础 API 问题增加独立复现，同一 API 组合仍保留流程断言。允许错误映射只覆盖逐例精确的类别和文案，必须仍比较值、顺序、状态、请求和后续阶段。
2. 阶段结束以 `report.json` 的流程范围为准，阶段用例和完整流程用例分别列出数量，独立预期必须全部通过。基线 484 个基础契约继续通过，2 个原参考观察单列。最终连续运行两次流程，核对两端逐例结果及请求轨迹，排除时间、目录名等运行元数据。报告记录新增行为维度、样本、分支来源和结果；旧测试独有的取消、资源回收与安全断言继续保留。
3. 最终更新测试包 README、`docs/compatibility/conformance-tests.md` 与计划完成记录，报告仍待验证的字符集、Cookie 真实宿主、完整 `AnalyzeUrl`/JS 方法重载和 Android 应用入口边界。文档提交 `docs(compatibility): 记录请求目录与变量流程验收`。

在仓库根目录串行执行 JVM 构建与双端验证：

```sh
node packages/compatibility-tests/scripts/prepare-jvm.mjs
node --test packages/compatibility-tests/tests/*.test.mjs
node packages/compatibility-tests/scripts/run.mjs --case flow.yiove.post.explicit-header
node packages/compatibility-tests/scripts/run.mjs --family flow
node packages/compatibility-tests/scripts/run.mjs
pnpm --config.verifyDepsBeforeRun=false run test:source
pnpm --config.verifyDepsBeforeRun=false run typecheck
pnpm --config.verifyDepsBeforeRun=false run test
pnpm --config.verifyDepsBeforeRun=false run build
git diff --check
```

### 风险与回滚

- 最敏感的假设是 `AnalyzeUrl` 的静态请求子集与应用流程可分离。若确实遇到无法独立编译的 Android 依赖，只保留从固定源码可复核的纯算法和最小编排，记录适配位置。若行为依赖真实宿主才能判断，阶段保持未验收，并保留已完成阶段及可重现的阻塞案例。
- 夹具全部离线，无站点账号、密钥、联网采集或新依赖。Node 26.12.1、pnpm 11.27.0 和上游提交已在当前工作区确认。JDK 21.0.4 与 Maven 3.9.9 沿用已通过的参考配置。根测试若涉及本机环回端口，记录执行条件。
- 预计超过 8 个文件，集中在同一测试包及按实证定位的生产文件。A 约 1–2 个工作日，B 和 C 各约 1–2 个工作日；遇到独立产品缺陷再按根因估算。沿用阶段及根因提交，可逆序回退，无数据迁移。

## 完成记录

| 阶段 | 提交 | 阶段报告 |
| --- | --- | --- |
| A | `7edf1c4` | [12/12](../packages/compatibility-tests/output/run-X0oWGb/report.md)，机制覆盖同 URL 的方法、请求体区分及 Header 覆盖 |
| B | `4fdea62` | [16/16](../packages/compatibility-tests/output/run-tUBzqZ/report.md)，验证重定向身份、复用、目录反序去重与卷节点 |
| C | `9e2066b` | [20/20](../packages/compatibility-tests/output/run-tbcznG/report.md)，18 个完整流程与 2 个目录阶段用例，两个 worker 均验证变量隔离 |

阶段 B 首轮发现查询串形式的相对地址 `?page=2` 在桌面 JDK URL 和 TS 中解析不同。目录顺序案例使用两端语义相同的带路径相对地址 `toc?page=2`，保留 query 比较。查询串单独作为相对地址时，需 Android 应用或 Android 运行库证据核定，未计为本轮已验证。三阶段确认的流程行为在现有 TS 实现中均通过，变更集中于参考端、夹具和比较报告。

请求比对发生在离线传输边界。真实客户端注入的默认传输头、非 UTF-8 字符集、Cookie 真实宿主、完整 AnalyzeUrl/JS 重载、在线登录及设备行为分别取证。原 Android 工作区参考源码无改动。

### 最终验收

- [全量报告](../packages/compatibility-tests/output/run-QMpfyH/report.md) 共 506 条，484/484 基础契约与 20/20 流程类案例一致。另有 2 条原参考观察。流程没有意外差异、独立预期失败或执行器失败。
- 两次复跑 [第一次](../packages/compatibility-tests/output/run-TlmYzu/report.md) 和 [第二次](../packages/compatibility-tests/output/run-ouPSHR/report.md) 的 JVM、TS 逐例结果、请求轨迹和比较报告一致。[显式 Content-Type POST 单例](../packages/compatibility-tests/output/run-s3DRDL/report.md) 独立通过。
- 纯 JVM 准备、29 条机制和参考测试、203 条书源测试、694 条全仓测试、构建、类型检查及 `git diff --check` 通过。全仓测试使用本机环回夹具。无生产代码、依赖或上游参考仓库改动。

## 变更记录

- 2026-11-07 建立三阶段草稿，区分全流程、目录阶段与真实宿主证据。
- 2026-11-07 三阶段实施和验收完成，记录逐阶段提交、复跑产物与查询地址的证据边界。

## 批准记录

2026-11-07 用户批准实施，并要求按阶段和任务提交。
