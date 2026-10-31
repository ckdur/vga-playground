/**
 * Compiles a Verilated model (VModel, see vjsonparser.ts) into WebAssembly.
 *
 * The generated module mirrors the C++ that Verilator emits:
 *   - all design state lives in linear memory, at fixed addresses
 *   - every Verilator CFUNC becomes a WASM function
 *   - the scheduler (_eval, _eval_phase__act, _eval_nba, trigger vectors...)
 *     is compiled like any other function, so the full Verilator 5 scheduling
 *     semantics (ico/act/nba regions, derived clocks, convergence loops) are
 *     preserved
 *   - values up to 32 bits are i32, up to 64 bits i64, and wider values are
 *     arrays of 32-bit words in memory handled by the helpers in wasmlib.ts
 *
 * The module is generated as WAT text, parsed, validated and optimized by
 * binaryen, and then instantiated.
 */
import binaryen from 'binaryen';
import {
  HDLError,
  HDLModuleRunner,
  isArray,
  isLogic,
  isWide,
  numWords,
  typeAlign,
  typeSize,
  VExpr,
  VFunc,
  VInit,
  VLogicType,
  VModel,
  VStmt,
  VType,
  VVar,
} from './hdltypes';
import { helperScratchSize, wasmHelpers } from './wasmlib';

const TRACERECLEN = '$$treclen';
const TRACEOFS = '$$tofs';
const TRACEEND = '$$tend';
const TRACEBUF = '$$tbuf';
const DIDINIT = '$$didinit';

/** Numeric class of a value in WASM */
type Cls = 'i32' | 'i64';

function clsOf(t: VType): Cls {
  if (isLogic(t)) {
    if (t.width <= 32) return 'i32';
    if (t.width <= 64) return 'i64';
  }
  throw new HDLError(t, `type ${describeType(t)} is not a scalar`);
}

function bitsOf(c: Cls) {
  return c === 'i32' ? 32 : 64;
}

function describeType(t: VType): string {
  if (isLogic(t)) return `logic[${t.width}]${t.signed ? ' signed' : ''}`;
  if (isArray(t)) return `${describeType(t.elem)}[${t.count}]`;
  return t.name;
}

function isScalar(t: VType) {
  return isLogic(t) && t.width <= 64;
}

function i32c(n: number | bigint) {
  return `(i32.const ${Number(BigInt.asIntN(32, BigInt(n)))})`;
}

function i64c(n: number | bigint) {
  return `(i64.const ${BigInt.asIntN(64, BigInt(n)).toString()})`;
}

function constOf(c: Cls, n: number | bigint) {
  return c === 'i32' ? i32c(n) : i64c(n);
}

function coerce(code: string, from: Cls, to: Cls) {
  if (from === to) return code;
  if (from === 'i32') return `(i64.extend_i32_u ${code})`;
  return `(i32.wrap_i64 ${code})`;
}

function maskBits(width: number): bigint {
  return (1n << BigInt(width)) - 1n;
}

export interface StructRec {
  name: string;
  offset: number;
  size: number;
  type?: VType;
  v?: VVar;
}

/** Layout of the data segment */
class Struct {
  len = 0;
  vars: Record<string, StructRec> = {};

  alignTo(align: number) {
    while (this.len % align) this.len++;
  }

  alloc(size: number, align: number) {
    this.alignTo(Math.max(1, align));
    const offset = this.len;
    this.len += size;
    return offset;
  }

  addEntry(name: string, size: number, type?: VType, v?: VVar): StructRec {
    const offset = this.alloc(size, type ? typeAlign(type) : Math.min(size, 8));
    const rec: StructRec = { name, offset, size, type, v };
    this.vars[name] = rec;
    return rec;
  }

  lookup(name: string): StructRec {
    return this.vars[name];
  }
}

interface Options {
  maxMemoryMB?: number;
  /** run the binaryen optimizer (default: true) */
  optimize?: boolean;
}

// ---------------------------------------------------------------------------
// Code generator
// ---------------------------------------------------------------------------

interface FuncCtx {
  f: VFunc;
  locals: string[]; // extra local declarations
  tmpCount: number;
  labelCount: number;
  loopLabels: string[]; // innermost last
  /** memory-resident locals (wide, arrays, or passed by reference) */
  memLocals: Map<string, number>;
}

class WatGen {
  globals = new Struct();
  /** address of each memory-resident variable, by var id */
  varAddr = new Map<string, number>();
  /** initialized data: [offset, bytes] */
  data: [number, Uint8Array][] = [];
  wideConsts = new Map<string, number>();
  funcNames = new Map<string, string>();
  fatalMessages: string[] = [];
  maxWords = 2;
  outputbytes = 0;
  statebytes = 0;
  traceBufferSize: number;

  private ctx!: FuncCtx;
  private out: string[] = [];

  constructor(
    public model: VModel,
    traceBufferSize: number,
  ) {
    this.traceBufferSize = traceBufferSize;
  }

  generate(): string {
    this.layout();
    const funcs: string[] = [];
    for (const f of this.model.funcs) funcs.push(this.genFunc(f));
    // scratch area for the wide helpers, sized after code generation since
    // temporaries may be wider than any variable
    this.globals.alignTo(8);
    const scratch = this.globals.alloc(helperScratchSize(this.maxWords), 8);
    const helpers = wasmHelpers(scratch, this.maxWords);
    const membytes = this.globals.len;
    const pages = Math.ceil(membytes / 65536) + 1;
    const lines: string[] = [];
    lines.push('(module');
    lines.push('  (import "builtins" "finish" (func $__finish (param i32)))');
    lines.push('  (import "builtins" "stop" (func $__stop (param i32)))');
    lines.push('  (import "builtins" "fatal" (func $__fatal (param i32)))');
    lines.push('  (import "builtins" "time" (func $__time (result i64)))');
    lines.push('  (import "builtins" "random" (func $__random (result i32)))');
    lines.push(`  (memory $mem ${pages} ${pages})`);
    lines.push('  (export "memory" (memory $mem))');
    lines.push(helpers);
    lines.push(...funcs);
    lines.push(this.genDriver());
    for (const [offset, bytes] of this.data) {
      lines.push(`  (data (i32.const ${offset}) "${escapeBytes(bytes)}")`);
    }
    lines.push(')');
    return lines.join('\n');
  }

  // --- memory layout ---

