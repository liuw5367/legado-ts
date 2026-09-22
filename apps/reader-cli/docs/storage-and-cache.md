# 命令行阅读器存储与缓存

## 目录

```text
~/.config/reader-cli/
  data-v1/
    manifest.json
    search-history.json
    reading-history.json
    bookshelf.json
    books/<bookId>/
      book.json
      sources.json
  cache-v1/
    index.json
    source-input/<sha256>.json
    toc/<sha256>.json
    content/<sha256>.json
    tmp/
```

每个持久 JSON 文件都有 `schemaVersion`、`revision`、`updatedAt` 和 `data` 封装。缺失文件按空集合初始化；损坏文件保留为带时间戳的 `.corrupt-*.json`，不会静默删除。写入使用同目录临时文件、`fsync` 和原子替换。

## 持久数据

`search-history.json` 保存最近 100 次搜索的关键词、来源范围、分源摘要、候选数量和已打开的 `bookId`，首页展示最近 20 次。重复关键词不会覆盖旧时间线。

`reading-history.json` 每条记录对应一个 `bookId`，保存各 `editionKey` 的章节 URL、索引、标题、段落索引、字符偏移和 `lastReadAt`。记录同时支持书架内和未加入书架的书，未加入书架的阅读记录最多保留最近 200 本。

`bookshelf.json` 只保存 `bookId`、加入时间和更新时间，是书架关系唯一事实源。最近阅读页面读取时将它与阅读记录关联，计算 `isOnBookshelf`，不会复制一个持久化布尔值。

`books/<bookId>/book.json` 保存逻辑书籍的展示信息和当前活动版本。`sources.json` 保存已经搜索到的来源候选，包含 `editionKey`、sourceId、fingerprint、bookUrl、搜索返回字段、匹配类型和发现时间。相同 `(sourceId, bookUrl)` 再次出现时复用原 `bookId`。

## 缓存

缓存可以全部删除并重建，不决定书架、历史或书籍信息是否存在。`source-input` 保存远程来源最近一次成功原文；目录和正文缓存使用 `sourceDefinitionFingerprint + 核心工作流 key` 的 SHA-256，因此同一 URL 在规则更新后不会命中旧内容。缓存命中仍需检查书源定义和章节身份。

`index.json` 保存缓存文件相对路径、类别、字节数和最近访问时间。索引损坏时通过扫描目录重建；加载索引时只接受 `source-input|toc|content/<sha256>.json` 形式的路径，任何父目录、绝对路径或未知类别都会被丢弃，LRU 清理也会再次校验目标路径。缓存总量超过 512 MiB 时按 LRU 删除缓存文件，不能删除 `data-v1`。

## 书源切换

详情和阅读页进入书源页面时只读 `sources.json` 和当前来源目录。有效候选直接显示，可用性过期或来源被移除的候选禁止直接使用。用户按 `m` 后，只查询没有有效候选或 fingerprint 已变化的来源，进度实时显示，匹配当前书名的结果合并回 `sources.json`，不自动改变当前活动版本。

## 一致性和恢复

应用单进程写入同一数据目录，使用 `writer.lock` 排除第二个写实例。启动时执行只读一致性检查：书架和阅读记录引用的书籍必须存在，活动版本必须仍在已知来源集合中，缓存身份不匹配按未命中处理。可选的书籍文件损坏会备份为 `.corrupt-*.json` 并从首页跳过，不阻塞其他书籍。退出时先取消并等待活动工作流、写队列和缓存索引完成，再删除当前实例的锁。
