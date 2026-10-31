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
| `reading_records` | 每个用户/书籍唯一的一份当前章节、来源、段落索引、偏移、版本和最近阅读时间 |
| `source_runtime_state` | 加密的 Cookie/变量快照、fingerprint、版本和五分钟租约 |
| `reader_settings` | 当前账号的全部阅读与通用偏好；`preferences` JSONB 保存带版本号的完整设置文档 |

表定义位于 `server/db/schema.ts`，迁移位于 `server/db/migrations/`。共享书源字段和规则语义以 [Android 规则来源](../../../docs/upstream/android/rules/README.md) 为上游依据，跨包执行取舍以 [兼容政策](../../../docs/contracts/compatibility-policy.md) 为准。

`reader_settings.preferences` 是设置的唯一持久化文档，按 `general`、`display` 和 `pageTapZones` 保存通用偏好、页面显示偏好和分页点击区域比例/动作；新增偏好在该 JSON 文档中扩展并由 API 逐项校验。旧 JSON 文档缺少 `pageTapZones` 时读取默认比例，下一次保存时写回完整字段。`0009_reader_settings_json.sql` 删除旧列并以默认 JSON 初始化，现有账号的旧设置值会重置为默认值。

浏览器对字号、行距和四边距即时预览并更新账号本地设置，停止修改 500ms 后合并保存；持续操作最多等待 2 秒触发提交，若已有请求未完成则继续串行等待，尚未发送的字段仍可合并。主题、阅读模式、通用设置和点击区域保持即时提交，并带上待保存的显示字段；要求成功后应用的操作仍等待服务器确认。旧响应按字段保留较新的预览，令牌刷新不重建账号保存队列。

关闭阅读设置面板、离开设置页面或页面进入后台时提交剩余修改；浏览器强制退出时不保证网络提交成功。失败保留当前预览及内存中的未同步字段，后续编辑或明确重试时重新提交，不自动循环重试。登出或换账号停止未发送任务，已发送请求继续结算，旧账号响应不更新新账号页面或本地设置。

## 版本与身份

`user_sources.source_uuid` 是服务端分配的稳定 UUID，数据库唯一约束防止碰撞；更新、软删除、恢复和撤销保留 UUID。`user_id + source_id` 仍用于业务去重，sourceId 继续保留原始 bookSourceUrl。旧数据只回填 UUID，不推断来源和导入时间。

书源 `fingerprint` 区分功能定义版本；导入确认发现 fingerprint 改变时清除该源的运行状态。`user_sources.revision` 是用户源记录的当前版本，用于应用层判断变更。`editionKey` 将 sourceId、bookUrl 和 fingerprint 绑定到书籍来源版本；目录 `revision` 由章节序列摘要生成。正文缓存键包含 editionKey、目录 revision 和 chapterId，章节身份由 URL 与 index 的 SHA-256 摘要生成。

这些身份用于避免跨源和跨目录复用数据，不能替代用户授权。书源删除只清理源记录和运行状态；书籍、书架和阅读记录保留。

## 数据库读取与出站流量

书源管理列表只读取摘要字段，并在数据库内提取 JSONB 中的名称、分组、作者和规则更新时间；保留原有筛选、排序、分页及全部摘要模式。启用书源列表和发现入口读取来源身份、排序和发现可用性所需字段，不传输完整规则。单本书来源列表根据该书的候选及已保存版本，一次查询相关书源摘要，保留停用来源并过滤已删除或 fingerprint 失配的来源。规则执行、导入比较和备份仍按需要读取完整定义。

书源摘要的发现可用性在数据库内计算，只返回布尔值，不返回 exploreUrl；按来源读取展示名称时仅提取 bookSourceName。书架与最近阅读只选择书籍展示字段、版本标识及章节标题、阅读入口和时间所需字段，不读取完整版本 metadata 或 variable。搜索页通过 /api/books/identities 读取书籍身份与书架标识；没有显式版本的阅读入口通过单书 reading-entry 查询当前版本，不读取整库。

