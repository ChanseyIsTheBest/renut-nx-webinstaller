// renut-nx-webinstaller (was banjo-nx-installer): makes the package off the page's thread (lib/build.js) and streams the zip to the download
// service worker (sw.js). From bejeweled3-nx-installer's worker.js (nfsmw-nx-installer's download stream, GPL-3.0).
import createRenutHlslModule from './wasm/renut_hlsl.mjs';
import { loadPyodide } from './vendor/pyodide/pyodide.mjs';
import { loadPython } from './lib/py.js';
import { compileVariants, dumpContainers, makeGlsl, packageShaders, variantJobs } from './lib/build.js';
import { nroShaders } from './lib/nro.js';
import { glslMaker, uamCompile, workerPool } from './lib/pool.js';
import { parseVariants } from './lib/variants.js';
import { packageFiles } from './lib/renut_files.js';
import { ZipWriter, zipSize } from './lib/zip.js';

const ROOT = 'switch/renut-nx';  // renut-nx (2026-11-01; banjo-nx before)
const log = (text) => postMessage({ type: 'log', text });
// The steps' shares of the bar: the shaders take the time, the zip the bytes.
const STEPS = { dump: [0, 0.12], glsl: [0.12, 0.55], uam: [0.55, 0.8], zip: [0.8, 1] };
// renut-nx (2026-11-04): the console compiles the shaders, so no uam step
const STEPS_NO_COMPILE = { dump: [0, 0.16], glsl: [0.16, 0.73], zip: [0.73, 1] };
let steps = STEPS;
const progress = (step) => (f) => {
  const [a, b] = steps[step];
  postMessage({ type: 'progress', fraction: a + (b - a) * f });
};

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// A release file, checked against the SHA-256 the manifest gives for it.
async function fetchChecked(name, hash) {
  const bytes = await fetchBytes(`./release/${name}`);
  const got = await sha256(bytes);
  if (hash && got !== hash) throw new Error(`release/${name} is not the one the manifest names (${got})`);
  return bytes;
}

// Sends every write as one chunk, and only when the download has asked for more ("pull").
function portSink(port) {
  let credits = 0, cancelled = false, waiting = null;
  port.onmessage = ({ data }) => {
    if (data.type === 'pull') credits++;
    else if (data.type === 'cancel') cancelled = true;
    if (waiting) { const wake = waiting; waiting = null; wake(); }
  };
  return {
    async write(bytes) {
      while (!credits) {
        if (cancelled) throw new Error('the download was cancelled');
        await new Promise((resolve) => (waiting = resolve));
      }
      if (cancelled) throw new Error('the download was cancelled');
      credits--;
      const copy = bytes.slice();
      port.postMessage({ type: 'chunk', buffer: copy.buffer }, [copy.buffer]);
    },
    async close() { port.postMessage({ type: 'end' }); },
    fail(message) { port.postMessage({ type: 'error', message }); },
  };
}

// The game's files: { path (in the game folder), size, read(offset, length) } from the page's Files, or for
// test/browser.html from the test server (HTTP range requests).
// A file inside a disc image has the image as its file and its offset there (lib/xiso.js).
function gameFiles(entries) {
  return entries.map((e) => ({
    path: e.path,
    size: e.size,
    // the whole file for the shader dump: a Blob of the player's file, which Python reads without a copy in memory
    // first (lib/py.js); the test server's, its bytes (fetched Blobs fill the browser's blob storage: test/browser.html
    // stopped after 2 GB of them)
    blob: e.file ? async () => (e.offset === undefined ? e.file : e.file.slice(e.offset, e.offset + e.size)) : async () => {
      const r = await fetch(e.url);
      if (!r.ok) throw new Error(`${e.url}: HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    read: e.file
      ? async (offset, length) => {
          const at = (e.offset || 0) + offset;
          return new Uint8Array(await e.file.slice(at, at + length).arrayBuffer());
        }
      : async (offset, length) => {
          const r = await fetch(e.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
          if (!r.ok) throw new Error(`${e.url}: HTTP ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        },
  }));
}

async function* chunks(file, size = 8 << 20) {
  for (let at = 0; at < file.size; at += size) yield await file.read(at, Math.min(size, file.size - at));
}

const quiet = () => ({ print: () => {}, printErr: () => {} });

// count Web Workers of a script, each started and ready, as lib/pool.js takes them
function startWorkers(script, count) {
  return Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const w = new Worker(script, { type: 'module' });
    w.onerror = (e) => reject(new Error(`${script}: ${e.message}`));
    w.addEventListener('message', ({ data }) => {
      if (data.ready) resolve({ w, post: (m, t) => w.postMessage(m, t), onMessage: (cb) => w.addEventListener('message', ({ data: d }) => cb(d)) });
    }, { once: true });
  })));
}

