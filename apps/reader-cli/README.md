# @legado/reader-cli

`@legado/reader-cli` 是基于 `@legado/source-core` 和 `@legado/source-node` 的交互式命令行阅读器。它负责来源加载、搜索、书籍信息、目录、正文、书架和本地阅读状态，核心 package 只负责书源规则解释和阅读工作流。

## 使用

先构建 workspace：

```bash
pnpm build
```

通过参数或环境变量提供书源：

```bash
node apps/reader-cli/dist/index.js --source ./fixtures/source
LEGADO_READER_SOURCE=https://example.test/sources.json node apps/reader-cli/dist/index.js
```

参数 `--source` 优先于 `LEGADO_READER_SOURCE`。来源可以是单个 JSON/JavaScript 文件、目录或 HTTP/HTTPS JSON 地址。目录递归读取 `.json` 和 `.js`，不跟随符号链接；导入和网络响应均有字节、文件数和候选数限制。

## 功能边界

- 首页包含书架、最近阅读和搜索记录入口。
- 搜索并发最多四个书源；某个书源返回后立即把候选增量显示在结果页，并将同书名、同作者的候选合并为一项。
- 结果按完全匹配、包含关键词、其他三档排序，第一条候选显示书源、搜索耗时和已聚合书源数；结果列表显示绝对序号，支持 j/k 或上下键逐项移动、左右键或 PageUp/PageDown 翻页、Home/End 首尾跳转。
- 搜索页实时显示 `已完成/总书源数`、当前书源和候选数量；搜索中按 `Esc` 取消但留在结果页，保留已返回结果，只有非搜索状态下的 `Esc` 才返回上一页。
- 详情页显示当前书源、搜索耗时、最新章节和更新时间，并提供开始/继续阅读、章节列表、书源切换和加入书架入口；界面时间统一为上海时区 `YYYY-MM-DD HH:mm:ss`。
- 详情、目录、正文、已知书源和辅助页均按终端高度内部滚动；`o` 只在书架/最近阅读、搜索结果和详情页打开统一操作菜单，菜单以居中的页内边框覆盖层显示，底层页面保持可见。
- 已知书源页只读本地候选列表；当前书源固定置顶，其余按搜索耗时从短到长排列；`m` 才会搜索更多书源，已有有效候选不会再次请求。
- 阅读页支持滚动、左右键/PageUp/PageDown 翻页、目录跳转、上一章和下一章，`r` 刷新当前章节正文，并保存段落锚点和上次阅读时间；HTML 正文支持段落、标题、引用、列表、预格式文本和图片占位。
- 首版仅处理文本书源，音频、图片、视频、文件下载、登录和 WebView 需要后续宿主能力。

## 常用按键

| 页面 | 按键 |
| --- | --- |
| 全局 | `Ctrl+K` 搜书，`?` 帮助，`d` 诊断，`Esc` 取消当前搜索/返回，`q` 退出 |
| 搜索 | 输入关键词，`Enter` 提交 |
| 列表 | `j/k`、上下方向键移动，左右方向键或 `PageUp/PageDown` 翻页，`Home/End` 首尾，`Enter` 打开；书架/搜索结果可用 `o` 操作 |
| 详情 | `Enter` 开始/继续阅读，`t` 目录，`s` 书源，`a` 书架，`o` 操作菜单 |
| 目录 | `j/k`、上下方向键移动，左右方向键或分页键翻页，`Home/End` 首尾，`Enter` 阅读 |
| 阅读 | `j/k` 滚动，左右方向键/空格翻页，`b` 回退，`[`/`]` 切章，`t` 目录，`s` 书源，`a` 书架，`r` 刷新正文 |
| 已知书源 | `Enter` 使用本地候选，`m` 手动搜索更多，搜索期间 `j/k` 或上下键选择增量结果，左右方向键或分页键翻页 |

`o` 菜单固定提供“继续阅读、书籍信息、章节列表、书源切换”。当前页面或普通异步操作不允许的动作会显示禁用原因；搜索中已返回的候选仍可操作，执行时会先取消剩余来源；底部键位栏始终只显示一行，放不下的低优先级动作会省略。HTML 输入不会执行脚本或下载图片。

## 数据目录

持久数据和可删除缓存分开保存。详细字段、写入顺序和恢复规则见：

- [交互设计](docs/interaction.md)
- [应用功能](docs/features.md)
- [应用架构](docs/architecture.md)
- [存储与缓存](docs/storage-and-cache.md)

## 页面预览

当前页面的静态终端预览集中在[交互设计中的页面预览](docs/interaction.md#页面预览)，SVG 资产位于 `docs/screenshots/`。预览覆盖首页、搜索进度与取消、结果、详情、目录、阅读、已知书源、书源映射、配置、帮助和诊断页面。

![阅读页预览](docs/screenshots/reader.svg)

默认数据目录为 `~/.config/reader-cli/data-v1`，缓存目录为 `~/.config/reader-cli/cache-v1`。

## 验证

```bash
pnpm --filter @legado/reader-cli build
pnpm --filter @legado/reader-cli test
```

非 TTY 环境只支持 `--help` 和 `--version`，不会启动备用屏幕或写入阅读状态。
