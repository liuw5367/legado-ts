# 当前实现

本目录记录 TypeScript 仓库中已经存在的书源运行时入口、宿主契约与阶段验证记录。公开 API 以 `packages/source-core/src/public/index.ts` 为准；与 [书源规则标准](../standard/README.md) 的不一致登记在 [已知差异](../divergence/known-divergences.md)。

## 入口与契约

- [package 使用指南](package-usage.md)：公开入口、调用方式与结果形状。
- [运行时统一契约](runtime-contracts.md)：请求计划、结果终态、副作用与错误命名。
- [宿主接口](runtime-host-interfaces.md)：核心与 Node 宿主之间的端口和错误契约。

## 阶段与验证记录

- [阶段 A：模型、导入与编辑基础](phase-a-codec-editor.md)
- [阶段 B：规则引擎与请求计划](phase-b-rules-request.md)
- [阶段 C：发现、搜索、详情、目录与正文](phase-c-workflows.md)
- [阶段 D：批量、媒体与交互扩展](phase-d-extended-capabilities.md)
- [任务 07-FONT：字体映射与文字解码](phase-07-font.md)
- [任务 07-A：书源解析兼容测试](phase-07-a-source-conformance.md)
- [任务 07-B：真实书源文件测试](phase-07-b-source-fixtures.md)
- [任务 07-C：兼容性静态与在线审计](phase-07-c-source-compatibility.md)

实施前的总路线与未实施的阶段 E 文档已移入 [归档](../archive/README.md)。阶段完成状态以 [质量与验证](../quality/README.md) 的矩阵和测试证据为准；能力取舍仍需用户单独审核。
