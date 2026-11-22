#!/usr/bin/env bash
# Saring Suara Fix 2.0 · package ONNX Runtime Web + UVR_MDXNET_9482 at deploy time.
# No npm, backend or remote model download during actual inference.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
for exe in npm node python3 curl sha256sum; do command -v "$exe" >/dev/null || { echo "Missing ${exe}" >&2; exit 1; }; done
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
npm install --prefix "$TMP" --no-save --ignore-scripts --no-audit --no-fund 'onnxruntime-web@1.23.2'
DIST="$TMP/node_modules/onnxruntime-web/dist"
mkdir -p vendor-uvr
for f in \
  ort.min.js ort.webgpu.min.js \
  ort-wasm-simd-threaded.wasm ort-wasm-simd-threaded.mjs \
  ort-wasm-simd-threaded.jsep.wasm ort-wasm-simd-threaded.jsep.mjs; do
  test -s "$DIST/$f" || { echo "Missing ONNX Runtime asset $f" >&2; exit 1; }
  cp "$DIST/$f" "vendor-uvr/$f"
done
# GitHub source is also the maintained sherpa-onnx public ONNX model mirror.
URL='https://huggingface.co/k2-fsa/sherpa-onnx-models/resolve/main/source-separation-models/UVR_MDXNET_9482.onnx?download=true'
EXPECTED='9d78f8566fa8198065214ab628be1de966a500c57786695aa4b13e2b27a7727d'
MODEL='vendor-uvr/UVR_MDXNET_9482.onnx'
if [ ! -s "$MODEL" ] || ! echo "$EXPECTED  $MODEL" | sha256sum --check --status; then
  curl --fail --location --retry 3 --connect-timeout 30 --max-time 300 --output "$TMP/model.onnx" "$URL"
  echo "$EXPECTED  $TMP/model.onnx" | sha256sum --check
  mv "$TMP/model.onnx" "$MODEL"
fi
node --check uvr-live.js
node --check uvr-live-worker.js
node --check uvr-tap-worklet.js
cat > vendor-uvr/NOTICE.txt <<'NOTE'
UVR_MDXNET_9482 model · UVR / Anjok07 and contributors.
Model from k2-fsa/sherpa-onnx-models, original UVR model weights.
SHA256 9d78f8566fa8198065214ab628be1de966a500c57786695aa4b13e2b27a7727d
ONNX Runtime Web by Microsoft (MIT).
Check upstream license and attribution before redistributing modified models.
A machine-learning separator, not guaranteed real-time on mobile.
NOTE
python3 - <<'PY'
from pathlib import Path
p=Path('vendor-uvr')
assert (p/'UVR_MDXNET_9482.onnx').stat().st_size > 20_000_000
assert (p/'ort.min.js').stat().st_size > 10_000
assert (p/'ort.webgpu.min.js').stat().st_size > 10_000
print('UVR assets ready; model bytes:', (p/'UVR_MDXNET_9482.onnx').stat().st_size)
PY
