# OAuth 鉴权架构设计文档

> 本文档描述「钉钉 MCP OAuth 网关」的 OAuth 2.1 鉴权架构，
> 旨在为标准化迁移（更换上游 IdP、替换存储层、部署到其他平台）提供完整参考。

---

## 1. 系统定位与角色

本系统是一个 **OAuth 2.1 授权服务器（Authorization Server）**，
同时扮演 **钉钉 OAuth 客户端（OAuth Client）** 的双重角色：

| 角色 | 说明 |
|------|------|
| 对 MCP Client（如 Amazon Quick）| 本系统是 **授权服务器**，签发 MCP access/refresh token |
| 对钉钉开放平台 | 本系统是 **OAuth 客户端**，持有 AppKey/AppSecret，代用户获取钉钉 token |

```
┌────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│ MCP Client │──────▶│  本网关（OAuth AS）    │──────▶│  钉钉开放平台    │
│ (Quick)    │◀──────│  + MCP 聚合代理       │◀──────│  (IdP/Resource) │
└────────────┘       └──────────────────────┘       └─────────────────┘
```

---

## 2. 协议规范遵循

| 规范 | 用途 | 实现位置 |
|------|------|----------|
| RFC 6749 / OAuth 2.1 | 授权码流程 | `/authorize`, `/token` |
| RFC 7636 (PKCE) | 防授权码劫持，强制 S256 | `/authorize` + `/token` |
| RFC 7591 (DCR) | 动态客户端注册 | `POST /register` |
| RFC 8414 | 授权服务器元数据发现 | `/.well-known/oauth-authorization-server` |
| RFC 9728 | 受保护资源元数据 | `/.well-known/oauth-protected-resource` |

---

## 3. 核心端点一览

| 端点 | 方法 | 功能 | 源文件 |
|------|------|------|--------|
| `/.well-known/oauth-authorization-server` | GET | AS 元数据发现 | `src/oauth/metadata.ts` |
| `/.well-known/oauth-protected-resource[/path]` | GET | 资源元数据发现 | `src/oauth/metadata.ts` |
| `/register` | POST | 动态客户端注册 (DCR) | `src/oauth/register.ts` |
| `/authorize` | GET | 授权端点（启动流程） | `src/oauth/authorize.ts` |
| `/dingtalk/callback` | GET | 钉钉授权回调（中间跳转） | `src/dingtalk/callback.ts` |
| `/token` | POST | 令牌端点（code→token / refresh） | `src/oauth/token.ts` |
| `/mcp/:group` | POST | 受保护的 MCP 资源端点 | `src/mcp/aggregator.ts` |

---

## 4. 完整授权流程（时序图）

```
MCP Client          本网关 (AS)           钉钉开放平台
    │                    │                      │
    │ ① GET /.well-known/oauth-authorization-server
    │───────────────────▶│                      │
    │◀──────────────────-│ (返回端点信息)        │
    │                    │                      │
    │ ② POST /register (DCR)                   │
    │───────────────────▶│                      │
    │◀──────────────────-│ (client_id)          │
    │                    │                      │
    │ ③ GET /authorize                         │
    │   ?response_type=code                    │
    │   &client_id=...                         │
    │   &redirect_uri=...                      │
    │   &code_challenge=...                    │
    │   &code_challenge_method=S256            │
    │   &state=...                             │
    │───────────────────▶│                      │
    │                    │ 保存 AuthSession      │
    │                    │ ④ 302 → 钉钉授权页   │
    │                    │─────────────────────▶│
    │                    │                      │ (用户扫码/确认)
    │                    │◀─────────────────────│
    │                    │ ⑤ GET /dingtalk/callback
    │                    │   ?authCode=...&state=sessionId
    │                    │                      │
    │                    │ ⑥ 钉钉 authCode → token
    │                    │─────────────────────▶│
    │                    │◀─────────────────────│ (dingtalk access/refresh token)
    │                    │                      │
    │                    │ 生成 MCP Code         │
    │ ⑦ 302 → redirect_uri?code=mcp_code&state=...
    │◀──────────────────-│                      │
    │                    │                      │
    │ ⑧ POST /token                            │
    │   grant_type=authorization_code           │
    │   &code=mcp_code                         │
    │   &code_verifier=...                     │
    │   &redirect_uri=...                      │
    │───────────────────▶│                      │
    │                    │ PKCE 验证             │
    │                    │ 签发 MCP token        │
    │◀──────────────────-│                      │
    │ (access_token, refresh_token)             │
    │                    │                      │
    │ ⑨ POST /mcp/:group (Bearer token)        │
    │───────────────────▶│                      │
    │                    │ 验证 MCP token        │
    │                    │ 透传钉钉 token → 上游 │
    │                    │─────────────────────▶│
    │◀──────────────────-│ (MCP 工具调用结果)    │
```

