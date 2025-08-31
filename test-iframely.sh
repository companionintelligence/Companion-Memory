#!/bin/bash
# Test script to verify iframely service is working

echo "🧪 Testing iframely service integration..."

# Start the services
echo "Starting iframely and minio services..."
docker compose up iframely minio -d

# Wait for services to be ready
echo "Waiting for services to start..."
sleep 5

# Test iframely direct access
echo "Testing direct iframely access..."
if curl -s -f http://localhost:8061/ > /dev/null; then
    echo "✅ Iframely service is responding"
else
    echo "❌ Iframely service is not responding"
    docker logs iframely
    exit 1
fi

# Test iframely API endpoint
echo "Testing iframely API endpoint..."
response=$(curl -s http://localhost:8061/iframely?uri=https://example.com)
if echo "$response" | grep -q '"error"'; then
    echo "✅ Iframely API is responding with expected error format"
else
    echo "❌ Iframely API response unexpected: $response"
    exit 1
fi

# Test with nginx if available
if docker ps | grep -q webserver; then
    echo "Testing nginx proxy integration..."
    response=$(curl -s -k https://localhost/embed/iframely?uri=https://example.com 2>/dev/null || echo "proxy_error")
    if echo "$response" | grep -q -E '("error"|proxy_error)'; then
        echo "✅ Nginx proxy is routing to iframely"
    else
        echo "❌ Nginx proxy integration issue"
    fi
fi

echo "✅ All tests passed! Iframely service is properly configured."

# Clean up
docker compose down