  private layout() {
    const g = this.globals;
    const vars = this.model.vars;
    const sortKey = (v: VVar) => typeSize(v.type);
    for (const f of this.model.funcs) this.funcNames.set(f.id, f.name);
    // outputs first (contiguous, copied to the trace buffer)
    const outputs = vars
      .filter((v) => v.isPrimaryIO && v.dir === 'output' && !v.isConst)
      .sort((a, b) => sortKey(a) - sortKey(b));
    for (const v of outputs) this.addGlobal(v);
    if (g.len === 0) g.addEntry('___', 1);
    g.alignTo(8);
    this.outputbytes = g.len;
    // inputs and internal state
    const outSet = new Set(outputs);
    const state = vars.filter((v) => !outSet.has(v) && !v.isConst);
    state.sort((a, b) => sortKey(a) - sortKey(b));
    for (const v of state) this.addGlobal(v);
    g.addEntry(DIDINIT, 4);
    g.alignTo(8);
    this.statebytes = g.len;
    // constants (initialized by data segments, never cleared)
    for (const v of vars.filter((v) => v.isConst)) {
      const rec = this.addGlobal(v);
      if (v.init) this.data.push([rec.offset, this.initBytes(v.type, v.init)]);
    }
    // function locals that must live in memory
    for (const f of this.model.funcs) {
      const forceMem = new Set<string>();
      collectByRefArgs(f.body, forceMem);
      for (const v of f.locals) {
        if (!isScalar(v.type) || forceMem.has(v.id)) {
          const offset = g.alloc(Math.max(typeSize(v.type), 1), typeAlign(v.type));
          this.varAddr.set(v.id, offset);
        }
      }
    }
    for (const v of [...vars, ...this.model.funcs.flatMap((f) => [...f.args, ...f.locals])]) {
      if (isWide(v.type)) this.maxWords = Math.max(this.maxWords, numWords(v.type as VLogicType));
      if (isArray(v.type) && isWide(v.type.elem)) {
        this.maxWords = Math.max(this.maxWords, numWords(v.type.elem as VLogicType));
      }
    }
    // trace buffer
    g.alignTo(8);
    g.addEntry(TRACERECLEN, 4);
    g.addEntry(TRACEOFS, 4);
    g.addEntry(TRACEEND, 4);
    g.alignTo(8);
    g.addEntry(TRACEBUF, this.traceBufferSize);
    // the code generator allocates wide temporaries after this point
  }

  private addGlobal(v: VVar) {
    const size = Math.max(typeSize(v.type), 1);
    const rec = this.globals.addEntry(v.name, size, v.type, v);
    this.varAddr.set(v.id, rec.offset);
    return rec;
  }

  private initBytes(t: VType, init: VInit): Uint8Array {
    const bytes = new Uint8Array(typeSize(t));
    const write = (tt: VType, ini: VInit | undefined, base: number) => {
      if (!ini) return;
      if (isArray(tt)) {
        const es = typeSize(tt.elem);
        for (let i = 0; i < tt.count; i++) {
          const item = ini.kind === 'array' ? ini.items.get(i) ?? ini.dflt : ini;
          write(tt.elem, item, base + i * es);
        }
      } else if (isLogic(tt) && ini.kind === 'const') {
        let value = ini.value & maskBits(Math.max(typeSize(tt) * 8, 8));
        for (let i = 0; i < typeSize(tt); i++) {
          bytes[base + i] = Number(value & 0xffn);
          value >>= 8n;
        }
      }
    };
    write(t, init, 0);
    return bytes;
  }

  /** allocate a temporary for a wide value (static, never recursive) */
  private allocWide(words: number) {
    this.maxWords = Math.max(this.maxWords, words);
    return this.globals.alloc(words * 4, 8);
  }

  private wideConst(value: bigint, words: number) {
    const key = `${words}:${value.toString(16)}`;
    let addr = this.wideConsts.get(key);
    if (addr === undefined) {
      addr = this.allocWide(words);
      const bytes = new Uint8Array(words * 4);
      let v = value;
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      this.data.push([addr, bytes]);
      this.wideConsts.set(key, addr);
    }
    return addr;
  }

  // --- functions ---

  private genFunc(f: VFunc): string {
    this.ctx = {
      f,
      locals: [],
      tmpCount: 0,
      labelCount: 0,
      loopLabels: [],
      memLocals: new Map(),
    };
    const params: string[] = [];
    for (const a of f.args) {
      if (a.byRef || !isScalar(a.type)) params.push(`(param ${this.localName(a)} i32)`);
      else params.push(`(param ${this.localName(a)} ${clsOf(a.type)})`);
    }
    for (const v of f.locals) {
      if (this.varAddr.has(v.id)) continue; // in memory
      this.ctx.locals.push(`(local ${this.localName(v)} ${clsOf(v.type)})`);
    }
    const result = f.ret ? `(result ${clsOf(f.ret)})` : '';
    const body = this.stmts(f.body);
    const tail = f.ret ? '\n    (unreachable)' : '';
    return `  (func $${f.name} ${params.join(' ')} ${result}\n    ${this.ctx.locals.join(' ')}\n    ${body}${tail})`;
  }

  private localName(v: VVar) {
    return `$v_${v.id.replace(/[^a-zA-Z0-9_]/g, '')}`;
  }

  private tmp(cls: Cls) {
    const name = `$t${this.ctx.tmpCount++}`;
    this.ctx.locals.push(`(local ${name} ${cls})`);
    return name;
  }

  private label(prefix: string) {
    return `$${prefix}${this.ctx.labelCount++}`;
  }

  // --- statements ---

  private stmts(list: VStmt[]): string {
    return list.map((s) => this.stmt(s)).join('\n    ');
  }

  private stmt(s: VStmt): string {
    switch (s.s) {
      case 'assign':
        return this.assign(s.lhs, s.rhs);
      case 'creset':
        return this.creset(s.lhs);
      case 'if': {
        const els = s.else.length ? ` (else ${this.stmts(s.else)})` : '';
        return `(if ${this.cond(s.cond)} (then ${this.stmts(s.then)})${els})`;
      }
      case 'loop': {
        const brk = this.label('brk');
        const cont = this.label('cont');
        this.ctx.loopLabels.push(brk);
        const body = this.stmts(s.body);
        this.ctx.loopLabels.pop();
        return `(block ${brk} (loop ${cont} ${body} (br ${cont})))`;
      }
      case 'looptest': {
        const brk = this.ctx.loopLabels[this.ctx.loopLabels.length - 1];
        if (!brk) throw new HDLError(s, 'LOOPTEST outside of a loop');
        return `(br_if ${brk} (i32.eqz ${this.cond(s.cond)}))`;
      }
      case 'jumpblock':
        return `(block $jb_${s.id.replace(/[^a-zA-Z0-9_]/g, '')} ${this.stmts(s.body)})`;
      case 'jumpgo':
        return `(br $jb_${s.id.replace(/[^a-zA-Z0-9_]/g, '')})`;
      case 'return': {
        const f = this.ctx.f;
        if (!s.value || !f.ret) return '(return)';
        return `(return ${this.exAs(s.value, clsOf(f.ret))})`;
      }
      case 'expr': {
        const e = s.e;
        if (e.k === 'call') {
          const code = this.call(e);
          return e.func.ret ? `(drop ${code})` : code;
        }
        if (isScalar(e.t)) return `(drop ${this.ex(e)})`;
        return '(nop)';
      }
      case 'fatal': {
        this.fatalMessages.push(s.msg + (s.loc ? ` (line ${s.loc.line})` : ''));
        return `(call $__fatal ${i32c(this.fatalMessages.length - 1)}) (unreachable)`;
      }
      case 'finish':
        return `(call $__finish ${i32c(s.loc?.line ?? 0)})`;
      case 'stop':
        return `(call $__stop ${i32c(s.loc?.line ?? 0)})`;
    }
  }

