# 书源检测流程

## 目的与边界

书源检测是诊断书源当前可用性的独立流程，不等同于用户搜索，也不等同于导入校验。它使用一份不可变的 source snapshot，按阶段执行最小请求，记录每个阶段的结果和耗时，并在版本仍然有效时回写检查状态。

package 对外提供检测编排和结果模型；应用层提供 HTTP/浏览器运行时、任务调度、权限和持久化。检测不应把书、章节或正文保存为用户阅读数据。

## 数据流

```text
读取用户 source snapshot
        │
        ▼
创建 checkSession + checkRevision，状态 NEEDS_CHECK → RUNNING
        │
        ▼
逐书源隔离执行：超时、取消、阶段日志、错误归类
        │
        ├─ domain
        ├─ search（需要 searchRule）
        ├─ discovery/explore（需要 exploreRule）
        └─ info → category/toc → content（依赖可用的书籍样本）
        │
        ▼
聚合 SourceCheckResult[]
        │
        ├─ sourceRevision 已变化 ──► 丢弃回写，仅返回 stale
        └─ 版本仍有效 ──► 写入通过/失败/取消状态和统计
```

## 检测配置

```ts
export interface SourceCheckConfig {
  /** 单个请求的超时时间；不能让一个失效源阻塞整批任务。 */
  timeoutMs: number;
  /** 失败时是否把简短错误写入书源备注；Android 的 `wSourceComment` 默认 true，并以 `// Error: ` 前缀写入书源注释。 */
  writeErrorComment: boolean;
  /** 是否检查域名、基础连接和 URL 可达性。 */
  domain: boolean;
  /** 是否用固定关键字验证搜索规则。 */
  search: boolean;
  /** 是否验证发现/分类入口和 exploreRule。 */
  discovery: boolean;
  /** 是否从搜索或发现结果验证详情规则。 */
  info: boolean;
  /** 是否验证目录规则；文件型书源可跳过。 */
  category: boolean;
  /** 是否请求并验证正文规则；必须受超时和大小限制。 */
  content: boolean;
  /** 可选的检测关键字；为空时使用实现定义的安全默认值。 */
  keyword?: string;
}
```

默认超时、错误备注、域名/搜索/发现/详情/目录/正文开关与 Android 的 `CheckSource` 配置对应；其中错误备注默认开启并写 `// Error: ` 前缀。配置属于检测任务，不应混入可导出的 `BookSource` JSON。

## 阶段和依赖

| 阶段 | 前置条件 | 输入 | 成功标准 | 失败影响 |
| --- | --- | --- | --- | --- |
| domain | 有有效书源 URL | URL、请求客户端 | DNS/连接/响应满足策略 | 标记域名失败；可继续收集其他阶段证据 |
| search | `searchRule` 存在 | 安全关键字 | 得到可解析的书籍结果 | 详情阶段没有可靠样本时跳过 |
| discovery | `exploreRule` 存在且有入口 | 分类/发现 URL | 至少得到一个可解析结果 | 可继续搜索路径 |
| info | 有搜索或发现样本 | 详情 URL、`bookInfoRule` | 书名/作者等核心字段可提取 | 目录/正文通常跳过 |
| category | 有详情样本且非文件源 | 目录 URL、`tocRule` | 得到非空章节列表 | 正文阶段按样本策略跳过 |
| content | 有章节样本且 `contentRule` 存在 | 正文 URL | 得到非空、可接受的正文 | 仅当前书源正文失败 |

“空结果”与“执行失败”必须分开：搜索成功但无结果是业务结果；网络错误、解析异常、超时和规则缺失是诊断结果；由于前置阶段失败而未执行是 `SKIPPED`，不能伪装成 `PASSED`。

文件型书源、仅 RSS 的书源、需要登录的书源和 JS 专用书源要在能力探测时标记限制。缺少可公开凭据时，登录相关阶段应为 `UNSUPPORTED` 或 `SKIPPED`，而不是把整个任务误报为规则错误。

## 单书源执行流程

1. 在开始时固定 `sourceRevision` 和脱敏后的 source snapshot，禁止任务中途读取“最新书源”。
2. 为书源创建独立超时和取消边界；一个源失败不应中断其他源。
3. 按配置执行阶段。每个阶段记录 `startedAt`、`finishedAt`、请求 URL（脱敏 query/header）、HTTP 状态、解析结果摘要和错误分类。
4. 在详情、目录和正文阶段使用前置阶段得到的第一个可靠样本，避免无限遍历全站；样本选择规则必须稳定并可测试。
5. 聚合阶段结果、总耗时、错误信息和可展示的建议。不要把远程响应原文或秘密写入普通日志。
6. 回写前以 `(userId, sourceId, sourceRevision, checkSessionId)` 做条件检查。版本不一致则标记结果 `STALE` 并丢弃持久化更新。

## 状态转换

