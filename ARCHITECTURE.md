# 架构说明：DingTalk MCP OAuth Gateway

> 本文档描述网关的当前实现架构，供后续维护者理解设计与代码结构。
> 面向使用者的接入步骤见 [README.md](README.md) 与 [infra/QUICK-SETUP.md](infra/QUICK-SETUP.md)，
> 部署见 [infra/DEPLOY.md](infra/DEPLOY.md)。

## 1. 它解决什么问题

Amazon Quick 的 MCP 连接器向导强制要求标准 OAuth 认证（Authorization URL / Token URL / Client ID / Secret），
而钉钉 MCP 广场生成的 Remote URL 用 `?key=` 参数鉴权、且绑定个人，无法满足「标准 OAuth + 多用户隔离」。

本网关作为中间层填补这个缺口：

- 对 MCP Client（Amazon Quick）：扮演标准 **OAuth 2.1 Authorization Server**（强制 PKCE）
- 对钉钉：扮演标准 **OAuth Client**
- 对 MCP 调用：扮演 **协议代理**，把请求转发到钉钉企业版 MCP 统一网关 `mcp-gw.dingtalk.com`

关键收益：MCP Client 永不接触钉钉凭据；每个用户用自己的钉钉身份授权，数据按用户隔离；
钉钉工具无需逐个重新实现，直接代理钉钉官方 MCP 网关。

## 2. 角色与整体架构

```
┌────────────────┐   OAuth 2.1 (PKCE)    ┌──────────────────────────────┐   x-user-access-token    ┌──────────────────────┐
│  Amazon Quick  │ ────────────────────► │   MCP OAuth Gateway（本项目）  │ ───────────────────────► │  钉钉 MCP 统一网关     │
│  (MCP Client)  │ ◄──────────────────── │                              │ ◄─────────────────────── │  mcp-gw.dingtalk.com │
└────────────────┘     MCP over HTTP     │  • OAuth Authorization Server │      MCP 执行并返回       └──────────────────────┘
                                         │  • DingTalk OAuth Client      │
                                         │  • MCP 分组聚合代理            │          ┌──────────────────────┐
                                         └──────────────┬───────────────┘          │  钉钉 OAuth 授权服务   │
                                                        │  钉钉 OAuth 2.0          │  login.dingtalk.com  │
                                                        └─────────────────────────►└──────────────────────┘
```

网关一身三任：

| 身份 | 职责 |
|------|------|
| OAuth Authorization Server | 对 Quick 暴露 `/authorize` `/token` `/register` 及元数据发现，签发 mcp_token |
| DingTalk OAuth Client | 把用户重定向到钉钉登录，回调换取钉钉 user_access_token |
| MCP 分组聚合代理 | 校验 mcp_token，取出对应钉钉 token，转发到钉钉 MCP 网关并聚合工具 |

## 3. 完整授权流程

```
Quick ──① GET /authorize（client_id + redirect_uri + state + PKCE code_challenge）
         网关校验参数与 redirect_uri 白名单，生成 sessionId 存 AuthSession
      ──② 302 跳转钉钉授权页（scope=openid corpid，state=sessionId）
         用户在钉钉登录并授权
钉钉  ──③ GET /dingtalk/callback?authCode=...&state=sessionId
         网关用 authCode 换钉钉 token（access/refresh/corpId），取用户 openId
         生成一次性 mcp_code，关联钉钉 token + userId + sessionId
      ──④ 302 回 Quick 的 redirect_uri（code=mcp_code，原样带回 state）
Quick ──⑤ POST /token（grant_type=authorization_code, code, code_verifier）
         网关校验 client_id/redirect_uri 一致、PKCE：SHA256(code_verifier)==code_challenge
         签发 mcp_access_token + mcp_refresh_token，删除一次性 code 与 session
      ──⑥ POST /mcp/<分组>（Authorization: Bearer mcp_access_token）
         中间件校验 token、必要时自动续期钉钉 token
         聚合器按 <server>__<tool> 前缀转发到 mcp-gw.dingtalk.com/server/<server>
```

注意涉及两个不同的回调地址，容易混淆：

| 回调 | 地址 | 用途 |
|------|------|------|
| Quick 的回调 | `https://<region>.quicksight.aws.amazon.com/sn/oauthcallback` | Quick 接收网关签发的 mcp_code |
| 网关的钉钉回调 | `https://<网关域名>/dingtalk/callback` | 网关接收钉钉签发的 authCode |

## 4. OAuth 端点与标准兼容

