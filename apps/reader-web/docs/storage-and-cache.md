# reader-web 存储与缓存

## 用户隔离

所有用户业务表都带 `user_id`；全局 `sources` 只保存共享书源定义，用户侧覆盖保存在 `user_sources`。服务端从 Supabase Auth token 取得用户身份，再把它传给 Repository；请求体、查询参数和书源内容中的同名字段不具有授权效力。Repository 的用户资源查询条件同时包含 userId 和资源身份，MemoryRepository 用相同的接口验证应用流程。

## 主要实体

| 实体 | 作用 |
| --- | --- |
| `user_sources` | 用户书源、raw/normalized 内容、fingerprint、enabled、customOrder、revision 和删除标记 |
| `source_import_previews` | 有效期 15 分钟的导入候选与已消费候选，确认前不改变书源 |
| `books`、`bookshelf` | 逻辑书籍与书架关系；移出书架不删除书籍 |
| `book_source_candidates` | 书架书籍发现过的来源候选，按账号、书籍、来源、fingerprint 和 URL 去重 |
| `book_editions` | 一本书在某个 sourceId、bookUrl 和 fingerprint 下的来源版本 |
| `search_runs`、`search_history` | 当前搜索的候选、分源状态、游标、operationId、进度和历史摘要 |
| `toc_snapshots` | edition 的章节列表、sourceFingerprint 和目录 revision |
| `chapter_contents` | edition、toc revision、chapterId 和 sourceFingerprint 对应的正文 |
| `reading_records` | 每个用户/书籍/edition 的章节、段落索引、偏移、版本和最近阅读时间 |
| `source_runtime_state` | 加密的 Cookie/变量快照、fingerprint、版本和五分钟租约 |
| `reader_settings` | 当前账号的主题、字号和行距 |

表定义位于 `server/db/schema.ts`，迁移位于 `server/db/migrations/`。共享书源字段和规则语义仍以根目录标准文档为准。

## 版本与身份

书源 `fingerprint` 区分功能定义版本；导入确认发现 fingerprint 改变时清除该源的运行状态。`user_sources.revision` 是用户源记录的当前版本，用于应用层判断变更。`editionKey` 将 sourceId、bookUrl 和 fingerprint 绑定到书籍来源版本；目录 `revision` 由章节序列摘要生成。正文缓存键包含 editionKey、目录 revision 和 chapterId，章节身份由 URL 与 index 的 SHA-256 摘要生成。

这些身份用于避免跨源和跨目录复用数据，不能替代用户授权。书源删除只清理源记录和运行状态；书籍、书架和阅读记录保留。

## 搜索与写入

搜索开始时写入 `search_runs` 和 `search_history`，每次来源完成后更新 sourceStates、候选、进度和 operationId。领取、更新和取消都带用户身份及当前操作条件，防止迟到结果覆盖新状态。搜索历史只记录摘要和数量，不保存 Cookie 或完整请求体。

导入确认在事务中锁定预览和用户源覆盖，候选 ID 去重后写入 `user_sources`。同一 sourceId 的定义更新保留用户 enabled/customOrder 状态；预览失效、候选不可写或数据库失败都不返回导入成功。

## 书籍来源候选

加入书架和搜索批次结算时，按 trim/NFC 后的书名和已知作者完全匹配，批量 upsert 同书候选。没有作者或“作者未知”时不自动合并。候选保存书名、作者、简介、封面、分类、字数、最新章节、更新时间、目录 URL，以及 JavaScript 详情脚本重建候选所需的 rawFields 和执行变量；不保存只能在搜索响应中使用的 infoPage 详情正文。缓存写入失败通过 cacheWarning 单独反馈，主保存结果保留。

列表合并缓存与有效 edition，edition 优先；读取时过滤删除、禁用和 fingerprint 不匹配的源。旧 fingerprint 行保留，重新搜索增量写入新版本；重新启用相同版本可恢复展示。无时间 TTL 和后台搜索，移出书架保留缓存，普通搜索不再更新该书缓存。打开候选时重新验证身份、源状态和版本，仅创建 edition，不覆盖书籍元数据、活动版本或阅读位置。新增表启用并强制 RLS，沿用 app.user_id。

## 运行状态加密与租约

`source_runtime_state.encrypted_state` 使用 AES-256-GCM，密钥来自服务端环境变量 `SOURCE_RUNTIME_STATE_KEY`，至少 32 个字符，明文上限 512 KiB。运行前取得 leaseToken 和 leaseUntil；只有持有 token 且版本仍匹配的调用可以提交新快照。提交成功后清除租约，失败时释放租约；旧 fingerprint 或过期 token 不能覆盖新状态。

Cookie、脚本变量和运行时缓存不进入浏览器响应，也不写入 raw/normalized source JSON。轮换密钥会使旧运行状态无法解密，需要重新建立书源会话。

## 目录、正文和阅读位置

目录成功后以 editionKey 为范围保存快照。refresh 跳过目录缓存并在成功后覆盖当前快照；预览其他来源不会写入当前 edition。正文成功后保存完整 `ChapterContent`，缓存命中不触发网络请求；正文请求失败保留旧缓存。

阅读位置是可变用户数据，与正文缓存分开。服务端保存章节 URL、章节索引、标题、目录 revision、段落索引、字符偏移和 version；前端离开阅读页或位置变化时提交，不能因为清理正文缓存而删除位置。

## 清理与恢复

过期导入预览在写入前清理。source runtime lease 通过时间判断可重新取得，进程退出不会留下永久占用。数据库迁移由显式命令执行，部署构建不自动修改 schema。数据库不可用时 API 返回错误并保留客户端当前页面状态，不回退为空书源列表。
