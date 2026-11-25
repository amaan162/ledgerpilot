FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Install backend dependencies first for layer caching
COPY backend/pyproject.toml backend/uv.lock ./backend/
WORKDIR /app/backend
RUN uv sync --frozen --no-dev

# Copy backend code, eval scorecards, MCP server, and n8n blueprints
WORKDIR /app
COPY backend ./backend
COPY evals/results ./evals/results
COPY mcp_server ./mcp_server
COPY n8n ./n8n

RUN mkdir -p /app/uploads /app/settlements

WORKDIR /app/backend
EXPOSE 8000

CMD ["sh", "-c", "uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