| 端点 | 规范 | 说明 |
|------|------|------|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | 授权服务器元数据发现 |
| `GET /.well-known/oauth-protected-resource[/<分组>]` | RFC 9728 | 受保护资源元数据，401 时由 `WWW-Authenticate` 头指向 |
| `POST /register` | RFC 7591 | 动态客户端注册（DCR），Quick 的 Default OAuth app 模式自动调用 |
| `GET /authorize` | OAuth 2.1 | 强制校验 PKCE（仅 S256）、state、redirect_uri 白名单 |
| `POST /token` | OAuth 2.1 | 支持 `authorization_code` 与 `refresh_token` 两种 grant |

客户端认证：`/token` 兼容三种方式——`client_secret_basic`（Quick 用此方式，凭据在 `Authorization: Basic` 头）、
`client_secret_post`（凭据在 body）、`none`（public client）。

> **关于 client_secret**：网关遵循 OAuth 2.1 PKCE public client 模式，安全性由 `code_challenge`/`code_verifier`
> 保证，**实际不校验 secret**。但 Quick 表单要求 secret 必填，故 DCR 在客户端声明 `client_secret_basic/post`
> 时会签发一个 secret 写进注册响应（否则 Quick 会校验失败），该 secret 不参与鉴权。

钉钉侧授权使用 `scope=openid corpid`，以便拿到 corpId 调用企业级能力。

## 5. 数据存储模型

存储抽象为 `IStorage` 接口（`src/storage/interface.ts`），有内存与 DynamoDB 两种实现，按 `STORAGE_DRIVER` 切换。

| 记录 | 主键 | TTL | 用途 |
|------|------|-----|------|
| `ClientRecord` | clientId | 永久 | 注册的客户端（含 redirect_uri 白名单） |
| `AuthSession` | sessionId | 10 分钟 | 授权中间态（state、code_challenge、redirect_uri、scope） |
| `McpCode` | code | 5 分钟 | 一次性授权码，关联钉钉 token 与 userId，用后即删 |
| `TokenRecord` | mcpAccessToken（+ refresh 指针） | 对齐 refresh 30 天 | mcp_token ↔ 钉钉 token 映射 |

`TokenRecord` 用双键设计：主记录以 `TOKEN#<accessToken>` 存储，另写一条 `REFRESH#<refreshToken>` 指针指向主记录，
使刷新流程能通过 refresh_token 反查（即便 access_token 已过期）。`deleteToken` 会同时清除主记录与指针。

Token 生命周期：

| Token | 有效期（默认） | 续期策略 |
|-------|---------------|----------|
| mcp_authorization_code | 5 分钟（`MCP_CODE_EXPIRY`） | 一次性，换 token 后立即删除 |
| mcp_access_token | 1 小时（`MCP_TOKEN_EXPIRY`） | 用 refresh_token 换新 |
| mcp_refresh_token | 30 天（`MCP_REFRESH_EXPIRY`） | 轮换：每次刷新都签发新的并删旧的 |
| 钉钉 access_token | 钉钉定义（约 2 小时） | 网关在刷新或 MCP 调用时自动用钉钉 refresh_token 续期 |

钉钉 access/refresh token 在 DynamoDB 实现中经 **KMS 加密**后存储（`KMS_KEY_ID` 留空则透传，仅限本地开发）。

## 6. MCP 分组聚合（核心设计）

钉钉上游 15 个 server 共约 316 个工具，超过 Amazon Quick 单连接器 **100 工具上限**。
聚合器（`src/mcp/aggregator.ts`）按「业务域 + 危险隔离」拆成 5 个分组，每个分组是一个独立 MCP endpoint：

| 分组 | Endpoint | 上游 server | 模式 | 工具数 |
|------|----------|-------------|------|--------|
| 办公协作 | `/mcp/office` | contact, calendar, todo, report | safe | ~58 |
| 文档知识 | `/mcp/docs` | doc, wiki, drive | safe | ~45 |
| 表格数据 | `/mcp/tables` | aitable, sheet | safe | ~92 |
| 沟通审批 | `/mcp/comm` | oa, mail, bot, group, live, teambition | safe | ~89 |
| ⚠️ 危险操作 | `/mcp/danger` | 以上全部 server | danger | ~32 |

设计要点：

- **工具名前缀**：聚合后工具名加 `<server>__<tool>` 前缀（如 `calendar__list_calendars`），`tools/call` 时按前缀路由回对应上游 server。
- **危险隔离**：按工具名动词判定危险（`delete`/`remove`/`revoke`/`reject`，兼容 `batch_` 前缀）。前 4 个 safe 分组只保留非危险工具，所有破坏性操作集中在 danger 分组。
- **强制确认**：danger 分组每个工具的 description 与 `initialize` 返回的 `instructions` 都注入强制提示，要求 AI 助手调用前先向用户说明操作内容、影响范围、不可逆，并取得确认。
- **跨组防绕过**：`tools/call` 会校验目标工具确实属于当前分组（server 归属 + 危险性匹配），防止借 safe 分组调用危险工具。
- **缓存与单飞**：`tools/list` 结果按分组全局缓存（`MCP_TOOLS_CACHE_TTL`，默认 600s），并用 inflight 单飞避免并发重复拉取（工具定义对所有用户一致）。
- **优雅降级**：用 `Promise.allSettled` 拉取各 server，单个 server 失败/报错则跳过，不影响整组。
- **SSE 兼容**：上游可能返回 `text/event-stream`，聚合器解析 `data:` 行还原 JSON。

