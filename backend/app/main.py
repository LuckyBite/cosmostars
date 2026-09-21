"""Service entry point.

Run from the repository root so that the reference library and the scenario
folder resolve the same way they do for the replay command in the README:

    uvicorn backend.app.main:app --reload
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.routes import router
from .core import config
from .core.errors import ServiceError

app = FastAPI(
    title='Cosmostars · автономное управление спутниковой группировкой',
    version='1.0',
    description='Оператор наземной смены: планирование, события, ветвление, сравнение.',
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=['*'],
    allow_headers=['*'],
)
app.include_router(router)


@app.exception_handler(ServiceError)
def service_error_handler(request: Request, exc: ServiceError) -> JSONResponse:
    """A refused request never damages a running shift; say why in plain terms."""
    return JSONResponse(status_code=exc.status_code, content=exc.payload())


@app.get('/api', include_in_schema=False)
def api_index() -> dict[str, str]:
    return {'service': 'cosmostars', 'docs': '/docs', 'api': '/api/health'}


# The built interface is served by this same process: one origin, one container,
# one link for the jury. Mounted last so that /api and /docs keep their routes,
# and only when a build exists, so the API alone still runs from a bare clone.
if (config.FRONTEND_DIR / 'index.html').is_file():
    app.mount('/', StaticFiles(directory=config.FRONTEND_DIR, html=True), name='ui')
else:
    @app.get('/')
    def index() -> dict[str, str]:
        return {'service': 'cosmostars', 'docs': '/docs', 'api': '/api/health',
                'interface': 'not built; run npm ci && npm run build in frontend/'}
