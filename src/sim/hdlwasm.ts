import binaryen from 'binaryen';
import { HDLModuleRunner } from './hdltypes';

const VERILATOR_UNIT_FUNCTIONS = [
  '_ctor_var_reset',
  '_eval_initial',
  '_eval_settle',
  '_eval',
  '_eval_phase__stl',
  '_eval_static',
];

interface Options {
  store?: boolean;
  //  funcblock?: HDLBlock;
  funcarg?: boolean;
  resulttype?: number;
}

const GLOBALOFS = 0;
const MEMORY = '$$MEM';
const GLOBAL = '$$GLOBAL';
const CHANGEDET = '$$CHANGE';
const TRACERECLEN = '$$treclen';
const TRACEOFS = '$$tofs';
const TRACEEND = '$$tend';
const TRACEBUF = '$$tbuf';

export class HDLModuleWASM implements HDLModuleRunner {
  bmod!: binaryen.Module;
  instance!: WebAssembly.Instance;

  hdlmod: any;
  constpool: any | null;
  globals!: any;
  locals!: any;
  databuf!: ArrayBuffer;
  data8!: Uint8Array;
  data16!: Uint16Array;
  data32!: Uint32Array;
  getFileData: ((filename: string) => string | Uint8Array | undefined) | null = null;
  maxMemoryMB: number;
  optimize: boolean = false;
  maxEvalIterations: number = 8;

  state: any;
  statebytes!: number;
  outputbytes!: number;

  traceBufferSize: number = 0xff000;
  traceRecordSize!: number;
  traceReadOffset!: number;
  traceStartOffset!: number;
  traceEndOffset!: number;
  trace: any;

  randomizeOnReset: boolean = false;
  finished!: boolean;
  stopped!: boolean;
  resetStartTimeMsec!: number;

  rawwasm!: string;

  _tick2!: (ofs: number, iters: number) => void;

  constructor(moddef: any, constpool: any | null, maxMemoryMB?: number) {
    this.maxMemoryMB = maxMemoryMB || 16;
  }

  eval(): void {}

  tick(): void {}

  tick2(iters: number) {}

  powercycle(): void {}

  isFinished(): boolean {
    return false;
  }

  isStopped(): boolean {
    return false;
  }

  saveState(): {} {
    return {};
  }

  loadState(state: {}): void {}

  dispose(): void {}

  getGlobals(): {} {
    return {};
  }
}
