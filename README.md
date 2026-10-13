# Legado TS

Legado TS 是一个以兼容 [Legado](https://github.com/LegadoTeam/legado) 书源行为为目标的 TypeScript 书源运行时。它负责导入书源、解释规则，并编排从发现和搜索到书籍详情、目录和正文的处理流程。

仓库同时提供两个使用同一运行时的阅读应用：交互式终端阅读器和带服务端书源代理的 Web 阅读器。核心运行时不负责书架、阅读进度或界面状态；这些数据由应用保存。

## 主要能力

- 解析 JSON 和 JavaScript 书源，保留未识别字段并提供导入诊断。
- 执行 CSS、XPath、JSONPath 和 JavaScript 规则，生成可判别的成功、空结果、部分失败、取消和能力缺失结果。
- 编排发现、搜索、详情、目录、正文和正文缓存流程，并通过宿主端口注入网络、Cookie、解析器、字符集和 JavaScript 能力。
- 提供 Node 宿主实现，包括 HTTP、Cookie、HTML/JSONPath/XPath、QuickJS、字体、归档、加密和并发能力。
- 提供 `legado-reader` 终端阅读器，以及使用 React、Hono、Supabase 和 Postgres 的 Web 阅读器。

## 仓库组成

| 单元 | 用途 | 入口 |
| --- | --- | --- |
| `@legado/source-core` | 平台无关的书源 codec、规则、请求和阅读工作流 | [source-core 文档](packages/source-core/README.md) |
| `@legado/source-node` | Node 宿主适配和 `createNodeSourceSession` | [source-node 文档](packages/source-node/README.md) |
| `@legado/reader-cli` | 终端阅读器、书架、本地阅读状态和书源管理 | [CLI README](apps/reader-cli/README.md) |
| `@legado/reader-web` | Web 阅读器、账号、书源管理、目录和正文 | [Web README](apps/reader-web/README.md) |

`source-core` 不依赖 Node。浏览器应用不直接执行 Node 宿主；reader-web 通过服务端调用共享运行时，并把用户范围和持久化交给应用层。

## 快速开始：终端阅读器

需要 Node.js、pnpm 11 和一份自备的 JSON 或 JavaScript 书源。仓库不附带可直接阅读的线上书源。

```bash
pnpm install --frozen-lockfile
pnpm build
node apps/reader-cli/dist/index.js --source ./path/to/sources.json
```

也可以通过环境变量提供书源：

```bash
LEGADO_READER_SOURCE=https://example.test/sources.json \
  node apps/reader-cli/dist/index.js
```

启动后按 `Ctrl+K` 搜索，选择书籍后进入详情、目录和正文。`--source` 优先于 `LEGADO_READER_SOURCE`；支持单个文件、目录和 HTTP(S) JSON 地址。完整键位、数据目录和单文件构建见 [CLI README](apps/reader-cli/README.md)。

## 其他使用路径

- **集成书源运行时**：先看 [source-core 文档](packages/source-core/README.md) 的边界和 API，再看 [source-node 文档](packages/source-node/README.md) 中的 Node session 示例与安全边界。
- **运行 Web 阅读器**：先阅读 [Web README](apps/reader-web/README.md)，再按 [开发与部署](apps/reader-web/docs/development-and-deployment.md) 配置 Supabase、数据库和服务端密钥。
- **理解兼容范围**：查看 [运行时状态总览](docs/compatibility/status.md)、[能力清单](docs/compatibility/capabilities.md) 和 [已知差异](docs/compatibility/known-divergences.md)。
- **研究规则和流程**：从 [共享文档库](docs/README.md) 进入上游来源、流程、架构、兼容性和运维主题。

## 当前支持边界

文本书源的导入、规则求值、请求处理和四类阅读流程已经有 TypeScript 实现、Node 宿主和自动测试。WebView、复杂登录、验证码、付费动作、部分交互事件和结构化段评仍需要额外宿主协议或应用能力。

“已有实现”与“已完成 Android 同输入兼容验证”是两个状态。跨端验证、能力缺失和有意保留的差异统一记录在[运行时状态总览](docs/compatibility/status.md)和[已知差异](docs/compatibility/known-divergences.md)，不要根据一次构建成功推断完整兼容。

## 验证

```bash
pnpm typecheck
pnpm test
```

书源专项检查、静态兼容性审计和 Web 检查命令见[兼容性与验证](docs/compatibility/README.md)、[CLI 文档](apps/reader-cli/docs/README.md)和 [Web 文档](apps/reader-web/docs/README.md)。

## 许可证状态

当前仓库尚未包含 `LICENSE` 文件。正式对外发布前，需要由项目维护者选择并添加适用许可证，同时核对上游代码、第三方依赖和 fixture 的公开范围。
