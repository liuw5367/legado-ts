# 书源订阅与刷新

本章是 Web 目标设计。已有 Android 导入行为见 [导入协议](import-protocol.md)。链接返回 JSON 数组属于一次导入；保存链接并持续刷新是另一个显式操作，不把两者混称为订阅。`BookSource`、`RssSource` 和 `ReplaceRule` 的实体边界见[书源相关实体边界](../reference/artifact-model.md)。

## 数据和职责

| 字段 | 契约 |
| --- | --- |
| subscriptionId | 应用生成的非空不透明身份，同 URL 可由不同用户分别订阅 |
| url | 用户确认的下载 URL，允许的协议与目标由宿主校验；不是书源 sourceId |
| subscriptionRevision | 应用每次成功提交订阅快照时生成的版本，用于并发刷新比较 |
| lastSuccessAt | 上次成功提交时间，毫秒时间戳；首次刷新前为空 |
| update | 最近一次尝试刷新的时间，毫秒时间戳；Android 在请求前更新它，因此它不是“最近一次成功时间” |
| validators | 可选 ETag/Last-Modified，按请求地址和会话隔离；不是内容正确性的证据 |
| baseline | 上次确认的各源原始配置与内容指纹，按 sourceId 对应；不混入用户覆盖值 |
| bindings | 该订阅提供的源及本地源关联，记录采用的上游版本与本地 sourceRevision |
| lastAttempt | 最近刷新时间和 success/failed/cancelled/conflict 状态，不代替 baseline |

应用拥有订阅记录、调度、确认和事务。package 的 `refreshSubscription` 接收订阅快照、当前本地 artifact 快照、`operationId`、`idempotencyKey` 和取消/预算上下文，下载后复用 `importSources`，返回 `SubscriptionRefreshAttempt`、逐项 diff 和可提交计划。不会自行创建定时器、数据库任务或后台服务。URL 可一次提供多个源，sourceUrls 的外层限制仍然有效。

刷新结果的最小结构为：

```ts
interface SubscriptionRefreshAttempt {
  subscriptionId: string
  operationId: string
  baseSubscriptionRevision: string
  status: 'unchanged' | 'updated' | 'partial' | 'conflict' | 'failed' | 'cancelled' | 'stale'
  startedAt: number
  finishedAt?: number
  diffs: Array<{ sourceId: string; kind: 'added' | 'updated' | 'unchanged' | 'conflict' | 'remote-missing'; fields: string[]; error?: string }>
  commitPlan: { sourceIds: string[]; requiresConfirmation: boolean }
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
}
```

`baseline`、本地快照和远端快照都按 `sourceId` 保存；attempt 只在成功提交后更新 `baseline` 和 `subscriptionRevision`。取消、超时或非法成员保留旧 baseline，并返回可重试的 attempt 状态。

## Android `RuleSub` 兼容

Web 设计中的订阅记录需要能够承接 Android 的 `RuleSub`，但不应把 Android 数据库实体原样暴露为核心 package API。

| Android 字段 | 移植语义 | 处理位置 |
| --- | --- | --- |
| `id` | 订阅身份；迁移时保留为外部映射，不作为 sourceId | 应用存储 |
| `name` | 用户可编辑名称 | 应用元数据 |
| `url` | 下载地址；支持得到多个书源的响应 | 订阅下载器 |
| `type` | 订阅格式/来源类型；当前 `RuleUpdate` 实际分支为 `0=BookSource`、`1=RssSource`、`2=ReplaceRule` | 适配器，进入对应解析与保存策略 |
| `customOrder` | 列表排序 | 用户覆盖 |
| `autoUpdate` | 是否参与自动刷新 | 调度器 |
| `updateInterval` | 以小时为单位的刷新间隔；Android 用 `update + updateInterval * 3600000 > now` 判断是否跳过本次请求 | 调度器 |
| `silentUpdate` | Android 直接采用检测到的更新；Web 安全模式才使用三方差异和无冲突确认策略 | 适配器/应用确认策略 |
| `js` | 访问订阅链接前执行的 JS 规则文本；为空时不执行 | JS capability/适配器 |
| `showRule` | 订阅展示/筛选规则 | 应用展示层或订阅解析器 |
| `sourceUrl` | 订阅项绑定的源链接，可供源运行时调用资源 | baseline 与 binding |

