// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MagicCards contributors

import {createInterface} from 'node:readline/promises';
import {readFile,writeFile} from 'node:fs/promises';
import {stdin,stdout} from 'node:process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {build,root} from '../../scripts/build.mjs';
import {runScenario} from './scenario.mjs';
await build();
const E=await import(pathToFileURL(resolve(root,'dist/src/engine/engine.mjs')).href);
const C=await import(pathToFileURL(resolve(root,'dist/src/content/compile.mjs')).href);
const B=await import(pathToFileURL(resolve(root,'dist/src/bot/policy.mjs')).href);
const content=C.validateContent(JSON.parse(await readFile(resolve(root,'dist/content.json'),'utf8')));
let state=E.createGame({},content,1),player='p1',debug=false;
const rl=createInterface({input:stdin,output:stdout});
const print=v=>console.log(typeof v==='string'?v:JSON.stringify(v,null,2));
const entity=id=>id==='p1'||id==='p2'?{playerId:id}:id.startsWith('s')?{itemId:id}:state.instances[id]?E.ref(state.instances[id]):(()=>{throw new Error('Неизвестный объект '+id);})();
const actor=()=>state.pendingDecision?.playerId||state.declaration?.playerId||state.priorityPlayerId;
const submit=c=>{const r=E.execute(state,c);if(!r.ok)throw new Error(r.error.code+': '+r.error.message);state=r.state;print(r.events);print({turn:state.turnId,phase:state.phase,priority:state.priorityPlayerId,result:state.result});};
print('MagicCards — help: команды; выход: quit. Приоритет '+actor());
for(;;){
  const line=(await rl.question('['+state.turnId+' '+state.phase+' '+actor()+'] > ')).trim();
  if(!line)continue;
  try{
    if(line.startsWith('{')){submit(JSON.parse(line));continue;}
    const [cmd,arg,...rest]=line.split(' ');
    if(cmd==='quit'||cmd==='exit')break;
    if(cmd==='help')print('new [deck_sources|automatic_growth] [seed]\nview p1|p2; debug full|off\nshow state|stack|legal|choices|events|abilities <instance>|modifiers <instance>|rule <id>\npass; source <instance>; cast <instance> <targets JSON>\nactivate <instance> <abilityId> <command fields JSON>\nattackers <a1>[>p2],<a2>; blockers <attacker>=<blocker>,...\nchoose <targets JSON>; action <legal index>; bot; concede\nfixture <file>; scenario <file>; save <file>; load <file>; export <file>; replay <file>\nМожно вводить полный JSON команды; один pass не завершает ход.');
    else if(cmd==='new'){state=E.createGame({presetId:arg==='automatic_growth'?'automatic_energy_v1':'duality_sources_v1'},content,Number(rest[0])||1);print('Новая партия');}
    else if(cmd==='view'){if(!['p1','p2'].includes(arg))throw new Error('Укажите p1/p2');player=arg;debug=false;}
    else if(cmd==='debug')debug=arg==='full';
    else if(cmd==='show'){
      if(arg==='state')print(debug?E.getDebugView(state):E.getPlayerView(state,player));
      else if(arg==='stack')print(E.getPlayerView(state,player).stack);
      else if(arg==='legal')print(E.getLegalActions(state,actor()));
      else if(arg==='choices')print(E.getPendingDecision(state,actor()));
      else if(arg==='events')print(debug?state.events:E.getPlayerView(state,player).events);
      else if(arg==='rule')print(content.rules[rest[0]]);
      else if(arg==='abilities'||arg==='modifiers'){const r=entity(rest[0]),v=E.effectiveView(state)[r.instanceId+'@'+r.generation];print(arg==='abilities'?v?.abilities:v?.modifierOrigins);}
    }else if(cmd==='pass')submit({type:'PassPriority',actorId:actor()});
    else if(cmd==='concede')submit({type:'Concede',actorId:player});
    else if(cmd==='source')submit({type:'PlayResourceCard',actorId:actor(),card:entity(arg)});
    else if(cmd==='cast')submit({type:'CastCard',actorId:actor(),card:entity(arg),targets:JSON.parse(rest.join(' ')||'{}')});
    else if(cmd==='activate')submit({type:'ActivateAbility',actorId:actor(),source:entity(arg),abilityId:rest[0],...JSON.parse(rest.slice(1).join(' ')||'{}')});
    else if(cmd==='attackers')submit({type:'DeclareAttackers',actorId:actor(),attackers:(arg?arg.split(','):[]).map(s=>{const [a,d]=s.split('>');return {attacker:entity(a),defender:entity(d||(actor()==='p1'?'p2':'p1'))};})});
    else if(cmd==='blockers')submit({type:'DeclareBlockers',actorId:actor(),blockers:(arg?arg.split(','):[]).map(s=>{const [a,b]=s.split('=');return {attacker:entity(a),blocker:entity(b)};})});
    else if(cmd==='choose')submit({type:'SubmitChoice',actorId:actor(),decisionId:state.pendingDecision?.decisionId,targets:JSON.parse([arg,...rest].join(' '))});
    else if(cmd==='action'){const t=E.getLegalActions(state,actor())[Number(arg)];if(!t)throw new Error('Нет действия');submit(E.materialize(t));}
    else if(cmd==='bot')submit(B.chooseAction(E.getDecisionContext(state,actor())).command);
    else if(cmd==='save'){await writeFile(arg||'magiccards-save.json',E.saveGame(state));print('Сохранено');}
    else if(cmd==='load'){state=E.loadGame(await readFile(arg,'utf8'));print('Загружено');}
    else if(cmd==='export'){await writeFile(arg||'magiccards-replay.json',JSON.stringify(E.makeReplay(state),null,2));print('Replay сохранён');}
    else if(cmd==='replay'){state=E.replay(JSON.parse(await readFile(arg,'utf8')));print('Replay совпал: '+E.hashState(state));}
    else if(cmd==='fixture'){state=E.loadFixture(JSON.parse(await readFile(arg,'utf8')),content);print('Fixture загружен');}
    else if(cmd==='scenario'){const scenario=JSON.parse(await readFile(arg,'utf8')),fixture=typeof scenario.fixture==='string'?JSON.parse(await readFile(resolve(root,scenario.fixture),'utf8')):scenario.fixture;const result=runScenario(E,scenario,content,fixture);state=result.state;print({scenarioId:result.scenarioId,passed:result.passed,observations:result.observations});}
    else print('Неизвестная команда. help — справка.');
  }catch(e){print('ОШИБКА: '+e.message);}
}
rl.close();
