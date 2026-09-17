# 身份、状态与副作用

本章为 Web package 目标契约。Android 的对象原地修改、磁盘目录名和全局单例不直接成为服务端的数据模型。流程规格引用本章，不各自定义缓存身份或提交协议。

## 身份和版本

| 名称 | 含义与比较规则 |
| --- | --- |
| `sourceId` | 通过校验的原始 `bookSourceUrl` 字符串；不做 URL 大小写、尾斜杠、query 排序等网络规范化。它是源主键，不保证是可请求地址 |
| `sourceRevision` | 应用每次保存源时生成的非空、不透明版本；与 `lastUpdateTime` 分离，后者是不可信的源元数据 |
| `semanticVersion` | package 的规则语义版本，参与派生结果缓存键 |
| `sessionId` | 宿主认证后注入的用户/匿名会话命名空间；不能信任请求体自报身份 |
| `operationId` | 一次调用的唯一身份；重试 HTTP attempt 不改变它，新调用必定改变 |
| `requestId` | 服务端请求的日志关联标识；一次请求可包含多个 operation |
| `bookKey` | `(sessionId, sourceId, bookUrl)`；跨源同 URL 不合并持久化身份 |
| `chapterKey` | `(bookKey, tocRevision, index)`；目录刷新可改变索引，URL 仅供匹配与兼容脚本查询 |
| `resourceKey` | 以上相关身份加资源种类、sourceRevision、semanticVersion；用户相关响应默认不跨会话缓存 |
| `writeVersion` | 宿主给一次待保存操作的写入代次，提交时原子比较；不等于缓存有效版本 |

`sourceId` 改变视为新源候选；原源、旧书籍与订阅归属不能静默改名。目录修订变化后旧章节 token 失效。无内容变化的目录刷新可保留 tocRevision，由宿主比较完整规范化目录后决定。原文 hash 用于检测变化，不作为用户身份或权限凭证。

Android 行为与上表不同：`BookSourceCheckState.sourceRevision` 在插入和规则内容变化（`BookSourceDao.update` 的 `checkContent()` 比较）时生成新 UUID；`upGroup` 修改 `bookSourceGroup` 时经 `update()` 触发（`checkContent()` 未清零分组字段，`BookSource.kt` L259-263）；`beginCheck` 保留 `sourceRevision`、只生成新的 `revision`（任务版本 UUID，`BookSourceDao.kt` L304）；`enable`/`enableExplore`/`upOrder` 走独立 `@Query` SQL（`BookSourceDao.kt` L354/364/377），不触发。`writeVersion` 可类比的是 `BookSourceCheckState.revision`（`finishCheck` 的 CAS 键），而不是 `sourceRevision`。章节在 Android 的主键是 `(bookUrl, url)`，并有唯一索引 `(bookUrl, index)`；`chapterKey` 以 `index` 为身份组件会遗漏唯一索引冲突。`beginCheck` 对已不存在（或 `lastUpdateTime`/`checkRevision` 已变化）的源不写状态，直接返回 `selected.copy()` 作为身份失效分支。

## 状态所有权

| 状态 | 所有者 / 生命周期 | 跨调用与失败处理 |
| --- | --- | --- |
| 解析器配置、不可变已编译规则 | runtime 工厂 | 可共享；缓存必须含语义版本，无用户数据 |
| DOM、规则局部变量、临时分页结果、JS scope | operation | 结束时释放，不存入用户数据库 |
| Cookie、登录头、源变量、脚本持久缓存 | 会话 + 源命名空间下的宿主 | 跨调用保留；释放请求视图不调用 clear |
| Book/Chapter 变量与字段 | 领域快照及返回变更 | 普通流程成功后由应用提交；失败不污染输入对象 |
| 目录、正文、书源原文、订阅记录 | 应用存储 / 注入存储端口 | 独立于函数实例；可提供内存实现用于本地测试 |
| 进度及 page owner | 搜索 operation / 应用当前操作 | 只接收当前所有权事件；新页和新搜索有独立 operationId |

