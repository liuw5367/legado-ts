# reader-web 存储与缓存

## 用户隔离

所有用户业务表都带 `user_id`；全局 `sources` 只保存共享书源定义，用户侧覆盖保存在 `user_sources`。服务端从 Supabase Auth token 取得用户身份，再把它传给 Repository；请求体、查询参数和书源内容中的同名字段不具有授权效力。Repository 的用户资源查询条件同时包含 userId 和资源身份，MemoryRepository 用相同的接口验证应用流程。

## 主要实体

| 实体 | 作用 |
| --- | --- |
| `user_sources` | 用户书源、raw/normalized 内容、fingerprint、enabled、customOrder、revision、稳定 source_uuid、当前来源归属和删除标记 |
| `source_import_links`、`source_import_settings` | 来源地址的账号内唯一摘要、加密地址、展示地址、排序及排序版本 |
| `source_import_batches`、`source_import_items` | 独立保留的导入批次、摘要、加密前快照、导入后版本及撤销状态 |
| `source_import_undo_operations` | 账号范围内撤销幂等键、选择签名及结果 |
| `source_execution_slots` | 固定八个跨实例执行槽位，20 秒租期，只保存服务端调度元数据 |
| `source_import_previews` | 有效期 15 分钟的导入候选与已消费候选，确认前不改变书源 |
| `books`、`bookshelf` | 逻辑书籍与书架关系；group_id 为单分组归属，null 表示默认；移出书架不删除书籍 |
| `book_lists`、`book_list_items` | type 区分 booklist 与 shelf_group；普通书单成员单独保存评价，分组成员由书架关系保存 |
| `book_source_candidates` | 书架书籍发现过的来源候选，按账号、书籍、来源、fingerprint 和 URL 去重 |
| `book_editions` | 一本书在某个 sourceId、bookUrl 和 fingerprint 下的来源版本 |
| `search_runs`、`search_history` | 当前搜索的候选、分源状态、游标、operationId、进度和历史摘要 |
| `toc_snapshots` | edition 的章节列表、sourceFingerprint 和目录 revision |
| `chapter_contents` | edition、toc revision、chapterId 和 sourceFingerprint 对应的正文 |
| `reading_bookmarks`、`reading_annotations` | 账号书签与文字批注，独立于阅读位置；JSONB data 保存锚点、摘录、颜色、想法、时间、版本和删除状态 |
| `reading_records` | 每个用户/书籍/edition 的章节、段落索引、偏移、版本和最近阅读时间 |
| `source_runtime_state` | 加密的 Cookie/变量快照、fingerprint、版本和五分钟租约 |
| `reader_settings` | 当前账号的全部阅读与通用偏好；`preferences` JSONB 保存带版本号的完整设置文档 |

表定义位于 `server/db/schema.ts`，迁移位于 `server/db/migrations/`。共享书源字段和规则语义以 [Android 规则来源](../../../docs/upstream/android/rules/README.md) 为上游依据，跨包执行取舍以 [兼容政策](../../../docs/contracts/compatibility-policy.md) 为准。

`reader_settings.preferences` 是设置的唯一持久化文档，按 `general`、`display` 和 `pageTapZones` 保存通用偏好、页面显示偏好和分页点击区域比例/动作；新增偏好在该 JSON 文档中扩展并由 API 逐项校验。旧 JSON 文档缺少 `pageTapZones` 时读取默认比例，下一次保存时写回完整字段。`0009_reader_settings_json.sql` 删除旧列并以默认 JSON 初始化，现有账号的旧设置值会重置为默认值。

## 版本与身份

`user_sources.source_uuid` 是服务端分配的稳定 UUID，数据库唯一约束防止碰撞；更新、软删除、恢复和撤销保留 UUID。`user_id + source_id` 仍用于业务去重，sourceId 继续保留原始 bookSourceUrl。旧数据只回填 UUID，不推断来源和导入时间。

书源 `fingerprint` 区分功能定义版本；导入确认发现 fingerprint 改变时清除该源的运行状态。`user_sources.revision` 是用户源记录的当前版本，用于应用层判断变更。`editionKey` 将 sourceId、bookUrl 和 fingerprint 绑定到书籍来源版本；目录 `revision` 由章节序列摘要生成。正文缓存键包含 editionKey、目录 revision 和 chapterId，章节身份由 URL 与 index 的 SHA-256 摘要生成。

这些身份用于避免跨源和跨目录复用数据，不能替代用户授权。书源删除只清理源记录和运行状态；书籍、书架和阅读记录保留。

## 搜索与写入

搜索开始时写入 `search_runs` 和 `search_history`，将来源完成事件合并为每 500ms 至多一次的 sourceStates、候选和进度检查点，批次结算立即保存。领取校验搜索版本和 operationId，并持有 30 秒操作租约；检查点续租，进程异常退出后可重新领取。领取、更新和取消都带用户身份及当前操作条件，防止迟到结果覆盖新状态。最终状态成功保存并释放操作标识后，不再重复发送清理更新；未确认释放的异常路径仍按操作身份清理。候选只在 candidates 保存一份；sourceStates 持久化逐源元数据，读取时按 sourceId 重建共享候选引用，兼容旧记录。已持有且经过操作条件校验的快照在领取和检查点写入时直接复用，数据库不重复返回大结果。搜索历史只记录摘要和数量，不保存 Cookie 或完整请求体。

