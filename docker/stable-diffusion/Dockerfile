FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY index.js ./

# Expose port
EXPOSE 7860

# Run the application
CMD ["node", "index.js"]