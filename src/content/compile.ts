import {validateProgramTypes} from './dsl-types.ts';
/** Content is untrusted data: compile before a match and never execute user code. */
export class ContentError extends Error {
  path: string; constructor(path: string, message: string) { super(path + ': ' + message); this.path=path; }
}
export const COMPONENTS = ['abilities','effect_tokens','exhaustion','health','attack','combat','damageable','armor','battlefield_slot','attachment_host','attachment','power_meter'];
export const EFFECTS = ['damage','heal','draw','gain_resource','create_token','apply_effect_token','remove_effect_token','destroy','modify_stat','create_delayed_trigger','modify_keyword','create_continuous_effect','grant_ability','suppress_ability','counter_spell','return_to_battlefield','exile_top','gain_armor','lose_armor','let','if','foreach'];
export const EXPRESSIONS = ['literal','read_property','read_event','read_cost','read_param','local','item','count','exists','filter','sum','if_value','coalesce','add','subtract','multiply','min','max','abs','negate','equal','not_equal','less','less_or_equal','greater','greater_or_equal','and','or','not','is_damaged','has_subtype','has_tag','has_keyword','has_capability','read_effect_token_count','can_interact','interaction_allowed'];
export const SELECTORS = ['self','friendly_player','enemy_player','player','friendly_creature','enemy_creature','friendly_character','enemy_character','character','all_enemy_creatures','all_friendly_creatures','other_friendly_creatures','all_creatures','pending_spell','friendly_permanent','enemy_permanent','all_permanents','enemy_damageable','graveyard_card','graveyard_creature_card','attached_host'];
export const EVENTS = ['on_enter','on_death','zone_changed','permanent_entered','permanent_left','creature_entered','creature_died','card_drawn','creature_attacked','attackers_declared','turn_start','turn_end','damage_applied','effect_token_added','effect_token_removed','resource_entered','resource_left','resource_gained','resource_spent','resource_activated','combat_ended','resolution_ended'];
const fail = (p,m) => { throw new ContentError(p,m); };
export const integer = (v,p,min=-2147483648,max=2147483647) => {
  if (!Number.isInteger(v) || v<min || v>max) fail(p,'Ожидается целое от '+min+' до '+max);
  return v;
};
const index = (items,p) => {
  const result = Object.create(null);
  for (const [i,d] of (items||[]).entries()) {
    if (!d || typeof d.id!=='string' || !/^[a-z][a-z0-9_-]*:[a-z0-9_-]+$/.test(d.id)) fail(p+'.'+i,'Некорректный id');
    if (result[d.id]) fail(p+'.'+i,'Повтор id '+d.id);
    result[d.id]=structuredClone(d);
  }
  return result;
};
export function compileCardTypes(definitions) {
  const defs=index(definitions,'cardTypes'), out=Object.create(null);
  const visit=(id,chain=[])=>{
    if(chain.includes(id)||chain.length>4) fail(id,'Цикл или глубина наследования > 4');
    if(out[id])return out[id];
    const d=defs[id];if(!d)fail(id,'Неизвестный тип');
    const parent=d.extends?visit(d.extends,[...chain,id]):{};
    const t={...parent,...d,abstract:d.abstract===true,components:{...parent.components,...d.components},categories:d.categories??parent.categories??[]};
    for(const name of d.removeComponents||[]) delete t.components[name];
    for(const name of Object.keys(t.components))if(!COMPONENTS.includes(name))fail(id+'.components.'+name,'Неизвестный компонент');
    const c=t.components,p=t.play;
    if(!p||!['cast','source_deploy'].includes(p.method)||!['slow','fast'].includes(p.timing)||!['enter_battlefield','attach','resolve_effects'].includes(p.resolution))fail(id+'.play','Некорректный маршрут');
    const perm=p.resolution!=='resolve_effects';
    const require=(name)=>{if(!c[name])fail(id+'.components','Требуется '+name);};
    if(!perm&&Object.keys(c).some(k=>k!=='abilities'))fail(id,'Компонент требует permanent');
    if(p.method==='source_deploy'&&p.resolution!=='enter_battlefield')fail(id,'Источник должен входить на поле');
    if(c.combat?.canAttack||c.combat?.canBlock)for(const n of ['health','attack','damageable','exhaustion','battlefield_slot'])require(n);
    if(c.combat?.canBeAttacked)require('damageable');
    if(c.damageable){if(!['health','power'].includes(c.damageable.sink))fail(id,'Неизвестный sink');require(c.damageable.sink==='power'?'power_meter':'health');}
    if(c.armor)require('damageable');
    if(c.power_meter)require('effect_tokens');
    if(c.attachment&&p.resolution!=='attach'||p.resolution==='attach'&&!c.attachment)fail(id,'Несогласованное прикрепление');
    if(t.categories.includes('categories:creature'))for(const n of ['health','attack','battlefield_slot'])require(n);
    if(c.exhaustion&&!['none','controller_turn_start'].includes(c.exhaustion.readyDelay))fail(id,'Некорректная готовность');
    t.capabilities=[...(perm?['permanent']:['one_shot']),...Object.keys(c)];
    const aliases={abilities:'ability_host',effect_tokens:'effect_token_host',exhaustion:'exhaustible',power_meter:'power',battlefield_slot:'unit_slot'};
    for(const [k,v]of Object.entries(aliases))if(c[k])t.capabilities.push(v);
    if(c.combat?.canAttack||c.combat?.canBlock)t.capabilities.push('combat_body');
    if(c.combat?.canAttack)t.capabilities.push('combat_attacker');
    if(c.combat?.canBlock)t.capabilities.push('combat_blocker');
    if(c.combat?.canBeAttacked)t.capabilities.push('attack_target');
    out[id]=t;return t;
  };
  for(const id of Object.keys(defs))visit(id);return out;
}
export function bindAbility(binding,capabilities,content,zone='battlefield') {
  const d=binding.ref?content.abilities[binding.ref]:{id:binding.id,behaviors:[binding],parameters:{},stacking:'per_source'};
  if(!d)fail(binding.ref,'Неизвестная способность');
  if((d.hostRequirements?.all||[]).some(c=>!capabilities.includes(c)))fail(d.id,'Несовместимый носитель');
  const params={};
  for(const [name,spec] of Object.entries(d.parameters||{})) {
    const v=binding.params?.[name]??spec.default;
    if(spec.type==='Integer')integer(v,d.id+'.params.'+name,spec.min??-2147483648,spec.max??2147483647);
    else if(spec.type==='Boolean'&&typeof v!=='boolean')fail(d.id,'Ожидается Boolean');
    params[name]=v;
  }
  for(const name of Object.keys(binding.params||{}))if(!(name in (d.parameters||{})))fail(d.id,'Неизвестный параметр '+name);
  return {...d,params,active:!d.activeZones||d.activeZones.includes(zone)};
}
function inspectAST(node,path,content,depth=0,budget={n:0}) {
  if(node===null||node===undefined)return;
  if(Array.isArray(node)){node.forEach((n,i)=>inspectAST(n,path+'.'+i,content,depth,budget));return;}
  const semantic=typeof node==='number'||typeof node==='boolean'||typeof node==='object'&&(node.context||node.selected||node.selector||node.kind||node.operation||node.type&&!['until_end_of_turn','permanent_on_instance','until_source_leaves'].includes(node.type));
  if(semantic){depth++;budget.n++;}
  if(depth>16||budget.n>(budget.max??256))fail(path,'Предел AST: 256 узлов / глубина 16');
  if(typeof node==='number'){integer(node,path);return;}
  if(typeof node!=='object')return;
  const allowed=[...EFFECTS,...EXPRESSIONS,'spend_resource','pay_life','tap','sacrifice','pay_effect_tokens','place_effect_tokens','until_end_of_turn','permanent_on_instance','until_source_leaves'];
  if(node.kind==='ability'&&node.ref&&!content.abilities[node.ref])fail(path,'Неизвестная способность');
  if(node.type&&!allowed.includes(node.type))fail(path+'.type','Неизвестная операция '+node.type);
  if(node.selector&&!SELECTORS.includes(node.selector))fail(path+'.selector','Неизвестный селектор');
  if(node.trigger&&!EVENTS.includes(node.trigger))fail(path+'.trigger','Неизвестное событие');
  if(node.duration&&(!node.duration.type||!['until_end_of_turn','permanent_on_instance','until_source_leaves'].includes(node.duration.type)))fail(path+'.duration','Требуется объект DurationSpec');
  if(node.type==='create_continuous_effect'&&node.duration?.type!=='until_end_of_turn')fail(path,'Независимая аура только до конца хода');
  if(typeof node.amount==='number'&&!['modify_stat','literal'].includes(node.type)&&node.amount<0)fail(path+'.amount','Количество не может быть отрицательным');
  if(node.type==='is_damaged'&&!node.object)fail(path,'Обязательно object');
  if(node.type==='draw'&&node.player?.selected){
    // Exact target-family validation is performed in validateBehavior.
  }
  if(node.tokenRef&&!content.tokens[node.tokenRef])fail(path,'Неизвестная фишка '+node.tokenRef);
  if(node.definitionId&&!content.effectTokens[node.definitionId]&&!content.abilities[node.definitionId])fail(path,'Неизвестное определение');
  for(const [k,v]of Object.entries(node))if(!['text','name','parameters','hostRequirements'].includes(k))inspectAST(v,path+'.'+k,content,depth,budget);
}
function validateBehavior(b,p,content,host,parameters={},rootProgram=false) {
  if(!['triggered','activated','resource_activated','continuous','on_resolve','interaction_rule'].includes(b.kind))fail(p,'Неизвестный kind');
  if(['activated','resource_activated'].includes(b.kind)&&b.kind!=='resource_activated'&&!['fast','slow'].includes(b.speed))fail(p,'Нужна скорость');
  if(b.kind==='resource_activated'){
    if(!b.productionOptions?.length||b.targets?.length||b.effects)fail(p,'Производство задаётся productionOptions без целей/effects');
    if((b.costs||[]).some(cost=>!['tap','spend_resource'].includes(cost.type)))fail(p,'Немедленное производство допускает только tap и spend_resource');
    const ids=new Set();
    for(const option of b.productionOptions){
      if(!option.id||ids.has(option.id))fail(p,'productionOptionId должен быть уникальным');ids.add(option.id);
      if(!option.resources||!Object.values(option.resources).some(n=>n>0))fail(p,'Нужно положительное производство ресурса');
      validateResourceCost({resources:option.resources},content,p+'.productionOptions.'+option.id);
    }
  }
  if(b.kind==='on_resolve'&&(b.costs||b.afterResolve&&!rootProgram))fail(p,'on_resolve не содержит costs или локальный afterResolve');
  if(b.kind==='interaction_rule'&&(b.ref?!content.rules[b.ref]:!b.interaction||!b.require))fail(p,'Нужно существующее ref либо inline interaction/require');
  for(const t of b.targets||[])integer(t.count,p+'.targets.count',1,32);
  inspectAST(b,p,content);
  const declaredTargets=new Set();
  const collect=n=>{if(!n||typeof n!=='object')return;for(const t of n.targets||[])declaredTargets.add(t.id);for(const v of Object.values(n))if(typeof v==='object')Array.isArray(v)?v.forEach(collect):collect(v);};collect(b);
  const scan=(n)=>{
    if(!n||typeof n!=='object')return;
    if(n.selected&&!declaredTargets.has(n.selected))fail(p,'Необъявленная цель '+n.selected);
    if(n.type==='draw'&&n.player?.selected){
      const t=b.targets?.find(t=>t.id===n.player.selected);
      if(t&&!['player','friendly_player','enemy_player'].includes(t.selector))fail(p,'draw принимает только игрока');
    }
    if(n.type==='tap'&&n.object?.context==='source'&&!host.includes('exhaustible'))fail(p,'tap требует exhaustion');
    if(n.type==='create_continuous_effect'||b.kind==='continuous'){
      if(n.type==='read_property'&&n.read==='effective')fail(p,'Аура читает только BaseView');
    }
    Object.values(n).forEach(v=>Array.isArray(v)?v.forEach(scan):scan(v));
  };scan(b);
  if(b.kind!=='interaction_rule')validateProgramTypes(b,host,content,parameters,fail,p);
}
export function validateContent(raw) {
  if(raw.schemaVersion!==3||raw.rulesetId!=='prototype-stack-v1'||raw.rulesetVersion!=='0.12')fail('manifest','Несовместимая версия');
  const c={schemaVersion:3,rulesetId:raw.rulesetId,rulesetVersion:raw.rulesetVersion};
  for(const k of ['cards','tokens','abilities','effectTokens','resources','rules','decks'])c[k]=index(raw[k],k);
  c.globalRuleIds=structuredClone(raw.globalRuleIds||[]);for(const id of c.globalRuleIds)if(!c.rules[id])fail('globalRuleIds','Неизвестное правило '+id);
  const allIds=new Set();for(const kind of ['cards','tokens','abilities','effectTokens','resources','rules','decks'])for(const id of Object.keys(c[kind])){if(allIds.has(id))fail(id,'Конфликт id разных определений');allIds.add(id);}
  c.cardTypes=compileCardTypes(raw.cardTypes);
  c.presets=Object.fromEntries((raw.presets||[]).map(p=>[p.presetId,structuredClone(p)]));
  for(const r of Object.values(c.resources))if(!['step_end','owner_turn_start','persistent'].includes(r.poolPolicy))fail(r.id,'Некорректный poolPolicy');
  for(const d of Object.values(c.abilities)){
    if(!['unique','per_source'].includes(d.stacking)||!Array.isArray(d.behaviors)||d.behaviors.length>32)fail(d.id,'Некорректная библиотечная способность');
    d.behaviors.forEach((b,i)=>validateBehavior(b,d.id+'.behaviors.'+i,c,d.hostRequirements?.all||[],d.parameters||{}));
    inspectAST(d.behaviors,d.id,c,0,{n:0,max:4096});
  }
  for(const d of [...Object.values(c.cards),...Object.values(c.tokens)]){
    const fields=['id','name','typeId','cost','attack','health','armor','power','text','keywords','tags','subtypes','colors','abilities','effects','targets','attachTo','activationGroups','afterResolve'];
    for(const field of Object.keys(d))if(!fields.includes(field))fail(d.id+'.'+field,'Неизвестное поле карты');
    const knownKeywords=new Set(Object.values(c.abilities).map(a=>a.keywordId).filter(Boolean));for(const keyword of d.keywords||[])if(!knownKeywords.has(keyword))fail(d.id+'.keywords','Неизвестное свойство '+keyword);
    const t=c.cardTypes[d.typeId];if(!t||t.abstract)fail(d.id+'.typeId','Неизвестный или абстрактный тип');
    if(typeof d.name!=='string'||!d.name.trim()||d.name.length>120)fail(d.id+'.name','Нужно название длиной 1–120');
    for(const field of ['tags','keywords','subtypes'])if(d[field]&&(!Array.isArray(d[field])||d[field].some(x=>typeof x!=='string')||new Set(d[field]).size!==d[field].length))fail(d.id+'.'+field,'Нужен список уникальных строк');
    for(const [comp,field]of [['health','health'],['attack','attack'],['armor','armor'],['power_meter','power']]) {
      if(t.components[comp])integer(d[field]??(field==='armor'?0:undefined),d.id+'.'+field,0);
      else if(d[field]!==undefined)fail(d.id+'.'+field,'Тип не поддерживает поле');
    }
    if(t.play.method==='cast'&&!c.tokens[d.id])validateResourceCost(d.cost||{},c,d.id+'.cost');
    if(t.play.method==='source_deploy'&&d.cost)fail(d.id,'У источника нет cast-цены');
    if(t.play.resolution==='attach'&&!d.attachTo)fail(d.id,'Нужен attachTo');
    if(d.attachTo&&d.targets?.some(t=>t.id==='attachmentHost'))fail(d.id,'Зарезервированная цель attachmentHost');
    if(d.attachTo)inspectAST(d.attachTo,d.id+'.attachTo',c);
    const ids=new Set();
    for(const a of d.abilities||[]){
      if(!a.id||ids.has(a.id))fail(d.id,'Повтор/отсутствие abilityId');ids.add(a.id);
      if(a.ref)bindAbility(a,t.capabilities,c,t.play.resolution==='resolve_effects'?'stack':'battlefield');
      else validateBehavior(a,d.id+'.'+a.id,c,t.capabilities);
    }
    if(d.effects)validateBehavior({kind:'on_resolve',targets:d.targets,effects:d.effects,afterResolve:d.afterResolve},d.id+'.effects',c,t.capabilities,{},true);
  }
  for(const d of Object.values(c.effectTokens)){
    if(!Array.isArray(d.components))fail(d.id,'Нужны components');
    for(const component of d.components){
      if(!['stat','keyword','ability'].includes(component.kind))fail(d.id,'Неизвестный компонент жетона');
      if(component.kind==='stat'){if(!['attack','max_health'].includes(component.stat))fail(d.id,'Неизвестная характеристика');integer(component.amount,d.id+'.amount');}
      if(component.kind==='ability'&&!c.abilities[component.ref])fail(d.id,'Неизвестная способность');
    }
  }
  for(const r of Object.values(c.rules))inspectAST(r,r.id,c);
  return deepFreeze(c);
}
export function validateResourceCost(cost,c,path='cost') {
  integer(cost.generic??0,path+'.generic',0);
  for(const [id,n]of Object.entries(cost.resources||{})){if(!c.resources[id])fail(path,'Неизвестный ресурс '+id);integer(n,path+'.'+id,0);}
}
export function normalizeConfig(input,c) {
  const id=input?.presetId||(input?.economy?.mode==='automatic_growth'?'automatic_energy_v1':'duality_sources_v1');
  const base=c.presets[id];if(!base)fail('config','Неизвестный пресет');
  const config={...structuredClone(base),...structuredClone(input||{}),limits:{...base.limits,...input?.limits},deck:{...base.deck,...input?.deck}};
  integer(config.limits.maxCreaturesPerPlayer,'limits.maxCreaturesPerPlayer',1,32);
  const e=config.economy;
  if(e.mode==='deck_sources'){
    if(!e.enabledResourceIds?.length||new Set(e.enabledResourceIds).size!==e.enabledResourceIds.length)fail('economy','Нужны уникальные ресурсы');
    for(const id of e.enabledResourceIds)if(!c.resources[id])fail('economy','Неизвестный ресурс');
    integer(e.sourcePlaysPerTurn??1,'economy.sourcePlaysPerTurn',0,4);
    if(e.resourceId!==undefined)fail('economy','Смешаны режимы');
  }else if(e.mode==='automatic_growth'){
    if(c.resources[e.resourceId]?.poolPolicy!=='owner_turn_start'||e.enabledResourceIds||e.sourcePlaysPerTurn!==undefined)fail('economy','Несовместимый ресурс/режим');
    integer(e.initialCapacity,'economy.initialCapacity',0,100);integer(e.maxCapacity,'economy.maxCapacity',e.initialCapacity,100);integer(e.growthPerTurn,'economy.growthPerTurn',1,100);
  }else fail('economy','Неизвестный режим');
  for(const id of config.deck.unlimitedCopyCardIds||[])if(e.mode!=='deck_sources'||c.cardTypes[c.cards[id]?.typeId]?.play.method!=='source_deploy')fail('deck','Неверное исключение лимита');
  return config;
}
export function expandDeck(d) { return Array.isArray(d)?[...d]:d.cards.flatMap(v=>Array(v.count).fill(v.cardId)); }
export function validateDeck(deck,c,config) {
  const cards=expandDeck(deck),counts={};
  if(cards.length!==config.deck.size)fail('deck','Колода должна содержать '+config.deck.size+' карты');
  for(const id of cards){
    const card=c.cards[id];if(!card)fail('deck','Неизвестная карта '+id);
    const t=c.cardTypes[card.typeId];
    counts[id]=(counts[id]||0)+1;
    if(counts[id]>config.deck.maxCopiesPerCard&&!config.deck.unlimitedCopyCardIds.includes(id))fail('deck','Слишком много копий '+id);
    const enabled=config.economy.mode==='automatic_growth'?[config.economy.resourceId]:config.economy.enabledResourceIds;
    if(t.play.method==='source_deploy'&&config.economy.mode!=='deck_sources')fail('deck','Источники недопустимы в автоматическом режиме');
    for(const r of Object.keys(card.cost?.resources||{}))if(!enabled.includes(r))fail('deck','Недоступный ресурс '+r);
  }
  return cards;
}
export function deepFreeze(o) { if(o&&typeof o==='object'&&!Object.isFrozen(o)){Object.freeze(o);Object.values(o).forEach(deepFreeze);}return o; }
