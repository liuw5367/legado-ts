# 架构与职责映射

## 当前实现的调用关系

### Android（标准侧行为事实）

```text
导入
  ImportBookSourceViewModel
    -> BookSourceImport / JsSourceConfig
    -> SourceHelp / BookSourceDao

运行时
  SearchModel / WebBook
    -> AnalyzeUrl                 请求并展开 URL 规则
    -> AnalyzeRule                执行字段规则
    -> BookList / BookInfo
    -> BookChapterList / BookContent
    -> SearchBook / Book / BookChapter
```

`WebBook` 先依据 `mainJs` 是否非空分流：非空时走 `JsSourceBook`，否则走声明式规则流程。声明式流程的发现、搜索、详情、目录和正文处理共享 `AnalyzeRule` 和 `AnalyzeUrl`，但每个处理器对空值、字段覆盖和分页有自己的语义。

### TypeScript 仓库现状

```text
apps/reader-cli          应用层：UI、书架、本地 JSON 存储、多源循环
  -> @legado/source-node 平台能力适配与宿主组合
  -> @legado/source-core 规则解释、请求语义、候选归并和单源工作流
```

- **source-core**：不依赖 Node 平台；`SourceRuleRuntime` 解释书源规则，`SourceRequestRuntime` 解释书源请求选项，搜索聚合函数处理跨源候选。通过 `WorkflowPorts` / `ReadingPorts` 接收宿主能力；公开入口见 [package 使用指南](../implementation/package-usage.md)。
- **source-node**：实现网络、HTML/JSONPath/XPath 解析器、QuickJS、Cookie、字符集、加密、归档、字体和并发能力；`SourceRuleHost` / `SourceRequestHost` 组合这些能力并委托给核心，也提供兼容性 CLI。
- **reader-cli**：负责来源选择与读取、跨源调度、并发、进度和取消、搜索历史、持久化及终端交互；调用核心归并候选，但不重新解释书源规则或归并条件。

仓库中**没有** `SourceApplicationService`、`SourceRepository`、`SecretStore`、`JobStore` 这些应用服务端口；书源保存与检测的 Repository 设计见 [归档](../archive/source-management-and-state.md)。reader-cli 使用自有 `json-store` / `cache-store`。

### 纯核心层

核心层解释书源规则，并通过宿主端口编排流程：

- schema 解析和导入分类；
- 发现分类解释、选定分类后的列表流程；
- 规则文本词法拆分、模式选择和规则链执行；
- HTML/CSS、JSONPath、XPath、Regex、模板、替换及书源 JavaScript 的规则语义；
- 来源请求选项、请求体和查询编码、重试、bodyJs、响应归一化；
- 结果归一化、变量作用域、跨源候选归并和匹配排序；
- 搜索/详情/目录/正文流程状态机；
- 并发、超时、取消的抽象约定。

多源 fan-out、每源会话、并发限制、进度与终止生命周期属于应用层；source-core 的搜索聚合函数只处理候选身份、分组及稳定排序，不依赖 CLI 的 `SourceEntry` 或页面模型。

### 宿主端口（当前实现）

以下能力通过依赖注入提供（定义在 source-core，实现在 source-node）：

- `NetworkHost`：请求、响应、重定向和响应字节（实现 `NodeNetworkHost`）；
- `HtmlParser` / `XPathParser` / `JsonPathParser`（实现 `HtmlParserAdapter` 等）；
- `JavaScriptHost` 与 QuickJS 执行器；
- 字符集、编码、Cookie、加密、归档、字体及并发能力；
- 组合门面：`SourceRuleHost`、`SourceRequestHost`；书源语义由 source-core 实现。

`java` / `sourceApi` 等脚本绑定由宿主按 capability 注入，保持 Android 同步外观。

### 上层应用

上层应用负责书源列表、当前用户持久化、搜索与发现进度展示、登录页面和编辑器 UI。上层不能自行重新解释规则字段；预览和运行时必须调用同一个核心解析器。当前仓库中的上层是 `apps/reader-cli`；书源交互能力通过版本化宿主接口与应用对接，不因属于 Android UI 就从能力清单中删除。

历史目标设计中的应用服务边界（**未实现**）如下，仅供后续持久化设计对照，详见 [归档](../archive/source-management-and-state.md)：

