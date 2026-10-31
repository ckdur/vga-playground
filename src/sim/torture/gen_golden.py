#!/usr/bin/env python3
"""
Generate golden reference traces for the simulator torture tests.

The golden values are produced by native (C++) Verilator, using the same
Verilator flags as the playground, so that the WASM simulator can be
compared bit-for-bit against the real thing.

Two kinds of goldens are produced in ./golden:

  * <design>.json   - torture designs (t_*.v in this directory). Every output
                      port is recorded after each clock edge, while the inputs
                      a/b/c are driven from a deterministic xorshift64 PRNG.
  * <example>.json  - VGA examples (../../examples/*). A FNV-1a hash of
                      {uo_out, uio_out, uio_oe} is recorded every N cycles.

Usage:
    VERILATOR=/path/to/verilator ./gen_golden.py [names...]

Requirements: verilator (>= 5.040) and a C++ compiler in the PATH.
Extra designs can be described in a JSON file passed with --extra (see
EXTRA_DESIGN_HELP below); this is how designs that live outside of this
repository (e.g. a Tiny Tapeout project and its gate-level netlist) are added.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXAMPLES = os.path.normpath(os.path.join(HERE, '..', '..', 'examples'))
GOLDEN = os.path.join(HERE, 'golden')

# Keep in sync with src/verilator/compile.ts
VERILATOR_FLAGS = [
    '-O3', '-Wall', '-Wno-EOFNEWLINE', '-Wno-DECLFILENAME', '-Wno-UNOPTFLAT', '-Wno-BLKSEQ',
    '-Wno-UNDRIVEN', '-Wno-PINMISSING', '-Wno-UNUSED', '-Wno-WIDTHTRUNC', '-Wno-fatal', '--x-assign',
    'fast',
]

TORTURE_CYCLES = 300
# Cycles where rst_n is forced low (to exercise synchronous and asynchronous resets)
TORTURE_RESET = [(0, 3), (150, 152)]

EXAMPLE_FRAMES = 2
VGA_CYCLES_PER_FRAME = 800 * 525
EXAMPLE_HASH_EVERY = 4096
EXAMPLE_RESET_CYCLES = 10

EXTRA_DESIGN_HELP = """
--extra takes a JSON file with a list of objects:
  [{"name": "maze_rtl", "top": "tt_um_maze", "kind": "vga",
    "files": ["/abs/path/a.v", ...], "frames": 2, "flags": ["-DFOO"]}]
