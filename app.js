// renut-nx-webinstaller (was banjo-nx-installer): the page. The player chooses their disc image (lib/xiso.js) or the
// folder the game was extracted to, and title update 3's package (with the DLC's, if they have it: lib/renut_files.js);
// worker.js makes the Switch package from them (the shaders included: the NRO carries none of the game's) and sw.js
// serves it as a download.
// From bejeweled3-nx-installer's app.js (ChanseyIsTheBest; nfsmw-nx-installer's download flow, StevensND; GPL-3.0),
// without its languages for this prototype.
import { listXiso } from './lib/xiso.js';
import { describePackages } from './lib/renut_files.js';

const folderInput = document.getElementById('folder');
const isoInput = document.getElementById('iso');
const chosen = document.getElementById('chosen');
const detected = document.getElementById('detected');
const packagesInput = document.getElementById('packages');
const packagesChosen = document.getElementById('packages-chosen');
const packagesDetected = document.getElementById('packages-detected');
const create = document.getElementById('create');
const bar = document.getElementById('bar');
const logBox = document.getElementById('log');
const manifest = fetch('./release/manifest.json').then((r) => r.json());
let entries = null;
let packages = null;  // renut-nx (2026-11-01): the title update's package (and the DLC's), checked
let busy = false;
let downloadFrame = null;

function log(text, error = false) {
  const line = document.createElement('div');
  line.textContent = text;
  if (error) line.className = 'error';
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function formatSize(bytes) {
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(2)} GB` : `${(bytes / (1 << 20)).toFixed(0)} MB`;
}

async function sha256(blob) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function show(state, text, box = detected) {
  box.hidden = false;
  box.className = `detected ${state}`;
  box.textContent = text;
}

function updateCreate() {
  create.disabled = busy || !entries || !packages;
}

// list: [{ path (in the game), size, file, offset (in a disc image) }]
async function choose(list, what) {
  entries = null;
  updateCreate();
  const total = list.reduce((n, e) => n + e.size, 0);
  chosen.textContent = `${what}: ${list.length} files, ${formatSize(total)}`;
  const xex = list.find((e) => e.path === 'default.xex');
  if (!xex) {
    show('bad', 'No default.xex: choose the folder the game disc was extracted to, or the disc image.');
    return;
  }
  show('', 'Checking default.xex...');
  const blob = xex.offset === undefined ? xex.file : xex.file.slice(xex.offset, xex.offset + xex.size);
  const hash = await sha256(blob);
  const build = (await manifest).builds.find((b) => b.xex_sha256 === hash);
  if (!build) {
    show('bad', `This default.xex is not one this release supports. Its SHA-256: ${hash}`);
    return;
  }
  if (!list.some((e) => e.path.startsWith('Bundle/'))) {
    show('bad', 'The Bundle folder is missing: choose the whole extracted game.');
    return;
  }
  show('good', `Banjo-Kazooie: Nuts & Bolts (${build.edition}), supported.`);
  entries = list;
  updateCreate();
}

// renut-nx (2026-11-01): title update 3's package (required: renut-nx is the updated game) and the DLC's (optional),
// read in place: nothing is extracted until the zip is written.
packagesInput.addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  packages = null;
  updateCreate();
  packagesChosen.textContent = files.map((f) => `${f.name} (${formatSize(f.size)})`).join(', ');
  try {
    const kinds = await describePackages(files);
    if (!kinds.update) {
      show('bad', 'Title update 3 is missing: choose its package (TU_16L61VD_...) together with the DLC.', packagesDetected);
      return;
    }
    show('good', 'Title update 3' + (kinds.dlc.length ? `, with the DLC (${kinds.dlc.length} package)` : ', without the DLC') +
         '.', packagesDetected);
    packages = files;
    updateCreate();
  } catch (error) {
    show('bad', error.message, packagesDetected);
  }
});

folderInput.addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  // the paths inside the chosen folder (its own name dropped)
  await choose(files.map((file) => ({ path: file.webkitRelativePath.split('/').slice(1).join('/'), size: file.size, file })),
               files[0].webkitRelativePath.split('/')[0]);
});

isoInput.addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  const read = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  try {
    const files = await listXiso(read, file.size);
    if (!files) {
      entries = null;
      updateCreate();
      show('bad', `${file.name} is not an Xbox 360 disc image.`);
      return;
    }
    await choose(files.map((f) => ({ path: f.path, size: f.size, file, offset: f.offset })), file.name);
  } catch (error) {
    show('bad', error.message);
  }
});

// The zip is served by sw.js as a normal browser download, streamed while it is being made.
async function downloadHelper() {
  if (!('serviceWorker' in navigator)) throw new Error('this browser cannot stream a download (no service workers)');
  await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  const registration = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    const claimed = new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    registration.active.postMessage({ type: 'claim' });
    await claimed;
  }
  return navigator.serviceWorker.controller;
}
const helper = downloadHelper();
helper.catch(() => {});

create.addEventListener('click', async () => {
  if (!entries || !packages || busy) return;
  let controller;
  try {
    controller = await helper;
  } catch (error) {
    log(`Error: ${error.message}`, true);
    return;
  }
  busy = true;
  create.disabled = true;
  bar.hidden = false;
  bar.value = 0;
  logBox.textContent = '';
  const channel = new MessageChannel();
  const keepAlive = setInterval(() => controller.postMessage({ type: 'ping' }), 10000);
  const worker = new Worker('./worker.js', { type: 'module' });
  const finish = () => {
    clearInterval(keepAlive);
    worker.terminate();
    busy = false;
    updateCreate();
  };
  worker.onmessage = async ({ data }) => {
    if (data.type === 'log') {
      log(data.text);
    } else if (data.type === 'progress') {
      bar.value = data.fraction;
    } else if (data.type === 'size') {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const ack = new MessageChannel();
      const registered = new Promise((resolve) => (ack.port1.onmessage = resolve));
      controller.postMessage({ type: 'download', id, filename: 'renut-nx.zip', size: data.size }, [channel.port2, ack.port2]);
      await registered;
      // a hidden frame opens the download: its request is a navigation, which always reaches the service worker
      downloadFrame?.remove();
      downloadFrame = document.createElement('iframe');
      downloadFrame.hidden = true;
      downloadFrame.src = `./download/${id}/renut-nx.zip`;
      document.body.appendChild(downloadFrame);
      log(`Download started: renut-nx.zip, ${formatSize(data.size)}. Keep this page open until it finishes.`);
    } else if (data.type === 'done') {
      bar.value = 1;
      log(`Finished in ${data.seconds} s.`);
      finish();
    } else if (data.type === 'error') {
      log(`Error: ${data.message}`, true);
      finish();
    }
  };
  worker.onerror = (event) => {
    log(`Error: ${event.message}`, true);
    finish();
  };
  worker.postMessage({ entries, packages, port: channel.port1 }, [channel.port1]);
});
