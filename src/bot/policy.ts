// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MagicCards contributors

import { materialize, same } from '../engine/engine.ts';
const opponent=p=>p==='p1'?'p2':'p1';
function entity(view,r){
  if(r?.playerId)return view.players[r.playerId];
  return [...view.board,...view.players[view.playerId].hand,...Object.values(view.players).flatMap(p=>p.graveyard)].find(o=>same(o,r))||view.stack.find(i=>i.itemId===r?.itemId);
}
const value=o=>o?.playerId?8: (o?.attack||0)*1.6+Math.max(0,o?.health||0)+ (o?.abilities?.some(a=>a.kind==='continuous')?4:0);
const scalar=n=>typeof n==='number'?n:n?.type==='literal'?n.value:1;
function effectValue(e,command,view){
  const me=view.playerId,target=e.target?.selected?command.targets?.[e.target.selected]:e.player?.selected?command.targets?.[e.player.selected]:e.target?.context==='controller'?{playerId:me}:e.target?.context==='opponent'?{playerId:opponent(me)}:e.target?.selector==='all_enemy_creatures'?null:command.source;
  const o=entity(view,target),own=o&&(o.playerId||o.controllerId)===me,n=scalar(e.amount);
  if(e.type==='damage'){
    if(!o)return e.target?.selector==='all_enemy_creatures'?view.board.filter(o=>o.controllerId!==me).reduce((s,o)=>s+Math.min(n,o.health)+(n>=o.health?value(o):0),0):0;
    return (own?-1:1)*(o.playerId?(n>=o.health?10000:n*1.2):Math.min(n,o.health)+(n>=o.health?value(o):0));
  }
  if(e.type==='heal')return o?(own?1:-1)*Math.min(n,Math.max(0,(o.maxHealth||0)-o.health))*1.3:0;
  if(e.type==='destroy')return o?(own?-1:1)*value(o):0;
  if(e.type==='counter_spell')return o?(o.controllerId===me?-30:5+scalar(o.ability.cost?.generic)):0;
  if(e.type==='modify_stat')return own?n*1.3:-n;
  if(e.type==='draw')return 3*n;
  if(e.type==='create_token')return 6*n;
  if(e.type==='return_to_battlefield')return o?value(o):0;
  if(e.type==='exile_top')return 1.5*n;
  if(e.type==='if')return Math.max(...[...(e.then||[]),...(e.else||[])].map(x=>effectValue(x,command,view)),0)*0.7;
  if(['grant_ability','apply_effect_token','create_continuous_effect','modify_keyword'].includes(e.type))return 2;
  return 0;
}
function abilityFor(command,view){
  const o=entity(view,command.card||command.source);
  return command.type==='CastCard'?o?.definition:o?.abilities?.find(a=>a.abilityId===command.abilityId);
}
function score(command,view){
  if(command.type==='PassPriority')return 0;
  if(command.type==='PlayResourceCard')return 30;
  const o=entity(view,command.card||command.source),a=abilityFor(command,view);
  if(command.type==='SubmitChoice')return Object.values(command.targets||{}).reduce((s,r)=>s+value(entity(view,r)),1);
  if(!a)return -1;
  if(a.kind==='resource_activated'){
    const option=a.productionOptions.find(x=>x.id===command.productionOptionId),pool={...view.players[view.playerId].pool};
    for(const [r,n]of Object.entries(option?.resources||{}))pool[r]=(pool[r]||0)+n;
    let need=false;
    for(const card of view.players[view.playerId].hand){
      const d=card.definition;
      const ownMain=view.activePlayerId===view.playerId&&['MAIN_1','MAIN_2'].includes(view.phase)&&!view.stack.length;
      if(!ownMain&&!d.effects)continue;
      if(d.effects?.every(e=>effectValue(e,{targets:{victim:{playerId:opponent(view.playerId)}}},view)<=0))continue;
      const cost=d.cost;if(!cost)continue;
      const required=Object.entries(cost.resources||{}).some(([r,n])=>(view.players[view.playerId].pool[r]||0)<n&&(option.resources[r]||0)>0);
      const total=Object.values(view.players[view.playerId].pool).reduce((a,b)=>a+b,0),price=Object.values(cost.resources||{}).reduce((a,b)=>a+b,0)+(cost.generic||0);
      if(required||total<price)need=true;
    }
    return need?8:-1;
  }
  let n=(a.effects||[]).reduce((sum,e)=>sum+effectValue(e,command,view),0);
  if(command.type==='CastCard'&&!a.effects)n+=a.health?value({attack:a.attack,health:a.health,abilities:a.abilities})+1:a.power?6:3;
  for(const c of a.costs||[]){
    if(c.type==='pay_life'){if(scalar(c.amount)>=view.players[view.playerId].health)return -10000;n-=scalar(c.amount)*0.8;}
    if(c.type==='sacrifice')for(const r of command.costChoices?.[c.id||c.type]||[])n-=value(entity(view,r));
    if(c.type==='tap')n-=0.3;
  }
  n-=scalar(a.cost?.generic||0)*0.15;
  if(a.effects?.length&&n<=0)return -1;
  return n;
}
export function chooseAction(context){
  const {view,actions}=context,p=context.playerId,budget=Math.max(1,Math.floor(Math.min(256,context.budget||256)));
  if(!actions.length)return {revision:context.revision,decisionId:context.decisionId,command:null};
  const declaration=actions[0];
  if(declaration.type==='DeclareAttackers'){
    const enemies=view.board.filter(o=>o.controllerId!==p&&!o.tapped);
    const attackers=declaration.attackers.filter(r=>{
      const a=entity(view,r);return a?.keywords?.includes('vigilance')||!enemies.length||enemies.every(b=>b.attack<a.health)||a.attack>=view.players[opponent(p)].health||view.board.filter(o=>o.controllerId===p).length>=enemies.length;
    }).map(attacker=>({attacker,defender:{playerId:opponent(p)}}));
    return {revision:context.revision,decisionId:context.decisionId,command:{type:'DeclareAttackers',actorId:p,attackers}};
  }
  if(declaration.type==='DeclareBlockers'){
    const blockers=[],usedA=[],usedB=[],threat=(view.combat?.attackers||[]).reduce((n,a)=>n+(entity(view,a.attacker)?.attack||0),0);
    const pairs=[...declaration.pairs].sort((x,y)=>{
      const metric=pair=>{const a=entity(view,pair.attacker),b=entity(view,pair.blocker);return (b.attack>=a.health?value(a):0)-(a.attack>=b.health?value(b):0)+a.attack;};return metric(y)-metric(x);
    });
    for(const pair of pairs){
      if(usedA.some(r=>same(r,pair.attacker))||usedB.some(r=>same(r,pair.blocker)))continue;
      const a=entity(view,pair.attacker),b=entity(view,pair.blocker);
      if(threat>=view.players[p].health||b.attack>=a.health||a.attack<b.health){blockers.push(pair);usedA.push(pair.attacker);usedB.push(pair.blocker);}
    }
    return {revision:context.revision,decisionId:context.decisionId,command:{type:'DeclareBlockers',actorId:p,blockers}};
  }
  let policyState=(Number(context.policySeed)||1)>>>0;
  const nextTie=()=>{policyState^=policyState<<13;policyState^=policyState>>>17;policyState^=policyState<<5;return policyState>>>0;};
  let best=materialize(actions[0]),bestScore=-Infinity,bestTie=-1,count=0;
  for(const t of actions){
    const initial=materialize(t),variants=[initial];
    for(const target of t.targets||[]){
      if(target.count===1)for(const r of target.options)variants.push({...initial,targets:{...initial.targets,[target.id]:r}});
    }
    for(const choice of t.costChoices||[])if(choice.count===1)for(const r of choice.options)variants.push({...initial,costChoices:{...initial.costChoices,[choice.id]:[r]}});
    for(const option of t.productionOptions||[])variants.push({...initial,productionOptionId:option.id});
    for(const c of variants){
      if(count>=budget)break;count++;
      const n=score(c,view);
      const tie=nextTie();if(n>bestScore||n===bestScore&&tie>bestTie){bestScore=n;bestTie=tie;best=c;}
    }
    if(count>=budget)break;
  }
  return {revision:context.revision,decisionId:context.decisionId,command:best,evaluated:count,score:bestScore};
}
