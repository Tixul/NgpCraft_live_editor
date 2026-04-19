// Test-only headless loader for the NgpCraft live-editor JS modules. Same
// pattern as the MCP server's _transpiler_loader.js: load the bare scripts
// into a Node `vm` context, then read the bindings from the sandbox.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JS_DIR = join(__dirname, "..", "js");

// Order matters: api.js defines NGPC_API which interpreter buildEnv depends on.
const FILES = [
  "api.js",
  "memory.js",
  "runtime.js",
  "psg.js",        // PSG state model — Node-safe (init() guards on `window`)
  "font_data.js",
  "font.js",
  "interpreter.js",
  "asset_tools.js",
  "vdp.js",
];

let cached = null;
export function loadInterp() {
  if (cached) return cached;
  const sandbox = { console, performance: { now: () => Date.now() } };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of FILES) {
    vm.runInContext(readFileSync(join(JS_DIR, f), "utf8"), ctx, { filename: f });
  }
  cached = {
    Interp: sandbox.NGPC_Interp,
    Memory: sandbox.NGPC_Memory,
    Runtime: sandbox.NGPC_Runtime,
    AssetTools: sandbox.NGPC_AssetTools,
    VDP: sandbox.NGPC_VDP,
    PSG: sandbox.NGPC_PSG,
  };
  return cached;
}
