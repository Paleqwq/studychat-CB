# studychat-CB：CloudBase PostgreSQL 与云托管部署

本指南适用于独立的 `studychat-CB` 项目，目标为中国站 CloudBase PG 环境和容器型云托管。原项目仍可继续运行。本项目保留 Bloom、英语助教、两套独立学生身份和记录；英语助教继续使用共享 DeepSeek 模型配置与两组独立分配。

截至 2026-10-05，已连接你的上海 PG 环境 `studychat-d2g0qgliy0655a4ca`（`ap-shanghai`）并完成新库初始化：迁移任务 `task-c9c18fd1` 返回 `Succeed`，迁移历史包含 `20261005183000`，已核实 22 个业务表／视图。身份认证 v2 的 `anonymous` 和 `usernamePassword` 已开启，真实匿名登录、Token 验证、当前用户查询和服务端 PG 读取均返回 200。

云托管镜像构建任务 `build2608129382` 已完成，已分配入口 [studychat-CB 测试站](https://studychat-cb-323544-9-1253606895.sh.run.tcloudbase.com)，容器健康检查已返回 200。当前镜像仍需包含最新认证兼容修复后重新构建；管理员授权与网站后台登录、业务登记、模型和长 SSE 尚待验收，**目前不能据此认定整个网站已经完成上线**。以下控制台名称以腾讯云实际页面为准；官方资料核对日期：2026-10-05。

## 1. 确认环境是 PostgreSQL 模式

进入 CloudBase 控制台，查看已开通环境的数据库类型。该项目需要 **创建环境时选择 PostgreSQL** 的 PG 模式；传统文档数据库环境不能直接升级成 PG 模式。如果已开通的是传统模式，请新建 PG 环境作为测试环境。[官方 PG 概述](https://docs.cloudbase.net/quick-start/pg-overview)

记录以下三项，并分别保管：

| 配置 | 用途 |
|---|---|
| 环境 ID | 中国站网关 `https://环境ID.api.tcloudbasegateway.com` |
| Publishable Key | 公开配置，可以进入浏览器构建 |
| API Key，角色为 `service_role` | 服务端数据库访问，绕过 RLS，必须保密 |

`CLOUDBASE_API_KEY` 填的是上述 CloudBase PG API Key，不能替换成腾讯云 CAM 的 SecretId 或 SecretKey。原生 `auth.uid()` 返回字符串，本项目通过 `public.app_users` 映射成原有业务 UUID；无需修改 CloudBase 内置 Auth 函数。[官方身份与权限说明](https://docs.cloudbase.net/authentication-v2/auth/auth-pg)

云托管当前文档标注支持上海地域。建议测试数据库和云托管均选上海，配置 `NEXT_PUBLIC_CLOUDBASE_REGION=ap-shanghai`；其他地域是否可用，以控制台当前列表为准。[云托管概述](https://docs.cloudbase.net/run/quick-start/introduce)

## 2. 开启登录，登记网站域名

在环境的 **身份认证 → 登录方式** 中开启：

- 匿名登录：学生使用。
- 用户名密码登录：管理员使用。在身份认证用户管理中创建非匿名、状态正常的管理员账号，记下它的真实用户 ID（`sub`）。管理员登录框支持用户名或按平台配置使用的邮箱账号。

确认操作的是身份认证 v2 的配置。不要将 v1 控制台开关当成 v2 已启用。[官方登录方式管理](https://docs.cloudbase.net/authentication-v2/auth/manage-login)

在环境的安全域名／Web 访问配置中加入测试站域名；后续使用正式域名时再加入正式域名。若本地调试需要 `localhost:3000`，按控制台要求增加本地地址。浏览器原生 HTTP Auth 请求涉及 `Authorization`、`Content-Type`、`X-Device-Id`，需确认网关允许网站来源及这些请求头。不要为解决跨域问题公开业务表或给 `anon` 增加管理员权限。

当前代码直接使用 CloudBase 官方 HTTP Auth 接口，分别保存 Bloom、英语助教、管理员的设备 ID 和登录态；服务端通过 `/auth/v1/token/introspect` 和 `/auth/v1/user/me` 验证实际登录身份，然后映射 UUID。Publishable Key 不能当成学生身份。[验证 Token](https://docs.cloudbase.net/http-api/auth/auth-token-introspect)、[获取当前用户](https://docs.cloudbase.net/http-api/auth/user-me)

本环境实测匿名 JWT 的 issuer 是网关根地址，官方 PG 文档示例则包含 `/auth/v1` 后缀。服务端在两次远端验证成功后，仅接受当前环境这两个精确 issuer，同时验证 subject、环境、有效期和用户类型；不允许第三方 issuer、相似域名或其他路径。

真实普通密码账号 JWT 使用 `authenticated` 角色，但可能缺省 `is_anonymous`。仅在两次远端验证通过后，该角色缺省此字段按非匿名处理；`anon` 角色仍必须显式携带 `is_anonymous:true`，`null`、字符串或角色与布尔值不匹配的 Token 均拒绝。系统管理和 API Key 凭据仍不能作为网站用户登录。

CloudBase 模式不要填写旧 Supabase 的 Turnstile site key；当前接入未实现 CloudBase 验证码流程。

## 3. 新空数据库初始化

**这一节只适用于全新空库。保留旧学生和会话时先阅读第 7 节。**

**本次环境已成功执行 `20261005183000_studychat_initial`，不要再次初始化。** `cloudbase/migrations/20261005183000_studychat_initial.sql` 是已应用迁移的不可变快照；后续修改必须新增迁移，而不是改写该文件或重跑初始化。下述步骤用于其他新空 PG 环境。

进入 PostgreSQL 的 SQL 编辑器，完整执行 [cloudbase/new_project_init.sql](../cloudbase/new_project_init.sql) 一次。该文件是一个原子 `DO` 语句：包含身份映射和现有 001–008 业务能力，不需再执行 `supabase/migrations`。文件没有创建、替换或删除 CloudBase 的 `auth.*` 对象。

初始化使用控制台 SQL 编辑器，或通过具有相应腾讯云权限的 CloudBase MCP `managePgDatabase` 迁移操作执行。**MCP 请求省略 `role`；`cloudbase_admin` 是平台保留角色，不能显式传入。** 平台管理原生 SQL 通道的 DDL 权限，不应把网站的 `service_role` API Key 当作建表管理通道。[官方 Auth 角色说明](https://docs.cloudbase.net/authentication-v2/auth/auth-pg)

官方迁移指南说明 `ExecutePGSql` 每次接受一个 SQL 语句，因此本项目已经把完整初始化包装成单条 `DO`。不能按照分号或换行拆开其中的存储函数。如果控制台报告 SQL 长度或执行时限超标，应按完整 SQL 对象和依赖关系调整；目前未确认你的控制台有这些限制。[官方迁移指南](https://docs.cloudbase.net/quick-start/migration/supabase)

初始化整体失败时，`DO` 中的数据定义会回滚；先修复具体报错再执行。成功后不要重复运行初始化，也不要在已有业务库运行它。

使用 MCP 时先读取完整 SQL 文件，调用 `managePgDatabase` 的 `planMigration`，审核计划后再调用 `applyMigration`。以下 `sql` 表示文件的完整内容，不能把文件路径字符串直接传作 SQL，也不能拆分其中的存储函数：

```text
planMigration:
  action: "planMigration"
  migrationName: "studychat_initial"
  migrationVersion: "20261005183000"
  sql: <完整的 cloudbase/new_project_init.sql 内容>

applyMigration:
  action: "applyMigration"
  migrationName: "studychat_initial"
  migrationVersion: "20261005183000"
  sql: <与计划相同的完整 SQL 内容>
  confirm: true
  waitForTask: false
```

上述版本号是本次已应用记录；其他环境自行使用唯一的新版本号，后续升级也必须使用新版本。`applyMigration` **需要 `confirm:true`**，两次调用均省略 `role`。MCP 会写入 `cloudbase/migrations/<版本号>_<名称>.sql` 本地快照；收到异步任务 ID 只表示已提交，不代表成功。[官方 MCP 数据库工具](https://docs.cloudbase.net/ai/mcp/tool-description)

随后调用 `describeMigrationTask`，传入 `action:"describeMigrationTask"` 与返回的 `taskId`，确认任务 `Status:"Succeed"`；再调用 `listMigrations`，传入 `action:"listMigrations",limit:20`，确认目标版本在迁移历史中。本次已用这两个查询核实 `task-c9c18fd1` 与 `20261005183000`，并另外检查业务表／视图及 PG 服务端读取。

然后在 SQL 编辑器执行以下**一条**管理员授权语句，将占位符替换为身份认证控制台显示的真实管理员用户 ID；不是学号、用户名或邮箱：

```sql
insert into public.admin_users(user_id)
select (public.get_or_create_app_user('真实的CloudBase管理员用户ID')->>'id')::uuid
on conflict(user_id) do nothing;
```

网站实际权限由这个 UUID 白名单控制，匿名学生即使存在映射也不能进入后台。

可以分别执行这些检查：

```sql
select count(*) from public.admin_users;
```

```sql
select to_regprocedure('public.register_english_session(uuid,text,text,bigint)');
```

```sql
select to_regprocedure('public.set_english_learning_pause(uuid,uuid,uuid,text,integer,boolean)');
```

后两项应返回函数名而不是 `NULL`。业务表不需要对学生开放写权限，学生操作由网站 API 验证身份后执行。

## 4. 配置构建变量和运行变量

Next.js 的 `NEXT_PUBLIC_*` 变量在构建时写入浏览器代码，因此 **必须作为 Docker 构建参数传入**。仅在容器运行时设置，无法更新已经构建的浏览器代码；修改环境 ID、公开 Key 或后端类型后需重新构建镜像。[Next.js 环境变量规则](https://nextjs.org/docs/app/guides/environment-variables)

| Docker 构建参数 | 示例 |
|---|---|
| `NEXT_PUBLIC_DATA_BACKEND` | `cloudbase` |
| `NEXT_PUBLIC_CLOUDBASE_ENV_ID` | `你的PG环境ID` |
| `NEXT_PUBLIC_CLOUDBASE_REGION` | `ap-shanghai` |
| `NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY` | `你的Publishable_Key` |

在云托管的**运行时环境变量**配置下面的值；公开配置也应与构建时保持一致：

```dotenv
NEXT_PUBLIC_DATA_BACKEND=cloudbase
NEXT_PUBLIC_CLOUDBASE_ENV_ID=你的PG环境ID
NEXT_PUBLIC_CLOUDBASE_REGION=ap-shanghai
NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY=你的Publishable_Key
CLOUDBASE_API_KEY=你的服务端API_Key
CONFIG_ENCRYPTION_KEY=你的32字节Base64加密密钥
APP_ORIGIN=https://测试站实际域名
AI_ALLOWED_HOSTS=api.openai.com,api.anthropic.com,api.deepseek.com,openrouter.ai,api.siliconflow.cn
DEMO_MODE=false
PORT=3000
HOSTNAME=0.0.0.0
```

按需要配置独立访问码 `STUDY_ACCESS_CODE`、`ENGLISH_ASSISTANT_ACCESS_CODE`。使用自建模型网关时，把其**准确主机名**加入 `AI_ALLOWED_HOSTS`，然后在后台配置模型 URL。

`APP_ORIGIN` 必须是网站实际的完整 HTTPS 来源，不能有路径、尾部 `/`、通配符或多个地址。它用于云托管反向代理后的同源校验；测试用默认域名，正式发布后更新为正式域名，并让用户统一通过该域名访问。

新项目可以在可信本地终端生成加密密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

妥善备份，避免出现在 Git、截图或日志中。**导入原模型配置必须使用原来的 `CONFIG_ENCRYPTION_KEY`**，否则旧 API Key 密文无法解密。模型厂商的 DeepSeek API Key 继续在网站后台输入，不能放进 `NEXT_PUBLIC_*`。

`CLOUDBASE_API_KEY`、`CONFIG_ENCRYPTION_KEY` 只注入运行中的容器，不能作为 Docker build args、Dockerfile 固定值或仓库文件。`.dockerignore` 已排除 `.env*`、凭据及本地构建产物。

## 5. 创建容器型云托管服务

在 CloudBase 云托管创建 `studychat-cb-test` 测试服务。选择 **容器型／Dockerfile 部署**，绑定 GitHub 仓库 `studychat-CB`；本仓库现已公开，私有仓库则按控制台引导授权读取。仓库根目录包含 Dockerfile，构建上下文使用根目录。[官方 Git 部署](https://docs.cloudbase.net/run/deploy/deploy/deploying-git)

| 服务设置 | 值 |
|---|---|
| Dockerfile | 仓库根目录的 `Dockerfile` |
| 服务端口 | `3000` |
| 启动命令 | 使用镜像自带 `node server.js`，无需覆盖 |
| 运行环境 | 镜像已使用 Node.js 22 |
| 健康检查 | HTTP `GET /api/health`，端口 `3000` |
| 首次测试资源 | 建议先用 1 核、2GB，实际可选规格以控制台为准 |
| 教学期间实例 | 建议最小 1，避免课前冷启动；最大值按压测和费用限制设置 |

上述资源是测试起点，并不保证 70 人同时作答。Dockerfile 已构建 Next.js standalone 并设置非 root 运行用户、静态资源、端口和健康检查。[官方 Node.js 容器部署](https://docs.cloudbase.net/run/quick-start/dockerize-node)

把第 4 节公开值配置成控制台的 **Docker 构建参数**，把私钥配置为**运行环境变量**。如果控制台只提供运行环境变量，没有构建参数入口，采用下述镜像部署方式，不能假定运行变量会自动传给 Docker build。

### 使用本机 CloudBase MCP 上传源码

`manageCloudRun` 的源码部署接口没有 Docker build args 字段。此时在干净部署目录中生成 `cloudbase/public-build.json`，仅允许以下四项公开配置：

```json
{
  "NEXT_PUBLIC_DATA_BACKEND": "cloudbase",
  "NEXT_PUBLIC_CLOUDBASE_ENV_ID": "你的PG环境ID",
  "NEXT_PUBLIC_CLOUDBASE_REGION": "ap-shanghai",
  "NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY": "你的Publishable_Key"
}
```

Docker 构建脚本会校验并加载这个文件，再启动 Next.js 构建。文件未提供时继续使用第 4 节的 Docker build args。脚本拒绝未知字段、服务端密钥字段及不完整配置；实际文件已被 Git 忽略。它只应包含公开信息。

**MCP 源码上传自身不会读取 `.gitignore` 或 `.dockerignore`。** 不要把当前开发目录直接设为 `targetPath`。先用 `git archive` 从已审核提交建立独立、干净的目录，再加入上述公开文件；核对目录没有 `.env*`、私钥、`node_modules`、`.next` 或 `artifacts` 后才能上传。所有私钥通过 `serverConfig.EnvParams` 注入运行环境。

本机 stdio MCP 可以读取干净目录；远程 HTTP MCP 无法读取本地文件时，使用控制台 Git 部署或镜像部署。

### 可选：自行构建镜像，再部署私有镜像

在装有 Docker 的电脑／Ubuntu 服务器中进入 `studychat-CB`，替换四个公开占位值：

```bash
docker build --platform linux/amd64 -t studychat-cb:test \
  --build-arg NEXT_PUBLIC_DATA_BACKEND=cloudbase \
  --build-arg NEXT_PUBLIC_CLOUDBASE_ENV_ID=你的PG环境ID \
  --build-arg NEXT_PUBLIC_CLOUDBASE_REGION=ap-shanghai \
  --build-arg NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY=你的Publishable_Key \
  .
```

在腾讯云容器镜像服务创建私有仓库，按它显示的命令登录、标记和推送这个镜像，然后在云托管选择镜像部署，并配置运行变量。不要把私钥写入镜像层或构建日志。

可先把运行变量保存到本地已忽略的 `.env.cloudbase`，本地容器测试时临时移除 HTTPS 的 `APP_ORIGIN`，使用默认 loopback 校验：

```bash
docker run --rm --name studychat-cb-test --env-file .env.cloudbase -p 127.0.0.1:3000:3000 studychat-cb:test
```

```bash
curl -i http://127.0.0.1:3000/api/health
```

返回 `200` 和 `{"status":"ok"}` 只说明进程存活，不能证明 Auth、数据库或模型配置成功。健康接口不会输出秘密或连接信息。**这份指南中的本机 Docker 命令尚未执行；本次实际使用 CloudBase 云端源码构建完成镜像构建。**

云托管启用 HTTP/HTTPS 访问后取得测试域名，把它加入安全域名并更新 `APP_ORIGIN`，发布新的运行配置。先手动发布测试版本，完成验收后再决定是否启用自动部署。

## 6. 配置网站后台和真实环境验收

打开 `https://测试站域名/admin`，使用第 2 节创建的账号登录：

1. 配置并发布原模型设置。当前首次发布须填写 DeepSeek 和 ChatGPT 两套连接与 API Key；英语助教只使用共享 DeepSeek 连接，Bloom 的研究配置保持原有结构。保存配置不调用模型，但后续普通作答会消耗模型额度。
2. 打开 `/admin/english-assistant`，设置两组、基础提示词、人格提示词和六阶段 BOPPPS 内容，发布英语课程。
3. 从学生页面登记不同测试学号：Bloom 与英语助教应分别保存身份、分组、会话和消息。
4. 验证作答、刷新恢复、长历史、重复提交、暂停、继续、同一活动恢复、管理员删除及导出。退出管理员身份不应改变学生会话。
5. 无登录访问管理 API 应失败；学生不能读取模型密钥、公开配置之外的数据或其他学生记录。不能把 API Key 当作浏览器 Authorization。

**流式回复必须线上实测。** 当前代码在 Bloom 和英语助教等待模型／保存期间，每约 10 秒发送 SSE 注释心跳；应用模型等待上限约 120 秒。网关支持 SSE，但心跳不能解除平台的总请求时限、扩容中断或客户端网络限制。[云托管 HTTP 与 SSE](https://docs.cloudbase.net/run/faq/gw)

在浏览器开发者工具检查聊天 POST：确认 `Content-Type: text/event-stream`、数据持续到达、空闲时能看到 `: heartbeat`，最终事件完整保存。测试接近 120 秒的慢回复、首个模型 token 延迟、断线重连、刷新恢复及请求失败重试。如前面还有 CDN／代理，检查它不会缓存或缓冲聊天 API。

## 7. 保留原 Supabase 数据时单独迁移

初始化建立的是空结构，**不会迁移旧学生、Auth 账号或会话，也不会按学号自动认领历史。** 当前 CloudBase 浏览器身份与原 Supabase 身份分别保存，旧登录态不能冒充新 CloudBase 用户。

需要保留记录时，在切换正式域名前安排独立迁移：

1. 备份原 `public` 业务数据、用户业务 UUID、身份关联及原 `CONFIG_ENCRYPTION_KEY`。先验证备份可以恢复。不要导入旧 `auth` schema 到 CloudBase。
2. 按原 UUID 预建 `app_users` 占位身份，再按外键依赖导入原业务数据。每批可通过受控 SQL 执行 `seed_legacy_app_users(uuid[])`，每批最多 10,000 个 ID；该函数只允许服务端角色调用。
3. 导入范围包括共享模型与实验配置、分组、学生登记、Bloom 会话和题目评估，以及独立的英语课程快照、会话、评估、暂停控制和删除审计。保留所有原主键及身份 UUID；重置生成序列，避免后续消息序号冲突。
4. 通过身份认证控制台／官方流程建立新账号。只有独立核验了旧身份与新 CloudBase 用户之后，管理员才能调用 `link_legacy_app_user(原业务UUID,新CloudBase用户ID)`。绑定一次后不能更换，不提供学号认领接口。
5. 完成身份绑定后再允许相关用户首次登录新站。如果新 subject 已创建了另一 UUID，绑定函数会拒绝，需人工核验和规划合并；不能覆盖身份映射绕过保护。
6. 测试历史归属、完整导出、旧密文解密和新记录。正式切换时暂停旧站写入，做增量同步，再切域名。保留旧部署便于回滚；回滚前同步新站产生的数据，避免分叉。

旧匿名用户没有密码，必须在原身份还可验证时设计账号绑定／迁移，或经可靠身份核验后由管理员处理。仅提供学号不构成历史会话所有权。官方也说明不能直接 dump/restore Auth 账号，应重新激活账号或联系平台确认批量导入方案。[官方迁移指南](https://docs.cloudbase.net/quick-start/migration/supabase)

保留 Supabase 模式时，设置 `NEXT_PUBLIC_DATA_BACKEND=supabase`，使用原 Supabase 的公开构建参数和服务端运行变量，并重新构建浏览器。这只是兼容旧后端的开关，不会在两个数据库之间自动同步数据。

## 8. 70 人课堂压测与费用

先测试 70 人同时登录、登记、提交、集中刷新及长会话；持续观察 CPU、内存、数据库连接／慢查询、HTTP QPS、429、5xx、首 token 延迟、保存成功率和费用。每次学生请求还包含远端身份验证、数据库读取与模型调用，70 人在线不等于只有 70 个数据库请求。

共享 PG 实例适合测试和低频业务；需要稳定教学资源时可从独享 2 核 4GiB 作为压测起点。实际容量由压测决定，独享数据库持续运行会计量费用。[官方数据库规格与计量](https://docs.cloudbase.net/database/postgresql/database-management)

云托管支持弹性扩缩容。教学时保留运行实例，按并发连接和资源指标设置扩容阈值、最大实例数及费用告警；不要仅根据 CPU 低就认为长连接容量充足。查询控制台的环境 QPS、身份认证限流、数据库配额和模型厂商限流，必要时申请调整。[官方云托管概述](https://docs.cloudbase.net/run/introduction)

当前官方计费说明称 CloudBase 云托管 CPU／内存换算为统一计算资源，按环境套餐、资源包、按量顺序扣量；数据库也有独立的计算／存储计量。按你的环境控制台核对可用额度、超限策略和费用，不承诺套餐一定覆盖课堂负载。[官方云托管计费说明](https://docs.cloudbase.net/run/faq/fee)

## 9. 常见问题

| 表现 | 检查 |
|---|---|
| 页面显示服务尚未配置 | 公开构建参数、运行变量、环境 ID、API Key 和加密密钥是否完整且一致 |
| 修改运行变量后浏览器仍连旧环境 | 重新带正确公开参数构建镜像 |
| 管理员能登录但后台 403 | 非匿名账号、真实 subject、`app_users` UUID、`admin_users` 白名单 |
| 学生登录方式未开启 | 身份认证 v2 的匿名登录开关；不要修改数据表权限 |
| 跨站请求被拒绝 | `APP_ORIGIN` 是否恰好等于正在访问的 HTTPS 来源，是否存在尾部斜线 |
| 浏览器 Auth 被拒绝或预检失败 | 安全域名、网关 CORS、请求头和登录方式配置 |
| 数据库函数不存在 | 初始化是否成功、是否为正确 PG 环境、PostgREST 是否已刷新 schema |
| 能登录但模型无法回复 | 发布共享模型配置，核对厂商 Key、URL、`AI_ALLOWED_HOSTS` 和课程启用状态 |
| 旧模型 Key 解密失败 | 是否保留原 `CONFIG_ENCRYPTION_KEY` |
| SSE 一段时间后断开 | 10 秒心跳、网关总时限、前置代理缓冲、模型超时和容器重启记录 |
| 旧学号不能在新浏览器登记 | 不自动认领历史；按第 7 节核验身份和迁移记录 |

本次已核实原生匿名 Auth 和普通密码账号 Token 差异、PG 服务端读取、数据库初始化、云端镜像构建和容器健康检查。仍需部署最新认证修复，并完成网站管理员权限、实际业务记录、模型流式回复及 70 人负载验收；不能仅依据本地测试或 `/api/health` 成功判断整站可用。