  /** i32 boolean for a condition */
  private cond(e: VExpr): string {
    if (isWide(e.t))
      return `(call $w_redor ${this.wideAddr(e)} ${i32c(numWords(e.t as VLogicType))})`;
    const c = clsOf(e.t);
    const code = this.ex(e);
    return c === 'i32' ? code : `(i64.ne ${code} (i64.const 0))`;
  }

  private assign(lhs: VExpr, rhs: VExpr): string {
    const t = lhs.t;
    if (isArray(t)) {
      return `(memory.copy ${this.lvAddr(lhs)} ${this.addrOf(rhs)} ${i32c(typeSize(t))})`;
    }
    if (isWide(t)) {
      const words = numWords(t as VLogicType);
      const dst = this.lvAddr(lhs);
      // compute directly into the destination when it can't alias the sources
      if (rhs.k === 'op' && lhs.k === 'var' && !exprUsesVar(rhs, lhs.v)) {
        return this.wideInto(rhs, dst, words);
      }
      return `(call $w_copy ${dst} ${this.wideAddr(rhs)} ${i32c(words)})`;
    }
    const cls = clsOf(t);
    let value = this.exAs(rhs, cls);
    if (lhs.k === 'var' && !this.isMemVar(lhs.v)) {
      // emulate C storage truncation for CData/SData locals
      const size = typeSize(t);
      if (size < 4) value = `(i32.and ${value} ${i32c(size === 1 ? 0xff : 0xffff)})`;
      return `(local.set ${this.localName(lhs.v)} ${value})`;
    }
    return this.store(this.lvAddr(lhs), typeSize(t), cls, value);
  }

  private creset(lhs: VExpr): string {
    const t = lhs.t;
    if (isArray(t) || isWide(t)) {
      return `(memory.fill ${this.lvAddr(lhs)} (i32.const 0) ${i32c(typeSize(t))})`;
    }
    if (!isScalar(t)) return '(nop)';
    const cls = clsOf(t);
    if (lhs.k === 'var' && !this.isMemVar(lhs.v)) {
      return `(local.set ${this.localName(lhs.v)} ${constOf(cls, 0)})`;
    }
    return this.store(this.lvAddr(lhs), typeSize(t), cls, constOf(cls, 0));
  }

  private store(addr: string, size: number, cls: Cls, value: string) {
    switch (size) {
      case 1:
        return `(i32.store8 ${addr} ${value})`;
      case 2:
        return `(i32.store16 ${addr} ${value})`;
      case 4:
        return `(i32.store ${addr} ${value})`;
      case 8:
        return `(i64.store ${addr} ${value})`;
    }
    throw new Error(`bad store size ${size} (${cls})`);
  }

  private load(addr: string, t: VType) {
    switch (typeSize(t)) {
      case 1:
        return `(i32.load8_u ${addr})`;
      case 2:
        return `(i32.load16_u ${addr})`;
      case 4:
        return `(i32.load ${addr})`;
      case 8:
        return `(i64.load ${addr})`;
    }
    throw new HDLError(t, `cannot load ${describeType(t)}`);
  }

  // --- variables and addresses ---

  private isMemVar(v: VVar) {
    if (v.scope === 'arg') return v.byRef || !isScalar(v.type);
    return this.varAddr.has(v.id);
  }

  private varAddrCode(v: VVar): string {
    if (v.scope === 'arg') {
      if (!this.isMemVar(v)) throw new HDLError(v, `argument ${v.name} has no address`);
      return `(local.get ${this.localName(v)})`;
    }
    const addr = this.varAddr.get(v.id);
    if (addr === undefined) throw new HDLError(v, `variable ${v.name} has no address`);
    return i32c(addr);
  }

  /** Address of an lvalue (variable, array element, word of a wide value) */
  private lvAddr(e: VExpr): string {
    if (e.k === 'var') return this.varAddrCode(e.v);
    if (e.k === 'op' && e.op === 'arraysel') {
      const [from, idx] = e.args;
      if (!isArray(from.t)) throw new HDLError(e, `ARRAYSEL on non-array ${describeType(from.t)}`);
      const es = typeSize(from.t.elem);
      return this.indexAddr(this.lvAddr(from), idx, es);
    }
    if (e.k === 'op' && e.op === 'wordsel') {
      const [from, idx] = e.args;
      return this.indexAddr(this.wideAddr(from), idx, 4);
    }
    throw new HDLError(e, `cannot take the address of ${e.k === 'op' ? e.op : e.k}`);
  }

  private indexAddr(base: string, idx: VExpr, elsize: number) {
    if (idx.k === 'const') {
      const off = Number(idx.value) * elsize;
      return off ? `(i32.add ${base} ${i32c(off)})` : base;
    }
    return `(i32.add ${base} (i32.mul ${this.exAs(idx, 'i32')} ${i32c(elsize)}))`;
  }

  /** Address of any value that lives (or can be materialized) in memory */
  private addrOf(e: VExpr): string {
    if (e.k === 'var' || (e.k === 'op' && (e.op === 'arraysel' || e.op === 'wordsel'))) {
      if (e.k !== 'var' || this.isMemVar(e.v)) return this.lvAddr(e);
    }
    if (isWide(e.t)) return this.wideAddr(e);
    if (isScalar(e.t)) {
      // materialize a scalar into a temporary memory slot
      const size = typeSize(e.t);
      const addr = this.globals.alloc(size, size);
      return `(block (result i32) ${this.store(i32c(addr), size, clsOf(e.t), this.ex(e))} ${i32c(addr)})`;
    }
    throw new HDLError(e, `cannot take the address of ${describeType(e.t)}`);
  }

  // --- scalar expressions ---

  /** evaluate e in its natural class */
  private ex(e: VExpr): string {
    if (!isScalar(e.t)) {
      throw new HDLError(e, `expected a scalar value, got ${describeType(e.t)}`);
    }
    return this.exAs(e, clsOf(e.t));
  }

  /** evaluate e (scalar or wide) as cls (wide values are truncated) */
  private exAs(e: VExpr, cls: Cls): string {
    if (isWide(e.t)) {
      const addr = this.wideAddr(e);
      return cls === 'i32' ? `(i32.load ${addr})` : `(i64.load ${addr})`;
    }
    if (!isScalar(e.t)) throw new HDLError(e, `expected a scalar value, got ${describeType(e.t)}`);
    const nat = clsOf(e.t);
    return coerce(this.exNat(e), nat, cls);
  }

