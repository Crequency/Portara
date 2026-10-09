# Portara 镜像 —— 多阶段构建
#   build  阶段：装依赖、构建前端产物与后端 JS
#   runtime 阶段：只带运行所需内容，非 root 运行

FROM node:24-alpine AS build
WORKDIR /app
RUN npm i -g pnpm@11
COPY pnpm-workspace.yaml package.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN pnpm install --no-frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORTARA_PORT=52740 \
    PORTARA_HOST=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/package.json ./package.json

USER node
EXPOSE 52740

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:52740/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