---

## 5. 数据模型

### 5.1 实体定义

#### ClientRecord — 已注册的 OAuth 客户端

```typescript
interface ClientRecord {
  clientId: string;              // 唯一标识（DCR 时自动生成）
  clientSecretHash: string;      // client_secret（public client 为空）
  redirectUris: string[];        // 允许的回调地址白名单
  clientName: string;            // 客户端名称
  grantTypes: string[];          // 允许的 grant type
  tokenEndpointAuthMethod: string; // 认证方式: none / client_secret_basic / client_secret_post
  createdAt: number;             // 创建时间戳 (ms)
}
```

#### AuthSession — 授权会话（临时态）

```typescript
interface AuthSession {
  sessionId: string;             // UUID，同时作为钉钉 OAuth 的 state 参数
  clientId: string;              // 关联的客户端
  redirectUri: string;           // 最终回调地址
  state: string;                 // MCP Client 传入的 state（原样回传）
  codeChallenge: string;         // PKCE code_challenge
  codeChallengeMethod: string;   // 固定 S256
  scope: string;                 // 请求的 scope
  createdAt: number;             // 创建时间戳
}
// TTL: 10 分钟
```

#### McpCode — MCP 授权码（一次性，临时态）

```typescript
interface McpCode {
  code: string;                  // mcp_code_xxx 格式
  sessionId: string;             // 关联的 AuthSession
  dingtalkAccessToken: string;   // 钉钉用户 token（加密存储）
  dingtalkRefreshToken: string;  // 钉钉刷新 token（加密存储）
  dingtalkTokenExpiresAt: number;// 钉钉 token 过期时间
  corpId: string;                // 企业 ID
  userId: string;                // 用户 OpenID
  createdAt: number;
}
// TTL: 5 分钟，使用后立即删除
```

#### TokenRecord — MCP 令牌（长期态）

```typescript
interface TokenRecord {
  mcpAccessToken: string;        // mcp_at_xxx 格式
  mcpRefreshToken: string;       // mcp_rt_xxx 格式
  clientId: string;              // 关联的客户端
  userId: string;                // 用户标识
  corpId: string;                // 企业标识
  scope: string;                 // 授权范围
  dingtalkAccessToken: string;   // 钉钉 token（加密存储）
  dingtalkRefreshToken: string;  // 钉钉刷新 token（加密存储）
  dingtalkTokenExpiresAt: number;// 钉钉 token 过期时间
  mcpTokenExpiresAt: number;     // MCP access_token 过期时间
  createdAt: number;
}
// access_token 有效期: 1 小时（可配置 MCP_TOKEN_EXPIRY）
// refresh_token 有效期: 30 天（可配置 MCP_REFRESH_EXPIRY）
```

### 5.2 存储架构

采用 **策略模式**（Strategy Pattern），通过接口抽象支持多种存储后端：

```
IStorage (interface)
  ├── MemoryStorage   — 本地开发（进程内 Map）
  └── DynamoStorage   — 生产环境（AWS DynamoDB 单表设计）
```

**DynamoDB 单表设计（Single-Table Design）：**

