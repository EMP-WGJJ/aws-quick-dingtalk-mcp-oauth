#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# dingtalk-mcp-oauth-gateway — 一键发版脚本
#
# 功能：构建新镜像 → 推送 ECR → 更新 CloudFormation（滚动更新）→ 等待稳定 → 健康检查
# 适用于代码改动后的快速发版。基础设施参数从 .deploy-config 读取。
#
# 用法：
#   ./scripts/redeploy.sh                 # 自动用时间戳作为镜像 tag
#   ./scripts/redeploy.sh --tag v4        # 指定镜像 tag
#   ./scripts/redeploy.sh --skip-build    # 不重新构建，仅用 latest 重新滚动部署
#   ./scripts/redeploy.sh --no-wait       # 不等待服务稳定，触发更新后即返回
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${PROJECT_ROOT}/.deploy-config"
TEMPLATE_FILE="${PROJECT_ROOT}/infra/cloudformation.yaml"

# ─── 颜色与输出 ───────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
err()  { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${CYAN}→ $1${NC}"; }

# ─── 参数解析 ─────────────────────────────────────────────────────────
IMAGE_TAG=""
SKIP_BUILD=false
WAIT_STABLE=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)        IMAGE_TAG="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --no-wait)    WAIT_STABLE=false; shift ;;
    -h|--help)
      echo "用法: ./scripts/redeploy.sh [--tag TAG] [--skip-build] [--no-wait]"
      exit 0 ;;
    *) err "未知选项: $1" ;;
  esac
done

# ─── 加载配置 ─────────────────────────────────────────────────────────
[[ -f "${CONFIG_FILE}" ]] || err "未找到 .deploy-config，请先用 scripts/deploy.sh 完成首次部署"
# shellcheck source=/dev/null
source "${CONFIG_FILE}"
info "已加载部署配置（stack=${STACK_NAME}, region=${DEPLOY_REGION}）"

[[ -z "${IMAGE_TAG}" ]] && IMAGE_TAG="v$(date -u +%Y%m%d%H%M%S)"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  一键发版: ${STACK_NAME}"
echo "  区域: ${DEPLOY_REGION} | 新镜像 tag: ${IMAGE_TAG}"
echo "═══════════════════════════════════════════════════════"
echo ""

# ─── Step 1: 前置检查 ─────────────────────────────────────────────────
info "Step 1: 检查前置工具与凭证"
command -v aws    >/dev/null || err "需要 aws CLI"
command -v docker >/dev/null || err "需要 docker"
docker info >/dev/null 2>&1 || err "Docker daemon 未运行"
aws sts get-caller-identity --region "${DEPLOY_REGION}" >/dev/null 2>&1 || err "AWS 凭证不可用"
ok "前置检查通过"

# ─── Step 2: 构建并推送镜像 ───────────────────────────────────────────
if [[ "${SKIP_BUILD}" == "true" ]]; then
  IMAGE_URI="${ECR_URI}:latest"
  warn "Step 2: 跳过构建，复用 ${IMAGE_URI}"
else
  info "Step 2: 构建并推送镜像"
  IMAGE_URI="${ECR_URI}:${IMAGE_TAG}"

  aws ecr get-login-password --region "${DEPLOY_REGION}" \
    | docker login --username AWS --password-stdin "${ECR_URI%/*}" >/dev/null 2>&1 \
    || err "ECR 登录失败"

  docker build --platform linux/amd64 \
    -t "${IMAGE_URI}" -t "${ECR_URI}:latest" "${PROJECT_ROOT}" \
    || err "镜像构建失败"

  docker push "${IMAGE_URI}" >/dev/null || err "镜像推送失败"
  docker push "${ECR_URI}:latest" >/dev/null || true
  ok "镜像已推送: ${IMAGE_URI}"
fi

# ─── Step 3: 更新 CloudFormation（滚动更新） ──────────────────────────
info "Step 3: 更新 CloudFormation（滚动更新 ECS 服务）"
echo ""

aws cloudformation deploy \
  --template-file "${TEMPLATE_FILE}" \
  --stack-name "${STACK_NAME}" \
  --region "${DEPLOY_REGION}" \
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
    ContainerPort="${CONTAINER_PORT}" \
  || err "CloudFormation 更新失败，请查看控制台事件日志"

ok "CloudFormation 更新已提交"

# 若镜像 tag 变化未被 CFN 检测为差异（极少数情况），强制刷新服务
if [[ "${SKIP_BUILD}" == "true" ]]; then
  info "强制刷新 ECS 服务以拉取 latest..."
  aws ecs update-service \
    --cluster "${CLUSTER_NAME}" --service "${SERVICE_NAME}" \
    --force-new-deployment --region "${DEPLOY_REGION}" >/dev/null \
    || warn "force-new-deployment 失败（可忽略，若上面 CFN 已更新镜像）"
fi

# ─── Step 4: 等待服务稳定 ─────────────────────────────────────────────
if [[ "${WAIT_STABLE}" == "true" ]]; then
  info "Step 4: 等待 ECS 服务稳定（滚动更新完成）..."
  aws ecs wait services-stable \
    --cluster "${CLUSTER_NAME}" --services "${SERVICE_NAME}" \
    --region "${DEPLOY_REGION}" \
    || err "服务未在预期时间内稳定，请检查 ECS 控制台与 CloudWatch 日志"
  ok "服务已稳定"
else
  warn "Step 4: 跳过等待（--no-wait），滚动更新在后台进行"
fi

# ─── Step 5: 健康检查 ─────────────────────────────────────────────────
info "Step 5: 健康检查"
HEALTH_URL="${BASE_URL}/health"
if curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
  ok "健康检查通过: ${HEALTH_URL}"
else
  warn "健康检查未通过（可能 DNS/回源延迟），请稍后手动验证: ${HEALTH_URL}"
fi

# ─── 完成 ─────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "  ${GREEN}发版完成！${NC}"
echo "═══════════════════════════════════════════════════════"
echo "  镜像:    ${IMAGE_URI}"
echo "  域名:    ${BASE_URL}"
echo "  健康检查: curl ${BASE_URL}/health"
echo ""
