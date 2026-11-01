// renut-nx-webinstaller (2026-11-01): the title update's and the DLC's packages read in place (lib/renut_files.js),
// each file against a folder they were extracted to (sha-256):
//   node test/packages_node.mjs <title update package> <extracted update folder> [DLC package ...]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describePackages, packageFiles } from '../lib/renut_files.js';

const [updatePath, extracted, ...dlcPaths] = process.argv.slice(2);
const asFile = async (p) => {
  const blob = await fs.openAsBlob(p);
  return Object.assign(blob, { name: path.basename(p) });
};
const files = await Promise.all([updatePath, ...dlcPaths].map(asFile));
console.log('kinds:', JSON.stringify(await describePackages(files)));
const out = await packageFiles(files);
let bad = 0;
for (const f of out) {
  const bytes = await f.read(0, f.size);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  let ref = null;
  if (f.path.startsWith('dlc/')) {
    ref = fs.readFileSync(dlcPaths.find((p) => path.basename(p) === f.path.slice(4)));
  } else {
    const name = f.path.replace(/^game_root\//, '').replace(/^update\//, '');
    ref = fs.readFileSync(path.join(extracted, name));
  }
  const refHash = crypto.createHash('sha256').update(ref).digest('hex');
  const ok = hash === refHash;
  if (!ok) bad++;
  console.log(`${ok ? 'same' : 'DIFFERS'} ${f.path} ${f.size}`);
}
console.log(`${out.length} files, ${bad} differ`);
process.exit(bad ? 1 : 0);
