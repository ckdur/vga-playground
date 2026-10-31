/**
 * Code generator tests at the IR level: every operator is checked against a
 * BigInt reference implementation of Verilator's semantics, for random
 * operands at many widths (narrow, 64-bit and wide).
 *
 * Verilator normally expands most wide operations into per-word code before
 * the JSON dump, so these tests also cover paths that real designs rarely hit.
 */
import { describe, expect, test } from 'vitest';
import { VExpr, VLogicType, VModel, VStmt, VType, VVar } from './hdltypes';
import { HDLModuleWASM } from './hdlwasm';

let ids = 0;
const logic = (width: number, signed = false): VLogicType => ({
  kind: 'logic',
  width,
  widthMin: width,
  signed,
});

function mkvar(name: string, type: VType, dir: VVar['dir'] = 'none'): VVar {
  return {
    id: `(V${ids++})`,
    name,
    origName: name,
    type,
    scope: 'global',
    byRef: false,
    dir,
    isPrimaryIO: dir !== 'none',
    isConst: false,
  };
}
const ref = (v: VVar): VExpr => ({ k: 'var', t: v.type, v });
const op = (o: string, t: VType, ...args: VExpr[]): VExpr => ({ k: 'op', op: o, t, args });
const cst = (t: VType, value: bigint): VExpr => ({ k: 'const', t, value });

function makeModel(vars: VVar[], body: VStmt[]): VModel {
  return {
    vars,
    funcs: [{ id: '(F)', name: '_eval', args: [], locals: [], body, ret: null }],
    warnings: [],
  };
}

/** deterministic random BigInt of 'width' bits, biased towards edge values */
function makeRng(seed = 12345n) {
  let s = seed;
  const next64 = () => {
    s ^= (s << 13n) & 0xffffffffffffffffn;
    s ^= s >> 7n;
    s ^= (s << 17n) & 0xffffffffffffffffn;
    return s;
  };
  return (width: number) => {
    const mask = (1n << BigInt(width)) - 1n;
    const kind = Number(next64() % 8n);
    if (kind === 0) return 0n;
    if (kind === 1) return mask;
    if (kind === 2) return 1n << BigInt(width - 1); // most negative
    if (kind === 3) return 1n;
    let v = 0n;
    for (let i = 0; i < width; i += 64) v = (v << 64n) | next64();
    if (kind === 4) v >>= BigInt(Number(next64() % BigInt(width))); // small values
    return v & mask;
  };
}

const WIDTHS = [1, 7, 8, 16, 31, 32, 33, 48, 63, 64, 65, 96, 100, 127, 128, 200, 256];
const SAMPLES = 40;

const mask = (w: number) => (1n << BigInt(w)) - 1n;
const toSigned = (v: bigint, w: number) => BigInt.asIntN(w, v);

type Ref = (a: bigint, b: bigint, w: number) => bigint;
const BINOPS: Record<string, Ref> = {
  add: (a, b, w) => (a + b) & mask(w),
  sub: (a, b, w) => (a - b) & mask(w),
  mul: (a, b, w) => (a * b) & mask(w),
  and: (a, b) => a & b,
  or: (a, b) => a | b,
  xor: (a, b) => a ^ b,
  div: (a, b) => (b === 0n ? 0n : a / b),
  moddiv: (a, b) => (b === 0n ? 0n : a % b),
  divs: (a, b, w) => {
    if (b === 0n) return 0n;
    if (w === 32 || w === 64) {
      // VL_DIVS_III/QQQ: -MAX / -1 is defined as 0
      if (a === 1n << BigInt(w - 1) && b === mask(w)) return 0n;
    }
    return (toSigned(a, w) / toSigned(b, w)) & mask(w);
  },
  moddivs: (a, b, w) => {
    if (b === 0n) return 0n;
    if ((w === 32 || w === 64) && a === 1n << BigInt(w - 1) && b === mask(w)) return 0n;
    return toSigned(a, w) % toSigned(b, w) & mask(w);
  },
  muls: (a, b, w) => (toSigned(a, w) * toSigned(b, w)) & mask(w),
};
const CMPOPS: Record<string, (a: bigint, b: bigint, w: number) => boolean> = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lts: (a, b, w) => toSigned(a, w) < toSigned(b, w),
  ltes: (a, b, w) => toSigned(a, w) <= toSigned(b, w),
  gts: (a, b, w) => toSigned(a, w) > toSigned(b, w),
  gtes: (a, b, w) => toSigned(a, w) >= toSigned(b, w),
};
const SHIFTS: Record<string, (a: bigint, n: number, w: number) => bigint> = {
  shiftl: (a, n, w) => (n >= w ? 0n : (a << BigInt(n)) & mask(w)),
  shiftr: (a, n, w) => (n >= w ? 0n : a >> BigInt(n)),
  shiftrs: (a, n, w) => (toSigned(a, w) >> BigInt(Math.min(n, w))) & mask(w),
};
const UNOPS: Record<string, (a: bigint, w: number) => bigint> = {
  not: (a, w) => ~a & mask(w),
  negate: (a, w) => -a & mask(w),
  redor: (a) => (a !== 0n ? 1n : 0n),
  redand: (a, w) => (a === mask(w) ? 1n : 0n),
  redxor: (a) => BigInt(a.toString(2).split('1').length % 2 === 0 ? 1 : 0),
};

