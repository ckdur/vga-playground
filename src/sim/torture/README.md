# Simulator torture tests

Small Verilog designs that exercise the corners of the simulator, plus
golden traces produced by **native Verilator** (the C++ model). `torture.spec.ts`
runs every design through the in-browser pipeline (`verilator_bin.wasm` →
JSON → WASM) and compares the results bit for bit.

| Design        | Covers |
| ------------- | ------ |
| `t_arith.v`   | `+ - * / %`, signed and unsigned, 8..64 bits, division by zero |
| `t_shift.v`   | `<< >> >>>` by constant and variable amounts (including amounts >= width), narrow, 64-bit and 100/128-bit values |
| `t_wide.v`    | values > 64 bits: add/sub/mul, bitwise ops, signed/unsigned compares, concatenation, replication, variable part selects, reductions |
| `t_signed.v`  | sign extension at odd widths, `$signed`/`$unsigned`, signed compares and multiplies, saturation |
| `t_mem.v`     | memories (8/32/64/100-bit words, 2-D arrays), constant tables, case ROMs |
| `t_control.v` | `case`/`casez`, `for`/`while`/`repeat`, functions with loops, tasks, an FSM |
| `t_clocks.v`  | negedge flops, async resets, derived and gated clocks, latches, blocking/non-blocking mixes |
| `t_bits.v`    | single-bit writes in loops, `+:`/`-:` selects, packed 2-D arrays, generate blocks, parameterized instances |
| `t_gates.v`   | gate-level netlist style: combinational and sequential UDPs, gate primitives, power pins, tie cells |

Every torture design has the same ports: `clk`, `rst_n`, `a[63:0]`, `b[63:0]`,
`c[7:0]` and any number of outputs. Each cycle the inputs are driven from a
xorshift64 PRNG (`rst_n` is low for cycles 0..2 and 150..151), and every
output is recorded after both clock edges.

The VGA presets in `src/examples` are also checked: a FNV-1a hash of
`{uo_out, uio_out, uio_oe}` is recorded every 4096 cycles over two frames.

## Adding a design

1. Write `t_<name>.v` with a top module named `t_<name>` and the ports above.
   It must be lint-clean with the playground flags (see `VERILATOR_ARGS` in
   `src/verilator/compile.ts`).
2. Generate its golden trace (needs Verilator >= 5.040 and a C++ compiler):

   ```bash
   VERILATOR=/path/to/verilator ./src/sim/torture/gen_golden.py t_<name>
   ```

3. Run `npm test`.

`gen_golden.py` without arguments regenerates every golden file. Regenerate
them when the Verilator version or the flags change.

## Checking your own project (e.g. a gate-level netlist)

Designs that don't belong in this repository, such as a Tiny Tapeout project
and its post-layout netlist, can be checked the same way:

```bash
cat > designs.json <<EOF
[{"name": "maze_rtl", "top": "tt_um_maze", "kind": "vga", "frames": 3,
  "files": ["/abs/src/tt_um_maze.v", "/abs/src/maze.v", "..."]},
 {"name": "maze_gl", "top": "tt_um_maze", "kind": "vga", "frames": 3,
  "files": ["/abs/tt_um_maze.nl.v", "/abs/primitives.v", "/abs/sky130_fd_sc_hd.v"]}]
EOF
VERILATOR=verilator ./src/sim/torture/gen_golden.py --extra designs.json --out golden maze_rtl maze_gl

cat > manifest.json <<EOF
[{"name": "maze_rtl", "top": "tt_um_maze", "golden": "golden/maze_rtl.json",
  "files": ["/abs/src/tt_um_maze.v", "/abs/src/maze.v", "..."]},
 {"name": "maze_gl", "top": "tt_um_maze", "golden": "golden/maze_gl.json",
  "files": ["/abs/tt_um_maze.nl.v", "/abs/primitives.v", "/abs/sky130_fd_sc_hd.v"]}]
EOF
VGA_PLAYGROUND_EXTRA_GOLDEN=$PWD/manifest.json npx vitest --run src/sim/torture.spec.ts
```

Relative paths in the manifest are resolved from the manifest's directory.
