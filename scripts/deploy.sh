#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# dingtalk-mcp-oauth-gateway — ECS Fargate + DynamoDB 部署脚本
#
# 功能：
# - 一键部署：建 ECR → build/push 镜像 → 部署 CloudFormation（ALB/Fargate/DynamoDB/KMS）
# - 幂等重跑：配置保存到 .deploy-config，再次执行可复用
# - 凭据安全：钉钉 AppSecret 存入 Secrets Manager，不落明文
# - 自动探测：可自动发现默认 VPC / 子网，减少手填
# - 多区域支持
#
# 用法：
#   ./scripts/deploy.sh [options]
#
# 选项：
#   --region REGION      AWS 区域（默认：.deploy-config 或 ap-southeast-1）
#   --image-tag TAG      镜像 tag（默认：时间戳）
#   --non-interactive    使用已保存配置，跳过交互（用于 CI/CD）
#   --skip-build         跳过镜像 build/push（仅更新基础设施）
#   -h, --help           显示帮助
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${PROJECT_ROOT}/.deploy-config"
TEMPLATE_FILE="${PROJECT_ROOT}/infra/cloudformation.yaml"

# ─── 默认值 ───────────────────────────────────────────────────────────
PROJECT_PREFIX="dingtalk-mcp-gateway"
STACK_NAME="${PROJECT_PREFIX}"
ECR_REPO_NAME="${PROJECT_PREFIX}-repo"
APP_SECRET_ID="${PROJECT_PREFIX}/dingtalk-app-secret"

# ─── 解析参数 ─────────────────────────────────────────────────────────
FORCE_REGION=""
IMAGE_TAG=""
NON_INTERACTIVE=false
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)          FORCE_REGION="$2"; shift 2 ;;
    --image-tag)       IMAGE_TAG="$2"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=true; shift ;;
    --skip-build)      SKIP_BUILD=true; shift ;;
    -h|--help)
      echo "用法: ./scripts/deploy.sh [--region REGION] [--image-tag TAG] [--non-interactive] [--skip-build]"
      exit 0
      ;;
    *) echo "未知选项: $1"; exit 1 ;;
  esac
done

