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
- 云托管修复版本 `studychat-cb-002`，构建 `2608124668`、代码提交 `a0941a6` 已发布，管理任务 `2289954` 为 `finished`，服务 `normal`、流量 100%。[测试入口](https://studychat-cb-323544-9-1253606895.sh.run.tcloudbase.com) 的四个页面及 `/api/health` 均返回 200。
- 网站管理员 `studychat_admin` 已通过真实密码登录、两次远端身份验证并映射业务 UUID；白名单写入成功。共享设置、英语设置和英语会话记录三个后台接口均返回 200，响应未包含密钥或密文。
- 两个独立学生匿名身份均可读取对应应用会话入口，返回 200 和 `registration_required:true`；两个身份访问管理员设置均返回 403。三项未认证业务接口返回 401；公开 Key 和服务端 Key 均不能冒充网站用户（401）。
- 浏览器 Auth CORS 预检返回 204，来源准确匹配站点并允许 `X-Device-Id` 等必要请求头；不可信来源的登记 POST 返回 403。运行 `APP_ORIGIN` 已匹配当前入口，安全域名为 `ENABLE`。
- 当前共享模型配置未发布，英语课程未启用：同源登记 POST 按 `NOT_CONFIGURED` 返回预期 503「对话尚未开放，请联系管理员。」；没有创建学习会话或调用 LLM。测试最初误期望课程暂停的 403；按源码确认配置检查更早执行后，单独复核未发布状态的预期 503 通过。
- 四个页面、健康接口及 16 个线上静态资源均未包含本次实际服务端 API Key 或运行加密密钥；这是一项公开输出抽样检查，不代表所有潜在路径都已审计。Git 与两次干净源码包都未包含运行密钥、实际环境文件、依赖或本地构建目录；MCP 自动生成的 `cloudbaserc.json` 仅含环境及服务名称。
- Chrome 中管理员登录页面和修复版英语助教学号入口正常可见，没有登录过期或连接失败提示；没有通过浏览器填写或提交凭据。公开截图保存在忽略的本地 `artifacts` 目录。

本地未安装 Docker 引擎，未执行本机 Docker 构建；已完成 CloudBase 云端源码镜像构建和修复版发布。当前为新空业务环境，没有导入原站历史记录或模型密钥。学习会话登记与恢复、暂停与删除的线上完整流程、模型回复、长 SSE 及 70 人并发尚未完成验收，不将这些环节标记为已通过。按 [部署指南](cloudbase-deploy.md) 在后台发布共享模型及课程后继续验证。当前资源为 0.5 CPU、1 GiB、最少 0／最多 2 个实例，属于本次测试部署设置，不是已验证的 70 人容量结论。
