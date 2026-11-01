// banjo-nx-installer: the page's whole shader build (lib/build.js) in Node on a game folder, and its results against
// banjo-nx's native build:
//   node test/full_node.mjs <game folder> <banjo-nx root> <out folder> [--nro=<NRO or its GLSL package>] [--threads=N]
// Writes <out>/deko3d_glsl.bin and <out>/deko3d_shaders.bin (game data: never committed or distributed) and checks:
//   - every shader of the native dump made, and its numbers equal to the native shader table's (app/out/pc-me);
//   - how many GLSL texts are the native glsl_opt_any's (the rest differ by DXC's version, test/chain_node.mjs);
//   - every variant compiled, and those of a native GLSL byte for byte the native DKSH cache's (--cache=).
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPython } from '../lib/py.js';
import { dumpContainers, makeGlsl, packageShaders, variantJobs, compileVariants } from '../lib/build.js';
import { nroShaders } from '../lib/nro.js';
import { workerPool, uamCompile, glslMaker } from '../lib/pool.js';
import { parseVariants, readCache } from '../lib/variants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const [game, banjo, outDir] = process.argv.slice(2);
const opt = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const threads = Number(opt('threads', 8));
const nroPath = opt('nro', path.join(banjo, 'app', 'out', 'renut_switch_dist', 'deko3d_glsl.bin'));
const cachePath = opt('cache', path.join(banjo, 'out', 'deko3d_shaders', 'deko3d_shaders_60.bin'));
fs.mkdirSync(outDir, { recursive: true });
const log = (s) => console.log(`[${((performance.now() - T0) / 1000).toFixed(0)} s] ${s}`);
const T0 = performance.now();
let lastShown = 0;
const progress = (label) => (f) => {
  const now = performance.now();
  if (now - lastShown > 15000 || f === 1) { lastShown = now; log(`${label} ${(100 * f).toFixed(0)} %`); }
};

// count workers of a test/*_node.mjs script, each started and ready
async function startWorkers(script, count) {
  return Promise.all(Array.from({ length: count }, async () => {
    const w = new Worker(path.join(here, script));
    await new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
    return { post: (m, t) => w.postMessage(m, t), onMessage: (cb) => w.on('message', cb), w };
  }));
}

const imp = async (f) => (await import(pathToFileURL(path.join(root, 'wasm', f)).href)).default;
const quiet = () => ({ print: () => {}, printErr: () => {} });
const tr = await (await imp('renut_hlsl.mjs'))(quiet());
const { loadPyodide } = await import(pathToFileURL(path.join(root, 'vendor', 'pyodide', 'pyodide.mjs')).href);
const py = await loadPython(loadPyodide, path.join(root, 'vendor', 'pyodide') + path.sep,
                            async (n) => fs.readFileSync(path.join(root, 'py', n), 'utf8'));
log('modules loaded');

// 1. the containers
const files = [path.join(game, 'default.xex')];
for (const sub of fs.readdirSync(path.join(game, 'Bundle')).sort()) {
  for (const f of fs.readdirSync(path.join(game, 'Bundle', sub)).sort()) files.push(path.join(game, 'Bundle', sub, f));
}
const containers = await dumpContainers(files.map((p) => ({ path: p, read: async () => new Uint8Array(fs.readFileSync(p)) })),
                                        py, log, progress('dump'));

// 2-4. the GLSL
const shaderCommon = fs.readFileSync(path.join(banjo, 'app', 'thirdparty', 'reblue-XenosRecomp', 'XenosRecomp', 'shader_common.h'));
const errors = [];
const glslWorkers = await startWorkers('glsl_worker_node.mjs', threads);
log(`${threads} GLSL workers ready`);
const { shaders, failed } = await makeGlsl(containers, tr, glslMaker(workerPool(glslWorkers)), shaderCommon, log,
                                           progress('glsl'),
                                           (e) => { errors.push(e); if (errors.length <= 5) log(`error: ${e}`); });
for (const w of glslWorkers) await w.w.terminate();
const pkg = packageShaders(shaders);
fs.writeFileSync(path.join(outDir, 'deko3d_glsl.bin'), pkg);
log(`deko3d_glsl.bin: ${shaders.length} shaders, ${(pkg.length / 1048576).toFixed(1)} MB`);

// The numbers against the native table (shader_cache.cpp of the PC build: hash, dxil x2, spirv x2, spec, vfm, tfm,
// mem[8], float[8], vi offset, vi count, literal offset, literal count, flags).
const table = fs.readFileSync(path.join(banjo, 'app', 'out', 'pc-me', 'renut_gpu', 'shader_cache.cpp'), 'utf8');
const block = (name) => table.match(new RegExp(name + '\\[\\]\\s*=\\s*\\{\\n([\\s\\S]*?)\\n\\};'))[1].split('\n')
  .map((l) => (l.match(/0x[0-9A-Fa-f]+|\d+/g) || []).map((v) => Number(v)));
