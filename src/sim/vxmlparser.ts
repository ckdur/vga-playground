import {
  HDLAlwaysBlock,
  HDLArrayItem,
  HDLBinop,
  HDLBlock,
  HDLConstant,
  HDLDataType,
  HDLDataTypeObject,
  HDLExpr,
  HDLExtendop,
  HDLFile,
  HDLFuncCall,
  HDLHierarchyDef,
  HDLInstanceDef,
  HDLLogicType,
  HDLVlTriggerVecType,
  HDLModuleDef,
  HDLNativeType,
  HDLPort,
  HDLSensItem,
  HDLSourceLocation,
  HDLSourceObject,
  HDLTriop,
  HDLUnit,
  HDLUnop,
  HDLUnpackArray,
  HDLVariableDef,
  HDLVarRef,
  HDLWhileOp,
  isConstExpr,
  isVarDecl,
} from './hdltypes';
import { parseJSONPoorly, JSONNode } from './json';

/**
 * Whaa?
 *
 * Each hierarchy takes (uint32[] -> uint32[])
 * - convert to/from js object
 * - JS or WASM
 * - Fixed-size packets
 * - state is another uint32[]
 * Find optimal packing of bits
 * Find clocks
 * Find pivots (reset, state) concat them together
 * Dependency cycles
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
 */

export class CompileError extends Error implements HDLSourceObject {
  $loc: HDLSourceLocation;
  constructor($loc: HDLSourceLocation, msg: string) {
    super(msg);
    this.$loc = $loc;
    Object.setPrototypeOf(this, CompileError.prototype);
  }
}

export class VerilogJSONParser implements HDLUnit {
  files: { [id: string]: HDLFile } = {};
  dtypes: { [id: string]: HDLDataType } = {};
  modules: { [id: string]: HDLModuleDef } = {};
  hierarchies: { [id: string]: HDLHierarchyDef } = {};

  cur_node!: JSONNode;
  cur_module!: HDLModuleDef;
  cur_loc!: HDLSourceLocation;
  cur_loc_str!: string;
  cur_deferred: Array<() => void> = [];

  constructor() {
    // TODO: other types?
    this.dtypes['QData'] = { left: 63, right: 0, signed: false };
    this.dtypes['IData'] = { left: 31, right: 0, signed: false };
    this.dtypes['SData'] = { left: 15, right: 0, signed: false };
    this.dtypes['CData'] = { left: 7, right: 0, signed: false };
    this.dtypes['byte'] = { left: 7, right: 0, signed: true };
    this.dtypes['shortint'] = { left: 15, right: 0, signed: true };
    this.dtypes['int'] = { left: 31, right: 0, signed: true };
    this.dtypes['integer'] = { left: 31, right: 0, signed: true };
    this.dtypes['longint'] = { left: 63, right: 0, signed: true };
    this.dtypes['time'] = { left: 63, right: 0, signed: false };
  }

  defer(fn: () => void) {
    this.cur_deferred.unshift(fn);
  }

  defer2(fn: () => void) {
    this.cur_deferred.push(fn);
  }

  run_deferred() {
    this.cur_deferred.forEach((fn) => fn());
    this.cur_deferred = [];
  }

  name2js(s: string) {
    if (s == null) throw new CompileError(this.cur_loc, `no name`);
    return s.replace(/[^a-z0-9_]/gi, '$');
  }

  findChildren(node: JSONNode, type: string, required: boolean): JSONNode[] {
    const arr = node.children.filter((n) => n.type == type);
    if (arr.length == 0 && required)
      throw new CompileError(this.cur_loc, `no child of type ${type}`);
    return arr;
  }

  parseSourceLocation(node: JSONNode): HDLSourceLocation | undefined {
    const loc = node.attrs['loc'];
    if (loc) {
      if (loc == this.cur_loc_str) {
        return this.cur_loc; // cache last parsed $loc object
      } else {
        const [fileid, line, col, end_line, end_col] = loc.split(/[,:]/);
        const file = this.files[fileid] ?? fileid
        const filename = file.filename ?? fileid
        const $loc = {
          hdlfile: file,
          path: filename,
          line: parseInt(line),
          start: parseInt(col) - 1,
          end_line: parseInt(end_line),
          end: parseInt(end_col) - 1,
        };
        this.cur_loc = $loc;
        this.cur_loc_str = loc;
        return $loc;
      }
    } else {
      return undefined;
    }
  }

