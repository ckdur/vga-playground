/**
 * Torture tests: compares the WASM simulator against golden traces produced
 * by native (C++) Verilator. See src/sim/torture/gen_golden.py.
 *
 *  - torture designs (src/sim/torture/t_*.v): every output, every clock edge
 *  - VGA examples (src/examples/*): hash of uo_out/uio_out/uio_oe for 2 frames
 *
 * Extra designs (e.g. a Tiny Tapeout project and its gate-level netlist) can be
 * checked by pointing VGA_PLAYGROUND_EXTRA_GOLDEN to a manifest file, see
 * src/sim/torture/README.md.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { compileVerilator } from '../verilator/compile';
import { HDLModuleWASM } from './hdlwasm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const verilatorWasmBinary = readFileSync(resolve(__dirname, '../verilator/verilator_bin.wasm'));
const TORTURE_DIR = resolve(__dirname, 'torture');
const GOLDEN_DIR = resolve(TORTURE_DIR, 'golden');
const EXAMPLES_DIR = resolve(__dirname, '../examples');

const originalExit = process.exit;
beforeAll(() => {
  process.setMaxListeners(50);
  process.exit = vi.fn((code?: number) => {
    throw new Error(`process.exit called with code ${code}`);
  }) as any;
});
afterAll(() => {
  process.exit = originalExit;
});

interface TortureGolden {
  kind: 'torture';
  top: string;
  cycles: number;
  reset: [number, number][];
  outputs: { name: string; width: number }[];
  trace: string[][];
}

interface VGAGolden {
  kind: 'vga';
  top: string;
  cycles: number;
  resetCycles: number;
  hashEvery: number;
  uiIn: number;
  hashes: string[];
}

async function build(top: string, sources: Record<string, string>, extraArgs: string[] = []) {
  const res = await compileVerilator({
    topModule: top,
    sources,
    wasmBinary: verilatorWasmBinary,
    extraArgs,
  });
  if (!res.output) {
    throw new Error(
      `Compilation failed:\n${res.errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join('\n')}`,
    );
  }
  const mod = new HDLModuleWASM(res.output);
  await mod.init();
  return mod;
}

/** Same PRNG as the C++ harness */
function makeRng() {
  let s = 0x9e3779b97f4a7c15n;
  const M = (1n << 64n) - 1n;
  return () => {
    s ^= (s << 13n) & M;
    s ^= s >> 7n;
    s ^= (s << 17n) & M;
    return s;
  };
}

function hex(v: number | bigint, width: number) {
  return (BigInt(v) & ((1n << BigInt(width)) - 1n)).toString(16);
}

export async function runTorture(mod: HDLModuleWASM, golden: TortureGolden) {
  const rng = makeRng();
  const mismatches: string[] = [];
  for (let cyc = 0; cyc < golden.cycles; cyc++) {
    const rst = golden.reset.some(([lo, hi]) => cyc >= lo && cyc < hi);
    mod.state.rst_n = rst ? 0 : 1;
    mod.state.a = rng() & ((1n << 64n) - 1n);
    mod.state.b = rng();
    mod.state.c = Number(rng() & 0xffn);
    for (let half = 0; half < 2; half++) {
      mod.state.clk = half;
      mod.eval();
      const expected = golden.trace[cyc * 2 + half];
      golden.outputs.forEach((o, i) => {
        const actual = hex(mod.state[o.name], o.width);
        if (actual !== expected[i] && mismatches.length < 10) {
          mismatches.push(
            `cycle ${cyc}${half ? ' (clk=1)' : ' (clk=0)'}: ${o.name} = ${actual}, expected ${expected[i]}`,
          );
        }
      });
    }
    if (mismatches.length >= 10) break;
  }
  return mismatches;
}

