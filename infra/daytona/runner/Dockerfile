FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
RUN useradd --create-home --uid 10001 forksafe \
    && chown -R forksafe:forksafe /workspace
USER forksafe
ENV HOME=/home/forksafe
# Install the Factory droid CLI as the runtime user: installing it as root leaves it under
# /root/.local/bin, unreadable by forksafe ("Failed to start Droid: executable not found").
ARG INSTALL_DROID_CLI=true
RUN if [ "$INSTALL_DROID_CLI" = "true" ]; then curl -fsSL https://app.factory.ai/cli | sh; fi
ENV PATH="/home/forksafe/.local/bin:${PATH}"

CMD ["sleep", "infinity"]