# ─── 颜色与输出辅助 ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
err()  { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${CYAN}→ $1${NC}"; }

# ─── 配置持久化（幂等重跑） ───────────────────────────────────────────
REGION=""
ACCOUNT=""
APP_KEY=""
APP_SECRET=""
BASE_URL=""
VPC_ID=""
PUBLIC_SUBNETS=""
PRIVATE_SUBNETS=""
CERT_ARN=""
QUICK_CLIENT_ID=""
QUICK_REDIRECT_URI=""
DESIRED_COUNT=""

load_config() {
  if [[ -f "${CONFIG_FILE}" ]]; then
    # shellcheck source=/dev/null
    source "${CONFIG_FILE}"
    info "已加载保存的配置: .deploy-config"
  fi
}

save_config() {
  cat > "${CONFIG_FILE}" <<EOF
# dingtalk-mcp-oauth-gateway 部署配置（自动生成）
# 最近部署: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
DEPLOY_REGION="${REGION}"
DEPLOY_ACCOUNT="${ACCOUNT}"
APP_KEY="${APP_KEY}"
BASE_URL="${BASE_URL}"
VPC_ID="${VPC_ID}"
PUBLIC_SUBNETS="${PUBLIC_SUBNETS}"
PRIVATE_SUBNETS="${PRIVATE_SUBNETS}"
CERT_ARN="${CERT_ARN}"
QUICK_CLIENT_ID="${QUICK_CLIENT_ID}"
QUICK_REDIRECT_URI="${QUICK_REDIRECT_URI}"
DESIRED_COUNT="${DESIRED_COUNT}"
EOF
  info "配置已保存到 .deploy-config"
}

load_config

# 应用区域覆盖
[[ -n "${FORCE_REGION}" ]] && REGION="${FORCE_REGION}"
[[ -z "${REGION}" ]] && REGION="${DEPLOY_REGION:-ap-southeast-1}"
[[ -z "${IMAGE_TAG}" ]] && IMAGE_TAG="v$(date -u +%Y%m%d%H%M%S)"

# ═══════════════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  dingtalk-mcp-oauth-gateway — 部署 (ECS Fargate + DynamoDB)"
echo "  区域: ${REGION} | 镜像 tag: ${IMAGE_TAG}"
echo "═══════════════════════════════════════════════════════"
echo ""

# ─── 交互式输入辅助：复用已存值，回车保留 ─────────────────────────────
prompt_value() {
  # $1=变量名 $2=提示 $3=当前值 $4=默认值
  local var_name="$1" prompt="$2" current="$3" default="$4" input=""
  if [[ "${NON_INTERACTIVE}" == "true" ]]; then
    eval "${var_name}=\"${current:-$default}\""
    return
  fi
  if [[ -n "${current}" ]]; then
    read -rp "  ${prompt} [当前: ${current}]，回车保留: " input
    eval "${var_name}=\"${input:-$current}\""
  elif [[ -n "${default}" ]]; then
    read -rp "  ${prompt} [默认: ${default}]: " input
    eval "${var_name}=\"${input:-$default}\""
  else
    read -rp "  ${prompt}: " input
    eval "${var_name}=\"${input}\""
  fi
}

# ─── Step 1: 检查前置工具 ─────────────────────────────────────────────
info "Step 1: 检查前置工具"

command -v aws    >/dev/null || err "需要 aws CLI (https://aws.amazon.com/cli/)"
command -v docker >/dev/null || err "需要 docker 用于构建镜像"
command -v jq     >/dev/null || err "需要 jq (https://jqlang.github.io/jq/)"

docker info >/dev/null 2>&1 || err "Docker daemon 未运行，请先启动 Docker"

ok "前置工具就绪"

# ─── Step 2: 验证 AWS 凭证 ────────────────────────────────────────────
info "Step 2: 验证 AWS 凭证"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text --region "${REGION}" 2>/dev/null)" \
  || err "AWS 凭证未配置，请先运行 'aws configure' 或设置 AK/SK 环境变量"

ok "AWS 账号 ${ACCOUNT} @ ${REGION}"

# ─── Step 3: 收集部署参数 ─────────────────────────────────────────────
info "Step 3: 收集部署参数"
echo ""

# 钉钉 AppKey
prompt_value APP_KEY "钉钉 AppKey (Client ID)" "${APP_KEY}" ""
[[ -z "${APP_KEY}" ]] && err "钉钉 AppKey 必填"

# 钉钉 AppSecret（仅交互模式询问；为空表示复用 Secrets Manager 已有值）
if [[ "${NON_INTERACTIVE}" != "true" ]]; then
  read -rsp "  钉钉 AppSecret（回车跳过则复用云端已存值）: " APP_SECRET
  echo ""
fi

