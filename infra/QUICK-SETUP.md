# Amazon Quick 接入配置指南

本文档记录将 DingTalk MCP OAuth Gateway 接入 Amazon Quick（Quick Suite）的完整配置参数。

> 文中 `<你的网关域名>` 为占位符，请替换为你实际部署的网关域名（例如 `gateway.example.com`）。

## 网关信息

| 项 | 值 |
|----|-----|
| 网关域名 | `https://<你的网关域名>` |
| 部署区域 | ap-southeast-1 |
| 认证方式 | OAuth 2.1 Authorization Code + PKCE |

---

## 用户身份隔离（per-user）—— 重要

本网关按 **per-user** 设计：每个用户以**自己的钉钉身份**调用，数据按用户隔离。
网关的映射规则是「mcp_token → 授权时的钉钉用户」，每次授权独立绑定授权者身份。

实现 per-user 的前提是 **Quick 为每个用户单独发起 OAuth 授权**（DCR + User authentication）。
实测要点（已验证）：

- 管理员创建 connector 时用 **Default OAuth app**（走 DCR 动态注册），并发布给团队。
- 每个团队成员首次使用时，Quick 会**弹出登录按钮**，成员用**自己的钉钉账号**完成授权，
  之后以自己身份调用。日志中可见各自的 `[authorize] → [dingtalk/callback] 用户信息: nick=<本人> → [token] 颁发`。
- 若成员未授权，调用会触发其本人的授权流（而非复用管理员凭据）。

> 历史说明：早期若 connector 走「共享凭据」模式（管理员授权一次、全员复用），
> 会导致所有人共用管理员的钉钉身份。务必使用 Default OAuth app（DCR）模式以获得 per-user 隔离。

---

## 一、Amazon Quick 连接器配置

在 Quick 的 OAuth / 自定义连接器配置界面，按下表填写：

| 字段 | 值 | 说明 |
|------|-----|------|
| Authorization URL | `https://<你的网关域名>/authorize` | 授权端点 |
| Token URL | `https://<你的网关域名>/token` | 令牌端点 |
| Client ID | `amazon_quick_001` | 预分配的 client_id |
| Client Secret | 任意非空字符串（占位即可，勿填真实密钥） | 网关用 PKCE 鉴权，不校验 secret；Quick 表单要求非空，填占位值即可 |
| MCP Server Endpoint | 见下方「分组」——需创建 5 个 connector，各填对应分组 URL | 钉钉工具按分组拆分，规避 Quick 100 工具上限 |
| Scope | `openid` | 也支持 `openid dingtalk:contact:read dingtalk:message:send` |
| Redirect URL | `https://us-east-1.quicksight.aws.amazon.com/sn/oauthcallback` | Quick 自带，须与网关白名单一致（见下） |

### 关于 Client Secret

网关遵循 OAuth 2.1 的 PKCE public client 模式，安全性由 `code_challenge`/`code_verifier` 保证，
**不校验 client_secret**。但 Quick 表单将其列为必填，填任意非空字符串即可。
Quick 实际通过 `Authorization: Basic` 头发送 client_id/secret，网关已兼容解析。

### 关于 Redirect URL（重要）

Quick 的回调地址形如 `https://<region>.quicksight.aws.amazon.com/sn/oauthcallback`，
其中 `<region>` 取决于你的 Quick 所在区域。该地址**必须**在网关的 client 白名单中，
否则授权第一步会报 `invalid_redirect_uri`。

当前网关白名单（通过 `QUICK_REDIRECT_URI` 参数配置，支持逗号分隔多个）：

```
https://us-east-1.quicksight.aws.amazon.com/sn/oauthcallback
https://quick.aws.com/sn/oauthcallback
```

如果你的 Quick 在其它区域，需把对应回调地址加入白名单后重新发版（见 `redeploy.sh`）。

---

## 二、钉钉开放平台配置

在钉钉开发者后台（对应你自己的应用 AppKey）配置：

| 项 | 值 |
|----|-----|
| 重定向 URL（回调域名） | `https://<你的网关域名>/dingtalk/callback` |
| 所需权限 | 按需申请：通讯录、日历、待办、文档、审批、邮箱等 |

---

## 三、MCP 工具说明（分组聚合网关）