  open_module(node: JSONNode) {
    const module: HDLModuleDef = {
      $loc: this.parseSourceLocation(node),
      name: node.attrs['name'],
      origName: node.attrs['origName'],
      blocks: [],
      instances: [],
      vardefs: {},
    };
    if (this.cur_module) throw new CompileError(this.cur_loc, `nested modules not supported`);
    this.cur_module = module;
    return module;
  }

  deferDataType(node: JSONNode, def: HDLDataTypeObject) {
    const dtype_id = node.attrs['dtypep'];
    if (dtype_id != null) {
      this.defer(() => {
        def.dtype = this.dtypes[dtype_id];
        if (!def.dtype) {
          throw new CompileError(this.cur_loc, `Unknown data type ${dtype_id} for ${node.type}`);
        }
      });
    }
  }

  parseConstValue(s: string): { value: number | bigint; origWidth: number } {
    // Match constants like 32'hABCD or 512'h0000_1234_... (with optional underscores)
    const re_const = /(\d+)'([s]?)h([0-9a-f_]+)/i;
    const m = re_const.exec(s);
    if (m) {
      const origWidth = parseInt(m[1]);
      // Remove underscores from hex string
      const numstr = m[3].replace(/_/g, '');
      if (numstr.length <= 8) return { value: parseInt(numstr, 16), origWidth };
      else return { value: BigInt('0x' + numstr), origWidth };
    } else {
      try {
        // Just try to treat it as a number of 32 bits
        const num = parseInt(s);
        const origWidth = 32;
        return { value: num, origWidth }
      }
      catch {
        throw new CompileError(this.cur_loc, `could not parse constant "${s}"`);
      }
    }
  }

  resolveVar(s: string, mod: HDLModuleDef): HDLVariableDef {
    const def = mod.vardefs[s];
    if (def == null) throw new CompileError(this.cur_loc, `could not resolve variable "${s}"`);
    return def;
  }

  resolveModule(s: string): HDLModuleDef {
    const mod = this.modules[s];
    if (mod == null) throw new CompileError(this.cur_loc, `could not resolve module "${s}"`);
    return mod;
  }

  //

  visit_verilator_xml(node: JSONNode) {}

  visit_package(node: JSONNode) {
    // TODO?
  }

  visit_module(node: JSONNode) {
    this.findChildren(node, 'var', false).forEach((n) => {
      if (isVarDecl(n.obj)) {
        this.cur_module.vardefs[n.obj.name] = n.obj;
      }
    });
    this.modules[this.cur_module.name] = this.cur_module;
    this.cur_module = null!;
  }

  visit_var(node: JSONNode): HDLVariableDef {
    let name = node.attrs['name'];
    name = this.name2js(name);
    const vardef: HDLVariableDef = {
      $loc: this.parseSourceLocation(node),
      name: name,
      origName: node.attrs['origName'],
      isInput: node.attrs['dir'] == 'input',
      isOutput: node.attrs['dir'] == 'output',
      isParam: node.attrs['param'] == 'true',
      dtype: null!,
    };
    this.deferDataType(node, vardef);
    const const_nodes = this.findChildren(node, 'const', false);
    if (const_nodes.length) {
      vardef.constValue = const_nodes[0].obj;
    }
    const init_nodes = this.findChildren(node, 'initarray', false);
    if (init_nodes.length) {
      vardef.initValue = init_nodes[0].obj;
    }
    return vardef;
  }

  visit_const(node: JSONNode): HDLConstant {
    const name = node.attrs['name'];
    const { value, origWidth } = this.parseConstValue(name);
    const constdef: HDLConstant = {
      $loc: this.parseSourceLocation(node),
      dtype: null!,
      cvalue: typeof value === 'number' ? value : null!,
      bigvalue: typeof value === 'bigint' ? value : null!,
      origWidth,
    };
    this.deferDataType(node, constdef);
    return constdef;
  }

  visit_varref(node: JSONNode): HDLVarRef {
    let name = node.attrs['name'];
    name = this.name2js(name);
    const varref: HDLVarRef = {
      $loc: this.parseSourceLocation(node),
      dtype: null!,
      refname: name,
    };
    this.deferDataType(node, varref);
    const mod = this.cur_module;
    /*
        this.defer2(() => {
            varref.vardef = this.resolveVar(name, mod);
        });
        */
    return varref;
  }

