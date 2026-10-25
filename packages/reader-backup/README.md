# `@legado/reader-backup`

这个包定义 `reader-cli` 和 `reader-web` 共用的用户数据备份 ZIP。ZIP 根目录包含 `backup.json`，其余文件沿用 CLI 数据目录的相对路径：

- `book-lists.json`：可选书单扩展，归入 bookshelf 分类，封装数据为 `{lists,items}`；lists 保存普通书单、分组、customOrder，items 保存普通书单成员及独立评价
- `bookshelf.json` 和 `books/<bookId>/*`：书架及书籍元数据、书源版本记录
- `reading-history.json`：阅读位置
- `reading/bookmarks.json`、`reading/annotations.json`：可选 Web 书签与笔记扩展，归入 reading 分类
- `search-history.json`：搜索记录
- `sources.json`、`source-state.json`、`source-check-config.json`：书源和书源状态
- `reader-settings.json`：阅读设置。CLI 直接沿用 CLI 的设置文件内容，Web 使用 `web` 字段保存 Web 设置；导入另一端时会保留本端无法识别的设置。

`backup.json` 使用 `formatVersion: 1`，逐个记录文件字节数、SHA-256 和恢复分类。读取时会拒绝路径穿越、重复文件、未知路径、加密 ZIP、ZIP64、CRC 或 SHA-256 校验失败，以及超过条目数和字节预算的归档。备份只携带用户数据，不包含正文缓存、登录凭据、Cookie、运行时脚本变量或设备路径。

第一版固定使用 `sha256(sourceId + "\0" + bookUrl)` 作为 editionKey，并要求一个备份内的 `sourceId` 只有一个 fingerprint。恢复界面先完整校验 ZIP 和用户数据结构，再按书架、阅读记录、搜索记录、书源、设置分别选择，默认全选；选中的分类会完整覆盖对应用户数据，合法空数组表示清空该分类。阅读记录需要对应书籍和 edition 已经存在，或者和书架分类一起恢复。

Web 与 CLI 共享路径、封装和共同字段，但不把不存在于 Web 第一版数据库模型中的字段伪造成已恢复：Web 导出会为 CLI 的 `openedBookIds` 写空数组，搜索摘要只保留 Web 能保存的状态、结果数和文本摘要，阅读记录级 `lastOpenedAt`/独立更新时间、候选确认时间以及 CLI 书源检测 health/check 不在 Web 端持久化。CLI 导入仍会严格校验这些字段；跨端往返按共同字段验收；这些 CLI 专有字段仍不在 Web 端持久化。

当前只支持第一版格式，不提供历史 CLI 数据迁移或版本兼容层。大小限制为最多 30,000 个文件、单文件 64 MiB、总解压数据 128 MiB，压缩比最高 1,000 倍。

## 书单扩展兼容

书架关系可携带 groupId，未分组为 null。书单关联的书籍即使不在书架，也必须有对应书籍文件。读取扩展时校验名称、类型、顺序、唯一性和成员/分组引用；缺少 customOrder 的旧扩展按分组数组顺序生成。临时已移除行不进入备份。

新版读取器继续接收没有 book-lists.json 的旧第一版归档，缺少该文件表示保留本地书单和分组定义；恢复书架时保护这些书单引用的书籍。含扩展的归档选择 bookshelf 时完整替换组织数据，空 lists/items 表示清空。Web 恢复会重新分配导入组织标识并同步成员、书架归属和启动目标；旧备份中的书籍 ID 与本地书单引用冲突时映射导入书籍。只恢复设置时，目标分组不存在则使用全部。

CLI 不提供书单或分组界面，保留导入的扩展并随下一次导出携带；恢复旧备份保留本地书单依赖，遇到同 ID 不同书籍时拒绝并提示使用 Web 恢复。CLI 保存自己的设置时保留 web 设置文档。格式版本仍为 1，但旧版读取器严格拒绝新增路径，因此含书单的新备份需要更新后的应用恢复。

## Web批注扩展兼容

两个reading扩展文件使用schemaVersion 1封装，保存书籍/来源/章节身份、文字锚点、摘录、颜色、想法、创建/更新时间、版本和deletedAt，包含已删除记录。恢复reading时，存在的文件替换对应账号数据，空数组清空；缺失文件保留当前数据。恢复重映射账号与书籍身份，校验书籍版本依赖，和现有恢复事务一起提交或回滚。

格式版本仍为1，旧版应用严格拒绝新增路径，因此需要更新后的应用读取。CLI不展示或持久化这两个Web专属文件，CLI重新导出不会保留Web批注；需要保留笔记时使用Web导出与恢复。