以下状态机为 Web 目标设计。Android 的 `BookSourceCheckState` 只有 `NEEDS_CHECK`/`PASSED`/`FAILED` 三种持久化状态；`RUNNING` 只存在于会话层，`CANCELLED` 与 `STALE` 在 Android 没有对应持久化状态，版本过期、书源已删除或回写失败在会话结果层以 `CheckSourceStatus.NOT_COMPLETED` 表达；用户取消时未处理的书源仅从会话快照缺失，不会合成该状态。

```text
NEEDS_CHECK ──start──► RUNNING ──all stages pass──► PASSED
      │                    │
      │                    ├─ stage error ──► FAILED
      │                    ├─ user stop ────► CANCELLED
      │                    └─ source edited ► STALE
      └────────────── source edited ───────────────► STALE
```

状态模型、`sourceRevision/checkRevision` 的条件写入和旧结果防覆盖规则见[书源检测状态模型](../reference/source-check-state.md)。删除或重新导入书源时，旧检测任务即使晚到也不得恢复已删除的状态。

## 结果契约

```ts
export type SourceCheckStage =
  | "domain"
  | "search"
  | "discovery"
  | "info"
  | "category"
  | "content";

export interface SourceCheckResult {
  /** 本次检测会话标识。 */
  sessionId: string;
  /** 被检测的用户和书源。 */
  userId: string;
  /** 被检测的原始 bookSourceUrl/sourceId。 */
  sourceId: string;
  /** 开始检测时的书源版本。 */
  sourceRevision: string;
  /** 最终状态或实时阶段状态，使用规范的大写状态。 */
  status: SourceCheckStatus;
  /** 每个阶段的结构化结果；跳过阶段也要有记录。 */
  stages: Array<{
    /** 阶段名称。 */
    stage: SourceCheckStage;
    /** 该阶段的结论，不把 SKIPPED 当作 PASSED。 */
    status: SourceCheckStageStatus;
    /** 阶段耗时；未执行阶段为空。 */
    durationMs?: number;
    /** 稳定错误码；通过或跳过时为空。 */
    errorCode?: string;
    /** 脱敏、可展示的诊断文本。 */
    message?: string;
  }>;
  /** 供列表展示的脱敏摘要。 */
  summary: string;
}
```

实时事件可以复用同一结果模型的增量版本，但客户端不能把 `RUNNING` 结果当作最终通过。若兼容层输出小写状态，必须按[状态模型](../reference/source-check-state.md)的映射表转换；WebSocket 或 SSE 只是应用传输方式，检测核心不应依赖某一种推送协议。

## Android 兼容语义

Android 检测接口会从当前书源快照启动会话，校验提交的 source snapshot/checkContent，并用会话 token 停止任务；DAO 在完成回写时还会检查版本，避免旧任务覆盖新结果。启动时 `BookSourceDao.beginCheck` 会把每个仍有效的待检源重置为新的 `NEEDS_CHECK` 状态并更新 `checkRevision`；书源在排队期间被修改则跳过重置，不写新状态；该源随后因 `lastUpdateTime`/`checkRevision` 不匹配在结果层记 `NOT_COMPLETED`（"书源已变更，校验结果未写回"），不执行实际检测。移植时保留这些语义，但把 Android token、WebSocket 子协议和 DAO 细节放在 adapter 层。

Android 服务还会分别统计响应时间、域名错误、搜索/发现错误、详情/目录/正文错误，并可把失败书源按原因分组。失败书源的分组标签（如 `校验超时`、`js失效`、`网站失效`、`搜索失效`、`发现失效`、`域名失效`）与 `// Error: ` 错误注释只修改内存中的 source 对象（`CheckSourceService` 无 `bookSourceDao.update` 调用），随 `completeCheck` 的 detail 字符串持久化到 `book_source_check_states.detail` 字段，不更新 `book_sources` 行的分组或备注。package 应提供结构化 stage result，让应用自行决定列表分组、错误备注和通知方式。

## 应用责任

- 从当前用户上下文读取允许检测的 sourceId，并在服务端再次授权。
- 限制批量大小、并发数、请求体、响应体和单源总耗时，避免公共部署被书源拖垮。
- 提供 start/status/stop 三类任务接口；任务状态存储不能只放在单个 Vercel 实例内存中。
- 检测失败时保留上次成功状态和最近一次失败证据，必要时提供重试；不要自动删除书源。
- 向用户展示脱敏错误，维护可观测性和审计记录。

## 验收标准

- 配置关闭某阶段时，该阶段明确为 `SKIPPED`，不会偷偷发请求。
- 搜索无结果、规则缺失、网络错误、超时、取消和版本过期均能区分。
- 单个书源失败不会中断批量任务；单个阶段失败不会产生虚假的下游通过。
- 新版本书源提交后，旧检测结果不能回写；删除后不能重建状态。
- 同一编排既能由 Node 运行，也能在受限 Edge 环境中通过 capability 检查明确拒绝不支持的执行器。
