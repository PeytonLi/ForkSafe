FROM node:22-slim AS build

WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.34.8 --activate && pnpm --version
COPY . .
RUN CI=true pnpm install --frozen-lockfile --filter '@forksafe/runner...' --filter '@forksafe/runner-pool'
RUN pnpm --filter @forksafe/runner build:bundle \
    && pnpm --filter @forksafe/runner-pool build

FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && useradd --create-home --uid 10001 forksafe \
    && rm -rf /var/lib/apt/lists/*
USER forksafe
ENV HOME=/home/forksafe
ENV PATH="/home/forksafe/.local/bin:${PATH}"
RUN curl -fsSL https://app.factory.ai/cli | sh && droid --version

WORKDIR /app
COPY --from=build --chown=forksafe:forksafe /repo/apps/runner-pool/dist ./apps/runner-pool/dist
COPY --from=build --chown=forksafe:forksafe /repo/apps/runner/dist/runner.mjs ./apps/runner/dist/runner.mjs
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/runner-pool/dist/main.js"]
