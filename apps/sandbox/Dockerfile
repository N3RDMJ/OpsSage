FROM node:20-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json ./
COPY apps/sandbox/package.json apps/sandbox/
RUN pnpm install --frozen-lockfile=false --filter @opssage/sandbox...

FROM deps AS build
COPY apps/sandbox apps/sandbox
RUN pnpm --filter @opssage/sandbox build \
 && pnpm --filter @opssage/sandbox --prod deploy /out

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates jq \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /work \
 && chown node:node /work
COPY --from=build /out /app
ENV NODE_ENV=production
ENV PORT=8081
ENV SANDBOX_WORK_DIR=/work
EXPOSE 8081
USER node
CMD ["node", "dist/index.js"]
