"""Service entry point.

Run from the repository root so that the reference library and the scenario
folder resolve the same way they do for the replay command in the README:

    uvicorn backend.app.main:app --reload
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .api.routes import router
from .core.errors import ServiceError

app = FastAPI(
    title='Cosmostars · автономное управление спутниковой группировкой',
    version='1.0',
    description='Оператор наземной смены: планирование, события, ветвление, сравнение.',
)
app.include_router(router)


@app.exception_handler(ServiceError)
def service_error_handler(request: Request, exc: ServiceError) -> JSONResponse:
    """A refused request never damages a running shift; say why in plain terms."""
    return JSONResponse(status_code=exc.status_code, content=exc.payload())


@app.get('/')
def index() -> dict[str, str]:
    return {'service': 'cosmostars', 'docs': '/docs', 'api': '/api/health'}
