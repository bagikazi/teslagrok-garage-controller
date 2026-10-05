#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDF_VERSION="${1:-v6.0.3}"
TOOLS_DIR="$ROOT_DIR/.tools"
IDF_DIR="$TOOLS_DIR/esp-idf"
mkdir -p "$TOOLS_DIR"
if [[ ! -d "$IDF_DIR/.git" ]]; then
  git clone --branch "$IDF_VERSION" --depth 1 --recursive https://github.com/espressif/esp-idf.git "$IDF_DIR"
else
  git -C "$IDF_DIR" fetch --tags
  git -C "$IDF_DIR" checkout "$IDF_VERSION"
  git -C "$IDF_DIR" submodule update --init --recursive
fi
"$IDF_DIR/install.sh" esp32s3
echo "ESP-IDF $IDF_VERSION installed. Run: source .tools/esp-idf/export.sh"
