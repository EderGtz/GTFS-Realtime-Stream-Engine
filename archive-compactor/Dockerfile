FROM python:3.12-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src/ ./src/
RUN uv sync --frozen --no-dev

# Default to the daily loop; `--once` is passed via a compose command override or
# `docker compose run archive-compactor --once`.
CMD ["uv", "run", "--no-dev", "python3", "-m", "src.main"]
