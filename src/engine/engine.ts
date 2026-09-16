// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MagicCards contributors

import { normalizeConfig, validateDeck, validateContent, bindAbility, integer, deepFreeze } from '../content/compile.ts';

export type PlayerId = 'p1' | 'p2';
export type EntityRef = {playerId:PlayerId}|{instanceId:string;generation:number}|{itemId:string};
export type Command = {type:string;actorId:PlayerId;[key:string]:any};
export const PHASES=['UPKEEP','DRAW','MAIN_1','COMBAT_BEGIN','DECLARE_ATTACKERS','DECLARE_BLOCKERS','COMBAT_DAMAGE','COMBAT_END','MAIN_2','END','CLEANUP'];
export class IllegalCommand extends Error { code:string; constructor(code:string,message=code){super(message);this.code=code;} }
const assert=(v,code,message=code)=>{if(!v)throw new IllegalCommand(code,message);};
const other=p=>p==='p1'?'p2':'p1';
export const ref=o=>o.playerId?{playerId:o.playerId}:o.itemId?{itemId:o.itemId}:{instanceId:o.instanceId,generation:o.generation};
export const same=(a,b)=>!!a&&!!b&&(a.playerId&&b.playerId?a.playerId===b.playerId:a.itemId&&b.itemId?a.itemId===b.itemId:!!a.instanceId&&a.instanceId===b.instanceId&&a.generation===b.generation);
const key=r=>r?.playerId||r?.itemId||(r?.instanceId+'@'+r?.generation);
const list=x=>x==null?[]:Array.isArray(x)?x:[x];
const def=(s,o)=>s.content.cards[o?.cardId]||s.content.tokens[o?.cardId];
const type=(s,o)=>s.content.cardTypes[def(s,o)?.typeId];
const units=(s,p)=>Object.values(s.instances).filter((o:any)=>o.zone==='battlefield'&&(!p||o.controllerId===p));
const isCreature=(s,o)=>!!type(s,o)?.categories.includes('categories:creature');
const exists=(s,r)=>!!getObject(s,r);
export function getObject(s,r) {
  if(!r)return undefined;
  if(r.playerId)return s.players[r.playerId];
  if(r.itemId)return s.stack.find(v=>v.itemId===r.itemId);
  const o=s.instances[r.instanceId];
  return o&&o.generation===r.generation?o:undefined;
}
export function nextRandom(state) {
  let x=state.rngState>>>0;x^=x<<13;x^=x>>>17;x^=x<<5;state.rngState=x>>>0;return state.rngState;
}
export function nextIndex(state,n) {
  assert(Number.isInteger(n)&&n>0,'BAD_RANDOM_BOUND');
  const limit=Math.floor(4294967296/n)*n;let x;do{x=nextRandom(state);}while(x>=limit);return x%n;
}
const shuffle=(s,a)=>{for(let i=a.length-1;i>0;i--){const j=nextIndex(s,i);[a[i],a[j]]=[a[j],a[i]];}return a;};
function tick(s,n=1){s._ops=(s._ops||0)+n;assert(s._ops<=1000,'TECHNICAL_BUDGET','Превышен бюджет 1000 операций команды');}
const num=(s,n,ctx,nonnegative=true)=>{const v=evaluate(s,n,ctx);assert(Number.isInteger(v)&&v>= (nonnegative?0:-2147483648)&&v<=2147483647,'EXPRESSION_RANGE');return v;};
const baseContext=(s,o,extra={})=>({source:o?ref(o):undefined,controller:{playerId:o?.controllerId||s.activePlayerId},opponent:{playerId:other(o?.controllerId||s.activePlayerId)},sourceSnapshot:o?snapshot(s,o):undefined,attached_to:o?.attachmentHost,attachedSnapshot:o?.attachmentHost?snapshot(s,getObject(s,o.attachmentHost)):undefined,locals:{},params:{},targets:{},...extra});

