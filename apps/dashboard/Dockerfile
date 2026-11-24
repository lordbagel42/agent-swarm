# The swarm dashboard. Build from the repository root: docker build -f apps/dashboard/Dockerfile .
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter @swarm/dashboard...
COPY apps/dashboard apps/dashboard
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @swarm/dashboard build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
