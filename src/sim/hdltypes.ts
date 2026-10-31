import { EmuHalt, SourceLocation } from './emu';

/**
 * Intermediate representation of a Verilated model.
 *
 * The IR mirrors the C++ code that Verilator would emit (after V3Clean,
 * V3Expand etc.), since that is what Verilator's final JSON tree describes:
 * a set of C functions operating on C-sized integers (CData/SData/IData/QData),
 * wide values (VlWide, arrays of 32-bit words) and unpacked arrays.
 */

export class HDLError extends EmuHalt {
  obj: any;
  constructor(obj: any, msg: string) {
    super(msg, obj && obj.loc ? obj.loc : undefined);
    Object.setPrototypeOf(this, HDLError.prototype);
    this.obj = obj;
  }
}

export interface HDLModuleRunner {
  state: any; // live state or proxy object
  eval(): void;
  tick(): void;
  tick2(iters: number): void;
  powercycle(): void;
  isFinished(): boolean;
  isStopped(): boolean;
  getGlobals(): {};
  saveState(): {};
  loadState(state: {}): void;
  dispose(): void;
  getFileData: ((filename: string) => string | Uint8Array | undefined) | null;
}

// --- Types ---

/** Packed integral value (bit/logic vector, CData/SData/IData/QData, VlWide) */
export interface VLogicType {
  kind: 'logic';
  width: number;
  /** Verilator's widthMin(), passed as 'lbits' to signed helpers */
  widthMin: number;
  signed: boolean;
}

/** Unpacked array (VlUnpacked<T, N>) */
export interface VArrayType {
  kind: 'array';
  elem: VType;
  /** number of elements */
  count: number;
  /** lowest declared index (informational, Verilator indexes from 0) */
  lo: number;
}

export interface VOtherType {
  kind: 'void' | 'string' | 'real' | 'unsupported';
  name: string;
}

export type VType = VLogicType | VArrayType | VOtherType;

export function isLogic(t: VType | undefined): t is VLogicType {
  return !!t && t.kind === 'logic';
}

export function isArray(t: VType | undefined): t is VArrayType {
  return !!t && t.kind === 'array';
}

/** Values wider than 64 bits are stored as arrays of 32-bit words */
export function isWide(t: VType | undefined): boolean {
  return isLogic(t) && t.width > 64;
}

export function numWords(t: VLogicType): number {
  return Math.ceil(t.width / 32);
}

/** Size in bytes of the storage for a type (matches Verilator's C types) */
export function typeSize(t: VType): number {
  if (isLogic(t)) {
    if (t.width <= 8) return 1;
    if (t.width <= 16) return 2;
    if (t.width <= 32) return 4;
    if (t.width <= 64) return 8;
    return numWords(t) * 4;
  }
  if (isArray(t)) return t.count * typeSize(t.elem);
  return 0;
}

/** Alignment in bytes of the storage for a type */
export function typeAlign(t: VType): number {
  if (isLogic(t)) return Math.min(typeSize(t), 8);
  if (isArray(t)) return typeAlign(t.elem);
  return 1;
}

// --- Variables and functions ---

export type VVarScope = 'global' | 'local' | 'arg';
export type VDirection = 'input' | 'output' | 'inout' | 'none';

export type VInit =
  | { kind: 'const'; value: bigint }
  | { kind: 'array'; items: Map<number, VInit>; dflt?: VInit };

export interface VSourceLocation extends SourceLocation {}

export interface VVar {
  id: string;
  /** C identifier (unique within its scope) */
  name: string;
  /** Pretty (Verilog) name */
  origName: string;
  type: VType;
  scope: VVarScope;
  /** Function argument passed by reference (pointer) */
  byRef: boolean;
  dir: VDirection;
  /** Top-level I/O port */
  isPrimaryIO: boolean;
  /** Constant (e.g. constant pool tables), initialized once */
  isConst: boolean;
  init?: VInit;
  loc?: VSourceLocation;
}

export interface VConst {
  k: 'const';
  t: VType;
  value: bigint;
  /** set for string literals */
  str?: string;
  loc?: VSourceLocation;
}

export interface VVarRef {
  k: 'var';
  t: VType;
  v: VVar;
  loc?: VSourceLocation;
}

export interface VOp {
  k: 'op';
  op: string;
  t: VType;
  args: VExpr[];
  loc?: VSourceLocation;
}

export interface VCall {
  k: 'call';
  t: VType;
  func: VFunc;
  args: VExpr[];
  loc?: VSourceLocation;
}

/** System functions ($time, $random...) */
export interface VSys {
  k: 'sys';
  name: string;
  t: VType;
  args: VExpr[];
  loc?: VSourceLocation;
}

export type VExpr = VConst | VVarRef | VOp | VCall | VSys;

export type VStmt =
  | { s: 'assign'; lhs: VExpr; rhs: VExpr; loc?: VSourceLocation }
  /** Reset a variable to its power-on value (Verilator CRESET) */
  | { s: 'creset'; lhs: VExpr; loc?: VSourceLocation }
  | { s: 'if'; cond: VExpr; then: VStmt[]; else: VStmt[]; loc?: VSourceLocation }
  /** Infinite loop, exited by 'looptest' (innermost) or 'jumpgo' */
  | { s: 'loop'; body: VStmt[]; loc?: VSourceLocation }
  /** Break out of the innermost loop when cond is false */
  | { s: 'looptest'; cond: VExpr; loc?: VSourceLocation }
  | { s: 'jumpblock'; id: string; body: VStmt[]; loc?: VSourceLocation }
  | { s: 'jumpgo'; id: string; loc?: VSourceLocation }
  | { s: 'return'; value?: VExpr; loc?: VSourceLocation }
  | { s: 'expr'; e: VExpr; loc?: VSourceLocation }
  | { s: 'fatal'; msg: string; loc?: VSourceLocation }
  | { s: 'finish'; loc?: VSourceLocation }
  | { s: 'stop'; loc?: VSourceLocation };

export interface VFunc {
  id: string;
  name: string;
  args: VVar[];
  locals: VVar[];
  body: VStmt[];
  /** Return type, or null for void functions */
  ret: VType | null;
  loc?: VSourceLocation;
}

export interface VModel {
  /** Global variables (module state, constant pool, packages) */
  vars: VVar[];
  funcs: VFunc[];
  /** Non fatal issues found while parsing */
  warnings: string[];
}
