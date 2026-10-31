import { VModel } from '../sim/hdltypes';
import { VerilogJSONParser } from '../sim/vjsonparser';
import { ErrorParser } from './ErrorParser';
import verilated_std_sv from './verilated_std.sv?raw';
import verilated_std_waiver_vlt from './verilated_std_waiver.vlt?raw';
import verilator_bin from './verilator_bin';

let browserWasmBin: ArrayBuffer | null = null;

/** Debug helper: offer a text file for download (browser only) */
export function downloadRawFile(
  content: string,
  fileName: string,
  contentType: string = 'text/plain',
) {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: contentType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

/** True when the page was opened with ?debug (enables artifact downloads) */
export function isDebugMode() {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');
}

export interface ICompileOptions {
  topModule: string;
  sources: Record<string, string>;
  wasmBinary?: ArrayBuffer | Buffer;
  /** extra verilator arguments (e.g. -DFOO) */
  extraArgs?: string[];
}

export const VERILATOR_ARGS = [
  '--cc',
  '-O3',
  '-Wall',
  '-Wno-fatal', // lint warnings are reported as markers, but don't stop the simulation
  '-Wno-EOFNEWLINE',
  '-Wno-DECLFILENAME',
  '-Wno-UNOPTFLAT',
  '-Wno-BLKSEQ',
  '-Wno-UNDRIVEN',
  '-Wno-PINMISSING',
  '-Wno-UNUSED',
  '-Wno-WIDTHTRUNC',
  '--x-assign',
  'fast',
  '--debug-check', // dumps the final tree as JSON (obj_dir/V<top>.tree.json)
];

export async function compileVerilator(opts: ICompileOptions) {
  let wasmBinary = opts.wasmBinary;
  if (!wasmBinary) {
    if (!browserWasmBin) {
      const { default: wasmUrl } = await import('./verilator_bin.wasm?url');
      browserWasmBin = await fetch(wasmUrl).then((res) => res.arrayBuffer());
    }
    wasmBinary = browserWasmBin ?? undefined;
  }

  const errorParser = new ErrorParser();

  // Emscripten >= 3.1.5x: the factory returns a promise of the module
  const verilatorInst = await verilator_bin({
    wasmBinary,
    noInitialRun: true,
    noExitRuntime: true,
    print: () => {},
    printErr: (message: string) => {
      errorParser.feedLine(message);
    },
  });
  if (verilatorInst.ready) await verilatorInst.ready; // older emscripten
  const { FS } = verilatorInst;

  const sourceList: string[] = [];
  FS.mkdir('src');
  FS.mkdir('/share');
  FS.mkdir('/share/verilator');
  FS.mkdir('/share/verilator/include');
  FS.writeFile('/share/verilator/include/verilated_std_waiver.vlt', verilated_std_waiver_vlt);
  FS.writeFile('/share/verilator/include/verilated_std.sv', verilated_std_sv);
  for (const [name, source] of Object.entries(opts.sources)) {
    const path = `src/${name}`;
    FS.writeFile(path, source);
    // Header files (.vh/.svh) are pulled in via `include, not as direct sources
    if (!name.endsWith('.vh') && !name.endsWith('.svh')) {
      sourceList.push(path);
    }
  }
  const jsonPath = `obj_dir/V${opts.topModule}.tree.json`;
  const metaPath = `obj_dir/V${opts.topModule}.tree.meta.json`;
  try {
    verilatorInst.callMain([
      ...VERILATOR_ARGS,
      ...(opts.extraArgs ?? []),
      '-Isrc/',
      '--top-module',
      opts.topModule,
      ...sourceList,
    ]);
  } catch (e) {
    // Verilator exits through exit(), which emscripten reports as an exception
    const status = (e as { status?: number }).status;
    if (status !== 0) {
      errorParser.errors.push({
        type: 'error',
        file: '',
        line: 1,
        column: 1,
        message: 'Compilation failed: ' + e,
      });
    }
  }

  if (errorParser.errors.filter((e) => e.type === 'error').length) {
    return { errors: errorParser.errors };
  }

  let jsonContent = '';
  try {
    jsonContent = FS.readFile(jsonPath, { encoding: 'utf8' });
    const parser = new VerilogJSONParser();
    try {
      parser.setFileNames(JSON.parse(FS.readFile(metaPath, { encoding: 'utf8' })));
    } catch {}
    const output: VModel = parser.parse(jsonContent);
    for (const w of output.warnings) console.warn(w);
    return { errors: errorParser.errors, output };
  } catch (e) {
    console.error(e);
    if (isDebugMode() && jsonContent) downloadRawFile(jsonContent, `V${opts.topModule}.json`);
    const loc = (e as { loc?: { path?: string; line?: number } }).loc;
    return {
      errors: [
        ...errorParser.errors,
        {
          type: 'error' as const,
          file: loc?.path?.replace(/^src\//, '') ?? '',
          line: loc?.line ?? 1,
          column: 1,
          message: 'Simulation model generation failed: ' + (e instanceof Error ? e.message : e),
        },
      ],
    };
  }
}