  visit_sentree(node: JSONNode) {
    // TODO
  }

  visit_always(node: JSONNode): HDLAlwaysBlock {
    // TODO
    let sentree: HDLSensItem[] | null;
    let expr: HDLExpr;
    if (node.children.length == 2) {
      sentree = node.children[0].obj as HDLSensItem[];
      expr = node.children[1].obj as HDLExpr;
      // TODO: check sentree
    } else {
      sentree = null;
      expr = node.children[0].obj as HDLExpr;
    }
    const always: HDLAlwaysBlock = {
      $loc: this.parseSourceLocation(node),
      blocktype: node.type,
      name: null!,
      senlist: sentree!,
      exprs: [expr],
    };
    this.cur_module.blocks.push(always);
    return always;
  }

  visit_begin(node: JSONNode): HDLBlock {
    const exprs: HDLExpr[] = [];
    node.children.forEach((n) => exprs.push(n.obj));
    return {
      $loc: this.parseSourceLocation(node),
      blocktype: node.type,
      name: node.attrs['name'],
      exprs: exprs,
    };
  }

  visit_initarray(node: JSONNode): HDLBlock {
    return this.visit_begin(node);
  }

  visit_inititem(node: JSONNode): HDLArrayItem {
    this.expectChildren(node, 1, 1);
    return {
      index: parseInt(node.attrs['index']),
      expr: node.children[0].obj,
    };
  }

  visit_cfunc(node: JSONNode) {
    if (this.cur_module == null) {
      return;
    }
    const block = this.visit_begin(node);
    block.exprs = [];
    node.children.forEach((n) => {
      if(n.attrs["JSONfrom"] == "argsp") {
        if(n.type != "var") return; // Skips assigns with cresets
        n.attrs["param"] = "true";
        n.obj.isParam = true;
      }
      block.exprs.push(n.obj)
    });
    this.cur_module.blocks.push(block);
    return block;
  }

  visit_cuse(node: JSONNode) {
    // TODO?
  }

  visit_instance(node: JSONNode): HDLInstanceDef {
    const instance: HDLInstanceDef = {
      $loc: this.parseSourceLocation(node),
      name: node.attrs['name'],
      origName: node.attrs['origName'],
      ports: [],
      module: null!,
    };
    node.children.forEach((child) => {
      instance.ports.push(child.obj);
    });
    this.cur_module.instances.push(instance);
    this.defer(() => {
      instance.module = this.resolveModule(node.attrs['defName']);
    });
    return instance;
  }

  visit_iface(node: JSONNode) {
    throw new CompileError(this.cur_loc, `interfaces not supported`);
  }

  visit_intfref(node: JSONNode) {
    throw new CompileError(this.cur_loc, `interfaces not supported`);
  }

  visit_port(node: JSONNode): HDLPort {
    this.expectChildren(node, 1, 1);
    const varref: HDLPort = {
      $loc: this.parseSourceLocation(node),
      name: node.attrs['name'],
      expr: node.children[0].obj,
    };
    return varref;
  }

  visit_netlist(node: JSONNode) {}

  visit_files(node: JSONNode) {}

  visit_module_files(node: JSONNode) {
    node.children.forEach((n) => {
      if (n.obj) {
        const file = this.files[(n.obj as HDLFile).id];
        if (file) file.isModule = true;
      }
    });
  }

  visit_file(node: JSONNode) {
    return this.visit_file_or_module(node, false);
  }

  // TODO
  visit_scope(node: JSONNode) {}

  visit_topscope(node: JSONNode) {}

  visit_file_or_module(node: JSONNode, isModule: boolean): HDLFile {
    const file: HDLFile = {
      id: node.attrs['id'],
      filename: node.attrs['filename'],
      isModule: isModule,
    };
    this.files[file.id] = file;
    return file;
  }

  visit_cells(node: JSONNode) {
    this.expectChildren(node, 1, 9999);
    const hier = node.children[0].obj as HDLHierarchyDef;
    if (hier != null) {
      const hiername = hier.name;
      this.hierarchies[hiername] = hier;
    }
  }