书单列表在数据库统计成员数、是否包含目标书籍，并只读取最新四本书的封面摘要。加入与移入书单使用 purpose=picker，省去封面查询与 coverBooks；书单详情只读取成员展示、评价及恢复操作所需字段，不读取版本或阅读位置。分组数量在数据库聚合，分组选择器使用可选 bookId 同时读取当前归属，不加载整个首页。

书籍详情的版本元数据在 SQL 中按展示白名单提取，不返回脚本变量与 rawFields；阅读进度仅返回标题和时间。目录来源选择使用单书 edition-options，保留历史版本及来源名称回退；目录页、阅读器和笔记定位的共享快照加载目录与 `/api/books/:bookId/reading-info`，只返回书籍 id、name、author、activeEditionKey，以及版本 editionKey 和书名；切换书源页也使用该轻量接口。数据库以一次按账号和书籍限定的关联查询选择基础字段，并只从版本 JSONB 提取 name，不读取简介、封面、完整 metadata、书架状态、书源展示名或阅读记录。`/details` 由书籍详情页按需读取，不再用于构造阅读快照。共享快照不附带全账号书源或完整版本列表。版本选项复用当前书籍内存缓存，换书、账号及来源变更时清除。

笔记与书签列表在数据库提取 id、bookId、bookName、chapterTitle、color、note、createdAt、deletedAt、version、excerpt 和 hasCachedChapter；不传完整锚点、来源身份或缓存原文。点击定位、编辑或查看原文时，按账号、书籍和记录 ID 读取单条动作信息，并按记录版本在页面内复用。正文内标记使用 view=reader，并要求 editionKey、chapterUrl；数据库只提取定位、编辑与版本校验所需字段，不关联书籍展示信息。保存、删除和恢复可用 view=list 或 view=reader 返回对应精简视图。点击查看原文时另读单条缓存，允许查看本人软删除笔记。内部写入和备份保留完整模型。笔记书籍筛选直接返回当前版本，不额外读取书库。导入历史批次摘要不读取 selection，确认与撤销仍保留各自所需数据。

正文、段评和新建批注的章节校验通过轻量数据库查询读取目录 revision、sourceFingerprint、目标章节和下一章地址，目录数组在数据库内处理，不向后端返回完整目录。章节身份沿用 URL、NUL 分隔符和 index 的 UTF-8 SHA-256；目录不存在与章节不存在分别处理。正文接口校正缓存章节标题时也使用轻量章节查询，保留当前目录标题且不修改缓存正文。目录展示接口只返回 bookId、editionKey、sourceFingerprint、revision、章节摘要及可选 runtimeWarning；章节摘要保留 chapterId、chapterUrl、index、title、isVolume、isVip。缓存命中时，数据库直接从 JSONB 提取章节白名单字段，不向后端传输完整章节对象、bookPatch、bookAfter 或快照时间；同时只读取当前来源摘要进行有效性校验。刷新或缓存失效时仍使用完整书源和快照执行抓取与保存，再生成展示摘要。上述查询不增加跨请求缓存，不修改现有表结构与索引；减少网络传输不代表数据库内部免于读取或处理 JSONB。

## 首页列表接口

首页使用三个独立 GET 接口：`/api/bookshelf` 返回 `{ bookshelf }`（不分页，含所有书籍和分组归属）；`/api/reading-history` 返回 `{ reading }`（最近50本）；`/api/search-history` 返回 `{ searchHistory }`（最近50个不同关键词）。分组继续通过 `/api/bookshelf-groups` 读取。原 `/api/home` 已移除。生产调用方使用独立 Repository 查询，getHome 只作为测试组合读取保留。

书架在数据库按加入时间或单书最近阅读时间排序，未读书籍置后，不再在应用层重排。首页默认只请求当前 Tab 和分组，未加载 Tab 不显示数量；首次切换才加载，并保留各自数据、失败结果和滚动位置。切回已结算且未失效的 Tab 不请求；隐藏时失效等再次显示再读；失败需要显式重试。分组失败不阻塞书架，列表之间不等待彼此。书架排序设置变化只重新读取书架，不加载其他列表。

## 书架章节摘要与更新标记

