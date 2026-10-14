"""FastAPI entry point for the LiteLLM health watcher."""

from watcher import app


if __name__ == "__main__":
    import os
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
