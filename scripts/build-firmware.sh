#!/usr/bin/env bash
set -euo pipefail
TARGET="${1:-controller-s3}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/firmware/$TARGET"
command -v idf.py >/dev/null || { echo "idf.py is not on PATH; source .tools/esp-idf/export.sh first" >&2; exit 1; }
pushd "$PROJECT" >/dev/null
if [[ "$TARGET" == "controller-s3" ]]; then idf.py set-target esp32s3; else idf.py set-target esp32; fi
idf.py build
popd >/dev/null
