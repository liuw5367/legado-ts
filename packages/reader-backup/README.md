# `@legado/reader-backup`

这个包定义 `reader-cli` 和 `reader-web` 共用的用户数据备份 ZIP。ZIP 根目录包含 `backup.json`，其余文件沿用 CLI 数据目录的相对路径：

- `bookshelf.json` 和 `books/<bookId>/*`：书架及书籍元数据、书源版本记录
- `reading-history.json`：阅读位置
- `search-history.json`：搜索记录
- `sources.json`、`source-state.json`、`source-check-config.json`：书源和书源状态
- `reader-settings.json`：阅读设置。CLI 直接沿用 CLI 的设置文件内容，Web 使用 `web` 字段保存 Web 设置；导入另一端时会保留本端无法识别的设置。

`backup.json` 使用 `formatVersion: 1`，逐个记录文件字节数、SHA-256 和恢复分类。读取时会拒绝路径穿越、重复文件、未知路径、加密 ZIP、ZIP64、CRC 或 SHA-256 校验失败，以及超过条目数和字节预算的归档。备份只携带用户数据，不包含正文缓存、登录凭据、Cookie、运行时脚本变量或设备路径。

第一版固定使用 `sha256(sourceId + "\0" + bookUrl)` 作为 editionKey，并要求一个备份内的 `sourceId` 只有一个 fingerprint。恢复界面先完整校验 ZIP 和用户数据结构，再按书架、阅读记录、搜索记录、书源、设置分别选择，默认全选；选中的分类会完整覆盖对应用户数据，合法空数组表示清空该分类。阅读记录需要对应书籍和 edition 已经存在，或者和书架分类一起恢复。

Web 与 CLI 共享路径、封装和共同字段，但不把不存在于 Web 第一版数据库模型中的字段伪造成已恢复：Web 导出会为 CLI 的 `openedBookIds` 写空数组，搜索摘要只保留 Web 能保存的状态、结果数和文本摘要，阅读记录级 `lastOpenedAt`/独立更新时间以及候选确认时间不在 Web 端持久化。CLI 导入仍会严格校验这些字段；跨端往返按共同字段验收，不新增数据库迁移。

当前只支持第一版格式，不提供历史 CLI 数据迁移或版本兼容层。大小限制为最多 30,000 个文件、单文件 64 MiB、总解压数据 128 MiB，压缩比最高 1,000 倍。