  visit_cell(node: JSONNode): HDLHierarchyDef {
    const hier: HDLHierarchyDef = {
      $loc: this.parseSourceLocation(node),
      name: node.attrs['name'],
      module: null!,
      parent: null!,
      children: node.children.map((n) => n.obj),
    };
    if (node.children.length > 0)
      throw new CompileError(this.cur_loc, `multiple non-flattened modules not yet supported`);
    node.children.forEach((n) => ((n.obj as HDLHierarchyDef).parent = hier));
    this.defer(() => {
      hier.module = this.resolveModule(node.attrs['submodname']);
    });
    return hier;
  }

  parseRange(text: string | undefined): [number, number] {
    if(!text) {
      return [0, 0]
    }
    const [high, low] = text.split(':').map(Number);
    
    return [high, low];
  }

  visit_basicdtype(node: JSONNode): HDLDataType {
    let id = node.attrs['dtypep'];
    let dtype: HDLDataType;
    const dtypename = node.attrs['name'];
    switch (dtypename) {
      case 'logic':
      case 'integer': // TODO?
      case 'bit':
        const [msb, lsb] = this.parseRange(node.attrs['range']);
        let dlogic: HDLLogicType = {
          $loc: this.parseSourceLocation(node),
          left: msb,
          right: lsb,
          signed: node.attrs['signed'] == 'true',
        };
        dtype = dlogic;
        break;
      case 'VlTriggerVec': // TODO
        let dtrigger: HDLVlTriggerVecType = {
          $loc: this.parseSourceLocation(node),
          left: parseInt(node.attrs['left'] || '0'),
          right: parseInt(node.attrs['right'] || '0'),
          signed: node.attrs['signed'] == 'true',
        };
        dtype = dtrigger;
        break
      case 'string':
        let dstring: HDLNativeType = {
          $loc: this.parseSourceLocation(node),
          jstype: 'string',
        };
        dtype = dstring;
        break;
      default:
        dtype = this.dtypes[dtypename];
        if (dtype == null) {
          throw new CompileError(this.cur_loc, `unknown data type ${dtypename}`);
        }
    }
    this.dtypes[id] = dtype;
    return dtype;
  }

  visit_refdtype(node: JSONNode) {}

  visit_enumdtype(node: JSONNode) {}

  visit_enumitem(node: JSONNode) {}

  visit_packarraydtype(node: JSONNode): HDLDataType {
    // TODO: packed?
    return this.visit_unpackarraydtype(node);
  }

  visit_memberdtype(node: JSONNode) {
    throw new CompileError(null!, `structs not supported`);
  }

  visit_constdtype(node: JSONNode) {
    // TODO? throw new CompileError(null, `constant data types not supported`);
  }

  visit_paramtypedtype(node: JSONNode) {
    // TODO? throw new CompileError(null, `constant data types not supported`);
  }

  visit_unpackarraydtype(node: JSONNode): HDLDataType {
    let id = node.attrs['dtypep'];
    let sub_dtype_id = node.attrs['refDTypep'];
    let range = node.children[0].obj as HDLBinop;
    if (isConstExpr(range.left) && isConstExpr(range.right)) {
      const dtype: HDLUnpackArray = {
        $loc: this.parseSourceLocation(node),
        subtype: null!,
        low: range.left,
        high: range.right,
      };
      this.dtypes[id] = dtype;
      this.defer(() => {
        dtype.subtype = this.dtypes[sub_dtype_id];
        if (!dtype.subtype)
          throw new CompileError(this.cur_loc, `Unknown data type ${sub_dtype_id} for array`);
      });
      return dtype;
    } else {
      throw new CompileError(this.cur_loc, `could not parse constant exprs in array`);
    }
  }

  visit_senitem(node: JSONNode): HDLSensItem {
    const edgeType = node.attrs['edgeType'];
    if (edgeType != 'POS' && edgeType != 'NEG')
      throw new CompileError(this.cur_loc, 'POS/NEG required');
    return {
      $loc: this.parseSourceLocation(node),
      edgeType: edgeType,
      expr: node.obj,
    };
  }

  visit_text(node: JSONNode) {}

  visit_cstmt(node: JSONNode) {} // For debugs, so disabled

  visit_cfile(node: JSONNode) {}

  visit_typetable(node: JSONNode) {}

  visit_constpool(node: JSONNode) {}

  visit_comment(node: JSONNode) {}