const nativeEntries = new Map();
for (const line of table.match(/ShaderCacheEntry g_shaderCacheEntries\[\]\s*=\s*\{\n([\s\S]*?)\n\};/)[1].split('\n')) {
  const hash = BigInt(line.match(/0x[0-9A-Fa-f]+/)[0]);
  nativeEntries.set(hash, (line.match(/0x[0-9A-Fa-f]+|\d+/g) || []).slice(1).map((v) => Number(v)));
}
const nativeInputs = block('ShaderVertexInput g_shaderVertexInputs');
const nativeLiterals = block('ShaderLiteral g_shaderLiterals');
let numbersSame = 0, numbersDiffer = 0, notNative = 0;
for (const s of shaders) {
  const e = nativeEntries.get(s.numbers.hash);
  if (!e) { notNative++; continue; }
  const n = s.numbers;
  const mine = [n.specConstantsMask, n.vertexFetchMemoryMask, n.textureFetchMask, ...n.memExportConstants, ...n.floatConstants,
                n.vertexInputs.length, n.literals.length, n.shaderFlags];
  const theirs = [...e.slice(4, 23), e[24], e[26], e[27]];
  const inputs = nativeInputs.slice(e[23], e[23] + e[24]);
  const literals = nativeLiterals.slice(e[25], e[25] + e[26]);
  const same = JSON.stringify(mine) === JSON.stringify(theirs) &&
               JSON.stringify(n.vertexInputs) === JSON.stringify(inputs) && JSON.stringify(n.literals) === JSON.stringify(literals);
  if (same) numbersSame++;
  else { numbersDiffer++; if (numbersDiffer <= 3) log(`numbers differ: ${s.name}`); }
}
log(`shader table: ${numbersSame} the native numbers, ${numbersDiffer} different, ${notNative} not in the native table ` +
    `(${nativeEntries.size} there)`);
const glslDir = opt('native-glsl', path.join(banjo, 'out', 'deko3d_shaders', 'glsl_opt_any'));  // 2026-11-01: settable
let glslSame = 0;
const dec = new TextDecoder();
for (const s of shaders) {
  const p = path.join(glslDir, s.name + '.glsl');
  if (fs.existsSync(p) && dec.decode(s.glsl) === fs.readFileSync(p, 'utf8')) glslSame++;
}
log(`GLSL: ${glslSame} of ${shaders.length} the native glsl_opt_any's`);

// 5. the variants
const runtime = nroShaders(new Uint8Array(fs.readFileSync(nroPath)));
const glslOf = new Map(shaders.map((s) => [s.name, s.glsl]));
let runtimeAdded = 0;
for (const [stem, glsl] of runtime) if (!glslOf.has(stem)) { glslOf.set(stem, glsl); runtimeAdded++; }
log(`the NRO's own shaders: ${runtime.size} (${runtimeAdded} not made from the game's files)`);
const variants = parseVariants(fs.readFileSync(path.join(root, 'release', 'variants.txt'), 'utf8'));
const { jobs, skipped } = variantJobs(variants, glslOf);
log(`${jobs.length} compiles (${variants.length} variants listed, ${skipped} of shaders there are not, + each shader as it is)`);
const workers = await startWorkers('uam_worker_node.mjs', threads);
const t1 = performance.now();
const { cache, compiled, failures } = await compileVariants(jobs, uamCompile(workerPool(workers)), threads * 2,
                                                            progress('uam'));
for (const w of workers) await w.w.terminate();
fs.writeFileSync(path.join(outDir, 'deko3d_shaders.bin'), cache);
log(`deko3d_shaders.bin: ${compiled} compiled in ${((performance.now() - t1) / 1000).toFixed(0)} s on ${threads} threads, ` +
    `${failures.length} failed, ${(cache.length / 1048576).toFixed(1)} MB`);
for (const f of failures.slice(0, 3)) log(`uam failed ${f.key.toString(16)}: ${f.error.slice(0, 300)}`);
if (fs.existsSync(cachePath)) {
  const native = readCache(new Uint8Array(fs.readFileSync(cachePath)));
  const mine = readCache(cache);
  let inBoth = 0, sameBytes = 0;
  for (const [k, v] of mine) {
    const n = native.get(k);
    if (!n) continue;
    inBoth++;
    if (n.length === v.length && n.every((b, i) => b === v[i])) sameBytes++;
  }
  log(`against ${path.basename(cachePath)} (${native.size} variants): ${inBoth} keys in both, ${sameBytes} byte for byte`);
}
log(`done: ${errors.length} errors, ${failed} shaders failed`);
fs.writeFileSync(path.join(outDir, 'errors.txt'), errors.join('\n') + '\n');
process.exit(0);