| 实体 | 分区键 pk | TTL |
|------|-----------|-----|
| Client | `CLIENT#<clientId>` | 无（长期） |
| AuthSession | `SESSION#<sessionId>` | 10 分钟 |
| McpCode | `CODE#<code>` | 5 分钟 |
| Token 主记录 | `TOKEN#<accessToken>` | 与 refresh 对齐（30 天） |
| Refresh 指针 | `REFRESH#<refreshToken>` | 与 refresh 对齐（30 天） |

**安全设计：**
- 钉钉 access/refresh token 通过 AWS KMS 加密后存储
- 加密前缀 `kms:` 用于区分密文与明文（向后兼容）
- Token 主记录与 Refresh 指针使用 DynamoDB 事务（TransactWrite）保证一致性

---

## 6. 安全机制

### 6.1 PKCE（Proof Key for Code Exchange）

- **强制要求**：所有授权请求必须携带 `code_challenge` + `code_challenge_method=S256`
- **验证时机**：`/token` 端点校验 `code_verifier` 与存储的 `code_challenge` 匹配
- **算法**：`code_challenge = BASE64URL(SHA256(code_verifier))`

### 6.2 客户端认证

支持三种方式（由 DCR 时 `token_endpoint_auth_method` 决定）：

| 方式 | 说明 | 安全保证 |
|------|------|----------|
| `none` | Public Client，无 secret | 依赖 PKCE |
| `client_secret_basic` | Authorization: Basic 头 | PKCE + secret |
| `client_secret_post` | Body 中传 client_secret | PKCE + secret |

> 实际安全性主要由 PKCE 保证，client_secret 更多是协议兼容性需要。

### 6.3 Token 安全

- Token 格式：`前缀_随机48字符`（UUID 拼接去横线）
- 前缀区分用途：`mcp_at_`（access）、`mcp_rt_`（refresh）、`mcp_code_`（授权码）
- Refresh Token 轮换（Rotation）：每次刷新都签发新的 refresh_token，旧的立即失效
- 钉钉 token 自动续期：中间件层在钉钉 token 过期时透明续期，不影响 MCP Client

### 6.4 敏感数据保护

- 钉钉 token 使用 AWS KMS 信封加密后存入 DynamoDB
- 加密/解密通过 `src/utils/encryption.ts` 统一处理
- 本地开发环境可不配置 KMS（退化为明文，不阻塞开发）

---

## 7. Token 生命周期管理

### 7.1 过期策略

| Token 类型 | 默认有效期 | 配置项 |
|------------|-----------|--------|
| AuthSession | 10 分钟 | 硬编码 |
| MCP Code | 5 分钟 | `MCP_CODE_EXPIRY` |
| MCP Access Token | 1 小时 | `MCP_TOKEN_EXPIRY` |
| MCP Refresh Token | 30 天 | `MCP_REFRESH_EXPIRY` |
| 钉钉 Access Token | ~2 小时 | 由钉钉决定 |
| 钉钉 Refresh Token | ~30 天 | 由钉钉决定 |

### 7.2 刷新流程

```
MCP Client                     本网关                        钉钉
    │                            │                            │
    │ POST /token                │                            │
    │ grant_type=refresh_token   │                            │
    │ refresh_token=mcp_rt_xxx   │                            │
    │───────────────────────────▶│                            │
    │                            │ 查找 TokenRecord            │
    │                            │ 验证 client_id              │
    │                            │                            │
    │                            │ 钉钉 token 过期？           │
    │                            │──────── 是 ────────────────▶│
    │                            │          刷新钉钉 token      │
    │                            │◀────────────────────────────│
    │                            │                            │
    │                            │ 删除旧 token 记录           │
    │                            │ 生成新 access + refresh     │
    │◀───────────────────────────│                            │
    │ (新 access_token,          │                            │
    │  新 refresh_token)         │                            │
```

### 7.3 中间件自动续期

Bearer Token 验证中间件 (`src/mcp/middleware.ts`) 在每次请求时：
1. 验证 MCP access_token 有效性
2. 检查关联的钉钉 token 是否过期
3. 若过期则自动调用钉钉 refresh API 续期
4. 更新存储中的钉钉 token 信息
5. 将有效的钉钉 token 注入 `req.dingtalkAccessToken` 供下游使用

