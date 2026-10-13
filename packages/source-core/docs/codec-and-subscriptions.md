# Codec、身份与订阅

Codec 的完整实现位于 [`codec/`](../src/codec/)，数据边界定义在 [`model/types.ts`](../src/model/types.ts)。本页记录应用接入时必须保留的原文、未知字段、身份和提交计划；它不替代[上游书源规则](../../../docs/upstream/README.md)或应用 Repository 契约。

## importSources

`importSources(input, options)` 支持：

- JSON 文本、JSON 对象或 JSON 数组；数组成员分别生成候选；
- 静态 JavaScript `config`/`source` 对象。它只安全抽取对象字面量，不能把动态脚本假装成已执行；
- `kind: 'text' | 'javascript'` 的结构化文本；
- `kind: 'uri' | 'url' | 'file'` 的受控读取。必须注入 `ImportReader`，core 不直接读取任意本地路径或公网。

每个 `ImportCandidate` 保留：

- `rawText`、`RawSource.kind`、脱敏 `origin`、解析值和 `fieldShapes`；
- `unknownFields`，即非已知书源字段的原结构；
- 规范化 `source`（无效候选没有该字段）、`sourceUuid`、定义指纹和 `localMatch`；
- 替换规则执行结果、稳定 `ImportDiagnostic[]`、`writable` 和 `status`。

应用必须先检查 `status`、`writable` 和 diagnostics，再决定是否写入。`sourceUuid` 是本次导入实例 UUID，不替代 `bookSourceUrl` 的兼容身份；用户保存版本由应用的 `SourceSnapshot` 管理。

导入限制默认在 [`import.ts`](../src/codec/import.ts) 中定义：候选数、单份输入字节数和 `sourceUrls` 展开数都有限制。`sourceUrls` 只展开一层，每个 URI 仍经过 `ImportReader` 和取消信号；读取失败、超限和取消生成候选级诊断，不静默丢弃来源。

## normalize 与原文保留

`normalizeSource` 为缺省字段提供 Android 兼容默认值，并把规则字段保留为对象、数组、空值或原始形态；无效 `bookSourceUrl`、类型或规则生成诊断。已知字段表以 [`normalize.ts`](../src/codec/normalize.ts) 为准，不要在文档中复制一份可漂移的字段清单。

未知字段不能因为运行时暂不消费就删除。编辑器或应用再次导出时，应继续暴露 `unknownFields` 和原始字段形态；安全展示仍须脱敏 URL、Cookie、Token 和 Authorization。

替换规则按顺序匹配书源名称和 URL，对原始文本执行受控 regex 替换，再重新解析和规范化。替换失败保留原候选并禁止写入，不通过放宽解析器来消除错误。

## exportSource

`exportSource(candidate, options)` 的行为是：

- 无 patch 且格式与原输入相同，优先逐字返回 `rawText`；
- JSON 输出使用规范化源并保留未知字段；
- JavaScript 输出在有修改时生成静态 `const config = ...` 包装，并给出 `requires-javascript` 信息诊断；原始动态脚本只在未修改时逐字保留；
- 无有效 `source` 的候选不能导出为可保存书源，返回原文本和 `unsupported-format` 诊断。

导出只生成文本，不写 Repository、不执行脚本、不调用网络。应用必须在用户确认后自行提交。

## 身份与定义指纹

`sourceDefinitionFingerprint` 对规则、请求、宿主提示和其他定义字段做稳定排序与 FNV-1a 哈希；名称、分组、排序、启用状态、更新时间、响应时间、权重和自定义按钮等展示/管理字段不参与指纹。`sameSourceDefinition` 只比较指纹，不能作为授权或安全 token。

书源的运行身份仍是原始 `bookSourceUrl`，不进行 URL 规范化；跨源搜索聚合必须同时保留 `sourceId` 和 `bookUrl`。应用保存版本时另行提供 `sourceRevision`，不能把定义指纹当成并发版本。

## refreshSubscription

`refreshSubscription` 接受订阅身份、操作身份、当前订阅版本、baseline、local 和 remote 快照：

1. 如果提供 `remoteSources`，直接比较，不读取网络；否则使用受控 `ImportReader` 读取 `url`，复用导入限制和诊断。
2. 按 `sourceId` 建立 baseline/remote/local 三方索引，返回 `added`、`updated`、`unchanged`、`conflict` 或 `remote-missing` 的 `SourceDiff`。
3. 远程与本地同时修改同一字段且值不同，标记 `conflict`；只改一侧时生成 `updated`。
4. 返回 `SubscriptionRefreshPlan.commitPlan`，其中有待提交的 `sourceIds`、预期本地版本和是否需要确认。

`outcome` 可以是 `unchanged`、`updated`、`partial`、`conflict`、`failed`、`cancelled`、`stale` 或 `unknown`。这些是订阅计划状态，不是 `RuntimeResult` 的 core 工作流终态。core 不保存、删除、调度或自动覆盖源；应用确认并以版本条件提交。

## 证据与测试

Codec 变化至少运行 `packages/source-core/tests/import.test.ts`、`subscription.test.ts` 或对应主题测试；真实源语料和执行状态见[兼容性与验证](../../../docs/compatibility/README.md)。不存在 Android golden 时只能记录为待验证。
