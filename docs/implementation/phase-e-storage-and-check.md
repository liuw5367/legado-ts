# 阶段 E-1：书源持久化、订阅刷新与书源检测

本阶段把前面已经定义的 codec、规则执行和领域流程接入用户数据，但仍不实现完整阅读应用。目标是让 package 的运行结果可以安全地保存、并发更新、检测和刷新，同时保持 package 不依赖 Supabase 或具体 Web 框架。

## 依赖与交付

依赖阶段 A 的 `NormalizedSource/ImportCandidate`、阶段 C 的流程结果和阶段 D 的订阅差异入口；实体与订阅类型以[书源相关实体边界](../reference/artifact-model.md)为准。交付：

- [Repository 规范](../reference/source-management-and-state.md#3-repository-边界)中的 `SourceRepository`、`SourceTransaction`、`SourceRevision`、`SourceCheckRepository`、[JobStore](../operations/job-and-execution.md) 等端口；
- 保存、编辑、删除、批量导入和订阅刷新的应用 service；
- `checkSources` 的阶段编排、取消、版本保护和结构化结果；
- 内存 fake、Postgres/Supabase adapter 的集成测试与 RLS 测试；
- 与兼容 Web API 的 adapter 行为对照，但不修改核心规则入口。

## 实施顺序

### 1. 先固定领域状态

实现 `SourceRecord`、`SourceRevision`、`SourceCheckState`、`SubscriptionRecord`、`SubscriptionItem` 和[JobRecord](../operations/job-and-execution.md) 的序列化模型。明确 source 内容、用户覆盖、订阅基线、检查状态、秘密引用和可重建缓存的所有权；不要把这些字段混在 `BookSource` 导出 JSON 中。

### 2. 实现内存 Repository

先用内存实现验证接口和状态机：

1. `save` 校验 userId、sourceId、expectedSourceRevision 和 source 内容；`saveBatch` 通过同一事务边界提交整批变化；
2. 内容相同不递增版本，规则变化递增版本并使检查状态失效；
3. 事务接口支持整批候选提交、失败回滚和幂等键；
4. `remove` 清理派生状态，按策略保留书架和阅读进度；
5. 检测回写使用 sourceRevision/checkSession 条件；
6. 所有返回值脱敏，不暴露 SecretStore 明文。

内存实现不是生产存储，但可以先让 `REPO-*`、`CHECK-*` 和 API 流程测试稳定运行。

### 3. 接入 Postgres/Supabase

按[存储方案](../operations/storage-and-supabase.md)建立迁移和索引：每个用户的 sourceId 唯一、revision 条件更新、检查状态按源索引、任务按租约索引。事务中完成 source revision、当前版本、审计和检查失效；RLS 以 user_id 做纵深防御，应用 service 仍做授权。

Supabase SDK 只在 adapter 包出现。浏览器不持有 service key；Edge/Node 通过服务端会话访问。先用本地 Postgres 或 Supabase 分支项目执行迁移，再运行跨用户、CAS、事务失败和删除清理测试。

### 4. 实现保存应用服务

应用 service 接收 `ImportCandidate[]` 和用户确认结果，按保存流程执行：重新读取当前快照、重新校验候选、检查 revision、计算 `SourceChange[]`、执行原子保存、提交后投递缓存失效/检查任务。订阅、编辑器和兼容 API 都调用它，但兼容 API 可以选择 Android 的逐项跳过语义。

不得接受客户端传入的 userId、任意 RuntimeHost、任意 SecretStore 或未经验证的 source snapshot。保存失败返回稳定错误码并保留编辑草稿；版本冲突返回两侧差异供应用合并。

### 5. 实现书源检测编排

实现 `checkSources(snapshot, config, host, signal)`：固定版本快照，创建 session，逐源隔离超时和取消，按 domain → search/discovery → info → category → content 的依赖运行。每阶段都返回规范的 `PASSED/FAILED/SKIPPED/UNSUPPORTED`；不把空搜索结果当网络错误。状态定义和兼容 DTO 映射见[书源校验状态](../reference/source-check-state.md)。

检测只生成诊断和状态变更，不保存书、章节或正文。完成回写前执行 CAS；源已编辑或删除时返回 stale 并丢弃旧回写。实时进度通过应用 adapter 输出为 SSE/WebSocket，核心不绑定传输方式。

### 6. 实现订阅调度与刷新

调度器读取 `RuleSub` 兼容字段，先判断 `autoUpdate`、`updateInterval`、`update` 和上次尝试时间，再创建幂等刷新任务。按 `type=0/1/2` 分别进入 `BookSource`、`RssSource`、`ReplaceRule` 解析分支；`type=3` 保留原值并返回 `UNSUPPORTED_SUBSCRIPTION_TYPE`，不得猜测映射。刷新下载、解析 `sourceUrls`、复用导入和三方 diff；Web 安全模式只自动采用无冲突变更，Android 兼容模式按实际直接采用路径执行，并在结果中记录模式。冲突、非法成员和远端缺失保留给用户确认，远程失败保留旧 baseline。

调度和 worker 的租约、幂等、恢复及 `unknown` 状态必须遵循[任务执行与 Serverless 边界](../operations/job-and-execution.md)，不能用一次 HTTP 请求的生命周期代替任务状态。

### 7. 最后实现兼容 adapter

以上层仓库 `api.md` 和 Controller 为协议证据实现保存、列表、管理快照、删除、检测、搜索和调试适配。兼容层负责 Android Token、WebSocket 首帧生命周期、请求限制、旧字段映射和错误 DTO；package 只提供领域能力。每个端点至少覆盖[兼容 API 测试](../quality/conformance-tests.md#用例目录和覆盖矩阵)中的 API-003–008，并记录 `android-compatible` 与 `web-safe` 的保存策略差异。

## 事务和任务伪代码

```ts
// SavePlanInput 是应用 service 的输入，不是 Repository 的公开保存类型。
async function saveConfirmedSources(input: SavePlanInput) {
  const snapshot = await sourceRepository.list(input.userId)
  const plan = await sourceCore.planSave(input.candidates, snapshot, input.confirmation)
  if (!plan.ok) return plan

  return sourceRepository.transaction(async (tx) => {
    await tx.assertRevisions(plan.expectedSourceRevisions)
    const saved = await tx.saveSources(plan.changes)
    await tx.invalidateChecks(plan.ruleChanges)
    await tx.appendAudit(plan.audit)
    return saved
  })
}
```

伪代码只表达事务边界，不规定 ORM。缓存失效、检测任务和订阅通知在 commit 后投递；消费者必须以 sourceRevision 幂等处理。

## 测试门槛

实现顺序不是测试顺序的替代。每一步都要先通过内存 fake，再通过数据库 adapter：

- `REPO-001`、`SEC-001`：跨用户隔离和 RLS；
- `REPO-002`、`CHECK-003`：CAS、规则变更失效、旧结果防覆盖；
- `REPO-003`、`SUB-004/005/011/013–018`：事务失败、刷新失败、部分非法、时间间隔、类型分支、未知类型和两种静默策略；
- `REPO-004`：删除清理与阅读数据保留；
- `CHECK-001–004`：阶段依赖、取消、超时、能力缺失和文件源；
- `API-003–008`：Android 兼容入口的逐项保存、JS 限制、已保存前置条件、管理快照、WebSocket 首帧和插入策略差异。
- `REPO-005`：SourceHelp 插入策略与 Repository 保存边界的分离。

所有案例必须记录领域结果、处理轨迹、写入结果、错误语义和资源清理。测试仍未实现时只能标记 `execution=not-run`，不能因为 Supabase 表已经创建就宣称 package 兼容完成。

## 完成定义

本阶段完成的最低条件是：同一份 package 结果可由内存和 Postgres Repository 保存；两个用户互不可见；并发写入不会丢更新；规则变化会触发检查失效；检测和订阅任务不会旧版本回写；兼容 adapter 与新应用 service 均不复制规则解析。完整 UI、书架和阅读器需求不在本阶段。
