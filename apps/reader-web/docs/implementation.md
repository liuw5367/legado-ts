# reader-web 实现方案

## 书源导入与管理

`/sources` 通过 `POST /api/source-management/import-preview` 提交 HTTP(S) 地址。服务端限制响应大小、总字节数、候选数、来源 URL 数量和 45 秒预览时间，调用共享 `importSources` 后与当前用户源快照比较，生成带过期时间的预览记录。页面只显示脱敏摘要，用户选择候选后再调用 `import-confirm`；确认事务保留用户的启用和排序状态，定义指纹变化时清除旧运行状态。

启用、禁用和删除通过 `/api/source-management/actions` 批量处理。删除源配置和加密运行状态，但书籍、书架和阅读记录由独立业务关系保存。接口按当前用户查询，不接受客户端传入的 userId。

## 搜索、流式进度与取消

`POST /api/searches` 创建搜索记录，写入关键词、来源范围和精准模式。`GET /api/searches/:id/stream` 以 SSE 推送每个来源的状态、候选和进度；`POST /api/searches/:searchId/batches` 用同一搜索记录请求带游标的下一页。页面把 source 事件合并到当前候选快照，候选归并和排序调用 source-core 结果。

取消同时中止浏览器请求、调用 `POST /api/searches/:searchId/cancel` 更新数据库状态，并由 runtime 中止活动来源的 `AbortController`。已经持久化的候选保留在结果页；未完成来源标记为 `cancelled`。同一搜索已经被其他操作领取时，Repository 的 operationId 条件会拒绝迟到更新。

## 从候选到书籍

`POST /api/books` 根据搜索记录中的候选索引加载书籍详情，使用 `sourceId + bookUrl + sourceFingerprint` 生成 editionKey。新书可以加入书架，也可以追加到已有书籍；书籍本体和来源版本分开保存，活动 edition 由应用显式更新。书籍详情失败不会创建不完整版本。

## 目录、正文和来源切换

目录接口先按 userId、bookId、editionKey 查找快照；快照的 sourceFingerprint 与当前书源一致且未请求 refresh 时直接返回。未命中或 refresh 时，runtime 创建 Node source session，调用 `loadTableOfContents`，按章节列表摘要生成 revision 后保存。

正文接口按目录 revision 和 chapterId 查找缓存。chapterId 是章节 URL 与 index 的 SHA-256 摘要；缓存命中且来源 fingerprint 一致时不请求网络。未命中时调用 `loadChapterContent`，限制正文输出为 4 MiB，成功后保存内容。阅读页提交段落索引、字符偏移和 version 到 reading_records，并以 editionKey 保存每个来源版本的阅读位置。

来源页面可以查看同一本书的其他 editions；切换来源只更新活动 edition，不因查看目录自动切换。点击其他来源的章节后，阅读页用该 edition 的目录和正文，并保存新的阅读位置。

## 状态、错误与安全

API 将未登录、输入无效、资源不存在、来源忙、配置错误和运行失败映射为明确错误。运行结果保留 `success`、`empty`、`partial`、`failed`、`cancelled` 和 `capability-missing`，前端分别展示空态、失败提示和取消后的已有结果。Cookie 与脚本变量不进入浏览器 DTO，也不写入普通 source JSON。

运行状态使用 AES-256-GCM 加密，密钥来自服务端 `SOURCE_RUNTIME_STATE_KEY`，明文大小最多 512 KiB。来源 session 关闭后才保存快照；fingerprint、lease token 或版本不匹配时拒绝写回，避免并发请求覆盖较新的 Cookie/变量。

## 当前非范围

当前 Web 没有订阅自动刷新、持久 JobStore/Worker、完整书源编辑器、Android 旧 Web API/WebSocket 兼容和交互式 WebView 登录。相关目标与限制见根目录 [archive](../../../docs/archive/README.md) 和 [能力清单](../../../docs/standard/capability-inventory.md)，不能从当前 API 的存在推断这些能力已实现。

## 验证

```bash
pnpm --filter @legado/reader-web typecheck
pnpm --filter @legado/reader-web build
pnpm --filter @legado/reader-web test
pnpm --filter @legado/reader-web test:db
```

Vercel 静态产物另用 `pnpm run build:web:vercel` 验证；部署配置和数据库迁移步骤见 [开发与部署](development-and-deployment.md)。