export function baseView(s) {
  const v={};
  for(const p of Object.values(s.players) as any[])v[p.playerId]={...p,capabilities:['player','health','damageable','ability_host'],keywords:[],rules:[],abilities:[]};
  for(const o of Object.values(s.instances) as any[]){
    const d=def(s,o),t=type(s,o);if(!d||!t)continue;
    v[key(o)]={...o,attack:d.attack??0,maxHealth:d.health,health:d.health===undefined?undefined:d.health-o.markedDamage,subtypes:d.subtypes||[],tags:d.tags||[],keywords:[...(d.keywords||[])],rules:[],abilities:[],capabilities:t.capabilities,categories:t.categories};
  }
  return v;
}
function bindings(s,o,attachments) {
  const out=[],seen=new Set();
  for(const [i,a]of attachments.entries()){
    const bound=bindAbility(a,type(s,o)?.capabilities||['player','health','ability_host'],s.content,o.zone||'battlefield');
    if(!bound.active)continue;
    const origin=a.origin||key(o)+':'+(a.id||i);
    if(bound.stacking==='unique'&&seen.has(bound.id))continue;seen.add(bound.id);
    for(const b of bound.behaviors.length?bound.behaviors:bound.keywordId?[{id:'keyword',kind:'keyword_marker'}]:[]){
      out.push({...b,abilityId:a.id&&!a.origin?a.id+(bound.behaviors.length>1?'/'+b.id:''):origin+'/'+b.id,definitionId:bound.id,params:bound.params,keywordId:bound.keywordId,origin,hostRole:b.hostRole});
    }
  }
  return out;
}
export function effectiveView(s) {
  const v=baseView(s),b=baseView(s),providers=[],grants=[];
  for(const o of [...Object.values(s.players),...Object.values(s.instances)] as any[]){
    const k=key(o),d=def(s,o);
    let a=[...(d?.abilities||[])];
    for(const kw of d?.keywords||[]){const lib=Object.values(s.content.abilities).find((x:any)=>x.keywordId===kw);if(lib&&!a.some(x=>x.ref===lib.id))a.push({id:'keyword:'+kw,ref:lib.id});}
    for(const g of s.grants)if(same(g.target,ref(o))&&durationActive(s,g))a.push({...g.ability,origin:g.id});
    for(const token of o.effectTokens||[]){
      const td=s.content.effectTokens[token.definitionId];
      for(const c of td?.components||[]){
        if(c.kind==='ability')a.push({...c,origin:token.id+'/'+c.id});
        else if(c.kind==='stat')providers.push({target:ref(o),operation:'add_stats',attack:c.stat==='attack'?c.amount:0,health:c.stat==='max_health'?c.amount:0,origin:token.id});
        else if(c.kind==='keyword')providers.push({target:ref(o),operation:c.operation==='remove'?'remove_keyword':'grant_keyword',keyword:c.keyword,origin:token.id});
      }
    }
    v[k].abilities=bindings(s,o,a).filter(a=>!s.suppressions.some(m=>same(m.target,ref(o))&&m.definitionId===a.definitionId&&durationActive(s,m)));
    for(const a of v[k].abilities)if(a.keywordId&&!v[k].keywords.includes(a.keywordId))v[k].keywords.push(a.keywordId);
    if(o.zone==='battlefield'){
      for(const a of v[k].abilities)if(a.kind==='continuous'){
        const ctx={source:ref(o),controller:{playerId:o.controllerId},opponent:{playerId:other(o.controllerId)},attached_to:o.attachmentHost,params:a.params,locals:{},targets:{},view:b};
        for(const m of a.modifiers||[])for(const target of query(s,m,ctx)){
          (m.operation==='grant_ability'?grants:providers).push({...m,target,origin:a.origin+'/'+m.id,ctx});
        }
      }
    }
  }
  for(const ce of s.continuous)if(durationActive(s,ce))for(const m of ce.modifiers)for(const target of query(s,m,{...ce.context,view:b})) (m.operation==='grant_ability'?grants:providers).push({...m,target,origin:ce.id+'/'+m.id,ctx:ce.context});
  for(const m of s.modifiers)if(durationActive(s,m))providers.push(m);
  // Keyword masks dominate grants. Abilities retain stable origin-derived IDs.
  for(const m of providers)if(v[key(m.target)]&&m.operation==='grant_keyword')v[key(m.target)].keywords.push(m.keyword);
  for(const m of providers)if(v[key(m.target)]&&m.operation==='remove_keyword')v[key(m.target)].keywords=v[key(m.target)].keywords.filter(k=>k!==m.keyword);
  for(const [k,o]of Object.entries(v) as any) {
    o.keywords=[...new Set(o.keywords)];
    for(const mask of s.suppressions)if(same(mask.target,ref(o))&&durationActive(s,mask)){const kw=s.content.abilities[mask.definitionId]?.keywordId;if(kw)o.keywords=o.keywords.filter(k=>k!==kw);}
    o.abilities=o.abilities.filter(a=>!a.keywordId||o.keywords.includes(a.keywordId));
    // A granted keyword activates its library behavior just like an intrinsic keyword.
    for(const kw of o.keywords){
      const lib=Object.values(s.content.abilities).find((a:any)=>a.keywordId===kw);
      if(lib&&!o.abilities.some(a=>a.definitionId===lib.id))o.abilities.push(...bindings(s,getObject(s,ref(o)),[{ref:lib.id,origin:'keyword/'+kw}]));
    }
  }
  for(const g of grants){
    const o=getObject(s,g.target);if(!o||!v[key(o)])continue;
    const a=bindings(s,o,[{...g.ability,origin:g.origin}]).filter(a=>!s.suppressions.some(m=>same(m.target,g.target)&&m.definitionId===a.definitionId&&durationActive(s,m)));
    for(const a1 of a){
      if(s.content.abilities[a1.definitionId]?.stacking==='unique'&&v[key(o)].abilities.some(x=>x.definitionId===a1.definitionId))continue;
      v[key(o)].abilities.push(a1);
      if(a1.kind==='continuous')for(const m of a1.modifiers||[]){
        assert(!['grant_ability','grant_keyword','remove_keyword'].includes(m.operation),'RECURSIVE_AURA');
        for(const target of query(s,m,{source:ref(o),controller:{playerId:o.controllerId},opponent:{playerId:other(o.controllerId)},params:a1.params,view:b}))providers.push({...m,target,origin:g.origin+'/'+m.id,ctx:{params:a1.params,view:b}});
      }
    }
  }
  assert(providers.length<=4096,'TECHNICAL_CONTRIBUTIONS');
  for(const m of providers){
    const o=v[key(m.target)];if(!o)continue;
    if(m.operation==='add_stats'){o.attack+=evaluate(s,m.attack??0,{...m.ctx,view:b});if(o.maxHealth!==undefined)o.maxHealth+=evaluate(s,m.health??0,{...m.ctx,view:b});}
    if(m.operation==='grant_rule')o.rules.push(m.rule);
  }
  for(const m of providers)if(m.operation==='remove_rule'&&v[key(m.target)])v[key(m.target)].rules=v[key(m.target)].rules.filter(r=>r!==m.rule);
  for(const o of Object.values(v)as any[]){o.attack=Math.max(0,o.attack||0);if(o.maxHealth!==undefined)o.health=o.maxHealth-(o.markedDamage||0);o.modifierOrigins=providers.filter(m=>same(m.target,ref(o))).map(m=>m.origin);}
  return v;
}
function durationActive(s,m) {
  if(!exists(s,m.target)&&m.target)return false;
  if(m.target?.instanceId&&getObject(s,m.target)?.zone!=='battlefield')return false;
  if(m.duration?.type==='until_source_leaves')return getObject(s,m.source)?.zone==='battlefield';
  if(m.duration?.type==='until_end_of_turn')return m.turnId===s.turnId;
  return true;
}
export function snapshot(s,o,v=undefined){
  if(!o)return undefined;
  const e=(v||effectiveView(s))[key(o)];
  return structuredClone({...o,...e,abilities:e?.abilities||[],effectTokens:o.effectTokens||[]});
}
function property(s,object,name,read,ctx) {
  if(object==null)return undefined;
  const o=read==='snapshot'?object:(ctx.view|| (read==='base'?baseView(s):effectiveView(s)))[key(object)];
  if(!o)return undefined;
  const props={attack:o.attack??o.creatureSnapshot?.attack,health:o.health??o.creatureSnapshot?.health,max_health:o.maxHealth,maxHealth:o.maxHealth,markedDamage:o.markedDamage,controller:o.controller||{playerId:o.controllerId||o.playerId},owner:o.owner||{playerId:o.ownerId||o.playerId},power:o.power,armor:o.armor,isToken:o.isToken};
  assert(Object.hasOwn(props,name),'UNKNOWN_PROPERTY',name);return props[name];
}
export function query(s,q,ctx={}) {
  const view=ctx.view||effectiveView(s),p=ctx.controller?.playerId||s.activePlayerId,source=ctx.source;
  const board=units(s).map(ref),creatures=units(s).filter(o=>isCreature(s,o)).map(ref);
  const friendly=r=>getObject(s,r)?.controllerId===p,enemy=r=>!friendly(r);
  let a=[];
  switch(q.selector){
    case 'self':a=source?[source]:[];break;
    case 'attached_host':a=ctx.attached_to?[ctx.attached_to]:[];break;
    case 'friendly_player':a=[{playerId:p}];break;
    case 'enemy_player':a=[{playerId:other(p)}];break;
    case 'player':a=[{playerId:'p1'},{playerId:'p2'}];break;
    case 'friendly_creature':case 'all_friendly_creatures':a=creatures.filter(friendly);break;
    case 'other_friendly_creatures':a=creatures.filter(r=>friendly(r)&&!same(r,source));break;
    case 'enemy_creature':case 'all_enemy_creatures':a=creatures.filter(enemy);break;
    case 'all_creatures':a=creatures;break;
    case 'friendly_character':a=[{playerId:p},...creatures.filter(friendly)];break;
    case 'enemy_character':a=[{playerId:other(p)},...creatures.filter(enemy)];break;
    case 'character':a=[{playerId:'p1'},{playerId:'p2'},...creatures];break;
    case 'friendly_permanent':a=board.filter(friendly);break;
    case 'enemy_permanent':a=board.filter(enemy);break;
    case 'all_permanents':a=board;break;
    case 'enemy_damageable':a=[{playerId:other(p)},...board.filter(r=>enemy(r)&&view[key(r)]?.capabilities.includes('damageable'))];break;
    case 'pending_spell':a=s.stack.filter(x=>x.kind==='spell').map(ref);break;
    case 'graveyard_card':case 'graveyard_creature_card':a=Object.values(s.instances).filter((o:any)=>o.zone==='graveyard'&&(q.selector==='graveyard_card'||isCreature(s,o))).map(ref);break;
    default:throw new IllegalCommand('UNKNOWN_SELECTOR',q.selector);
  }
  return a.filter(r=>exists(s,r)&&(!q.filter||evaluate(s,q.filter,{...ctx,view,candidate:r})));
}
export function evaluate(s,n,ctx={}) {
  if(typeof s._ops==='number')tick(s);
  if(n==null||typeof n!=='object')return n;
  if(n.context)return ctx[n.context];
  if(n.selected)return ctx.targets?.[n.selected];
  if(n.selector)return query(s,n,ctx);
  if(Array.isArray(n))return n.map(v=>evaluate(s,v,ctx));
  const ev=x=>evaluate(s,x,ctx),binary=f=>f(ev(n.left),ev(n.right));
  let value;
  switch(n.type){
    case 'literal':return n.value;
    case 'local':case 'item':return ctx.locals?.[n.name];
    case 'read_param':return ctx.params?.[n.name];
    case 'read_event':return n.field.split('.').reduce((o,k)=>o?.[k],ctx.event);
    case 'read_cost':return ctx.costReceipt?.[n.costId]?.[n.index||0]?.[n.property];
    case 'read_property':return property(s,ev(n.object),n.property,n.read,ctx);
    case 'read_effect_token_count':{const o=ev(n.object);return (n.read==='snapshot'?o:getObject(s,o))?.effectTokens?.filter(t=>t.definitionId===n.definitionId).length||0;}
    case 'count':return list(ev(n.items)).length;
    case 'exists':return list(ev(n.items??n.value??n.object)).length>0;
    case 'filter':return list(ev(n.items)).filter(x=>evaluate(s,n.where,{...ctx,locals:{...ctx.locals,[n.as]:x}}));
    case 'sum':value=list(ev(n.items)).reduce((sum,x)=>sum+evaluate(s,n.value,{...ctx,locals:{...ctx.locals,[n.as]:x}}),0);break;
    case 'if_value':return ev(ev(n.condition)?n.then:n.else);
    case 'coalesce':return ev(n.value)??ev(n.fallback);
    case 'add':value=binary((a,b)=>a+b);break;
    case 'subtract':value=binary((a,b)=>a-b);break;
    case 'multiply':value=binary((a,b)=>a*b);break;
    case 'min':value=n.items?Math.min(...ev(n.items)):binary(Math.min);break;
    case 'max':value=n.items?Math.max(...ev(n.items)):binary(Math.max);break;
    case 'abs':value=Math.abs(ev(n.value));break;
    case 'negate':value=-ev(n.value);break;
    case 'equal':return binary((a,b)=>typeof a==='object'?same(a,b):a===b);
    case 'not_equal':return binary((a,b)=>typeof a==='object'?!same(a,b):a!==b);
    case 'less':return binary((a,b)=>a<b);
    case 'less_or_equal':return binary((a,b)=>a<=b);
    case 'greater':return binary((a,b)=>a>b);
    case 'greater_or_equal':return binary((a,b)=>a>=b);
    case 'and':return n.items.every(x=>!!ev(x));
    case 'or':return n.items.some(x=>!!ev(x));
    case 'not':return !ev(n.value??n.item);
    case 'is_damaged':{const o=getObject(s,ev(n.object));return !!o&&(o.playerId?o.health<o.maxHealth:o.markedDamage>0);}
    case 'has_subtype':case 'has_tag':case 'has_keyword':case 'has_capability':{
      const object=ev(n.object),o=n.read==='snapshot'?object:(ctx.view||(n.read==='base'?baseView(s):effectiveView(s)))[key(object)];
      const [field,value]=n.type==='has_subtype'?['subtypes',n.subtype]:n.type==='has_tag'?['tags',n.tag]:n.type==='has_keyword'?['keywords',n.keyword]:['capabilities',n.capability];
      return !!o?.[field]?.includes(value);
    }
    case 'interaction_allowed':case 'can_interact':return evaluateInteraction(s,n.interaction,Object.fromEntries(Object.entries(n.participants||{}).map(([k,v])=>[k,ev(v)]))).allowed;
    default:throw new IllegalCommand('UNKNOWN_EXPRESSION',n.type);
  }
  assert(Number.isInteger(value)&&value>=-2147483648&&value<=2147483647,'EXPRESSION_OVERFLOW');return value;
}
export function evaluateInteraction(s,interaction,participants) {
  const v=effectiveView(s),violations=[],rules=(s.content.globalRuleIds||[]).map(id=>({...s.content.rules[id],id:'global/'+id}));
  for(const [role,r]of Object.entries(participants))for(const a of v[key(r)]?.abilities||[])if(a.kind==='interaction_rule'&&a.hostRole===role){
    const rule=a.ref?s.content.rules[a.ref]:a;
    rules.push({...rule,id:a.origin+'/'+(rule.id||a.id),source:r});
  }
  assert(rules.length<=128,'TECHNICAL_RULES');
  for(const r of rules as any[])if(r.interaction===interaction){
    const ctx={...participants,source:r.source,view:v};
    if((!r.when||evaluate(s,r.when,ctx))&&!evaluate(s,r.require,ctx))violations.push(r.reasonCode);
  }
  return {allowed:!violations.length,violations};
}

