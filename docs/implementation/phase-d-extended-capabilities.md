# 阶段 D：批量、媒体与交互扩展

**状态：** 部分完成（字体、加密、归档、并发宿主已实现；段评、付费、事件、批量正文等未完成，2026-09-24 核对）。

本阶段按 [能力清单](../standard/capability-inventory.md) 逐项增加功能，每项完成后都能独立进入兼容矩阵。核心层定义执行语义与调用协议，宿主实现脚本、浏览器、文件和用户交互能力。低优先级只影响实施时间；建议舍弃某项能力时，先提交可核对的理由和兼容损失供用户审核。

## 扩展能力公共输出

扩展入口都使用可判别结果，不把 JavaScript 的任意对象直接暴露给应用：

```ts
type MarshalledValue =
  | { kind: 'null' }
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'array'; value: MarshalledValue[] }
  | { kind: 'object'; value: Record<string, MarshalledValue> }

interface BinaryReference {
  /** 二进制响应的独立资源身份；实际 bytes 通过宿主二进制响应返回。 */
  resourceId: string
  mimeType?: string
  size: number
  url?: string
}

type MediaValue =
  | { kind: 'text'; content: string }
  | { kind: 'image' | 'audio' | 'video' | 'file'; url?: string; resource?: BinaryReference; mimeType?: string }

interface ExtendedResult<T> {
  status: 'success' | 'empty' | 'partial' | 'failed' | 'cancelled' | 'stale' | 'unknown' | 'capability-missing'
  value?: T
  diagnostics: RuntimeDiagnostic[]
  effects: EffectRecord[]
  changes: DomainChange[]
  operationId: string
  cleanup: { status: 'complete' | 'partial' | 'failed'; pending: string[] }
}
```

数组顺序、`null`、空数组、未回存章节、批量乱序回调、媒体资源元数据和解密失败都必须由结果字段表达；`Uint8Array` 只能存在于宿主内部或独立二进制响应，不能进入 `ExtendedResult` 的 JSON DTO；“脚本返回了对象”不构成可保存的领域对象。

## 基础 JS 前置与批量扩展

下列第 1 至 3 项由 B/C 设计和验证，runtime 已建立基础能力后复用并回归验证；第 4 项批量（`getContentBatch`）为本阶段新增，**尚未实现**。基础脚本能力不能等到 D 才提供。

1. 在隔离的 `JavaScriptRuntime` 中执行导入脚本，抽取 `config` 或兼容旧版 `source`，验证必需函数与成对函数。完整 `mainJs` 原文继续由 codec 保留；导入失败返回脚本、配置或函数阶段的错误，不覆盖已保存书源。
2. 以一次函数调用为单位创建 scope，绑定 `java`、`source/sourceApi`、`cookie`、`cache`、当前书籍、章节及请求变量。脚本的网络、Cookie、缓存和文件操作只能通过经过授权的宿主 API；每次调用设置超时、取消、资源限额和可追踪日志。
3. 先执行 `search`、`explore`、`getBookInfo`、`getChapters`、`getContent`，再通过同一 marshaller 归一化数组、对象、字符串、`toJSON`、getter 与空值。不能直接把脚本返回对象写入应用的 `Book` 或目录存储。
4. 增加 `getContentBatch`、`java.cacheContent` 和保存 token；未回存章节按正文规格兜底。批量 scope 关闭后拒绝迟到写入，回调乱序不能改变章节身份。

JS 源的公开入口与声明式源在目标设计中共用 `searchOne`、`explore`、`getBookInfo`、`getChapterList`、`getContent`（历史名；当前导出为 `searchBooks` / `discoverBooks` / `loadBookDetails` / `loadTableOfContents` / `loadChapterContent`，见 [包使用](package-usage.md)）。分流只发生在 package 内；应用不根据 `mainJs` 自行调用脚本。先完成 `IMP-008` 至 `IMP-010`、`JS-001` 至 `JS-003`、`FLOW-012`，然后把对应能力标记为已验证。

## 媒体、文件和图片解密

为文本、音频、图片、视频和文件结果建立带类型的输出与宿主消费约定。文件源的 `downloadUrls` 由详情入口归一化，实际下载由宿主负责。音频、视频正文返回资源地址，歌词或弹幕更新章节元数据。图片请求保留 bytes，按 `coverDecodeJs` 或 `imageDecode` 选择脚本并绑定 `src`、`result`、`book`；脚本失败不缓存损坏输出。按 [媒体与交互流程](../flows/adjacent-source-flows.md) 验证 `MEDIA-001` 至 `MEDIA-003`，再分别验证 Node 与目标部署宿主。

## 段评与用户动作

段评读取先实现结构化摘要、详情分页和回复，声明式规则与 JS 函数各走自己的输入路径；同时保留 `getDP/getZP` 旧式网页桥接及其 nonce 会话、CSP/sandbox 和脚本回调边界。结构化入口统一输出段落索引、评论 ID、内容协议和分页状态，旧式入口返回隔离页面会话，具体顺序见[段评流程](../flows/review-flow.md)。`JS-004`、`REVIEW-001` 与读取组合测试必须能区分合法空评论、规则失败、缺失宿主能力和旧式会话错误。

`payAction`、`callBackJs` 和自定义按钮需要应用触发事件。package 接收书源、书籍、章节、事件名及用户确认状态，执行脚本后返回明确动作，例如打开 URL、刷新目录、拦截默认动作或继续默认动作；应用根据结果执行导航与持久化。脚本不能直接调用网页全局对象或绕开宿主授权。按钮重复触发、组件离开、取消、超时和错误都释放占用，旧事件不能影响新页面。使用 `ACTION-001` 与 `ACTION-003` 验证。

`ReviewRule` 的写入地址目前只有字段证据，尚未确认 Android 执行协议。先继续追踪调用点；若确无执行入口，写入功能单列为 Web 目标设计，并由用户确认请求方法、认证与结果契约。完成前至少保证字段导入、编辑和导出不丢失，不能根据 URL 字段自行发起点赞或删除请求。待验证状态必须包含“无执行证据/禁止自动调用/下一步证据”，不能只写一个 URL。

## 登录、浏览器与平台能力

静态 Header、Cookie、Token 与 `loginCheckJs` 已属于优先路径。交互式登录、验证码、多步骤认证与动态 `loginUi/loginAction` 随后作为宿主协议实施：应用展示表单或挑战，package 保持书源函数与参数语义，宿主保存按用户和书源隔离的认证状态。失败、过期和重新登录均返回可识别状态，不能让一个用户的 Cookie 进入另一个请求。

`@webjs:`、WebView 页面脚本、资源嗅探、代理和 DNS 覆盖需要各自的宿主能力。Node 的浏览器适配器与普通 HTTP 适配器分别测试；Edge 若缺少某项能力，通过路由交给具备能力的宿主或报告 capability error。不能用静态 HTML 解析结果冒充执行了页面脚本。`LOGIN-001`、`LOGIN-002`、`URL-005` 和相关规则 fixture 验证这些路径。

每增加宿主方法，同步[宿主接口](runtime-host-interfaces.md)、[能力清单](../standard/capability-inventory.md)与具体案例。CAP-ARCHIVE、CAP-FONT、加密工厂返回对象及应用绑定的方法按能力清单逐重载实现；原文保留不等于运行支持。归档验证路径/大小限制，字体验证轮廓映射，锁验证同源互斥与释放。动态登录和段评写入的阻塞项必须先确定参数与副作用，不能根据字段名猜测。
