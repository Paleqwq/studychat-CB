# StudyChat-CB

StudyChat 的独立 CloudBase 版本，支持腾讯云中国站 **PostgreSQL 环境、Auth v2 身份认证和云托管容器**。原项目的源代码、远端仓库和部署保持独立；本仓库不包含实际账号、API 密钥或研究数据。

## 部署入口

完整操作步骤见 [CloudBase 部署指南](docs/cloudbase-deploy.md)。首次部署需要创建支持 PostgreSQL 的 CloudBase 环境，初始化业务数据库、开启匿名和账号密码登录、设置管理员，再部署 Docker 服务。仅开通传统文档型数据库环境不足以运行此版本。

| 项目 | 文件 / 设置 |
| --- | --- |
| 新数据库初始化 | `cloudbase/new_project_init.sql`，仅用于空业务库 |
| 环境变量示例 | `.env.example` |
| Docker 构建 | `Dockerfile`，Node.js 22，端口 3000 |
| 存活检查 | `GET /api/health`，只检查服务进程 |
| 公网同源校验 | 运行变量 `APP_ORIGIN`，填写完整 HTTPS origin，不带末尾斜杠 |
| 旧数据保留与身份迁移 | 部署指南中的迁移章节 |
| SQL 生成校验 | `node cloudbase/scripts/build-schema.mjs --check` |

所有 `NEXT_PUBLIC_*` 值在构建时固定，仅允许公开配置。`CLOUDBASE_API_KEY`、`CONFIG_ENCRYPTION_KEY` 和访问码只通过运行时注入。已保存的模型密钥需要原来的 `CONFIG_ENCRYPTION_KEY` 解密。不要把私钥写进 Docker 构建参数或 Git。

## 保留的教学与研究功能

- `/`：Bloom 学生入口，四组实验、三题两轮问答、学号登记、流式回复和历史恢复。
- `/english-assistant`：PEEC / BOPPPS 英语助教，独立两组、独立会话与分组记录，沿用已发布的 DeepSeek 模型连接。
- `/admin`：管理员控制台；模型设置共享，研究设置集中在侧栏折叠卡片。
- `/admin/english-assistant`：BOPPPS 流程内容和提示词配置、记录查询、暂停及会话删除。
- 配置快照、事务分组、幂等重试、权限白名单、会话删除审计和模型密钥加密沿用原业务规则。

浏览器端通过 CloudBase 官方 HTTP Auth 登录，Bloom、英语助教和管理员各自保存独立的设备 ID 与会话。服务端先远程验证令牌，再将 CloudBase 的文本身份映射到业务 UUID。业务表通过服务端访问；公开密钥和匿名令牌没有直接访问业务表的权限。

聊天 SSE 每 10 秒空闲发送心跳。云托管实际连接上限、模型出口连通性和 70 人同时使用的容量仍需在目标环境验证。

## 本地运行与检查

需要 Node.js 22 或更高版本。Windows PowerShell 使用 `npm.cmd`。

```sh
npm ci
# 按 .env.example 创建 .env.local；实际密钥不会被 Git 跟踪。
npm run dev
```

本地演示可将 `DEMO_MODE=true`，仅在开发模式生效，使用固定模拟回复并将演示记录保存在当前浏览器。生产环境缺少配置时显示配置页，不绕过管理员认证。

```sh
npm test
npm run typecheck
node cloudbase/scripts/build-schema.mjs --check
npm run build
```

`next.config.ts` 生成 standalone 产物，Docker 镜像以非 root 用户运行。仓库提供自动化数据库和认证测试；PGlite 测试不等于已在腾讯云原生 PG 执行 SQL。当前交付未包含真实 CloudBase 环境部署或 Docker 引擎实测。

## 可选旧后端

显式设置 `NEXT_PUBLIC_DATA_BACKEND=supabase` 并提供对应变量，可以继续使用旧 Supabase 后端；必须重新构建并连接已安装原迁移的数据库。旧业务操作和迁移说明存档于 [Supabase 原版说明](docs/legacy-supabase.md)，其中部署平台及旧后端指令不适用于 CloudBase 初始化。

界面与组件的参考范围和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
