# 任务 07-B：真实书源文件测试

本任务验证仓库中的真实书源 JSON 文件能够经过受控文件读取进入统一导入入口，并与直接传入单个书源对象保持一致。

## 固定输入

测试读取 `fixtures/source/collection` 和 `fixtures/source/single`，但不得把真实网站请求作为默认测试步骤。当前 corpus 的文件数量、候选数量和诊断统计必须由测试动态核对并写入脱敏 manifest，不把源文件内容复制到测试代码。

manifest 是语料快照（`version: 2`）：`fixtures[]` 记录每个文件的候选数、状态数与诊断数，`knownBrokenRules[]` 记录**语料自带的坏规则**。语料里确实存在写法损坏的真实规则（例如 `//div[@id='intro]/p/text()` 少了闭引号、`{{$.officialDescr},}` 多一个花括号、`{{'...=1"}'}}` 把双引号嵌在插值里），这些规则在 Android 同样解析不出可用的结果，因此**不修改语料**（fixture 必须保持真实），也不放宽编译器，而是显式登记：只有登记过的规则允许编译失败，新出现的失败仍会让测试变红。语料更新后用 `node fixtures/phase-07-b/regenerate.mjs` 重生 `manifest.json`（脚本幂等，输出 file/candidates/statuses/diagnostics/knownBrokenRules），再跑 `node --test packages/source-core/tests/source-fixtures.test.ts` 核对，并确认新增的坏规则确实是源本身的写法问题而不是解析器回归。

## 验收内容

- 受控 file reader、文本输入和已解析 JSON 输入均可运行；
- 顶层数组逐项进入与单对象相同的规范化/诊断入口；
- 集合与单文件的候选身份、未知字段、规则形态和错误语义可比较；
- 非法源、动态 JS、字体/加密/登录等宿主依赖被分类为明确诊断；
- 代表性 JSON、HTML/CSS、XPath、JS 和字体书源使用本地响应 fixture 做 smoke test；
- 读取取消、字节上限、最大候选数和单项失败不会污染其他候选。

真实源的公网行为、账号登录和写操作不属于本任务。需要公网或真实账号的案例另行标记 integration，不得让默认 `pnpm test` 依赖它们。

## 与任务 11 的关系

任务 07-B 拥有真实书源 corpus 的导入和解析案例；任务 11 只负责把本任务纳入全局 conformance、质量报告和发布门禁，不重复定义书源语义。

## 完成记录

- 2026-09-22：纳入 `fixtures/source` 的 4 个真实 JSON 文件，共 316 个候选；新增受控 file reader、原始文本、已解析值、集合成员/单个入口一致性测试，并记录 230/84 个集合源和 2 个单源文件的状态/诊断统计。测试不访问公网。
- 2026-09-22：新增 `packages/source-node/tests/source-file-smoke.test.ts`，使用真实书源配置和本地响应覆盖 JSON 搜索工作流、HTML/CSS、XPath、QuickJS；字体二进制映射仍由 `packages/source-node/tests/font.test.ts` 单独覆盖。同步兼容 Android 的列表字段别名和 `{{key}}` 搜索占位符。
- 2026-09-22：新增 `packages/source-node/tests/source-file-flow.test.ts`，从真实书源文件中选择两个可运行源，使用本地网络与规则端口贯通导入后的搜索、切换书源、详情、目录和正文；新增 `pnpm run test:source` 与 `pnpm run test:source:flow` 专用命令。目录入口优先使用详情返回的 `tocUrl`。