Android 的订阅刷新 `RuleUpdate.cacheSource` 只把响应整体按 `type` 解析为对应实体数组（`GSON.fromJsonArray<BookSource>` 等），不支持 `sourceUrls` 外层 JSON 数组；`sourceUrls` 只属于导入流程（见 [导入协议](import-protocol.md) 的 `parseBookSourceJson`）。因此 `sourceUrls` 逐项解析只适用于 Web 目标或导入适配器，Android-compatible 订阅适配器必须拒绝该形态或显式转入导入协议。订阅与导入请求都支持 `#requestWithoutUA` 标记。移植时应将这些解析和请求选项记录到 refresh plan；自动更新只改变“是否触发刷新”，不改变保存事务。`update` 在 Android 中记录最近一次尝试，网络失败后仍会影响下一次间隔判断；Web 调度器若改用 `lastSuccessAt`，必须在适配层明确记录这是目标策略而非 Android 原样行为。

### `type` 与静默更新的兼容边界

`RuleSub.kt` 的字段注释把替换规则写成类型 `3`，但当前 `RuleUpdate.kt` 的实际 `when` 分支处理类型 `2`。Android 的 `when` 对类型 `3` 没有分支，会静默跳过：不缓存、不写库、也不返回错误。这不是可以静默猜测的映射：适配器必须保留原始整数，Web 目标中类型 `3` 默认返回 `UNSUPPORTED_SUBSCRIPTION_TYPE` 并记录诊断，除非后续 Android 版本证据或迁移决策明确将其映射为 `ReplaceRule`。类型 `1` 和 `2` 不得被当成 `BookSource[]` 解析。

不同实体使用各自的稳定关联键：`BookSource` 使用 `bookSourceUrl/sourceId`，`RssSource` 使用其 `sourceUrl`，`ReplaceRule` 使用规则 `id`。只有 `BookSource` 条目进入本 package 的 source repository；另外两类必须由独立 adapter 或未来扩展 repository 负责，不能把它们强制转换为 `SourceRecord`。

Android `silentUpdate=true` 的实际路径是：发现本地不存在或 `lastUpdateTime` 更旧的条目后直接插入；已有书源只保留本地分组，然后调用 `SourceHelp.insertBookSource`，完成后更新替换规则处理。它没有本流程定义的三方冲突确认。`silentUpdate=false` 时 `RuleUpdate.cacheSource` 不写库，而是把更新后的列表写入 `cacheBookSourceMap[url]` 并返回，由导入流程的 `ImportBookSourceViewModel.importSourceUrl` 消费，进入导入预览和用户确认。Web package 的推荐路径仍是保存前计算 base/remote/local 差异；若兼容 adapter 需要复刻 Android 静默行为，必须显式使用 `android-compatible` 模式，并仍执行用户隔离、版本写入、脚本隔离和秘密保护。

## 刷新流程

```text
读取订阅 subscriptionRevision、baseline 和本地源版本
  -> 请求链接并验证最终地址、大小与内容
  -> 解析整个来源，产生候选及错误
  -> 按 sourceId 比较 baseline、remote、local
  -> 返回新增/更新/相同/冲突/远端缺失
  -> 应用展示差异并确认选项
  -> 比较订阅 subscriptionRevision 和各本地 sourceRevision
  -> 原子保存选中变更、来源关联及成功快照
  -> 发布源版本更新，后续调用使用新快照
```

HTTP 304 只在存在对应成功 baseline 时表示 unchanged；没有 baseline 时重新无条件获取一次，不能把 304 当成空订阅。下载、解析、取消或版本比较失败均保留旧 baseline 和本地源。某来源包含非法成员时，刷新可以展示合法候选，但不发布完整新 baseline，不把缺少的项目标为远端删除。

订阅下载必须复用普通请求的安全边界：只允许应用配置的 `https`/受信协议，限制重定向、响应大小、展开深度和总耗时；每一跳重新执行 SSRF 和凭据策略。`js` 预请求脚本使用独立 operation scope，不得读取其他用户的 Cookie、变量或文件缓存。ETag/Last-Modified 只作为条件请求提示，不能绕过内容解析和权限检查。

## 比较与确认策略