首页搜索记录按 trim/NFC 后的关键词去重，保留创建时间最新的一次请求，再取最近 50 个不同关键词。完成时间不影响排序；删除某关键词的可见记录同时隐藏其旧记录，不删除搜索任务和候选。

导入确认在事务中锁定预览和用户源覆盖，候选 ID 去重后写入 `user_sources`。同一 sourceId 的定义更新保留用户 enabled/customOrder 状态；预览失效、候选不可写或数据库失败都不返回导入成功。

## 书籍来源候选

加入书架和搜索批次结算时，按 trim/NFC 后的书名和已知作者完全匹配，批量 upsert 同书候选。没有作者或“作者未知”时不自动合并。候选保存书名、作者、简介、封面、分类、字数、最新章节、更新时间、目录 URL，以及 JavaScript 详情脚本重建候选所需的 rawFields 和执行变量；不保存只能在搜索响应中使用的 infoPage 详情正文。缓存写入失败通过 cacheWarning 单独反馈，主保存结果保留。

列表合并缓存与有效 edition，edition 优先；读取时过滤已删除和 fingerprint 不匹配的源，停用实现仍显示其状态，供同域版本切换。旧 fingerprint 行保留，重新搜索增量写入新版本。无时间 TTL 和后台搜索，移出书架保留缓存，普通搜索不再更新该书缓存。打开候选时重新验证身份、源状态和版本，仅创建 edition，不覆盖书籍元数据、活动版本或阅读位置。新增表启用并强制 RLS，沿用 app.user_id。

## 用户选择的封面

`books.custom_cover_url` 保存账号下单本书籍的用户封面，空值表示跟随来源。它独立于 `books.cover_url` 和 edition 元数据，换源、重新搜索和详情刷新只更新来源数据，保留用户选择。详情、书架、最近阅读、书单成员及书单组合封面优先展示用户封面。`0012_book_cover.sql` 只增加可空列，旧书籍无需回填；上线新代码前需显式执行迁移。

封面保存接口 `PUT /api/books/:bookId/cover` 接受 `selection: null` 恢复默认，或接受来源的 `sourceId`、`sourceFingerprint` 和 `bookUrl`。服务端验证账号、书籍归属和当前书源定义，再从候选缓存或已保存 edition 解析封面，客户端不能直接提交任意图片地址。保存只修改用户封面，不改变活动 edition、其他元数据、书架归属、阅读位置或书籍更新时间。

缺少封面的已发现候选复用来源详情接口逐个读取，沿用同书身份校验、运行状态租约和全局执行槽位，执行超时为 10 秒。请求取消后不开始下一来源，详情执行链传递 AbortSignal，保存 edition 前再次检查取消。同步脚本仍受执行超时约束，无法承诺即时强制中断；读取过程中可能结算书源 Cookie 等运行状态。封面队列失败保留已返回结果，不自动重试。

用户封面随 Web 备份书籍文档的可选 `customCoverUrl` 字段导出和恢复，旧备份缺字段时按未选择处理。图片仍使用来源 URL，不额外保存图片文件。保存成功清除浏览器书籍缓存，并使详情、首页、书单列表和成员数据失效；来源后来删除不会清除已经选择的封面 URL。

## 运行状态加密与租约

`source_runtime_state.encrypted_state` 使用 AES-256-GCM，密钥来自服务端环境变量 `SOURCE_RUNTIME_STATE_KEY`，至少 32 个字符，明文上限 512 KiB。运行前取得 leaseToken 和 leaseUntil；只有持有 token 且版本仍匹配的调用可以提交新快照。提交成功后清除租约，失败时释放租约；旧 fingerprint 或过期 token 不能覆盖新状态。

Cookie、脚本变量和运行时缓存不进入浏览器响应，也不写入 raw/normalized source JSON。轮换密钥会使旧运行状态、导入原始来源和撤销前快照无法解密；轮换前必须迁移加密数据，不能只要求用户重新登录后继续使用旧撤销记录。

## 目录、正文和阅读位置

目录成功后以 editionKey 为范围保存快照。refresh 跳过目录缓存并在成功后覆盖当前快照；预览其他来源不会写入当前 edition。正文成功后保存完整 `ChapterContent`，缓存命中不触发网络请求；正文请求失败保留旧缓存。本次正文已成功保存后，如果书源会话结算失败，仍返回这次正文，并在响应中通过 runtimeWarning 标记状态未能保存，服务端保留诊断，阅读正文不插入该提示；不使用旧缓存掩盖抓取或正文保存失败。运行状态继续执行租约释放，警告不写入正文缓存。

浏览器另外持有当前书籍各 edition 的目录、公开详情和阅读位置。目录页、阅读入口、正文和换源共享这一内存缓存，合并同版本正在进行的请求；成功刷新更新快照，失败保留旧值，失效的迟到响应不能回写。换书、换账号、书源导入或管理动作清空缓存。该缓存不写入 localStorage，也不替代服务端所有权与 fingerprint 校验。

