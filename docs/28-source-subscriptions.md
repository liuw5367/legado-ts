# 书源订阅与刷新

本章是 Web 目标设计。已有 Android 导入行为见 [导入协议](03-import-protocol.md)。链接返回 JSON 数组属于一次导入；保存链接并持续刷新是另一个显式操作，不把两者混称为订阅。

## 数据和职责

| 字段 | 契约 |
| --- | --- |
| subscriptionId | 应用生成的非空不透明身份，同 URL 可由不同用户分别订阅 |
| url | 用户确认的下载 URL，允许的协议与目标由宿主校验；不是书源 sourceId |
| revision | 应用每次成功提交订阅快照时生成的版本，用于并发刷新比较 |
| lastSuccessAt | 上次成功提交时间，毫秒时间戳；首次刷新前为空 |
| validators | 可选 ETag/Last-Modified，按请求地址和会话隔离；不是内容正确性的证据 |
| baseline | 上次确认的各源原始配置与内容指纹，按 sourceId 对应；不混入用户覆盖值 |
| bindings | 该订阅提供的源及本地源关联，记录采用的上游版本与本地 sourceVersion |
| lastAttempt | 最近刷新时间和 success/failed/cancelled/conflict 状态，不代替 baseline |

应用拥有订阅记录、调度、确认和事务。package 的 `refreshSubscription` 接收上述快照和当前本地源，下载后复用 importSources，返回 diff 和可提交计划。不会自行创建定时器、数据库任务或后台服务。URL 可一次提供多个源，sourceUrls 的外层限制仍然有效。

## 刷新流程

```text
读取订阅 revision、baseline 和本地源版本
  -> 请求链接并验证最终地址、大小与内容
  -> 解析整个来源，产生候选及错误
  -> 按 sourceId 比较 baseline、remote、local
  -> 返回新增/更新/相同/冲突/远端缺失
  -> 应用展示差异并确认选项
  -> 比较订阅 revision 和各本地 sourceVersion
  -> 原子保存选中变更、来源关联及成功快照
  -> 发布源版本更新，后续调用使用新快照
```

HTTP 304 只在存在对应成功 baseline 时表示 unchanged；没有 baseline 时重新无条件获取一次，不能把 304 当成空订阅。下载、解析、取消或版本比较失败均保留旧 baseline 和本地源。某来源包含非法成员时，刷新可以展示合法候选，但不发布完整新 baseline，不把缺少的项目标为远端删除。

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

以上为设计案例，尚无运行断言；证据与实现状态遵循 [测试基线](15-conformance-tests.md)。