# 网关对外域名
prompt_value BASE_URL "网关对外 HTTPS 域名 (如 https://gateway.example.com)" "${BASE_URL}" ""
[[ "${BASE_URL}" =~ ^https:// ]] || err "BASE_URL 必须以 https:// 开头"

# ACM 证书 ARN
prompt_value CERT_ARN "ACM 证书 ARN（覆盖上述域名）" "${CERT_ARN}" ""
[[ -z "${CERT_ARN}" ]] && err "ACM 证书 ARN 必填（ALB HTTPS 监听器需要）"

# Quick 配置（有默认值）
prompt_value QUICK_CLIENT_ID "Amazon Quick client_id" "${QUICK_CLIENT_ID}" "amazon_quick_001"
prompt_value QUICK_REDIRECT_URI "Amazon Quick 回调地址" "${QUICK_REDIRECT_URI}" "https://quick.aws.com/sn/oauthcallback"
prompt_value DESIRED_COUNT "Fargate 任务数量" "${DESIRED_COUNT}" "2"

echo ""

# ─── Step 4: 探测/确认网络（VPC 与子网） ──────────────────────────────
info "Step 4: 确认 VPC 与子网"

if [[ -z "${VPC_ID}" ]]; then
  DEFAULT_VPC="$(aws ec2 describe-vpcs \
    --filters Name=is-default,Values=true \
    --query 'Vpcs[0].VpcId' --output text --region "${REGION}" 2>/dev/null || echo "None")"
  [[ "${DEFAULT_VPC}" != "None" ]] && VPC_ID="${DEFAULT_VPC}" && info "探测到默认 VPC: ${VPC_ID}"
fi
prompt_value VPC_ID "VPC ID" "${VPC_ID}" ""
[[ -z "${VPC_ID}" ]] && err "VPC ID 必填"

# 自动列出该 VPC 下的子网供参考
if [[ -z "${PUBLIC_SUBNETS}" || -z "${PRIVATE_SUBNETS}" ]]; then
  info "该 VPC 下的子网："
  aws ec2 describe-subnets \
    --filters Name=vpc-id,Values="${VPC_ID}" \
    --query 'Subnets[].{Subnet:SubnetId,AZ:AvailabilityZone,Public:MapPublicIpOnLaunch}' \
    --output table --region "${REGION}" 2>/dev/null || true
fi

prompt_value PUBLIC_SUBNETS "公有子网 ID（给 ALB，逗号分隔，至少 2 个跨 AZ）" "${PUBLIC_SUBNETS}" ""
[[ -z "${PUBLIC_SUBNETS}" ]] && err "公有子网必填"
prompt_value PRIVATE_SUBNETS "Fargate 子网 ID（逗号分隔，需可出公网访问钉钉 API）" "${PRIVATE_SUBNETS}" "${PUBLIC_SUBNETS}"

echo ""

# ─── Step 5: 存储钉钉 AppSecret 到 Secrets Manager ───────────────────
info "Step 5: 管理 Secrets Manager 中的 AppSecret"

if [[ -n "${APP_SECRET}" ]]; then
  if aws secretsmanager describe-secret --secret-id "${APP_SECRET_ID}" --region "${REGION}" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --secret-id "${APP_SECRET_ID}" \
      --secret-string "${APP_SECRET}" \
      --region "${REGION}" >/dev/null
    ok "已更新 AppSecret"
  else
    aws secretsmanager create-secret \
      --name "${APP_SECRET_ID}" \
      --secret-string "${APP_SECRET}" \
      --region "${REGION}" \
      --tags Key=project,Value="${PROJECT_PREFIX}" >/dev/null
    ok "已创建 AppSecret"
  fi
else
  aws secretsmanager describe-secret --secret-id "${APP_SECRET_ID}" --region "${REGION}" >/dev/null 2>&1 \
    || err "Secrets Manager 中无 AppSecret，且本次未输入。请重新运行并提供 AppSecret"
  info "复用 Secrets Manager 中已有的 AppSecret"
fi

APP_SECRET_ARN="$(aws secretsmanager describe-secret \
  --secret-id "${APP_SECRET_ID}" --region "${REGION}" \
  --query 'ARN' --output text)"
ok "AppSecret ARN: ${APP_SECRET_ARN}"

# ─── Step 6: 确保 ECR 仓库存在 ────────────────────────────────────────
info "Step 6: 确保 ECR 仓库存在"

ECR_URI="$(aws ecr describe-repositories \
  --repository-names "${ECR_REPO_NAME}" --region "${REGION}" \
  --query 'repositories[0].repositoryUri' --output text 2>/dev/null || echo "")"

if [[ -z "${ECR_URI}" ]]; then
  ECR_URI="$(aws ecr create-repository \
    --repository-name "${ECR_REPO_NAME}" \
    --image-scanning-configuration scanOnPush=true \
    --region "${REGION}" \
    --tags Key=project,Value="${PROJECT_PREFIX}" \
    --query 'repository.repositoryUri' --output text)"
  ok "已创建 ECR 仓库: ${ECR_URI}"
else
  ok "ECR 仓库已存在: ${ECR_URI}"
fi

IMAGE_URI="${ECR_URI}:${IMAGE_TAG}"

# ─── Step 7: 构建并推送镜像 ───────────────────────────────────────────
if [[ "${SKIP_BUILD}" == "true" ]]; then
  warn "Step 7: 跳过镜像构建（--skip-build）"
  # 复用 latest
  IMAGE_URI="${ECR_URI}:latest"
  info "将使用镜像: ${IMAGE_URI}"
else
  info "Step 7: 构建并推送镜像"

  aws ecr get-login-password --region "${REGION}" \
    | docker login --username AWS --password-stdin "${ECR_URI%/*}" >/dev/null 2>&1 \
    || err "ECR 登录失败"
  ok "已登录 ECR"

  # Fargate 默认 X86_64 架构
  info "构建镜像（linux/amd64）..."
  docker build --platform linux/amd64 -t "${ECR_REPO_NAME}:${IMAGE_TAG}" "${PROJECT_ROOT}" \
    || err "镜像构建失败"

  docker tag "${ECR_REPO_NAME}:${IMAGE_TAG}" "${IMAGE_URI}"
  docker tag "${ECR_REPO_NAME}:${IMAGE_TAG}" "${ECR_URI}:latest"

  info "推送镜像到 ECR..."
  docker push "${IMAGE_URI}" >/dev/null || err "镜像推送失败"
  docker push "${ECR_URI}:latest" >/dev/null || true
  ok "镜像已推送: ${IMAGE_URI}"
fi

# ─── Step 8: 部署 CloudFormation ──────────────────────────────────────
info "Step 8: 部署 CloudFormation Stack"
echo ""

aws cloudformation deploy \
  --template-file "${TEMPLATE_FILE}" \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    VpcId="${VPC_ID}" \
    PublicSubnetIds="${PUBLIC_SUBNETS}" \
    PrivateSubnetIds="${PRIVATE_SUBNETS}" \
    CertificateArn="${CERT_ARN}" \
    ImageUri="${IMAGE_URI}" \
    BaseUrl="${BASE_URL}" \
    DingtalkAppKey="${APP_KEY}" \
    DingtalkAppSecretArn="${APP_SECRET_ARN}" \
    QuickClientId="${QUICK_CLIENT_ID}" \
    QuickRedirectUri="${QUICK_REDIRECT_URI}" \
    DesiredCount="${DESIRED_COUNT}" \
  || err "CloudFormation 部署失败，请查看控制台事件日志"

ok "CloudFormation 部署完成"

# ─── Step 9: 读取输出 ─────────────────────────────────────────────────
info "Step 9: 读取 Stack 输出"

get_output() {
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text 2>/dev/null || echo ""
}

ALB_DNS="$(get_output AlbDnsName)"
TABLE_NAME="$(get_output TableName)"
KMS_KEY_ID="$(get_output KmsKeyId)"

# ─── 保存配置 ─────────────────────────────────────────────────────────
save_config

# ─── 最终输出 ─────────────────────────────────────────────────────────
GATEWAY_DOMAIN="${BASE_URL#https://}"

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "  ${GREEN}部署完成！${NC}"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  区域:        ${REGION}"
echo "  账号:        ${ACCOUNT}"
echo "  镜像:        ${IMAGE_URI}"
echo "  DynamoDB 表: ${TABLE_NAME}"
echo "  KMS Key:     ${KMS_KEY_ID}"
echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │ DNS 配置（必做）                                    │"
echo "  ├─────────────────────────────────────────────────────┤"
echo "  │ 将域名 ${GATEWAY_DOMAIN}"
echo "  │ 通过 CNAME 指向 ALB:"
echo "  │   ${ALB_DNS}"
echo "  └─────────────────────────────────────────────────────┘"
echo ""
echo "  待 DNS 生效后，验证健康检查："
echo "    curl ${BASE_URL}/health"
echo ""
echo "  钉钉开放平台 — 配置重定向 URL:"
echo "    ${BASE_URL}/dingtalk/callback"
echo ""
echo "  Amazon Quick — 配置:"
echo "    Authorization URL: ${BASE_URL}/authorize"
echo "    Token URL:         ${BASE_URL}/token"
echo "    Client ID:         ${QUICK_CLIENT_ID}"
echo ""
echo "  幂等重新部署:        ./scripts/deploy.sh"
echo "  仅更新基础设施:      ./scripts/deploy.sh --skip-build"
echo "  CI/CD 非交互:        ./scripts/deploy.sh --non-interactive"
echo ""