"""

PORT_RE = re.compile(r'VL_(IN|OUT|INOUT)(8|16|64|W)?\(&(\w+),(\d+),(\d+)')

HARNESS_COMMON = r'''
#include <cstdio>
#include <cstdint>
#include <string>
#include "verilated.h"
#include "V{top}.h"

static uint64_t s_rng = 0x9e3779b97f4a7c15ULL;
static uint64_t xorshift64() {{
    s_rng ^= s_rng << 13;
    s_rng ^= s_rng >> 7;
    s_rng ^= s_rng << 17;
    return s_rng;
}}

static std::string hexw(const uint32_t* w, int words, int bits) {{
    static const char* digits = "0123456789abcdef";
    std::string s;
    for (int i = words * 8 - 1; i >= 0; --i) {{
        int bit = i * 4;
        if (bit >= bits) continue;
        uint32_t nib = (w[bit / 32] >> (bit % 32)) & 0xf;
        int rem = bits - bit;
        if (rem < 4) nib &= (1u << rem) - 1;
        if (s.empty() && nib == 0) continue;
        s += digits[nib];
    }}
    return s.empty() ? "0" : s;
}}
static std::string hexq(uint64_t v, int bits) {{
    uint32_t w[2] = {{(uint32_t)v, (uint32_t)(v >> 32)}};
    return hexw(w, 2, bits);
}}
'''

TORTURE_MAIN = r'''
int main(int argc, char** argv) {{
    VerilatedContext* ctx = new VerilatedContext;
    ctx->commandArgs(argc, argv);
    V{top}* top = new V{top}{{ctx}};
    FILE* f = fopen(argv[1], "w");
    fprintf(f, "[\n");
    for (int cyc = 0; cyc < {cycles}; ++cyc) {{
        bool rst = {reset_expr};
        top->rst_n = rst ? 0 : 1;
        {set_inputs}
        for (int half = 0; half < 2; ++half) {{
            top->clk = half;
            top->eval();
            fprintf(f, "%s[", (cyc || half) ? ",\n" : "");
            {dump_outputs}
            fprintf(f, "]");
        }}
    }}
    fprintf(f, "\n]\n");
    fclose(f);
    top->final();
    delete top;
    delete ctx;
    return 0;
}}
'''

VGA_MAIN = r'''
int main(int argc, char** argv) {{
    VerilatedContext* ctx = new VerilatedContext;
    ctx->commandArgs(argc, argv);
    V{top}* top = new V{top}{{ctx}};
    FILE* f = fopen(argv[1], "w");
    uint32_t h = 2166136261u;
    top->ena = 1;
    top->ui_in = {ui_in};
    top->uio_in = 0;
    top->rst_n = 0;
    fprintf(f, "[");
    const long total = {cycles};
    for (long cyc = 0; cyc < total; ++cyc) {{
        if (cyc == {reset_cycles}) top->rst_n = 1;
        top->clk = 0;
        top->eval();
        top->clk = 1;
        top->eval();
        const uint8_t bytes[3] = {{top->uo_out, top->uio_out, top->uio_oe}};
        for (int i = 0; i < 3; ++i) {{
            h ^= bytes[i];
            h *= 16777619u;
        }}
        if (((cyc + 1) % {every}) == 0 || cyc + 1 == total) {{
            fprintf(f, "%s\"%08x\"", cyc + 1 == {every} ? "" : ",", h);
        }}
    }}
    fprintf(f, "]\n");
    fclose(f);
    delete top;
    delete ctx;
    return 0;
}}
'''


def run(cmd, cwd=None):
    res = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if res.returncode != 0:
        sys.stderr.write(res.stdout)
        raise SystemExit(f'command failed: {" ".join(cmd)}')
    return res.stdout


def verilate(verilator, workdir, top, files, harness, extra_flags):
    cpp = os.path.join(workdir, 'harness.cpp')
    with open(cpp, 'w') as f:
        f.write(harness)
    run([verilator, '--cc', '--exe', '--build', '-j', '0', '--Mdir', os.path.join(workdir, 'obj'),
         *VERILATOR_FLAGS, *extra_flags, '--top-module', top, *files, cpp])
    return os.path.join(workdir, 'obj', f'V{top}')


def ports_of(verilator, workdir, top, files, extra_flags):
    """Run verilator once (lint+cc) to discover the port list from the header."""
    mdir = os.path.join(workdir, 'ports')
    run([verilator, '--cc', '--Mdir', mdir, *VERILATOR_FLAGS, *extra_flags, '--top-module', top,
         *files])
    with open(os.path.join(mdir, f'V{top}.h')) as f:
        text = f.read()
    ports = []
    for m in PORT_RE.finditer(text):
        direction, _, name, msb, lsb = m.groups()
        ports.append({'name': name, 'dir': direction.lower(), 'width': int(msb) - int(lsb) + 1})
    return ports


def gen_torture(verilator, name, files, top=None, extra_flags=()):
    top = top or name
    with tempfile.TemporaryDirectory() as tmp:
        ports = ports_of(verilator, tmp, top, files, extra_flags)
        outputs = [p for p in ports if p['dir'] == 'out']
        inputs = {p['name']: p['width'] for p in ports if p['dir'] == 'in'}
        for required in ('clk', 'rst_n', 'a', 'b', 'c'):
            if required not in inputs:
                raise SystemExit(f'{name}: torture designs need a "{required}" input')
        set_inputs = '\n        '.join([
            f'top->a = xorshift64() & {mask(inputs["a"])};',
            f'top->b = xorshift64() & {mask(inputs["b"])};',
            f'top->c = xorshift64() & {mask(inputs["c"])};',
        ])
        dumps = []
        for i, p in enumerate(outputs):
            sep = '' if i == 0 else ','
            if p['width'] <= 64:
                expr = f'hexq((uint64_t)top->{p["name"]}, {p["width"]})'
            else:
                words = (p['width'] + 31) // 32
                expr = f'hexw(top->{p["name"]}.data(), {words}, {p["width"]})'
            dumps.append(f'fprintf(f, "{sep}\\"%s\\"", {expr}.c_str());')
        reset_expr = ' || '.join(f'(cyc >= {lo} && cyc < {hi})' for lo, hi in TORTURE_RESET)
        harness = HARNESS_COMMON.format(top=top) + TORTURE_MAIN.format(
            top=top, cycles=TORTURE_CYCLES, reset_expr=reset_expr, set_inputs=set_inputs,
            dump_outputs='\n            '.join(dumps))
        exe = verilate(verilator, tmp, top, files, harness, extra_flags)
        trace_file = os.path.join(tmp, 'trace.json')
        run([exe, trace_file])
        with open(trace_file) as f:
            trace = json.load(f)
    return {
        'kind': 'torture',
        'top': top,
        'cycles': TORTURE_CYCLES,
        'reset': TORTURE_RESET,
        'outputs': [{'name': p['name'], 'width': p['width']} for p in outputs],
        'trace': trace,
    }


def mask(width):
    return f'0x{(1 << width) - 1:x}ULL' if width < 64 else '0xffffffffffffffffULL'


def gen_vga(verilator, name, files, top, frames=EXAMPLE_FRAMES, ui_in=0, extra_flags=()):
    cycles = frames * VGA_CYCLES_PER_FRAME
    with tempfile.TemporaryDirectory() as tmp:
        harness = HARNESS_COMMON.format(top=top) + VGA_MAIN.format(
            top=top, cycles=cycles, reset_cycles=EXAMPLE_RESET_CYCLES, every=EXAMPLE_HASH_EVERY,
            ui_in=ui_in)
        exe = verilate(verilator, tmp, top, files, harness, extra_flags)
        trace_file = os.path.join(tmp, 'hashes.json')
        run([exe, trace_file])
        with open(trace_file) as f:
            hashes = json.load(f)
    return {
        'kind': 'vga',
        'top': top,
        'cycles': cycles,
        'resetCycles': EXAMPLE_RESET_CYCLES,
        'hashEvery': EXAMPLE_HASH_EVERY,
        'uiIn': ui_in,
        'hashes': hashes,
    }


def example_files(example):
    d = os.path.join(EXAMPLES, example)
    files = sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith('.v'))
    common = os.path.join(EXAMPLES, 'common')
    files += sorted(os.path.join(common, f) for f in os.listdir(common) if f.endswith('.v'))
    return files


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter,
                                 epilog=EXTRA_DESIGN_HELP)
    ap.add_argument('names', nargs='*', help='only regenerate these designs/examples')
    ap.add_argument('--extra', help='JSON file describing extra designs')
    ap.add_argument('--out', default=GOLDEN, help='output directory')
    args = ap.parse_args()

    verilator = os.environ.get('VERILATOR') or shutil.which('verilator')
    if not verilator:
        raise SystemExit('verilator not found (set VERILATOR=/path/to/verilator)')
    os.makedirs(args.out, exist_ok=True)

    jobs = []
    for f in sorted(os.listdir(HERE)):
        if f.startswith('t_') and f.endswith('.v'):
            name = f[:-2]
            jobs.append((name, lambda name=name, f=f: gen_torture(verilator, name,
                                                                   [os.path.join(HERE, f)])))
    for ex in sorted(os.listdir(EXAMPLES)):
        if os.path.exists(os.path.join(EXAMPLES, ex, 'project.v')):
            jobs.append((f'example_{ex}', lambda ex=ex: gen_vga(verilator, ex, example_files(ex),
                                                                'tt_um_vga_example')))
    if args.extra:
        with open(args.extra) as f:
            for d in json.load(f):
                flags = d.get('flags', [])
                if d.get('kind', 'vga') == 'vga':
                    jobs.append((d['name'], lambda d=d, flags=flags: gen_vga(
                        verilator, d['name'], d['files'], d['top'], d.get('frames', EXAMPLE_FRAMES),
                        d.get('uiIn', 0), flags)))
                else:
                    jobs.append((d['name'], lambda d=d, flags=flags: gen_torture(
                        verilator, d['name'], d['files'], d['top'], flags)))

    for name, job in jobs:
        if args.names and name not in args.names:
            continue
        print(f'generating {name} ...', flush=True)
        golden = job()
        with open(os.path.join(args.out, f'{name}.json'), 'w') as f:
            json.dump(golden, f, separators=(',', ':'))
            f.write('\n')


if __name__ == '__main__':
    main()