`GET /api/bookshelf` 的书架条目包含 `chapters`：`chapterCount`、`latestChapterTitle` 和 `unreadChapterCount`。books 保存 latestChapterIndex/latestChapterName/currentChapterIndex/currentChapterName，正文序号从0开始，排除卷标题，最新序号-1表示已获取空目录，null表示未知。首页只读这些摘要和单条阅读记录，通过序号相减计算未读数，不查询或展开目录、不读取完整 metadata。尚未阅读时统计全部正文，目录未知时数量为null。

`POST /api/books/:bookId/toc/refresh?editionKey=...` 强制刷新指定版本目录，返回同一章节摘要、当前阅读入口摘要 position（无进度为 null），以及 `previousChapterCount`、`hasNewChapters` 和可选 `runtimeWarning`。未读数按刷新后的目录与当前阅读位置计算；目录重排时按URL和标题校准当前章节身份，保留同一章节内的段落位置。旧目录不存在时 previousChapterCount 为 null，不产生更新标记；只有正文章节数增加时 hasNewChapters 为 true。失败保留旧目录。成功后前端只替换当前书架条目的摘要并使该书目录失效，不重新请求首页。

`POST /api/bookshelf/refresh` 接收 `{ books: [{ bookId, editionKey }] }`，按书籍和来源版本去重后通过 SSE 返回 `batch-start`、逐本 `book-result` 或 `book-error`、最终 `batch-end`。成功事件的 result 与单本刷新响应一致；失败只影响对应书籍。服务端从账号设置 `general.bookshelfRefreshConcurrency` 读取并发上限，默认5，合法整数范围5–10，与搜索并发独立；旧设置缺省为5，设置随账号保存与备份恢复。执行每项前校验书架归属及当前来源版本，不搜索或切换来源。连接断开停止派发剩余项，已开始请求可能完成保存，不提供后台续传。

“更新”标记只保存在浏览器，localStorage 键为 `legado:book-update:v1:` 加账号、书籍与版本的 JSON 数组，值为 `{ version: 1, updated: true }`。再次刷新无新增时保留已有标记，进入对应版本的正常阅读页后清除；目录、详情和阅读位置预览不会清除。存储不可用时在当前会话内保存。该标记不写入数据库，也不随备份同步。

## 搜索与写入

搜索开始时写入 `search_runs` 和 `search_history`，将来源完成事件合并为每 500ms 至多一次的 sourceStates、候选和进度检查点，批次结算立即保存。领取校验搜索版本和 operationId，并持有 30 秒操作租约；检查点续租，进程异常退出后可重新领取。领取、更新和取消都带用户身份及当前操作条件，防止迟到结果覆盖新状态。最终状态成功保存并释放操作标识后，不再重复发送清理更新；未确认释放的异常路径仍按操作身份清理。候选只在 candidates 保存一份；sourceStates 持久化逐源元数据，读取时按 sourceId 重建共享候选引用，兼容旧记录。已持有且经过操作条件校验的快照在领取和检查点写入时直接复用，数据库不重复返回大结果。搜索历史只记录摘要和数量，不保存 Cookie 或完整请求体。

搜索历史查询在数据库内按 JS trim 的空白字符集合和 NFC 规范化关键词，通过 DISTINCT ON 保留创建时间最新的请求，再按时间与ID取最近50个不同关键词。数据库只返回限定的摘要行，不先向应用传输全部历史；完成时间不影响排序。删除操作用同一规范化条件直接隐藏整组，不读取全账号历史，也不删除搜索任务和候选。

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

正文展示接口只返回 tocRevision、可选 runtimeWarning，以及章节标识、URL、序号、标题、contentType、cleaned、图片 resources 和可选 finalUrl，不返回 raw、pages 或内部快照字段。缓存命中时在数据库提取正文 JSONB 白名单，版本查询只读来源身份，来源查询只读摘要；缓存未命中和刷新仍用完整规则执行抓取，再生成展示响应。PUT /api/books/:bookId/edition 用于设置当前阅读版本，只返回 editionKey；数据库校验版本归属后直接更新书籍，不读取或返回版本 metadata。

