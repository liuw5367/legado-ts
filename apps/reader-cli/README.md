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
- 搜索并发最多四个书源，搜索结果进入书籍后记录同名候选的已知书源。
- 搜索页实时显示 `已完成/总书源数`、当前书源和候选数量；搜索中按 `Esc` 取消并返回首页，不会残留“搜索中”状态。
- 详情页、目录页和阅读页支持 `a` 加入或移出书架。
- 已知书源页只读本地候选列表；`m` 才会搜索更多书源，已有有效候选不会再次请求。
- 阅读页支持滚动、翻页、目录跳转、上一章和下一章，并保存段落锚点和上次阅读时间。
- 首版仅处理文本书源，音频、图片、视频、文件下载、登录和 WebView 需要后续宿主能力。

## 常用按键

| 页面 | 按键 |
| --- | --- |
| 全局 | `Ctrl+K` 搜书，`?` 帮助，`d` 诊断，`Esc` 返回，`q` 退出 |
| 搜索 | 输入关键词，`Enter` 提交 |
| 列表 | `j/k` 或方向键移动，`Enter` 打开 |
| 详情 | `t` 目录，`s` 已知书源，`a` 书架 |
| 目录 | `j/k` 移动，`Enter` 阅读 |
| 阅读 | `j/k` 滚动，空格翻页，`b` 回退，`[`/`]` 切章，`t` 目录，`s` 书源 |
| 已知书源 | `Enter` 使用本地候选，`m` 手动搜索更多 |

## 数据目录

持久数据和可删除缓存分开保存。详细字段、写入顺序和恢复规则见：

- [交互设计](docs/interaction.md)
- [应用功能](docs/features.md)
- [应用架构](docs/architecture.md)
- [存储与缓存](docs/storage-and-cache.md)

## 页面预览

当前页面的静态终端预览集中在[交互设计中的页面预览](docs/interaction.md#页面预览)，SVG 资产位于 `docs/screenshots/`。预览覆盖首页、搜索进度与取消、结果、详情、目录、阅读、已知书源、书源映射、配置、帮助和诊断页面。

![阅读页预览](docs/screenshots/reader.svg)

默认持久数据目录为 Linux 的 `~/.local/state/legado-reader/data-v1`、macOS 的 `~/Library/Application Support/legado-reader/data-v1`、Windows 的 `%LOCALAPPDATA%/legado-reader/data-v1`。缓存目录统一为用户目录下的 `~/.config/reader-cli`。

## 验证

```bash
pnpm --filter @legado/reader-cli build
pnpm --filter @legado/reader-cli test
```

非 TTY 环境只支持 `--help` 和 `--version`，不会启动备用屏幕或写入阅读状态。
