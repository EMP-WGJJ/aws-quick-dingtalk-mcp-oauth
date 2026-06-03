# 部署指南：ECS Fargate + DynamoDB

本文档说明如何将 DingTalk MCP OAuth Gateway 部署到 AWS ECS Fargate，
使用 DynamoDB 作为持久化存储，KMS 加密敏感字段。

## 架构

```
Amazon Quick / 钉钉
      │ HTTPS（固定域名）
      ▼
   ALB (idle_timeout=300s, 支持 SSE)
      │
      ▼
  ECS Fargate (>=2 实例)  ← Express 应用
      │
      ├──► DynamoDB（token 映射持久化，TTL 自动清理）
      └──► KMS（钉钉 token 加解密）
```

## 前置条件

- 一个 VPC，含至少 2 个公有子网（给 ALB）和可出公网的子网（给 Fargate，访问钉钉 API）
- 一个 ACM 证书（覆盖你的网关域名）
- 已安装：`aws` CLI、`docker`、`jq`，且 Docker daemon 在运行
- 已配置 AWS 凭证（`aws configure` 或 AK/SK 环境变量）

---

## 方式一：一键部署脚本（推荐）

`scripts/deploy.sh` 把建 ECR、构建推送镜像、部署 CloudFormation 全部串起来，
首次交互填参数，之后保存到 `.deploy-config` 可幂等重跑。

```bash
# 首次部署（交互式）
./scripts/deploy.sh

# 后续更新代码后重新部署（复用已保存配置）
./scripts/deploy.sh

# 仅更新基础设施、不重新构建镜像
./scripts/deploy.sh --skip-build

# 指定区域
./scripts/deploy.sh --region ap-southeast-1
```

脚本会依次：检查工具 → 验证凭证 → 收集参数 → 存 AppSecret 到 Secrets Manager
→ 建 ECR → build/push 镜像 → 部署 CloudFormation → 打印 DNS / 钉钉 / Quick 配置指引。

部署完成后按输出提示完成下方「上线切换与验证」即可。

---

## 方式二：手动分步部署

如果想了解底层步骤或自行控制流程，可手动执行。

### 步骤一：建 ECR 仓库

```bash
aws ecr create-repository --repository-name dingtalk-mcp-gateway-repo
```

记录返回的 `repositoryUri`。

### 步骤二：构建并推送镜像

```bash
# 登录 ECR（替换 region 和 account-id）
aws ecr get-login-password --region ap-southeast-1 \
  | docker login --username AWS --password-stdin <account-id>.dkr.ecr.ap-southeast-1.amazonaws.com

# 构建镜像（Fargate 默认 X86_64）
docker build --platform linux/amd64 -t dingtalk-mcp-gateway .

# 打 tag 并推送
docker tag dingtalk-mcp-gateway:latest <repositoryUri>:v1
docker push <repositoryUri>:v1
```

### 步骤三：存储钉钉 AppSecret

```bash
aws secretsmanager create-secret \
  --name dingtalk-mcp-gateway/dingtalk-app-secret \
  --secret-string "<你的钉钉 AppSecret>" \
  --region ap-southeast-1
```

记录返回的 secret `ARN`。

### 步骤四：部署 CloudFormation

```bash
aws cloudformation deploy \
  --template-file infra/cloudformation.yaml \
  --stack-name dingtalk-mcp-gateway \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId=vpc-xxxx \
    PublicSubnetIds=subnet-aaa,subnet-bbb \
    PrivateSubnetIds=subnet-ccc,subnet-ddd \
    CertificateArn=arn:aws:acm:ap-southeast-1:<account-id>:certificate/xxxx \
    ImageUri=<repositoryUri>:v1 \
    BaseUrl=https://gateway.example.com \
    DingtalkAppKey=dingxxxxxx \
    DingtalkAppSecretArn=arn:aws:secretsmanager:ap-southeast-1:<account-id>:secret:dingtalk-mcp-gateway/dingtalk-app-secret-xxxx
```

部署完成后，从 Outputs 取 `AlbDnsName`。

---

## 上线切换与验证

> 方式一、方式二部署完成后都需要完成以下配置。

### 1. 配置 DNS

将网关域名（如 `gateway.example.com`）CNAME 指向 Stack 输出的 `AlbDnsName`。

### 2. 切换钉钉与 Quick 配置

- **钉钉开放后台**：将重定向 URL 改为 `https://gateway.example.com/dingtalk/callback`
- **Amazon Quick**：
  - Authorization URL → `https://gateway.example.com/authorize`
  - Token URL → `https://gateway.example.com/token`

### 3. 验证清单

- [ ] `curl https://gateway.example.com/health` 返回 `{"status":"ok"}`
- [ ] 完整走一遍 OAuth 授权流（确认多实例下 session/code 跨请求正常）
- [ ] token 刷新（refresh_token）正常
- [ ] SSE 工具调用不被超时切断
- [ ] 重启一个 task（或滚动部署）后，已授权用户的 token 不丢失

---

## 更新部署

一键脚本方式：

```bash
./scripts/deploy.sh           # 重新构建镜像并滚动更新
```

手动方式：

```bash
docker build --platform linux/amd64 -t dingtalk-mcp-gateway . && \
docker tag dingtalk-mcp-gateway:latest <repositoryUri>:v2 && \
docker push <repositoryUri>:v2

aws cloudformation deploy \
  --template-file infra/cloudformation.yaml \
  --stack-name dingtalk-mcp-gateway \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ImageUri=<repositoryUri>:v2
  # ... 其余参数保持不变
```

ECS 会滚动更新（先起新任务、健康后再停旧任务），配合应用的优雅停机实现零中断。

---

## 本地用 DynamoDB 调试（可选）

```bash
# 启动 DynamoDB Local
docker run -d --name ddb-local -p 8000:8000 amazon/dynamodb-local

# .env 配置
# STORAGE_DRIVER=dynamo
# DYNAMO_ENDPOINT=http://localhost:8000
# KMS_KEY_ID=（留空则不加密）

# 跑存储层集成测试（自动建表/跑用例/删表）
npm run test:dynamo
```
