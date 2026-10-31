# Building `verilator_bin.wasm`

The playground runs [Verilator](https://github.com/verilator/verilator) in the
browser: Verilator itself is compiled to WebAssembly with
[Emscripten](https://emscripten.org/), and the result lives in
`src/verilator/`:

| File                         | Origin (Verilator tree)              |
| ---------------------------- | ------------------------------------ |
| `verilator_bin.js`           | `bin/verilator_bin` (Emscripten JS loader) |
| `verilator_bin.wasm`         | `bin/verilator_bin.wasm`             |
| `verilated_std.sv`           | `include/verilated_std.sv`           |
| `verilated_std_waiver.vlt`   | `include/verilated_std_waiver.vlt`   |

Verilator is only used as a front end: `compile.ts` runs it with
`--cc --debug-check`, which makes it dump its final AST as JSON
(`obj_dir/V<top>.tree.json`). That JSON is converted to WebAssembly by
`src/sim/vjsonparser.ts` and `src/sim/hdlwasm.ts` (see
[`src/sim/README.md`](../src/sim/README.md)). The C++ that Verilator writes is
ignored.

## Quick start

```bash
# Emscripten (emcc/em++/emconfigure/emmake) must be in the PATH, plus
# git, autoconf, bison, flex, python3 and make.
./verilator/build-verilator-wasm.sh          # builds in .verilator-wasm-build/
npm test                                     # check the new binary
```

The script clones Verilator at the commit the patch was written for, applies
[`verilator-wasm.patch`](verilator-wasm.patch), configures it for Emscripten,
builds the optimized binary and copies the four files above into
`src/verilator/`. Useful environment variables:

- `VERILATOR_GIT` / `VERILATOR_REF`: where to clone from, and which commit
- `VERILATOR_SRC`: build an existing (already patched) Verilator tree instead,
  e.g. a fork such as `ckdur/verilator` (branch `wasm`)
- `FLEX_SRC`: reuse an existing `flex-2.6.4` source tree (no download)
- `JOBS`: parallel build jobs

The build was tested with Emscripten 3.1.69 (clang 19) and Verilator
5.048 (`v5.048-52-gc69c11b2d`). A full build takes a few minutes.

## The patch

[`verilator-wasm.patch`](verilator-wasm.patch) is small:

| File                            | Change |
| ------------------------------- | ------ |
| `configure.ac`                  | When cross compiling, assume the C++ standard check passes (it cannot run the test program). |
| `include/verilatedos.h`         | `VL_CPU_RELAX()` has no WASM implementation: make it empty instead of an `#error`. |
| `include/verilated_threads.cpp` | No `pthread_setaffinity_np` under Emscripten. |
| `src/Verilator.cpp`             | `main()` is exported (`extern "C"` + `EMSCRIPTEN_KEEPALIVE`) so that `callMain()` works. |
| `src/V3AstNodes.cpp`            | JSON dump fixes needed by the simulator (see below). |

The JSON changes matter for simulation correctness:

1. **Complete `initList` for `INITARRAY`.** Upstream truncates the
   index list after 6 entries (`[1]=(A) [2]=(B) ... `) and `INITITEM`s carry no
   index, so sparse constant tables (e.g. a ROM where entry 0 is the default
   value) cannot be placed correctly.
2. **`width` and `widthMin` on every data type.** The C++ that Verilator emits
   passes `widthMin()` to its runtime helpers (e.g.
   `VL_SHIFTRS_WWI(obits=widthMin, ...)`, `VL_LTS_III(lbits=widthMin, ...)`),
   and it can differ from the declared range (a 100 bit result stored in a
   128 bit temporary, for example).

The simulator still accepts JSON from an unpatched Verilator, but it warns
about truncated tables and falls back to the declared ranges.

## Building by hand

This is what the script does, step by step:

```bash
git clone https://github.com/verilator/verilator.git && cd verilator
git checkout c69c11b2dba4c7d3537a6321a7e2d8343beba66f
git apply /path/to/vga-playground/verilator/verilator-wasm.patch

# flex: only FlexLexer.h is needed (do not build it)
wget https://github.com/westes/flex/releases/download/v2.6.4/flex-2.6.4.tar.gz
tar xzf flex-2.6.4.tar.gz
(cd flex-2.6.4 && emconfigure ./configure --host i686-pc-linux-gnu)

export EXPORTED_RUNTIME_METHODS=addRunDependency,removeRunDependency,FS_createPath,FS_createDataFile,FS_createPreloadedFile,FS_createLazyFile,FS_createDevice,FS_unlink,FS,callMain,writeStackCookie,checkStackCookie
export SFLAGS="-s EXPORTED_RUNTIME_METHODS=$EXPORTED_RUNTIME_METHODS -s INVOKE_RUN=0 -s MAIN_MODULE=0 \
  -s MODULARIZE=1 -s EXPORT_NAME=verilator_bin -s EXPORT_ES6=1 -s EXIT_RUNTIME=0 \
  -s ALLOW_MEMORY_GROWTH=1 -s ERROR_ON_UNDEFINED_SYMBOLS=0 -s STACK_SIZE=16777216"
export CFLAGS="-O3 -I$(pwd)/flex-2.6.4/src $SFLAGS"
export CPPFLAGS="-O3 -I$(pwd)/flex-2.6.4/src $SFLAGS"
export LDFLAGS="-O3 $SFLAGS"   # -O3: configure cannot detect it when cross compiling
autoconf
emconfigure ./configure --prefix=/ --host i686-pc-linux-gnu
emmake make -C src -j$(nproc) opt     # only the optimized binary

PG=/path/to/vga-playground
cp bin/verilator_bin              $PG/src/verilator/verilator_bin.js
cp bin/verilator_bin.wasm         $PG/src/verilator/verilator_bin.wasm
cp include/verilated_std.sv       $PG/src/verilator/
cp include/verilated_std_waiver.vlt $PG/src/verilator/
```

## Troubleshooting

- **`Stack overflow detected. You can try increasing -sSTACK_SIZE`** when
  compiling: the binary was linked without `-s STACK_SIZE=16777216`.
  Emscripten's default stack has been 64 KB since 3.1.27, which is far too
  small for Verilator's recursive passes.
- **`PCH file uses an older PCH format`**: the build tree contains objects or
  precompiled headers from a different clang/Emscripten version. Remove
  `src/obj_opt/*.o src/obj_opt/*.gch src/obj_opt/*.d` (or start from a clean
  tree) and rebuild.
- **`verilator_bin.wasm` is ~75 MB** instead of ~15 MB: it was built without
  `-O3` (configure does not add it when cross compiling).
- **`emmake make verilator_bin` fails in `obj_dbg`**: the top-level target
  also builds the (huge) debug binary. Build only the optimized one with
  `emmake make -C src opt`.
- **The JS loader API**: recent Emscripten versions return a promise from the
  module factory (`await verilator_bin({...})`); older ones returned the
  module with a `.ready` promise and needed
  `sed -i "s|return verilator_bin.ready|return verilator_bin //.ready|"`.
  `compile.ts` handles both, so no post-processing is needed anymore.
- After updating the binary, run `npm test`: the torture tests compare the
  whole Verilator + WASM pipeline against native Verilator (see
  [`src/sim/torture/README.md`](../src/sim/torture/README.md)).
