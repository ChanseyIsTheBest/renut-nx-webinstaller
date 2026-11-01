// renut-nx-webinstaller (2026-11-01): the title update's and the DLC's files from the player's Xbox 360 packages, read
// in place (lib/stfs.js). After keflings-nx-installer's lib/kef_files.js (GPL-3.0).
//
// renut-nx is built from title update 3 (title 4D5307ED, v0.0.3.1): its default.xexp goes beside default.xex in
// game_root/ (the program applies it when it loads the game) and its other files (db_index.txt and 12 bundle files) in
// update/. The DLC package (L.O.G.'s Lost Challenges) is copied whole to dlc/: renut-nx installs it at its first start.
import { StfsPackage } from './stfs.js';

export const GAME_TITLE = 0x4d5307ed;
export const CONTENT_UPDATE = 0x000b0000;
export const CONTENT_DLC = 0x00000002;

// A File (or Blob) as { size, read(offset, length) }.
export const blobReader = (blob) => ({
  size: blob.size,
  read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
});

// The packages' kinds, for the page: { update: name or null, dlc: [names] }, or throws with a message for the player.
export async function describePackages(files) {
  let update = null;
  const dlc = [];
  for (const file of files) {
    const pkg = await StfsPackage.open(blobReader(file)).catch(() => null);
    if (!pkg) throw new Error(`${file.name} is not an Xbox 360 content package.`);
    if (pkg.header.titleId !== GAME_TITLE) throw new Error(`${file.name} is not a Banjo-Kazooie: Nuts & Bolts package.`);
    if (pkg.header.contentType === CONTENT_UPDATE) {
      if (update) throw new Error('Choose one title update, not several.');
      update = file.name;
    } else if (pkg.header.contentType === CONTENT_DLC) {
      dlc.push(file.name);
    } else {
      throw new Error(`${file.name} is neither the title update nor the DLC (content type ${pkg.header.contentType.toString(16)}).`);
    }
  }
  return { update, dlc };
}

// What the packages put into the zip, [{ path (under switch/renut-nx/), size, read(offset, length) }].
export async function packageFiles(files) {
  let update = null;
  const dlc = [];
  for (const file of files) {
    const reader = blobReader(file);
    const pkg = await StfsPackage.open(reader);
    if (pkg.header.titleId !== GAME_TITLE) throw new Error(`${file.name} is not a Banjo-Kazooie: Nuts & Bolts package`);
    if (pkg.header.contentType === CONTENT_UPDATE) update = pkg;
    else if (pkg.header.contentType === CONTENT_DLC) dlc.push({ path: `dlc/${file.name}`, size: file.size, read: reader.read });
    else throw new Error(`${file.name}: content type ${pkg.header.contentType.toString(16)}, not the title update or the DLC`);
  }
  if (!update) throw new Error('the title update is missing: choose title update 3\'s package');
  const out = update.files().map((f) => ({
    path: f.path === 'default.xexp' ? 'game_root/default.xexp' : `update/${f.path}`,
    size: f.size,
    read: f.read,
  }));
  if (!out.some((f) => f.path === 'game_root/default.xexp')) throw new Error('the title update has no default.xexp');
  return [...out, ...dlc];
}
