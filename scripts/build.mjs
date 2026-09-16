import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
export const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function build(){
  const files=[];
  async function walk(dir){for(const entry of await readdir(resolve(root,dir),{withFileTypes:true})){const name=dir+'/'+entry.name;if(entry.isDirectory())await walk(name);else files.push(name);}}
  await walk('src');
  files.sort();
  const versionImports=text=>text.replace(/(from\s*['"])(\.{1,2}\/[^'"]+)\.(?:ts|mjs)(['"])/g,'$1$2.mjs$3');
  for(const file of files){
    const out=resolve(root,'dist',file.replace(/\.ts$/,'.mjs'));await mkdir(dirname(out),{recursive:true});
    if(file.endsWith('.ts')){
      const text=await readFile(resolve(root,file),'utf8');
      await writeFile(out,versionImports(stripTypeScriptTypes(text,{mode:'strip'})));
    }else if(file.endsWith('.mjs'))await writeFile(out,versionImports(await readFile(resolve(root,file),'utf8')));else await copyFile(resolve(root,file),out);
  }
  const manifest=JSON.parse(await readFile(resolve(root,'content/manifest.json'),'utf8')),raw={...manifest};
  for(const [kind,paths]of Object.entries(manifest))if(Array.isArray(paths))raw[kind]=await Promise.all(paths.map(async p=>JSON.parse(await readFile(resolve(root,p),'utf8'))));
  await mkdir(resolve(root,'dist'),{recursive:true});
  await writeFile(resolve(root,'dist/content.json'),JSON.stringify(raw));
  for(const file of ['index.html','styles.css'])try{await copyFile(resolve(root,file),resolve(root,'dist',file));}catch(e){if(e.code!=='ENOENT')throw e;}
  return {root,files:files.length,cards:raw.cards.length};
}
if(globalThis.process?.argv?.[1]&&resolve(globalThis.process.argv[1])===fileURLToPath(import.meta.url))console.log(await build());
