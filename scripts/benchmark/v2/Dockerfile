FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fastapi==0.115.* "uvicorn[standard]==0.32.*" pydantic==2.* \
    "mem0ai==2.0.4" chromadb ollama "hindsight-client>=0.7,<1" numpy

COPY app/ /app/

EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
