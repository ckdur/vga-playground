import { EmuHalt, SourceLocation } from './emu';

export class HDLError extends EmuHalt {
  obj: any;
  constructor(obj: any, msg: string) {
    super(msg, obj ? obj.$loc : null);
    Object.setPrototypeOf(this, HDLError.prototype);
    this.obj = obj;
    if (obj) console.log(obj);
  }
}

interface HDLFile {
  id: string;
  filename: string;
  isModule: boolean;
}

interface HDLSourceLocation extends SourceLocation {
  hdlfile: HDLFile;
  end_line?: number;
}

interface HDLSourceObject {
  $loc?: HDLSourceLocation;
}

class HDLCompileError extends Error implements HDLSourceObject {
  $loc: HDLSourceLocation;
  constructor($loc: HDLSourceLocation | undefined, msg: string) {
    super(msg);
    this.$loc = $loc ?? {
      hdlfile: { id: '', filename: 'no_file', isModule: false },
      path: 'no_file',
      line: 0,
      start: 0,
      end_line: 0,
      end: 0,
    };
    Object.setPrototypeOf(this, HDLCompileError.prototype);
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

export interface HDLDataTypeObject extends HDLSourceObject {
  dtype: HDLDataType;
}

export interface HDLConstant extends HDLDataTypeObject {
  cvalue: number;
  bigvalue: bigint;
  /** Original bit width from Verilog literal (e.g., 28 for 28'sh4000) */
  origWidth?: number;
}

export interface HDLLogicType extends HDLSourceObject {
  left: number;
  right: number;
  signed: boolean;
}

export interface HDLUnpackArray extends HDLSourceObject {
  subtype: HDLDataType;
  low: HDLConstant;
  high: HDLConstant;
}

export interface HDLNativeType extends HDLSourceObject {
  jstype: string;
}

export type HDLDataType = HDLLogicType | HDLUnpackArray | HDLNativeType;

interface HDLNode {
  type: string;
  name: string;
  loc: string;
  cur_loc: HDLSourceLocation | undefined;
  [key: string]: any;
}

interface HDLFileNode extends HDLNode {
  source: boolean;
  slow: boolean;
}

interface HDLModuleNode extends HDLNode {
  stmtsp: HDLNode[];
}

interface HDLNetlistNode extends HDLNode {
  modulesp: HDLModuleNode[];
  filesp: HDLFileNode[];
  miscp: any[];
}

export class HDLNetlist {
  data: HDLNetlistNode;
  files: { [id: string]: HDLFile } = {};
  dtypes: { [id: string]: HDLDataType } = {};

  constructor(public content: string) {
    this.data = JSON.parse(content) as HDLNetlistNode;
    this.parse(this.data);
  }

  parseSourceLocation(node: HDLNode): void {
    const loc = node.loc;
    if (loc) {
      const [fileid, line, col, end_line, end_col] = loc.split(/[,:]/);
      const file = this.files[fileid] ?? { id: '', filename: 'no_file', isModule: false };
      const filename = file.filename ?? fileid;
      const $loc = {
        hdlfile: file,
        path: filename,
        line: parseInt(line),
        start: parseInt(col) - 1,
        end_line: parseInt(end_line),
        end: parseInt(end_col) - 1,
      };
      node.cur_loc = $loc;
    }
  }

  private parse(node: HDLNode) {
    this.parseSourceLocation(node);
    // Call the XXX_init function
    const method = (this as any)[`${node.type}_init`];
    if (method) {
      return method.bind(this)(node);
    } else {
      throw new HDLCompileError(node.cur_loc, `no init for ${node.type}`);
    }
  }

  NETLIST_init(obj: HDLNetlistNode) {}

  findModuleByName(name: string): HDLModuleNode | undefined {
    return this.data.modulesp.find((m) => m.name === name);
  }
}
