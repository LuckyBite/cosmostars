"""Service entry point.

Run from the repository root so that the reference library and the scenario
folder resolve the same way they do for the replay command in the README:

    uvicorn backend.app.main:app --reload
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.routes import router
from .core import config
from .core.errors import ServiceError

app = FastAPI(
    title='Cosmostars · автономное управление спутниковой группировкой',
    version='1.0',
    description='Оператор наземной смены: планирование, события, ветвление, сравнение.',
)
# The shift views are repetitive JSON and compress by an order of magnitude;
# over a modest link that is the difference between instant and sluggish.
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware('http')
async def limit_request_body(request: Request, call_next):
    """Refuse a body larger than the service is willing to parse.

    Two endpoints take files from the operator: an uploaded scenario and an
    export to replay. A megabyte of JSON becomes several megabytes of Python
    objects, so an unbounded body is a way to exhaust the memory of a small
    machine with one request. The limit is stated rather than assumed: a daily
    export is about ten megabytes, and the default leaves room for that.
    """
    declared = request.headers.get('content-length')
    if declared is not None and declared.isdigit() and int(declared) > config.MAX_UPLOAD_BYTES:
        return JSONResponse(status_code=413, content={
            'error': 'PayloadTooLarge',
            'message': (f'Тело запроса больше {config.MAX_UPLOAD_BYTES // (1024 * 1024)} МБ. '
                        'Суточная выгрузка весит около 10 МБ; если файл законно больше, '
                        'поднимите COSMOSTARS_MAX_UPLOAD_BYTES.'),
            'detail': {'content_length': int(declared), 'limit': config.MAX_UPLOAD_BYTES},
        })
    return await call_next(request)
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
