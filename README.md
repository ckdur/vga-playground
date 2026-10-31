# Tiny Tapeout VGA Playground

Online version: https://vga-playground.com/

Write and run verilog code to generate VGA signals in the browser, then manufacture your project with [Tiny Tapeout](https://tinytapeout.com/).

## Development

You'll need to have [Node.js](https://nodejs.org) installed on your computer and clone this repository.

Then you can install the dependencies and run the development server:

```bash
npm install
npm start
```

To view the playground, open `http://localhost:5173` in your browser.

### Tests

```bash
npm test          # unit, integration and torture tests
npm run typecheck
```

### Simulator internals

The Verilog code is compiled in the browser by [Verilator](https://github.com/verilator/verilator)
(itself compiled to WebAssembly), and the model Verilator produces is translated
to WebAssembly by the playground. See:

- [`src/sim/README.md`](src/sim/README.md): how the simulator works
- [`verilator/README.md`](verilator/README.md): how to build `verilator_bin.wasm`
- [`src/sim/torture/README.md`](src/sim/torture/README.md): torture tests against native Verilator,
  and how to check your own designs (including gate-level netlists)

## URL Parameters

You can use URL parameters to load a specific preset or a project from GitHub:

### Load a preset

    https://vga-playground.com/?preset=music

Available presets: `stripes`, `music`, `rings`, `logo`, `conway`, `checkers`, `drop`, `gamepad`

### Load a project from GitHub

    https://vga-playground.com/?repo=https://github.com/urish/tt-rings

This fetches `info.yaml` from the repository to discover source files, then loads them into the editor. The repository must follow the [Tiny Tapeout](https://tinytapeout.com/) project structure.

Optionally, specify a git ref (branch, tag, or commit hash) to load a specific version:

    https://vga-playground.com/?repo=https://github.com/urish/tt-rings&ref=main

If `ref` is not specified, defaults to `main` (then `master`).
