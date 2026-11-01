// banjo-nx-installer: lib/xiso.js on a disc image against the extracted game folder (paths, sizes, and the bytes of
// default.xex and a sample of the rest).
//   node test/xiso_node.mjs <image.iso> <extracted folder>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listXiso } from '../lib/xiso.js';

const [iso, folder] = process.argv.slice(2);
const fd = fs.openSync(iso, 'r');
const size = fs.fstatSync(fd).size;
const read = async (offset, length) => {
  const b = Buffer.alloc(length);
  fs.readSync(fd, b, 0, length, offset);
  return new Uint8Array(b.buffer, b.byteOffset, length);
};
const t0 = performance.now();
const files = await listXiso(read, size);
console.log(`${files.length} files in the image (${(performance.now() - t0).toFixed(0)} ms)`);
const walk = (d, p = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name), p + e.name + '/') : [{ path: p + e.name, size: fs.statSync(path.join(d, e.name)).size }]);
const extracted = new Map(walk(folder).map((f) => [f.path, f.size]));
let same = 0, sizeDiffers = 0, missing = 0;
for (const f of files) {
  if (!extracted.has(f.path)) { missing++; if (missing <= 3) console.log(`not extracted: ${f.path}`); continue; }
  if (extracted.get(f.path) === f.size) same++; else sizeDiffers++;
}
console.log(`${same} with the extracted size, ${sizeDiffers} different, ${missing} not in the folder, ` +
            `${extracted.size - same - sizeDiffers} only in the folder`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let bytesSame = 0, checked = 0;
for (const f of files.filter((f, i) => f.path === 'default.xex' || i % 97 === 0)) {
  if (!extracted.has(f.path) || f.size > 300 << 20) continue;
  checked++;
  if (sha(await read(f.offset, f.size)) === sha(fs.readFileSync(path.join(folder, f.path)))) bytesSame++;
}
console.log(`${bytesSame} of ${checked} sampled files byte for byte the extracted ones`);
