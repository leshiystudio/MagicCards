// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MagicCards contributors

import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {build,root} from './build.mjs';
export async function simulate({count=100,startSeed=1,modes=['deck_sources','automatic_growth'],onProgress=()=>{}}={}){
  if(!Number.isInteger(count)||count<1||count>10000||!Number.isInteger(startSeed)||startSeed<1||modes.some(m=>!['deck_sources','automatic_growth'].includes(m)))throw new Error('Invalid simulation range');
  await build();const stamp=Date.now(),load=p=>import(pathToFileURL(resolve(root,p)).href+'?v='+stamp);
  const E=await load('dist/src/engine/engine.mjs'),C=await load('dist/src/content/compile.mjs'),B=await load('dist/src/bot/policy.mjs');
  const content=C.validateContent(JSON.parse(await readFile(resolve(root,'dist/content.json'),'utf8'))),results=[];
  for(const mode of modes)for(let seed=startSeed;seed<startSeed+count;seed++){
    const started=Date.now();let s=E.createGame({presetId:mode==='deck_sources'?'duality_sources_v1':'automatic_energy_v1'},content,seed),error=null,steps=0;
    for(;steps<100000&&s.turnId<=500&&!s.result;steps++){
      try{
        const player=s.pendingDecision?.playerId||s.declaration?.playerId||s.priorityPlayerId;
        const context=E.getDecisionContext(s,player),decision=B.chooseAction({...context,policySeed:seed+100000});
        const r=E.execute(s,decision.command);
        if(!r.ok){error=r.error;break;}
        s=r.state;E.assertInvariants(s);
      }catch(e){error={code:e.code||'SIMULATION_EXCEPTION',message:e.message};break;}
      if(steps%200===0)await new Promise(r=>setTimeout(r,0));
    }
    let replayVerified=false;
    if(!error){try{replayVerified=E.hashState(E.replay(E.makeReplay(s)))===E.hashState(s);}catch(e){error={code:e.code,message:e.message};}}
    const row={mode,seed,turns:s.turnId,commands:steps,result:s.result,status:error?'technical_error':s.result?'completed':'unfinished',error,replayVerified,elapsedMs:Date.now()-started};
    results.push(row);onProgress(row);
    if(error){await mkdir(resolve(root,'artifacts/failures'),{recursive:true});await writeFile(resolve(root,'artifacts/failures',mode+'-'+seed+'.json'),JSON.stringify(E.makeReplay(s)));}
  }
  const report={timestamp:new Date().toISOString(),checks:{invariantsAfterEveryCommand:true,replayFinalHash:true},results,summary:{games:results.length,completed:results.filter(r=>r.status==='completed').length,technicalErrors:results.filter(r=>r.status==='technical_error').length,unfinished:results.filter(r=>r.status==='unfinished').length,replays:results.filter(r=>r.replayVerified).length}};
  await mkdir(resolve(root,'artifacts'),{recursive:true});await writeFile(resolve(root,'artifacts/simulation-'+startSeed+'-'+count+'.json'),JSON.stringify(report,null,2));return report;
}
if(globalThis.process?.argv?.[1]&&resolve(globalThis.process.argv[1])===fileURLToPath(import.meta.url)){const r=await simulate({count:Number(globalThis.process.argv[2])||100,onProgress:r=>console.log(r.mode,r.seed,r.status,r.turns)});console.log(r.summary);globalThis.process.exitCode=r.summary.technicalErrors||r.summary.unfinished?1:0;}
