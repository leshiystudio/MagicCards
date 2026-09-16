// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MagicCards contributors

import assert from 'node:assert/strict';
export function runScenario(engine,scenario,content,fixture){
  let state=engine.loadFixture(fixture||scenario.fixture,content),last,previous=state;
  const observations=[];
  for(const [index,step] of (scenario.commands||[]).entries()){
    previous=state;last=engine.execute(state,step.command||step);
    if(step.expectError)assert.equal(last.error?.code,step.expectError,'Команда '+index);
    else if(!last.ok&&!(scenario.assertions||[]).some(a=>a.type==='command_error'))throw new Error('Команда '+index+': '+last.error.message);
    if(last.ok)state=last.state;
    observations.push({index,ok:last.ok,error:last.error,events:last.events,hash:engine.hashState(state)});
    for(const assertion of step.assertions||[])check(assertion);
  }
  function check(a){
    if(a.type==='command_error')assert.equal(last?.error?.code,a.code);
    else if(a.type==='state_unchanged')assert.deepEqual(state,previous);
    else if(a.type==='no_committed_events')assert.deepEqual(last?.events,[]);
    else if(a.type==='equals')assert.deepEqual(a.path.split('.').reduce((v,k)=>v?.[k],state),a.value,a.path);
    else if(a.type==='event')assert.ok(state.events.some(e=>e.type===a.event));
    else if(a.type==='stack_size')assert.equal(state.stack.length,a.value);
    else if(a.type==='invariants')engine.assertInvariants(state);
    else throw new Error('Неизвестное утверждение: '+a.type);
  }
  for(const a of scenario.assertions||[])check(a);
  return {scenarioId:scenario.scenarioId,passed:true,state,observations};
}
