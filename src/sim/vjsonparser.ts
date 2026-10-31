/**
 * Converts the JSON tree dumped by Verilator 5 (`obj_dir/V<top>.tree.json`,
 * produced by `--debug-check` or `--json-only`) into the VModel IR.
 *
 * The final tree is the one Verilator uses to emit C++, so it consists of:
 *   - the `$root` module, with every (flattened) variable and all CFUNCs
 *     (_eval, _eval_static, _eval_initial, _eval_settle, _ctor_var_reset...)
 *   - the constant pool (`@CONST-POOL@`), with read-only tables
 *   - packages and classes (only package variables/functions are supported)
 *
 * Every reference in the tree is by address (`varp`, `funcp`, `dtypep`...),
 * so names never need to be resolved.
 */
import {
  isArray,
  isLogic,
  VExpr,
  VFunc,
  VInit,
  VLogicType,
  VModel,
  VSourceLocation,
  VStmt,
  VType,
  VVar,
  VVarScope,
} from './hdltypes';

type JNode = Record<string, any> & { type: string; addr?: string };

export class CompileError extends Error {
  loc?: VSourceLocation;
  constructor(loc: VSourceLocation | undefined, msg: string) {
    super(loc ? `${msg} (${loc.path ?? ''}:${loc.line})` : msg);
    this.loc = loc;
    Object.setPrototypeOf(this, CompileError.prototype);
  }
}

const VOID: VType = { kind: 'void', name: 'void' };

// Expression node types that map 1:1 to an operator (lowercase name is the op)
const UNOPS = new Set([
  'NOT',
  'NEGATE',
  'REDAND',
  'REDOR',
  'REDXOR',
  'LOGNOT',
  'CCAST',
  'EXTEND',
  'EXTENDS',
  'ONEHOT',
  'ONEHOT0',
  'COUNTONES',
  'CLOG2',
  'ISUNKNOWN',
]);
const BINOPS = new Set([
  'ADD',
  'SUB',
  'MUL',
  'MULS',
  'DIV',
  'DIVS',
  'MODDIV',
  'MODDIVS',
  'POW',
  'POWSS',
  'POWSU',
  'POWUS',
  'AND',
  'OR',
  'XOR',
  'LOGAND',
  'LOGOR',
  'LOGIF',
  'LOGEQ',
  'EQ',
  'NEQ',
  'LT',
  'LTE',
  'GT',
  'GTE',
  'LTS',
  'LTES',
  'GTS',
  'GTES',
  'EQCASE',
  'NEQCASE',
  'EQWILD',
  'NEQWILD',
  'SHIFTL',
  'SHIFTR',
  'SHIFTRS',
  'SHIFTLOVR',
  'SHIFTROVR',
  'SHIFTRSOVR',
  'CONCAT',
  'REPLICATE',
]);

// Some binops keep their operands in other fields
const OPERAND_FIELDS: Record<string, [string, string]> = {
  ARRAYSEL: ['fromp', 'bitp'],
  WORDSEL: ['fromp', 'bitp'],
  REPLICATE: ['srcp', 'countp'],
};

