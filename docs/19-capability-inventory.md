# 书源能力清单与审核决策

目标是完整移植 `BookSource` 的可观察行为。优先级表示实施顺序，不表示放弃。若某项收益低且显著增加架构成本，应先给出使用场景、原实现证据、替代方案和兼容损失，再由用户审核是否舍弃。未经审核的能力保留在清单中，未实现时必须返回能力状态和可识别的错误。

本清单以 `BookSource`、规则对象、`WebBook`、`AnalyzeRule`、`AnalyzeUrl`、`JsSourceBook` 及调用它们的 Android 入口为盘点起点。它记录已发现的能力类别，不等于已经完成逐字段与逐调用点的行为验证；兼容结论仍以 [兼容性矩阵](13-compatibility-matrix.md) 和独立 fixture 为准。`RssSource` 是另一个实体与处理体系，是否纳入同一个 package 需要单独评估，不能把它当成 `BookSource` 的已支持能力。

| 能力组 | 需要形成的行为规格 | 当前文档位置 | 优先级与待核对内容 |
| --- | --- | --- | --- |
| 导入、更新、导出 | JSON、JS、远程地址、替换、冲突、未知字段和原文保留 | [导入](03-import-protocol.md)、[编辑](16-source-editor.md) | 优先；核对更新后的缓存失效和版本身份 |
| 书源字段与类型 | `BookSource`、规则对象、文本/音频/图片/文件/视频类型 | [模型](02-source-schema.md) | 优先；各类型从列表到消费结果的行为需分开验收 |
| 规则语言 | CSS、XPath、JSONPath、正则、组合、变量、内嵌 JS、WebJS | [规则](04-rule-language.md) | 优先；WebJS 需浏览器宿主能力 |
| URL 与请求 | 参数、页码、Body、Header、Cookie、重试、重定向、代理和 DNS | [URL](05-url-request-rules.md) | 优先；代理与 DNS 由宿主实现并验证 |
| 搜索与发现 | 多源搜索、精准搜索、分类入口、筛选状态、发现列表 | [搜索](06-search-flow.md)、[发现](17-explore-flow.md) | 优先；`exploreScreen` 和分类交互需要继续核对 |
| 详情与目录 | 字段覆盖、文件下载地址、目录刷新、分页、卷、VIP 和顺序 | [详情](07-book-info-flow.md)、[目录](08-chapter-list-flow.md) | 优先；文件类源需专门结果契约 |
| 正文与批量 | 正文分页、清洗、替换、缓存、批量、元数据保存 | [正文](09-content-flow.md) | 优先；音频、视频、图片和文件资源不能只按文本正文测试 |
| JavaScript 书源 | 配置抽取、函数调用、返回值、同步兼容 API、变量和脚本 scope | [JS](10-javascript-source.md)、[宿主](11-runtime-host-interfaces.md) | 优先；核对 `JsExtensions` 中未列出的实际书源依赖 |
| 图片与封面解密 | `coverDecodeJs`、`imageDecode` 的字节输入、脚本输出与缓存 | [模型](02-source-schema.md) | 后续规格；需核对 `ImageUtils` 及图片请求链 |
| 付费与受限章节 | VIP/购买标识、`payAction`、授权状态、执行后刷新 | [目录](08-chapter-list-flow.md)、[模型](02-source-schema.md) | 后续规格；需核对用户触发、凭据和失败恢复 |
| 段评读取与交互 | 摘要、详情、回复、点赞、发送和删除规则 | [JS](10-javascript-source.md)、[模型](02-source-schema.md) | 读取行为已发现；写入目前只有字段证据，先核实执行入口 |
| 登录与认证 | 静态 Header/Cookie、`loginCheckJs`、登录表单、验证码和动态登录 | [请求](05-url-request-rules.md)、[JS](10-javascript-source.md) | 静态能力优先；交互登录低优先级，保留完整目标 |
| 浏览器行为 | WebView 请求、`@webjs:`、资源嗅探和页面脚本 | [请求](05-url-request-rules.md)、[宿主](11-runtime-host-interfaces.md) | 后续宿主能力；不能把普通 HTTP 当成等价实现 |
| 书源交互与事件 | `eventListener`、`customButton`、正文回调和宿主 UI 动作 | [模型](02-source-schema.md) | 后续规格；需核对 `SourceCallBack` 和调用方事件协议 |
| 书源编辑与诊断 | 字段编辑、未知字段保留、规则预览、保存冲突、导入导出 | [编辑](16-source-editor.md) | 优先；所有能力字段至少可见、可保留、可诊断 |

## 处理规则

每组能力都需要同一组可核验材料：原实现入口、字段与规则、输入、处理顺序、输出、状态变化、失败与取消、宿主依赖、应用调用点，以及成功、错误和边界 fixture。仅有字段注释或源码路径不能说明一项能力已经完整移植。

能力状态应分开记录：`已登记`、`行为已核对`、`规格已完成`、`TypeScript 已实现`、`目标宿主已验证`。此外记录优先级和宿主能力要求。若某个目标宿主缺少能力，仍可在其他宿主实现该能力；只有用户审核并明确同意后，才能把能力状态改为 `放弃`。低优先级不能写成永久不支持。

图片解密、付费、事件回调、媒体结果和段评交互的已核对调用关系见 [与书源关联的媒体和交互流程](20-adjacent-source-flows.md)。下一轮审查应继续追踪未核实的调用点，并把对应测试加入 [一致性测试基线](15-conformance-tests.md)。书源编辑器的字段覆盖也应按本清单反查，确保能导入、显示、保留和导出尚未执行的能力字段。