export function runVGA(mod: HDLModuleWASM, golden: VGAGolden) {
  const uo = mod.globals.lookup('uo_out').offset;
  const uio = mod.globals.lookup('uio_out').offset;
  const oe = mod.globals.lookup('uio_oe').offset;
  const data = mod.data8;
  mod.state.ena = 1;
  mod.state.ui_in = golden.uiIn;
  mod.state.uio_in = 0;
  mod.state.rst_n = 0;
  let h = 2166136261;
  const hashes: string[] = [];
  for (let cyc = 0; cyc < golden.cycles; cyc++) {
    if (cyc === golden.resetCycles) mod.state.rst_n = 1;
    mod.tick2(1);
    for (const b of [data[uo], data[uio], data[oe]]) {
      h ^= b;
      h = Math.imul(h, 16777619) >>> 0;
    }
    if ((cyc + 1) % golden.hashEvery === 0 || cyc + 1 === golden.cycles) {
      hashes.push(h.toString(16).padStart(8, '0'));
    }
  }
  return hashes;
}

function firstHashMismatch(actual: string[], expected: string[], every: number) {
  const n = actual.findIndex((h, i) => h !== expected[i]);
  if (n < 0) return null;
  return `outputs diverge between cycles ${n * every} and ${(n + 1) * every}`;
}

function loadGoldens(dir: string) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({
      name: basename(f, '.json'),
      golden: JSON.parse(readFileSync(resolve(dir, f), 'utf8')),
    }));
}

function exampleSources(name: string) {
  const sources: Record<string, string> = {};
  for (const dir of [resolve(EXAMPLES_DIR, name), resolve(EXAMPLES_DIR, 'common')]) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.v')) sources[f] = readFileSync(resolve(dir, f), 'utf8');
    }
  }
  return sources;
}

const goldens = loadGoldens(GOLDEN_DIR);

describe('Torture designs vs. native Verilator', () => {
  for (const { name, golden } of goldens.filter((g) => g.golden.kind === 'torture')) {
    test(name, async () => {
      const src = readFileSync(resolve(TORTURE_DIR, `${name}.v`), 'utf8');
      const mod = await build(golden.top, { [`${name}.v`]: src });
      const mismatches = await runTorture(mod, golden);
      mod.dispose();
      expect(mismatches).toEqual([]);
    });
  }
});

describe('VGA examples vs. native Verilator', () => {
  for (const { name, golden } of goldens.filter((g) => g.golden.kind === 'vga')) {
    test(
      name,
      async () => {
        const mod = await build(golden.top, exampleSources(name.replace(/^example_/, '')));
        const hashes = runVGA(mod, golden);
        mod.dispose();
        expect(firstHashMismatch(hashes, golden.hashes, golden.hashEvery)).toBeNull();
      },
      60000,
    );
  }
});

// Extra designs, described by a manifest:
// [{ "name": "...", "top": "...", "files": [...], "golden": "path.json", "flags": [] }]
const extraManifest = process.env.VGA_PLAYGROUND_EXTRA_GOLDEN;
describe.skipIf(!extraManifest)('Extra designs vs. native Verilator', () => {
  const manifestPath = resolve(extraManifest ?? '.');
  const entries: {
    name: string;
    top: string;
    files: string[];
    golden: string;
    flags?: string[];
  }[] = extraManifest ? JSON.parse(readFileSync(manifestPath, 'utf8')) : [];
  for (const entry of entries) {
    test(
      entry.name,
      async () => {
        const base = dirname(manifestPath);
        const golden = JSON.parse(readFileSync(resolve(base, entry.golden), 'utf8'));
        const sources: Record<string, string> = {};
        for (const f of entry.files) sources[basename(f)] = readFileSync(resolve(base, f), 'utf8');
        const mod = await build(golden.top, sources, entry.flags ?? []);
        if (golden.kind === 'torture') {
          expect(await runTorture(mod, golden)).toEqual([]);
        } else {
          const hashes = runVGA(mod, golden);
          expect(firstHashMismatch(hashes, golden.hashes, golden.hashEvery)).toBeNull();
        }
        mod.dispose();
      },
      600000,
    );
  }
});
