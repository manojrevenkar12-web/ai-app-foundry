# The console: static files behind nginx, with the API on the same origin.
#   docker build -f deploy/docker/console.Dockerfile -t foundry-console .
FROM node:22.21.1-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/console ./apps/console
RUN pnpm install --frozen-lockfile --filter "@foundry/console..." \
 && pnpm --filter "@foundry/console..." build

FROM nginxinc/nginx-unprivileged:1.29.3-alpine
COPY deploy/docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/apps/console/dist /usr/share/nginx/html
# API_UPSTREAM is the API's internal address, e.g. http://foundry-api (Container Apps internal ingress)
ENV API_UPSTREAM=http://api:8080
EXPOSE 8080