由于 Amazon Quick 对单个 MCP connector 有 **100 个工具上限**，而钉钉全部工具达 316 个，
网关将其按"业务域 + 危险隔离"拆分为 **5 个分组**，每个分组是一个独立的 MCP endpoint。
**需要在 Quick 中分别创建 5 个 connector，每个单独授权一次。**

工具名采用 `<server>__<tool>` 前缀（如 `calendar__list_calendars`），便于区分来源。

### 5 个分组 endpoint

| 分组 | MCP Endpoint | 建议 connector 名 | 工具数 | 内容 |
|------|--------------|-------------------|--------|------|
| 办公协作 | `https://<你的网关域名>/mcp/office` | 钉钉-办公协作 | ~58 | 通讯录、日历、待办、日志 |
| 文档知识 | `https://<你的网关域名>/mcp/docs` | 钉钉-文档知识 | ~45 | 文档、知识库、钉盘 |
| 表格数据 | `https://<你的网关域名>/mcp/tables` | 钉钉-表格数据 | ~92 | AI 表格、在线表格 |
| 沟通审批 | `https://<你的网关域名>/mcp/comm` | 钉钉-沟通审批 | ~89 | OA审批、邮箱、机器人、群聊、直播、项目管理 |
| ⚠️ 危险操作 | `https://<你的网关域名>/mcp/danger` | 钉钉-危险操作(删除类) | ~32 | 上述所有服务的 delete/remove/revoke/reject |

> 以上前 4 个分组**只含非危险工具**（查询、新增、更新），不含任何删除/移除/撤销/驳回操作。
> 所有破坏性操作统一隔离在「危险操作」分组。

### ⚠️ 关于危险操作分组（务必阅读）

`/mcp/danger` 包含全部不可逆操作（delete/remove/revoke/reject），例如删除日程、移除群成员、
撤销审批、删除文档等。

- **对用户**：这是一个独立 connector，需单独授权。仅在确实需要执行删除类操作时才连接它。
- **对 AI 助手**：该分组每个工具的 description 都强制要求——调用前必须先向用户说明
  「将执行的操作 + 影响的对象与范围 + 操作不可逆」，并取得用户明确确认后才能调用。
  网关 serverInfo 的 instructions 也会下发该提示。

> 提示：危险组只含"删除类"工具，不含查询工具。若要完成「先查到目标再删除」的操作，
> 用户可能需要同时连接对应的业务分组（如删日程需配合「办公协作」查到日程 ID）。

### 发现分组

`GET https://<你的网关域名>/mcp/groups` 可列出全部分组及说明（无需鉴权）。

> 全部 316 个工具的完整分类明细（每个工具归属哪个分组、32 个危险工具清单）见
> [MCP-CLASSIFICATION.md](MCP-CLASSIFICATION.md)。

### 裁剪分组内的 server

如需调整某分组包含的 server，或屏蔽特定能力，修改 `src/mcp/aggregator.ts` 的 `GROUPS` 定义后重新发版。
工具列表缓存 TTL 由 `MCP_TOOLS_CACHE_TTL`（秒，默认 600）控制。

---

## 四、完整授权流程

```
Quick → /authorize（校验 client_id + redirect_uri + PKCE）
     → 302 跳转钉钉登录页
     → 用户在钉钉扫码/登录授权
     → 钉钉回调 /dingtalk/callback（换钉钉 token + 取用户信息）
     → 302 重定向回 Quick（带 mcp authorization code）
     → Quick 调 /token（Basic 头带 client_id/secret + PKCE code_verifier）
     → 网关颁发 mcp access_token + refresh_token
     → Quick 用 access_token 调 /mcp/<分组>（initialize → tools/list → tools/call）
```

> 每个分组 connector 独立走一遍上述流程并各自授权一次。

## 五、验证清单

- [ ] Quick 连接器保存后能跳转钉钉登录页
- [ ] 钉钉授权后成功回到 Quick（无 invalid_redirect_uri）
- [ ] Quick 拿到 token（无 /token 报错）
- [ ] connector 创建成功（无 Creation failed —— 每组工具均 < 100）
- [ ] Quick 工具列表能看到带前缀的钉钉工具
- [ ] 实际调用一个工具成功（如 `contact__get_current_user_profile`）
- [ ] 危险操作分组的工具调用前，助手会提示确认
