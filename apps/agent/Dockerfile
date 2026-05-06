FROM node:20-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# --- deps ---
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json ./
COPY apps/agent/package.json apps/agent/
COPY packages/config-schema/package.json packages/config-schema/
COPY packages/skills/package.json packages/skills/
COPY packages/tools/package.json packages/tools/
RUN pnpm install --frozen-lockfile=false

# --- build ---
FROM deps AS build
COPY packages packages
COPY apps/agent apps/agent
RUN pnpm --filter @opssage/config-schema build \
 && pnpm --filter @opssage/tools build \
 && pnpm --filter @opssage/skills build \
 && pnpm --filter @opssage/agent build
# Drop dev deps for runtime image.
RUN pnpm --filter @opssage/agent... --prod deploy /out

# --- runtime ---
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /app
COPY --from=build /repo/packages/skills/skills /app/node_modules/@opssage/skills/skills
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
