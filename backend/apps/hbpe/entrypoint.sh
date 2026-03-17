#!/bin/bash
set -e

echo "Starting CI-HBPE services..."

# Start the FastAPI histogram API in the background
echo "Starting HBPE API on port 8002..."
uvicorn ci.api:app --host 0.0.0.0 --port 8002 &
API_PID=$!

# Give the API a moment to start
sleep 2

# Start the Temporal worker in the background
echo "Starting HBPE Temporal worker..."
python -m ci.worker &
WORKER_PID=$!

shutdown() {
    echo "Shutting down HBPE services..."
    kill $API_PID $WORKER_PID 2>/dev/null || true
    wait $API_PID $WORKER_PID 2>/dev/null || true
    exit 0
}

trap shutdown SIGTERM SIGINT

wait $API_PID $WORKER_PID
