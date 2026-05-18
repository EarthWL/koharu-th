#!/usr/bin/env bash
# Build per-GPU-family release binaries.
#
# bindgen_cuda 0.1.6 (transitive via candle-kernels) only supports a
# single compute cap per build, so to ship coverage across RTX
# generations we run `bun run build` once per cap and rename the
# resulting MSI/NSIS to include the family in the filename.
#
# Usage: bash scripts/build-all-gpus.sh
# Outputs: release-out/ holds N artifacts ready to upload to a release.
set -euo pipefail

# Single source of truth: the workspace version in Cargo.toml.
# Avoids drift between this script and the actual binary version after
# every release bump.
VERSION=$(grep -E '^version = "[0-9]+\.[0-9]+\.[0-9]+"$' Cargo.toml | head -1 | sed -E 's/version = "(.+)"/\1/')
if [[ -z "$VERSION" ]]; then
    echo "ERROR: could not parse workspace version from Cargo.toml" >&2
    exit 1
fi
echo "Building koharu-th v$VERSION"

OUT_DIR="release-out"
mkdir -p "$OUT_DIR"

# (compute_cap, label, GPU family description)
declare -a BUILDS=(
    "75|rtx20-turing|RTX 20xx / Quadro RTX (Turing)"
    "86|rtx30-ampere|RTX 30xx / A-series (Ampere)"
    "89|rtx40-ada|RTX 40xx (Ada Lovelace)"
    "120|rtx50-blackwell|RTX 50xx (Blackwell)"
)

for entry in "${BUILDS[@]}"; do
    IFS='|' read -r cap label desc <<< "$entry"
    echo ""
    echo "==============================================================="
    echo "Building for $desc (compute cap $cap)..."
    echo "==============================================================="

    # Wipe per-build artifacts so we never accidentally copy a stale
    # bundle from a previous iteration if a build fails. MSI was
    # dropped from bundle.targets in 583fe513; only NSIS is produced
    # on Windows now.
    rm -f target/release/bundle/nsis/koharu_${VERSION}_x64-setup.exe

    CUDA_COMPUTE_CAP="$cap" bun run build

    cp "target/release/bundle/nsis/koharu_${VERSION}_x64-setup.exe" \
       "$OUT_DIR/koharu_${VERSION}_${label}-setup.exe"
    echo "→ $OUT_DIR/koharu_${VERSION}_${label}-setup.exe"
done

echo ""
echo "==============================================================="
echo "All builds complete. Artifacts in $OUT_DIR/:"
echo "==============================================================="
ls -lh "$OUT_DIR"
