# source-node 宿主实现

本文记录当前 `@legado/source-node` 的装配方式，不定义新的跨平台 API。平台无关的规则、请求计划、工作流和结果契约以 [`@legado/source-core`](../../source-core/README.md) 为准。

## Session 装配

`createNodeSourceSession(source, options)` 把一个不可变 `NormalizedSource` 交给 core 的 `createSourceSession`。默认装配链如下：

```text
createNodeSourceSession
  ├─ NodeCookieStore
  ├─ NodeNetworkHost ── undici/fetch
  ├─ NodeCharsetCodec
  ├─ SourceRequestHost ── 请求计划、Cookie bridge、响应解码
  └─ SourceRuleHost
       ├─ HTML / JSONPath / XPath adapter
       ├─ QuickJSJavaScriptHost
       ├─ NodeEncodingHost / NodeCryptoHost / NodeFontHost / NodeSourceFileHost
       ├─ NodeSourceRuntimePlatform（设备、配置、转换和可注入宿主动作）
       ├─ NodeSourceConcurrency（跨执行 SourceLock）
       └─ source-core SourceRuleRuntime
```

`NodeSourceSessionOptions` 可替换网络、Cookie、字符集、脚本缓存、初始 source 变量、时钟、并发端口、平台端口和文件根目录。没有传入 `cookieStore` 时，session 创建自己的 `NodeCookieStore`；没有传入网络时，`NodeNetworkHost` 使用同一个 Cookie store。请求 host 把当前书源通过每次 bridge 调用传入，避免并发书源共享可变的“当前 source”字段。登录 header、登录信息、source variable 和 source key/value 在 session 内按源 URL 隔离；动态 loginUi 默认值沿用 `BaseSource.getLoginInfoMap()` 的执行顺序。默认 `NodeSourceRuntimePlatform` 提供 t2s/s2t、稳定的宿主 deviceID、阅读/主题配置和 source 导航上下文；浏览器、WebView、验证码、媒体和 UI 动作通过 `platform` 注入，未注入时保留明确的 capability-missing。`NodeSourceConcurrency` 把 Android `singleFlight`、`lock` 和 `tick` 的等待、跳过、取消、溢出与 LRU 语义放在 session 之外的宿主端口中，避免同一源的不同脚本执行只看到局部锁。

## 请求与规则桥接

`SourceRequestHost` 只组合 Node 能力，书源请求选项和工作流语义仍由 core 执行。规则中的 network、network-all 和 network-response bridge 经过同一请求运行时；Cookie get/set/remove 只作用于当前 URL 和 session 的 Cookie store，token bridge 当前明确拒绝。`network-all` 最多同时处理 8 个地址；异步 bridge 调用链的嵌套深度上限为 3，超出返回配置错误。嵌套请求会跳过动态 source header，只保留静态头，以切断 header 脚本自递归。

响应解码按 BOM、响应头 charset、HTML/XML 元数据、`chardet` 和 UTF-8 回退的顺序尝试。解码失败会继续尝试后续候选，最终使用 `TextDecoder`；这只影响本次响应文本，不修改 source 身份或正文缓存版本。

`SourceRuleHost` 把 core 的规则运行时接到 HTML、JSONPath、XPath、QuickJS、编码、加密和字体 host。JavaScript 不使用 Node 的 `eval`、`Function` 或 `node:vm`，而是在独立 QuickJS context 中执行，并在完成、取消、超时或序列化失败时释放 context 和 handle。默认单次脚本预算为：超时 1000 ms、内存 16 MiB、栈 1 MiB、输入 512 KiB、输出 1 MiB、bridge 调用 32 次；调用方可通过 core 的 JavaScript budget 覆盖，但仍必须是有限的整数限制。

## 网络宿主

`NodeNetworkHost` 默认使用与当前 Android 对照相同的 User-Agent：

```text
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36
```

