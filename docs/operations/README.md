# 运维与维护

本目录记录 package 在真实运行环境中的安全、部署、发布、版本、上游证据和回退约定。平台事实集中在运行边界文档，版本与来源集中在维护文档，其他主题不重复维护这些事实。

- [运行边界与部署验收](runtime-security-and-deployment.md)：Node、Edge、脚本沙箱、网络策略、状态和部署检查。
- [存储与 Supabase](../archive/storage-and-supabase.md)：用户书源、运行状态、秘密和数据库适配边界。
- [任务执行与 Serverless 边界](../archive/job-and-execution.md)：JobStore、Node Worker、租约、幂等和长任务恢复。
- [package 维护与迁移证据](package-maintenance.md)：源码基线、版本、发布、上游变更、许可记录和回退。

应用调用方式见 [package 使用指南](../implementation/package-usage.md)；未实施的存储与任务设计见 [归档](../archive/README.md)。
