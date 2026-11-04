# renut-nx-webinstaller

Version 1.0.1, for **renut-nx 1.0.1**: Banjo-Kazooie: Nuts & Bolts on the Nintendo Switch (homebrew), by
ChanseyIsTheBest. renut-nx is a Switch port of [reNut](https://github.com/masterspike52/reNut).

This page makes the Switch package from **your own copy** of the game. It runs entirely in your browser: nothing is
uploaded, and no game data comes with renut-nx.

## What you need

- Your **Xbox 360 disc** of Banjo-Kazooie: Nuts & Bolts as an `.iso` image (or the folder it was extracted to, with
  `default.xex` and `Bundle` in it).
- **Title update 3**: its Xbox 360 package, the file `TU_16L61VD_0000004000000.00000000000O1` (in the update's
  `3E567DFF` folder). renut-nx is the updated game, so this is required.
- Optional: the **DLC**, L.O.G.'s Lost Challenges: its package `E41F20AAF7094B9AFCA8CC90489D689D72A5062B4D`.
- A desktop **Chromium browser** (Chrome, Edge, Brave...), about 8 GB of free memory and 7 GB of free disk space for
  the download.
- A Switch that runs homebrew (Atmosphère) with **Sphaira**, and an SD card with at least 8 GB free.

## How to use it

1. Open the page: **https://chanseyisthebest.github.io/renut-nx-webinstaller/**
2. **Choose your game**: the disc image (`.iso`) or the extracted folder. The page checks that it is the supported
   version.
3. **Choose title update 3** (and the DLC package, at the same time, if you have it).
4. Press **Create renut-nx.zip**. The page makes the game's shaders and compiles them for the Switch: this takes a
   while (20 to 40 minutes, depending on your computer). The zip downloads while it is made; keep the page open until it
   finishes. See [Letting the Switch compile the shaders](#letting-the-switch-compile-the-shaders) for the option that
   is not recommended.
5. Extract `renut-nx.zip` to the **root of the SD card**. It makes `switch/renut-nx/`.
6. On the Switch, open **Sphaira**, find Banjo-Kazooie Nuts & Bolts, press **X** to open Options and choose
   **Install Forwarder**. Make sure **Address Space** is set to **39-bit**, choose **Create Forwarder**, then start the
   game from the **Home Screen**. This is so the game can use all four CPU cores: it cannot do this through a title
   takeover. The first start sets this up; from the second start on it runs on four cores.
   The very first start also takes a few seconds longer: renut-nx compresses its shader package once.

To run the page on your own computer: `python serve.py 8193 .` in this folder, then open http://127.0.0.1:8193/.

### Letting the Switch compile the shaders

The page's third step also offers **The Switch, as you play**, which is **not recommended**. The page still makes the
game's shaders from your files, about half of the wait, but compiles none of them. renut-nx then compiles each shader the
first time the game needs it and keeps the result on the SD card, so each one is compiled only once.

- **The game stops while it compiles.** On an emulator, a fresh install made draws wait for over 200 compiles in its
  first 7.5 minutes and had not reached the title screen when the test was stopped. This was not measured on a console.
- **It runs slower for a long time.** The faster versions of the shaders (about 28,000) compile slowly in the
  background, and the game draws with slower general versions until they are done. The picture is the same.

To change to the recommended way later, make the package again with the first choice and extract it over the old folder.
That also replaces your `renut.toml`, so keep a copy if you changed your settings.

## Settings

`switch/renut-nx/renut.toml` holds the settings you may want to change, with a comment on each: the language (by
default the Switch's system language), MSAA and SMAA, the dynamic resolution (handheld 540p-720p, docked 540p-1080p), fur detail, 1.0.0's original font and dialogue boxes, the
frame cap, four-core mode and the controls.

## If something goes wrong

- Crash logs are written to `switch/renut-nx/logs/rex/rex_crash.log`.
- For a bug report, open `renut.toml`, remove the `#` in front of `log_level = "info"`, play until the problem
  happens, and send the `switch/renut-nx/logs/` folder.
- The page says the game or the update is not supported: renut-nx 1.0.1 supports the Xbox 360 disc release with title
  update 3 only.

## How it works

The rest of this file is for developers.

A web page that builds the Nintendo Switch package of **Banjo-Kazooie: Nuts & Bolts** (banjo-nx) from the player's own
copy of the game, in the browser, as the sa2-nx and bejeweled3-nx installers do. Nothing is uploaded.

The distribution NRO carries no game data: none of the game's assets and none of its shaders except the ~150 the game
makes at runtime (no game file holds those). The page makes everything else from the player's files:

1. **The shaders' containers**: reNut's `tools/dump_shaders.py` (unchanged, in [Pyodide](https://pyodide.org)) on
   `default.xex` and the `Bundle` files, with Rare's LZX decoded by `lib/lzx.js` (a line-for-line port of the tool's
   decoder): 4,731 containers, the same as the native dump.
2. **Renut's translator** (`wasm/renut_hlsl`, banjo-nx's XenosRecomp in WebAssembly): each container's HLSL and the
   numbers of the NRO's shader table (masks, vertex inputs, literals).
3. **GLSL for the console**, on a pool of workers (`glsl_worker.js`, about 0.9 s a shader each): banjo-nx's
   `renut_early_alpha.py` (pixel shaders), DXC, SPIRV-Cross, `deko3d_glsl.py` and `deko3d_glsl_opt.py` (its default
   passes), the Python tools unchanged in Pyodide.
4. **deko3d_glsl.bin** (`lib/package.js`, version 2 of banjo-nx's GLSL package): the GLSL and the shader table, which the
   NRO reads next to itself (`banjo_renut_deko3d.cpp`, OpenInstalled / InstalledShaderTable).
5. **deko3d_shaders.bin**: every shader variant of `release/variants.txt` (21,961, recorded by banjo-nx's
   `tools/deko3d_variant_cache.py --export-variants`) plus each shader as it is (the console's fallback while a
   variant compiles), compiled by uam in WebAssembly (`wasm/uam`, the console's compiler with banjo-nx's flags) on a
   pool of workers. The NRO's own runtime shaders are read out of the NRO (`lib/nro.js`) and compiled too, so the
   console compiles nothing. If the player chooses to let the Switch compile, as katamari-nx-installer does, this step is
   skipped and `pipeline_list.bin` is left out too: with that list and no cache, the NRO's prebuild workers would compile
   every shader in it. Both files then build up on the SD card as the game runs.
6. **Title update 3 and the DLC**: renut-nx is the updated game. The player also chooses title update 3's Xbox 360
   package (`TU_16L61VD_0000004000000.00000000000O1`) and, optionally, the DLC's (L.O.G.'s Lost Challenges,
   `E41F20AAF7094B9AFCA8CC90489D689D72A5062B4D`). They are read in place (`lib/stfs.js`, from keflings-nx-installer;
   `lib/renut_files.js`): the update's `default.xexp` goes beside `default.xex` (checked against the manifest's
   SHA-256), its other files to `update/`, and the DLC package whole to `dlc/` (renut-nx installs it at its first
   start). `test/packages_node.mjs` checks every file against an extracted copy.
7. **renut-nx.zip**, streamed to a download by the service worker (`sw.js`): `switch/renut-nx/` with
   `renut-nx.nro`, `renut.toml`, `pipeline_list.bin`, the two shader files, `game_root/` (the game's files),
   `update/` and `dlc/`.

Every step except DXC is byte-identical with the native build (tests below). The page's DXC is newer (v2025.1, from
nfsmw-nx-installer) than the native build's (1.8.2407): about a quarter of the shaders come out with different
temporaries. They compile and do the same thing, but their GLSL, and so their DKSH, is not the native bytes.

## Use

    python serve.py 8193 .

then open http://127.0.0.1:8193/, choose the game's disc image (`.iso`, read by `lib/xiso.js`) or the folder it was
extracted to (with `default.xex` and `Bundle`), then title update 3's package (and the DLC's), and press
**Create renut-nx.zip**. A Chromium browser is recommended (service-worker downloads, `webkitdirectory`,
nested workers).

## Release files

`release/` is filled by `tools/make_release.py` from a banjo-nx **distribution build** (banjo-nx:
`tools/renut_switch_shader_cache.py --only app/out/pc-me/shader_capture` and `tools/deko3d_shader_package.py --only
app/out/pc-me/shader_capture --raw`, see banjo-nx's docs/deko3d-renderer.md). `manifest.json` names the supported
`default.xex` by its SHA-256 and the SHA-256 of every release file; with `--reference` also those of the shader files a
Node run made, so the page can say whether its own are identical.

## Tests (Node 24, from this folder)

| Test | What it checks |
|---|---|
| `test/dump_node.mjs <game> <banjo-nx out/renut_shader_dump>` | the dump in Pyodide finds every container of the native dump |
| `test/translate_node.mjs` | the translator and early alpha against the native build's rewritten HLSL |
| `test/py_passes_node.mjs`, `test/spirv_cross_node.mjs` | the Python passes and SPIRV-Cross, byte for byte |
| `test/chain_node.mjs <banjo-nx>` | the whole chain on a sample against glsl_opt_any; the different ones compile with uam |
| `test/uam_node.mjs` | the wasm uam against the console's DKSH cache, byte for byte |
| `test/timing_node.mjs <banjo-nx>` | where the GLSL step's time goes |
| `test/xiso_node.mjs <image.iso> <extracted folder>` | the disc image reader: the same files, sizes and bytes |
| `test/full_node.mjs <game> <banjo-nx> <out>` | everything, as the page runs it, with the shader table and caches compared |
| `test/browser.html` (with `python serve.py 8193 . --test-files <game>`) | worker.js in a browser, the zip read back; `?compile=0` leaves the compiling to the Switch |

Outputs of the tests (shader files, zips) are game data: never commit or share them.

Results (2026-10-22, the Xbox 360 disc, 16-thread PC; `test/full_node.mjs`, 10 threads, 22 min):

| Step | Result |
|---|---|
| dump | 4,731 containers in 303 files, all of the native dump's (113 s) |
| shader table | 4,731 of 4,731 shaders' numbers equal to the native table's |
| GLSL | 4,731 made (13 min); 3,547 byte for byte the native glsl_opt_any (the rest: DXC's version) |
| variants | 21,962 compiled (7 min), 0 failed; the 17,374 keys shared with the native cache 60 byte for byte |
| disc image | `lib/xiso.js`: 1,981 files, the extracted folder's sizes and bytes |
| browser (`test/browser.html?game=0`, Chromium, 8 GLSL + 15 uam workers) | shaders in 17 min (dump 2, GLSL 9.7, uam 5.3), both files byte for byte the Node run's (the manifest's SHA-256), the 5.7 GB zip streamed whole with good end records (20 min in all) |
| console (Ryujinx) | the NRO with these files: the intro and title, uam 0 compiles, 3,218 DKSH cache hits |

Per shader on one thread: early alpha 294 ms, DXC 272 ms, the GLSL passes 289 ms (`test/timing_node.mjs`), so the
page runs them on up to 8 workers (about 0.5 GB each) and uam on one worker per core.

## Not done yet

- Languages, offline copy of the page (bejeweled3-nx-installer's sw.js has both).
- An update-only zip (program and shaders, without the 6 GB of game files).

See NOTICES.md for what comes from where and its licences. GPL-3.0 (LICENSE).
