# 书源导入协议

## 输入分类

`ImportBookSourceViewModel.importSource` 对去除首尾空白后的文本按以下顺序判断：

1. JSON 对象或数组：解析为一个或多个书源；
2. 绝对 URL：下载文本后再次按 JSON 或 JavaScript 书源解析；
3. URI：读取 URI 内容后按文本解析；
4. 其他文本：作为 JavaScript 书源交给 `JsSourceConfig.extract`。

JSON 对象带 `sourceUrls` 时表示远程书源 URL 列表。导入器递归下载这些 URL；列表项为空时拒绝。远程 URL 返回的 JSON 在当前流程中禁止再次携带 `sourceUrls`，以避免递归协议和错误来源混淆。

`sourceUrls` 的处理必须有明确的边界：先规范化 URL 并按规范化地址去重，再按输入顺序下载；请求失败、响应为空、内容不是书源或远程内容再次包含 `sourceUrls` 时，该项进入导入错误列表，不能写入部分结果。当前兼容行为只允许外层 JSON 指向远程书源，远程书源不得继续递归；实现若提供更深层递归，必须显式增加最大深度、已访问 URL 集合、总数量上限和取消传播，否则会形成无限导入或资源耗尽。

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

核心导入结果使用候选对象承载流程状态：

```ts
export interface ImportOrigin {
  /** 输入分类，例如 json、remote-url、uri 或 javascript。 */
  kind: string
  /** 原始文件、URI 或 URL，展示时需要脱敏。 */
  location?: string
}

export interface ImportReplacement {
  /** 命中的导入替换规则身份。 */
  ruleId: string
  /** 是否实际应用了该规则。 */
  applied: boolean
  /** 应用失败时的稳定错误说明。 */
  error?: string
}

export type ImportStage =
  | 'input' | 'fetch' | 'parse' | 'normalize'
  | 'replace' | 'conflict' | 'storage'

export interface ImportDiagnostic {
  /** 诊断阶段，例如 parse、replace 或 conflict。 */
  stage: ImportStage
  /** 稳定错误编码。 */
  code: string
  /** 面向编辑器和测试的说明。 */
  message: string
}

export interface ImportCandidate {
  /** 稳定的输入顺序标识，供编辑器和批量保存引用。 */
  id: string
  /** 原始输入类型和位置，例如 json、remote-url、uri 或 javascript。 */
  origin: ImportOrigin
  /** 未经替换的原始文本，供回退和导出保留。 */
  rawText: string
  /** 解析并归一化后的书源对象，校验失败时为空。 */
  source?: BookSource
  /** 按顺序记录命中的替换规则及前后差异摘要。 */
  replacements: ImportReplacement[]
  /** 输入、解析、字段、冲突和持久化前诊断。 */
  diagnostics: ImportDiagnostic[]
  /** 与本地同 URL 书源的比较结果。 */
  localMatch?: 'new' | 'update' | 'same' | 'conflict'
  /** 是否可以进入用户确认和保存阶段。 */
  writable: boolean
}
```

替换失败不能静默使用部分替换结果作为有效书源。候选应保留错误、命中的规则 ID 和可回退的原始版本，编辑器可以据此显示诊断。

导入候选的生命周期为 `read -> classify -> fetch/parse -> normalize -> replace -> validate -> compare-local -> await-confirmation -> persist`。每个候选至少保留 `rawText`、规范化对象、来源位置、替换记录、诊断和可写入版本；验证失败或用户拒绝时只能丢弃候选，不得改动本地书源。保存多个候选时使用单次持久化事务，事务失败时不能出现只有部分书源写入的状态。

## 写入语义

最终写入由 `SourceHelp.insertBookSource` 和 `BookSourceDao` 完成，同 URL 的数据库冲突策略是替换。迁移库不应把导入和持久化绑在一起：核心返回 `ImportCandidate[]`，Node/应用层决定是否保存、如何确认更新和是否保留本地名称、分组、启用状态。

比较本地版本时，以规范化后的 `bookSourceUrl` 作为身份，以 `lastUpdateTime` 判断新增、更新或跳过；本地名称、分组、启用状态等用户字段是否覆盖必须作为显式策略传入，不能由导入器隐式决定。导入、替换和持久化的错误要区分 `input`、`fetch`、`parse`、`normalize`、`replace`、`conflict` 和 `storage` 阶段。

## JavaScript 书源导入

JS 书源的顶层配置优先读取 `config`；当 `config` 不存在或缺少有效的 `bookSourceUrl`/`bookSourceName` 时兼容旧版顶层 `source`。导入时执行脚本以获得配置，但保存的 `mainJs` 必须保留完整原文。配置中的声明式 `ruleSearch`、`ruleExplore`、`ruleBookInfo`、`ruleToc`、`ruleContent` 和 `ruleReview` 会从持久化配置对象剥离，因为运行时优先执行脚本。

导入器必须把脚本执行错误、缺少配置对象、缺少必备函数、配置字段类型错误区分开；不能将所有错误归为 JSON 格式错误。

JS 源的 `mainJs` 必须保存完整脚本原文。声明式规则被剥离只影响执行配置对象，不代表这些文本可以丢失；当书源配置中存在 `mainJs` 时，导出器不得尝试从 `ruleSearch` 等剥离后的对象重新拼装脚本。`ruleReview` 与其他规则对象一样参与类型校验，但 JS 源的段评执行入口由脚本函数决定，详见 [JavaScript 书源](10-javascript-source.md)。
