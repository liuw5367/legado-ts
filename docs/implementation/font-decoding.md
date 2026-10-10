# 字体映射与文字解码

字体解码是 source-node 的宿主能力，用于把书源的反爬字体映射为文字。它不负责阅读器字体渲染，也不把字体文件作为领域结果保存。

## 当前实现

`NodeFontHost` 支持 Android 对照中已验证的 TrueType sfnt cmap 0/4/6、glyf 轮廓签名反查、Base64 和 `Uint8Array` 输入，以及 `replaceFont` 的普通和 `filter` 模式。`source-core` 只定义 capability 和结果契约，字体 bytes 的读取、预算、取消和缓存由宿主提供。

支持的输入来自受控网络响应、Base64 或 bytes。宿主不允许字体解析器直接访问全局文件系统；WOFF/WOFF2/CFF、浏览器字体加载和字体渲染不在当前支持范围内，未覆盖格式必须返回能力缺失或明确诊断。

## 资源与失败

字体解析有输入字节预算、缓存容量和取消检查。损坏 cmap、截断文件、缺少 glyph、超大输入和取消都必须产生可判别结果，不能静默返回原文成功。缓存只影响性能，不能改变书源身份或正文缓存版本。

## 验证

字体映射、Base64/bytes 一致性、过滤模式、多字节 Unicode、缓存命中和错误输入由 `packages/source-node/tests/font.test.ts` 覆盖。兼容性结论仍需 Android 对照样本；实现存在不代表所有字体格式都已支持。
