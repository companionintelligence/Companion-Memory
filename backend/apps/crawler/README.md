# Crawl4AI Service

A Docker container service that provides web crawling capabilities using crawl4ai, with FastAPI endpoints for extracting markdown content from websites.

## Features

- **Single Page Crawling**: Extract markdown content from individual web pages
- **Deep Crawling**: Crawl multiple pages with BFS/DFS strategies
- **LLM Extraction**: Use AI to extract specific information from pages
- **Link & Media Extraction**: Extract links and media files from crawled pages
- **Custom Headers**: Support for custom user agents and headers
- **Flexible Output**: Get markdown, HTML, or structured data

## Quick Start

### Build and Run the Container

```bash
# Build the Docker image
docker build -t crawl4ai-service .

# Run the container
docker run -p 9003:9003 crawl4ai-service
```

### Test the Service

```bash
# Run the test script
python test_crawler.py
```

## API Endpoints

### 1. Health Check
```bash
GET /health
```

Returns the service status and availability.

### 2. Service Info
```bash
GET /
```

Returns service information and available endpoints.

### 3. Simple Crawl
```bash
POST /crawl/simple?url=https://example.com&extract_query=Extract all product prices
```

Quick crawl with minimal parameters.

**Parameters:**
- `url`: URL to crawl (required)
- `extract_query`: Optional LLM extraction query

### 4. Advanced Crawl
```bash
POST /crawl
```

Full-featured crawling with all options.

**Request Body:**
```json
{
  "url": "https://example.com",
  "max_pages": 5,
  "deep_crawl": true,
  "crawl_strategy": "bfs",
  "wait_for": ".content",
  "delay_between_requests": 1.0,
  "user_agent": "Custom Bot 1.0",
  "headers": {
    "Authorization": "Bearer token"
  },
  "extract_links": true,
  "extract_media": false,
  "word_count_threshold": 10,
  "extraction_strategy": "llm",
  "extraction_query": "Extract all product information"
}
```

**Parameters:**
- `url`: URL to crawl (required)
- `max_pages`: Maximum pages to crawl (default: 1)
- `deep_crawl`: Enable deep crawling (default: false)
- `crawl_strategy`: "bfs" or "dfs" (default: "bfs")
- `wait_for`: CSS selector to wait for before extracting
- `delay_between_requests`: Delay between requests in seconds (default: 1.0)
- `user_agent`: Custom user agent string
- `headers`: Custom HTTP headers
- `extract_links`: Extract links from pages (default: true)
- `extract_media`: Extract media files (default: false)
- `word_count_threshold`: Minimum word count for content (default: 10)
- `extraction_strategy`: "llm" for AI extraction
- `extraction_query`: Query for LLM extraction

## Response Format

```json
{
  "success": true,
  "url": "https://example.com",
  "markdown": "# Page Title\n\nContent...",
  "html": "<html>...</html>",
  "links": ["https://example.com/page1", "https://example.com/page2"],
  "media": [
    {
      "type": "image",
      "url": "https://example.com/image.jpg",
      "alt": "Description"
    }
  ],
  "metadata": {
    "title": "Page Title",
    "description": "Page description",
    "word_count": 150,
    "crawl_timestamp": "2024-01-01T12:00:00Z"
  },
  "pages_crawled": 1
}
```

## Usage Examples

### Basic Markdown Extraction
```bash
curl -X POST "http://localhost:9003/crawl/simple?url=https://news.ycombinator.com"
```

### Deep Crawl with Link Extraction
```bash
curl -X POST "http://localhost:9003/crawl" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://docs.python.org",
    "max_pages": 3,
    "deep_crawl": true,
    "extract_links": true,
    "crawl_strategy": "bfs"
  }'
```

### LLM-based Content Extraction
```bash
curl -X POST "http://localhost:9003/crawl" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/products",
    "extraction_strategy": "llm",
    "extraction_query": "Extract all product names, prices, and descriptions"
  }'
```

### Custom Headers and User Agent
```bash
curl -X POST "http://localhost:9003/crawl" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.example.com/data",
    "user_agent": "MyBot/1.0",
    "headers": {
      "Authorization": "Bearer your-token",
      "X-Custom-Header": "value"
    }
  }'
```

## Configuration

The service runs on port 9003 by default. You can modify the port in the `crawler_service.py` file:

```python
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=9003)
```

## Dependencies

- **crawl4ai**: Web crawling library
- **FastAPI**: Web framework
- **Playwright**: Browser automation
- **Pydantic**: Data validation
- **Uvicorn**: ASGI server

## Troubleshooting

### Common Issues

1. **Browser Installation**: The Dockerfile automatically installs Playwright browsers, but if you encounter issues, you can manually run:
   ```bash
   playwright install --with-deps chromium
   ```

2. **Memory Issues**: For large crawls, you may need to increase Docker memory limits:
   ```bash
   docker run -m 2g -p 9003:9003 crawl4ai-service
   ```

3. **Network Issues**: If crawling fails, check if the target website blocks automated requests. Try using custom user agents or headers.

### Logs

Check the container logs for debugging:
```bash
docker logs <container_id>
```

## Development

To run the service locally for development:

```bash
# Install dependencies
pip install -r requirements.txt

# Install playwright browsers
playwright install --with-deps chromium

# Run crawl4ai setup
crawl4ai-setup

# Run the service
python crawler_service.py
```

## License

This service is part of the CI-Server project.
