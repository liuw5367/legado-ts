# 下一批书源兼容开发规划

- 状态：completed
- 创建：2026-11-08
- 更新：2026-11-08

## 方案

### 目标、范围与决策

基于已推送的 TS `b5119f0` 和固定 Android `32a87b253e7cc28273c3850de86242caac83f1fd`，扩大能发现实际行为差异的双端覆盖，并修复有最小反例的差异。上一批 564 例中有 558 例一致、4 例逐例允许差异、2 项未支持的内部观察，意外差异和执行器故障均为 0。42 例流程包含 25 条完整流程和 17 条阶段案例。[批次报告](../packages/compatibility-tests/output/run-LgkZvM/report.md)

- 优先验证已经发现的原始差异、上游实现与 TS 实现明确不同的分支，以及现有案例尚未覆盖的真实规则组合。按行为分支计覆盖，不设案例数量指标。
- 继续使用现有独立测试包、纯 Kotlin/JVM 或 Java 参考端及实际 TS 产品入口。原 Android 仓库只读。默认离线，保留来源摘要及固定输入。常规验收无需 Android SDK、设备或外部账号。
- 逐例比较返回值、类型、顺序、空结果、继续条件、请求轨迹和相关状态。若这些行为及清理一致，仅按案例保留具体的异常文本或类别映射。会影响正常规则继续运行的异常、空值或副作用差异进入修复。
- 保持安全限制及宿主隔离。每项先保存双端结果，确认根因后将产品改动与回归断言放在同一个可回退提交。已通过的新增覆盖单独提交。完整范围可能涉及超过 8 个文件，复用既有包、命令和报告，公共产品 API、生产服务及数据迁移均无新增。
- 最小批次为 H1、H2 两项和 H6 验收。建议执行全部六项。真实 WebView、验证码、登录界面及跨进程状态沿用已完成的宿主取证协议单列，本批验收无需这些结果。

### 实施与验证

| 任务 | 实施位置及同输入验证 | 交付门槛 |
| --- | --- | --- |
| H1 HTML 序列化进入后续规则，D19 | 以 `css.string.batch-mixed-html` 和 `flow.synthetic.html-br.display` 为起点。固定同一 HTML，比较直接输出、依赖换行的正则替换、读取行数并分支的 JS。加入无 `br` 的对照，另复验既有 `pre` 空白和直接正文显示。案例位于 `cases/css.json`、`cases/flow-html-display.json`。 | 若正文或后续脚本分支不同，限定在实际触发的 HTML 序列化路径修复，复验文本和 XPath 分支。原有显示例外仅适用于已登记路径及原值，修复后若例外消失则删除该条。 |
| H2 多条目 ZIP 读取，D30 | 扩展 `cases/zip-download.json`。用同一个含四个常规文件的 ZIP 分别读取第一、第二、第三、第四个条目和不存在的名称。覆盖文本、字节、十六进制输入，复验已有网络、损坏、BOM 及缺条目用例。参考端用原 `JsExtensions` 循环，TS 用现有 `source-file-host.ts` 实际 bridge。 | Android 源码在条目未命中后额外调用 `nextEntry()`，TS 当前在解包结果里按路径查找。由实测确定跳读、正常返回和失败分支。确认行为差异后，仅在这两个 ZIP 单条目读取 API 中对齐已证实的安全输入行为。通用解包、路径检查、CRC 和预算继续使用现有回归验证。 |
| H3 请求头优先级和重定向，D5/D6/D22 | 扩展 `cases/flow-dynamic-request.json` 与 `cases/flow-login-check.json`。分别测默认 UA、显式 source UA、同名 URL options 覆盖、登录头与 options 同名、同源重定向、跨站重定向及缺失响应。使用虚构认证头，断言每跳方法、URL、Header 和 body。参考端拆开请求组装和固定 OkHttp 的实际传输行为。 | 组装差异可以独立复现和修复。只有参考传输实际执行才确认传输一致性。跨站敏感头隔离按既有 TS 安全约定验收，发现差异单列。 |
| H4 JSON 与正则的高影响边界，D20/D21 | 在 `cases/json.json` 验证嵌套数组中的显式 null、缺键、空列表与非空列表如何触发后备规则。区分 Jayway 求值与 Android AnalyzeRule 的继续条件。在 `cases/pattern-matcher.json` 测局部 flag 组结束后恢复、零宽全局替换及无匹配对照，对比 JDK Pattern 的文本、位置和异常。 | 已有等价用例只关联矩阵。对新增差异保留最小例，并通过调用它的规则入口验证最终结果。 |
| H5 真实规则组合 | 用 Yiove「文桑小说」原始奇幻分类 URL `/xuanhuan/page_{{page}}.html` 与 `ruleExplore`，固定第一页两个有序条目、第二页空结果。参考 Android 发现列表逻辑，TS 使用 `source-core/src/workflows/discovery.ts` 对应入口。另用合成目录或正文规则验证 `||` 左分支命中、合法为空后回退、两分支均空。现有已保存规则中尚未定位到可直接复用的无脚本目录或正文 `||`，合成例单独标记。 | 真实发现例比较页码展开、请求、结果顺序、字段和空页终态。TS 应用游标签名只作为本端约束。若需补充来源，优先请求实际存在可复现后备规则或其他尚未覆盖组合的书源；YCK 起点中文网继续排除。 |
| H6 差异登记与验收 | 按任务更新 `coverage.json` 以及对应兼容状态和差异条目。只复验受影响的历史条目，例如 D19、D20、D21、D22、D30，另执行完整基线。上一批三项旧流程测试按既有矩阵保留。 | 交付基线与本批的统计、可复现差异、修复提交和未验证范围。若实测与已有允许差异的值或路径不符，重新归因。无意外行为差异或执行器故障。 |

