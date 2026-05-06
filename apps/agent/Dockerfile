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
COPY packages/tools/package.json packages/tools/
RUN pnpm install --frozen-lockfile=false

# --- build ---
FROM deps AS build
COPY packages packages
COPY apps/agent apps/agent
RUN pnpm --filter @opssage/config-schema build \
 && pnpm --filter @opssage/tools build \
 && pnpm --filter @opssage/agent build
RUN pnpm --filter @opssage/agent... --prod deploy /out

# --- runtime ---
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# CLIs the agent's flue commands shell out to.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      jq \
      ripgrep \
      ca-certificates \
      gnupg \
 # gh CLI
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# datadog-ci is distributed as a single Node binary via npm.
RUN npm install -g @datadog/datadog-ci@^2

COPY --from=build /out /app
# Skill markdown lives at /app/.agents/skills/ — flue auto-discovers it.
COPY apps/agent/.agents /app/.agents
COPY apps/agent/config /app/config
COPY apps/agent/fixtures /app/fixtures

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