function emit(s,event,payload={},listeners=undefined) {
  tick(s);
  const e={eventId:'e'+(++s.ids.event),type:event,turnId:s.turnId,phase:s.phase,source:s.frame?.source,stackItemId:s.frame?.itemId,...structuredClone(payload)};
  s.events.push(e);
  const listenerView=listeners?null:effectiveView(s);
  const sources=listeners||units(s).map(o=>snapshot(s,o,listenerView));
  for(const o of sources){
    for(const a of o.abilities||[]){
      if(a.kind!=='triggered')continue;
      const matches=a.trigger===event||(a.trigger==='on_enter'&&event==='permanent_entered'&&same(ref(o),e.permanent))||(a.trigger==='on_death'&&event==='creature_died'&&same(ref(o),e.creature));
      if(!matches)continue;
      const ctx={source:ref(o),sourceSnapshot:o,controller:{playerId:o.controllerId},opponent:{playerId:other(o.controllerId)},event:e,params:a.params,attached_to:o.attachmentHost,locals:{},targets:{}};
      if(!a.condition||evaluate(s,a.condition,ctx))s.pendingTriggers.push({ability:a,context:ctx,eventOrder:s.ids.event,sourceOrder:o.enterOrder||0});
    }
  }
  for(const delayed of [...s.delayed]){
    if((delayed.event===event||delayed.event?.type===event)&&(!delayed.scopeId||delayed.scopeId===s.combat?.combatId)){
      const ctx={...delayed.context,event:e};
      if(!delayed.condition||evaluate(s,delayed.condition,ctx)){
        s.pendingTriggers.push({ability:delayed,context:ctx,eventOrder:s.ids.event,sourceOrder:0});
        s.delayed=s.delayed.filter(d=>d.id!==delayed.id);
      }
    }
  }
  assert(s.pendingTriggers.length<=256,'TECHNICAL_TRIGGERS');
  return e;
}
function newInstance(s,cardId,ownerId,zone,isToken=false) {
  const d=s.content.cards[cardId]||s.content.tokens[cardId];assert(d,'UNKNOWN_CARD');
  const o={instanceId:'c'+(++s.ids.instance),generation:1,cardId,ownerId,controllerId:ownerId,zone,isToken,markedDamage:0,tapped:false,enteredTurn:0,enterOrder:0,effectTokens:[],armor:d.armor||0,power:d.power,usage:{},attachmentHost:undefined};
  s.instances[o.instanceId]=o;return o;
}
function removeFromZone(s,o) {
  const a=s.players[o.ownerId]?.[o.zone];
  if(Array.isArray(a)){const i=a.indexOf(o.instanceId);if(i>=0)a.splice(i,1);}
}
function move(s,o,zone,reason='effect',controllerId=o.ownerId,attachmentHost=undefined) {
  moveBatch(s,[o],zone,reason,controllerId,attachmentHost);
}
function moveBatch(s,objects,zone,reason='effect',controllerId=undefined,attachmentHost=undefined) {
  if(!objects.length)return;
  const v=effectiveView(s),listeners=units(s).map(o=>snapshot(s,o,v)),changes=[];
  for(const o of objects){
    const before=snapshot(s,o,v),from=o.zone,oldRef=ref(o);
    removeFromZone(s,o);
    o.generation++;o.zone=zone;o.controllerId=controllerId||o.ownerId;
    o.markedDamage=0;o.tapped=false;o.effectTokens=[];o.usage={};o.attachmentHost=undefined;
    o.armor=def(s,o).armor||0;o.power=def(s,o).power;
    if(zone==='battlefield'){
      o.enteredTurn=s.turnId;o.controllerTurnEntered=s.players[o.controllerId].turnsStarted;o.enterOrder=++s.ids.entry;o.attachmentHost=attachmentHost;
      const meter=type(s,o).components.power_meter;
      if(meter)for(let i=0;i<(def(s,o).power||0);i++)o.effectTokens.push({id:'t'+(++s.ids.token),definitionId:meter.markerId,hostRef:ref(o),duration:{type:'permanent_on_instance'},turnId:s.turnId});
    }else if(Array.isArray(s.players[o.ownerId][zone]))s.players[o.ownerId][zone].push(o.instanceId);
    changes.push({o,before,from,oldRef});
  }
  for(const {o,before,from,oldRef}of changes){
    const after=snapshot(s,o),payload={card:ref(o),previous:oldRef,from,to:zone,reason,controller:{playerId:o.controllerId},permanentSnapshot:before};
    emit(s,'zone_changed',payload,listeners);
    if(from==='battlefield'){
      emit(s,'permanent_left',{...payload,permanent:oldRef},listeners);
      if(type(s,o).play.method==='source_deploy')emit(s,'resource_left',{...payload,resource:oldRef,resourceSnapshot:before},listeners);
      if(zone==='graveyard'&&isCreature(s,o)){
        const death={creature:oldRef,creatureSnapshot:before,controller:{playerId:before.controllerId},reason,source:s.frame?.source,stackItemId:s.frame?.itemId};
        s.deaths.push(death);if(s.combat)s.combat.deaths.push(death);
        emit(s,'creature_died',death,listeners);
      }
    }
    if(zone==='battlefield'){
      const entryView=effectiveView(s),entering=units(s).map(x=>snapshot(s,x,entryView));
      emit(s,'permanent_entered',{...payload,permanent:ref(o),permanentSnapshot:after},entering);
      if(isCreature(s,o))emit(s,'creature_entered',{...payload,creature:ref(o),creatureSnapshot:after},entering);
      if(type(s,o).play.method==='source_deploy')emit(s,'resource_entered',{...payload,resource:ref(o),resourceSnapshot:after},entering);
    }
    if(o.isToken&&zone!=='battlefield'){removeFromZone(s,o);delete s.instances[o.instanceId];}
  }
}
function vacant(s,o,p){return !type(s,o).components.battlefield_slot||units(s,p).filter(x=>type(s,x).components.battlefield_slot?.group==='unit').length<s.config.limits.maxCreaturesPerPlayer;}
function attachmentValid(s,o,host) {
  const h=getObject(s,host);if(!h||h.zone!=='battlefield'||same(ref(o),host)||!type(s,h).components.attachment_host)return false;
  const seen=new Set([key(ref(o))]);let current=host,depth=0;
  while(current){if(seen.has(key(current))||++depth>16)return false;seen.add(key(current));current=getObject(s,current)?.attachmentHost;}
  return query(s,def(s,o).attachTo,{controller:{playerId:o.controllerId},source:ref(o),view:baseView(s)}).some(r=>same(r,host));
}
function checkpoint(s) {
  for(let wave=0;wave<128;wave++){
    tick(s);
    const losers=Object.values(s.players).filter((p:any)=>p.health<=0).map((p:any)=>p.playerId);
    if(losers.length){s.result={type:losers.length===2?'draw':'win',winner:losers.length===1?other(losers[0]):undefined,reason:'health'};s.pendingDecision=null;return;}
    const v=effectiveView(s),dead=units(s).filter(o=>{
      const t=type(s,o),e=v[key(o)];
      return t.components.health&&(e.maxHealth<=0||e.health<=0)||t.components.power_meter?.onZero==='graveyard'&&power(s,o)<=0||t.components.attachment&&!attachmentValid(s,o,o.attachmentHost);
    });
    if(!dead.length)return;
    moveBatch(s,dead,'graveyard','state_based');
  }
  throw new IllegalCommand('TECHNICAL_CHECKPOINT');
}
function power(s,o) { const id=type(s,o)?.components.power_meter?.markerId;return id?o.effectTokens.filter(t=>t.definitionId===id).length:undefined; }
function pushStack(s,kind,ability,ctx,card=undefined){
  const item={itemId:'s'+(++s.ids.stack),kind,ability:structuredClone(ability),context:structuredClone(ctx),controllerId:ctx.controller.playerId,source:ctx.source,card};
  s.stack.push(item);emit(s,'stack_added',{itemId:item.itemId,kind,controller:{playerId:item.controllerId},name:ability.name||ability.id});return item;
}
function castProgram(s,o){
  const d=def(s,o),modules=bindings(s,{...o,zone:'stack'},d.abilities||[]).filter(a=>a.kind==='on_resolve').map(a=>({...a,prefix:a.abilityId}));
  return {...d,modules,targets:[...(d.targets||[]),...modules.flatMap(a=>(a.targets||[]).map(t=>({...t,id:a.prefix+'/'+t.id})))]};
}
function targetSpecs(s,a,o) {
  return [...(a.targets||[]),...(o&&type(s,o).play.resolution==='attach'?[{id:'attachmentHost',...def(s,o).attachTo,count:1}]:[])];
}
function validateTargets(s,specs,targets,ctx,partial=false) {
  const checked={};
  for(const spec of specs){
    const chosen=list(targets?.[spec.id]),options=query(s,spec,ctx);
    if(!partial)assert(chosen.length===spec.count,'TARGET_COUNT',spec.id+': выберите '+spec.count);
    const good=chosen.filter(r=>options.some(x=>same(x,r)));
    if(!partial)assert(good.length===chosen.length&&new Set(chosen.map(key)).size===chosen.length,'ILLEGAL_TARGET',spec.id);
    if(good.length)checked[spec.id]=spec.count===1?good[0]:good;
  }
  return checked;
}
function flushTriggers(s) {
  if(s.result)return;
  s.pendingTriggers.sort((a,b)=>(a.context.controller.playerId===s.activePlayerId?0:1)-(b.context.controller.playerId===s.activePlayerId?0:1)||a.eventOrder-b.eventOrder||a.sourceOrder-b.sourceOrder);
  while(s.pendingTriggers.length&&!s.pendingDecision){
    const trigger=s.pendingTriggers.shift(),specs=trigger.ability.targets||[];
    if(specs.some(t=>query(s,t,trigger.context).length<t.count)){emit(s,'trigger_skipped',{reason:'NO_TARGET',abilityId:trigger.ability.id});continue;}
    if(specs.length){s.pendingDecision={decisionId:'d'+(++s.ids.decision),playerId:trigger.context.controller.playerId,trigger,specs};return;}
    pushStack(s,'trigger',trigger.ability,trigger.context);
  }
}
function draw(s,p,n,setup=false) {
  for(let i=0;i<n;i++){
    tick(s);const player=s.players[p];
    if(!player.deck.length){player.fatigue++;damage(s,[{playerId:p}],player.fatigue);continue;}
    const o=s.instances[player.deck[0]];
    if(player.hand.length>=10){move(s,o,'graveyard','hand_overflow');continue;}
    move(s,o,'hand','draw');if(!setup)emit(s,'card_drawn',{player:{playerId:p},card:ref(o),cardSnapshot:snapshot(s,o)});
  }
}
function damage(s,targets,amount){
  const pending=targets.map(r=>({r,o:getObject(s,r)})).filter(x=>x.o);
  for(const {r,o}of pending){
    if(amount===0)continue;
    if(o.playerId){o.health-=amount;emit(s,'damage_applied',{target:r,amount,damageAmount:amount});continue;}
    if(o.zone!=='battlefield'||!type(s,o).components.damageable)continue;
    const absorbed=Math.min(o.armor||0,amount);o.armor-=absorbed;const applied=amount-absorbed;
    if(type(s,o).components.damageable.sink==='power')removeTokens(s,o,type(s,o).components.power_meter.markerId,applied);
    else o.markedDamage+=applied;
    if(applied)emit(s,'damage_applied',{target:r,amount:applied,damageAmount:applied,absorbed});
  }
}
function removeTokens(s,o,id,n){
  const chosen=o.effectTokens.filter(t=>t.definitionId===id).slice(0,n);
  o.effectTokens=o.effectTokens.filter(t=>!chosen.includes(t));
  for(const token of chosen)emit(s,'effect_token_removed',{host:ref(o),definitionId:id,tokenSnapshot:token});
  if(type(s,o).components.power_meter)o.power=power(s,o);
}
function addTokens(s,o,id,n,duration,ctx){
  const d=s.content.effectTokens[id];assert(d,'UNKNOWN_EFFECT_TOKEN');
  assert(o.zone==='battlefield'&&type(s,o).components.effect_tokens,'INVALID_TOKEN_HOST');
  assert((d.hostRequirements?.all||[]).every(c=>type(s,o).capabilities.includes(c)),'INVALID_TOKEN_HOST');
  assert(o.effectTokens.length+n<=64&&units(s).reduce((n,o)=>n+o.effectTokens.length,0)+n<=1024,'TECHNICAL_TOKENS');
  for(let i=0;i<n;i++){
    tick(s);const token={id:'t'+(++s.ids.token),definitionId:id,hostRef:ref(o),duration,turnId:s.turnId,source:ctx.source};
    o.effectTokens.push(token);emit(s,'effect_token_added',{host:ref(o),definitionId:id,tokenSnapshot:token});
  }
  if(type(s,o).components.power_meter)o.power=power(s,o);
}
function runEffects(s,effects,ctx) {
  for(const e of effects||[]){
    tick(s);
    const ev=n=>evaluate(s,n,ctx),amount=()=>num(s,e.amount??1,ctx);
    if(e.type==='let'){assert(!Object.hasOwn(ctx.locals,e.name),'DUPLICATE_LOCAL');ctx.locals[e.name]=structuredClone(ev(e.value));continue;}
    if(e.type==='if'){runEffects(s,ev(e.condition)?e.then:e.else,{...ctx,locals:{...ctx.locals}});continue;}
    if(e.type==='foreach'){const items=list(ev(e.items));assert(items.length<=128,'TECHNICAL_FOREACH');for(const item of items)runEffects(s,e.effects,{...ctx,locals:{...ctx.locals,[e.as]:item}});continue;}
    if(e.type==='draw'){const p=ev(e.player);if(p?.playerId)draw(s,p.playerId,amount());continue;}
    if(e.type==='gain_resource'){const p=ev(e.player);if(p?.playerId)gainResource(s,p.playerId,Object.fromEntries(Object.entries(e.resources).map(([id,n])=>[id,num(s,n,ctx)])));continue;}
    if(e.type==='exile_top'){const p=ev(e.player)?.playerId;if(p)for(let i=0,n=amount();i<n&&s.players[p].deck.length;i++)move(s,s.instances[s.players[p].deck[0]],'exile','exile');continue;}
    if(e.type==='create_token'){
      const p=ev(e.controller)?.playerId,n=amount();assert(n<=1000,'TECHNICAL_TOKENS');
      if(p)for(let i=0;i<n;i++){const template={cardId:e.tokenRef};if(!vacant(s,template,p))break;const o=newInstance(s,e.tokenRef,p,'void',true);move(s,o,'battlefield','create_token',p);}continue;
    }
    if(e.type==='create_delayed_trigger'){if(!s.combat)continue;assert(s.delayed.length<256,'TECHNICAL_TRIGGERS');s.delayed.push({...structuredClone(e),id:'delayed'+(++s.ids.modifier),scopeId:e.scopeId?ev(e.scopeId):s.combat?.combatId,context:structuredClone(ctx)});continue;}
    if(e.type==='create_continuous_effect'){assert(s.continuous.length<256,'TECHNICAL_CONTINUOUS');s.continuous.push({...e,id:'aura'+(++s.ids.modifier),context:structuredClone(ctx),turnId:s.turnId});continue;}
    const selectedSpec=e.target?.selected?ctx.targetSpecs?.find(t=>t.id===e.target.selected):undefined;
    const targets=list(ev(e.target)).filter(r=>exists(s,r)&&(!selectedSpec||query(s,selectedSpec,ctx).some(candidate=>same(candidate,r))));
    if(e.type==='damage'){damage(s,targets,amount());continue;}
    if(e.type==='destroy'){moveBatch(s,targets.map(r=>getObject(s,r)).filter(o=>o.zone==='battlefield'),'graveyard','destroy');continue;}
    for(const r of targets){
      const o=getObject(s,r);if(!o)continue;
      const permanent=o.zone==='battlefield',t=type(s,o);
      if(e.type==='heal'){
        const n=amount();let actual=0;
        if(o.playerId){actual=Math.max(0,Math.min(n,o.maxHealth-o.health));o.health+=actual;}
        else if(permanent&&t.components.health){actual=Math.min(n,o.markedDamage);o.markedDamage-=actual;}
        if(actual)emit(s,'healed',{target:r,amount:actual});
      }else if(e.type==='counter_spell'){
        if(o.kind!=='spell')continue;
        s.stack=s.stack.filter(x=>x.itemId!==o.itemId);
        const card=getObject(s,o.card);if(card)move(s,card,'graveyard','countered');
        emit(s,'spell_countered',{itemId:o.itemId});
      }else if(e.type==='return_to_battlefield'){
        const p=ev(e.controller)?.playerId||ctx.controller.playerId,host=e.attachmentHost?ev(e.attachmentHost):undefined;
        if(o.zone!=='graveyard'||o.isToken||t.play.resolution==='resolve_effects'||!vacant(s,o,p))continue;
        if(t.components.attachment&&!attachmentValid(s,{...o,controllerId:p},host))continue;
        move(s,o,'battlefield','return',p,host);
      }else if(permanent||o.playerId&&['grant_ability','suppress_ability'].includes(e.type)){
        const common={id:'m'+(++s.ids.modifier),target:r,source:ctx.source,duration:e.duration,turnId:s.turnId};
        if(e.type==='modify_stat')s.modifiers.push({...common,origin:common.id,operation:'add_stats',attack:e.stat==='attack'?num(s,e.amount,ctx,false):0,health:e.stat==='max_health'?num(s,e.amount,ctx,false):0});
        else if(e.type==='modify_keyword')s.modifiers.push({...common,origin:common.id,operation:e.operation==='remove'?'remove_keyword':'grant_keyword',keyword:e.keyword});
        else if(e.type==='grant_ability'){bindAbility(e.ability,t?.capabilities||['player','health','ability_host'],s.content);s.grants.push({...common,ability:e.ability});}
        else if(e.type==='suppress_ability')s.suppressions.push({...common,definitionId:e.definitionId});
        else if(e.type==='apply_effect_token')addTokens(s,o,e.definitionId,amount(),e.duration,ctx);
        else if(e.type==='remove_effect_token')removeTokens(s,o,e.definitionId,amount());
        else if(e.type==='gain_armor'&&t.components.armor)o.armor+=amount();
        else if(e.type==='lose_armor'&&t.components.armor)o.armor=Math.max(0,o.armor-amount());
        else if(!['gain_armor','lose_armor'].includes(e.type))throw new IllegalCommand('UNKNOWN_EFFECT',e.type);
      }
    }
  }
}
function gainResource(s,p,resources){
  const enabled=s.config.economy.mode==='deck_sources'?s.config.economy.enabledResourceIds:[s.config.economy.resourceId];
  for(const [id,n]of Object.entries(resources)as any){assert(enabled.includes(id),'UNAVAILABLE_RESOURCE');assert(Number.isInteger(n)&&n>=0,'BAD_RESOURCE_AMOUNT');s.players[p].pool[id]=(s.players[p].pool[id]||0)+n;}
  emit(s,'resource_gained',{player:{playerId:p},resources});
}
export function paymentPlan(pool,cost,requested=undefined){
  const available={...pool},spent={};
  for(const [id,n]of Object.entries(cost.resources||{})as any){assert((available[id]||0)>=n,'INSUFFICIENT_RESOURCE',id);available[id]=(available[id]||0)-n;spent[id]=n;}
  let generic=cost.generic||0;
  if(requested){
    const all=requested.resources||requested.actualSpent||requested;
    let total=0;
    for(const [id,n]of Object.entries(all)as any){assert(Object.hasOwn(pool,id)&&Number.isInteger(n)&&n>=0&&(pool[id]||0)>=n&&n>=(spent[id]||0),'INVALID_PAYMENT');total+=n-(spent[id]||0);}
    assert(Object.keys(spent).every(id=>(all[id]||0)>=spent[id])&&total===generic,'INVALID_PAYMENT');
    return {...all};
  }
  for(const id of Object.keys(available).sort()){const n=Math.min(available[id],generic);if(n)spent[id]=(spent[id]||0)+n;generic-=n;}
  assert(generic===0,'INSUFFICIENT_RESOURCE','Недостаточно ресурса');return spent;
}
function spend(s,p,cost,requested) {
  const actualSpent=paymentPlan(s.players[p].pool,cost,requested);
  for(const [id,n]of Object.entries(actualSpent)as any)s.players[p].pool[id]-=n;
  emit(s,'resource_spent',{player:{playerId:p},actualSpent});return actualSpent;
}
function ready(s,o){return !o.tapped&&(type(s,o).components.exhaustion?.readyDelay==='none'||o.enteredTurn<s.turnId&&s.players[o.controllerId].turnsStarted>o.controllerTurnEntered);}
function payCosts(s,a,ctx,command) {
  const p=ctx.controller.playerId,source=getObject(s,ctx.source),view=effectiveView(s);
  const plan={resource:{resources:{},generic:0},life:0,tap:[],sacrifice:[],remove:[],add:[]},receipt={};
  for(const cost of a.costs||[]){
    tick(s);const id=cost.id||cost.type;
    if(cost.type==='spend_resource'){
      plan.resource.generic+=num(s,cost.generic||0,ctx);
      for(const [r,n]of Object.entries(cost.resources||{}))plan.resource.resources[r]=(plan.resource.resources[r]||0)+num(s,n,ctx);
    }else if(cost.type==='pay_life')plan.life+=num(s,cost.amount,ctx);
    else if(cost.type==='tap'){
      const r=evaluate(s,cost.object,ctx)||command.costChoices?.[id],o=getObject(s,r);
      assert(o?.controllerId===p&&o.zone==='battlefield'&&type(s,o).components.exhaustion&&ready(s,o),'CANNOT_TAP');
      assert(!plan.tap.some(x=>same(ref(x),r)),'DUPLICATE_COST');plan.tap.push(o);
    }else if(cost.type==='sacrifice'){
      const choices=cost.object?list(evaluate(s,cost.object,ctx)):list(command.costChoices?.[id]);
      const options=cost.object?choices:query(s,cost,ctx);
      assert(choices.length===(cost.count??1),'SACRIFICE_COUNT');
      for(const r of choices){
        const o=getObject(s,r);
        assert(o?.zone==='battlefield'&&o.controllerId===p&&options.some(x=>same(x,r))&&(!cost.excludeSource||!same(r,ctx.source)),'INVALID_SACRIFICE');
        assert(!plan.sacrifice.some(x=>same(ref(x),r)),'DUPLICATE_COST');plan.sacrifice.push(o);
      }
      receipt[id]=choices.map(r=>snapshot(s,getObject(s,r),view));
    }else if(['pay_effect_tokens','place_effect_tokens'].includes(cost.type)){
      const o=getObject(s,evaluate(s,cost.object,ctx)),n=num(s,cost.amount,ctx);
      assert(o?.controllerId===p&&o.zone==='battlefield'&&type(s,o).components.effect_tokens,'INVALID_TOKEN_HOST');
      if(cost.type==='pay_effect_tokens'){
        const reserved=plan.remove.filter(x=>x.o===o&&x.id===cost.definitionId).reduce((sum,x)=>sum+x.n,0);
        assert(o.effectTokens.filter(t=>t.definitionId===cost.definitionId).length>=n+reserved,'INSUFFICIENT_EFFECT_TOKENS');
        receipt[id]=structuredClone(o.effectTokens.filter(t=>t.definitionId===cost.definitionId).slice(reserved,reserved+n));
        plan.remove.push({o,id:cost.definitionId,n});
      }else{
        assert(same(ref(o),ctx.source)&&a.usageGroup&&source&&def(s,source).activationGroups?.[a.usageGroup],'TOKEN_COST_REQUIRES_USAGE_GROUP');
        assert(s.content.effectTokens[cost.definitionId]?.components?.length===0,'TOKEN_COST_REQUIRES_MARKER');
        plan.add.push({o,id:cost.definitionId,n});
      }
    }else throw new IllegalCommand('UNKNOWN_COST',cost.type);
  }
  assert(s.players[p].health>=plan.life,'INSUFFICIENT_LIFE');
  const actual=paymentPlan(s.players[p].pool,plan.resource,command.paymentPlan);
  let usageKey=a.abilityId,limit=a.usageLimit?.timesPerTurn;
  if(a.usageGroup){usageKey='group:'+a.usageGroup;limit=def(s,source)?.activationGroups?.[a.usageGroup]?.timesPerTurn;assert(limit,'UNKNOWN_USAGE_GROUP');}
  if(limit)assert((source?.usage?.[s.turnId+'/'+usageKey]||0)<limit,'USAGE_LIMIT');
  ctx.costReceipt=receipt;
  if(a.kind!=='resource_activated')pushStack(s,'ability',a,ctx);
  for(const o of plan.tap)o.tapped=true;
  spend(s,p,plan.resource,actual);s.players[p].health-=plan.life;
  if(plan.life)emit(s,'life_paid',{player:{playerId:p},amount:plan.life});
  for(const x of plan.remove)removeTokens(s,x.o,x.id,x.n);
  for(const x of plan.add)addTokens(s,x.o,x.id,x.n,{type:'permanent_on_instance'},ctx);
  if(limit)source.usage[s.turnId+'/'+usageKey]=(source.usage[s.turnId+'/'+usageKey]||0)+1;
  moveBatch(s,plan.sacrifice,'graveyard','sacrifice');
  return receipt;
}

