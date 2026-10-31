# Simulator

The playground simulates Verilog by compiling it twice:

```
Verilog ──(verilator_bin.wasm, --debug-check)──> V<top>.tree.json
        ──(vjsonparser.ts)──> VModel IR ──(hdlwasm.ts)──> WAT ──(binaryen)──> WASM
```

1. **Verilator** (compiled to WebAssembly, see [`verilator/`](../../verilator/README.md))
   parses, elaborates, flattens and optimizes the design, and dumps the final
   AST as JSON. This is the same tree Verilator uses to write C++, so it is a
   list of C functions (`_eval`, `_eval_static`, `_eval_initial`,
   `_eval_settle`, `_ctor_var_reset`, the trigger/phase functions of the
   Verilator 5 scheduler...) operating on C-sized integers.
2. **`vjsonparser.ts`** turns the JSON into a small IR (`hdltypes.ts`):
   variables, functions, statements and expressions. All references are
   resolved through Verilator's node addresses (`varp`, `funcp`, `dtypep`).
3. **`hdlwasm.ts`** generates a WebAssembly module (as WAT text) that mirrors
   the C++ Verilator would emit:
   - design state at fixed addresses in linear memory (outputs first, then
     inputs and internal state, then constant tables and temporaries)
   - one WASM function per Verilator function, including arguments passed by
     value or by reference, return values, loops (`LOOP`/`LOOPTEST`) and jump
     blocks
   - values up to 32 bits are `i32`, up to 64 bits `i64`, wider values are
     arrays of 32-bit words handled by helpers in `wasmlib.ts`
   - the semantics of Verilator's runtime (`verilated_funcs.h`) are followed
     exactly: `x/0 == 0`, shifts by more than the width, `VL_SHIFTRS`,
     `VL_EXTENDS`, signed comparisons using `widthMin`, etc.
   - `$readmemh`/`$readmemb` load files from the project's `dataFiles`
     (`readmem.ts`), with Verilator's addressing rules
   - the model is initialized lazily on the first `eval()` (static/initial
     blocks and settle), like `Vtop::eval_step()`, so the inputs set after
     `powercycle()` are seen by `initial` blocks
4. **binaryen** parses, validates and optimizes the module (`-O2`), which
   typically makes the simulation 2-3x faster.

The generated code is about as fast as native Verilator: 9 Mcycles/s for an
RTL design and 0.6 Mcycles/s for a post-layout sky130 netlist, vs. 7 and
0.5 Mcycles/s for the C++ model (`-O3`, same machine).

## Debugging

- Open the playground with `?debug` in the URL to download the JSON tree
  (when it cannot be converted) or the generated WAT (when it does not
  validate).
- `HDLModuleWASM.wat` holds the generated WAT source; construct the module
  with `{ optimize: false }` to keep the binary close to it.
- `HDLModuleWASM.getGlobals()` returns the state as a tree.

## Tests

| Spec | What it checks |
| ---- | -------------- |
| `hdlwasm.spec.ts` | IR-level: every operator at 17 widths (1..256 bits) against a BigInt model of Verilator's semantics; functions, loops, arrays, fatal errors |
| `hdlwasm-integration.spec.ts` | Verilog to WASM for wide counters, arithmetic, shifts, comparisons |
| `vga-integration.spec.ts` | First frame of the `stripes` preset against a reference PNG |
| `torture.spec.ts` | Torture designs and all presets against golden traces from native Verilator, see [`torture/README.md`](torture/README.md) |

The original simulator was based on [8bitworkshop](https://github.com/sehugg/8bitworkshop)
(GPL v3).
