import { ErrorParser } from './ErrorParser';
import verilated_std_sv from './verilated_std.sv?raw';
import verilated_std_waiver_vlt from './verilated_std_waiver.vlt?raw';
import verilator_bin from './verilator_bin';

let browserWasmBin: ArrayBuffer | null = null;

export interface ICompileOptions {
  topModule: string;
  sources: Record<string, string>;
  wasmBinary?: ArrayBuffer | Buffer;
}

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

  const verilatorInst = verilator_bin({
    wasmBinary,
    noInitialRun: true,
    noExitRuntime: true,
    print: console.log,
    printErr: (message: string) => {
      console.log(message);
      errorParser.feedLine(message);
    },
  });
  await verilatorInst.ready;
  const { FS } = verilatorInst;

  let sourceList: string[] = [];
  let cwd = FS.cwd();
  console.log(cwd);
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
  var contents = FS.readdir('/');
  console.log(contents);
  const jsonPath = `obj_dir/V${opts.topModule}.tree.json`;
  try {
    // args = verilator_bin --cc -O3 -Wall -Wno-EOFNEWLINE -Wno-DECLFILENAME -Wno-UNOPTFLAT -Wno-BLKSEQ -Wno-UNDRIVEN -Wno-PINMISSING -Wno-UNUSED -Wno-WIDTHTRUNC --x-assign fast --debug-check --top-module tt_um_vga_example project.v ../common/hvsync_generator.v
    const args = [
      '--cc',
      '-O3',
      '-Wall',
      '-Wno-EOFNEWLINE',
      '-Wno-DECLFILENAME',
      // Why do you even care?
      '-Wno-UNOPTFLAT',
      '-Wno-BLKSEQ',
      '-Wno-UNDRIVEN',
      '-Wno-PINMISSING',
      '-Wno-UNUSED',
      '-Wno-WIDTHTRUNC',
      '--x-assign',
      'fast',
      '--debug-check', // for XML output
      '-Isrc/',
      '--top-module',
      opts.topModule,
      ...sourceList,
    ];
    verilatorInst.callMain(args);
  } catch (e) {
    console.log(e);
    errorParser.errors.push({
      type: 'error',
      file: '',
      line: 1,
      column: 1,
      message: 'Compilation failed: ' + e,
    });
  }

  if (errorParser.errors.filter((e) => e.type === 'error').length) {
    return { errors: errorParser.errors };
  }

  function downloadRawFile(content: string, fileName: string, contentType: string = 'text/plain') {
    // 1. Create a Blob from the raw string
    const blob = new Blob([content], { type: contentType });

    // 2. Create a temporary URL pointing to that Blob
    const url = window.URL.createObjectURL(blob);

    // 3. Create a hidden 'a' element
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;

    // 4. Append to body, click it, and remove it
    document.body.appendChild(link);
    link.click();

    // Clean up
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }

  var jsonContent = null;
  try {
    jsonContent = FS.readFile(jsonPath, { encoding: 'utf8' });
  } catch (e) {
    console.log(e, (e as Error).stack);

    return {
      errors: [
        ...errorParser.errors,
        {
          type: 'error' as const,
          file: '',
          line: 1,
          column: 1,
          message: 'JSON parsing failed: ' + e,
        },
      ],
    };
  }
  return {
    errors: errorParser.errors,
    output: jsonContent,
  };
}