目录成功后以 editionKey 为范围保存快照。refresh 跳过目录缓存并在成功后覆盖当前快照；预览其他来源不会写入当前 edition。正文成功后保存完整 `ChapterContent`，缓存命中不触发网络请求；正文请求失败保留旧缓存。本次正文已成功保存后，如果书源会话结算失败，仍返回这次正文，并在响应中通过 runtimeWarning 标记状态未能保存，服务端保留诊断，阅读正文不插入该提示；不使用旧缓存掩盖抓取或正文保存失败。运行状态继续执行租约释放，警告不写入正文缓存。

浏览器另外持有当前书籍各 edition 的目录和轻量书籍信息，以及一份当前阅读位置。目录页、阅读入口、正文和换源共享这一内存缓存，合并同版本正在进行的请求；成功刷新更新快照，失败保留旧值，失效的迟到响应不能回写。换书、换账号、书源导入或管理动作清空缓存。该缓存不写入 localStorage，也不替代服务端所有权与 fingerprint 校验。

阅读位置是可变用户数据，与正文缓存分开。服务端每本书仅保存一份章节 URL、原始章节索引、标题、当前 edition、目录 revision、段落索引、字符偏移和 version；books 的正文序号用于未读数，原始索引用于来源定位。保存目录与摘要、确认切源与目标进度在各自事务内完成，按书籍锁串行。仅预览目录不更新当前状态。切源先匹配章节名称，再按原始索引定位，替换唯一进度；切回旧源继续当前进度，不恢复历史来源进度。同章位置保存不读取目录，跨章只在数据库计算正文序号；迟到的低版本保存不覆盖当前状态。前端翻页或滚动位置变化后防抖 2 秒，只提交同书同版本的最后一个位置；离开阅读页、切章、页面进入后台或 pagehide 时立即提交待保存位置。明确接受预览位置和失败重试立即提交，不能因为清理正文缓存而删除位置。

