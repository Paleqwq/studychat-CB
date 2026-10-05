# 本次交付验证

核对日期：2026-10-05。项目：独立的 `studychat-CB`。

- issuer 兼容修复前的完整 `npm test`：51 个文件、755 项测试全部通过，含 CloudBase 身份隔离、服务端认证、数据库事务、权限、BOPPPS、暂停、删除及源码部署公开构建配置。
- 最新认证兼容修复后仅运行 `npm test -- tests/cloudbase-server-auth.test.ts`：56 项认证测试全部通过，覆盖实测匿名网关根 issuer、官方认证 issuer 后缀、两个远端验证接口、第三方／非精确 issuer 拒绝，以及普通密码 Token 缺省匿名标记和错误标记拒绝。认证修复后尚未重新运行全套，不将推算出的总数写为全套实测结果。
- `npm run typecheck`：通过；生产构建中的 TypeScript 检查也通过。
- `node cloudbase/scripts/build-schema.mjs --check`：生成结果与已审阅源一致；单条原子 SQL 的 19 项数据库测试通过。
- `npm run build`：使用 CloudBase 模式的虚拟公开配置成功生成 standalone 产物。
- 本地直接运行 standalone：四个业务页面与健康检查返回 200；未认证业务 API 返回 401；不匹配的公开 origin 返回 403；缺少运行私钥时四个页面正确显示配置提示。
- 检查 20 个静态文件及上述 HTTP 响应，运行时模拟私钥未出现在公开输出中。
- 上传文件检查：实际 `.env`、私钥文件、本地 provider 配置、依赖与构建产物均未纳入 Git；常见实际凭据格式扫描未发现候选。
- 原 `studychat` 工作区未修改。

真实环境 `studychat-d2g0qgliy0655a4ca`（`ap-shanghai`）的核验结果：

- 数据库初始化任务 `task-c9c18fd1` 返回 `Succeed`；迁移历史包含 `20261005183000`，22 个业务表／视图已核实。已应用迁移快照保持不变。
- 身份认证 v2 配置中 `anonymous`、`usernamePassword` 均为 `true`。
- 真实网关匿名登录、`/auth/v1/token/introspect`、`/auth/v1/user/me` 均返回 200；`service_role` PG 读取返回 200。测试不输出 Token 或 API Key。
- 真实匿名 JWT 的 issuer 为 `https://studychat-d2g0qgliy0655a4ca.api.tcloudbasegateway.com`；官方 PG 文档示例使用该地址加 `/auth/v1`。真实普通密码账号 Token 的角色是 `authenticated`，但缺省 `is_anonymous`。代码仅在远端验证成功后接受这两种精确可信 issuer，允许该角色缺省匿名标记为 false；`anon` 必须显式 true，错误类型和非匹配布尔值仍拒绝。最新 56 项认证测试及 `npm run typecheck` 通过。
- 云托管构建任务 `build2608129382` 完成；[测试入口](https://studychat-cb-323544-9-1253606895.sh.run.tcloudbase.com) 的 `/api/health` 已返回 200。该响应仅证明容器存活。

本地未安装 Docker 引擎，未执行本机 Docker 构建；已完成的是 CloudBase 云端源码镜像构建。当前云端镜像尚需重新构建以纳入最新认证修复。网站管理员授权和后台登录、学生登记与恢复、模型回复、长 SSE 及 70 人并发尚未完成验收，不将这些环节标记为已通过。按 [部署指南](cloudbase-deploy.md) 继续验证。
