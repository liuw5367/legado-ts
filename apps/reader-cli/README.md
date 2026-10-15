# `@legado/reader-cli`

`@legado/reader-cli` 是基于 `@legado/source-core` 和 `@legado/source-node` 的交互式终端阅读器。它负责书源加载、多源搜索、书籍详情、目录、正文、书架和本地阅读状态；规则解释和单源工作流仍由共享 package 提供。

## 使用

在仓库根目录安装依赖并构建 workspace：

```bash
pnpm install --frozen-lockfile
pnpm build
```

通过参数或环境变量提供书源：

```bash
node apps/reader-cli/dist/index.js --source ./fixtures/source
LEGADO_READER_SOURCE=https://example.test/sources.json \
  node apps/reader-cli/dist/index.js
```

`--source` 优先于 `LEGADO_READER_SOURCE`。来源可以是单个 JSON/JavaScript 文件、目录或 HTTP(S) JSON 地址；目录递归读取 `.json` 和 `.js`。导入和网络响应会受到字节、文件数和候选数限制。

也可以把书源嵌入 Bun 单文件程序：

```bash
pnpm build:binary --source-dir ./fixtures/source/single --outfile ./dist/legado-reader
./dist/legado-reader
```

更新内置书源需要重新构建。`--target` 可以选择 Bun 支持的其他平台目标。

## 可以做什么

- 首页提供书架、最近阅读、搜索记录、书源管理和设置。
- 搜索支持多源并发、结果合并、精准匹配、续页和取消；已返回的结果可以继续查看。
- 详情、目录和阅读页支持来源切换、目录筛选、正倒序、正文刷新和章节导航。
- 书源管理支持筛选、启用/禁用、优先级调整和按 Android 顺序执行的来源检测。
- 本地保存书源状态、书架、阅读位置和正文缓存；正文缓存与用户状态分开管理。
- `backup export <zip>` 导出与 Web 共用的第一版用户数据 ZIP；`backup import <zip>` 会先完整校验，再在确认后按 `--only` 分类完整替换书架、阅读记录、搜索记录、书源或设置。备份不包含正文缓存、凭据和运行时状态；当前不迁移历史 CLI 数据。

首版主要面向文本书源。音频、图片、视频、文件下载、复杂登录和 WebView 需要额外宿主能力，当前状态见[兼容性与验证](../../docs/compatibility/README.md)。

## 常用按键

| 页面 | 按键 |
| --- | --- |
| 全局 | `Ctrl+K` 搜索，`?` 帮助，`d` 诊断，`Esc` 取消或返回，`q` 退出 |
| 搜索和列表 | `j/k` 或方向键移动，`Enter` 打开，`n` 请求下一页，`Ctrl+P` 切换精准搜索 |
| 详情 | `Enter` 阅读，`t` 目录，`s` 书源，`a` 书架 |
| 目录 | `/` 筛选，`r` 刷新，`s` 切换顺序，`Enter` 阅读 |
| 阅读 | 方向键或 `j/k` 翻页，左右方向键或 `h/l` 切章，`i` 详情，`t` 目录，`r` 刷新 |
| 书源管理 | 空格选择，`c` 检测，`x/e` 禁用或启用，`f` 选择本次失败项，`p` 调整优先级 |

完整页面行为、导航规则和低尺寸终端处理见[交互设计](docs/interaction.md)；功能边界见[应用功能](docs/features.md)。

备份 ZIP 使用 `packages/reader-backup` 定义的固定路径和 `sha256(sourceId + "\0" + bookUrl)` editionKey。导入前会检查书架、书籍、edition、阅读引用、书源指纹和设置值；选中书架时会替换完整书籍闭包，未选分类保留原值。

## 数据目录

默认数据目录是 `~/.config/reader-cli/data-v1`，可删除缓存目录是 `~/.config/reader-cli/cache-v1`。文件模型、版本、写入顺序和恢复规则见[存储与缓存](docs/storage-and-cache.md)。

非 TTY 环境只支持 `--help` 和 `--version`，不会启动备用屏幕或写入阅读状态。

## 文档与检查

- [CLI 文档入口](docs/README.md)
- [架构](docs/architecture.md)
- [当前实现](docs/implementation.md)
- [功能说明](docs/features.md)
- [交互设计](docs/interaction.md)
- [存储与缓存](docs/storage-and-cache.md)

```bash
pnpm --filter @legado/reader-cli build
pnpm --filter @legado/reader-cli test
```

终端预览集中在[交互设计中的页面预览](docs/interaction.md#页面预览)，SVG 资产位于 `docs/screenshots/`。