  private exNat(e: VExpr): string {
    const cls = clsOf(e.t);
    switch (e.k) {
      case 'const':
        return constOf(cls, e.value);
      case 'var':
        if (this.isMemVar(e.v)) return this.load(this.varAddrCode(e.v), e.v.type);
        return `(local.get ${this.localName(e.v)})`;
      case 'call':
        return this.coerceCall(e, cls);
      case 'sys':
        if (e.name === '$time') return coerce('(call $__time)', 'i64', cls);
        if (e.name === '$random') return coerce('(call $__random)', 'i32', cls);
        throw new HDLError(e, `unsupported system function ${e.name}`);
      case 'op':
        return this.op(e.op, e.args, e.t as VLogicType, e);
    }
  }

  private coerceCall(e: VExpr & { k: 'call' }, cls: Cls) {
    if (!e.func.ret) throw new HDLError(e, `function ${e.func.name} returns no value`);
    return coerce(this.call(e), clsOf(e.func.ret), cls);
  }

  private call(e: VExpr & { k: 'call' }): string {
    const f = e.func;
    const args = f.args.map((p, i) => {
      const a = e.args[i];
      if (!a) throw new HDLError(e, `missing argument ${p.name} calling ${f.name}`);
      if (p.byRef || !isScalar(p.type)) return this.addrOf(a);
      return this.exAs(a, clsOf(p.type));
    });
    return `(call $${f.name} ${args.join(' ')})`;
  }

  private op(op: string, args: VExpr[], t: VLogicType, e: VExpr): string {
    const cls = clsOf(t);
    const I = cls; // instruction prefix
    const [a, b] = args;
    const bin = (inst: string) => `(${I}.${inst} ${this.exAs(a, cls)} ${this.exAs(b, cls)})`;
    switch (op) {
      case 'add':
        return bin('add');
      case 'sub':
        return bin('sub');
      case 'mul':
        return bin('mul');
      case 'and':
        return bin('and');
      case 'or':
        return bin('or');
      case 'xor':
        return bin('xor');
      case 'div':
        return `(call $divu${bitsOf(cls)} ${this.exAs(a, cls)} ${this.exAs(b, cls)})`;
      case 'moddiv':
        return `(call $remu${bitsOf(cls)} ${this.exAs(a, cls)} ${this.exAs(b, cls)})`;
      case 'divs':
      case 'moddivs':
      case 'muls': {
        const lbits = widthMinOf(a);
        const sa = this.sext(this.exAs(a, cls), cls, lbits);
        const sb = this.sext(this.exAs(b, cls), cls, lbits);
        if (op === 'muls') return `(${I}.mul ${sa} ${sb})`;
        return `(call $${op === 'divs' ? 'divs' : 'rems'}${bitsOf(cls)} ${sa} ${sb})`;
      }
      case 'pow':
        return `(call $powu${bitsOf(cls)} ${this.exAs(a, cls)} ${this.exAs(b, cls)})`;
      case 'not':
        return `(${I}.xor ${this.exAs(a, cls)} ${constOf(cls, -1)})`;
      case 'negate':
        return `(${I}.sub ${constOf(cls, 0)} ${this.exAs(a, cls)})`;
      case 'ccast':
      case 'extend':
        return this.exAs(a, cls);
      case 'extends': {
        if (isWide(a.t)) return this.exAs(a, cls);
        return this.sext(this.exAs(a, cls), cls, widthMinOf(a));
      }
      case 'lognot':
        return coerce(`(i32.eqz ${this.cond(a)})`, 'i32', cls);
      case 'logand':
        return coerce(
          `(i32.and (i32.ne ${this.cond(a)} (i32.const 0)) (i32.ne ${this.cond(b)} (i32.const 0)))`,
          'i32',
          cls,
        );
      case 'logor':
        return coerce(
          `(i32.or (i32.ne ${this.cond(a)} (i32.const 0)) (i32.ne ${this.cond(b)} (i32.const 0)))`,
          'i32',
          cls,
        );
      case 'logif':
        return coerce(
          `(i32.or (i32.eqz ${this.cond(a)}) (i32.ne ${this.cond(b)} (i32.const 0)))`,
          'i32',
          cls,
        );
      case 'logeq':
        return coerce(
          `(i32.eq (i32.ne ${this.cond(a)} (i32.const 0)) (i32.ne ${this.cond(b)} (i32.const 0)))`,
          'i32',
          cls,
        );
      case 'redor':
        return coerce(`(i32.ne ${this.cond(a)} (i32.const 0))`, 'i32', cls);
      case 'redxor': {
        if (isWide(a.t)) {
          return coerce(
            `(call $w_redxor ${this.wideAddr(a)} ${i32c(numWords(a.t as VLogicType))})`,
            'i32',
            cls,
          );
        }
        const ac = clsOf(a.t);
        return coerce(`(${ac}.and (${ac}.popcnt ${this.ex(a)}) ${constOf(ac, 1)})`, ac, cls);
      }
      case 'redand': {
        const w = (a.t as VLogicType).width;
        if (isWide(a.t))
          return coerce(`(call $w_redand ${this.wideAddr(a)} ${i32c(w)})`, 'i32', cls);
        const ac = clsOf(a.t);
        const m = constOf(ac, maskBits(w));
        return coerce(`(${ac}.eq (${ac}.and ${this.ex(a)} ${m}) ${m})`, 'i32', cls);
      }
      case 'countones': {
        if (isWide(a.t))
          return coerce(
            `(call $w_popcnt ${this.wideAddr(a)} ${i32c(numWords(a.t as VLogicType))})`,
            'i32',
            cls,
          );
        const ac = clsOf(a.t);
        return coerce(`(${ac}.popcnt ${this.ex(a)})`, ac, cls);
      }
      case 'onehot':
      case 'onehot0': {
        const ac = isWide(a.t) ? null : clsOf(a.t);
        if (!ac) throw new HDLError(e, `${op} on wide values is not supported`);
        const cmp = op === 'onehot' ? 'eq' : 'le_u';
        return coerce(`(${ac}.${cmp} (${ac}.popcnt ${this.ex(a)}) ${constOf(ac, 1)})`, 'i32', cls);
      }
      case 'eq':
      case 'neq':
      case 'eqcase':
      case 'neqcase':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
        return coerce(this.compare(op.replace('case', ''), a, b, false), 'i32', cls);
      case 'lts':
      case 'ltes':
      case 'gts':
      case 'gtes':
        return coerce(this.compare(op.slice(0, -1), a, b, true), 'i32', cls);
      case 'shiftl':
      case 'shiftlovr':
      case 'shiftr':
      case 'shiftrovr': {
        // operate in the wider of the operand and result classes
        const lc = isWide(a.t) ? 'i64' : clsOf(a.t);
        const oc: Cls = lc === 'i64' || cls === 'i64' ? 'i64' : 'i32';
        const dir = op.startsWith('shiftl') ? 'shl' : 'shr';
        if (b.k === 'const' && b.value < BigInt(bitsOf(oc))) {
          const inst = dir === 'shl' ? 'shl' : 'shr_u';
          return coerce(`(${oc}.${inst} ${this.exAs(a, oc)} ${constOf(oc, b.value)})`, oc, cls);
        }
        return coerce(`(call $${dir}${bitsOf(oc)} ${this.exAs(a, oc)} ${this.shamt(b)})`, oc, cls);
      }
      case 'shiftrs':
      case 'shiftrsovr': {
        const lc = isWide(a.t) ? 'i64' : clsOf(a.t);
        const oc: Cls = lc === 'i64' || cls === 'i64' ? 'i64' : 'i32';
        const lbits = widthMinOf(a);
        return coerce(
          `(call $shrs${bitsOf(oc)} ${this.exAs(a, oc)} ${this.shamt(b)} ${i32c(t.widthMin)} ${i32c(lbits)})`,
          oc,
          cls,
        );
      }
      case 'cond': {
        const [c, x, y] = args;
        return `(if (result ${cls}) ${this.cond(c)} (then ${this.exAs(x, cls)}) (else ${this.exAs(y, cls)}))`;
      }
      case 'arraysel': {
        const from = args[0];
        if (!isArray(from.t)) throw new HDLError(e, `ARRAYSEL on ${describeType(from.t)}`);
        return coerce(this.load(this.lvAddr(e), from.t.elem), clsOf(from.t.elem), cls);
      }
      case 'wordsel':
        return coerce(`(i32.load ${this.lvAddr(e)})`, 'i32', cls);
      case 'sel': {
        const [from, lsb] = args;
        const width = t.width;
        if (isWide(from.t)) {
          const bits = `(call $w_getbits ${this.wideAddr(from)} ${i32c(numWords(from.t as VLogicType))} ${this.exAs(lsb, 'i32')})`;
          return `(${cls}.and ${coerce(bits, 'i64', cls)} ${constOf(cls, maskBits(width))})`;
        }
        const fc = clsOf(from.t);
        const shifted = `(call $shr${bitsOf(fc)} ${this.ex(from)} ${this.exAs(lsb, 'i32')})`;
        return `(${cls}.and ${coerce(shifted, fc, cls)} ${constOf(cls, maskBits(width))})`;
      }
      case 'concat': {
        const rw = (b.t as VLogicType).width;
        if (rw >= bitsOf(cls)) return this.exAs(b, cls);
        return `(${I}.or (${I}.shl ${this.exAs(a, cls)} ${constOf(cls, rw)}) ${this.exAs(b, cls)})`;
      }
      case 'replicate': {
        const sw = (a.t as VLogicType).width;
        if (b.k !== 'const') throw new HDLError(e, 'replication count must be constant');
        const n = Number(b.value);
        if (n <= 0) return constOf(cls, 0);
        const src = this.tmp(cls);
        let acc = `(local.tee ${src} ${this.exAs(a, cls)})`;
        for (let i = 1; i < n; i++) {
          acc = `(${I}.or (${I}.shl ${acc} ${constOf(cls, sw)}) (local.get ${src}))`;
        }
        return acc;
      }
      default:
        throw new HDLError(e, `unsupported operation ${op} on ${describeType(t)}`);
    }
  }