function clearPools(s,boundary,p=undefined){
  for(const player of Object.values(s.players) as any[])if(!p||player.playerId===p)for(const id of Object.keys(player.pool))if(s.content.resources[id]?.poolPolicy===boundary)player.pool[id]=0;
}
function beginTurn(s,p){
  s.activePlayerId=p;s.turnId++;const player=s.players[p];player.turnsStarted++;player.sourcePlaysUsed=0;
  clearPools(s,'owner_turn_start',p);
  for(const o of units(s,p))if(type(s,o).components.exhaustion)o.tapped=false;
  const e=s.config.economy;
  if(e.mode==='automatic_growth'){player.capacity=Math.min(e.maxCapacity,player.capacity+e.growthPerTurn);player.pool[e.resourceId]=player.capacity;}
  s.phase='UPKEEP';s.declaration=null;s.priorityPlayerId=p;s.passes=0;s.resolutionsWithoutProgress=0;
  emit(s,'turn_start',{player:{playerId:p}});
}
function enterPhase(s,phase){
  s.phase=phase;s.declaration=null;s.priorityPlayerId=s.activePlayerId;s.passes=0;s.resolutionsWithoutProgress=0;
  if(phase==='DRAW'){if(!(s.turnId===1&&s.activePlayerId===s.firstPlayerId))draw(s,s.activePlayerId,1);}
  if(phase==='COMBAT_BEGIN')s.combat={combatId:'combat'+(++s.ids.combat),player:{playerId:s.activePlayerId},attackers:[],deaths:[]};
  if(phase==='DECLARE_ATTACKERS'){s.declaration={type:'attackers',playerId:s.activePlayerId};s.priorityPlayerId=null;}
  if(phase==='DECLARE_BLOCKERS'){s.declaration={type:'blockers',playerId:other(s.activePlayerId)};s.priorityPlayerId=null;}
  if(phase==='COMBAT_DAMAGE')combatDamage(s);
  if(phase==='COMBAT_END'){
    emit(s,'combat_ended',s.combat||{player:{playerId:s.activePlayerId},attackers:[],deaths:[]});
    s.delayed=s.delayed.filter(d=>d.scopeId!==s.combat?.combatId);s.combat=null;
  }
  if(phase==='END')emit(s,'turn_end',{player:{playerId:s.activePlayerId}});
  if(phase==='CLEANUP')cleanup(s);
}
function cleanup(s){
  for(const o of units(s)){
    if(type(s,o).components.health)o.markedDamage=0;
    const removed=o.effectTokens.filter(t=>t.duration?.type==='until_end_of_turn'&&t.turnId===s.turnId);
    o.effectTokens=o.effectTokens.filter(t=>!removed.includes(t));
    for(const token of removed)emit(s,'effect_token_removed',{host:ref(o),definitionId:token.definitionId,tokenSnapshot:token});
  }
  for(const k of ['modifiers','grants','suppressions','continuous'])s[k]=s[k].filter(m=>m.duration?.type!=='until_end_of_turn'||m.turnId!==s.turnId);
  checkpoint(s);flushTriggers(s);
  if(!s.result&&!s.stack.length&&!s.pendingDecision)beginTurn(s,other(s.activePlayerId));
}
function advance(s){
  clearPools(s,'step_end');
  if(s.phase==='CLEANUP'){cleanup(s);return;}
  let index=PHASES.indexOf(s.phase)+1;
  if(s.phase==='DECLARE_ATTACKERS'&&!s.combat?.attackers.length)index=PHASES.indexOf('COMBAT_END');
  enterPhase(s,PHASES[index]);
}
function combatDamage(s){
  const v=effectiveView(s),batch=[];
  for(const attack of s.combat?.attackers||[]){
    const a=getObject(s,attack.attacker),d=getObject(s,attack.defender);
    if(!a||a.zone!=='battlefield'||!d||d.instanceId&&d.zone!=='battlefield')continue;
    const b=getObject(s,attack.blocker);
    if(b?.zone==='battlefield'){batch.push({target:ref(b),amount:v[key(a)].attack,source:ref(a)});batch.push({target:ref(a),amount:v[key(b)].attack,source:ref(b)});}
    else if(!attack.wasBlocked)batch.push({target:attack.defender,amount:v[key(a)].attack,source:ref(a)});
  }
  // All values and participants are captured before the first damage operation.
  for(const hit of batch){s.frame={source:hit.source};damage(s,[hit.target],hit.amount);}
  s.frame=null;
}
function resolveTop(s){
  assert(++s.resolutionsWithoutProgress<=1000,'TECHNICAL_RESOLUTION_LOOP');
  const item=s.stack.pop();s.frame=item;
  const ctx=item.context,a=item.ability,o=item.card?getObject(s,item.card):undefined;
  const specs=targetSpecs(s,a,o),valid=validateTargets(s,specs,ctx.targets,ctx,true),deathStart=s.deaths.length;
  ctx.targets=valid;ctx.targetSpecs=specs;
  const fizzled=specs.length>0&&!Object.keys(valid).length;
  if(!fizzled){
    if(o){
      const t=type(s,o);
      if(t.play.resolution!=='resolve_effects'){
        if(vacant(s,o,item.controllerId)&&(t.play.resolution!=='attach'||attachmentValid(s,o,valid.attachmentHost)))move(s,o,'battlefield','cast',item.controllerId,valid.attachmentHost);
        else move(s,o,'graveyard','no_slot_or_host');
      }
    }
    runEffects(s,a.effects,ctx);
    if(o){
      for(const behavior of a.modules||[]){
        const targets=Object.fromEntries((behavior.targets||[]).map(t=>[t.id,ctx.targets[behavior.prefix+'/'+t.id]]));
        runEffects(s,behavior.effects,{...ctx,targets,targetSpecs:behavior.targets||[],params:behavior.params,locals:{}});
      }
    }
  }else emit(s,'spell_fizzled',{itemId:item.itemId,reason:'NO_LEGAL_TARGETS'});
  if(o&&o.zone==='stack')move(s,o,'graveyard',fizzled?'fizzled':'resolved');
  checkpoint(s);
  const summary={itemId:item.itemId,player:ctx.controller,deaths:structuredClone(s.deaths.slice(deathStart))};
  emit(s,'resolution_ended',summary);
  if(a.afterResolve&&!fizzled&&!s.result)s.pendingTriggers.push({ability:{...a.afterResolve,id:(a.id||'spell')+'/afterResolve'},context:{...ctx,event:summary,locals:{...ctx.locals}},eventOrder:s.ids.event,sourceOrder:0});
  s.frame=null;
  s.priorityPlayerId=s.activePlayerId;s.passes=0;
}
function speedAllowed(s,p,speed){return speed==='fast'||p===s.activePlayerId&&['MAIN_1','MAIN_2'].includes(s.phase)&&s.stack.length===0;}
export function createGame(config,content,seed=1){
  const normalized=normalizeConfig(config,content);
  const s={version:1,content,config:normalized,seed:seed>>>0||1,rngState:seed>>>0||1,revision:0,turnId:0,firstPlayerId:null,activePlayerId:null,priorityPlayerId:null,phase:'READY',passes:0,instances:{},players:{},stack:[],pendingTriggers:[],pendingDecision:null,declaration:null,combat:null,modifiers:[],continuous:[],grants:[],suppressions:[],delayed:[],events:[],deaths:[],commands:[],result:null,ids:{instance:0,event:0,stack:0,entry:0,token:0,modifier:0,decision:0,combat:0},resolutionsWithoutProgress:0,_ops:0};
  s.firstPlayerId=nextIndex(s,2)===0?'p1':'p2';
  const deckId=normalized.economy.mode==='deck_sources'?'duality:starter':'core:starter';
  for(const p of ['p1','p2']){
    s.players[p]={playerId:p,health:20,maxHealth:20,pool:{},capacity:normalized.economy.initialCapacity||0,turnsStarted:0,fatigue:0,sourcePlaysUsed:0,deck:[],hand:[],graveyard:[],exile:[]};
    const deck=validateDeck(config?.decks?.[p]||content.decks[deckId],content,normalized);
    s.players[p].deck=shuffle(s,deck.map(id=>newInstance(s,id,p,'deck').instanceId));
  }
  for(const p of ['p1','p2'])draw(s,p,4,true);
  beginTurn(s,s.firstPlayerId);checkpoint(s);flushTriggers(s);delete s._ops;
  return s;
}
function perform(s,c) {
  const p=c.actorId;assert(['p1','p2'].includes(p),'UNKNOWN_PLAYER');
  assert(!s.result,'GAME_OVER');
  if(c.type==='Concede'){s.result={type:'win',winner:other(p),reason:'concede'};s.pendingDecision=null;emit(s,'conceded',{player:{playerId:p}});return;}
  if(s.pendingDecision){
    const d=s.pendingDecision;assert(c.type==='SubmitChoice'&&p===d.playerId&&c.decisionId===d.decisionId,'PENDING_DECISION');
    const ctx=d.trigger.context;ctx.targets=validateTargets(s,d.specs,c.targets||c.choices,ctx);
    s.pendingDecision=null;pushStack(s,'trigger',d.trigger.ability,ctx);flushTriggers(s);return;
  }
  if(s.declaration){
    assert(p===s.declaration.playerId,'NOT_DECLARING_PLAYER');
    if(s.declaration.type==='attackers'){
      assert(c.type==='DeclareAttackers','DECLARE_ATTACKERS_REQUIRED');
      const choices=c.attackers||[],v=effectiveView(s),seen=new Set();
      for(const item of choices){
        const r=item.attacker||item.source||item,a=getObject(s,r),defender=item.defender||{playerId:other(p)},d=getObject(s,defender);
        assert(a?.controllerId===p&&a.zone==='battlefield'&&type(s,a).components.combat?.canAttack&&ready(s,a)&&v[key(a)].attack>0&&!v[key(a)].rules.includes('cannot_attack'),'CANNOT_ATTACK');
        assert(!seen.has(key(r)),'DUPLICATE_ATTACKER');seen.add(key(r));
        assert(d&&(defender.playerId===other(p)||d.controllerId===other(p)&&d.zone==='battlefield'&&type(s,d).components.combat?.canBeAttacked),'INVALID_DEFENDER');
      }
      s.combat.attackers=choices.map(item=>({attacker:item.attacker||item.source||item,defender:item.defender||{playerId:other(p)},wasBlocked:false}));
      for(const item of s.combat.attackers){
        const o=getObject(s,item.attacker);
        if(!v[key(o)].keywords.includes('vigilance'))o.tapped=true;
        const snap={...snapshot(s,o,v),tapped:o.tapped};
        emit(s,'creature_attacked',{attacker:item.attacker,attackerSnapshot:snap,defender:item.defender,controller:{playerId:p},combatId:s.combat.combatId});
      }
      emit(s,'attackers_declared',{player:{playerId:p},attackers:s.combat.attackers,combatId:s.combat.combatId});
    }else{
      assert(c.type==='DeclareBlockers','DECLARE_BLOCKERS_REQUIRED');
      const seenB=new Set(),seenA=new Set(),v=effectiveView(s);
      for(const pair of c.blockers||[]){
        const b=getObject(s,pair.blocker),attack=s.combat.attackers.find(a=>same(a.attacker,pair.attacker));
        assert(b?.controllerId===p&&b.zone==='battlefield'&&!b.tapped&&type(s,b).components.combat?.canBlock&&!v[key(b)].rules.includes('cannot_block'),'CANNOT_BLOCK');
        assert(attack&&getObject(s,attack.attacker)?.zone==='battlefield'&&!seenA.has(key(pair.attacker))&&!seenB.has(key(pair.blocker)),'INVALID_BLOCK_PAIR');
        const verdict=evaluateInteraction(s,'block',{attacker:pair.attacker,blocker:pair.blocker});assert(verdict.allowed,verdict.violations[0]);
        seenA.add(key(pair.attacker));seenB.add(key(pair.blocker));
      }
      for(const pair of c.blockers||[]){const a=s.combat.attackers.find(a=>same(a.attacker,pair.attacker));a.blocker=pair.blocker;a.wasBlocked=true;}
      emit(s,'blockers_declared',{player:{playerId:p},blockers:c.blockers||[]});
    }
    s.declaration=null;s.priorityPlayerId=s.activePlayerId;s.passes=0;checkpoint(s);flushTriggers(s);return;
  }
  assert(p===s.priorityPlayerId,'NOT_YOUR_PRIORITY','Сейчас приоритет у другого игрока');
  if(c.type==='PassPriority'){
    if(++s.passes===1)s.priorityPlayerId=other(p);
    else if(s.stack.length)resolveTop(s);
    else advance(s);
    checkpoint(s);flushTriggers(s);return;
  }
  if(c.type==='CastCard'||c.type==='PlayResourceCard'){
    const o=getObject(s,c.card||c.source);assert(o?.zone==='hand'&&o.ownerId===p,'CARD_NOT_IN_HAND');
    const d=def(s,o),t=type(s,o);
    assert(speedAllowed(s,p,t.play.timing),'WRONG_TIMING','Медленное действие: своя основная фаза и пустой стек');
    if(c.type==='PlayResourceCard'){
      assert(t.play.method==='source_deploy'&&s.config.economy.mode==='deck_sources','NOT_RESOURCE_CARD');
      assert(s.players[p].sourcePlaysUsed<s.config.economy.sourcePlaysPerTurn,'SOURCE_LIMIT');
      assert(vacant(s,o,p),'BOARD_FULL');s.players[p].sourcePlaysUsed++;move(s,o,'battlefield','source_deploy',p);
    }else{
      assert(t.play.method==='cast','USE_PLAY_RESOURCE');assert(vacant(s,o,p),'BOARD_FULL');
      const program=castProgram(s,o),ctx=baseContext(s,o),specs=targetSpecs(s,program,o);ctx.targets=validateTargets(s,specs,c.targets,ctx);
      const actual=paymentPlan(s.players[p].pool,d.cost||{},c.paymentPlan);
      ctx.costReceipt={resource:actual};spend(s,p,d.cost||{},actual);
      move(s,o,'stack','cast',p);ctx.source=ref(o);pushStack(s,'spell',program,ctx,ref(o));
    }
  }else if(c.type==='ActivateAbility'){
    const o=getObject(s,c.source);assert(o&&(o.controllerId||o.playerId)===p,'INVALID_ABILITY_SOURCE');
    const a=effectiveView(s)[key(o)]?.abilities.find(a=>a.abilityId===c.abilityId);
    assert(a&&['activated','resource_activated'].includes(a.kind),'UNKNOWN_ABILITY');
    assert(speedAllowed(s,p,a.speed||'fast'),'WRONG_TIMING');
    const ctx=baseContext(s,o,{params:a.params});ctx.targets=validateTargets(s,a.targets||[],c.targets,ctx);
    let production;
    if(a.kind==='resource_activated'){production=a.productionOptions.find(x=>x.id===(c.productionOptionId||a.productionOptions[0]?.id));assert(production,'INVALID_PRODUCTION');}
    payCosts(s,a,ctx,c);
    if(production){gainResource(s,p,production.resources);emit(s,'resource_activated',{source:c.source,abilityId:c.abilityId,productionOptionId:production.id});}
  }else throw new IllegalCommand('UNKNOWN_COMMAND',c.type);
  s.passes=0;s.resolutionsWithoutProgress=0;checkpoint(s);flushTriggers(s);
}
export function execute(state,command) {
  const s=structuredClone({...state,content:null,events:[],commands:[]});s.content=state.content;s.events=[...state.events];s.commands=[...state.commands];s._ops=0;
  try{
    perform(s,structuredClone(command));
    s.revision++;s.commands.push(structuredClone(command));delete s._ops;
    return {ok:true,state:s,events:s.events.slice(state.events.length)};
  }catch(error){
    const code=error.code||'TECHNICAL_ERROR',technical=code.startsWith('TECHNICAL')||code.startsWith('EXPRESSION')||!error.code;
    return {ok:false,state,error:{code,message:error.message,technical,command:structuredClone(command)},events:[]};
  }
}
export function getPendingDecision(s,p){
  const d=s.pendingDecision;if(!d||d.playerId!==p)return null;
  return {decisionId:d.decisionId,playerId:p,targets:d.specs.map(t=>({...t,options:query(s,t,d.trigger.context)}))};
}
export function getSelectionOptions(s,p,command) {
  if(s.pendingDecision)return getPendingDecision(s,p)?.targets||[];
  const o=getObject(s,command.card||command.source);if(!o)return [];
  const a=command.type==='ActivateAbility'?effectiveView(s)[key(o)]?.abilities.find(a=>a.abilityId===command.abilityId):castProgram(s,o);
  if(!a)return [];
  const ctx=baseContext(s,o,{params:a.params});
  return targetSpecs(s,a,command.type==='CastCard'?o:undefined).map(t=>({...t,options:query(s,t,ctx)}));
}
export function getLegalActions(s,p) {
  if(s.result)return [];
  const actions=[];
  if(s.pendingDecision){
    const d=getPendingDecision(s,p);return d?[{type:'SubmitChoice',actorId:p,decisionId:d.decisionId,targets:d.targets}]:[];
  }
  const v=effectiveView(s);
  if(s.declaration){
    if(p!==s.declaration.playerId)return [];
    if(s.declaration.type==='attackers'){
      const attackers=units(s,p).filter(o=>type(s,o).components.combat?.canAttack&&ready(s,o)&&v[key(o)].attack>0&&!v[key(o)].rules.includes('cannot_attack')).map(ref);
      const defenders=[{playerId:other(p)},...units(s,other(p)).filter(o=>type(s,o).components.combat?.canBeAttacked).map(ref)];
      return [{type:'DeclareAttackers',actorId:p,attackers,defenders}];
    }
    const pairs=[];
    for(const a of s.combat.attackers)if(getObject(s,a.attacker)?.zone==='battlefield')for(const b of units(s,p)){
      if(!b.tapped&&type(s,b).components.combat?.canBlock&&!v[key(b)].rules.includes('cannot_block')&&evaluateInteraction(s,'block',{attacker:a.attacker,blocker:ref(b)}).allowed)pairs.push({attacker:a.attacker,blocker:ref(b)});
    }
    return [{type:'DeclareBlockers',actorId:p,pairs}];
  }
  if(s.priorityPlayerId!==p)return [];
  actions.push({type:'PassPriority',actorId:p});
  for(const id of s.players[p].hand){
    const o=s.instances[id],d=def(s,o),t=type(s,o);
    if(!speedAllowed(s,p,t.play.timing)||!vacant(s,o,p))continue;
    if(t.play.method==='source_deploy'){
      if(s.config.economy.mode==='deck_sources'&&s.players[p].sourcePlaysUsed<s.config.economy.sourcePlaysPerTurn)actions.push({type:'PlayResourceCard',actorId:p,card:ref(o)});
    }else{
      const template={type:'CastCard',actorId:p,card:ref(o),targets:getSelectionOptions(s,p,{type:'CastCard',card:ref(o)})};
      if(template.targets.some(t=>t.options.length<t.count))continue;
      try{template.paymentCost=structuredClone(d.cost||{});template.paymentPlan=paymentPlan(s.players[p].pool,template.paymentCost);actions.push(template);}catch{}
    }
  }
  for(const o of [...units(s,p),s.players[p]]){
    for(const a of v[key(o)]?.abilities||[]){
      if(!['activated','resource_activated'].includes(a.kind)||!speedAllowed(s,p,a.speed||'fast'))continue;
      if((a.costs||[]).some(c=>c.type==='tap'&&c.object?.context==='source'&&!ready(s,o)))continue;
      const ctx=baseContext(s,o,{params:a.params}),targets=getSelectionOptions(s,p,{type:'ActivateAbility',source:ref(o),abilityId:a.abilityId});
      if(targets.some(t=>t.options.length<t.count))continue;
      const costChoices=[];
      for(const cost of a.costs||[])if(cost.type==='sacrifice'&&!cost.object)costChoices.push({id:cost.id||cost.type,count:cost.count??1,options:query(s,cost,ctx).filter(r=>!cost.excludeSource||!same(r,ref(o)))});
      const template={type:'ActivateAbility',actorId:p,source:ref(o),abilityId:a.abilityId,targets,costChoices,productionOptions:a.productionOptions};
      try{
        const cost={generic:0,resources:{}};
        for(const part of a.costs||[])if(part.type==='spend_resource'){
          cost.generic+=num(s,part.generic||0,ctx);
          for(const [id,n]of Object.entries(part.resources||{}))cost.resources[id]=(cost.resources[id]||0)+num(s,n,ctx);
        }
        if(cost.generic||Object.values(cost.resources).some(Boolean)){template.paymentCost=cost;template.paymentPlan=paymentPlan(s.players[p].pool,cost);}
      }catch{continue;}
      const candidate=materialize(template);
      if(a.kind==='resource_activated'&&(a.costs||[]).every(c=>c.type==='tap'&&c.object?.context==='source')||execute(s,candidate).ok)actions.push(template);
    }
  }
  return actions;
}
export function materialize(t) {
  if(t.type==='DeclareAttackers')return {type:t.type,actorId:t.actorId,attackers:[]};
  if(t.type==='DeclareBlockers')return {type:t.type,actorId:t.actorId,blockers:[]};
  const c={...t};delete c.paymentCost;
  if(Array.isArray(t.targets))c.targets=Object.fromEntries(t.targets.map(x=>[x.id,x.count===1?x.options[0]:x.options.slice(0,x.count)]));
  if(Array.isArray(t.costChoices))c.costChoices=Object.fromEntries(t.costChoices.map(x=>[x.id,x.options.slice(0,x.count)]));
  if(t.productionOptions){c.productionOptionId=t.productionOptions[0]?.id;delete c.productionOptions;}
  return c;
}
export function getPlayerView(s,p) {
  const v=effectiveView(s),players={};
  for(const id of ['p1','p2']){
    const x=s.players[id];
    players[id]={playerId:id,health:x.health,maxHealth:x.maxHealth,pool:{...x.pool},capacity:x.capacity,fatigue:x.fatigue,sourcePlaysUsed:x.sourcePlaysUsed,deckCount:x.deck.length,handCount:x.hand.length,hand:id===p?x.hand.map(i=>({ ...v[key(s.instances[i])],definition:def(s,s.instances[i])})):[],graveyard:x.graveyard.map(i=>({...v[key(s.instances[i])],definition:def(s,s.instances[i])})),exile:x.exile.map(i=>({...v[key(s.instances[i])],definition:def(s,s.instances[i])}))};
  }
  return {revision:s.revision,playerId:p,turnId:s.turnId,phase:s.phase,activePlayerId:s.activePlayerId,priorityPlayerId:s.priorityPlayerId,players,board:units(s).map(o=>({...v[key(o)],power:power(s,o),definition:def(s,o)})),stack:s.stack.map(i=>({itemId:i.itemId,kind:i.kind,controllerId:i.controllerId,source:i.source,name:i.ability.name||i.ability.id,ability:i.ability,targets:i.context.targets})),combat:s.combat?structuredClone(s.combat):null,config:s.config,result:s.result,events:s.events.filter(e=>!['card_drawn','zone_changed'].includes(e.type)).slice(-100).map(e=>structuredClone(e))};
}
export function getDecisionContext(s,p) {
  return {playerId:p,decisionId:s.pendingDecision?.decisionId||'r'+s.revision,revision:s.revision,view:getPlayerView(s,p),actions:getLegalActions(s,p),policyVersion:'heuristic-v1',policySeed:1,budget:256};
}
export function getDebugView(s){return structuredClone(s);}
export function saveGame(s){return JSON.stringify({format:'magiccards-save',version:1,state:s});}
export function loadGame(text,compiledContent=undefined) {
  const data=typeof text==='string'?JSON.parse(text):text;
  assert(data.format==='magiccards-save'&&data.version===1,'INVALID_SAVE');
  const s=data.state;assert(s&&s.content?.rulesetVersion==='0.12'&&s.content?.schemaVersion===3,'VERSION_MISMATCH');
  s.content=verifySnapshot(s.content);assertInvariants(s);return s;
}
function verifySnapshot(snapshot){
  const raw={schemaVersion:snapshot.schemaVersion,rulesetId:snapshot.rulesetId,rulesetVersion:snapshot.rulesetVersion,globalRuleIds:snapshot.globalRuleIds||[]};
  for(const k of ['cards','tokens','abilities','effectTokens','resources','rules','decks','cardTypes','presets'])raw[k]=Object.values(snapshot[k]||{});
  return validateContent(raw);
}
export function assertInvariants(s){
  normalizeConfig(s.config,s.content);
  for(const p of Object.values(s.players)as any[]){
    assert(Number.isInteger(p.health)&&p.health<=p.maxHealth&&p.maxHealth===20,'INVALID_PLAYER_HEALTH');
    const enabled=s.config.economy.mode==='deck_sources'?s.config.economy.enabledResourceIds:[s.config.economy.resourceId];
    for(const [id,n]of Object.entries(p.pool)as any)assert(enabled.includes(id)&&Number.isInteger(n)&&n>=0,'INVALID_POOL');
  }
  assert(['p1','p2'].includes(s.activePlayerId),'INVALID_STATE');
  const listed=new Set();
  for(const p of Object.values(s.players)as any[])for(const zone of ['deck','hand','graveyard','exile']){
    assert(Array.isArray(p[zone]),'INVALID_ZONE');
    for(const id of p[zone]){assert(!listed.has(id),'DUPLICATE_INSTANCE');listed.add(id);assert(s.instances[id]?.zone===zone&&s.instances[id]?.ownerId===p.playerId,'ZONE_MISMATCH');}
  }
  for(const o of Object.values(s.instances)as any[]){
    assert(def(s,o)&&Number.isInteger(o.generation)&&o.generation>0,'INVALID_INSTANCE');
    if(!['battlefield','stack'].includes(o.zone))assert(listed.has(o.instanceId),'ORPHAN_INSTANCE');
    if(o.zone==='stack')assert(s.stack.some(x=>x.card&&same(x.card,ref(o))),'ORPHAN_STACK_CARD');
  }
  for(const p of ['p1','p2'])assert(units(s,p).filter(o=>type(s,o).components.battlefield_slot).length<=s.config.limits.maxCreaturesPerPlayer,'BOARD_FULL');
  return true;
}
export function hashState(s) {
  const text=JSON.stringify({...s,content:undefined,commands:undefined,_ops:undefined});let h=2166136261;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619)>>>0;return h.toString(16).padStart(8,'0');
}
export function makeReplay(s){return {format:'magiccards-replay',version:1,config:s.config,content:s.content,seed:s.seed,fixture:s.fixture,commands:s.commands,finalHash:hashState(s)};}
export function replay(record){
  assert(record.format==='magiccards-replay'&&record.version===1,'INVALID_REPLAY');
  const verified=verifySnapshot(record.content);
  let s=record.fixture?loadFixture(record.fixture,verified):createGame(record.config,verified,record.seed);
  for(const [i,c]of record.commands.entries()){const r=execute(s,c);assert(r.ok,'REPLAY_COMMAND_ERROR','Команда '+i+': '+r.error?.message);s=r.state;}
  assert(!record.finalHash||hashState(s)===record.finalHash,'REPLAY_HASH_MISMATCH');return s;
}
/** Fixture adapter: explicit stable setup; never used by ordinary match actions. */
export function loadFixture(f,content){
  let s=createGame(f.config||{presetId:f.presetId||'automatic_energy_v1'},content,f.seed||1);
  s.instances={};for(const p of Object.values(s.players)as any[]){p.deck=[];p.hand=[];p.graveyard=[];p.exile=[];p.pool={};p.turnsStarted=3;}
  s.turnId=f.turnId||5;s.phase=f.phase||'MAIN_1';s.activePlayerId=f.activePlayerId||'p1';s.priorityPlayerId=f.priorityPlayerId||s.activePlayerId;s.firstPlayerId='p1';s.events=[];s.stack=[];s.pendingTriggers=[];s.pendingDecision=null;s.declaration=null;s.combat=null;s.deaths=[];s.commands=[];s._ops=0;
  for(const p of ['p1','p2']){
    Object.assign(s.players[p],structuredClone(f.players?.[p]||{}));
    for(const zone of ['deck','hand','graveyard','exile','battlefield']){
      const values=f[zonesAlias(zone)]?.[p]||f[zone]?.[p]||[];
      for(const entry of values){const v=typeof entry==='string'?{cardId:entry}:entry,o=newInstance(s,v.cardId,p,zone,!!v.isToken);Object.assign(o,v,{zone});if(v.instanceId){delete s.instances['c'+s.ids.instance];s.instances[v.instanceId]=o;}
        o.enteredTurn=v.enteredTurn??1;o.controllerTurnEntered=v.controllerTurnEntered??1;o.enterOrder=++s.ids.entry;
        if(zone!=='battlefield')s.players[p][zone].push(o.instanceId);
        if(zone==='battlefield'&&type(s,o).components.power_meter)for(let i=0;i<(v.power??def(s,o).power);i++)o.effectTokens.push({id:'t'+(++s.ids.token),definitionId:type(s,o).components.power_meter.markerId,hostRef:ref(o),duration:{type:'permanent_on_instance'}});
      }
    }
  }
  if(f.combat)s.combat=structuredClone(f.combat);
  if(['DECLARE_ATTACKERS','DECLARE_BLOCKERS'].includes(s.phase))s.declaration={type:s.phase==='DECLARE_ATTACKERS'?'attackers':'blockers',playerId:s.phase==='DECLARE_ATTACKERS'?s.activePlayerId:other(s.activePlayerId)};
  if(!f.allowUnstable){const before=units(s).length;checkpoint(s);assert(units(s).length===before&&!s.result,'UNSTABLE_FIXTURE');}
  s.fixture=structuredClone(f);s.events=[];delete s._ops;assertInvariants(s);return s;
}
function zonesAlias(zone){return zone==='battlefield'?'board':zone;}
