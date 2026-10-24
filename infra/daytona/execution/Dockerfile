FROM python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python -m pip install --no-cache-dir mujoco==3.17.0 numpy==2.2.6

WORKDIR /workspace
RUN useradd --create-home --uid 10001 forksafe \
    && chown -R forksafe:forksafe /workspace
USER forksafe

CMD ["sleep", "infinity"]