  /** sign extend a value of class cls from lbits (VL_EXTENDS) */
  private sext(code: string, cls: Cls, lbits: number) {
    if (lbits >= bitsOf(cls)) return code;
    return `(call $sext${bitsOf(cls)} ${code} ${i32c(lbits)})`;
  }

  /** shift amount as an unsigned i32 (huge amounts saturate) */
  private shamt(e: VExpr): string {
    if (isWide(e.t))
      return `(call $w_shamt ${this.wideAddr(e)} ${i32c(numWords(e.t as VLogicType))})`;
    if (clsOf(e.t) === 'i64') return `(call $sat64 ${this.ex(e)})`;
    return this.ex(e);
  }

  private compare(op: string, a: VExpr, b: VExpr, signed: boolean): string {
    if (isWide(a.t) || isWide(b.t)) {
      const words = Math.max(wordsOf(a.t), wordsOf(b.t));
      const pa = this.wideAddrN(a, words);
      const pb = this.wideAddrN(b, words);
      if (op === 'eq') return `(call $w_eq ${pa} ${pb} ${i32c(words)})`;
      if (op === 'neq') return `(i32.eqz (call $w_eq ${pa} ${pb} ${i32c(words)}))`;
      const cmp = signed
        ? `(call $w_cmps ${pa} ${pb} ${i32c(widthMinOf(a))})`
        : `(call $w_cmp ${pa} ${pb} ${i32c(words)})`;
      const rel = { lt: 'lt_s', lte: 'le_s', gt: 'gt_s', gte: 'ge_s' }[op as 'lt'];
      return `(i32.${rel} ${cmp} (i32.const 0))`;
    }
    const cls: Cls = clsOf(a.t) === 'i64' || clsOf(b.t) === 'i64' ? 'i64' : 'i32';
    let pa = this.exAs(a, cls);
    let pb = this.exAs(b, cls);
    if (op === 'eq' || op === 'neq') return `(${cls}.${op === 'eq' ? 'eq' : 'ne'} ${pa} ${pb})`;
    const rel = { lt: 'lt', lte: 'le', gt: 'gt', gte: 'ge' }[op as 'lt'];
    if (signed) {
      // VL_LTS_III(lbits, ...): sign extend both operands from lbits
      const lbits = widthMinOf(a);
      pa = this.sext(pa, cls, lbits);
      pb = this.sext(pb, cls, lbits);
      return `(${cls}.${rel}_s ${pa} ${pb})`;
    }
    return `(${cls}.${rel}_u ${pa} ${pb})`;
  }

  // --- wide expressions ---

  /** address of a wide value with at least 'words' words (zero extended) */
  private wideAddrN(e: VExpr, words: number): string {
    if (isWide(e.t) && numWords(e.t as VLogicType) >= words) return this.wideAddr(e);
    const tmp = this.allocWide(words);
    return `(block (result i32) ${this.toWide(e, tmp, words, false)} ${i32c(tmp)})`;
  }

  /** store any value zero/sign-extended to 'words' words at dst */
  private toWide(e: VExpr, dst: number, words: number, signed: boolean): string {
    if (isWide(e.t)) {
      return `(call $w_extend ${i32c(dst)} ${i32c(words)} ${this.wideAddr(e)} ${i32c((e.t as VLogicType).width)} ${i32c(signed ? 1 : 0)})`;
    }
    const v = this.exAs(e, 'i64');
    if (signed) return `(call $w_sext64 ${i32c(dst)} ${i32c(words)} ${v} ${i32c(widthMinOf(e))})`;
    return `(call $w_from64 ${i32c(dst)} ${i32c(words)} ${v})`;
  }