export function parseConstValue(s: string): { value: bigint; width: number | null; str?: string } {
  // Sized literal: 32'h1, 64'shffff..., 100'h1_0000
  const m = /^(\d+)'(s?)([hbdo])([0-9a-fA-F_xXzZ?]+)$/.exec(s);
  if (m) {
    const width = parseInt(m[1]);
    const digits = m[4].replace(/_/g, '').replace(/[xXzZ?]/g, '0');
    const radix = { h: 16, b: 2, d: 10, o: 8 }[m[3] as 'h' | 'b' | 'd' | 'o'];
    let value = 0n;
    for (const ch of digits.toLowerCase()) value = value * BigInt(radix) + BigInt(parseInt(ch, 16));
    return { value, width };
  }
  // String literal (only meaningful for $display & co, which are ignored)
  if (s.startsWith('"')) {
    let str = s.slice(1, -1);
    try {
      str = JSON.parse(s.replace(/\\"/g, '"'));
    } catch {}
    return { value: 0n, width: null, str };
  }
  if (/^-?\d+$/.test(s)) return { value: BigInt(s), width: null };
  if (/^-?\d*\.\d*(e[-+]?\d+)?$/i.test(s))
    return { value: BigInt(Math.trunc(parseFloat(s))), width: null };
  throw new Error(`could not parse constant "${s}"`);
}

/** Two's complement value truncated to 'width' bits (negative literals wrap) */
function maskTo(value: bigint, width: number) {
  return BigInt.asUintN(width, value);
}

export class VerilogJSONParser {
  /** Resulting model */
  model: VModel = { vars: [], funcs: [], warnings: [] };

  private nodes = new Map<string, JNode>(); // addr -> node (dtypes, vars, funcs, jumpblocks)
  private types = new Map<string, VType>();
  private vars = new Map<string, VVar>();
  private funcs = new Map<string, VFunc>();
  private files = new Map<string, string>();
  private usedNames = new Set<string>();
  private curFunc: VFunc | null = null;

  /** File names from V<top>.tree.meta.json ({files: {id: {filename}}}) */
  setFileNames(meta: { files?: Record<string, { filename: string }> }) {
    for (const [id, f] of Object.entries(meta.files ?? {})) this.files.set(id, f.filename);
  }

  parse(json: string | object) {
    const root: JNode = typeof json === 'string' ? JSON.parse(json) : (json as JNode);
    if (root.type !== 'NETLIST' || !Array.isArray(root.modulesp)) {
      throw new CompileError(undefined, 'not a Verilator netlist JSON');
    }
    this.indexTree(root);
    // Modules and constant pool
    const modules: JNode[] = [...root.modulesp];
    for (const m of root.miscsp ?? []) {
      if (m.type === 'CONSTPOOL') modules.push(...(m.modulep ?? []));
    }
    // 1st pass: declare all global variables and functions (so references
    // can be resolved in any order)
    for (const mod of modules) {
      if (!this.isSupportedModule(mod)) continue;
      for (const stmt of mod.stmtsp ?? []) {
        if (stmt.type === 'VAR') this.declareVar(stmt, 'global', mod.name === '@CONST-POOL@');
        else if (stmt.type === 'CFUNC') this.declareFunc(stmt);
      }
    }
    // 2nd pass: function bodies
    for (const mod of modules) {
      if (!this.isSupportedModule(mod)) continue;
      for (const stmt of mod.stmtsp ?? []) {
        if (stmt.type === 'CFUNC') this.defineFunc(stmt);
      }
    }
    this.model.vars = [...this.vars.values()].filter((v) => v.scope === 'global');
    this.model.funcs = [...this.funcs.values()];
    return this.model;
  }

  /** Packages and the root module are simulated, classes are ignored */
  private isSupportedModule(mod: JNode) {
    return mod.type === 'MODULE' || mod.type === 'PACKAGE';
  }

  private indexTree(node: JNode) {
    const stack: JNode[] = [node];
    while (stack.length) {
      const n = stack.pop()!;
      if (
        n.addr &&
        (n.type.endsWith('DTYPE') ||
          n.type === 'VAR' ||
          n.type === 'CFUNC' ||
          n.type === 'JUMPBLOCK')
      ) {
        this.nodes.set(n.addr, n);
      }
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) for (const c of v) if (c && typeof c === 'object') stack.push(c);
      }
    }
  }

  private loc(node: JNode): VSourceLocation | undefined {
    const loc: string | undefined = node.loc;
    if (!loc) return undefined;
    const m = /^(\w+),(\d+):(\d+)/.exec(loc);
    if (!m) return undefined;
    return { path: this.files.get(m[1]) ?? m[1], line: parseInt(m[2]), start: parseInt(m[3]) - 1 };
  }

  private fail(node: JNode, msg: string): never {
    throw new CompileError(this.loc(node), msg);
  }

  // --- Types ---

  dtype(addr: string | undefined, node?: JNode): VType {
    if (!addr) return VOID;
    const cached = this.types.get(addr);
    if (cached) return cached;
    const dn = this.nodes.get(addr);
    if (!dn) {
      if (node) this.fail(node, `unknown data type ${addr}`);
      return { kind: 'unsupported', name: addr };
    }
    // Insert a placeholder to break cycles (self-referencing classes)
    this.types.set(addr, { kind: 'unsupported', name: dn.type });
    const t = this.makeType(dn);
    this.types.set(addr, t);
    return t;
  }

  private rangeCount(dn: JNode): { count: number; lo: number } {
    const decl = /\[(-?\d+):(-?\d+)\]/.exec(dn.declRange ?? '');
    if (decl) {
      const l = parseInt(decl[1]);
      const r = parseInt(decl[2]);
      return { count: Math.abs(l - r) + 1, lo: Math.min(l, r) };
    }
    const range = dn.rangep?.[0];
    if (range && range.leftp?.[0]?.type === 'CONST' && range.rightp?.[0]?.type === 'CONST') {
      const l = Number(parseConstValue(range.leftp[0].name).value);
      const r = Number(parseConstValue(range.rightp[0].name).value);
      return { count: Math.abs(l - r) + 1, lo: Math.min(l, r) };
    }
    this.fail(dn, `cannot determine array range`);
  }

  private makeType(dn: JNode): VType {
    const signed = dn.signed === true || dn.signed === 'true';
    const withWidth = (width: number): VLogicType => ({
      kind: 'logic',
      width,
      widthMin: typeof dn.widthMin === 'number' && dn.widthMin > 0 ? dn.widthMin : width,
      signed,
    });
    switch (dn.type) {
      case 'BASICDTYPE': {
        const kw: string = dn.keyword ?? dn.name;
        if (kw === 'string') return { kind: 'string', name: kw };
        if (kw === 'real' || kw === 'double' || kw === 'shortreal')
          return { kind: 'real', name: kw };
        if (typeof dn.width === 'number' && dn.width > 0) return withWidth(dn.width);
        const range = /^(-?\d+):(-?\d+)$/.exec(dn.range ?? '');
        if (range) return withWidth(Math.abs(parseInt(range[1]) - parseInt(range[2])) + 1);
        const widths: Record<string, number> = {
          bit: 1,
          logic: 1,
          byte: 8,
          shortint: 16,
          int: 32,
          integer: 32,
          longint: 64,
          time: 64,
          CData: 8,
          SData: 16,
          IData: 32,
          QData: 64,
          EData: 32,
        };
        if (widths[kw]) return withWidth(widths[kw]);
        return { kind: 'unsupported', name: kw };
      }
      case 'PACKARRAYDTYPE':
      case 'STRUCTDTYPE':
      case 'UNIONDTYPE': {
        if (typeof dn.width === 'number' && dn.width > 0) return withWidth(dn.width);
        if (dn.type === 'PACKARRAYDTYPE') {
          const elem = this.dtype(dn.refDTypep, dn);
          if (isLogic(elem)) return withWidth(elem.width * this.rangeCount(dn).count);
        }
        return { kind: 'unsupported', name: dn.type };
      }
      case 'UNPACKARRAYDTYPE': {
        const elem = this.dtype(dn.refDTypep ?? dn.childDTypep?.[0]?.addr, dn);
        const { count, lo } = this.rangeCount(dn);
        return { kind: 'array', elem, count, lo };
      }
      case 'REFDTYPE':
      case 'ENUMDTYPE':
      case 'CONSTDTYPE':
      case 'MEMBERDTYPE':
      case 'PARAMTYPEDTYPE':
      case 'TYPEDEF':
        if (dn.refDTypep && dn.refDTypep !== 'UNLINKED') return this.dtype(dn.refDTypep, dn);
        if (dn.childDTypep?.[0]) return this.dtype(dn.childDTypep[0].addr, dn);
        return { kind: 'unsupported', name: dn.type };
      case 'VOIDDTYPE':
        return VOID;
      default:
        return { kind: 'unsupported', name: dn.type };
    }
  }

  // --- Variables ---

  private uniqueName(name: string) {
    let n = name.replace(/[^a-zA-Z0-9_$]/g, '_');
    if (!this.usedNames.has(n)) {
      this.usedNames.add(n);
      return n;
    }
    for (let i = 1; ; i++) {
      const c = `${n}__${i}`;
      if (!this.usedNames.has(c)) {
        this.usedNames.add(c);
        return c;
      }
    }
  }

  private declareVar(node: JNode, scope: VVarScope, isConstPool = false): VVar {
    const existing = this.vars.get(node.addr!);
    if (existing) return existing;
    const type = this.dtype(node.dtypep, node);
    const dirmap: Record<string, VVar['dir']> = {
      INPUT: 'input',
      OUTPUT: 'output',
      INOUT: 'inout',
      REF: 'inout',
      CONSTREF: 'input',
    };
    const direction: string = node.direction ?? 'NONE';
    const byRef =
      scope === 'arg' &&
      (direction === 'OUTPUT' ||
        direction === 'INOUT' ||
        direction === 'REF' ||
        direction === 'CONSTREF' ||
        isArray(type) ||
        (isLogic(type) && type.width > 64));
    const name = scope === 'global' ? this.uniqueName(node.name) : node.name;
    const v: VVar = {
      id: node.addr!,
      name,
      origName: node.origName ?? node.name,
      type,
      scope,
      byRef,
      dir: dirmap[direction] ?? 'none',
      isPrimaryIO: node.isPrimaryIO === true,
      isConst: isConstPool || node.isConst === true,
      loc: this.loc(node),
    };
    const valuep = node.valuep?.[0];
    if (valuep && (isConstPool || node.isConst === true || node.isParam === true)) {
      v.init = this.initValue(valuep, type);
    }
    this.vars.set(node.addr!, v);
    return v;
  }

  private initValue(node: JNode, t: VType): VInit {
    if (node.type === 'CONST') {
      return { kind: 'const', value: parseConstValue(node.name).value };
    }
    if (node.type === 'INITARRAY') {
      const elemType = isArray(t) ? t.elem : t;
      const items = new Map<number, VInit>();
      const inits: JNode[] = node.initsp ?? [];
      // initList: " [1]=(FCC) [2]=(GCC) ..." maps indices to INITITEM addresses
      const indexOf = new Map<string, number>();
      const re = /\[(\d+)\]=(\([^)]*\)|0x[0-9a-f]+)/g;
      let m: RegExpExecArray | null;
      let truncated = /\.\.\./.test(node.initList ?? '');
      while ((m = re.exec(node.initList ?? ''))) indexOf.set(m[2], parseInt(m[1]));
      if (truncated) {
        this.model.warnings.push(
          `constant table at line ${this.loc(node)?.line} has a truncated index list; ` +
            `rebuild verilator_bin.wasm with the vga-playground JSON patch`,
        );
      }
      let next = 0;
      inits.forEach((item) => {
        let index = indexOf.get(item.addr!);
        if (index === undefined) index = next; // fallback for truncated lists
        next = index + 1;
        items.set(index, this.initValue(item.valuep[0], elemType));
      });
      const dflt = node.defaultp?.[0] ? this.initValue(node.defaultp[0], elemType) : undefined;
      return { kind: 'array', items, dflt };
    }
    this.fail(node, `unsupported initializer ${node.type}`);
  }

  // --- Functions ---

  private declareFunc(node: JNode) {
    const f: VFunc = {
      id: node.addr!,
      name: this.uniqueName(node.name),
      args: [],
      locals: [],
      body: [],
      ret: null,
      loc: this.loc(node),
    };
    for (const a of node.argsp ?? []) {
      if (a.type === 'VAR') f.args.push(this.declareVar(a, 'arg'));
    }
    for (const l of node.varsp ?? []) {
      if (l.type === 'VAR') f.locals.push(this.declareVar(l, 'local'));
    }
    this.funcs.set(node.addr!, f);
  }

  private defineFunc(node: JNode) {
    const f = this.funcs.get(node.addr!)!;
    this.curFunc = f;
    // locals declared among the statements
    f.body = this.stmts(node.stmtsp ?? []);
    // statements that initialize args (CRESET of reference args) are skipped
    this.curFunc = null;
    // return type: from the first value-returning CRETURN
    const findRet = (stmts: VStmt[]): VType | null => {
      for (const s of stmts) {
        if (s.s === 'return' && s.value) return s.value.t;
        let r: VType | null = null;
        if (s.s === 'if') r = findRet(s.then) ?? findRet(s.else);
        else if (s.s === 'loop' || s.s === 'jumpblock') r = findRet(s.body);
        if (r) return r;
      }
      return null;
    };
    f.ret = findRet(f.body);
    if (f.ret && isLogic(f.ret) && f.ret.width > 64) {
      this.fail(node, `functions returning values wider than 64 bits are not supported`);
    }
  }

  // --- Statements ---

  private stmts(nodes: JNode[]): VStmt[] {
    const out: VStmt[] = [];
    for (const n of nodes) this.stmt(n, out);
    return out;
  }

  private stmt(n: JNode, out: VStmt[]) {
    const loc = this.loc(n);
    switch (n.type) {
      case 'ASSIGN':
      case 'ASSIGNW':
      case 'ASSIGNDLY':
      case 'ASSIGNPRE':
      case 'ASSIGNPOST':
      case 'ASSIGNFORCE': {
        const rhsn = n.rhsp[0];
        const lhs = this.expr(n.lhsp[0]);
        if (rhsn.type === 'CRESET') {
          out.push({ s: 'creset', lhs, loc });
        } else {
          out.push({ s: 'assign', lhs, rhs: this.expr(rhsn), loc });
        }
        return;
      }
      case 'IF':
        out.push({
          s: 'if',
          cond: this.expr(n.condp[0]),
          then: this.stmts(n.thensp ?? []),
          else: this.stmts(n.elsesp ?? []),
          loc,
        });
        return;
      case 'LOOP':
        out.push({ s: 'loop', body: this.stmts([...(n.stmtsp ?? []), ...(n.contsp ?? [])]), loc });
        return;
      case 'LOOPTEST':
        out.push({ s: 'looptest', cond: this.expr(n.condp[0]), loc });
        return;
      case 'WHILE': {
        // Older Verilator: WHILE(precondsp, condp, stmtsp, incsp)
        const body: VStmt[] = [
          ...this.stmts(n.precondsp ?? []),
          { s: 'looptest', cond: this.expr(n.condp[0]), loc },
          ...this.stmts(n.stmtsp ?? []),
          ...this.stmts(n.incsp ?? []),
        ];
        out.push({ s: 'loop', body, loc });
        return;
      }
      case 'JUMPBLOCK':
        out.push({ s: 'jumpblock', id: n.addr!, body: this.stmts(n.stmtsp ?? []), loc });
        return;
      case 'JUMPGO':
        out.push({ s: 'jumpgo', id: n.blockp, loc });
        return;
      case 'JUMPLABEL':
        return;
      case 'CRETURN':
        out.push({ s: 'return', value: n.lhsp?.[0] ? this.expr(n.lhsp[0]) : undefined, loc });
        return;
      case 'STMTEXPR': {
        const e = n.exprp[0];
        if (this.ignorableExpr(e)) return;
        out.push({ s: 'expr', e: this.expr(e), loc });
        return;
      }
      case 'CSTMT':
      case 'CSTMTUSER': {
        // Raw C code. Only fatal errors matter for simulation, the rest is
        // debugging output (VL_DEBUG blocks), statistics or class plumbing.
        const text = (n.nodesp ?? [])
          .filter((t: JNode) => t.type === 'TEXT')
          .map((t: JNode) => t.text)
          .join('');
        const fatal = /VL_FATAL_MT\([^,]*,\s*\d+,\s*"[^"]*",\s*"((?:[^"\\]|\\.)*)"/.exec(text);
        if (fatal) out.push({ s: 'fatal', msg: fatal[1], loc });
        else if (/VL_FINISH_MT|gotFinish\(true\)/.test(text)) out.push({ s: 'finish', loc });
        else if (/VL_STOP_MT/.test(text)) out.push({ s: 'stop', loc });
        return;
      }
      case 'FINISH':
        out.push({ s: 'finish', loc });
        return;
      case 'STOP':
        out.push({ s: 'stop', loc });
        return;
      case 'VAR':
        if (this.curFunc) this.curFunc.locals.push(this.declareVar(n, 'local'));
        return;
      case 'COMMENT':
      case 'DISPLAY':
      case 'FCLOSE':
      case 'FFLUSH':
      case 'PRINTTIMESCALE':
      case 'CUSE':
      case 'TEXT':
      case 'TRACEDECL':
      case 'TRACEINC':
      case 'COVERDECL':
      case 'COVERINC':
        return;
      case 'BEGIN':
        for (const s of n.stmtsp ?? []) this.stmt(s, out);
        return;
      default:
        this.fail(n, `unsupported statement ${n.type}`);
    }
  }

  /** Calls/expressions that only exist for debugging or classes */
  private ignorableExpr(e: JNode) {
    if (e.type === 'CCALL') {
      const fn = this.nodes.get(e.funcp);
      // calls to debug dumps (only present under VL_DEBUG)
      if (fn && /^_dump_triggers__/.test(fn.name)) return true;
      if (!fn || !this.funcs.has(e.funcp)) {
        this.fail(e, `call to unsupported function ${e.funcName}`);
      }
    }
    return e.type === 'CMETHODHARD' && /^(randstate|reseed)/.test(e.name ?? '');
  }

  // --- Expressions ---

  expr(n: JNode): VExpr {
    const loc = this.loc(n);
    const t = this.dtype(n.dtypep, n);
    switch (n.type) {
      case 'CONST': {
        const { value, width, str } = parseConstValue(n.name);
        const w = isLogic(t) ? t.width : width ?? 64;
        return {
          k: 'const',
          t,
          value: str !== undefined ? 0n : maskTo(value, w),
          str,
          loc,
        };
      }
      case 'VARREF': {
        const v = this.vars.get(n.varp);
        if (!v) this.fail(n, `reference to unknown variable ${n.name}`);
        return { k: 'var', t: v.type, v, loc };
      }
      case 'CCALL': {
        const func = this.funcs.get(n.funcp);
        if (!func) this.fail(n, `call to unsupported function ${n.funcName}`);
        return { k: 'call', t, func, args: (n.argsp ?? []).map((a: JNode) => this.expr(a)), loc };
      }
      case 'COND':
      case 'CONDBOUND':
        return {
          k: 'op',
          op: 'cond',
          t,
          args: [this.expr(n.condp[0]), this.expr(n.thenp[0]), this.expr(n.elsep[0])],
          loc,
        };
      case 'SEL':
        // fromp[lsbp +: width] (widthp is a constant)
        return {
          k: 'op',
          op: 'sel',
          t,
          args: [this.expr(n.fromp[0]), this.expr(n.lsbp[0])],
          loc,
        };
      case 'TIME':
      case 'TIMED':
        return { k: 'sys', name: '$time', t, args: [], loc };
      case 'RAND':
      case 'URANDOM':
      case 'RANDRNG':
      case 'URANDOMRANGE':
        return {
          k: 'sys',
          name: '$random',
          t,
          args: [...(n.seedp ?? []), ...(n.lhsp ?? []), ...(n.rhsp ?? [])].map((a: JNode) =>
            this.expr(a),
          ),
          loc,
        };
      case 'CRESET':
        return { k: 'const', t, value: 0n, loc };
      default:
        break;
    }
    if (UNOPS.has(n.type)) {
      return { k: 'op', op: n.type.toLowerCase(), t, args: [this.expr(n.lhsp[0])], loc };
    }
    const fields = OPERAND_FIELDS[n.type];
    if (fields) {
      return {
        k: 'op',
        op: n.type.toLowerCase(),
        t,
        args: fields.map((f) => this.expr(n[f][0])),
        loc,
      };
    }
    if (BINOPS.has(n.type)) {
      return {
        k: 'op',
        op: n.type.toLowerCase(),
        t,
        args: [this.expr(n.lhsp[0]), this.expr(n.rhsp[0])],
        loc,
      };
    }
    this.fail(n, `unsupported expression ${n.type}`);
  }
}

export function parseVerilatorJSON(json: string | object): VModel {
  return new VerilogJSONParser().parse(json);
}
