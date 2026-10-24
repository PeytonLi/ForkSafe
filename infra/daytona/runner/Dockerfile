FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

ARG INSTALL_DROID_CLI=true
RUN if [ "$INSTALL_DROID_CLI" = "true" ]; then curl -fsSL https://app.factory.ai/cli | sh; fi

WORKDIR /workspace
RUN useradd --create-home --uid 10001 forksafe \
    && chown -R forksafe:forksafe /workspace
USER forksafe

CMD ["sleep", "infinity"]
