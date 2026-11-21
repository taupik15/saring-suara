#!/usr/bin/env bash
# Build an offline GTCRN AudioWorklet and copy its WASM/model to vendor-gtcrn.
# Requires Node 22, npm, Python 3. Used by GitHub Actions; no npm at runtime.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
for exe in node npm python3; do command -v "$exe" >/dev/null || { echo "Missing $exe" >&2; exit 1; }; done
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
npm install --prefix "$TEMP" --no-save --ignore-scripts --no-audit --no-fund \
  esbuild@0.25.12 '@sapphi-red/gtcrn-wasm@0.0.3'
PACKAGE="$TEMP/node_modules/@sapphi-red/gtcrn-wasm/dist"
test -s "$PACKAGE/gtcrn.wasm" || { echo 'GTCRN WASM missing from npm package' >&2; exit 1; }
cp scripts/gtcrn-worklet-entry.js "$TEMP/gtcrn-entry.js"
"$TEMP/node_modules/.bin/esbuild" "$TEMP/gtcrn-entry.js" \
  --bundle --platform=browser --format=esm --target=es2020 --log-level=warning \
  --outfile="$TEMP/gtcrn-worklet.js"
node --check "$TEMP/gtcrn-worklet.js"
python3 - "$PACKAGE/gtcrn.wasm" "$TEMP/gtcrn-worklet.js" <<'PY'
from pathlib import Path
import sys
wasm=Path(sys.argv[1]); js=Path(sys.argv[2])
assert wasm.stat().st_size > 100_000, 'WASM looks truncated'
assert wasm.read_bytes()[:4] == b'\0asm', 'Not a valid WASM file'
assert js.stat().st_size > 3000, 'GTCRN AudioWorklet bundle is empty'
body=js.read_text()
assert 'saring-gtcrn' in body and 'registerProcessor' in body
print('GTCRN assets validated:',wasm.stat().st_size,'WASM bytes,',js.stat().st_size,'JS bytes')
PY
mkdir -p vendor-gtcrn
cp "$PACKAGE/gtcrn.wasm" vendor-gtcrn/gtcrn.wasm
cp "$TEMP/gtcrn-worklet.js" vendor-gtcrn/gtcrn-worklet.js
cat > vendor-gtcrn/NOTICE.txt <<'NOTE'
GTCRN speech denoiser: @sapphi-red/gtcrn-wasm@0.0.3 (MIT).
Source: https://github.com/sapphi-red/gtcrn-wasm
Model weights from GTCRN (MIT), with pffft (FFTPACK/UCAR) licensed components.
This is noise suppression, not guaranteed music/dialogue separation.
See upstream package/repository for full license notices and attribution.
NOTE
printf 'GTCRN local assets installed to vendor-gtcrn/\n'
