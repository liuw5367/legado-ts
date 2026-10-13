# 真实书源 fixture

本文件记录 `fixtures/source` 语料如何进入测试。它只定义输入、manifest 和离线边界；规则语义仍以 standard 与流程文档为准。

## Corpus 与 manifest

测试读取 `fixtures/source/collection` 和 `fixtures/source/single`，通过受控 file reader 进入统一 `importSources` 入口。集合文件逐项展开，单文件对象与集合成员都必须经过相同的规范化、未知字段保留和诊断路径。默认测试不访问公网、不使用真实账号，也不执行写操作。

`fixtures/corpus/manifest.json` 是语料快照，记录每个文件的候选数、状态数、诊断数和已知坏规则。已知坏规则属于真实源文件本身，必须单独登记；新增编译失败应使测试失败，不能放宽解析器或修改 fixture 来消除回归。

## 验收内容

- 文件、文本和已解析 JSON 输入得到可比较的候选身份、未知字段和诊断；
- 最大文件、候选和响应限制以及取消不会污染其他候选；
- JSON、HTML/CSS、XPath、JavaScript、字体和加密代表性源使用本地响应 fixture 做 smoke test；
- 动态脚本、登录、字体或加密等宿主依赖返回明确诊断，不被当作普通空结果；
- 真实网站、账号和非幂等写入属于显式 integration 运行，不进入默认测试。

更新语料后运行 `node fixtures/corpus/regenerate.mjs` 生成新的 manifest，再运行 `pnpm run test:source`。manifest 的数量变化是输入变化证据，不单独证明兼容性完成。

## 证据边界

fixture 测试只能证明固定输入下的离线行为。公网可达性、账号登录、站点变化和部署宿主能力需要单独记录；没有 Android 输入/输出证据的 Web 目标只能标记为 design 或 not-run。
