#!/usr/bin/env bash
# Build only at GitHub Actions time. RNNoise is self-hosted in Pages at runtime.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
for exe in npm node python3; do command -v "$exe" >/dev/null || exit 1; done
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
npm install --prefix "$TMP" --ignore-scripts --no-save --no-audit --no-fund \
  esbuild@0.25.12 '@sapphi-red/web-noise-suppressor@0.4.1'
PACKAGE="$TMP/node_modules/@sapphi-red/web-noise-suppressor/dist"
test -s "$PACKAGE/rnnoise.wasm"
test -s "$PACKAGE/rnnoise/workletProcessor.js"
test -s "$PACKAGE/index.js"
# npm does not apply the upstream project's pnpm patch. Add the exact
# loadBinary bridge required to instantiate RNNoise using bytes supplied
# from the main thread (AudioWorklet cannot fetch extra files reliably).
python3 - "$TMP/node_modules/@shiguredo/rnnoise-wasm/dist/rnnoise.mjs" <<'PY_FIX'
from pathlib import Path
import sys
path=Path(sys.argv[1]); src=path.read_text()
if 'static async loadBinary(' not in src:
    marker='class Rnnoise {'
    assert marker in src and 'Module' in src, 'RNNoise source changed; refuse unsafe patch'
    src=src.replace(marker, marker + """
    static async loadBinary(binary) {
        const rnnoiseModule = await Module({locateFile: file => file, wasmBinary: binary});
        return new Rnnoise(rnnoiseModule);
    }
    """, 1)
    path.write_text(src)
assert 'static async loadBinary(' in path.read_text()
print('RNNoise loadBinary compatibility bridge ready')
PY_FIX
mkdir -p vendor-rnnoise
# Turn the published library into one local ESM module; no remote JS at playback.
cat > "$TMP/rnnoise-entry.js" <<'JS'
export { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
JS
"$TMP/node_modules/.bin/esbuild" "$TMP/rnnoise-entry.js" \
  --bundle --platform=browser --format=esm --target=es2020 --outfile=vendor-rnnoise/rnnoise-main.js
# Ensure any imports from the worklet distribution are also included locally.
"$TMP/node_modules/.bin/esbuild" "$PACKAGE/rnnoise/workletProcessor.js" \
  --bundle --platform=browser --format=iife --target=es2020 --outfile=vendor-rnnoise/rnnoise-worklet.js
# Bundle the VAD-capable mono worklet. Keep the old worklet/main assets
# for rollback and to satisfy unchanged Fix 1.7 workflow checks.
cp scripts/rnnoise-vad-worklet-entry.js "$TMP/rnnoise-vad-entry.js"
"$TMP/node_modules/.bin/esbuild" "$TMP/rnnoise-vad-entry.js" \
  --bundle --platform=browser --format=iife --target=es2020 --outfile=vendor-rnnoise/rnnoise-vad-worklet.js
cp "$PACKAGE/rnnoise.wasm" vendor-rnnoise/rnnoise.wasm
cp "$TMP/node_modules/@sapphi-red/web-noise-suppressor/LICENSE" vendor-rnnoise/LICENSE-MIT 2>/dev/null || true
cat > vendor-rnnoise/NOTICE.txt <<'NOTE'
RNNoise Web Audio processor: @sapphi-red/web-noise-suppressor@0.4.1 (MIT).
Upstream: https://github.com/sapphi-red/web-noise-suppressor
RNNoise WebAssembly backend: shiguredo/rnnoise-wasm (Apache-2.0).
RNNoise algorithm: xiph/rnnoise (BSD-3-Clause). Include attribution as required.
This is noise reduction; it does not guarantee removal of music.
NOTE
node --check vendor-rnnoise/rnnoise-main.js
node --check vendor-rnnoise/rnnoise-worklet.js
node --check vendor-rnnoise/rnnoise-vad-worklet.js
python3 - <<'PY'
from pathlib import Path
p=Path('vendor-rnnoise')
wasm=(p/'rnnoise.wasm').read_bytes()
assert len(wasm)>20000 and wasm[:4]==b'\0asm', 'WASM missing/corrupt'
assert (p/'rnnoise-main.js').stat().st_size>1000
assert (p/'rnnoise-worklet.js').stat().st_size>1000
assert (p/'rnnoise-vad-worklet.js').stat().st_size>1000
assert 'saring-rnnoise-vad' in (p/'rnnoise-vad-worklet.js').read_text()
print('RNNoise assets bundled:',len(wasm),'bytes WASM')
PY
