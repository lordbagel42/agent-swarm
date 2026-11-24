# The swarm's worker pods: a Rivet runner that hosts the worker and pool actors.
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/swarm/package.json packages/swarm/
# Production deps only. Pods connect to the cluster's engine (RIVET_ENDPOINT), so the local engine and
# Rivet Services binaries (~200 MB) never run here; dropping them keeps pulls small on the Pi nodes.
RUN pnpm install --frozen-lockfile --prod --filter @swarm/worker... \
	&& rm -rf node_modules/.pnpm/@rivetkit+engine-cli-linux-* node_modules/.pnpm/@rivet-dev+services-linux-* \
	&& rm -rf /root/.local/share/pnpm /root/.cache
COPY packages/swarm packages/swarm
WORKDIR /app/packages/swarm
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "src/server.ts"]
