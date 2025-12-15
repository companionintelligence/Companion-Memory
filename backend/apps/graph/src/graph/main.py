from fastapi import FastAPI
from pgboss import get_shared_message

app = FastAPI()

@app.get("/")
def read_root():
    # Use the shared code
    msg = get_shared_message()
    return {
        "service": "Graph App",
        "lib_response": msg
    }
