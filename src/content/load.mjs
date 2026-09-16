// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MagicCards contributors

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateContent } from './compile.ts';
export async function loadContent(root = new URL('../../', import.meta.url)) {
  const base=typeof root==='string'?root:new URL(root).pathname.replace(/^\/([A-Za-z]:)/,'$1');
  const manifest=JSON.parse(await readFile(resolve(base,'content/manifest.json'),'utf8')),raw={...manifest};
  for(const [kind,files]of Object.entries(manifest))if(Array.isArray(files))raw[kind]=await Promise.all(files.map(async file=>JSON.parse(await readFile(resolve(base,file),'utf8'))));
  return {raw,content:validateContent(raw)};
}
