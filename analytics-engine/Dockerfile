FROM python:3.12-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy dependency files first (layer caching).
# --no-install-project installs third-party deps without trying to build
# the analytics-engine package itself (which needs the source code).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Copy source and install the project itself
COPY src/ ./src/
COPY README.md ./
RUN uv sync --frozen --no-dev

RUN mkdir -p data/MBTA_GTFS

CMD ["uv", "run", "python3", "-m", "src.main"]