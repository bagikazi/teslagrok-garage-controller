#!/usr/bin/env bash
set -euo pipefail
if command -v lsusb >/dev/null; then lsusb | grep -i -E 'espressif|cp210|ch34|ftdi' || true; fi
if command -v tty >/dev/null; then find /dev -maxdepth 1 -type c -name 'ttyUSB*' -o -name 'ttyACM*' 2>/dev/null || true; fi
echo "Pass a selected port to idf.py/esptool; never infer board identity from the port name alone."
