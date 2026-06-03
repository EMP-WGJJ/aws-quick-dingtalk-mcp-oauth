# DingTalk MCP OAuth Gateway

为 MCP Client（如 Amazon Quick）提供标准 **OAuth 2.1（Authorization Code + PKCE）** 接入，底层将请求代理转发到钉钉企业版 MCP 统一网关（`mcp-gw.dingtalk.com`），实现**多用户身份隔离**。

> 网关只做两件事：对外当 OAuth Authorization Server，对内当钉钉 OAuth Client + MCP 协议代理。MCP Client 永远不接触钉钉凭据。

## 架构

```
┌────────────────┐   OAuth 2.1 (PKCE)   ┌──────────────────────────┐   x-user-access-token   ┌──────────────────────┐
│  Amazon Quick  │ ───────────────────► │  MCP OAuth Gateway（本项目）│ ──────────────────────► │  钉钉 MCP 统一网关     │
│  (MCP Client)  │ ◄─────────────────── │  Auth Server + MCP 代理    │ ◄────────────────────── │  mcp-gw.dingtalk.com │
└────────────────┘    MCP over HTTP     └──────────────────────────┘     MCP 执行并返回         └──────────────────────┘
```

核心原则：

- MCP Client 永远不接触钉钉凭据（AppSecret、钉钉 access_token 仅存在于网关内部）
- 每个用户独立授权，网关维护 `mcp_token → 钉钉 user_token` 的映射，按用户隔离
- 完全遵循 MCP OAuth 2.1 规范，强制 PKCE（S256）

> 设计与代码结构的完整说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少填入钉钉应用的 DINGTALK_APP_KEY 和 DINGTALK_APP_SECRET
```

> `.env` 含敏感凭据，已被 `.gitignore` 忽略，请勿提交。

### 3. 开发模式运行

```bash
npm run dev
```

### 4. 构建 & 生产运行

```bash
npm run build
npm start
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/.well-known/oauth-authorization-server` | GET | OAuth 元数据发现 |
| `/register` | POST | 动态客户端注册（DCR） |
| `/authorize` | GET | 授权端点（校验 client_id / redirect_uri / PKCE，302 跳钉钉） |
| `/token` | POST | Token 端点（授权码换 token、refresh_token 刷新） |
| `/dingtalk/callback` | GET | 钉钉 OAuth 回调（换钉钉 token + 取用户信息） |
| `/mcp/:group` | POST | MCP 分组调用（JSON-RPC，代理转发到钉钉 MCP 网关） |
| `/mcp/groups` | GET | 列出全部分组及说明（无需鉴权） |
| `/health` | GET | 健康检查 |

## MCP 分组聚合

钉钉上游 15 个 server 共 316 个工具，超过 Amazon Quick 单连接器 100 工具上限。网关按「业务域 + 危险隔离」拆成 5 个分组，每个分组是一个独立的 MCP endpoint：

| 分组 | Endpoint | 工具数 | 内容 |
|------|----------|--------|------|
| 办公协作 | `/mcp/office` | ~58 | 通讯录、日历、待办、日志 |
| 文档知识 | `/mcp/docs` | ~45 | 文档、知识库、钉盘 |
| 表格数据 | `/mcp/tables` | ~92 | AI 表格、在线表格 |
| 沟通审批 | `/mcp/comm` | ~89 | OA 审批、邮箱、机器人、群聊、直播、项目管理 |
| ⚠️ 危险操作 | `/mcp/danger` | ~32 | 上述服务的 delete/remove/revoke/reject |

前 4 个分组只含非危险工具，所有破坏性操作统一隔离在「危险操作」分组。完整分类见 [infra/MCP-CLASSIFICATION.md](infra/MCP-CLASSIFICATION.md)。

## Amazon Quick 接入

完整接入参数见 [infra/QUICK-SETUP.md](infra/QUICK-SETUP.md)。要点：

| 字段 | 值 |
|------|-----|
| Authorization URL | `https://<你的网关域名>/authorize` |
| Token URL | `https://<你的网关域名>/token` |
| Client ID | `amazon_quick_001`（或通过 DCR 动态注册） |
| Client Secret | 任意非空（PKCE 鉴权，不校验 secret） |
| MCP Server Endpoint | 5 个分组各创建一个 connector：`/mcp/office` `/mcp/docs` `/mcp/tables` `/mcp/comm` `/mcp/danger` |
| Redirect URL | `https://<region>.quicksight.aws.amazon.com/sn/oauthcallback`（须在网关白名单） |
| Scope | `openid` |