  expectChildren(node: JSONNode, low: number, high: number) {
    if (node.children.length < low || node.children.length > high)
      throw new CompileError(this.cur_loc, `expected between ${low} and ${high} children`);
  }

  __visit_unop(node: JSONNode): HDLUnop {
    this.expectChildren(node, 1, 1);
    const expr: HDLUnop = {
      $loc: this.parseSourceLocation(node),
      op: node.type,
      dtype: null!,
      left: node.children[0].obj as HDLExpr,
    };
    this.deferDataType(node, expr);
    return expr;
  }

  visit_extend(node: JSONNode): HDLUnop {
    const unop = this.__visit_unop(node) as HDLExtendop;
    unop.width = parseInt(node.attrs['width']);
    unop.widthminv = parseInt(node.attrs['widthminv']);
    return unop;
  }

  visit_extends(node: JSONNode): HDLUnop {
    return this.visit_extend(node);
  }

  __visit_binop(node: JSONNode): HDLBinop {
    this.expectChildren(node, 2, 2);
    const expr: HDLBinop = {
      $loc: this.parseSourceLocation(node),
      op: node.type,
      dtype: null!,
      left: node.children[0].obj as HDLExpr,
      right: node.children[1].obj as HDLExpr,
    };
    this.deferDataType(node, expr);
    return expr;
  }

  visit_if(node: JSONNode): HDLTriop {
    this.expectChildren(node, 2, 3);
    const expr: HDLTriop = {
      $loc: this.parseSourceLocation(node),
      op: 'if',
      dtype: null!,
      cond: node.children[0].obj as HDLExpr,
      left: node.children[1].obj as HDLExpr,
      right: node.children[2] && (node.children[2].obj as HDLExpr),
    };
    return expr;
  }

  // while and for loops
  visit_while(node: JSONNode): HDLWhileOp {
    //this.expectChildren(node, 2, 4);
    // The structure of whiles now is different
    // everything that is not a "LOOPTEST belongs to the body"
    // We need to create a mock node for the body only
    var node_body: JSONNode = { 
      type: "begin",
      text: null, 
      children: node.children.filter(x => x.type != "looptest"), 
      attrs: {},
      obj: null };
    const expr: HDLWhileOp = {
      $loc: this.parseSourceLocation(node),
      op: 'while',
      dtype: null!,
      precond: node.children[0].type === "looptest" 
          ? (node.children[0].obj as HDLExpr) 
          : null!,
      loopcond: node.children[node.children.length-1].type === "looptest" 
          ? (node.children[node.children.length-1].obj as HDLExpr) 
          : null!,
      body: this.visit_begin(node_body),
      inc: null!, // No more increments
    };
    return expr;
  }

  visit_loop(node: JSONNode): HDLWhileOp {
    return this.visit_while(node)
  }

  visit_looptest(node: JSONNode) {
    return this.visit_begin(node)  // Is just another begin
  }

  __visit_triop(node: JSONNode): HDLBinop {
    this.expectChildren(node, 3, 3);
    const expr: HDLTriop = {
      $loc: this.parseSourceLocation(node),
      op: node.type,
      dtype: null!,
      cond: node.children[0].obj as HDLExpr,
      left: node.children[1].obj as HDLExpr,
      right: node.children[2].obj as HDLExpr,
    };
    this.deferDataType(node, expr);
    return expr;
  }

  __visit_func(node: JSONNode): HDLFuncCall {
    const expr: HDLFuncCall = {
      $loc: this.parseSourceLocation(node),
      dtype: null!,
      funcname: node.attrs['func'] || '$' + node.type,
      args: node.children.map((n) => n.obj as HDLExpr),
    };
    this.deferDataType(node, expr);
    return expr;
  }

  visit_not(node: JSONNode) {
    return this.__visit_unop(node);
  }
  visit_negate(node: JSONNode) {
    return this.__visit_unop(node);
  }
  visit_redand(node: JSONNode) {
    return this.__visit_unop(node);
  }
  visit_redor(node: JSONNode) {
    return this.__visit_unop(node);
  }
  visit_redxor(node: JSONNode) {
    return this.__visit_unop(node);
  }
  visit_initial(node: JSONNode) {
    return this.__visit_unop(node);
  }
  visit_ccast(node: JSONNode) {
    return this.__visit_unop(node);
  }
  visit_creset(node: JSONNode) {
    if(node.children.length == 0) {
      // Treat it as a zero constant
      var elemp_node: JSONNode = { 
        type: "const", 
        text: null, 
        children: [], 
        attrs: { ...node.attrs }, 
        obj: null };
      elemp_node.attrs["name"] = "0";
      return this.visit_const(elemp_node);
    }
    return this.__visit_unop(node);
  }
  visit_creturn(node: JSONNode) {
    return this.__visit_unop(node);
  }

