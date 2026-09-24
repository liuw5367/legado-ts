# 书源导入协议

## 输入分类

`ImportBookSourceViewModel.importSource` 对去除首尾空白后的文本按以下顺序判断：

1. JSON 对象或数组：解析为一个或多个书源；
2. 绝对 URL：下载文本后再次按 JSON 或 JavaScript 书源解析；
3. URI：读取 URI 内容后按文本解析；
4. 其他文本：作为 JavaScript 书源交给 `JsSourceConfig.extract`。

JSON 对象带 `sourceUrls` 时表示外层远程书源 URL 列表。导入器按顺序下载这些 URL；列表项为空白时拒绝。远程返回的 JSON 禁止再次携带 `sourceUrls`，不是任意深度递归。

`ImportBookSourceViewModel.importBookSourceJson` 逐项调用 importSourceUrl，没有先去重的证据。兼容导入保持顺序与重复项，为各来源生成候选位置，同 sourceId 保存冲突单独诊断。Web 目标可收集不同链接的错误和成功候选，但不宣称这是 Android 已有的逐项错误隔离。只有用户选中的有效候选进入保存事务；下载失败不自动写入。宿主限制数量、响应大小与总预算，不扩展递归深度。

JSON 数组中的每一个对象都必须有非空 `bookSourceUrl`。单个 JSON 对象也必须有该字段；缺失时统一报告“不是书源”类错误。

导入器对 `ruleExplore`、`ruleSearch`、`ruleBookInfo`、`ruleToc`、`ruleContent` 和 `ruleReview` 都应接受对象形式以及持久化层可能出现的 JSON 字符串形式，再统一归一化为规则对象。Web 目标要求规则对象内部的未知字段不能在导入时静默丢弃，至少要进入 `unknownFields` 或原始字段保留区，供编辑器导出和兼容性诊断使用；Android 的 GSON 反序列化会直接丢弃未知字段。字段的默认值和是否允许空字符串以 [书源数据模型](../standard/source-schema.md) 为准。

## 导入候选与替换

导入后不会立刻覆盖本地数据。当前流程先：

1. 将原书源序列化为 JSON；
2. 按源名称和源 URL 匹配启用的导入替换规则；
3. 依次对 JSON 文本应用替换；
4. 严格 JSON 解析失败时尝试历史宽松 JSON 解析，并记录非规范提示（Web 目标设计；Android 导入只做一次 GSON 宽松解析，没有严格到宽松的回退）；
5. 生成原始候选、替换候选和替换错误；
6. 与本地同 `bookSourceUrl` 的源按 `lastUpdateTime` 判断新增或更新；
7. 用户确认后再写入。

核心导入结果使用候选对象承载流程状态：

```ts
export type ImportOrigin = SourceOrigin

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
  | 'replace' | 'conflict' | 'storage' | 'cancel'

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
  source?: NormalizedSource
  /** 未知字段和原始结构保留区；不能因没有表单控件而丢弃。 */
  unknownFields: Record<string, unknown>
  /** 按顺序记录命中的替换规则及前后差异摘要。 */
  replacements: ImportReplacement[]
  /** 输入、解析、字段、冲突和持久化前诊断。 */
  diagnostics: ImportDiagnostic[]
  /** 与本地同 URL 书源的比较结果。 */
  localMatch?: 'new' | 'update' | 'same' | 'conflict'
  /** 是否可以进入用户确认和保存阶段。 */
  writable: boolean
  /** 候选当前生命周期状态。 */
  status: 'ready' | 'invalid' | 'cancelled' | 'persisted'
  /** 候选级稳定错误；没有错误时为空。 */
  error?: { code: string; message: string; canRetry: boolean }
}
```

导入批次的整体结果还需要记录 `operationId`、输入顺序、候选数组、是否有可写候选和清理状态。候选 `cancelled` 表示读取、网络、脚本或临时资源尚未完成时被停止；它不能与 `invalid` 混用，也不能因为已有候选而把整批报告为 `persisted`。批量持久化仍由应用在确认后调用 Repository 完成。

替换失败不能静默使用部分替换结果作为有效书源。候选应保留错误、命中的规则 ID 和可回退的原始版本，编辑器可以据此显示诊断。

导入候选的生命周期为 `read -> classify -> fetch/parse -> normalize -> replace -> validate -> compare-local -> await-confirmation -> persist`。每个候选至少保留 `rawText`、规范化对象、来源位置、替换记录、诊断和可写入版本；验证失败或用户拒绝时只能丢弃候选，不得改动本地书源。保存多个候选时使用单次持久化事务，事务失败时不能出现只有部分书源写入的状态。

### 核心导入与 Android API 保存的边界

这里描述的是 package 推荐的导入协议，不应直接推断为 Android Web API 的完整保存语义。核心流程在 `persist` 前等待应用确认，并通过 `SourceRepository` 处理 userId、expectedSourceRevision、检查状态失效和缓存副作用；导入器本身不写数据库。

