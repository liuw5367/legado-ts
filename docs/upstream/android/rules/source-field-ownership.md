# Android 书源字段所有权与导入合并

本文整理固定 Android 基线中的字段所有权、导入保留和订阅更新行为。它是上游行为证据，不是 TypeScript 的 Repository 或 `SourceSnapshot` API；本项目采用的兼容要求见[兼容政策](../../../contracts/compatibility-policy.md)，未实现的统一管理接口见[书源管理与状态归档](../../../archive/source-management-and-state.md)。

## Android 的字段分层

Android 的 `BookSource` 是书源交换和数据库实体，`bookSourceUrl` 是主键。规则、请求、脚本、登录配置、`enabled`、`enabledExplore`、`customOrder`、`weight`、分组、`lastUpdateTime` 和 `respondTime` 都可以出现在实体中，但它们的写入来源不同：

| 字段族 | Android 中的事实所有者 | 备注 |
| --- | --- | --- |
| `bookSourceUrl`、名称、规则、请求和脚本 | 导入/编辑/订阅得到的 `BookSource` 行 | URL 按原字符串匹配；不按尾斜杠、大小写或 query 归一化 |
| `enabled`、`enabledExplore`、`customOrder`、`weight`、分组 | 本地书源管理和用户设置 | 是否由导入保留受 `AppConfig.importKeep*` 和导入路径控制 |
| `lastUpdateTime` | 远端源元数据 | 用于订阅更新比较，不等于检查任务版本 |
| `respondTime` | 检查/请求后的统计摘要 | 持久化在 `BookSource`，不是单独的检查会话对象 |
| Cookie、源变量和运行缓存 | 各自的 DAO/运行时存储 | 不属于普通书源 JSON 的配置字段，删除清理也不是同一事务 |

Android 的交换 JSON 可以带管理字段，但这些字段并不因此拥有相同的覆盖权限。未知字段由具体序列化路径决定是否保留，不能从一个导入入口推断所有入口都相同。

## 导入和订阅更新

`RuleUpdate` 的两条路径行为不同：

1. 静默更新（`RuleUpdate.cacheSource` 的 `silentUpdate` 分支）按 `lastUpdateTime` 判断远端是否较新，然后使用 `BookSourceDao.insertSources` 的 `REPLACE` 写入整行；该路径只特殊保留 `bookSourceGroup`。它不会执行通用的字段级 CAS，也不产生“远端缺失待确认”的状态。
2. 非静默导入经过导入页差异确认。`ImportBookSourceViewModel.importSelect` 根据 `AppConfig.importKeepName`、`importKeepGroup`、`importKeepEnable` 和当前选择保留部分本地值；`customOrder` 的保留规则与启用开关不同，不能概括成“所有用户字段都保留”。

书源内容变化由 `BookSource.checkContent()` 判断，排除 `customOrder`、`enabled`、`enabledExplore`、`lastUpdateTime`、`respondTime` 和 `weight` 等管理/统计字段；`BookSource.equal()` 的比较范围更宽，会包含管理字段和分组。两者不能互换为一个“源指纹”。

导入和编辑通常先保留原始 JSON 文本，结构化修改后再生成规范化对象。规则对象、显式 `null`、空字符串和缺失字段是否保持原形态取决于 codec/序列化入口；不能因为表单没有控件就静默删除未知字段。

## 删除、改名和状态清理

`SourceHelp.deleteBookSource` 会清理源变量和相关运行缓存，但当前 Android 代码没有同步清理 Cookie 表的关联删除调用。JS 源改名会检查目标冲突，迁移时保留启用、分组、排序和权重等用户状态；`bookSourceUrl` 或 `exploreUrl` 变化会清理 `exploreKindsCache`，`jsLib` 变化会移除 `SharedJsScope`。

`SourceHelp.insertBookSource` 通过异步 `adjustSortNumber()` 处理排序值：当 `maxOrder > 99999`、`minOrder < -99999` 或存在重复排序值时，才把全部 `customOrder` 重排为索引。删除源、重建源和仅编辑管理字段不是同一种操作，应用适配器必须分别记录可观察副作用。

## 迁移使用限制

Android 的这些行为证明兼容事实，不直接规定 Node/Web 的数据库键、用户隔离或版本 CAS。TypeScript 项目已接受的差异、必须保留的未知字段和能力缺失诊断见[兼容政策](../../../contracts/compatibility-policy.md)；`UserSourceState`、`SourceSnapshot`、`SourceRepository` 等统一模型属于历史目标，见[书源管理与状态归档](../../../archive/source-management-and-state.md)。