---

## 8. 元数据发现机制

### 8.1 授权服务器元数据 (RFC 8414)

端点：`GET /.well-known/oauth-authorization-server`

```json
{
  "issuer": "https://your-gateway.example.com",
  "authorization_endpoint": "https://your-gateway.example.com/authorize",
  "token_endpoint": "https://your-gateway.example.com/token",
  "registration_endpoint": "https://your-gateway.example.com/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "none"],
  "scopes_supported": ["openid", "dingtalk:contact:read", "dingtalk:message:send"]
}
```

### 8.2 受保护资源元数据 (RFC 9728)

端点：`GET /.well-known/oauth-protected-resource[/<resource-path>]`

MCP Client 访问 `/mcp/:group` 时若未携带 token，返回 `401` + `WWW-Authenticate` 头：

```
WWW-Authenticate: Bearer resource_metadata="https://gw.example.com/.well-known/oauth-protected-resource/mcp/office"
```

Client 据此发现授权服务器并启动 DCR → 授权码流程。

---

## 9. 模块依赖关系

```
src/
├── index.ts                    # 应用入口，组装路由
├── config.ts                   # 环境变量集中管理
│
├── oauth/
│   ├── metadata.ts             # 元数据发现（RFC 8414 / RFC 9728）
│   ├── register.ts             # 动态客户端注册（RFC 7591）
│   ├── authorize.ts            # 授权端点 → 重定向到钉钉
│   └── token.ts                # 令牌端点（code 换 token / refresh）
│
├── dingtalk/
│   └── callback.ts             # 钉钉回调 → 生成 MCP Code → 回 Client
│
├── mcp/
│   ├── middleware.ts           # Bearer Token 验证 + 钉钉 token 自动续期
│   └── aggregator.ts           # MCP 工具聚合网关（受保护资源）
│
├── storage/
│   ├── interface.ts            # 存储层抽象接口
│   ├── factory.ts              # 存储工厂（策略模式）
│   ├── memory.ts               # 内存实现（开发用）
│   └── dynamo.ts               # DynamoDB 实现（生产用）
│
└── utils/
    ├── crypto.ts               # Token 生成 + PKCE 验证
    ├── encryption.ts           # KMS 加密/解密
    └── dingtalk-api.ts         # 钉钉 API 封装
```

---

## 10. 配置参数

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | 3000 | 服务监听端口 |
| `BASE_URL` | http://localhost:3000 | 公网可访问地址（用于构造回调 URL 和元数据） |
| `DINGTALK_APP_KEY` | — | 钉钉应用 AppKey |
| `DINGTALK_APP_SECRET` | — | 钉钉应用 AppSecret |
| `DINGTALK_AUTH_URL` | https://login.dingtalk.com/oauth2/auth | 钉钉授权页 URL |
| `DINGTALK_TOKEN_URL` | https://api.dingtalk.com/v1.0/oauth2/userAccessToken | 钉钉 token 端点 |
| `DINGTALK_CALLBACK_PATH` | /dingtalk/callback | 钉钉回调路径 |
| `MCP_TOKEN_EXPIRY` | 3600 | MCP access_token 有效期（秒） |
| `MCP_REFRESH_EXPIRY` | 2592000 | MCP refresh_token 有效期（秒） |
| `MCP_CODE_EXPIRY` | 300 | 授权码有效期（秒） |
| `QUICK_CLIENT_ID` | amazon_quick_001 | 预注册的 Quick 客户端 ID |
| `QUICK_CLIENT_SECRET` | — | Quick 客户端 secret（可选） |
| `QUICK_REDIRECT_URI` | — | Quick 回调地址（逗号分隔多个） |
| `STORAGE_DRIVER` | memory | 存储驱动: memory / dynamo |
| `DYNAMO_TABLE_NAME` | dingtalk-mcp-gateway | DynamoDB 表名 |
| `DYNAMO_ENDPOINT` | — | DynamoDB 端点（本地开发用） |
| `AWS_REGION` | ap-southeast-1 | AWS 区域 |
| `KMS_KEY_ID` | — | KMS 密钥 ID（不配置则不加密） |