页面实例另外保留自身已成功加载的数据，生命周期和容量见 [页面保留与返回](interaction.md#页面保留与返回)。共享书籍缓存换书时清空，不要求其他隐藏页面删除组件中的成功快照；隐藏页不能主动加载并抢占当前书籍缓存。页面实例和导航元数据只存在于内存，历史条目映射最多保存一百项；遇到未知或已淘汰条目时按 URL 重建，不修改浏览器真实历史。

页面失效通知按账号隔离：bookshelf、reading-history、search-history 和 groups 分别对应独立资源，删除搜索历史只使 search-history 失效，修改分组只使 groups 与 bookshelf 失效；书籍与来源变更影响对应书籍，书源导入或管理变更影响书源、发现、书籍与正文。阅读位置成功保存只更新位置缓存并使 bookshelf、reading-history 和书单书籍信息失效，不重新抓取正文；设置继续由设置 Provider 通知。失败写入不发布成功失效，隐藏页面等到激活才重新读取。

阅读位置队列保存完整书籍、来源、章节与版本身份，顺序提交并保证同书跨来源版本递增；确认切源前提交该书待保存位置。防抖阶段按书籍与版本合并为最后一个完整位置，重新计时；已经进入串行发送队列的任务只对相邻且尚未结算、身份和锚点完全相同的保存共享请求，不缓存已结算请求以跳过后续阅读时间更新。调用方版本取最高值，已发出的请求内容不变，后续版本继续递增；失败保留待重试位置。切换账号停止未发送任务，请求发送时校验队列所属账号，迟到结果只属于原账号。已发送的业务写入不会因为页面隐藏而中断，防止把请求取消误认为服务端回滚。

## 导入历史与备份

历史与临时预览分表保存，不自动过期；读取列表或明细不加载加密撤销快照。批次写入、源变更、预览消费结果共用账号事务锁；来源排序也使用账号锁及排序版本。撤销只允许当前 revision 等于该明细的导入后版本，恢复产生新版本，保留历史。用户业务历史表强制 RLS；全局额度表只供受控服务端连接跨账号统计，客户端没有对应接口。

跨 CLI 备份格式只保存现有书源定义和用户状态，不包含导入历史与私有来源。恢复书源时，同账号按 sourceId 保留已有 UUID，新源生成 UUID；清除当前来源归属，并在同一事务将旧批次标为“备份恢复后不可撤销”，历史仍可读。跨账号不复制旧 UUID 或历史。

## 清理与恢复

过期导入预览在写入前清理。source runtime lease 通过时间判断可重新取得，进程退出不会留下永久占用。数据库迁移由显式命令执行，部署构建不自动修改 schema。数据库不可用时 API 返回错误并保留客户端当前页面状态，不回退为空书源列表。

## 书单与分组事务

两个新表强制 RLS，沿用 app.user_id。书单成员以用户、书单、书籍唯一，分组名称在当前账号内唯一。分组排序使用 custom_order，不按更新时间重排。普通书单只使用成员关联，分组只使用 bookshelf.group_id；公开字段保留，不授予匿名访问。

同账号的组织数据写入共用事务锁，覆盖分组排序、删除、归属修改和移入书单。移入在同一事务完成成员加入和移出书架；删除分组同时处理书架关系及失效的启动设置。重复加入保持评价和加入时间。列表封面与详情书籍批量读取，书单接口不返回内部脚本变量。

首页复用设置 Provider 的账号请求；当前账号设置加载成功且分组已返回后才初始化启动分组。加载失败可手动重试，迟到的其他账号响应不影响当前账号；加载与重试保留本账号已编辑的字段，初始化完成后不会覆盖用户手动选择的筛选。

启动选择保存为 preferences.general.bookshelfInitialGroup，all 表示全部，ungrouped 表示默认，其他值为当前账号分组 UUID。缺失按 all 读取。备份路径与恢复兼容以[共享备份契约](../../../packages/reader-backup/README.md)为准。

## 书签与文字批注

`0014_reading_annotations.sql` 只创建 reading_bookmarks、reading_annotations 及其索引、约束和强制RLS，不修改旧表或回填旧数据。新表以 user_id/id 唯一，按书籍、来源和章节索引查询，同章查询用于范围冲突检查；活动锚点具有唯一约束。data 的身份字段受数据库校验约束，与关系列一致。五色、文字位置及想法输入在API边界校验。

创建时验证账号书籍、来源 fingerprint、目录版本、章节、正文摘要及摘录范围，HTML文本校验排除被清洗移除的标签；已有记录允许正文失效后编辑颜色或想法，不允许替换文字身份。并发写入和备份恢复共用账号批注事务锁，更新、删除与恢复需要 expectedVersion，冲突不覆盖。删除保存 deletedAt，正文与正常列表只读取活动记录，设置笔记页可恢复；没有自动清理或永久删除入口。

书籍列表接口为 /api/books/:bookId/bookmarks 和 /annotations；账号笔记查询为 /api/annotations，书籍筛选为 /api/annotations/books。列表使用绑定筛选条件的稳定游标，每页50条；当前章单独读取。成功变更只发布 notes 失效，不重新抓取正文或改写阅读进度。文字锚点为段落索引与UTF-16偏移，原文及前后文用于正文变化后的唯一匹配，换源不自动转移标记。备份兼容以[共享备份契约](../../../packages/reader-backup/README.md)为准。

## 单书状态结构更新与备份

`0016_single_book_reading.sql` 为 books 增加四个章节摘要列，将 reading_records 的唯一约束改为 user_id/book_id，并明确清空全部旧阅读记录。不迁移或回填旧进度；部署时须显式执行结构 SQL，构建不执行。新摘要初始未知，后续获取目录或选择来源时建立。清除的旧进度无法靠回滚代码恢复。

Web 导出的 book.json 使用可选 chapterState 保存四个摘要字段，阅读记录只导出当前来源的一份状态。恢复旧备份时只选择记录中 activeEditionKey 对应位置；没有该位置时选择最近位置，不恢复多源历史进度。旧备份缺摘要时保留未知，重新获取目录后计算。恢复只读章节摘要，不凭原始目录 index 假造正文序号。