现有 Android `/saveBookSource` 会对单个 JSON 做名称/URL 的最小校验后直接保存，`/saveBookSources` 会逐项解析并跳过无效成员后直接写入 DAO。兼容 adapter 必须保留这种行为并返回逐项结果，但新 Web 应用应使用预览、确认、CAS 和事务保存。JS source 的大小、读取时限、`openedSourceUrl` 和重命名清理也属于 adapter 入口约束，见 [Legado Web API 适配](../archive/legado-web-api-bridge.md)。

## 写入语义

Android 应用的最终写入由 `SourceHelp.insertBookSource` 和 `BookSourceDao` 完成，同 URL 的数据库冲突策略是替换；`SourceHelp` 还可能拦截配置中的域名，并修正越界或重复的 `customOrder`。独立 package 不直接调用 Android helper：新 Web 应用应在应用层执行 `web-safe` 插入策略后调用[书源 Repository](../archive/source-management-and-state.md#6-插入策略与兼容实现事实)，兼容旧 API 时才选择 `android-compatible` 的直接 DAO 语义。两种入口的策略差异必须记录并测试。

迁移库不应把导入和持久化绑在一起：核心返回 `ImportCandidate[]`，Node/应用层决定是否保存、如何确认更新和是否保留本地名称、分组、启用状态。

保存成功后，若规则内容发生变化，必须重置或标记过期的书源检查状态，并使规则相关缓存失效（Android 的 `BookSourceDao.update` 在 `checkContent()` 变化时重置检查状态）。Web 目标要求仅改变用户排序或启用状态时不应误重置检查；Android 的 `bookSourceGroup` 属于 `checkContent()` 的一部分，修改分组仍会重置检查状态。删除还要清理变量、cookie 引用和检查记录，书籍/章节/阅读进度按应用策略单独处理。完整的数据写入和删除边界见 [书源保存与状态持久化流程](../archive/source-persistence-flow.md)。

比较本地版本时，以原始 `bookSourceUrl` 为身份；Android 使用 lastUpdateTime 参与比较，Web 同时比较内容，不因时间戳相同忽略变化。用户字段覆盖策略必须显式传入；sourceRevision 是独立保存版本。错误区分 `input`、`fetch`、`parse`、`normalize`、`replace`、`conflict`、`storage`。

JSON 数组含一个无 URL 项时，原解析器整组抛错；空数组是零候选。sourceUrls 为 null 或含空白项是错误。Web 目标要求 JSON 名称缺省允许导入并诊断；Android 只校验 `bookSourceUrl`，名称缺省不产生诊断。JS 名称缺省是配置错误（`JsSourceConfig.extract` 直接抛错）。远程导入 `#requestWithoutUA` 后缀会被剥离并将 UA 设置为字符串 `null`，不改变源身份。URI 由受控读取端口处理，不允许服务端读取任意用户路径。

持续订阅见 [订阅协议](source-subscriptions.md)。Android 非静默订阅（`silentUpdate=false`）在 `RuleUpdate.cacheSource` 检测到更新后把列表写入 `cacheBookSourceMap[url]`，由 `ImportBookSourceViewModel.importSourceUrl` 消费进入导入预览，保存后调用 `ContentProcessor.upReplaceRules()` 重建替换规则；`reimportSourceUrl` 对应的源通过 `selectExisting` 预选中。手动替换模式由 `automaticSourceReplacement` 与 `manualRuleIds` 控制，切换时逐项重新生成替换候选。导出基于原始快照与用户修改，未修改原样返回；修改后保留未知字段和 mainJs，并再导入检查结构等价，不承诺空白及 key 顺序完全不变。

## JavaScript 书源导入

JS 书源的顶层配置优先读取 `config`；当 `config` 不存在或缺少有效的 `bookSourceUrl`/`bookSourceName` 时兼容旧版顶层 `source`。导入时执行脚本以获得配置，但保存的 `mainJs` 必须保留完整原文。配置中的声明式 `ruleSearch`、`ruleExplore`、`ruleBookInfo`、`ruleToc`、`ruleContent` 和 `ruleReview` 会从持久化配置对象剥离，因为运行时优先执行脚本。

导入器必须把脚本执行错误、缺少配置对象、缺少必备函数、配置字段类型错误区分开；不能将所有错误归为 JSON 格式错误。

JS 源的 `mainJs` 必须保存完整脚本原文。声明式规则被剥离只影响执行配置对象，不代表这些文本可以丢失；当书源配置中存在 `mainJs` 时，导出器不得尝试从 `ruleSearch` 等剥离后的对象重新拼装脚本。`ruleReview` 与其他规则对象一样参与类型校验，但 JS 源的段评执行入口由脚本函数决定，详见 [JavaScript 书源](../standard/javascript-source.md)。
