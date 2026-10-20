# reader-web 实现方案

## 书源导入与管理

`/sources` 通过 `POST /api/source-management/import-preview` 提交 HTTP(S) 地址。服务端限制响应大小、总字节数、候选数、来源 URL 数量和 45 秒预览时间，网络宿主最多执行五次重定向、六次请求，每跳检查目标地址；调用共享 `importSources` 后与当前用户源快照比较，生成带过期时间的预览记录。页面只显示脱敏摘要，用户选择候选后再调用 `import-confirm`；确认事务保留用户的启用和排序状态，定义指纹变化时清除旧运行状态。

启用、禁用和删除通过 `/api/source-management/actions` 批量处理。删除源配置和加密运行状态，但书籍、书架和阅读记录由独立业务关系保存。接口按当前用户查询，不接受客户端传入的 userId。

来源管理和搜索运行时按来源 URL 的 hostname 归组（保留非默认端口），启用动作保证同一域名只有一个账号默认实现。旧数据存在多个启用项时，运行时按管理顺序选择一个有效版本，不写回修复数据库。管理页版本排序和更新时间显示使用导入 JSON 的 `lastUpdateTime`，不使用应用本地更新时间；同域同名的不同实现会加编号。导入同域新实现不会覆盖已有默认版本。

## 搜索、流式进度与取消

`POST /api/searches` 创建搜索记录，写入关键词、来源范围和精准模式。`GET /api/searches/:id/stream` 以 SSE 推送每个来源的状态、候选和进度。普通搜索与换源页共享搜索生命周期，合并 source 事件到当前候选快照；Web 客户端收到仍有下一页游标的来源后自动请求 `POST /api/searches/:searchId/batches`，直到所有来源完成，并按约 5 秒更新一次可见进度，批次结束时立即刷新。搜索页展示同域实现选择；切换域名默认版本先取消并等待当前搜索，再用更新后的账号默认来源范围重新搜索。创建请求尚未取得 searchId 时取消，会在创建返回后补发取消请求；取消完成前不允许启动下一次搜索。

取消同时中止浏览器请求、调用 `POST /api/searches/:searchId/cancel` 更新数据库状态，并由 runtime 中止活动来源的 `AbortController`。已经持久化的候选保留在结果页；未完成来源标记为 `cancelled`。同一搜索已经被其他操作领取时，Repository 的 operationId 条件会拒绝迟到更新。

## 从候选到书籍

`POST /api/books` 根据搜索记录中的候选索引加载书籍详情，使用 `sourceId + bookUrl + sourceFingerprint` 生成 editionKey。新书可以加入书架，也可以追加到已有书籍；书籍本体和来源版本分开保存，活动 edition 由应用显式更新。书籍详情失败不会创建不完整版本。

新页面同时提交候选的 sourceId、sourceFingerprint 和 bookUrl，服务端在当前账号保存的搜索结果中匹配这一身份，避免流式重排造成索引错配。未提交身份的旧调用仍兼容索引；客户端不能通过身份对象传入书籍元数据或脚本变量。

## 目录、正文和来源切换

目录接口先按 userId、bookId、editionKey 查找快照；快照的 sourceFingerprint 与当前书源一致且未请求 refresh 时直接返回。未命中或 refresh 时，runtime 创建 Node source session，调用 `loadTableOfContents`，按章节列表摘要生成 revision 后保存。

正文接口按目录 revision 和 chapterId 查找缓存。chapterId 是章节 URL 与 index 的 SHA-256 摘要；缓存命中且来源 fingerprint 一致时不请求网络。未命中时调用 `loadChapterContent`，限制正文输出为 4 MiB，成功后保存内容。阅读页提交段落索引、字符偏移和 version 到 reading_records，并以 editionKey 保存每个来源版本的阅读位置。阅读设置通过现有 `/api/settings` 保存；`reader_settings.preferences` 是按 `general`、`display` 分组的 JSONB 唯一设置文档。`0009_reader_settings_json.sql` 移除旧阅读列，并以默认 JSON 初始化，现有账号设置会重置为默认值。设置 API 保持对旧阅读字段的兼容校验，新增偏好存入文档，不再为每项新增数据库列。