```text
请求用户/认证
    -> SourceApplicationService          （目标设计，未实现）
       -> SourceRepository / SubscriptionRepository / SourceCheckRepository
       -> SecretStore / Cache / JobStore
    -> source-core package               解析、比较、执行、结构化结果
```

Repository 是应用侧端口，不是规则解析器的内部全局状态。Supabase/RLS 设计见 [归档](../archive/storage-and-supabase.md)。

## 关键边界

- HTML 解析器产生的 DOM 是规则输入；`getElements` 只在规则执行内部返回 DOM 节点引用或适配对象，公开 DTO 不包含节点或脚本句柄。
- JSONPath 规则可以返回对象、数组或标量；进入 `getString`/`getStringList` 时才转换为文本。
- 规则执行错误和网络错误必须带阶段、字段、书源 URL 和规则标识。编辑器内部诊断可以按权限保留受控原文；公共 DTO、日志和审计记录使用脱敏 URL、规则 ID 和摘要。
- `mainJs` 与声明式规则是两条执行路径；不能将 JavaScript 书源自动转换成声明式规则后丢弃原脚本。

媒体、登录和交互能力由核心声明端口、宿主能力和应用服务共同承担：核心描述输入、输出和能力要求，宿主执行网络/字节/浏览器操作，应用层负责用户确认、凭据、UI 和持久化。Repository 属于应用边界，不是规则解释器的全局状态。

## 统一处理流程

以下边界描述 source-core 工作流的执行顺序；Android 调用关系仍以本页上方事实图和各流程文档中的“Android 实际”段落为准。

每次工作流调用接受端口与输入：

```ts
discoverBooks(ports: WorkflowPorts, input: DiscoveryInput): Promise<RuntimeResult<...>>
searchBooks(ports: WorkflowPorts, input: SearchInput): Promise<RuntimeResult<...>>
loadBookDetails(ports: WorkflowPorts, input: DetailInput): Promise<RuntimeResult<...>>
loadTableOfContents(ports: ReadingPorts, input: TocInput): Promise<RuntimeResult<...>>
loadChapterContent(ports: ReadingPorts, input: ContentInput): Promise<RuntimeResult<...>>
```

`RuntimeResult` 至少包含 `status`、可选 `value`、`diagnostics` 和 `trace`。空列表或无匹配属于 `empty`；取消、能力缺失和部分成功必须使用可判别状态，不能只返回空值。历史目标设计中的 `effects` / `changes` / `cleanup` 信封尚未实现，见 [运行时统一契约](../implementation/runtime-contracts.md)。

所有领域流程都遵循同一条边界：

```text
上层输入 DTO
  -> 书源分流
  -> source-core 解释请求选项、展开 URL 并生成请求计划
  -> NetworkHost 执行请求
  -> 规则端口求值（compileRule / evaluateRule 等价路径）
  -> 领域对象归一化
  -> 领域级去重、分页、排序或正文处理
  -> 返回 RuntimeResult（status / value / diagnostics / trace）
  -> 应用自行提交持久化
```

核心流程输出“结果加变更”，宿主或上层应用负责提交变更。每个阶段都要明确成功、空结果、可继续错误、终止错误、取消和清理行为；领域流程分别见发现、搜索、详情、目录和正文文档。应用调用顺序见 [独立 package 的调用契约](../implementation/package-usage.md)。

“结果加变更”用于领域对象；Cookie、source.putVariable、脚本 cache 和批量回存可能在执行期间即时生效，不能假设整次调用可回滚。它们通过同一受控宿主记录 effects，具体时机见 [状态与副作用](../standard/state-and-effects.md)。

远程导入、订阅刷新和编辑均使用同一 codec；静态规则预览与生产流程使用同一解释器。执行层依赖端口，端口实现可以调用网络和存储，但不依赖 UI。公开类型仅含可序列化数据；DOM/脚本句柄留在调用内部。

书源保存、删除和检测是完整的业务流程，不是 DTO 转换：保存需要用户确认、版本条件写入、规则变化后的检查失效和缓存清理；检测需要固定 source snapshot、阶段依赖、取消及旧结果防覆盖。对应流程见 [书源保存](../archive/source-persistence-flow.md) 和 [书源检测](../flows/source-check-flow.md)。
