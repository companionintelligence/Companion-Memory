from fastapi import FastAPI
from pydantic import BaseModel

from pgboss import get_shared_message


class RootResponse(BaseModel):
    service: str
    lib_response: str

app = FastAPI()


@app.get("/")
def read_root() -> RootResponse:
    msg = get_shared_message()


    return RootResponse(
        service="Graph App",
        lib_response=msg
    )
