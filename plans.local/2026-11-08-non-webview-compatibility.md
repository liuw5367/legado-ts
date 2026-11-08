# 非 WebView 书源兼容实施规划

- 状态：approved
- 创建：2026-11-08
- 更新：2026-11-08

## 方案

### 目标、范围与决策

以 TS `a76e6c6` 和 Android `32a87b253e7cc28273c3850de86242caac83f1fd` 为基线。上一批报告为 604 例，598 例一致，4 例逐例允许差异，2 项未支持的内部观察。下一批优先处理影响普通 HTTP 书源结果、脚本分支、章节内容或状态提交的非浏览器行为。[上一批验收](2026-11-08-compatibility-implementation.md)

- 已复现的例子是 HTML 块级序列化。固定 Jsoup 对 `<div>a<br>b</div>` 的 `outerHtml()` 在开标签之后、br 之后及闭标签之前都有换行，当前 TS 只在 br 前插入换行。其对实际后续规则的影响由 N2 验收。Android 请求头组装按原始字符串键写入且 OkHttp 逐项追加，TS 在合并时按大小写折叠。ZIP 参考端命中后立即返回，默认 Node 路径仍先验证并展开整个包。这两项有源码依据，传输或终态由双端夹具确定。
- 现有固定 Yiove 11 源和已选用的 YCK 3 源中没有 `mainJs`。真实目录字段脚本已经覆盖，但整源生命周期另需证据。N4 复用旧 `JS-TOC-001` 的合成整源及已存在的 TS 行为断言。用户现在无需补源。后续真实整源优先选择无需浏览器、可脱敏、有稳定重放输入的样本。YCK 起点中文网继续排除。
- 沿用独立测试包、固定 Jsoup/Jayway/Rhino/OkHttp/JDK、真实 TS 产品入口和现有报告命令。每项先保存双端原始输出，再修复可复现差异。常规测试采用纯 JVM 和合成响应，传输使用本机环回。Android 仓库只读。当前机器有 Maven、Node、pnpm、可执行的 JDK 21 和已缓存的参考依赖。本批预计涉及超过 8 个文件，沿用现有命令和配置，无新增服务、凭据、数据迁移或公开 API 计划。
- 优先实施 N1–N4，随后 N5–N6 与 N7 验收。最小可交付范围为 N1、N2 及 N7 中对应验收。扩大用例数量以新增可观察分支为条件。只有结果、顺序、继续条件、写入、资源清理均一致时，才能对不参与脚本分支的异常名称或文案做逐例映射。
- 保留现有跨源凭据隔离、SSRF、归档路径及预算、缓存与脚本会话隔离、取消政策。涉及这些边界的兼容修复采用安全输入对照及单独的策略回归。

### 实施与验证

| 任务 | 输入、实施位置与证据 | 验收 |
| --- | --- | --- |
| N1 请求头大小写和重复值，D5/D6/D22/D27 | 扩展 `flow-dynamic-request.json`、`flow-login-check.json`、`request-redirect.json`。将 source、登录头、URL options 分别设为 `X-Probe` 或 `x-probe`，用同拼写覆盖作对照。先比较 Android Map 对脚本可见的键和值，再由固定 OkHttp 和实际 Node 宿主记录每跳值数组，区分映射语义和传输合并。同步复测默认 UA、POST Content-Type 与跨主机 302。相关实现为 `source-request.ts`、`http.ts`。 | 普通头的丢值、先后顺序或脚本分支变化有同输入证据才修复。先限定普通头，认证、Cookie、代理头与 body 描述头继续按既有安全策略验收。若重复值需扩展公共请求契约，保留反例并单独审批该契约。 |
| N2 HTML 块级输出与下游规则，D18/D19 | 扩展 `css.json` 与 `flow-html-display.json`。比较 `div/p` 中的 br 和嵌套块、标签边界处文本、`pre`、内联 span 和 XML 控制输入。对照固定 Jsoup 原始字符串，再通过实际规则链测试行首替换和 JS 分支。相关实现为 `html.ts`。 | 对已证实会改变规则结果的 HTML 路径修复。复验正文显示、文本/ownText、pre 空白与 XPath/XML，完整畸形 HTML 修复另列。 |
| N3 ZIP 提前命中与脚本字节，D30/D34 | 扩展 `zip-download.json` 及现有参考适配。用五条目固定 ZIP，分别篡改第二和第五条目的 CRC。对照命中首项后不访问第五项、直接读取损坏第五项、跳过损坏第二项再读取第三项、目标缺失以及目录参与跳读。另用 0x00、0x7f、0x80、0xff，经固定 Rhino 与 QuickJS 分别读取索引、转换列表和往返编码。相关实现为 `archive.ts`、`source-file-host.ts` 和 byte bridge。 | 确认提前命中能否成功、后续条目是否被访问，以及脚本实际观察到的符号。修复限于已证实的入口。复验条目预算、路径检查、CRC、取消、完整解包与自定义归档宿主。若安全校验与早返回冲突，记录具体策略差异。 |
| N4 整源 mainJs 执行与投影，D14/D16/D45–D47 | 复用 `fixtures/conformance/cases/JS-TOC-001`，为 `compatibility-tests` 增加合成整源搜索、详情、目录和正文阶段的同输入案例。参考端用固定 Rhino 执行原始脚本，按 `JsSourceMarshaller` 原方法或最小适配验证搜索/发现的 primitive 转换、非法条目跳过与类型回退，详情 variable 合并，目录原始卷标、相对 URL 与索引，正文标题/内容及空结果。TS 经公开工作流执行，相关实现为 `javascript-projection.ts`、`discovery.ts`、`reading.ts`。 | 将脚本求值、投影与流程结果分开断言。记录每次主脚本初始化、请求轨迹、条目顺序、变量与失败后的状态。旧 JS-TOC 独有断言保留。无法纯 JVM 执行的应用组件标明证据边界。 |
| N5 非浏览器状态与发现筛选，D26/D28/D31/D39/D40 | 在 `source-state.json`、`script-library.json` 和发现阶段案例验证 `InfoMap.save(time,need)`、`saveNow`、删除传播及筛选值进入下一请求。固定时间或用现有受控时间端口检查过期前后和恢复。脚本状态新增同源刷新与函数闭包跨调用的探针。 | 报告分开记录原 Kotlin Map/保存意图、Node session 实际状态和现有 reader-web 游标隔离证据。保持跨源/账号隔离。跨进程持久化与真实应用数据库不从纯 JVM 结果推断。 |
| N6 加密与字体代表向量，D32/D33/D35 | 复用现有 `legacy-crypto` 适配和固定 Hutool/BC。新增 AES-GCM AAD 与认证失败、RSA OAEP 同摘要及不同 MGF1 摘要的固定向量。另复用 `packages/source-node/tests/font.test.ts` 的 `makeFont(0xe001)` 与 `makeFont(0x4e00)` 生成并固定 TrueType 字节，对照 `QueryTTF` 的字形查找、缺失字形和映射输出，TS 经现有字体 bridge。 | 分开记录正确明文、认证失败、provider 能力缺失及 TTF 结果。不同 MGF1 在现有 provider 无法表达时保留明确诊断并登记。WOFF/WOFF2/CFF 和通用 JVM 类加载维持现有能力边界。 |
| N7 差异复测与验收 | 保留上一批 604 个 ID，以相同参考 SHA 执行新增功能族和两次全量。更新 `coverage.json`、`status.md` 和 `known-divergences.md` 各自负责的条目。复核允许差异的精确路径和值及旧夹具的独有断言。 | 无未归因的行为差异、无执行器故障。两次逐例结果一致。每项证据或修复分别提交，产品修复与能捕获该差异的回归同提交。 |

