# 书源字段所有权与合并规则

本章定义独立库的目标契约。Android 的订阅刷新、导入保留和版本控制行为与下文目标策略存在差异，差异在"与 Android 实际行为的差异"一节标注。以下名称作为目标契约维护；接口示意不代表已有实现。

本文定义书源字段在导入、编辑、订阅刷新和运行时之间的所有权。它解决“同一个字段由谁修改、保存在哪里、什么时候覆盖”的问题，是 `BookSource` 交换模型与用户源记录之间的桥梁。

## 三层模型

```text
RawSource
  -> NormalizedSource（源配置，来自文件/订阅/编辑器）
  +  UserSourceState（用户状态，来自当前账户）
  -> SourceSnapshot（一次运行使用的不可变合并视图）
```

```ts
export interface UserSourceState {
  /** 当前用户是否允许普通搜索、详情、目录和正文流程使用该源。 */
  enabled: boolean
  /** 当前用户是否允许发现流程使用该源。 */
  enabledExplore: boolean
  /** 用户自定义排序值；不属于远程订阅内容。 */
  customOrder: number
  /** 用户自定义权重；不属于远程订阅内容。 */
  weight: number
  /** 用户分组文本；多个分组仍按 BookSource 原有分隔语义保存。 */
  group: string | null
}

export interface SourceSnapshot {
  /** 当前用户和原始 bookSourceUrl 组成的稳定身份。 */
  sourceId: string
  /** 当前用户作用域。 */
  userId: string
  /** 当前源配置版本。 */
  sourceRevision: string
  /** 已规范化的源配置；不包含 Cookie、密码和 token。 */
  source: NormalizedSource
  /** 已合并的用户状态。 */
  userState: UserSourceState
}
```

`BookSource` 仍然是 Android 兼容的交换投影，可能带有 `enabled`、`enabledExplore`、`customOrder`、`weight` 和分组字段。Repository 内部必须把这些字段映射到 `UserSourceState` 的权威值；不能因为导入 JSON 同时携带这些字段，就让远程订阅静默覆盖用户状态。

## 字段所有权

| 字段族 | 权威所有者 | 订阅更新 | 用户编辑 | 运行时能否修改 |
| --- | --- | --- | --- | --- |
| `bookSourceUrl` / `sourceId` | 源身份 | 只能作为同一条目匹配键 | 改变即新建/改名流程 | 否 |
| `bookSourceName`、规则、请求、脚本 | 源配置 | 可提出更新 | 可编辑 | 否，运行时只读 |
| `enabled`、`enabledExplore`、分组、排序、权重 | 用户状态 | 默认保留 | 可编辑 | 否 |
| `lastUpdateTime` | 源元数据 | 随内容变化更新 | 不作为并发版本编辑 | 否 |
| `respondTime` | 运行统计 | 可由检测/请求更新 | 不参与规则版本 | 受应用策略控制 |
| `unknownFields` | 原文/codec | 保留未知值 | 原文未修改时保留 | 否 |
| Cookie、登录头、变量、脚本缓存 | SecretStore/Host | 不随普通源配置复制 | 由登录或脚本动作产生 | 是，受会话和源隔离 |
| 检测状态、任务、缓存 | 应用存储/Host | 由源版本关联 | 不进入导出 | 是，受版本条件约束 |

## 合并规则

订阅或文件更新按以下顺序处理：

1. 用原始 `bookSourceUrl` 精确匹配当前用户源；不做尾斜杠、大小写或 query 规范化。
2. 解析远程候选，生成新的源配置和未知字段集合。
3. 计算源配置差异；用户状态不参与源内容指纹。
4. 保留当前 `UserSourceState`，除非用户明确选择覆盖。
5. 产生 `SourceChange`，由应用确认后按 `expectedSourceRevision` 提交。

字段级策略：

| 场景 | 结果 |
| --- | --- |
| 远程只改变规则 | 更新源配置，保留用户状态，使检查状态失效 |
| 远程改变名称 | 默认更新显示名称，保留启用、分组、排序和权重 |
| 远程携带管理字段 | 默认忽略其对用户状态的覆盖，并记录诊断 |
| 用户同时编辑同一源 | 返回版本冲突，不自动合并规则文本 |
| 远程删除条目 | 保留本地源并标记订阅缺失，不能自动删除 |
| 用户明确删除 | 走删除流程，按策略清理源专属状态 |

### 与 Android 实际行为的差异

上表和"合并规则"是目标契约，Android 当前行为并不等同：

- 静默订阅更新（`RuleUpdate.cacheSource` 的 `silentUpdate` 分支）只保留 `bookSourceGroup`，其余字段被远端值整体 `REPLACE` 覆盖（`RuleUpdate.kt` L56-61 + `BookSourceDao.insertSources` 的 `OnConflictStrategy.REPLACE`）；非静默导入走导入页差异确认，`customOrder` 总是保留，`enabled`/`enabledExplore` 仅在 `AppConfig.importKeepEnable=true`（默认 false）时保留（`ImportBookSourceViewModel.importSelect` L140-153）。
- Android 没有 `expectedSourceRevision` CAS、没有版本冲突检测、没有远程删除缺失标记；静默路径不比较规则差异，只看 `lastUpdateTime` 整行替换。
- 源内容指纹有两个：`BookSource.checkContent()` 排除 `customOrder/enabled/enabledExplore/lastUpdateTime/respondTime/weight`，用于判断是否需要重置检查状态；`BookSource.equal()` 包含 `customOrder`、`enabled`、`enabledExplore`、`bookSourceGroup` 等用户状态，用于判断整源是否变化。
- 静默更新书源后立即触发 `ContentProcessor.upReplaceRules()`；`SourceHelp.insertBookSource` 通过 `Coroutine.async` 异步调用 `adjustSortNumber()`，在 `maxOrder>99999`、`minOrder<-99999` 或 `hasDuplicateOrder` 时把全部 `customOrder` 重排为索引。
- `SourceHelp.deleteBookSource` 清理源变量和相关运行缓存，但不清理 Cookie 表（`CookieDao` 无关联删除调用）。
- 导入保留行为由 `AppConfig.importKeepName`/`importKeepGroup`/`importKeepEnable` 控制，默认均关闭。

## 导入与导出

- 原文未修改时，优先逐字导出 `rawText`，包括未知字段和规则字段的原始字符串形态。
- 原文被结构化编辑后，以规范化配置和未知字段合成导出；用户状态、秘密、检测状态和运行缓存默认不进入书源 JSON。
- `RuleObject<T>` 的对象/字符串形态必须由 codec 记录；编辑器不能把未修改的规则字符串无故转换为对象。
- 删除字段和缺失字段必须可区分；显式 `null` 不能被当作“未编辑”。
- 导出订阅配置时，订阅元数据单独导出，不能混入 `BookSource` 对象。

## 验收要求

至少需要覆盖：远程更新保留用户状态、管理字段覆盖拒绝、rawText round-trip、未知字段保留、显式 null、版本冲突、源改名冲突和删除后状态清理。具体测试入口见[一致性测试基线](../quality/conformance-tests.md)。