调用方可以通过 `NodeNetworkOptions.defaultUserAgent` 覆盖它。默认协议为 HTTP/HTTPS；URL 中的用户名和密码会被拒绝。环回、私网、链路本地地址以及 DNS 解析到这些地址的目标默认拒绝，只有显式设置 `allowPrivateNetworks: true` 才放行。每次重定向都会重新检查地址；跨 origin 重定向会移除原请求的 Authorization、Proxy-Authorization 和 Cookie 头，然后只按新目标 URL 合并它自己的 Cookie store。书源要求代理时当前 Node 宿主返回 `capability-missing`，不会静默直连。

core 当前请求计划默认值为 15 秒、32 次请求、16 页、单响应 4 MiB、总响应 16 MiB、请求体 1 MiB、5 次重定向；工作流可以在更小的范围内覆盖。Node 层还按实际读取的字节限制响应和总量，保存 `Set-Cookie`，并返回最终 URL、状态、头、字节和是否重定向。`cookieJar: false` 时不保存响应 Cookie；显式请求 Cookie 与 session Cookie 按名称合并，显式值优先。

## 文件、字体与归档

CLI 的 `readSourcePath` 只递归普通目录，跳过符号链接，默认最多读取 256 个 `.json`/`.js` 文件，每个文件最多 4 MiB。它只返回输入文本和诊断，不把文件内容写入运行时缓存。

`NodeSourceFileHost` 实现 Android 文件桥的全部方法名：相对 root 的 `getFile`、bytes/文本读取、删除、脚本导入、下载、cacheFile、目录文本合并和归档条目读取。root 默认为系统临时目录下的 `legado-source-cache`，可由 `fileRoot` 覆盖；路径穿越、root 内符号链接和归档条目穿越都会拒绝。下载文件沿用 Android 的 root 下 MD5 文件名并返回带 `/` 的相对路径，URL options 中的 `type` 会优先决定扩展名；无扩展名时使用 `ext`。下载和归档读取沿用请求取消与 32 MiB 响应预算；cacheFile 的 TTL 写入受控元数据，因此 session 每次操作重建 file host 后仍能保持过期语义。`readTxtFile` 无显式字符集时按 BOM、`chardet`、有效 UTF-8 和 GB18030 回退探测。`getFile().absolutePath` 保持 root 内的相对元数据，不暴露 Node 实际磁盘路径。

`NodeFontHost` 当前支持 TrueType/sfnt 的 cmap 0/4/6、`glyf` 轮廓签名反查、Base64/bytes 输入和 `replaceFont` 的普通与 filter 模式；默认字体缓存最多 4 个映射、单次输入最多 16 MiB。WOFF、WOFF2、CFF、浏览器字体加载和渲染不在支持范围内。`NodeArchiveHost` 支持 gzip 与 zip，默认最多 64 个条目、单条目 8 MiB、总输出 32 MiB、压缩比 1000；RAR/7z 方法会返回明确能力错误，绝对路径、`.`、`..`、加密条目、zip64 和未知压缩方法会被拒绝。

QuickJS 只负责同步调用动作；`singleFlight`、`lock`、`tick` 由 `NodeSourceConcurrency` 在脚本执行之间共享。WebView、浏览器、验证码、媒体播放器和 UI 刷新仍需要应用注入平台动作；默认 Node 平台不会把这些动作伪装成成功。设备身份是按宿主 seed 派生、可重置的非物理标识，不应单独用于 Android 设备鉴权。

## 生命周期与所有权

一次 session 拥有本次规则工作流使用的 Cookie、变量、QuickJS context、请求观察器和可选脚本缓存引用。应用必须在 `await` 的工作流结束、取消已完成资源清理后调用 `session.close()`；session 关闭后迟到结果不得继续恢复脚本、写入缓存或更新应用状态。书架、正文、阅读进度、用户凭据和跨请求任务由应用存储或其他宿主负责，不能从本包的 session 推断持久化语义。

兼容性工具会复用上述宿主，但报告属于审计证据，不是运行时状态表。更多边界见[安全与部署](security-and-deployment.md)，静态/在线审计的输入和脱敏见[兼容性审计](compatibility-audit.md)。
