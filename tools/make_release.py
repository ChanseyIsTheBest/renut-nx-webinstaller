#!/usr/bin/env python3
"""renut-nx-webinstaller (was banjo-nx-installer): fills release/ from a renut-nx (banjo-nx) distribution build.

    python tools/make_release.py --nro <distribution NRO> --banjo <banjo-nx root> --xex <the game's default.xex>
        --xexp <title update 3's default.xexp> --dict <deko3d_glsl.dict>
        [--toml <renut.toml>] [--pipelines <pipeline_list.bin>] [--reference <folder of test/full_node.mjs's output>]

The NRO must be a distribution build (banjo-nx: tools/renut_switch_shader_cache.py --only and
tools/deko3d_shader_package.py --only --raw): it carries none of the game's shaders but the ones the game makes at
runtime. release/ then holds the NRO, its settings and pipeline list, the translator's shader_common.h, and
manifest.json naming each file's SHA-256 and the supported default.xex (its SHA-256 only). With --reference, the
SHA-256 of the deko3d_glsl.bin and deko3d_shaders.bin a run of the whole build made (they are the same bytes in every
browser): the page then says whether its own are identical. release/variants.txt is written by banjo-nx's
tools/deko3d_variant_cache.py --export-variants.
"""
import argparse
import hashlib
import json
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--nro', required=True)
    ap.add_argument('--banjo', required=True)
    ap.add_argument('--xex', required=True)
    ap.add_argument('--xexp', required=True)  # 2026-11-01: title update 3's default.xexp (the page checks it)
    ap.add_argument('--toml')
    ap.add_argument('--pipelines')
    # 2026-11-01: the zstd dictionary renut-nx compresses the page's GLSL package with at its first start
    ap.add_argument('--dict', required=True)
    ap.add_argument('--reference')
    a = ap.parse_args()
    release = os.path.join(ROOT, 'release')
    os.makedirs(release, exist_ok=True)
    toml = a.toml or os.path.join(a.banjo, 'dist', 'switch', 'banjo-nx', 'renut.toml')
    pipelines = a.pipelines or os.path.join(a.banjo, 'dist', 'switch', 'banjo-nx', 'pipeline_list.bin')
    copies = [(a.nro, 'renut-nx.nro'), (toml, 'renut.toml'), (pipelines, 'pipeline_list.bin'), (a.dict, 'deko3d_glsl.dict'),
              (os.path.join(a.banjo, 'app', 'thirdparty', 'reblue-XenosRecomp', 'XenosRecomp', 'shader_common.h'),
               'shader_common.h')]
    for src, name in copies:
        shutil.copyfile(src, os.path.join(release, name))
    build = {
        'edition': 'Xbox 360 disc, title update 3',
        'xex_sha256': sha256(a.xex),
        'xexp_sha256': sha256(a.xexp),
        'nro': 'renut-nx.nro',
        'nro_sha256': sha256(os.path.join(release, 'renut-nx.nro')),
        'files': [{'path': name, 'source': name, 'sha256': sha256(os.path.join(release, name))}
                  for name in ('renut.toml', 'pipeline_list.bin', 'deko3d_glsl.dict')],
    }
    if a.reference:
        build['deko3d_glsl_sha256'] = sha256(os.path.join(a.reference, 'deko3d_glsl.bin'))
        build['deko3d_shaders_sha256'] = sha256(os.path.join(a.reference, 'deko3d_shaders.bin'))
    with open(os.path.join(release, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump({'version': 1, 'builds': [build]}, f, indent=2)
        f.write('\n')
    print(json.dumps(build, indent=2))


if __name__ == '__main__':
    main()