逐项执行 `node packages/compatibility-tests/scripts/run.mjs --case <案例ID>`，再按功能族验证。批次验收在仓库根目录串行执行：

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

两次全量比较 `jvm.json.results`、`ts.json.results` 和 `report.json.cases`，保留输入、参考版本和结果差异。按 API、完整流程、阶段用例、内部观察、允许差异及真实宿主待验证分别统计。

### 风险与回滚

- 最重要的假设是核心差异可以通过原方法、固定依赖或可说明边界的离线编排复现。如果参考端需要真实宿主、公共契约扩展或现有 provider 缺少能力，记录该分支和阻碍，继续可独立验收的任务。实际网络站点下线时使用已固定的响应。
- 其余非 WebView 缺口由对应包维护，按触发条件独立进入计划。规则层的 CANON_EQ、更多 Java 重载、全量日期/繁简和 XPath 方言以真实规则反例优先。宿主层的 RAR/7z 部署、物理设备身份、真实阅读配置、跨进程状态和缓存由 Node/应用维护。应用层的段评写入、付费后刷新、自定义按钮、媒体与文件源消费由 reader-web/CLI 维护，需宿主证据或单独的产品决策。
- 每项可独立提交和回退。默认测试无需公网和外部账号。保留前批旧用例和用户数据。实施工期初估为 5–9 个工作日，主要取决于 N3 安全边界和 N4 参考适配。

## 完成记录

核对当前提交、两套固定语料、差异台账、固定 Android 源码和 Jsoup 块级序列化探针。进入 N1–N7 实施。

- N1 组装和重取用例通过，环回传输确认普通头三条独立值及顺序。请求/网络回归 59/59，类型检查通过。修复前报告为 `run-HYGsb0`、`run-k08EZk`，修复后为 `run-8rzubl`、`run-2xhBzy`。
- N2 修复前 CSS 四个块级分支及 JS 分支有差异，见 `run-GHeVgo`、`run-ddpuS7`。修复后 CSS、flow、XPath、corpus 功能族与类型检查通过。
- N3 修复前目标后损坏导致 TS 提前失败，且脚本读取 0x80/0xff 为无符号值，见 `run-Yl8E2q`。修复后 ZIP 差分 17/17，文件相关测试 14/14，类型检查通过。报告 `run-Pcqx8H`。
- N4 固定 Rhino 与原始 JsSourceMarshaller，使用 JVM 实体及 HTTP(S) 地址解析适配，复用旧目录脚本。搜索/发现交付、同名策略、字段投影、正文与失败终态 5 例均一致。额外诊断保留在 TS 单侧验证，未映射为 Android 应用状态。报告 `run-Nu9hyj`。
- N5 原 InfoMap 与实际 Node 发现链确认删除键未传播，修复后 3 例保存、请求及模拟快照一致，reader-web 发现回归 17/17。固定 Rhino 的同源闭包在第二次调用为 2，QuickJS 为 1，刷新后两端为 1。逐例登记闭包差异。报告 `run-soljEt`、`run-6O9K69`、`run-Jko1tK`。

## 变更记录

- 2026-11-08 新建非 WebView 兼容批次规划。

## 批准记录

- 用户批准开始实施 N1–N7，沿用按阶段和任务提交。
