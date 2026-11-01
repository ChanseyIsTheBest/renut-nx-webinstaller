// banjo-nx-installer: the shader dump (py/dump_shaders.py in Pyodide, LZX in lib/lzx.js) on a game folder against the
// native dump (banjo-nx's out/renut_shader_dump, its manifest.csv: the containers found in the files).
//   node test/dump_node.mjs <game folder (default.xex, Bundle/)> <banjo-nx out/renut_shader_dump> [--limit=N]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePartition } from '../lib/lzx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const [game, nativeDir] = process.argv.slice(2);
const limit = Number((process.argv.find((a) => a.startsWith('--limit=')) || '--limit=0').split('=')[1]);
globalThis.banjoLzxPartition = (data, windowBits, frames) => decodePartition(data, windowBits, frames);
const { loadPyodide } = await import(pathToFileURL(path.join(root, 'vendor', 'pyodide', 'pyodide.mjs')).href);
const py = await loadPyodide({ indexURL: path.join(root, 'vendor', 'pyodide') + path.sep });
py.FS.mkdirTree('/py');
for (const n of ['dump_shaders.py', 'banjo_dump.py']) py.FS.writeFile('/py/' + n, fs.readFileSync(path.join(root, 'py', n), 'utf8'));
py.runPython("import sys\nsys.path.insert(0, '/py')\nimport banjo_dump");
const dumpFile = py.globals.get('banjo_dump').dump_file;

const files = [path.join(game, 'default.xex')];
for (const sub of fs.readdirSync(path.join(game, 'Bundle'))) {
  for (const f of fs.readdirSync(path.join(game, 'Bundle', sub)).sort()) files.push(path.join(game, 'Bundle', sub, f));
}
const pick = limit ? files.slice(0, limit) : files;
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
const mine = new Map();
let problems = 0;
const t0 = performance.now();
for (const [i, f] of pick.entries()) {
  py.FS.writeFile('/game.bin', fs.readFileSync(f));
  const r = dumpFile('/game.bin');
  const [results, probs] = r.toJs();
  r.destroy();
  problems += probs.length;
  for (const [kind, blob] of results) mine.set(sha(blob), kind);
  if ((i + 1) % 25 === 0) console.log(`${i + 1}/${pick.length} files, ${mine.size} shaders, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
py.FS.unlink('/game.bin');
const manifest = fs.readFileSync(path.join(nativeDir, 'manifest.csv'), 'utf8').split('\n').slice(1).filter(Boolean);
const dumped = new Set(manifest.map((l) => l.split(',')[0]));
const native = new Set();
for (const name of dumped) {
  const p = path.join(nativeDir, name + '.bin');
  if (fs.existsSync(p)) native.add(sha(fs.readFileSync(p)));
}
let both = 0;
for (const h of mine.keys()) if (native.has(h)) both++;
console.log(`${pick.length} files in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${mine.size} shaders here, ` +
            `${native.size} in the native dump's manifest, ${both} in both, ${problems} problems`);
