FROM python:3.12-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src/ ./src/
RUN uv sync --frozen --no-dev
ENV UV_CACHE_DIR=/tmp/uv-cache

CMD ["uv", "run", "--no-dev", "--no-sync", "python3", "-m", "src.main"]
