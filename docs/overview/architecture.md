# 架构与职责映射

## 当前实现的调用关系

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

## TypeScript 目标分层

### 纯核心层

核心层解释书源规则，并通过宿主端口编排流程：

- schema 解析和导入分类；
- 发现分类解释、选定分类后的列表流程；
- 规则文本词法拆分、模式选择和规则链执行；
- 结果归一化、替换、变量作用域和 URL 解析；
- 搜索/详情/目录/正文流程状态机；
- 并发、超时、取消的抽象约定。

### 宿主端口

以下能力通过依赖注入提供：

- `HttpClient`：请求、响应、重定向和响应字节；
- `HtmlParser`：Jsoup 兼容的 HTML/CSS/属性/文本节点访问；
- `XPathParser` 与 `JsonPathParser`；
- `JavaScriptRuntime`：受限脚本执行、超时和取消；
- `CookieStore`、`CacheStore`、`VariableStoreFactory`、`Logger`、`RateLimiter`；
- `JavaApi`、`SourceApi`：仅作为 JS 源脚本的受限兼容外观，由宿主按 capability 注入。

### 上层应用

上层应用负责书源列表、当前用户持久化、搜索与发现进度展示、登录页面、代理路由和编辑器 UI。上层不能自行重新解释规则字段；预览和运行时必须调用同一个核心解析器。书源交互能力通过版本化宿主接口与应用对接，不因属于 Android UI 就从能力清单中删除。

书源管理还需要独立于规则执行的应用服务：

```text
请求用户/认证
    -> SourceApplicationService
       -> SourceRepository       当前源、版本、用户覆盖
       -> SubscriptionRepository 订阅、基线和关联
       -> SourceCheckRepository  检测会话和状态
       -> SecretStore            cookie、token、密码引用
       -> Cache/JobStore         可重建缓存和异步任务
    -> source-core package       解析、比较、执行、结构化结果
```

Repository 是 package 的端口实现，不是规则解析器的内部全局状态。这样 SPA、Next.js SSR、Node function 和受限 Edge adapter 可以共享同一核心；Supabase/RLS 只出现在应用边界，详见 [存储与 Supabase 部署方案](../operations/storage-and-supabase.md)。

## 关键边界

- HTML 解析器产生的 DOM 是规则输入；`getElements` 只在规则执行内部返回 DOM 节点引用或适配对象，公开 DTO 不包含节点或脚本句柄。
- JSONPath 规则可以返回对象、数组或标量；进入 `getString`/`getStringList` 时才转换为文本。
- 规则执行错误和网络错误必须带阶段、字段、书源 URL 和规则标识。编辑器内部诊断可以按权限保留受控原文；公共 DTO、日志和审计记录使用脱敏 URL、规则 ID 和摘要。
- `mainJs` 与声明式规则是两条执行路径；不能将 JavaScript 书源自动转换成声明式规则后丢弃原脚本。

媒体、登录和交互能力由核心声明端口、宿主能力和应用服务共同承担：核心描述输入、输出和能力要求，宿主执行网络/字节/浏览器操作，应用服务负责用户确认、凭据、UI 和持久化。Repository 是 `SourceApplicationService` 使用的端口实现，不是规则解释器的全局状态。

## TypeScript 目标：统一处理流程

以下流程是 TypeScript 目标设计。当前 Android 调用关系仍以本页上方的事实图和各流程文档中的“Android 实际”段落为准。

每次领域调用至少接受以下输入：

```ts
interface OperationInput {
  source: SourceSnapshot
  requestId: string
  operationId: string
  options: Record<string, unknown>
  budget: { timeoutMs?: number; deadlineMs?: number; maxRequests?: number }
  signal?: AbortSignal
  host: RuntimeHost
}
```

领域结果至少包含 `status`、可选 `value`、诊断、已发生的 `effects`、尚未提交的 `changes` 和清理结果。空列表或无匹配属于 `empty`；取消、版本不匹配、能力缺失和部分成功必须使用可判别状态，不能只返回空值。取消请求与资源释放是两个完成条件：操作结算后，资源所有者仍须完成请求、脚本、监听器和并发子任务的清理；已提交的外部副作用不因取消自动回滚。

所有领域流程都遵循同一条边界：

```text
上层输入 DTO
  -> 创建 requestId、VariableStore、RuleVariableView、RuleContext 和 AbortSignal
  -> 书源分流
  -> URL 展开与请求计划
  -> Host 执行请求
  -> AnalyzeRule 等价规则解析
  -> 领域对象归一化
  -> 领域级去重、分页、排序或正文处理
  -> 生成事件、诊断和持久化变更
  -> 上层提交或返回 DTO
  -> finally 清理请求资源并结算 cleanup
```

核心流程输出“结果加变更”，宿主或上层应用负责提交变更。每个阶段都要明确成功、空结果、可继续错误、终止错误、取消和清理行为；领域流程分别见发现、搜索、详情、目录和正文文档。应用调用顺序见 [独立 package 的调用契约](../guides/package-usage.md)。

“结果加变更”用于领域对象；Cookie、source.putVariable、脚本 cache 和批量回存可能在执行期间即时生效，不能假设整次调用可回滚。它们通过同一受控宿主记录 effects，具体时机见 [状态与副作用](../reference/state-and-effects.md)。

远程导入、订阅刷新和编辑均使用同一 codec；静态规则预览与生产流程使用同一解释器。执行层依赖端口，端口实现可以调用网络和存储，但不依赖 UI。公开类型仅含可序列化数据；DOM/脚本句柄留在调用内部。

书源保存、删除和检测是完整的业务流程，不是 DTO 转换：保存需要用户确认、版本条件写入、规则变化后的检查失效和缓存清理；检测需要固定 source snapshot、阶段依赖、取消及旧结果防覆盖。对应流程见 [书源保存](../workflows/source-persistence-flow.md) 和 [书源检测](../workflows/source-check-flow.md)。