| base / remote / local | diff 与默认处理 |
| --- | --- |
| 无 base，remote 有，本地无 | added，供用户选择导入 |
| remote 与 base 内容相同 | unchanged，保留本地修改 |
| remote 改变，本地仍等于采用的 base | updated，显示差异供确认 |
| remote 与本地都改变相同字段，值不同 | conflict，不自动覆盖 |
| 两边改变互不相交字段 | 可生成合并候选，但仍显示具体字段变化 |
| remote 不再包含 base 的源 | remote-missing，默认保留本地源和来源记录，不自动删除 |
| 同批 remote 重复 sourceId 且配置不同 | conflict，不使用最后一个静默覆盖 |
| 多个订阅提供同 sourceId | 多来源冲突，保留来源身份，由应用选择采用项 |

用户字段 `bookSourceName`、`bookSourceGroup`、`enabled`、`enabledExplore`、`customOrder` 默认保留本地值，同时保留远端原值供比较。规则对象按字段路径比较；mainJs 作为整体文本比较，不能自动拼接两段脚本。没有本地编辑记录时，用本地配置与已采用 baseline 比较确定变化。

内容指纹基于保留未知字段的结构化内容；对象 key 排序用于指纹，不改变导出文本，数组顺序和字符串内容参与比较。时间戳相同但内容不同仍是变更；时间戳更大但内容相同仍是 unchanged。导入替换后的有效候选与远端原文分别保存，变更替换规则必须重新计算候选。

失败刷新不能清空本地数据。取消订阅只解除订阅记录与关联；是否删除已导入书源是独立用户动作。订阅不自动成为可信脚本来源，远端新 JS 必须经过同一隔离和权限边界。

## 验收

`SUB-001`：远端 `[A,B]`、本地为空，得到两个 added，确认前写入为零。
`SUB-002`：base 的 A 搜索 URL 为 `/a`，remote 为 `/b`，local 为 `/c`，得到冲突，local 保持 `/c`。
`SUB-003`：base `[A,B]`、remote `[A]`，B 为 remote-missing，本地 B 保留。
`SUB-004`：远端超时或数组中一个非法对象，baseline、revision 和本地源均不变。
`SUB-005`：两个刷新基于 revision=r1，先提交者变为 r2，后提交者报告 conflict。
`SUB-006`：304 且已有 baseline 返回 unchanged；无 baseline 只进行一次无条件重取。
`SUB-007`：remote 修改 A 规则，local 只修改分组，候选采用远端规则并保留本地分组。
`SUB-008`：同时间戳但 mainJs 改变，报告更新或冲突，不视为相同。
`SUB-009`：RuleSub 的 `autoUpdate=false` 时调度器不请求；到期且为 true 时才创建刷新任务。
`SUB-010`：Web safe 静默刷新只自动采用无冲突变更，规则冲突和远端删除保留待用户确认；Android-compatible 模式按兼容策略直接采用更新，并单独记录该副作用。
`SUB-011`：Web 目标或导入适配器收到 `sourceUrls` 数组时逐项解析；一个非法成员有逐项诊断，不覆盖旧 baseline；Android-compatible 订阅入口不把该数组当作 `RuleUpdate` 响应。
`SUB-012`：`#requestWithoutUA` 只影响该请求的 User-Agent 策略，不改变 sourceId、缓存键或鉴权策略。
`SUB-013`：`update` 为最近一次尝试时间；未到 `updateInterval` 时不发请求，到期后请求前先更新尝试时间，失败不能冒充 `lastSuccessAt`。
`SUB-014`：`type=0` 解析并比较 `BookSource[]`，`type=1` 解析 `RssSource[]`，两者不能共用错误的实体解析器或主键。
`SUB-015`：`type=2` 解析 `ReplaceRule[]`，内容或预览样本变化进入更新；静默提交后触发替换规则重建。
`SUB-016`：收到 `type=3` 时保留原始类型并返回 `UNSUPPORTED_SUBSCRIPTION_TYPE`，不得未经决策静默映射为 `type=2`。
`SUB-017`：Android 兼容静默更新只保留本地分组并直接采用远端更新；Web 安全模式对规则冲突不自动覆盖，两个模式的结果和审计信息可区分。
`SUB-018`：同一订阅刷新失败、取消或出现非法成员时，旧 source snapshot、baseline、revision 和成功时间均保留；尝试时间和失败诊断可更新。

以上为设计案例，尚无运行断言；证据与实现状态遵循 [测试基线](../quality/conformance-tests.md)。
