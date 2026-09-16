import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {build,root} from './build.mjs';
import {runScenario} from '../src/cli/scenario.mjs';
export async function validate(){
  await build();const stamp=Date.now(),load=p=>import(pathToFileURL(resolve(root,p)).href+'?v='+stamp);
  const C=await load('dist/src/content/compile.mjs'),E=await load('dist/src/engine/engine.mjs');
  const raw=JSON.parse(await readFile(resolve(root,'dist/content.json'),'utf8')),content=C.validateContent(raw);
  for(const [id,p]of Object.entries(content.presets)){const config=C.normalizeConfig(p,content);C.validateDeck(content.decks[id==='automatic_energy_v1'?'core:starter':'duality:starter'],content,config);}
  const reports=[];
  for(const file of await readdir(resolve(root,'scenarios'))){if(!file.endsWith('.json'))continue;const scenario=JSON.parse(await readFile(resolve(root,'scenarios',file),'utf8'));const fixture=typeof scenario.fixture==='string'?JSON.parse(await readFile(resolve(root,scenario.fixture),'utf8')):scenario.fixture;const result=runScenario(E,scenario,content,fixture);reports.push({scenarioId:result.scenarioId,passed:result.passed});}
  return {cards:raw.cards.length,cardTypes:raw.cardTypes.length,scenarios:reports};
}
if(globalThis.process?.argv?.[1]&&resolve(globalThis.process.argv[1])===fileURLToPath(import.meta.url))console.log(await validate());
