# reader-cli 实现方案

## 启动与来源加载

`src/index.tsx` 负责解析命令行参数、判断 TTY 和启动 Ink。来源输入按 `--source`、`LEGADO_READER_SOURCE`、构建时嵌入来源的顺序选择；外部来源优先于内置来源。`source-catalog.ts` 通过 `source-policy.ts` 限制目录深度、文件数量、响应大小和候选数，再把候选交给 `source-core` 的导入入口。冲突来源不会进入默认搜索队列，`bookSourceUrl` 是兼容身份，定义指纹用于区分版本。

`source-session.ts` 为每个来源建立独立的 Cookie、网络和规则会话。搜索、详情、目录和正文每次创建请求门面，操作结束后关闭 session；持久 Cookie 和源变量由 `ReaderStorage` 交给下一次会话使用。CLI 不在页面层重新解析规则。

## 应用层与页面层

`application.ts` 是跨来源用例门面，负责来源筛选、并发额度、任务生命周期、搜索历史和阅读记录；`storage.ts` 负责 JSON 存储和正文 `ContentStore`。`ui.tsx`、`ui-pages.tsx` 和 `ui-model.ts` 只负责页面状态、导航栈、焦点和展示模型。页面动作在 `ui-actions.ts` 统一按终端宽度裁剪，避免把业务流程复制到每个页面。

## 搜索和续页

新搜索先写入 search history，再按设置中的搜索并发数为启用来源创建工作项。每个来源调用 `searchBooks`，结果通过 `SearchUpdateListener` 增量提交不可变快照；`search-results.ts` 只把 source-core 的候选组映射为页面模型。候选归并、匹配等级和稳定排序由核心包决定，CLI 附加来源状态、耗时和诊断。

取消通过 `AbortController` 传入每个来源。第一次 `Esc` 只取消正在运行的操作，并等待网络、脚本和写入队列清理；已经返回的候选继续留在结果页。结果页的 `n` 根据每个来源的 `nextCursor` 复用同一个搜索记录续页，已成功来源的候选不会被无条件清空。

## 详情、目录和正文

打开候选时使用 `(sourceId, bookUrl)` 复用已知来源，详情成功后补全书籍元数据。目录调用 `loadTableOfContents`，成功结果按来源指纹写入书籍目录快照；预览其他来源不会改变活动来源。正文使用书源、目录 revision 和章节身份组成的 `ContentIdentity` 调用 `loadStoredChapterContent`，缓存命中时跳过网络，刷新时使用条件写入避免旧请求覆盖新正文。

正文成功后先更新活动来源、章节和阅读记录，再按节流策略保存阅读位置。元数据更新失败不会删除已经保存的阅读记录；下次打开书籍时可以根据阅读记录修复活动来源。移出书架只删除关系，保留书籍、来源和阅读进度。

## 书源管理与诊断

书源管理页面固定本次检测的来源快照，检测依次执行域名、搜索、详情、目录和正文，以及第一个有效发现分类的同一组阶段。`source-check.ts` 为每个来源记录状态、耗时、trace 和诊断；取消时未完成来源保持 `cancelled`，已经确认失败的来源可以在页面中再次选择并批量禁用。`debug-runner.ts` 复用同一 session 顺序执行流程，`debug-capture.ts` 负责请求编号、截断和脱敏，`debug-export.ts` 只输出脱敏 Markdown/JSON。

## 终态与资源释放

页面可见终态使用 `success`、`empty`、`partial`、`failed`、`cancelled` 和 `capability-missing`。空列表不能代替失败，宿主缺少能力不能伪装成空结果。路由切换清除旧页面消息；退出前先取消并等待活动流程、写队列和缓存索引，再释放实例锁。

共享工作流的输入、输出和宿主端口见 [package 使用指南](../../../docs/implementation/package-usage.md)；CLI 特有的文件和页面行为以本目录其他文档为准。

## 验证入口

```bash
pnpm --filter @legado/reader-cli build
pnpm --filter @legado/reader-cli test
```

这些命令验证当前 package 的构建和应用测试，不等同于 Android 兼容性已经全部完成；跨端证据见 [质量与验证](../../../docs/quality/README.md)。
