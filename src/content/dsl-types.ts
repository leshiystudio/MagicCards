/** Small, closed type system for JSON programs; independent from TS erasure. */
const refType=(caps=[],extra={})=>({kind:'ref',caps,...extra});
const scalar=kind=>({kind});
const creature=()=>refType(['permanent','health','attack','damageable','ability_host','effect_token_host','combat_body','exhaustible']);
const player=()=>refType(['player','health','damageable','ability_host']);
const collection=item=>({kind:'collection',item});
export function validateProgramTypes(behavior,hostCaps,content,parameters,fail,path){
  const bad=message=>fail(path,message);
  const require=(t,kind,label)=>{if(t.kind!==kind||t.optional)bad(label+': ожидался '+kind+', получен '+t.kind+(t.optional?'?':''));};
  const cap=(t,name,label)=>{if(t.kind==='collection')t=t.item;if(t.kind!=='ref'&&t.kind!=='snapshot'||t.optional||!t.caps?.includes(name))bad(label+': требуется '+name);};
  const ctx={source:refType(hostCaps),controller:player(),opponent:player(),sourceSnapshot:{kind:'snapshot',caps:hostCaps},attached_to:refType(['permanent','ability_host'],{optional:true}),locals:{},targets:{},params:parameters||{},costs:{},eventType:behavior.kind==='triggered'?behavior.trigger:null};
  const selector=(q,c)=>{
    const name=q.selector;let t;
    if(name==='self')t=c.source;
    else if(name==='attached_host')t=refType(['permanent','ability_host','health'],{optional:false});
    else if(name==='pending_spell')t=refType(['stack_item']);
    else if(['player','friendly_player','enemy_player'].includes(name))t=player();
    else if(name.includes('character'))t=refType(['health','damageable','ability_host']);
    else if(name==='enemy_damageable')t=refType(['damageable']);
    else if(name==='graveyard_creature_card')t=refType(['card','creature_card']);
    else if(name==='graveyard_card')t=refType(['card']);
    else if(name.includes('creature'))t=creature();
    else t=refType(['permanent','ability_host','effect_token_host']);
    if(q.filter)require(infer(q.filter,{...c,candidate:t}),'Boolean','Фильтр');
    return t;
  };
  const common=(a,b)=>a.kind===b.kind&&(!a.optional&&!b.optional);
  const property=(object,name,read)=>{
    const requirements={attack:'attack',health:'health',max_health:'health',maxHealth:'health',markedDamage:'health',armor:'armor',power:'power'};
    if(requirements[name])cap({...object,optional:false},requirements[name],'read_property '+name);
    else if(!['controller','owner','isToken'].includes(name))bad('Неизвестное свойство '+name);
    if(['controller','owner'].includes(name))return player();
    const t=scalar(name==='isToken'?'Boolean':'Integer');
    if(read!=='snapshot'&&object===ctx.source&&!hostCaps.includes('player'))t.optional=true;
    return t;
  };
  function infer(n,c){
    if(typeof n==='number')return scalar('Integer');
    if(typeof n==='boolean')return scalar('Boolean');
    if(!n||typeof n!=='object')bad('Ожидалось типизированное выражение');
    if(n.context){if(!c[n.context])bad('Недоступный контекст '+n.context);return c[n.context];}
    if(n.selected){if(!c.targets[n.selected])bad('Необъявленная цель '+n.selected);return c.targets[n.selected];}
    if(n.selector)return collection(selector(n,c));
    const value=x=>infer(x,c);
    switch(n.type){
      case 'literal':return infer(n.value,c);
      case 'local':case 'item':if(!c.locals[n.name])bad('Необъявленное локальное имя '+n.name);return c.locals[n.name];
      case 'read_param':if(!c.params[n.name])bad('Необъявленный параметр '+n.name);return scalar(c.params[n.name].type);
      case 'read_cost':if(!c.costs[n.costId])bad('Нет оплаченного объекта '+n.costId);return property(c.costs[n.costId],n.property,'snapshot');
      case 'read_event':{
        const f=n.field;if(!c.eventType)bad('read_event доступен только в событии');
        if(['player','controller','owner'].includes(f))return player();
        if(['creature','attacker','source','target'].includes(f))return creature();
        if(f==='defender')return refType(['damageable']);
        if(['creatureSnapshot','attackerSnapshot','permanentSnapshot','sourceSnapshot','targetSnapshot'].includes(f))return {kind:'snapshot',caps:creature().caps};
        if(['deaths','attackers','blockers'].includes(f))return collection({kind:'snapshot',caps:creature().caps});
        if(/\.(isToken)$/.test(f))return scalar('Boolean');
        if(/\.(controller|owner)$/.test(f))return player();
        if(/(^|\.)(amount|damageAmount|attack|health|maxHealth|max_health|armor|power|turnId)$/.test(f))return scalar('Integer');
        bad('Неизвестное поле события '+f);break;
      }
      case 'read_property':return property(value(n.object),n.property,n.read);
      case 'coalesce':{const t=value(n.value),fallback=value(n.fallback);if(t.kind!==fallback.kind||fallback.optional)bad('Несовместимый fallback');return {...t,optional:false};}
      case 'if_value':require(value(n.condition),'Boolean','Условие');{const a=value(n.then),b=value(n.else);if(!common(a,b))bad('Разные типы ветвей');return a;}
      case 'add':case 'subtract':case 'multiply':case 'min':case 'max':
        for(const x of n.items||[n.left,n.right])require(value(x),'Integer','Арифметика');return scalar('Integer');
      case 'abs':case 'negate':require(value(n.value),'Integer','Арифметика');return scalar('Integer');
      case 'equal':case 'not_equal':{
        const a=value(n.left),b=value(n.right);if(!common(a,b)||a.kind==='snapshot'||a.kind==='collection')bad('Несовместимые типы сравнения');return scalar('Boolean');
      }
      case 'less':case 'less_or_equal':case 'greater':case 'greater_or_equal':
        require(value(n.left),'Integer','Сравнение');require(value(n.right),'Integer','Сравнение');return scalar('Boolean');
      case 'and':case 'or':for(const item of n.items)require(value(item),'Boolean','Логика');return scalar('Boolean');
      case 'not':require(value(n.item??n.value),'Boolean','Логика');return scalar('Boolean');
      case 'count':{const t=value(n.items);require(t,'collection','count');return scalar('Integer');}
      case 'exists':value(n.items??n.value??n.object);return scalar('Boolean');
      case 'filter':case 'sum':{
        const items=value(n.items);require(items,'collection',n.type);
        const scoped={...c,locals:{...c.locals,[n.as]:items.item}},result=infer(n.type==='filter'?n.where:n.value,scoped);
        require(result,n.type==='filter'?'Boolean':'Integer',n.type);return n.type==='filter'?items:scalar('Integer');
      }
      case 'is_damaged':cap(value(n.object),'health','is_damaged');return scalar('Boolean');
      case 'read_effect_token_count':cap(value(n.object),'effect_token_host','read_effect_token_count');return scalar('Integer');
      case 'has_tag':case 'has_subtype':case 'has_keyword':case 'has_capability':value(n.object);return scalar('Boolean');
      case 'can_interact':case 'interaction_allowed':return scalar('Boolean');
      default:bad('Неизвестный тип выражения '+n.type);
    }
  }
  for(const t of behavior.targets||[]){const item=selector(t,ctx);ctx.targets[t.id]=t.count===1?item:collection(item);}
  for(const cost of behavior.costs||[]){
    if(cost.type==='sacrifice')ctx.costs[cost.id||cost.type]={kind:'snapshot',caps:cost.object?hostCaps:selector(cost,ctx).caps};
    if(cost.amount!==undefined)require(infer(cost.amount,ctx),'Integer','Цена');
    if(cost.type==='tap')cap(infer(cost.object,ctx),'exhaustible','tap');
    if(cost.generic!==undefined)require(infer(cost.generic,ctx),'Integer','generic');
    for(const n of Object.values(cost.resources||{}))require(infer(n,ctx),'Integer','resource');
  }
  if(behavior.condition)require(infer(behavior.condition,ctx),'Boolean','Условие триггера');
  function program(effects,c){
    for(const e of effects||[]){
      if(e.type==='let'){if(c.locals[e.name])bad('Повтор локального имени '+e.name);c.locals[e.name]=infer(e.value,c);continue;}
      if(e.type==='if'){
        require(infer(e.condition,c),'Boolean','if');
        const branch={...c,locals:{...c.locals}};
        if(e.condition.type==='exists'&&e.condition.object?.context){const k=e.condition.object.context;branch[k]={...branch[k],optional:false};}
        program(e.then,branch);program(e.else,{...c,locals:{...c.locals}});continue;
      }
      if(e.type==='foreach'){const items=infer(e.items,c);require(items,'collection','foreach');if(c.locals[e.as])bad('Повтор имени цикла');program(e.effects,{...c,locals:{...c.locals,[e.as]:items.item}});continue;}
      if(e.amount!==undefined)require(infer(e.amount,c),'Integer',e.type+' amount');
      if(e.player)cap(infer(e.player,c),'player',e.type+' player');
      if(e.controller)cap(infer(e.controller,c),'player',e.type+' controller');
      if(e.target){
        const t=infer(e.target,c),caps={damage:'damageable',heal:'health',destroy:'permanent',modify_stat:e.stat==='attack'?'attack':'health',modify_keyword:'ability_host',grant_ability:'ability_host',suppress_ability:'ability_host',counter_spell:'stack_item',apply_effect_token:'effect_token_host',remove_effect_token:'effect_token_host',return_to_battlefield:'card',gain_armor:'armor',lose_armor:'armor'};
        if(caps[e.type])cap(t,caps[e.type],e.type);
      }
      if(e.resources)for(const n of Object.values(e.resources))require(infer(n,c),'Integer','Ресурс');
      if(e.type==='create_delayed_trigger')program(e.effects,{...c,eventType:e.event?.type||e.event,locals:{...c.locals}});
    }
  }
  program(behavior.effects,ctx);
  if(behavior.afterResolve){const after={...ctx,eventType:'resolution_ended',locals:{...ctx.locals},targets:{...ctx.targets}};for(const t of behavior.afterResolve.targets||[])after.targets[t.id]=selector(t,after);program(behavior.afterResolve.effects,after);}
}
