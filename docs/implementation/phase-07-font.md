# 任务 07-FONT：字体映射与文字解码

本任务是宿主扩展中的独立能力，目标是兼容书源用于反爬的字体映射。它处理字体文件到文字映射的转换，不负责阅读器字体渲染，也不把字体作为最终领域结果。

## 范围

- 兼容 Android `queryTTF`、`queryBase64TTF` 和 `replaceFont` 的已验证行为。
- 接受受控网络响应 bytes、Base64 和 `Uint8Array`；文件或 URL 读取必须经过宿主端口。
- 解析 Android 当前使用的 TrueType cmap/glyph 映射，按错误字体和正确字体反查 Unicode。
- 支持缓存、大小/时间预算、取消和明确的损坏字体/缺少 glyph 诊断。
- `replaceFont` 的普通模式和 `filter` 模式均返回文字。

不包含字体渲染、任意本地文件访问、浏览器字体加载，也不预先承诺 WOFF/OTF 等 Android 证据之外的格式。

## 端口边界

`source-core` 只定义 capability 和结果契约；TTF 二进制解析与缓存位于 `source-node`。解析器不得访问全局文件系统，字体 bytes 的来源、预算和取消由已有网络/宿主端口控制。

## 验收

- 已知 TTF 的 Unicode/glyph 映射与 Android 对照一致；
- Base64、bytes 和受控 URL 输入一致；
- 缺少 glyph、非法 cmap、截断文件、超大输入和取消均有可判别结果；
- `filter=false/true`、多字节 Unicode 和缓存命中均有测试；
- 未覆盖的字体格式返回 `capability-unavailable`，不得静默返回原文成功。

## 完成记录

- 2026-09-22：`NodeFontHost` 已支持 TrueType sfnt 的 cmap 0/4/6、glyf 轮廓签名反查、Base64 输入、四项 LRU 缓存、输入字节预算、取消前检查和 `replaceFont` 过滤语义；不包含字体渲染、全局文件读取、WOFF/WOFF2/CFF 支持。
