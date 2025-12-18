FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN pip install --no-cache-dir uv

# Copy dependency files first for better caching
COPY pyproject.toml uv.lock ./

# Install dependencies using uv (without --frozen to handle lock file updates)
RUN uv sync --no-dev

# Copy application code
COPY src/ ./src/
COPY entrypoint.sh ./

# Make entrypoint executable
RUN chmod +x entrypoint.sh

# Run as non-root user
RUN useradd -m -u 1000 memorizer && chown -R memorizer:memorizer /app
USER memorizer

# Expose API port
EXPOSE 8001

CMD ["./entrypoint.sh"]