  /** address where a wide value can be read */
  private wideAddr(e: VExpr): string {
    if (!isWide(e.t)) throw new HDLError(e, `expected a wide value, got ${describeType(e.t)}`);
    const words = numWords(e.t as VLogicType);
    switch (e.k) {
      case 'var':
        return this.varAddrCode(e.v);
      case 'const':
        return i32c(this.wideConst(e.value, words));
      case 'op':
        if (e.op === 'arraysel') return this.lvAddr(e);
        break;
      case 'call':
        throw new HDLError(e, `functions returning wide values are not supported`);
      case 'sys':
        throw new HDLError(e, `unsupported wide system function ${e.name}`);
    }
    const tmp = this.allocWide(words);
    return `(block (result i32) ${this.wideInto(e, i32c(tmp), words)} ${i32c(tmp)})`;
  }

  /** compute a wide operation into dst (an address expression, evaluated once) */
  private wideInto(e: VExpr, dstCode: string, words: number): string {
    if (e.k !== 'op') {
      return `(call $w_copy ${dstCode} ${this.wideAddr(e)} ${i32c(words)})`;
    }
    const t = e.t as VLogicType;
    const [a, b] = e.args;
    // dst may be an expression with side effects (array index): evaluate it once
    let pre = '';
    let dst = dstCode;
    if (!/^\(i32\.const -?\d+\)$/.test(dstCode)) {
      const d = this.tmp('i32');
      pre = `(local.set ${d} ${dstCode})`;
      dst = `(local.get ${d})`;
    }
    const W = i32c(words);
    const opA = () => this.wideAddrN(a, words);
    const opB = () => this.wideAddrN(b, words);
    let code: string;
    switch (e.op) {
      case 'add':
      case 'sub':
      case 'mul':
      case 'and':
      case 'or':
      case 'xor':
        code = `(call $w_${e.op} ${dst} ${opA()} ${opB()} ${W})`;
        break;
      case 'not':
        code = `(call $w_not ${dst} ${opA()} ${W})`;
        break;
      case 'negate':
        code = `(call $w_neg ${dst} ${opA()} ${W})`;
        break;
      case 'div':
      case 'moddiv':
        code = `(call $w_divmod ${dst} ${opA()} ${opB()} ${W} ${i32c(e.op === 'moddiv' ? 1 : 0)})`;
        break;
      case 'divs':
      case 'moddivs':
        code = `(call $w_divs ${dst} ${opA()} ${opB()} ${i32c(widthMinOf(a))} ${i32c(e.op === 'moddivs' ? 1 : 0)})`;
        break;
      case 'muls': {
        // signed multiply: |a| * |b|, negate if signs differ
        const lbits = widthMinOf(a);
        const ta = this.allocWide(words);
        const tb = this.allocWide(words);
        const neg = this.tmp('i32');
        const signOf = (p: string) =>
          `(i32.and (i32.shr_u (i32.load (i32.add ${p} ${i32c(((lbits - 1) >> 5) * 4)})) ${i32c((lbits - 1) & 31)}) (i32.const 1))`;
        code = `(call $w_copy ${i32c(ta)} ${opA()} ${W}) (call $w_copy ${i32c(tb)} ${opB()} ${W})
          (local.set ${neg} (i32.xor ${signOf(i32c(ta))} ${signOf(i32c(tb))}))
          (if ${signOf(i32c(ta))} (then (call $w_neg ${i32c(ta)} ${i32c(ta)} ${W}) (call $w_clean ${i32c(ta)} ${i32c(lbits)})))
          (if ${signOf(i32c(tb))} (then (call $w_neg ${i32c(tb)} ${i32c(tb)} ${W}) (call $w_clean ${i32c(tb)} ${i32c(lbits)})))
          (call $w_mul ${dst} ${i32c(ta)} ${i32c(tb)} ${W})
          (call $w_clean ${dst} ${i32c(lbits)})
          (if (local.get ${neg}) (then (call $w_neg ${dst} ${dst} ${W})))`;
        break;
      }
      case 'shiftl':
      case 'shiftlovr':
        code = `(call $w_shl ${dst} ${opA()} ${this.shamt(b)} ${i32c(t.widthMin)})`;
        break;
      case 'shiftr':
      case 'shiftrovr':
        code = `(call $w_shr ${dst} ${opA()} ${this.shamt(b)} ${i32c(t.widthMin)})`;
        break;
      case 'shiftrs':
      case 'shiftrsovr':
        code = `(call $w_shrs ${dst} ${opA()} ${this.shamt(b)} ${i32c(t.widthMin)} ${i32c(widthMinOf(a))})`;
        break;
      case 'ccast':
      case 'extend':
        code = this.toWideDyn(a, dst, words, false);
        break;
      case 'extends':
        code = this.toWideDyn(a, dst, words, true);
        break;
      case 'cond': {
        const [c, x, y] = e.args;
        code = `(if ${this.cond(c)} (then (call $w_copy ${dst} ${this.wideAddrN(x, words)} ${W}))
          (else (call $w_copy ${dst} ${this.wideAddrN(y, words)} ${W})))`;
        break;
      }
      case 'concat': {
        const rw = (b.t as VLogicType).width;
        const lw = (a.t as VLogicType).width;
        code = `(call $w_zero ${dst} ${W})
          (call $w_insert ${dst} (i32.const 0) ${i32c(rw)} ${this.wideAddrN(b, wordsOf(b.t))})
          (call $w_insert ${dst} ${i32c(rw)} ${i32c(lw)} ${this.wideAddrN(a, wordsOf(a.t))})`;
        break;
      }
      case 'replicate': {
        if (b.k !== 'const') throw new HDLError(e, 'replication count must be constant');
        const sw = (a.t as VLogicType).width;
        const src = this.tmp('i32');
        code = `(call $w_zero ${dst} ${W}) (local.set ${src} ${this.wideAddrN(a, wordsOf(a.t))})`;
        for (let i = 0; i < Number(b.value); i++) {
          code += ` (call $w_insert ${dst} ${i32c(i * sw)} ${i32c(sw)} (local.get ${src}))`;
        }
        break;
      }
      case 'sel': {
        const [from, lsb] = e.args;
        code = `(call $w_extract ${dst} ${W} ${this.wideAddrN(from, wordsOf(from.t))} ${i32c(wordsOf(from.t))} ${this.exAs(lsb, 'i32')})
          (call $w_clean ${dst} ${i32c(t.width)})`;
        break;
      }
      case 'arraysel':
        code = `(call $w_copy ${dst} ${this.lvAddr(e)} ${W})`;
        break;
      default:
        throw new HDLError(e, `unsupported operation ${e.op} on ${describeType(t)}`);
    }
    return pre + code;
  }

