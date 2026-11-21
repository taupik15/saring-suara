#!/usr/bin/env bash
# Fix 1.5.1: provision model + WASM + JS bundle on the same GitHub Pages domain.
# Run in Codespaces or through .github/workflows/install-saring-ai.yml.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
command -v npm >/dev/null || { echo 'npm/Node diperlukan di lingkungan BUILD saja' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl diperlukan di lingkungan BUILD' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'python3 diperlukan di lingkungan BUILD' >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/npm" "$TMP/bin"

# Download a full binary, rejecting HTML/error pages. Do not hide failures.
download_checked() {
  local dest="$1" format="$2"; shift 2
  local url
  for url in "$@"; do
    echo "Trying $url"
    rm -f "$dest"
    if ! curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 240 "$url" -o "$dest"; then
      echo '  Request failed; checking next source.'
      continue
    fi
    if python3 - "$dest" "$format" <<'PY_ASSET'
import sys
from pathlib import Path
p=Path(sys.argv[1]); kind=sys.argv[2]; b=p.read_bytes()
valid=(kind=='wasm' and len(b)>100_000 and b[:4]==b'\0asm') or (kind=='model' and len(b)>1_000_000 and b[:2]==b'\x1f\x8b')
if not valid:
 print('Invalid '+kind+' file, size='+str(len(b)), file=sys.stderr)
 sys.exit(1)
print(kind, 'validated', len(b), 'bytes')
PY_ASSET
    then
      return 0
    fi
  done
  echo "Gagal memperoleh file $format dari sumber yang tersedia." >&2
  return 1
}
MODEL_URLS=(
  'https://raw.githubusercontent.com/Rikorose/DeepFilterNet/main/models/DeepFilterNet3_onnx.tar.gz'
  'https://huggingface.co/trysem/DeepFilterNet3/resolve/main/DeepFilterNet3_onnx.tar.gz'
)
# Model comes from the original project's official ONNX archive.
download_checked "$TMP/model.gz" model "${MODEL_URLS[@]}"
# Try vendor's matching v3 binary first, then a documented v2 binary mirror.
V3='https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3/v3/pkg/df_bg.wasm'
V2='https://code.lotusguild.org/LotusGuild/cinny/raw/commit/04b56ffacd24cb1fe2fa99822fe31f8884dd15bc/build/denoise-vendor/deepfilternet/v2/pkg/df_bg.wasm'
if download_checked "$TMP/df_bg.wasm" wasm "$V3"; then
  VERSION='v3'; PACKAGE='1.3.0'
else
  download_checked "$TMP/df_bg.wasm" wasm "$V2"
  VERSION='v2'; PACKAGE='1.2.1'
fi

echo "Installing build tools and package deepfilternet3-noise-filter@${PACKAGE}"
npm install --prefix "$TMP/npm" --no-save --ignore-scripts --no-audit --no-fund \
  esbuild@0.25.12 "deepfilternet3-noise-filter@${PACKAGE}"
SRC="$TMP/npm/node_modules/deepfilternet3-noise-filter/dist/index.esm.js"
test -s "$SRC" || { echo 'Modul ESM AI tidak ditemukan' >&2; exit 1; }
"$TMP/npm/node_modules/.bin/esbuild" "$SRC" --bundle --platform=browser \
  --format=esm --target=es2020 --outfile="$TMP/dfn3.bundle.js"

# Atomic-ish staging: only publish complete, validated assets.
mkdir -p "vendor-ai/$VERSION/pkg" "vendor-ai/$VERSION/models"
cp "$TMP/dfn3.bundle.js" vendor-ai/dfn3.bundle.js
cp "$TMP/df_bg.wasm" "vendor-ai/$VERSION/pkg/df_bg.wasm"
cp "$TMP/model.gz" "vendor-ai/$VERSION/models/DeepFilterNet3_onnx.tar.gz"
cp "$TMP/npm/node_modules/deepfilternet3-noise-filter/LICENSE-MIT" vendor-ai/LICENSE-MIT 2>/dev/null || true
cp "$TMP/npm/node_modules/deepfilternet3-noise-filter/LICENSE-APACHE" vendor-ai/LICENSE-APACHE 2>/dev/null || true
python3 - "$VERSION" "$PACKAGE" <<'PY_MANIFEST'
import json,sys
from pathlib import Path
info={'engine':'deepfilternet3','version':sys.argv[1],'package':'deepfilternet3-noise-filter@'+sys.argv[2]}
Path('vendor-ai/manifest.json').write_text(json.dumps(info)+'\n')
print('AI installed:',info)
PY_MANIFEST
