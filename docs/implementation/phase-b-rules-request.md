# 阶段 B：规则引擎与请求计划

**状态：** 已完成（2026-09-24 按代码与测试核对）。

规则引擎是书源 package 的解释层，应用和编辑器只通过公开入口使用它。先实现可重复的规则求值与请求描述，再接入真实网络。精确语义以 [规则语言](../standard/rule-language.md)、[URL 与请求规则](../standard/url-request-rules.md) 和 [宿主接口](runtime-host-interfaces.md) 为准；本章说明实现依赖和验证顺序。

## 阶段输入、输出与失败边界

规则入口的**目标契约**接收 `source snapshot + requestId + operationId + RuleContext + budget + AbortSignal + RuntimeHost`，输出 `OperationResult<T>`。结果必须包含 `status`、可选值、诊断、effects、changes 和 cleanup；合法空列表使用 `empty`，脚本/宿主能力缺失使用 `capability-missing`，取消和版本变化分别使用 `cancelled`/`stale`。**当前实现**对应 `compileRule` / `evaluateRule` / `createRequestPlan`，返回 `RuleCompileResult` / `RuleEvaluationResult` / `RequestPlanResult` 或流程层 `RuntimeResult`（无 `RuntimeHost` / `OperationResult` 导出，见 [已知差异](../divergence/known-divergences.md)）。`RuntimeDiagnostic.canContinue` 只决定当前字段能否继续，不能把取消、预算耗尽或资源清理失败降级为普通字段警告。

规则中间表示至少记录 mode、原文、位置、输入类型和下一步输入；请求中间表示至少记录绝对 URL、method、headers、body、charset、重定向策略、responseType、超时、最大请求数和 signal。HTTP 响应保留最终 URL、状态码、响应头和 bytes；重定向、空 body、超时、取消、字节上限和 bodyJs 失败必须分别有稳定诊断。

## 规则求值的实现顺序

1. 建立统一 `RuleContext`：当前书源、书籍、章节、原始响应、基准 URL、`RuleVariableView`、脚本绑定和取消信号。每次公开调用创建新上下文；字段规则在同一流程中按原实现约定共享必要变量。
2. 按[规则语言](../standard/rule-language.md)的兼容边界实现扫描器，区分 RuleAnalyzer 的规则平衡和代码平衡。不得全局保护原实现未保护的引号，不改 JS/WebJS 两次扫描顺序。诊断与求值共享位置记录，但额外诊断不改变执行语义。
3. 对每段规则识别默认/Jsoup、CSS、XPath、JSONPath、Regex 和 JS 模式，输出带原始文本与位置的中间表示。模式选择与求值分开，编辑器诊断和运行时共享同一个扫描结果。
4. 通过解析器端口执行 DOM、XPath 和 JSONPath。核心层解释旧式选择器、节点链、索引、范围、排除、终端文本/属性读取和 `getString`/`getStringList`/`getElements` 的归一化。端口返回节点、对象、列表与标量时保留类型，直到输出 API 确定目标类型。
5. 加入 Regex、捕获组、替换、`@put`、`@get`、`{{}}` 与规则内 JS。明确求值顺序、变量写入范围、空字符串与空列表、单字段失败和取消。没有 JS 宿主时返回能力错误，静态规则仍可求值。
6. 对 `RuleContext` 实现单次调用关闭动作，释放解析文档引用、脚本 scope、临时变量与监听器。诊断输出字段路径、原始规则、稳定错误码和安全的输入摘要。

规则求值先使用固定 HTML、XML、JSON 与文本 fixture。`SCH-001` 至 `SCH-008`、`VAR-001` 和 `VAR-002` 都从公开规则入口执行；解析器端口测试保证节点身份、空值区分和非破坏性索引。Android 与 TypeScript 结果不一致时，先记录差异，再决定兼容修复，不能在编辑器里另写一套解释器。

## URL 与请求计划

URL 层分为请求计划与宿主执行；没有脚本及状态读取的静态展开才是纯函数。依 [URL 与请求规则](../standard/url-request-rules.md) 执行 JS、插值、页码、选项、地址、Header/Cookie 及编码，返回 HttpRequest。宿主返回 bytes，核心通过字符集端口解码后执行 bodyJs/XML 处理。

```text
书源 URL 规则 + page/key/context
  -> 展开与校验
  -> HttpRequest + 请求诊断
  -> Host.request
  -> HttpResponse
  -> 响应归一化与可解析内容
```

URL 展开函数不读取全局 Cookie 或全局配置。登录头、请求 Cookie 和书源变量来自当前调用的宿主视图。重试只作用于允许重试的请求失败，不重新执行已完成的字段规则或保存动作。超时、取消、重定向上限和字节大小限制由宿主落实，核心保持请求阶段与错误码。代理、DNS、WebView 等不能映射到普通 HTTP 的选项先保留请求描述并报告所需能力；对应宿主在阶段 D 提供时再用同一 URL fixture 验证。

URL fixture 同时断言请求描述和执行轨迹。B 先用 fake HTTP 验证，再接入本地可控 HTTP 站点的 Node adapter，验证重定向、Cookie、编码、bytes 和取消；不能以 fake HTTP 宣称真实网络已验证。

## 基础脚本与宿主

按 [运行边界与部署验收](../operations/runtime-security-and-deployment.md) 的候选方向提供受限 JS runtime；先用同步 java.ajax 延迟响应、无限循环终止、嵌套桥接、两会话和句柄清理案例验收，再固定依赖版本。动态 JS 导入与配置配对在此阶段完成，主函数 marshaller 可用固定输入单测。基本编码/bytes 方法与网络一起实现；缺失重载明确 capability-missing。预算必须覆盖脚本时间、调用深度、返回 bytes/字符串大小和并发桥接数；超限后停止新桥接，等待 scope 关闭并返回 `budget-exceeded` 或 `cancelled`。

源码 Java 对象互操作不能默认等价，遇到新重载先补参数/返回/错误案例。宿主提供显式预算、会话 Cookie 和变量视图，关闭视图不清持久数据。若桥接机制不能满足参考环境，记录 B 的 JS 验收阻塞，不增加未经批准的执行服务。

## 完成门槛

阶段 B 交付公开的规则求值入口、URL 请求计划入口、结构化诊断与 fake host。编辑器可以用相同扫描器显示规则阶段和位置，也可以对固定响应预览字段结果。无网络、无用户 Cookie 的条件下，纯规则与 URL fixture 应稳定重放；涉及宿主的能力缺失返回明确错误。此阶段不声称发现、搜索、目录或正文流程已经完成。
