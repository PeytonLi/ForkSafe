FROM python:3.12-slim-bookworm

RUN python -m pip install --no-cache-dir mujoco==3.17.0 numpy==2.5.4 pydantic==2.14.1

COPY services /opt/forksafe/services
COPY assets /opt/forksafe/assets
COPY evaluation /opt/forksafe/evaluation
COPY controllers /opt/forksafe/controllers

WORKDIR /workspace
RUN python -m compileall -q /opt/forksafe/services \
    && useradd --create-home --uid 10001 forksafe \
    && mkdir -p /workspace \
    && chown -R root:root /opt/forksafe \
    && chmod -R a-w,a+rX /opt/forksafe \
    && chown forksafe:forksafe /workspace

ENV PYTHONPATH=/opt/forksafe/services \
    PYTHONDONTWRITEBYTECODE=1 \
    OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1

USER forksafe

CMD ["sleep", "infinity"]