## 钉钉开放平台配置

1. 在[钉钉开发者后台](https://open-dev.dingtalk.com)创建企业内部应用
2. 记录 AppKey（`DINGTALK_APP_KEY`）和 AppSecret（`DINGTALK_APP_SECRET`）
3. 安全设置中添加重定向 URL：`https://<你的网关域名>/dingtalk/callback`
4. 按需申请权限（通讯录、日历、待办、文档、审批、邮箱等）

## 存储驱动

通过 `STORAGE_DRIVER` 切换：

- `memory`：内存存储，仅供本地开发，进程重启丢失
- `dynamo`：DynamoDB 持久化（生产），TTL 自动清理过期记录，敏感字段经 KMS 加密

本地用 DynamoDB Local 跑集成测试：

```bash
docker run -p 8000:8000 amazon/dynamodb-local
npm run test:dynamo
```

## 部署

生产环境推荐 ECS Fargate + DynamoDB + KMS，钉钉 AppSecret 存入 Secrets Manager。

首次部署前，复制部署配置模板并填入你自己的账号/资源信息（也可由 `deploy.sh` 交互式生成）：

```bash
cp .deploy-config.example .deploy-config
# 编辑 .deploy-config，填入 VPC、子网、证书 ARN、网关域名等
```

一键部署：

```bash
./scripts/deploy.sh
```

完整说明见 [infra/DEPLOY.md](infra/DEPLOY.md) 与 [infra/QUICK-SETUP.md](infra/QUICK-SETUP.md)。

## 项目结构

```
src/
├── index.ts              # 入口，Express 应用，挂载所有路由
├── config.ts             # 环境变量 & 配置
├── oauth/                # OAuth Authorization Server
│   ├── metadata.ts       # 元数据发现
│   ├── register.ts       # 动态客户端注册（DCR）
│   ├── authorize.ts      # 授权端点
│   └── token.ts          # Token 端点（授权码 / 刷新）
├── dingtalk/             # 钉钉 OAuth Client
│   └── callback.ts       # 钉钉回调
├── mcp/                  # MCP 分组聚合代理
│   ├── aggregator.ts     # 5 分组路由 + 转发钉钉 MCP 网关
│   ├── middleware.ts     # Bearer token 验证
│   └── tools/            # 本地 MCP 工具（兼容保留）
├── storage/              # 数据存储
│   ├── interface.ts      # 存储接口
│   ├── factory.ts        # 按 STORAGE_DRIVER 选择实现
│   ├── memory.ts         # 内存实现（开发）
│   └── dynamo.ts         # DynamoDB 实现（生产）
└── utils/
    ├── crypto.ts         # Token 生成、PKCE
    ├── dingtalk-api.ts   # 钉钉 API 封装
    └── encryption.ts     # KMS 加解密

infra/                    # 部署相关
├── cloudformation.yaml   # ALB / Fargate / DynamoDB / KMS
├── DEPLOY.md             # 部署指南
├── QUICK-SETUP.md        # Amazon Quick 接入指南
└── MCP-CLASSIFICATION.md # 316 个工具完整分类
scripts/
├── deploy.sh             # 一键部署
└── redeploy.sh           # 复用配置重新部署
```

## 安全说明

- 所有端点必须走 HTTPS；强制 PKCE（S256）与 state 校验
- 钉钉 AppSecret 仅存在服务端（生产存 Secrets Manager），永不下发给 MCP Client
- DynamoDB 中钉钉 token 等敏感字段经 KMS 加密存储
- 切勿提交 `.env`、`.deploy-config` 等含真实凭据的文件（已在 `.gitignore` 中忽略）

## 开发计划

- [x] Phase 1: MVP（OAuth 流程跑通，拿到钉钉 user_access_token）
- [x] Phase 2: MCP 分组聚合代理、Token 刷新、DynamoDB 持久化、KMS 加密
- [ ] Phase 3: 监控告警、限流、多租户

## License

ISC
