FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install npm dependencies (canvas may fail but we'll handle that)
RUN npm ci --only=production || npm install --only=production || true

# Copy application code
COPY . .

# Make startup script executable
RUN chmod +x start.sh

# Create directories
RUN mkdir -p /app/models /app/outputs

# Expose port
EXPOSE 7860

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:7860/health || exit 1

# Start the service
CMD ["./start.sh"]