---

## 11. 迁移指南

### 11.1 更换上游 IdP（将钉钉替换为其他身份提供者）

**需修改的模块：**

1. `src/dingtalk/callback.ts` → 改为新 IdP 的回调处理逻辑
2. `src/utils/dingtalk-api.ts` → 替换为新 IdP 的 API 封装
3. `src/oauth/authorize.ts` → 修改重定向目标（当前指向钉钉授权页）
4. `src/config.ts` → 替换 IdP 相关配置项

**无需修改的模块：**
- 存储层（`src/storage/`）— 数据模型与 IdP 无关
- Token 端点（`src/oauth/token.ts`）— 仅处理 MCP token，IdP token 已在回调阶段获取
- 中间件（`src/mcp/middleware.ts`）— 需适配新 IdP 的 token 刷新接口
- 元数据 / 注册 — 与 IdP 无关

**抽象建议：**

```typescript
// 建议引入 IdP 适配器接口
interface IdPAdapter {
  getAuthorizationUrl(sessionId: string, callbackUrl: string): string;
  exchangeToken(authCode: string): Promise<IdPTokenResponse>;
  refreshToken(refreshToken: string): Promise<IdPTokenResponse>;
  getUserInfo(accessToken: string): Promise<IdPUserInfo>;
}
```

### 11.2 更换存储后端

当前已有完整的存储抽象（`IStorage` 接口），迁移步骤：

1. 新建 `src/storage/your-backend.ts` 实现 `IStorage` 接口
2. 在 `src/storage/factory.ts` 添加新的 case 分支
3. 设置环境变量 `STORAGE_DRIVER=your-backend`

**注意事项：**
- Token 需要支持按 accessToken 和 refreshToken 两种方式查询
- 需实现过期清理机制（应用层判断 + 物理 TTL 清理）
- 事务一致性：Token 主记录与 Refresh 指针应原子写入

### 11.3 部署到其他平台

当前部署在 AWS ECS Fargate，迁移要点：

| 组件 | 当前 | 替代方案 |
|------|------|----------|
| 计算 | ECS Fargate | K8s / Cloud Run / Lambda |
| 存储 | DynamoDB | Redis / PostgreSQL / CosmosDB |
| 加密 | AWS KMS | Vault / Cloud KMS / 本地加密 |
| 负载均衡 | ALB | Nginx / Cloud LB |

---

## 12. 安全审计检查清单

- [ ] PKCE 是否强制（不允许无 code_challenge 的请求）
- [ ] 授权码是否一次性使用（使用后立即删除）
- [ ] Refresh Token 是否轮换（每次刷新生成新 RT）
- [ ] 钉钉 token 是否加密存储（KMS 加密）
- [ ] redirect_uri 是否严格校验（精确匹配白名单）
- [ ] 临时数据是否有 TTL（Session 10min, Code 5min）
- [ ] 非 localhost 的 redirect_uri 是否强制 HTTPS
- [ ] 是否有优雅停机处理（SIGTERM → 等待连接关闭）
- [ ] 客户端认证方式解析是否正确（Basic / Post / None）

---

## 13. 与 MCP 协议的集成

本网关不仅是 OAuth 授权服务器，还是 MCP (Model Context Protocol) 的受保护资源代理：

- **Discovery Flow**：MCP Client 访问 `/mcp/:group` → 401 + WWW-Authenticate → 发现 AS → DCR → 授权
- **Token Binding**：每个 MCP token 绑定一个钉钉用户 token，实现 per-user 代理访问
- **透明续期**：中间件层自动管理钉钉 token 生命周期，MCP Client 无感知
- **分组隔离**：5 个 MCP 分组共享同一 OAuth 层，token 跨分组通用

---

*文档版本：1.0.0 | 最后更新：2026-06-08*
