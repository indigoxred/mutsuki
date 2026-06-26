FROM node:24-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/kavita-mal-bridge/package.json apps/kavita-mal-bridge/package.json
RUN corepack enable && pnpm install --frozen-lockfile
COPY apps/kavita-mal-bridge apps/kavita-mal-bridge
RUN pnpm --filter @mutsuki/kavita-mal-bridge build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=6768
COPY --from=build /app/apps/kavita-mal-bridge/dist ./dist
COPY apps/kavita-mal-bridge/package.json ./package.json
EXPOSE 6768
CMD ["node", "dist/server.js"]