阅读位置是可变用户数据，与正文缓存分开。服务端保存章节 URL、章节索引、标题、目录 revision、段落索引、字符偏移和 version；前端离开阅读页或位置变化时提交，不能因为清理正文缓存而删除位置。

页面实例另外保留自身已成功加载的数据，生命周期和容量见 [页面保留与返回](interaction.md#页面保留与返回)。共享书籍缓存换书时清空，不要求其他隐藏页面删除组件中的成功快照；隐藏页不能主动加载并抢占当前书籍缓存。页面实例和导航元数据只存在于内存，历史条目映射最多保存一百项；遇到未知或已淘汰条目时按 URL 重建，不修改浏览器真实历史。

页面失效通知按账号隔离：书架及搜索历史变更影响首页，书籍与来源变更影响对应书籍，书源导入或管理变更影响书源、发现、书籍与正文。阅读位置成功保存只更新位置缓存并使首页和书单书籍信息失效，不重新抓取正文；设置继续由设置 Provider 通知。失败写入不发布成功失效，隐藏页面等到激活才重新读取。

阅读位置队列保存完整书籍、来源、章节与版本身份，顺序提交并保证版本递增；仅相邻且尚未结算、身份和锚点完全相同的保存共享请求，不跨越不同位置合并，不缓存已结算请求以跳过后续阅读时间更新。调用方版本取最高值，已发出的请求内容不变，后续版本继续递增；失败保留待重试位置。切换账号停止未发送任务，请求发送时校验队列所属账号，迟到结果只属于原账号。已发送的业务写入不会因为页面隐藏而中断，防止把请求取消误认为服务端回滚。

## 导入历史与备份

历史与临时预览分表保存，不自动过期；读取列表或明细不加载加密撤销快照。批次写入、源变更、预览消费结果共用账号事务锁；来源排序也使用账号锁及排序版本。撤销只允许当前 revision 等于该明细的导入后版本，恢复产生新版本，保留历史。用户业务历史表强制 RLS；全局额度表只供受控服务端连接跨账号统计，客户端没有对应接口。

跨 CLI 备份格式只保存现有书源定义和用户状态，不包含导入历史与私有来源。恢复书源时，同账号按 sourceId 保留已有 UUID，新源生成 UUID；清除当前来源归属，并在同一事务将旧批次标为“备份恢复后不可撤销”，历史仍可读。跨账号不复制旧 UUID 或历史。

## 清理与恢复

过期导入预览在写入前清理。source runtime lease 通过时间判断可重新取得，进程退出不会留下永久占用。数据库迁移由显式命令执行，部署构建不自动修改 schema。数据库不可用时 API 返回错误并保留客户端当前页面状态，不回退为空书源列表。

## 书单与分组事务

两个新表强制 RLS，沿用 app.user_id。书单成员以用户、书单、书籍唯一，分组名称在当前账号内唯一。分组排序使用 custom_order，不按更新时间重排。普通书单只使用成员关联，分组只使用 bookshelf.group_id；公开字段保留，不授予匿名访问。

同账号的组织数据写入共用事务锁，覆盖分组排序、删除、归属修改和移入书单。移入在同一事务完成成员加入和移出书架；删除分组同时处理书架关系及失效的启动设置。重复加入保持评价和加入时间。列表封面与详情书籍批量读取，书单接口不返回内部脚本变量。

启动选择保存为 preferences.general.bookshelfInitialGroup，all 表示全部，ungrouped 表示默认，其他值为当前账号分组 UUID。缺失按 all 读取。备份路径与恢复兼容以[共享备份契约](../../../packages/reader-backup/README.md)为准。

## 书签与文字批注

`0014_reading_annotations.sql` 只创建 reading_bookmarks、reading_annotations 及其索引、约束和强制RLS，不修改旧表或回填旧数据。新表以 user_id/id 唯一，按书籍、来源和章节索引查询，同章查询用于范围冲突检查；活动锚点具有唯一约束。data 的身份字段受数据库校验约束，与关系列一致。五色、文字位置及想法输入在API边界校验。

创建时验证账号书籍、来源 fingerprint、目录版本、章节、正文摘要及摘录范围，HTML文本校验排除被清洗移除的标签；已有记录允许正文失效后编辑颜色或想法，不允许替换文字身份。并发写入和备份恢复共用账号批注事务锁，更新、删除与恢复需要 expectedVersion，冲突不覆盖。删除保存 deletedAt，正文与正常列表只读取活动记录，设置笔记页可恢复；没有自动清理或永久删除入口。

书籍列表接口为 /api/books/:bookId/bookmarks 和 /annotations；账号笔记查询为 /api/annotations，书籍筛选为 /api/annotations/books。列表使用绑定筛选条件的稳定游标，每页50条；当前章单独读取。成功变更只发布 notes 失效，不重新抓取正文或改写阅读进度。文字锚点为段落索引与UTF-16偏移，原文及前后文用于正文变化后的唯一匹配，换源不自动转移标记。备份兼容以[共享备份契约](../../../packages/reader-backup/README.md)为准。
