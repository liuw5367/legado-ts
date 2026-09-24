# 阶段 C：发现、搜索、详情、目录与正文

**状态：** 已完成（2026-09-24 按代码与测试核对）。

本阶段使用 B 的 Node/基础 JS 宿主实现声明式和 JS 主流程，并通过最小真实部署验收。流程只调用共享层，不重新解释规则。行为以 [搜索流程](../flows/search-flow.md)、[详情流程](../flows/book-info-flow.md)、[目录流程](../flows/chapter-list-flow.md)、[正文流程](../flows/content-flow.md) 和 [发现流程](../flows/explore-flow.md) 为准。

## 阶段公共契约

每个流程入口的**目标契约**接收不可变 `SourceSnapshot`、领域输入、`requestId`、`operationId`、预算、`RuntimeHost` 和 `AbortSignal`；输出包含 `status`、领域值、逐阶段诊断、effects、changes 和 cleanup。**当前实现**接收 `WorkflowPorts` / `ReadingPorts` 与领域 `*Input`，返回 `RuntimeResult`（无 `stale`；无 effects/changes/cleanup 信封，见 [已知差异](../divergence/known-divergences.md)）。`success`、`empty`、`partial`、`failed`、`cancelled`、`capability-missing` 的含义与[运行时统一契约](runtime-contracts.md)一致。

书源级失败只能影响当前源，流程级存储/清理失败必须升级为流程诊断；空搜索、空目录、卷节点空正文和文件源下载地址缺失分别按各流程定义，不把所有空值统一成成功。已提交的缓存、Cookie、变量或用户确认副作用不因后续取消自动回滚；未通过版本/CAS 的 changes 不得提交。

## 共同调用框架

公开入口接收不可变书源快照、领域输入、请求身份和取消信号（当前为 `WorkflowPorts` / `ReadingPorts` 端口 + `*Input`）。流程创建 `RuleContext`、`RuleVariableView` 并通过端口调用规则与网络能力；返回 `RuntimeResult`（领域值 + 诊断）。调用方核对书源版本及请求所有权后再提交。失败、超时或取消走同一清理路径，不得把部分目录或旧正文写入应用存储。

Node 宿主端口在 B 建立，C 增加领域存储和组合验收。JS 基础配置、网络和 marshaller 是 C 依赖；未实现扩展方法返回具体能力缺失。所有组合测试从公开入口执行，不以手工组装内部处理器替代。

## 发现与搜索

先实现发现分类解释（目标名 `listExploreKinds`；当前随 `discoverBooks` 的分类路径处理），把普通文本、JSON 和 JS 分类解释为分类列表与诊断（差异见 [已知差异](../divergence/known-divergences.md)）。发现列表入口接受应用已经选定的 URL、页码和 `infoMap` 快照，声明式路径请求后使用 `ruleExplore`，其 `bookList` 为空时使用 `ruleSearch`。`enabledExplore` 由应用选择范围时使用，package 不悄悄过滤显式传入的源。

再实现单源与多源搜索入口。当前实现为 `searchBooks`（单源 `SearchInput`）；多源 `searchMany` 是目标设计，应用层多源循环见 `apps/reader-cli`（差异见 [已知差异](../divergence/known-divergences.md)）。单源流程执行请求、登录检测、重定向、列表或详情页回退、字段提取及同源去重。多源流程决定并发、进度和错误隔离，按 [搜索流程](../flows/search-flow.md) 的分组与来源合并规则输出快照。结果存储和成功事件的顺序固定；新搜索或换页生成新的所有权标识，旧请求迟到时只能清理，不能发布或写入结果。

## 详情

`getBookInfo` 使用搜索或发现产生的书籍快照。可复用的 `infoHtml`、请求最终 URL、`loginCheckJs` 和字段执行顺序由详情规格决定。字段覆盖由 `canReName` 与已有用户字段共同控制。文件源生成下载地址集合；缺少必要下载地址是失败。流程返回更新后的 `Book` 和允许写入的变更描述，不直接覆盖用户自定义名称、封面、阅读进度或其他应用数据。

## 目录

`getChapterList` 先判断是否使用详情阶段已有的目录响应，再按条件运行 `preUpdateJs` 和目录请求。单页或多页目录在各自请求上下文中解析，收集完成后统一排序、去重、重新编号、合并旧章节元数据和更新书籍统计。`readConfig.reverseToc` 影响刷新输入顺序，展示层的 `reverseTocDisplay` 不参与持久化顺序。只在最终目录通过校验且当前书源版本仍有效时提交目录变更；分页失败或取消不能提交不完整目录。

## 正文与资源

`getContent` 先以书源、书籍、章节和规则版本查询缓存；未命中时请求章节并执行正文规则。分页时保留顺序、防止循环和越过下一章；再处理副文、全文替换、章节标题及资源地址。文本、音频、视频、图片和文件结果保持类型区别，不能将媒体 bytes 当作 UTF-8 正文。批量正文在阶段 D 完整接入前，普通单章流程仍可使用。

正文保存采用 `ContentSaveToken`：在开始时取得版本，在写入时比较版本；旧请求、旧章节或旧规则的结果不能覆盖新内容。章节元数据与正文按 [正文流程](../flows/content-flow.md) 的边界一同提交。卷节点空正文与非卷章节空正文按各自规则处理，不能统一归为空结果成功。

## 验收与交付

本阶段覆盖 EXP-001–006、FLOW-001–011、HOST、API 的声明式和基础 JS 路径；批量 FLOW-012 在 D。至少从导入开始经过发现/搜索、详情、目录至首章，另外覆盖失败、取消、乱序响应、旧写和缓存冲突。以 DEP-001–007 验证参考 Node 部署，Edge 缺能力按实际报告，不要求伪造通过。

阶段 C 的目标是交付 Node 上声明式和基础 JS 的读取流程；流程入口已实现（`discoverBooks` / `searchBooks` / `loadBookDetails` / `loadTableOfContents` / `loadChapterContent`），扩展能力仍按能力状态报告。WebView、复杂登录及扩展互操作不宣称所有书源兼容。
