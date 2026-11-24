# The swarm's worker pods: a Rivet runner that hosts the worker and pool actors.
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/swarm/package.json packages/swarm/
RUN pnpm install --frozen-lockfile --filter @swarm/worker...
COPY packages/swarm packages/swarm
WORKDIR /app/packages/swarm
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "src/server.ts"]
