#!/usr/bin/env bash
# Publish the service to a Hugging Face Space (Docker SDK).
#
# The Space is its own git repository, and its configuration lives in the front
# matter of the README.md at its root. Ours would overwrite that, so the Space
# gets deploy/space-README.md instead and the project README stays as it is.
#
# Usage:
#   deploy/push-space.sh <owner>/<space-name>
#
# Requires: the Space already created on huggingface.co with SDK "Docker",
# and git credentials for huggingface.co (a write token as the password, or
# `huggingface-cli login`). Nothing here creates an account or a Space.

set -euo pipefail

SPACE="${1:-}"
if [[ -z "$SPACE" ]]; then
    echo "usage: deploy/push-space.sh <owner>/<space-name>" >&2
    exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ clone https://huggingface.co/spaces/$SPACE"
git clone --depth 1 "https://huggingface.co/spaces/$SPACE" "$WORK/space"

cd "$WORK/space"
# Drop what we are about to replace, keeping the Space's own git metadata.
find . -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +

echo "→ copy the service"
cp "$ROOT/Dockerfile" "$ROOT/.dockerignore" "$ROOT/requirements.txt" .
cp "$ROOT/deploy/space-README.md" README.md
for dir in model data examples backend; do
    cp -r "$ROOT/$dir" .
done
mkdir -p frontend
cp "$ROOT/frontend/package.json" "$ROOT/frontend/package-lock.json" \
   "$ROOT/frontend/vite.config.ts" "$ROOT/frontend/tsconfig.json" \
   "$ROOT/frontend/index.html" frontend/
cp -r "$ROOT/frontend/src" frontend/src
find . -name '__pycache__' -type d -prune -exec rm -rf {} +

echo "→ push"
git add -A
if git diff --cached --quiet; then
    echo "nothing changed; the Space is already up to date"
    exit 0
fi
git -c user.name="cosmostars-deploy" -c user.email="deploy@example.invalid" \
    commit -q -m "Deploy $(cd "$ROOT" && git rev-parse --short HEAD)"
git push

echo "✓ https://huggingface.co/spaces/$SPACE — сборка идёт 3–5 минут"
echo "  сервис будет на https://$(echo "$SPACE" | tr '/' '-' | tr '[:upper:]' '[:lower:]').hf.space"