describe('code generator vs. BigInt reference', () => {
  for (const w of WIDTHS) {
    test(`${w}-bit operators`, async () => {
      const t = logic(w);
      const a = mkvar('a', t, 'input');
      const b = mkvar('b', t, 'input');
      const n = mkvar('n', logic(32), 'input');
      const outs: { v: VVar; ref: (x: bigint, y: bigint, s: number) => bigint }[] = [];
      const body: VStmt[] = [];
      const add = (
        name: string,
        rt: VType,
        e: VExpr,
        r: (x: bigint, y: bigint, s: number) => bigint,
      ) => {
        const v = mkvar(name, rt, 'output');
        outs.push({ v, ref: r });
        body.push({ s: 'assign', lhs: ref(v), rhs: e });
      };
      for (const [name, r] of Object.entries(BINOPS)) {
        add(`o_${name}`, t, op(name, t, ref(a), ref(b)), (x, y) => r(x, y, w));
      }
      for (const [name, r] of Object.entries(CMPOPS)) {
        add(`o_${name}`, logic(1), op(name, logic(1), ref(a), ref(b)), (x, y) =>
          r(x, y, w) ? 1n : 0n,
        );
      }
      for (const [name, r] of Object.entries(SHIFTS)) {
        add(`o_${name}`, t, op(name, t, ref(a), ref(n)), (x, _y, s) => r(x, s, w));
        // shift by a constant
        const k = Math.max(0, Math.min(w - 1, 5 + (w >> 1)));
        add(`o_${name}_k`, t, op(name, t, ref(a), cst(logic(32), BigInt(k))), (x) => r(x, k, w));
      }
      for (const [name, r] of Object.entries(UNOPS)) {
        const rt = name.startsWith('red') ? logic(1) : t;
        add(`o_${name}`, rt, op(name, rt, ref(a)), (x) => r(x, w));
      }
      // conditional
      add('o_cond', t, op('cond', t, op('lt', logic(1), ref(a), ref(b)), ref(a), ref(b)), (x, y) =>
        x < y ? x : y,
      );
      // zero/sign extension to a wider type
      const wt = logic(w + 37);
      add('o_extend', wt, op('extend', wt, ref(a)), (x) => x);
      add('o_extends', wt, op('extends', wt, ref(a)), (x) => toSigned(x, w) & mask(w + 37));
      // concatenation and replication
      const ct = logic(2 * w);
      add('o_concat', ct, op('concat', ct, ref(a), ref(b)), (x, y) => (x << BigInt(w)) | y);
      const rt = logic(3 * w);
      add(
        'o_repl',
        rt,
        op('replicate', rt, ref(a), cst(logic(32), 3n)),
        (x) => (x << BigInt(2 * w)) | (x << BigInt(w)) | x,
      );

      const mod = new HDLModuleWASM(makeModel([a, b, n, ...outs.map((o) => o.v)], body));
      await mod.init();
      const rnd = makeRng(BigInt(w) * 7919n + 1n);
      const failures: string[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const x = rnd(w);
        const y = rnd(w);
        const s = [0, 1, 31, 32, 33, 63, 64, 65, w - 1, w, w + 1, 1000][i % 12] ?? 0;
        mod.state.a = x;
        mod.state.b = y;
        mod.state.n = Math.max(0, s);
        mod.eval();
        for (const o of outs) {
          const ow = (o.v.type as VLogicType).width;
          const expected = o.ref(x, y, Math.max(0, s)) & mask(ow);
          const actual = BigInt(mod.state[o.v.name]) & mask(ow);
          if (actual !== expected && failures.length < 10) {
            failures.push(
              `${o.v.name}(${x.toString(16)}, ${y.toString(16)}, n=${s}) = ${actual.toString(16)}, expected ${expected.toString(16)}`,
            );
          }
        }
      }
      mod.dispose();
      expect(failures).toEqual([]);
    });
  }

  test('arrays of wide elements, word selects and creset', async () => {
    const et = logic(100);
    const arr = mkvar('arr', { kind: 'array', elem: et, count: 4, lo: 0 });
    const idx = mkvar('idx', logic(2), 'input');
    const val = mkvar('val', et, 'input');
    const out = mkvar('out', et, 'output');
    const word = mkvar('word', logic(32), 'output');
    const sel = (e: VExpr) => op('arraysel', et, ref(arr), e);
    const body: VStmt[] = [
      { s: 'assign', lhs: sel(ref(idx)), rhs: op('add', et, ref(val), sel(ref(idx))) },
      { s: 'assign', lhs: ref(out), rhs: sel(ref(idx)) },
      {
        s: 'assign',
        lhs: ref(word),
        rhs: op('wordsel', logic(32), sel(ref(idx)), cst(logic(32), 3n)),
      },
    ];
    const mod = new HDLModuleWASM(makeModel([arr, idx, val, out, word], body));
    await mod.init();
    const v = (1n << 99n) | 0x123456789abcdefn;
    mod.state.idx = 2;
    mod.state.val = v;
    mod.eval();
    mod.eval();
    expect(mod.state.out).toBe((2n * v) & mask(100));
    expect(mod.state.word).toBe(Number(((2n * v) >> 96n) & 0xffffffffn));
    mod.state.idx = 1;
    mod.eval();
    expect(mod.state.out).toBe(v);
  });

  test('functions with by-value, by-reference and returned values', async () => {
    const t = logic(16);
    const x = mkvar('x', t, 'input');
    const y = mkvar('y', t, 'output');
    const z = mkvar('z', logic(64), 'output');
    // u16 f(u16 p, u64& r) { r = p * 3; return p + 1; }
    const p: VVar = { ...mkvar('p', t), scope: 'arg' };
    const r: VVar = { ...mkvar('r', logic(64)), scope: 'arg', byRef: true, dir: 'inout' };
    const f = {
      id: '(G)',
      name: 'f',
      args: [p, r],
      locals: [],
      ret: t,
      body: [
        {
          s: 'assign',
          lhs: ref(r),
          rhs: op('mul', logic(64), op('extend', logic(64), ref(p)), cst(logic(64), 3n)),
        },
        { s: 'return', value: op('add', t, ref(p), cst(t, 1n)) },
      ] as VStmt[],
    };
    const call: VExpr = { k: 'call', t, func: f, args: [ref(x), ref(z)] };
    const model: VModel = {
      vars: [x, y, z],
      funcs: [
        f,
        {
          id: '(F)',
          name: '_eval',
          args: [],
          locals: [],
          ret: null,
          body: [{ s: 'assign', lhs: ref(y), rhs: call }],
        },
      ],
      warnings: [],
    };
    const mod = new HDLModuleWASM(model);
    await mod.init();
    mod.state.x = 0xffff;
    mod.eval();
    expect(mod.state.y).toBe(0);
    expect(mod.state.z).toBe(0xffffn * 3n);
  });

  test('loops with looptest and jump blocks', async () => {
    const t = logic(32);
    const n = mkvar('n', t, 'input');
    const sum = mkvar('sum', t, 'output');
    const i: VVar = { ...mkvar('i', t), scope: 'local' };
    // sum = 0; i = 0; loop { looptest(i < n); sum += i; if (i == 100) jumpgo; i++ }
    const body: VStmt[] = [
      { s: 'assign', lhs: ref(sum), rhs: cst(t, 0n) },
      { s: 'assign', lhs: ref(i), rhs: cst(t, 0n) },
      {
        s: 'jumpblock',
        id: 'J1',
        body: [
          {
            s: 'loop',
            body: [
              { s: 'looptest', cond: op('lt', logic(1), ref(i), ref(n)) },
              { s: 'assign', lhs: ref(sum), rhs: op('add', t, ref(sum), ref(i)) },
              {
                s: 'if',
                cond: op('eq', logic(1), ref(i), cst(t, 100n)),
                then: [{ s: 'jumpgo', id: 'J1' }],
                else: [],
              },
              { s: 'assign', lhs: ref(i), rhs: op('add', t, ref(i), cst(t, 1n)) },
            ],
          },
        ],
      },
    ];
    const model = makeModel([n, sum], body);
    model.funcs[0].locals.push(i);
    const mod = new HDLModuleWASM(model);
    await mod.init();
    mod.state.n = 10;
    mod.eval();
    expect(mod.state.sum).toBe(45);
    mod.state.n = 1000;
    mod.eval();
    expect(mod.state.sum).toBe(5050);
  });

  test('fatal errors stop the simulation with a message', async () => {
    const body: VStmt[] = [{ s: 'fatal', msg: 'DIDNOTCONVERGE: test' }];
    const mod = new HDLModuleWASM(makeModel([mkvar('o', logic(8), 'output')], body));
    await mod.init();
    expect(() => mod.eval()).toThrow(/DIDNOTCONVERGE: test/);
    expect(mod.isStopped()).toBe(true);
  });
});
