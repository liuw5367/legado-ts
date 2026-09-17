# Legado Web API 适配

## 依据与目标

本文以上层仓库根目录的 `api.md`（路径为 `../api.md`，相对于 `typescript/`）以及 Android 端 `BookSourceController`、`BookSourceCheckController` 的实现为依据，定义兼容适配器需要保留的行为。本文不要求复刻 Android 的 URL、Token 或 DAO 实现，也不修改 `api.md`。`api.md` 属于外层仓库；独立克隆 `typescript/` 时应把它视为外部协议输入，而不是本仓库的必需文件。

适配器的目标是：已有 Legado 客户端可以继续调用；新 Web 应用则使用更安全的用户会话 API；两者共用 package 的解析和检测能力。保存策略必须显式区分 `android-compatible` 与 `web-safe`，详见[书源管理与状态](../reference/source-management-and-state.md#6-插入策略与兼容实现事实)，不能把不同入口的持久化副作用描述成完全相同。

## 书源相关端点映射

| Android 端点/通道 | 已观察到的行为 | 适配器职责 | package 是否负责 |
| --- | --- | --- | --- |
| `POST /saveBookSource` | 单个 JSON；名称和 URL 不能为空；有效后直接保存 | 解析 body、鉴权、调用 save policy | 解析/规范化/诊断 |
| `POST /saveBookSources` | JSON 数组；逐项解析；无效成员被跳过；最终直接写 DAO | 保留兼容语义并返回逐项结果；必要时提供新应用的确认模式 | 解析/比较 |
| `POST /saveJsSource` | `text/plain`；体积约束 1 MiB；30 秒读取限制；依赖 `openedSourceUrl` | 限制请求、解析 JS source、处理重命名/冲突 | JS source 解析契约 |
| `GET /getBookSource` | 按 URL 查询单个书源 | 授权、查询和脱敏 | source snapshot 模型 |
| `GET /getBookSources` | 返回当前实例的书源列表 | 改为当前用户范围；不得泄露其他用户 | 无存储实现 |
| `GET /getBookSourcesForManagement` | 在同一事务快照中返回书源及对应检测状态；可用 `urls` JSON 数组筛选 | 保持 `sources`/`states` 同快照、按当前用户授权并脱敏 | 源快照与检测状态模型 |
| `DELETE /deleteBookSources` | 按 URL 批量删除，并清理相关运行时状态 | 授权、确认、事务删除和审计 | 删除副作用契约 |
| `GET /getBookSourceCheckStates` | 读取书源检测状态 | 返回用户范围状态和脱敏摘要 | 检测状态模型 |
| `POST /startBookSourceCheck` | 校验当前 source snapshot/checkContent，创建会话 token | 启动任务并返回 session；避免旧版本写回 | 检测编排 |
| `POST /stopBookSourceCheck` | 用会话 token 停止任务 | 取消任务并回传状态 | 取消信号接口 |
| WS `searchBook` | 首个文本帧只接收 `{ key: string }`；搜索范围来自已保存书源和应用配置，不从首帧接收 source URL | 兼容 Token、首帧超时、连接生命周期和结果流 | 搜索编排 |
| WS `bookSourceDebug` | 调试指定规则/URL，并在 Android 侧要求书源已保存 | 鉴权、限流、调试数据脱敏 | 规则执行/诊断 |

端点名称、字段和状态码以 `api.md` 与实际 Controller 为准；本表是迁移边界，不是新的公开 API 规范。

## 关键兼容细节

### 普通与批量保存

普通保存的最小校验是名称和 `bookSourceUrl` 非空。批量保存的 Android 实现会跳过无效数组成员，而不是把整批作为事务失败；适配器应将 `accepted`、`skipped` 及每项诊断显式返回，避免调用方误以为所有条目都已保存。Android Controller 直接写 DAO，可能绕过 `SourceHelp` 的域名拦截和排序修正；新 Web 应用推荐先预览、执行 `web-safe` 插入策略，再按 Repository 事务确认，见[保存流程](../workflows/source-persistence-flow.md)。

### JS 书源

JS source 上传应使用 `text/plain`（允许 `charset` 参数），禁止 `Transfer-Encoding`，必须提供不超过 1 MiB 的正确 `Content-Length`。访问令牌在读取 body 前校验；通过后再在约 30 秒读取/保存时限内处理，HTTP 层去除脚本文本首尾空白，拒绝不符合传输约束的请求。解析时保留来源 URL；`openedSourceUrl` 用来判断关联旧脚本是否存在，重命名时清理旧记录并保留允许继承的用户状态。JS source 的脚本执行不能默认放进 Edge：需要 WebView、动态脚本或 Node 能力时必须通过 capability 检查路由到 Node worker。

### 查询、删除与秘密

查询结果应只返回导入/运行所需的非秘密字段。cookie、密码、token、请求头和用户变量应由 SecretStore 单独管理，API 只能返回是否存在、过期时间或脱敏摘要。删除必须执行保存流程中定义的清理：检查状态、变量、缓存和秘密引用；书籍/章节/阅读进度是否删除由应用策略决定，默认保留。

### 搜索与调试前置条件

Android 的搜索/调试 API 依赖已保存书源，不能把任意未保存 JSON 当作正常书源缓存查询。搜索 WebSocket 在建立后约 10 秒内必须收到唯一首帧 `{ key }`；调试 WebSocket 的首帧才是 `{ tag, key }`，其中 `tag` 查找已保存书源。兼容适配器应明确区分：`SOURCE_NOT_FOUND`、`SOURCE_DISABLED`、`SOURCE_REVISION_CONFLICT`、网络失败和规则解析失败。

### 书源检测

启动检测前应验证提交的 source snapshot/checkContent 仍对应当前版本，并生成不可猜测的 session token。停止时只接受该会话 token；检测完成写回时还必须校验 userId、sourceId 和 sourceRevision。Android 的 WebSocket/token 机制只在 adapter 中实现，核心 package 只接收抽象的取消信号和运行时端口。

## 传输与安全边界

兼容旧客户端时，适配器可以实现 `X-Legado-Token` 和 WebSocket subprotocol 等协议；新 Web 应用应使用自己的登录会话、服务端授权和 CSRF/CORS 策略。绝不能把 Android token 直接当作跨用户数据库授权，也不能让浏览器直连拥有服务端密钥的 Supabase client。

请求体、响应体、并发数、单源总耗时和调试日志都要有上限。错误信息需要保留 sourceId 和 item index 等定位信息，但必须脱敏 URL query、Authorization、cookie 和脚本秘密。

## 不纳入当前 package 的 API

`api.md` 中的书架、阅读进度、书籍缓存、RSS 管理、内容提供者、替换规则、MCP 和设备控制等能力不属于当前书源核心 package。本 package 可以为“取得书/章节/正文”提供领域结果；订阅链接返回多个 `BookSource` 仍属于书源导入范围。`RssSource` 与 `ReplaceRule` 是独立实体能力，当前只在订阅适配器中登记 `type` 分支和兼容边界，尚未纳入核心 CRUD；是否扩展为独立 package 能力必须按能力清单单独审核，不能静默视为已支持或已放弃。

## 验收标准

- 兼容端点的输入校验、批量跳过、JS 限制、已保存前置条件和检测会话语义都有测试。
- 管理列表端点能在同一快照返回书源与检测状态；搜索与调试首帧字段、超时和已保存前置条件都有测试。
- 兼容 API 与新应用 API 共用 package，不在 Controller 中复制规则解析。
- 所有数据访问都绑定当前用户；兼容 Token 只负责 adapter 鉴权。
- Edge/Node 不可用能力会显式返回 unsupported，而不是运行到一半超时。
