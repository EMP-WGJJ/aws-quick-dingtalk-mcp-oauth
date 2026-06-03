# ---------- 构建阶段 ----------
FROM public.ecr.aws/docker/library/node:22-alpine AS builder

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码并编译
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 仅保留生产依赖，缩小体积
RUN npm prune --omit=dev

# ---------- 运行阶段 ----------
FROM public.ecr.aws/docker/library/node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# 拷贝生产依赖与编译产物
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# 使用非 root 用户运行（node 镜像自带 node 用户）
USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
