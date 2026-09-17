# 与书源关联的媒体和交互流程

以下能力由 `BookSource` 字段驱动，但一部分执行入口位于 Android 阅读界面或图片加载器。完整移植时需要保留它们的书源语义；Web 应用只负责触发用户动作和展示结果。现状与目标设计在下文分开说明，未核实的字段不能推断为已有完整执行流程。

## 图片与封面解密

`ImageUtils.decode` 根据 `isCover` 选择 `BookSource.coverDecodeJs` 或 `ContentRule.imageDecode`。规则为空时原样返回输入 bytes 或输入流；规则非空时执行脚本，绑定 `book`、`result` 和 `src`，要求结果是字节数组。Android 在脚本失败时记录错误并返回 `null`。它会影响封面与正文图片的实际显示，不能只在 schema 中保留脚本文本。

目标流程为：书源结果提供图片 URL，宿主按该 URL 获取 bytes，package 选择解密脚本并通过受限 JS runtime 执行，返回解密 bytes 或明确的解密失败。图片缓存键应包含书源身份、URL、解密规则版本和会话边界；未启用解密时避免无意义的脚本开销。Node、Edge、Next.js 适配器各自验证二进制请求、字节传递、取消与内存限制。

## 文件、音频、图片和视频类型

`BookSource.bookSourceType` 影响 `Book.type`，文件源在详情流程通过 `downloadUrls` 提供下载入口。`BookContent` 对音频和视频返回资源地址，不按普通文本做 HTML 格式化；其 `subContent` 可成为歌词或弹幕，并更新章节元数据。图片源的正文和解密仍需要图片宿主能力。文件源可能不具备普通章节目录与正文函数，不能强制套用文本书籍流程。

package 应输出带类型的书籍、章节与内容结果；应用据此选择显示或下载方式。类型字段、资源地址、附加元数据和错误必须在同一调用结果中保持可区分。文件下载的持久化位置由应用或宿主决定，书源 package 负责解释书源提供的 URL 与相关规则。类型专属 golden 不能用纯文本正文 fixture 替代。

## 付费章节动作

Android 阅读界面只在用户确认后执行 `ContentRule.payAction`。调用脚本时绑定 `java`、`book`、`chapter`、`title`、`baseUrl`、`result` 和 `src`。脚本返回绝对 URL 时打开浏览器页面；返回真值时清理该章旧正文并刷新目录；失败时记录错误。该行为见 `app/src/main/java/io/legado/app/ui/book/read/ReadBookActivity.kt` 的 `payAction`。

Web 目标应把用户确认、跳转和目录刷新分开：应用确认动作；package 执行书源脚本并返回 `open-url`、`refresh-toc` 或结构化错误；应用在校验目标 URL 后执行跳转或刷新。购买失败不能提前把章节标记为已购买，也不能清理可读的旧正文。相关认证、脚本能力和目标 URL 校验由宿主提供。

## 书源事件与自定义按钮

`BookSource.eventListener` 与 `ContentRule.callBackJs` 控制书源回调。`SourceCallBack` 定义点击作者、书名、自定义按钮、分享、清缓存、书架变动、开始与结束阅读等事件。按钮事件绑定 `event`、`java`、`result`、`book`、`chapter`；脚本返回真值时拦截默认动作，非真值时调用默认动作。Android 为同一自定义按钮请求去重，并在任务完成时释放占用。书籍事件和源事件走不同入口，超时与错误处理也不同。

package 需要版本化的事件输入和执行结果协议，宿主注入允许的 UI 动作。Web 应用可以只发送自己实际产生的事件，但不能把未知事件解释成某个已有事件。未实现的 UI 动作返回 capability error；超时、取消、组件离开和重复点击都必须释放按钮占用。用户可见的默认动作是否执行，应由脚本结果与错误策略共同决定，不能让异步回调在页面已变更后触发旧动作。

## 段评交互字段

`ReviewRule` 定义摘要、详情与回复读取规则，还保存点赞、点踩、发送评论、发送回复和删除地址。当前已核对的 `ReviewController` 与 `ReviewRuleParser` 主要执行读取与解析；仅凭写入字段存在，不能宣称 Android 已有相同的写入协议。因此，交互字段必须在导入、编辑和导出中保留，写入操作先继续追踪调用点和可观察行为。若原项目没有执行入口，Web 侧新增写入能力应标为目标设计，不能放入 Android 等价 golden。

写入能力的目标规格至少应说明用户确认、认证身份、请求构造、重复提交、失败恢复和服务端响应；缺少可核实语义时不让 package 根据 URL 字段自行猜测 HTTP 方法或请求体。读取摘要、详情与回复仍按 [JavaScript 书源](../reference/javascript-source.md) 和 [规则模型](../reference/source-schema.md) 验收。

## 扩展入口与生命周期

公开入口统一见 [调用契约](../guides/package-usage.md#公共调用协议)。结果需区分 text、image-content、audio、video、file-links；content 字符串保留兼容输入，不能仅靠 URL 后缀猜类型。音视频附加内容分别为歌词/弹幕；图片正文仍可含多个图片引用，不强制简化为单 URL。

decodeImage 无规则时原 bytes 返回，有规则则传 src/result/book，执行成功后才缓存；失败保持原缓存。文件下载先 resolveDownload，应用选择链接，再由宿主流式下载并验证最终目标与大小；不向网页暴露服务器文件路径。

购买与事件调用绑定 operationId 和用户确认，执行前验证书籍/章节归属，执行后返回显式动作。外部写入没有可证明幂等性时不自动重试；未知执行结果保留为 unknown。取消后的导航不得生效，已经完成的购买请求不能声称撤回。

字体、归档、加密工具也是脚本书源能力，已在 [宿主盘点](../reference/capability-inventory.md#宿主方法补充盘点) 登记。它们通过相应宿主执行并保留 bytes/文本边界；逐重载契约尚未完整时返回具体能力缺失，不能退回原文本或空文件并宣称成功。
