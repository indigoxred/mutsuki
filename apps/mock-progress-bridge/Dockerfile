FROM node:24-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npx tsc --project tsconfig.json

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV MUTSUKI_BRIDGE_DATA=/data/events.jsonl
COPY --from=build /app/dist ./dist
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "dist/server.js"]
