# Android 书源校验状态

本文记录 Android `BookSourceCheckState`、校验任务版本和阶段结果的来源事实。项目中的 CLI/Web 状态映射和未实现的统一检测 Repository 分开维护；不要把下方 Android 状态名称直接当作 `source-core` 的 `RuntimeResult`。

## 持久状态

Android 的 `BookSourceCheckState` 最终状态只有：

- `NEEDS_CHECK`：尚未完成校验，或书源内容变化后需要重新校验；
- `PASSED`：配置的检查阶段完成；
- `FAILED`：至少一个检查阶段失败。

`BookSource.respondTime` 是 `BookSource` 上的响应时间摘要（`BookSource.kt` L77），不是检查会话级指标。检查状态的详情、阶段和版本在 `BookSourceCheckState`/`BookSourcePart` 中由查询投影展示；状态本身不进入书源导出 JSON。

## 开始、阶段和完成

`BookSourceDao.beginCheck` 在启动时重置仍然有效的源为 `NEEDS_CHECK`，生成新的任务 `revision`，并保留当前 `sourceRevision`。写回 `finishCheck` 使用 `status = 'NEEDS_CHECK' AND revision = :revision` 的条件；源已经被修改、删除或被另一个任务重新开始时，旧结果返回 false，不落入新的持久状态，也不覆盖新的源定义。

Android 检查顺序由 `CheckSourceService` 和相关 stage 代码确定：域名/请求可用性、搜索、发现、详情、目录和正文按配置执行；每个阶段保存可展示的错误摘要和耗时。阶段关闭时应明确跳过，不能把未执行当成通过。旧客户端的 `info`/`category` 等名字属于 adapter 输入别名，实体状态使用 Android 实际字段。

## 取消与删除

服务通过 `IntentAction.stop` 发送停止消息，取消 `checkJob`；取消中的源不应被写成 `PASSED` 或把未开始阶段误报成失败。源删除或重新导入会使关联的检查结果失效，迟到的 `finishCheck` 不能重建已删除的状态。

## 与项目实现的边界

`RUNNING`、`CANCELLED`、`STALE`、`sessionId`、统一 `SourceCheckRepository` 和跨用户 CAS 是项目目标设计，不是 Android `BookSourceCheckState` 当前提供的枚举或接口。reader-cli 的实际检测入口和小写运行时状态见 [CLI 实现](../../../../apps/reader-cli/docs/implementation.md)；兼容性状态和未满足条件见[能力状态](../../../compatibility/status.md)；目标 Repository 见[书源管理与状态归档](../../../archive/source-management-and-state.md)。
