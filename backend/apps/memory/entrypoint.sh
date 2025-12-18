#!/bin/bash
# Entrypoint script to run both the scheduler and the API server

set -e

echo "Starting CI-Memory services..."

# Activate the virtual environment
source .venv/bin/activate

# Start the FastAPI server in the background
echo "Starting FastAPI API server on port 8001..."
uvicorn src.api:app --host 0.0.0.0 --port 8001 &
API_PID=$!

# Give the API a moment to start
sleep 2

# Start the scheduler service in the foreground
echo "Starting summary scheduler..."
python -m src.main &
SCHEDULER_PID=$!

# Function to handle shutdown gracefully
shutdown() {
    echo "Shutting down services..."
    kill $API_PID $SCHEDULER_PID 2>/dev/null || true
    wait $API_PID $SCHEDULER_PID 2>/dev/null || true
    exit 0
}

# Trap SIGTERM and SIGINT
trap shutdown SIGTERM SIGINT

# Wait for both processes
wait $API_PID $SCHEDULER_PID