  private toWideDyn(e: VExpr, dst: string, words: number, signed: boolean) {
    if (isWide(e.t)) {
      return `(call $w_extend ${dst} ${i32c(words)} ${this.wideAddr(e)} ${i32c(widthMinOf(e))} ${i32c(signed ? 1 : 0)})`;
    }
    const v = this.exAs(e, 'i64');
    if (signed) return `(call $w_sext64 ${dst} ${i32c(words)} ${v} ${i32c(widthMinOf(e))})`;
    return `(call $w_from64 ${dst} ${i32c(words)} ${v})`;
  }

  // --- top level driver ---

  private genDriver(): string {
    const has = (name: string) => this.model.funcs.find((f) => f.name === name);
    const callIf = (name: string) => (has(name) ? `(call $${name})` : '');
    const didinit = this.globals.lookup(DIDINIT).offset;
    const t = (name: string) => this.globals.lookup(name).offset;
    const clk = this.globals.lookup('clk');
    const setClk = (v: number) =>
      clk
        ? this.store(i32c(clk.offset), clk.size, clsOf(clk.type!), constOf(clsOf(clk.type!), v))
        : '';
    return `
  (func $__ctor (export "ctor") ${callIf('_ctor_var_reset')})
  (func $__eval (export "eval")
    (if (i32.eqz (i32.load ${i32c(didinit)})) (then
      ${callIf('_eval_static')} ${callIf('_eval_initial')} ${callIf('_eval_settle')}
      (i32.store ${i32c(didinit)} (i32.const 1))))
    ${callIf('_eval')})
  (func $__final (export "final") ${callIf('_eval_final')})
  (func $copyTraceRec (local $src i32) (local $len i32) (local $dst i32)
    (local.set $len (i32.load ${i32c(t(TRACERECLEN))}))
    (local.set $dst (i32.load ${i32c(t(TRACEOFS))}))
    (memory.copy (local.get $dst) (i32.const 0) (local.get $len))
    (i32.store ${i32c(t(TRACEOFS))} (i32.add (local.get $dst) (local.get $len)))
    (if (i32.ge_u (i32.load ${i32c(t(TRACEOFS))}) (i32.load ${i32c(t(TRACEEND))}))
      (then (i32.store ${i32c(t(TRACEOFS))} ${i32c(t(TRACEBUF))}))))
  (func $__tick2 (export "tick2") (param $n i32)
    (block $done (loop $lp
      (br_if $done (i32.le_s (local.get $n) (i32.const 0)))
      ${setClk(0)}
      (call $__eval)
      ${setClk(1)}
      (call $__eval)
      (call $copyTraceRec)
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $lp))))`;
  }
}

function wordsOf(t: VType) {
  return isLogic(t) ? Math.max(numWords(t), 1) : 1;
}

function widthMinOf(e: VExpr) {
  return isLogic(e.t) ? e.t.widthMin || e.t.width : 32;
}

function escapeBytes(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += '\\' + b.toString(16).padStart(2, '0');
  return s;
}

function exprUsesVar(e: VExpr, v: VVar): boolean {
  switch (e.k) {
    case 'var':
      return e.v === v;
    case 'const':
      return false;
    default:
      return e.args.some((a) => exprUsesVar(a, v));
  }
}