书架按账号通用设置排序，默认按加入时间倒序；选择阅读时间后，按书籍所有版本的最近阅读时间倒序，未读书籍排在末尾，并以加入时间作为次序相同时的排序依据。

分页阅读在浏览器端基于固定高度的 CSS 多列布局生成屏幕页，不使用正文接口返回的 `ChapterContent.pages`。`column-width` 使用正文视口实际 `clientWidth` 注入的像素长度，避免百分比声明被浏览器忽略；正文等待字体、图片和容器尺寸稳定后，以实际 `scrollWidth` 和视口宽度计算页数，再通过 `scrollLeft` 定位当前页。分页模式的正文高度占满阅读视口，不叠加隐藏操作栏的预留高度，只应用安全区域和账号阅读设置中的四边距；边距、字号、行距和窗口尺寸变化后重新计算分页。翻页只保存当前页首个可见段落，调整布局后按该段落重新定位；分页布局无法取得有效几何结果时显示可重试或切换滚动阅读的恢复态。分页模式的翻页区域位于顶部更多菜单的书籍详情下面，通过全屏遮罩展示左侧上一页、中央操作栏切换和右侧下一页三个点击区域，遮罩点击或 Escape 会关闭翻页区域。

来源页面通过 `GET /api/books/:bookId/sources` 合并有效 editions 与持久候选，按来源、fingerprint 和 URL 去重；保留停用但未删除的实现，并返回其启用状态，过滤已删除或 fingerprint 已变化的实现。`POST /api/books/:bookId/sources/:candidateId/open` 按当前用户和书籍取得缓存候选，重新验证源与详情身份后仅保存 edition。加入书架及搜索批次结算增量缓存明确同书候选，失败通过可选 cacheWarning 反馈。

来源页面按该书已有候选或 edition 所属域名分组，并展示同域其他实现。选择尚非账号默认的实现前，页面先通过源管理动作将它设为账号默认版本，再打开目录、候选或仅对本书搜索。查看目录或创建 edition 不激活本书 edition；切换来源先加载目录和该版本的阅读位置，进入有效章节后由阅读页更新活动 edition。

`GET /api/books/:bookId/details` 按当前用户验证书籍和指定 edition 的所有权，返回可展示的详情字段与书架状态，不执行书源脚本、不激活 edition，不返回变量、rawFields 或运行状态。`GET /api/source-management?all=true` 返回筛选后的全部摘要；未指定该参数的调用仍保留原分页契约。

## 状态、错误与安全

API 将未登录、输入无效、资源不存在、来源忙、配置错误和运行失败映射为明确错误。运行结果保留 `success`、`empty`、`partial`、`failed`、`cancelled` 和 `capability-missing`，前端分别展示空态、失败提示和取消后的已有结果。Cookie 与脚本变量不进入浏览器 DTO，也不写入普通 source JSON。

运行状态使用 AES-256-GCM 加密，密钥来自服务端 `SOURCE_RUNTIME_STATE_KEY`，明文大小最多 512 KiB。来源 session 关闭后才保存快照；fingerprint、lease token 或版本不匹配时拒绝写回，避免并发请求覆盖较新的 Cookie/变量。

## 当前非范围

当前 Web 没有订阅自动刷新、持久 JobStore/Worker、完整书源编辑器、Android 旧 Web API/WebSocket 兼容和交互式 WebView 登录。相关目标与限制见根目录 [archive](../../../docs/archive/README.md) 和 [能力清单](../../../docs/compatibility/capabilities.md)，不能从当前 API 的存在推断这些能力已实现。

## 验证

```bash
pnpm --filter @legado/reader-web typecheck
pnpm --filter @legado/reader-web build
pnpm --filter @legado/reader-web test
pnpm --filter @legado/reader-web test:db
```

Vercel 静态产物另用 `pnpm run build:web:vercel` 验证；部署配置和数据库迁移步骤见 [开发与部署](development-and-deployment.md)。
