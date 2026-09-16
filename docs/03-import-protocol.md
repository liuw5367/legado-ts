# 书源导入协议

## 输入分类

`ImportBookSourceViewModel.importSource` 对去除首尾空白后的文本按以下顺序判断：

1. JSON 对象或数组：解析为一个或多个书源；
2. 绝对 URL：下载文本后再次按 JSON 或 JavaScript 书源解析；
3. URI：读取 URI 内容后按文本解析；
4. 其他文本：作为 JavaScript 书源交给 `JsSourceConfig.extract`。

JSON 对象带 `sourceUrls` 时表示远程书源 URL 列表。导入器递归下载这些 URL；列表项为空时拒绝。远程 URL 返回的 JSON 在当前流程中禁止再次携带 `sourceUrls`，以避免递归协议和错误来源混淆。

JSON 数组中的每一个对象都必须有非空 `bookSourceUrl`。单个 JSON 对象也必须有该字段；缺失时统一报告“不是书源”类错误。

导入器对 `ruleExplore`、`ruleSearch`、`ruleBookInfo`、`ruleToc`、`ruleContent` 和 `ruleReview` 都应接受对象形式以及持久化层可能出现的 JSON 字符串形式，再统一归一化为规则对象。规则对象内部的未知字段不能在导入时静默丢弃，至少要进入 `unknownFields` 或原始字段保留区，供编辑器导出和兼容性诊断使用。字段的默认值和是否允许空字符串以 [书源数据模型](02-source-schema.md) 为准。

## 导入候选与替换

导入后不会立刻覆盖本地数据。当前流程先：

1. 将原书源序列化为 JSON；
2. 按源名称和源 URL 匹配启用的导入替换规则；
3. 依次对 JSON 文本应用替换；
4. 严格 JSON 解析失败时尝试历史宽松 JSON 解析，并记录非规范提示；
5. 生成原始候选、替换候选和替换错误；
6. 与本地同 `bookSourceUrl` 的源按 `lastUpdateTime` 判断新增或更新；
7. 用户确认后再写入。

替换失败不能静默使用部分替换结果作为有效书源。候选应保留错误、命中的规则 ID 和可回退的原始版本，编辑器可以据此显示诊断。

## 写入语义

最终写入由 `SourceHelp.insertBookSource` 和 `BookSourceDao` 完成，同 URL 的数据库冲突策略是替换。迁移库不应把导入和持久化绑在一起：核心返回 `ImportCandidate[]`，Node/应用层决定是否保存、如何确认更新和是否保留本地名称、分组、启用状态。

## JavaScript 书源导入

JS 书源的顶层配置优先读取 `config`；当 `config` 不存在或缺少有效的 `bookSourceUrl`/`bookSourceName` 时兼容旧版顶层 `source`。导入时执行脚本以获得配置，但保存的 `mainJs` 必须保留完整原文。配置中的声明式 `ruleSearch`、`ruleExplore`、`ruleBookInfo`、`ruleToc`、`ruleContent` 和 `ruleReview` 会从持久化配置对象剥离，因为运行时优先执行脚本。

导入器必须把脚本执行错误、缺少配置对象、缺少必备函数、配置字段类型错误区分开；不能将所有错误归为 JSON 格式错误。

JS 源的 `mainJs` 必须保存完整脚本原文。声明式规则被剥离只影响执行配置对象，不代表这些文本可以丢失；当书源配置中存在 `mainJs` 时，导出器不得尝试从 `ruleSearch` 等剥离后的对象重新拼装脚本。`ruleReview` 与其他规则对象一样参与类型校验，但 JS 源的段评执行入口由脚本函数决定，详见 [JavaScript 书源](10-javascript-source.md)。