/** locals passed by reference to other functions must live in memory */
function collectByRefArgs(stmts: VStmt[], out: Set<string>) {
  const visitExpr = (e: VExpr) => {
    if (e.k === 'call') {
      e.func.args.forEach((p, i) => {
        const a = e.args[i];
        if (a && a.k === 'var' && (p.byRef || !isScalar(p.type))) out.add(a.v.id);
      });
    }
    if (e.k === 'op' || e.k === 'call' || e.k === 'sys') e.args.forEach(visitExpr);
  };
  for (const s of stmts) {
    switch (s.s) {
      case 'assign':
        visitExpr(s.lhs);
        visitExpr(s.rhs);
        break;
      case 'creset':
        visitExpr(s.lhs);
        break;
      case 'if':
        visitExpr(s.cond);
        collectByRefArgs(s.then, out);
        collectByRefArgs(s.else, out);
        break;
      case 'loop':
      case 'jumpblock':
        collectByRefArgs(s.body, out);
        break;
      case 'looptest':
        visitExpr(s.cond);
        break;
      case 'return':
        if (s.value) visitExpr(s.value);
        break;
      case 'expr':
        visitExpr(s.e);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class HDLModuleWASM implements HDLModuleRunner {
  model: VModel;
  bmod: binaryen.Module | null = null;
  instance!: WebAssembly.Instance;
  globals!: Struct;
  databuf!: ArrayBuffer;
  data8!: Uint8Array;
  data16!: Uint16Array;
  data32!: Uint32Array;
  getFileData: ((filename: string) => string | Uint8Array | undefined) | null = null;
  maxMemoryMB: number;
  optimize: boolean;

  state: any;
  statebytes!: number;
  outputbytes!: number;

  traceBufferSize: number = 0xff000;
  traceRecordSize!: number;
  traceReadOffset!: number;
  traceStartOffset!: number;
  traceEndOffset!: number;
  trace: any;

  finished = false;
  stopped = false;
  resetStartTimeMsec = 0;

  /** WAT source of the generated module (for debugging) */
  wat = '';
  private fatalMessages: string[] = [];
  private wasmBinary!: Uint8Array;
  private _eval!: () => void;
  private _tick2!: (iters: number) => void;
  private _ctor!: () => void;

  constructor(model: VModel, opts: Options | number = {}) {
    if (typeof opts === 'number') opts = { maxMemoryMB: opts };
    this.model = model;
    this.maxMemoryMB = opts.maxMemoryMB ?? 64;
    this.optimize = opts.optimize ?? true;
    this.compile();
  }

  /** for debugging: the generated WAT (before optimization) */
  get rawwasm() {
    return this.wat;
  }

  private compile() {
    const gen = new WatGen(this.model, this.traceBufferSize);
    this.wat = gen.generate();
    this.globals = gen.globals;
    this.statebytes = gen.statebytes;
    this.outputbytes = gen.outputbytes;
    this.traceRecordSize = gen.outputbytes;
    this.fatalMessages = gen.fatalMessages;
    if (gen.globals.len > this.maxMemoryMB * 1024 * 1024) {
      throw new HDLError(
        null,
        `cannot allocate ${gen.globals.len} bytes, limit is ${this.maxMemoryMB} MB`,
      );
    }
    const bmod = binaryen.parseText(this.wat);
    this.bmod = bmod;
    bmod.setFeatures(
      binaryen.Features.MVP |
        binaryen.Features.SignExt |
        binaryen.Features.BulkMemory |
        binaryen.Features.MutableGlobals |
        binaryen.Features.NontrappingFPToInt,
    );
    if (!bmod.validate()) {
      throw new HDLError(null, `could not validate wasm module`);
    }
    if (this.optimize) {
      binaryen.setOptimizeLevel(2);
      binaryen.setShrinkLevel(0);
      bmod.optimize();
    }
    this.wasmBinary = bmod.emitBinary();
    bmod.dispose();
    this.bmod = null;
  }

  async init() {
    const compiled = await WebAssembly.compile(this.wasmBinary as BufferSource);
    this.instance = await WebAssembly.instantiate(compiled, this.getImportObject());
    this.afterInstantiate();
  }

  initSync() {
    const compiled = new WebAssembly.Module(this.wasmBinary as BufferSource);
    this.instance = new WebAssembly.Instance(compiled, this.getImportObject());
    this.afterInstantiate();
  }

  private afterInstantiate() {
    const exp = this.instance.exports as any;
    this._eval = exp.eval;
    this._tick2 = exp.tick2;
    this._ctor = exp.ctor;
    this.databuf = (exp.memory as WebAssembly.Memory).buffer;
    this.data8 = new Uint8Array(this.databuf);
    this.data16 = new Uint16Array(this.databuf);
    this.data32 = new Uint32Array(this.databuf);
    this.state = this.makeScopeProxy(() => 0);
    this.enableTracing();
    this.powercycle();
  }

  private getImportObject(): WebAssembly.Imports {
    return {
      builtins: {
        finish: (line: number) => {
          if (!this.finished) console.log('... $finish @ line', line);
          this.finished = true;
        },
        stop: (line: number) => {
          if (!this.stopped) console.log('... $stop @ line', line);
          this.stopped = true;
        },
        fatal: (id: number) => {
          this.stopped = true;
          throw new HDLError(null, this.fatalMessages[id] ?? 'fatal error');
        },
        time: () => BigInt(Date.now() - this.resetStartTimeMsec),
        random: () => (Math.random() * 4294967296) | 0,
      },
    };
  }

  /**
   * Reset the model to its power-on state (like constructing a new Verilated
   * model). Initial blocks run on the next eval(), with the inputs set then.
   */
  powercycle() {
    this.resetStartTimeMsec = Date.now() - 1;
    this.finished = false;
    this.stopped = false;
    this.data8.fill(0, 0, this.statebytes);
    this._ctor();
  }

  eval() {
    this._eval();
  }

  tick() {
    this.state.clk ^= 1;
    this.eval();
  }

  tick2(iters: number) {
    this._tick2(iters);
  }

  isFinished() {
    return this.finished;
  }

  isStopped() {
    return this.stopped;
  }

  saveState() {
    return { o: this.data8.slice(0, this.statebytes) };
  }

  loadState(state: { o: Uint8Array }) {
    this.data8.set(state.o);
  }

  getGlobals() {
    const g: Record<string, any> = {};
    for (const v of this.model.vars) {
      let o: Record<string, any> = g;
      const toks = v.name.split('__DOT__');
      for (const tok of toks.slice(0, -1)) {
        o[tok] = o[tok] || {};
        o = o[tok];
      }
      o[toks[toks.length - 1]] = this.state[v.name];
    }
    return g;
  }

  dispose() {
    this.instance = null as any;
    this.databuf = null as any;
    this.data8 = null as any;
    this.data16 = null as any;
    this.data32 = null as any;
  }

  // --- tracing (outputs are copied to a ring buffer on every tick2 cycle) ---

  enableTracing() {
    if (this.outputbytes == 0) throw new Error(`outputbytes == 0`);
    if (this.outputbytes % 8) throw new Error(`outputbytes must be 8-byte aligned`);
    this.traceStartOffset = this.globals.lookup(TRACEBUF).offset;
    this.traceEndOffset = this.traceStartOffset + this.traceBufferSize - this.outputbytes;
    this.state[TRACEEND] = this.traceEndOffset;
    this.state[TRACERECLEN] = this.outputbytes;
    this.resetTrace();
    this.trace = this.makeScopeProxy(() => this.traceReadOffset);
  }

  resetTrace() {
    this.traceReadOffset = this.traceStartOffset;
    this.state[TRACEOFS] = this.traceStartOffset;
  }

  nextTrace() {
    this.traceReadOffset += this.outputbytes;
    if (this.traceReadOffset >= this.traceEndOffset) this.traceReadOffset = this.traceStartOffset;
  }

  getTraceRecordSize() {
    return this.traceRecordSize;
  }

  // --- JS access to the state ---

  private makeScopeProxy(basefn: () => number): {} {
    const proxy = Object.create(null);
    for (const rec of Object.values(this.globals.vars)) this.defineProperty(proxy, basefn, rec);
    return proxy;
  }

  private defineProperty(proxy: any, basefn: () => number, rec: StructRec) {
    const self = this;
    const t = rec.type;
    let get: () => any;
    let set: (v: any) => void;
    if (t && isArray(t)) {
      const es = typeSize(t.elem);
      const ctor =
        es === 1 ? Uint8Array : es === 2 ? Uint16Array : es === 8 ? BigUint64Array : Uint32Array;
      get = () =>
        new (ctor as any)(self.databuf, basefn() + rec.offset, rec.size / ctor.BYTES_PER_ELEMENT);
      set = () => {
        throw new HDLError(rec, `cannot assign array ${rec.name}`);
      };
    } else if (t && isLogic(t) && t.width > 32) {
      const words = Math.ceil(t.width / 32);
      const mask = maskBits(t.width);
      get = () => {
        const base = (basefn() + rec.offset) >> 2;
        let r = 0n;
        for (let i = words - 1; i >= 0; i--) r = (r << 32n) | BigInt(self.data32[base + i]);
        return r & mask;
      };
      set = (value) => {
        const base = (basefn() + rec.offset) >> 2;
        let v = BigInt(value) & mask;
        for (let i = 0; i < words; i++) {
          self.data32[base + i] = Number(v & 0xffffffffn);
          v >>= 32n;
        }
      };
    } else {
      const width = t && isLogic(t) ? t.width : rec.size * 8;
      const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
      if (rec.size === 1) {
        get = () => self.data8[basefn() + rec.offset];
        set = (v) => (self.data8[basefn() + rec.offset] = Number(v) & mask);
      } else if (rec.size === 2) {
        get = () => self.data16[(basefn() + rec.offset) >> 1];
        set = (v) => (self.data16[(basefn() + rec.offset) >> 1] = Number(v) & mask);
      } else {
        get = () => self.data32[(basefn() + rec.offset) >> 2];
        set = (v) => (self.data32[(basefn() + rec.offset) >> 2] = Number(v) & mask);
      }
    }
    Object.defineProperty(proxy, rec.name, {
      get,
      set(v) {
        set(v);
        return true;
      },
      enumerable: true,
      configurable: false,
    });
  }
}
