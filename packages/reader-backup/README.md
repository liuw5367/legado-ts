# `@legado/reader-backup`

这个包定义 `reader-cli` 和 `reader-web` 共用的用户数据备份 ZIP。ZIP 根目录包含 `backup.json`，其余文件沿用 CLI 数据目录的相对路径：

- `bookshelf.json` 和 `books/<bookId>/*`：书架及书籍元数据、书源版本记录
- `reading-history.json`：阅读位置
- `search-history.json`：搜索记录
- `sources.json`、`source-state.json`、`source-check-config.json`：书源和书源状态
- `reader-settings.json`：阅读设置。CLI 直接沿用 CLI 的设置文件内容，Web 使用 `web` 字段保存 Web 设置；导入另一端时会保留本端无法识别的设置。

`backup.json` 使用 `formatVersion: 1`，逐个记录文件字节数、SHA-256 和恢复分类。读取时会拒绝路径穿越、重复文件、未知路径、加密 ZIP、ZIP64、CRC 或 SHA-256 校验失败，以及超过条目数和字节预算的归档。备份只携带用户数据，不包含正文缓存、登录凭据、Cookie、运行时脚本变量或设备路径。

恢复界面先校验 ZIP 和用户数据结构，再按书架、阅读记录、搜索记录、书源、设置分别选择。选中的分类会覆盖对应用户数据；阅读记录需要对应书籍已经存在，或者和书架分类一起恢复。
