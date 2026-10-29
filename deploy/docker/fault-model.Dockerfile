# The fault model service. The model file comes from the training job (a mounted share).
#   docker build -f deploy/docker/fault-model.Dockerfile -t foundry-fault-model .
FROM python:3.13.9-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.9.7 /uv /usr/local/bin/uv
WORKDIR /app
COPY services/fault-model/pyproject.toml services/fault-model/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY services/fault-model/fault_model ./fault_model
RUN useradd --uid 10001 --no-create-home model
USER 10001
ENV MODEL_FILE=/model/fault-model.joblib PATH=/app/.venv/bin:$PATH
EXPOSE 8090
CMD ["uvicorn", "fault_model.service:app", "--host", "0.0.0.0", "--port", "8090"]
