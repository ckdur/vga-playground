import { EmuHalt } from './emu';

export class HDLError extends EmuHalt {
  obj: any;
  constructor(obj: any, msg: string) {
    super(msg, obj ? obj.$loc : null);
    Object.setPrototypeOf(this, HDLError.prototype);
    this.obj = obj;
    if (obj) console.log(obj);
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

interface HDLNode {
  type: string;
  name: string;
  loc: string;
  init(): void;
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

function NETLIST_init(obj: HDLNetlistNode) {
  obj.modulesp.forEach((m) => m.init());
  obj.filesp.forEach((f) => f.init());
  obj.miscp.forEach((x) => x.init());
}

class HDLNetlist {
  constructor(public data: HDLNetlistNode) {
    data.modulesp.forEach((m) => {});
  }

  findModuleByName(name: string): HDLModuleNode | undefined {
    return this.data.modulesp.find((m) => m.name === name);
  }
}
