#!/usr/bin/env bash
# Build verilator_bin.wasm (Verilator compiled to WebAssembly with Emscripten)
# and install it into src/verilator/.
#
# See verilator/README.md for details. Usage:
#
#   ./verilator/build-verilator-wasm.sh [build-dir]
#
# Environment variables:
#   VERILATOR_GIT   git URL (or local path) of Verilator   (default: upstream GitHub)
#   VERILATOR_REF   commit/tag to build                     (default: see below)
#   VERILATOR_SRC   use an existing, already patched source tree instead of cloning
#   FLEX_SRC        an existing flex-2.6.4 source tree (default: downloaded)
#   JOBS            parallel jobs                           (default: nproc)
#
# Requirements: emscripten (emcc/em++/emconfigure/emmake), git, autoconf,
# bison, flex, python3, make, wget or curl.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAYGROUND="$(cd "$HERE/.." && pwd)"
BUILD_DIR="${1:-$PLAYGROUND/.verilator-wasm-build}"
VERILATOR_GIT="${VERILATOR_GIT:-https://github.com/verilator/verilator.git}"
# Upstream commit the patch was made against (v5.048-52)
VERILATOR_REF="${VERILATOR_REF:-c69c11b2dba4c7d3537a6321a7e2d8343beba66f}"
FLEX_VERSION=2.6.4
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

for tool in emcc em++ emconfigure emmake git autoconf bison flex python3 make; do
  command -v "$tool" >/dev/null || { echo "error: '$tool' not found in PATH" >&2; exit 1; }
done

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# --- Verilator sources ---
if [ -n "${VERILATOR_SRC:-}" ]; then
  SRC="$(cd "$VERILATOR_SRC" && pwd)"
  echo ">> Using existing Verilator sources in $SRC"
else
  SRC="$BUILD_DIR/verilator"
  if [ ! -d "$SRC/.git" ]; then
    echo ">> Cloning Verilator from $VERILATOR_GIT"
    git clone "$VERILATOR_GIT" "$SRC"
  fi
  git -C "$SRC" fetch --quiet origin "$VERILATOR_REF" 2>/dev/null || true
  git -C "$SRC" checkout --quiet --force "$VERILATOR_REF"
  git -C "$SRC" clean -fdxq
  echo ">> Applying verilator-wasm.patch"
  git -C "$SRC" apply "$HERE/verilator-wasm.patch"
fi

# --- flex: only its headers (FlexLexer.h) are needed, flex itself is not built ---
if [ -n "${FLEX_SRC:-}" ]; then
  FLEX_DIR="$(cd "$FLEX_SRC" && pwd)"
else
  FLEX_DIR="$BUILD_DIR/flex-$FLEX_VERSION"
  if [ ! -d "$FLEX_DIR" ]; then
    echo ">> Downloading flex $FLEX_VERSION"
    url="https://github.com/westes/flex/releases/download/v$FLEX_VERSION/flex-$FLEX_VERSION.tar.gz"
    if command -v wget >/dev/null; then wget -q "$url" -O flex.tar.gz; else curl -sL "$url" -o flex.tar.gz; fi
    tar xzf flex.tar.gz
    (cd "$FLEX_DIR" && emconfigure ./configure --host i686-pc-linux-gnu >/dev/null)
  fi
fi

# --- Configure Verilator for Emscripten ---
EXPORTED_RUNTIME_METHODS=addRunDependency,removeRunDependency,FS_createPath,FS_createDataFile,FS_createPreloadedFile,FS_createLazyFile,FS_createDevice,FS_unlink,FS,callMain,writeStackCookie,checkStackCookie
SFLAGS="-s EXPORTED_RUNTIME_METHODS=$EXPORTED_RUNTIME_METHODS -s INVOKE_RUN=0 -s MAIN_MODULE=0"
SFLAGS="$SFLAGS -s MODULARIZE=1 -s EXPORT_NAME=verilator_bin -s EXPORT_ES6=1 -s EXIT_RUNTIME=0"
SFLAGS="$SFLAGS -s ALLOW_MEMORY_GROWTH=1 -s ERROR_ON_UNDEFINED_SYMBOLS=0"
# Verilator recurses deeply; the default Emscripten stack (64KB since 3.1.27) overflows
SFLAGS="$SFLAGS -s STACK_SIZE=16777216"

cd "$SRC"
echo ">> Configuring Verilator"
autoconf
# -O3 is explicit: Verilator's configure cannot probe optimization flags when
# cross compiling, and an unoptimized build is ~5x larger and much slower
CFLAGS="-O3 -I$FLEX_DIR/src $SFLAGS" \
CPPFLAGS="-O3 -I$FLEX_DIR/src $SFLAGS" \
LDFLAGS="-O3 $SFLAGS" \
  emconfigure ./configure --prefix=/ --host i686-pc-linux-gnu

echo ">> Building (this takes a while)"
emmake make -C src -j "$JOBS" opt

# --- Install into the playground ---
echo ">> Installing into $PLAYGROUND/src/verilator"
cp "$SRC/bin/verilator_bin" "$PLAYGROUND/src/verilator/verilator_bin.js"
cp "$SRC/bin/verilator_bin.wasm" "$PLAYGROUND/src/verilator/verilator_bin.wasm"
cp "$SRC/include/verilated_std.sv" "$PLAYGROUND/src/verilator/verilated_std.sv"
cp "$SRC/include/verilated_std_waiver.vlt" "$PLAYGROUND/src/verilator/verilated_std_waiver.vlt"
ls -la "$PLAYGROUND/src/verilator/verilator_bin."*
echo ">> Done. Run 'npm test' to check the new binary."