同一会话并发调用通过宿主原子操作访问持久状态，不能在调用结束时把旧的整份 Cookie/变量快照覆盖回存储。书源变量读写与章节变量提交是不同的副作用，不因都叫 variable 而共用生命周期。

## 副作用与提交

| 动作 | 时机 | 失败、取消后的事实 |
| --- | --- | --- |
| 网络请求、响应 Set-Cookie | 请求执行期间，按 enabledCookieJar 和策略更新 | 已发送的请求不可撤回，已经接受的 Cookie 不随正文失败回滚 |
| `source.putVariable`、脚本 cache 写入 | 脚本调用时，允许本次后续读取 | 已完成写入记录 effect；不得声称整个调用没有副作用 |
| 普通详情、目录和 Book/Chapter 变量 | 形成完整结果后产生变更 | 应用比较源/目录版本后原子提交；失败保持旧领域数据 |
| 单章正文 `needSave=true` | 归一化成功后调用 ContentStore | 正文与相关元数据一起提交；过期 token 为 stale，不是规则错误 |
| `java.cacheContent` | 批量脚本执行中，逐章比较 token 后提交 | 已保存章保留，失败与未回存章分别返回；禁止再次保存已成功章 |
| 搜索 sink | 单源解析成功后、source-success 之前 | sink 失败是 storage-error；内存 sink 可满足无数据库调用 |
| 用户购买、发帖等上游写入 | 明确用户动作后 | 不自动重试；未知结果明确标记，不假装失败后可安全重发 |

统一记录 `effects[]`：每项包含 `kind`、`resourceKey`、`status`（committed/rejected/unknown）、`operationId` 和脱敏诊断；不包含 Cookie 内容。执行结束不等于存储提交。`progress`、`source-success`、`completed` 是执行事件；`saved` 仅在对应存储确认后发布。

## 正文缓存与防旧写入

1. 按稳定 resourceKey 读取缓存，不递增 writeVersion；读取不能使其他正在执行的写入失效。
2. 缓存未命中且要求保存时，通过 ContentStore.reserve 取得写入 token；宿主原子增加该资源代次。
3. 网络、规则及分页完成后，比较 sourceRevision、tocRevision、operation 资格和 writeVersion，并在同一原子边界写入正文与元数据。
4. 新操作已取得更新代次、源已编辑、目录已刷新或 operation 已取消时，旧写入返回 stale/cancelled，不覆盖旧缓存。
5. 底层存储无法原子写大正文与元数据时，先写不可变内容，再原子发布引用；发布失败留下可回收的未引用内容，不能公布半完成结果。

`ContentIdentity` 使用上表的身份字段，并额外绑定 `tocRevision`、`chapterIndex` 和正文章节身份；`ContentSaveToken` 包含 `identity`（`ContentIdentity`）、`operationId`、`writeVersion` 和可选过期时间。规范接口定义在[宿主接口](runtime-host-interfaces.md)，正文流程只补充本流程的使用顺序。Android `folderName` 仅留在文件 adapter。单进程锁只保证单进程；多实例需跨实例原子比较写入。

## 取消与清理

operation 具有 `active -> settling -> closed` 生命周期，结果独立为 success/empty/partial/failed/cancelled/stale/capability-missing。进入 settling 后不启动新分页、重试、脚本或普通保存。取消信号发出后等待子任务停止，再释放脚本句柄、DOM、监听器与响应体；清理失败保留原错误并附加 lifecycle 诊断。

Android 的书源校验取消通过 `CheckSourceService` 的 `IntentAction.stop` 服务消息（`checkJob?.cancel()`）实现，没有 `active -> settling -> closed` 状态机；上述生命周期是目标契约。

提交与取消竞争由存储端口原子结算：提交先完成则记录 committed，取消先撤销资格则拒绝提交。不得用“已取消”否认实际完成的上游或存储副作用。事件订阅者异常仅增加日志诊断，不改变已结算业务结果。

预览使用独立临时命名空间，不自动提交用户状态。真实网络本身仍可能产生上游副作用，因此预览不自动触发购买、评论写入或交互事件。测试见 [状态及交叉案例](../quality/conformance-tests.md#具体状态与交叉案例)。