实施顺序 H1 → H2 → H3 → H4 → H5 → H6。参考端无法隔离的任务记录缺失证据并继续独立任务。单任务提交包括可通过的用例和必要修复。暂估 4–8 个工作日，取决于 H1、H3、H5 的参考端适配及实际缺陷数量。

从仓库根目录串行执行。开发阶段先按新增案例 ID 使用 `--case` 验证，之后执行功能族与全量检查。全量双端报告执行两次，比较 `jvm.json.results`、`ts.json.results`、`report.json.cases`，保留运行报告位置及上游 SHA。

```sh
node packages/compatibility-tests/scripts/prepare-jvm.mjs
node --test packages/compatibility-tests/tests/*.test.mjs
node packages/compatibility-tests/scripts/run.mjs --family flow
node packages/compatibility-tests/scripts/run.mjs
node packages/compatibility-tests/scripts/run.mjs
pnpm --config.verifyDepsBeforeRun=false run test:source
pnpm --config.verifyDepsBeforeRun=false run typecheck
pnpm --config.verifyDepsBeforeRun=false run test
pnpm --config.verifyDepsBeforeRun=false run build
git diff --check
```

### 风险与回滚

- 主要假设是解析与请求组装可以使用固定上游依赖和离线输入比较。只有编排模拟可用时标明参考类型；缺少真实传输或宿主证据的路径单列，不据此扩展产品行为。
- H2 需区分 ZIP 本地条目顺序、中央目录顺序和目录项。只有双端已复现的普通输入进入修复范围。回退单条目读取变更不影响其他包或已持久化数据。
- 新夹具采用合成响应，任何原始脚本进入运行环境前先静态审查。已有来源快照可在站点不可用时继续使用。独立运行步骤使用现有 JDK 21、Maven、Node 和 pnpm，网络流程夹具依赖本机环回端口。
- 按任务或根因回退提交。旧用例的删减需要独立确认逐断言覆盖并作为单独变更处理。

## 完成记录

| 任务 | 提交及验收证据 |
| --- | --- |
| H1 | `2156dda`。修复前 [JS](../packages/compatibility-tests/output/run-4LtMav/report.md) 返回“两行”与“一行”，[正则](../packages/compatibility-tests/output/run-mjn4O9/report.md) 的正文也不同。修复后直接显示、正则、JS 和无 br 对照一致，原始 HTML 的逐例允许差异已删除。CSS 与 XPath 功能族通过。 |
| H2 | `011a89b`。[修复前](../packages/compatibility-tests/output/run-ISdKZg/report.md) 第二条目在 JVM 失败、TS 返回内容。修复后 [ZIP 12/12](../packages/compatibility-tests/output/run-srQj9x/report.md)，文件宿主 9/9。字节用例比较原始八位内容，Java 脚本读取带符号字节的行为独立于此证据。 |
| H3 | `f5b6998`、`b45a84f`。同名头组装、缺响应故障、登录重取均通过。修复前 [302 保留了请求体描述头](../packages/compatibility-tests/output/run-pHhTOY/report.md)，修复后固定 OkHttp 与 Node 环回 4 例，3 例一致、1 例跨主机 Cookie 差异按安全策略保留。逐跳比较 127.0.0.1 与 localhost、方法、路径、请求体和 Authorization。 |
| H4 | `7810ee6`、`c440075`。JSON 字段后备与同一输入的 Jayway 原值分开断言，JSON 功能族 74/74。正则功能族通过，新增局部标志恢复、零宽替换和无匹配对照。 |
| H5 | `e12a3ef`、`6c1359f`。「文桑小说」第一页两本书顺序一致，第二页为空并终止，固定快照与上游发现逻辑已核验。三个合成正文案例分别对照主分支、回退和正文为空。发现流程单列，单规则语料统计保持原范围。 |
| H6 | 已复验 D5、D6、D8、D19、D20、D21、D22、D30、D40 的本批相关分支，更新状态、差异与固定源码摘要。上一批三个旧流程夹具及其独有断言保留。 |

[最终报告](../packages/compatibility-tests/output/run-H2YdXx/report.md) 为 604 例。547 例 API 中 544 例一致、3 例逐例允许差异。55 例流程中 54 例一致、1 例逐例允许差异，包含 36 条完整流程及 19 条阶段用例。另有 2 项未支持的内部观察。意外差异和执行器故障均为 0，84 项异常语义等价。上一批 564 个案例全部保留，只有原 HTML 例外变为一致。

两次全量 [run-x1eUfo](../packages/compatibility-tests/output/run-x1eUfo/report.md) 与 [run-H2YdXx](../packages/compatibility-tests/output/run-H2YdXx/report.md) 的 `jvm.json.results`、`ts.json.results`、`report.json.cases` 严格一致。输入、实现、core 产物和上游摘要核对一致。参考 SHA 仍为 `32a87b253e7cc28273c3850de86242caac83f1fd`，原仓库参考范围无差异。

JVM 准备、机制测试 33/33、流程定向 55 例、书源回归 207/207、项目回归 700/700、类型检查、构建及 `git diff --check` 均通过。真实 Android 应用宿主、完整 Jsoup 序列化、ZIP 畸形输入及请求头大小写变体继续按各自证据边界记录。

## 变更记录

- 2026-11-08 以已完成批次替换上一版草稿的过时进度，新增多条目 ZIP 验证，固定发现规则来源及回退分支的验证方式。
- 2026-11-08 完成 H1–H6，记录可复验报告、分任务提交和未验证边界。

## 批准记录

- 用户批准开始实施，要求按阶段和任务分别提交。
