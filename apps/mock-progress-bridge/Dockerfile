FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/mock-progress-bridge/package.json apps/mock-progress-bridge/package.json
RUN pnpm install --frozen-lockfile
COPY apps/mock-progress-bridge apps/mock-progress-bridge
RUN pnpm --filter @mutsuki/mock-progress-bridge build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV MUTSUKI_BRIDGE_DATA=/data/events.jsonl
COPY --from=build /repo/apps/mock-progress-bridge/dist ./dist
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "dist/server.js"]