self.onmessage = async ({ data }) => {
  const sink = portSink(data.port);
  const started = performance.now();
  const seconds = () => Math.round((performance.now() - started) / 1000);
  let workers = [];
  const stopWorkers = () => { for (const x of workers) x.w.terminate(); workers = []; };
  // renut-nx (2026-11-04, the user's request; katamari-nx-installer's way): compile false leaves out deko3d_shaders.bin,
  // and pipeline_list.bin with it: with that list and no cache, the prebuild workers would compile every shader in it.
  // The NRO compiles each shader when a draw first needs it (plume loadVariant) and keeps it in a new cache file.
  const compile = data.compile !== false;
  if (!compile) steps = STEPS_NO_COMPILE;
  try {
    const manifest = JSON.parse(new TextDecoder().decode(await fetchBytes('./release/manifest.json')));
    const files = gameFiles(data.entries);
    const xex = files.find((f) => f.path === 'default.xex');
    if (!xex) throw new Error('no default.xex in the folder: choose the folder the game was extracted to');
    const xexHash = await sha256(await xex.read(0, xex.size));
    const build = manifest.builds.find((b) => b.xex_sha256 === xexHash);
    if (!build) throw new Error(`this default.xex is not one this release supports (SHA-256 ${xexHash})`);
    // renut-nx (2026-11-01): title update 3's files (and the DLC's package) from the packages, read in place
    const updateFiles = await packageFiles(data.packages || []);
    const xexp = updateFiles.find((f) => f.path === 'game_root/default.xexp');
    const xexpHash = await sha256(await xexp.read(0, xexp.size));
    if (build.xexp_sha256 && xexpHash !== build.xexp_sha256) {
      throw new Error(`this title update is not the one the program was made for (default.xexp SHA-256 ${xexpHash})`);
    }

    log('Downloading the program and the tools...');
    const [nro, variantsText, shaderCommon] = await Promise.all([
      fetchChecked(build.nro, build.nro_sha256),
      compile ? fetchBytes('./release/variants.txt').then((b) => new TextDecoder().decode(b)) : null,
      fetchBytes('./release/shader_common.h'),
    ]);
    const extras = await Promise.all(build.files.filter((f) => compile || f.path !== 'pipeline_list.bin')
      .map(async (f) => ({ ...f, bytes: await fetchChecked(f.source, f.sha256) })));
    const tr = await createRenutHlslModule(quiet());
    // the shader dump's Pyodide (the GLSL workers have their own)
    const py = await loadPython(loadPyodide, new URL('./vendor/pyodide/', location.href).href,
                                async (n) => new TextDecoder().decode(await fetchBytes(`./py/${n}`)));
    log(`Tools ready (${seconds()} s). Looking for the shaders in the game's files...`);

    // 1-4: the shaders' GLSL and the shader table, from the game's files
    const shaderFiles = files.filter((f) => f.path === 'default.xex' || f.path.startsWith('Bundle/'))
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => ({ path: f.path, read: f.blob }));
    const containers = await dumpContainers(shaderFiles, py, log, progress('dump'));
    // A GLSL worker (Pyodide, numpy, DXC) holds about 0.5 GB: at most 8 of them, fewer on a device with less memory
    // (navigator.deviceMemory, in GB, Chromium only). A uam worker is small: one per core.
    const cores = Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4) - 1));
    const glslThreads = Math.max(1, Math.min(cores, 8, navigator.deviceMemory || 8));
    log(`Making the shaders' GLSL on ${glslThreads} threads...`);
    workers = await startWorkers('./glsl_worker.js', glslThreads);
    const errors = [];
    const { shaders, failed } = await makeGlsl(containers, tr, glslMaker(workerPool(workers)), shaderCommon, log,
                                               progress('glsl'), (e) => errors.push(e));
    stopWorkers();
    if (failed) throw new Error(`${failed} shaders could not be made: ${errors.slice(0, 3).join('; ')}`);
    const glslPackage = packageShaders(shaders);

    const glslHash = await sha256(glslPackage);
    let cache = null;
    if (compile) {
      // 5: every variant the game uses, compiled for the console (and the NRO's own shaders' variants)
      const glslOf = new Map(shaders.map((s) => [s.name, s.glsl]));
      for (const [stem, glsl] of nroShaders(nro)) if (!glslOf.has(stem)) glslOf.set(stem, glsl);
      const { jobs } = variantJobs(parseVariants(variantsText), glslOf);
      log(`Compiling ${jobs.length} shader variants for the Switch on ${cores} threads...`);
      workers = await startWorkers('./uam_worker.js', cores);
      const compiled = await compileVariants(jobs, uamCompile(workerPool(workers)), cores * 2, progress('uam'));
      stopWorkers();
      const { failures } = compiled;
      if (failures.length) throw new Error(`${failures.length} shader variants did not compile: ${failures[0].error.slice(0, 200)}`);
      cache = compiled.cache;
      const cacheHash = await sha256(cache);
      const checked = build.deko3d_glsl_sha256 === glslHash && build.deko3d_shaders_sha256 === cacheHash;
      log(`Shaders done in ${seconds()} s: ${shaders.length} shaders, ${jobs.length} variants` +
          (build.deko3d_glsl_sha256 ? (checked ? ', identical to the release\'s reference build' : ' (NOT the reference build\'s: ' +
            `${glslHash.slice(0, 12)} / ${cacheHash.slice(0, 12)})`) : ''));
    } else {
      log(`Shaders done in ${seconds()} s: ${shaders.length} shaders, left for the Switch to compile` +
          (build.deko3d_glsl_sha256 ? (build.deko3d_glsl_sha256 === glslHash ? ', identical to the release\'s reference build'
            : ` (NOT the reference build's: ${glslHash.slice(0, 12)})`) : ''));
    }

    // the zip: the program, its settings, the shaders, and the game's files
    // the update's default.xexp replaces one a folder may already have
    const game = files.filter((f) => !f.path.startsWith('$SystemUpdate/') && f.path !== 'default.xexp');
    const entries = [
      { path: `${ROOT}/renut-nx.nro`, size: nro.length },
      ...extras.map((f) => ({ path: `${ROOT}/${f.path}`, size: f.bytes.length })),
      { path: `${ROOT}/deko3d_glsl.bin`, size: glslPackage.length },
      ...(cache ? [{ path: `${ROOT}/deko3d_shaders.bin`, size: cache.length }] : []),
      ...game.map((f) => ({ path: `${ROOT}/game_root/${f.path}`, size: f.size })),
      ...updateFiles.map((f) => ({ path: `${ROOT}/${f.path}`, size: f.size })),
    ];
    const total = zipSize(entries);
    postMessage({ type: 'size', size: total });
    const zip = new ZipWriter(sink);
    let written = 0;
    const counted = (n) => { written += n; progress('zip')(written / total); };
    await zip.addBytes(entries[0].path, nro); counted(nro.length);
    for (const f of extras) { await zip.addBytes(`${ROOT}/${f.path}`, f.bytes); counted(f.bytes.length); }
    await zip.addBytes(`${ROOT}/deko3d_glsl.bin`, glslPackage); counted(glslPackage.length);
    if (cache) { await zip.addBytes(`${ROOT}/deko3d_shaders.bin`, cache); counted(cache.length); }
    for (const f of game) {
      await zip.addFile(`${ROOT}/game_root/${f.path}`, f.size, chunks(f), (c) => counted(c.length));
    }
    for (const f of updateFiles) {
      await zip.addFile(`${ROOT}/${f.path}`, f.size, chunks(f), (c) => counted(c.length));
    }
    await zip.finish();
    postMessage({ type: 'done', seconds: seconds() });
  } catch (error) {
    stopWorkers();
    const message = error.message || String(error);
    sink.fail(message);
    postMessage({ type: 'error', message });
  }
};