  visit_assignw(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_assigndly(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_assignpre(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_assignpost(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_assign(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_arraysel(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_wordsel(node: JSONNode) {
    return this.__visit_binop(node);
  }

  visit_eq(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_neq(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_lte(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_gte(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_lt(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_gt(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_and(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_or(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_xor(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_add(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_sub(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_concat(node: JSONNode) {
    return this.__visit_binop(node);
  } // TODO?
  visit_shiftl(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_shiftr(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_shiftrs(node: JSONNode) {
    return this.__visit_binop(node);
  }

  visit_mul(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_div(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_moddiv(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_muls(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_divs(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_moddivs(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_gts(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_lts(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_gtes(node: JSONNode) {
    return this.__visit_binop(node);
  }
  visit_ltes(node: JSONNode) {
    return this.__visit_binop(node);
  }
  // TODO: more?

  visit_range(node: JSONNode) {
    return this.__visit_binop(node);
  }

  visit_cond(node: JSONNode) {
    return this.__visit_triop(node);
  }
  visit_condbound(node: JSONNode) {
    return this.__visit_triop(node);
  }
  visit_sel(node: JSONNode) {
    return this.__visit_triop(node);
  }

  visit_changedet(node: JSONNode) {
    if (node.children.length == 0) return null;
    else return this.__visit_binop(node);
  }

  visit_ccall(node: JSONNode) {
    return this.__visit_func(node);
  }
  visit_finish(node: JSONNode) {
    return this.__visit_func(node);
  }
  visit_stop(node: JSONNode) {
    return this.__visit_func(node);
  }
  visit_rand(node: JSONNode) {
    return this.__visit_func(node);
  }
  visit_time(node: JSONNode) {
    return this.__visit_func(node);
  }

  visit_display(node: JSONNode) {
    return null;
  }
  visit_sformatf(node: JSONNode) {
    return null;
  }
  visit_scopename(node: JSONNode) {
    return null;
  }

  visit_readmem(node: JSONNode) {
    return this.__visit_func(node);
  }

  // Expressions for verilator 5 (TODO)

  visit_stmtexpr(node: JSONNode) {
    return this.__visit_unop(node); // A single operation
  }

  visit_textblock(node: JSONNode) {
    // TODO
    return null;
  }

  visit_cmethodhard(node: JSONNode) {
    const name = node.attrs['name'];
    node.type = name; // To propagate to Xop
    // Depends on the name, is the operation
    if(node.children.length == 1) {
      return this.__visit_unop(node); // One op
    }
    else if(node.children.length == 2) {
      return this.__visit_binop(node); // Two ops
    }
    else if(node.children.length == 3) {
      return this.__visit_triop(node); // Three ops
    }
    else {
      return; // TODO: No fail?
    }
  }

  visit_logand(node: JSONNode) {
      return this.__visit_binop(node);
  }

  visit_voiddtype(node: JSONNode) {
    let id = node.attrs['dtypep'];
    let dtype: HDLDataType;

    // Is actually useless
    let dstring: HDLNativeType = {
      $loc: this.parseSourceLocation(node),
      jstype: 'undefined',
    };
    dtype = dstring;

    this.dtypes[id] = dtype;
    return dtype;
  }

  //

  xml_open(node: JSONNode) {
    this.cur_node = node;
    const method = (this as any)[`open_${node.type}`];
    if (method) {
      return method.bind(this)(node);
    }
  }

  xml_close(node: JSONNode) {
    this.cur_node = node;
    const method = (this as any)[`visit_${node.type}`];
    if (method) {
      return method.bind(this)(node);
    } else {
      throw new CompileError(this.cur_loc, `no visitor for ${node.type}`);
    }
  }

  parse(jsons: string) {
    parseJSONPoorly(jsons, this.xml_open.bind(this), this.xml_close.bind(this));

    this.cur_node = null!;
    this.run_deferred();
  }
}
