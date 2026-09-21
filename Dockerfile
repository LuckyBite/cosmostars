# One container: the interface is built here and served by the service itself.
#
# Sessions live in the memory of this process, so the image is meant to run as a
# single instance. That is a deliberate limit of the case — a shift is a live
# object, not a row in a database — and it is why the service is deployed as one
# container rather than behind an autoscaler.

FROM node:22-alpine AS interface
WORKDIR /ui
# Dependencies first, so a source-only change does not reinstall them.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# The reference library is used as shipped, and the working directory is the
# repository root — the same way the documented replay command expects to run.
COPY model/ model/
COPY data/ data/
COPY examples/ examples/
COPY backend/ backend/
COPY --from=interface /ui/dist frontend/dist

# Hugging Face Spaces serves port 7860 and runs the container as uid 1000.
RUN useradd --uid 1000 --create-home operator && chown -R operator:operator /app
USER operator
ENV PORT=7860
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import os, sys, urllib.request; url = 'http://127.0.0.1:' + os.environ.get('PORT', '7860') + '/api/health'; sys.exit(0 if urllib.request.urlopen(url, timeout=4).status == 200 else 1)"

CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
