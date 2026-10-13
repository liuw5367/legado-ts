# 运维与维护

本目录记录 package 在真实运行环境中的安全、部署、发布、版本、上游证据和回退约定。Node 平台事实集中在 source-node 文档，Web 平台事实集中在 reader-web 文档，版本与来源集中在维护文档，其他主题不重复维护这些事实。

- [source-node 安全与部署](../../packages/source-node/docs/security-and-deployment.md)：当前 Node 网络、脚本、资源限制，以及需要应用/平台单独验收的部署边界。
- [reader-web 开发与部署](../../apps/reader-web/docs/development-and-deployment.md)：当前 Web 环境变量、迁移、Vercel 构建和部署边界。
- [任务执行与 Serverless 边界](../archive/job-and-execution.md)：JobStore、Node Worker、租约、幂等和长任务恢复。
- [package 维护与迁移证据](package-maintenance.md)：源码基线、版本、发布、上游变更、许可记录和回退。

应用调用方式见 [source-core 文档](../../packages/source-core/README.md) 和 [source-node 文档](../../packages/source-node/README.md)；reader-cli 与 reader-web 的应用边界见各自 docs；未实施的存储与任务设计见 [归档](../archive/README.md)。
