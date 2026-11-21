#!/usr/bin/env bash
# One-time, optional: fetch AI runtime/model for offline use on GitHub Pages.
# Run in Codespaces repository root: bash scripts/install-ai-vendor.sh
set -euo pipefail
cd "$(dirname "$0")/.."
command -v npm >/dev/null || { echo 'Node/npm diperlukan hanya saat persiapan aset AI.' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl tidak ditemukan.' >&2; exit 1; }
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p vendor-ai/v3/pkg vendor-ai/v3/models
printf '%s\n' 'Membangun modul AI lokal (hanya saat instalasi)...'
npm install --prefix "$TMP_DIR" --no-save --ignore-scripts --no-audit --no-fund \
  esbuild@0.25.12 deepfilternet3-noise-filter@1.3.0
"$TMP_DIR/node_modules/.bin/esbuild" \
  "$TMP_DIR/node_modules/deepfilternet3-noise-filter/dist/index.esm.js" \
  --bundle --platform=browser --format=esm --target=es2020 \
  --outfile=vendor-ai/dfn3.bundle.js
BASE='https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3'
printf '%s\n' 'Mengunduh model AI resmi dan WASM lokal...'
curl --fail --location --retry 3 --retry-delay 2 --max-time 300 \
  "$BASE/v3/pkg/df_bg.wasm" -o vendor-ai/v3/pkg/df_bg.wasm
curl --fail --location --retry 3 --retry-delay 2 --max-time 300 \
  "$BASE/v3/models/DeepFilterNet3_onnx.tar.gz" -o vendor-ai/v3/models/DeepFilterNet3_onnx.tar.gz
# Reject HTML error pages and incomplete model payloads.
python3 - <<'PY'
from pathlib import Path
wasm=Path('vendor-ai/v3/pkg/df_bg.wasm').read_bytes()
model=Path('vendor-ai/v3/models/DeepFilterNet3_onnx.tar.gz').read_bytes()
assert wasm[:4] == b'\0asm' and len(wasm) > 100000, 'WASM tidak valid'
assert model[:2] == b'\x1f\x8b' and len(model) > 1000000, 'Model gzip tidak valid'
print('Aset berhasil dicek:', len(wasm), 'WASM bytes;', len(model), 'model bytes')
PY
if test -f "$TMP_DIR/node_modules/deepfilternet3-noise-filter/LICENSE-MIT"; then
  cp "$TMP_DIR/node_modules/deepfilternet3-noise-filter/LICENSE-MIT" vendor-ai/LICENSE-MIT
fi
if test -f "$TMP_DIR/node_modules/deepfilternet3-noise-filter/LICENSE-APACHE"; then
  cp "$TMP_DIR/node_modules/deepfilternet3-noise-filter/LICENSE-APACHE" vendor-ai/LICENSE-APACHE
fi
printf '{"engine":"deepfilternet3","version":"v3","package":"deepfilternet3-noise-filter@1.3.0"}\n' > vendor-ai/manifest.json
printf '%s\n' 'Selesai: git add vendor-ai && git commit/push. GitHub Pages tidak perlu npm.'
