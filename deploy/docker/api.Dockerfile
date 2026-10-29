# The platform API. Build with the repository root as context:
#   docker build -f deploy/docker/api.Dockerfile -t foundry-api .
FROM node:22.21.1-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/mcp ./apps/mcp
RUN pnpm install --frozen-lockfile --filter "@foundry/api..." \
 && pnpm --filter "@foundry/api..." build \
 && pnpm --filter @foundry/api deploy --prod --legacy /out

# distroless: no shell, no package manager, runs as an unprivileged user
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app/apps/api
# the same layout as the repository, so config/ and packages/sdk/ are where the code expects them
COPY --from=build /out ./
COPY packages/sdk /app/packages/sdk
COPY config /app/config
ENV NODE_ENV=production CONFIG_DIR=/app/config PORT=8080
EXPOSE 8080
USER nonroot
CMD ["dist/main.js"]