支持的 MCP 方法：`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`。
另有 `GET /mcp/groups`（无需鉴权）列出全部分组，便于发现。

转发时把 `Authorization: Bearer <mcp_token>` 替换为钉钉要求的 `x-user-access-token: <钉钉 token>`，
目标地址 `https://mcp-gw.dingtalk.com/server/<serverName>`。

## 7. 代码结构

```
src/
├── index.ts              # Express 入口：装配中间件、预注册 Quick Client、挂载路由、优雅停机
├── config.ts             # 环境变量集中配置
├── oauth/                # OAuth Authorization Server
│   ├── metadata.ts       # RFC 8414 / RFC 9728 元数据发现
│   ├── register.ts       # RFC 7591 动态客户端注册
│   ├── authorize.ts      # 授权端点（校验 + 302 跳钉钉）
│   └── token.ts          # Token 端点（授权码 / 刷新，含客户端凭据解析）
├── dingtalk/
│   └── callback.ts       # 钉钉回调：authCode 换 token、取用户信息、生成 mcp_code
├── mcp/
│   ├── aggregator.ts     # 5 分组聚合代理（前缀路由 / 危险隔离 / 缓存 / SSE）
│   ├── middleware.ts     # Bearer token 校验 + 钉钉 token 自动续期 + WWW-Authenticate
│   └── tools/            # 早期本地工具（兼容保留）
├── storage/
│   ├── interface.ts      # IStorage 接口与记录类型
│   ├── factory.ts        # 按 STORAGE_DRIVER 选择实现
│   ├── memory.ts         # 内存实现（本地开发）
│   └── dynamo.ts         # DynamoDB 实现（TTL + KMS 加密）
└── utils/
    ├── crypto.ts         # token/code/sessionId 生成、PKCE 校验
    ├── dingtalk-api.ts   # 钉钉 token 交换/续期、用户信息
    └── encryption.ts     # KMS 加解密封装
```

## 8. 部署形态

生产部署到 AWS（详见 `infra/`）：

```
Amazon Quick / 钉钉
      │ HTTPS（固定域名 + ACM 证书）
      ▼
   ALB（idle_timeout=300s，支撑 SSE 长连接）
      ▼
  ECS Fargate（≥2 实例）  ← Express 应用（本项目镜像）
      ├──► DynamoDB（token 映射持久化，TTL 自动清理过期记录）
      ├──► KMS（钉钉 token 等敏感字段加解密）
      └──► Secrets Manager（钉钉 AppSecret，不落明文）
```

- **镜像**：多阶段 Dockerfile（node:22-alpine），构建后 `npm prune` 仅留生产依赖，非 root 用户运行。
- **优雅停机**：监听 SIGTERM，停止接收新连接并等待进行中的请求（含 SSE）完成，配合 ALB deregistration delay 避免硬切断。
- **一键部署**：`scripts/deploy.sh`（首次，交互填参并存 AppSecret 到 Secrets Manager）、`scripts/redeploy.sh`（发版，复用 `.deploy-config`）。

## 9. 安全要点

- 全链路 HTTPS；授权强制 PKCE（S256）与 state 校验；redirect_uri 白名单。
- authorization_code 一次性使用，用后即删；refresh_token 轮换。
- 钉钉 AppSecret 仅存服务端（生产存 Secrets Manager），永不下发给 MCP Client。
- DynamoDB 中钉钉 token 经 KMS 加密存储。
- 危险/不可逆操作隔离在独立分组，并强制要求调用前用户确认。

## 10. 历史背景

项目初期（Phase 1）设想由网关逐个封装钉钉 OpenAPI 为 MCP Tool，并用 Redis 存储。
后来发现钉钉已上线企业版 MCP 统一网关（`mcp-gw.dingtalk.com`），用 OAuth 拿到的 user_access_token
即可直接调用，于是架构简化为「**OAuth + MCP 协议代理**」：不再自实现工具，改为分组聚合转发；
存储也从 Redis 改为 DynamoDB（配合 TTL 与 KMS）。当前代码即简化后的形态，Redis 配置项已废弃保留。
