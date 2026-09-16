// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MagicCards contributors

import * as E from '../engine/engine.mjs';
import * as C from '../content/compile.mjs';
import {readLocal,writeLocal,download,importJSON} from './storage.mjs';

const app=document.querySelector('#app'),dialog=document.querySelector('#dialog');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={UPKEEP:'Начало',DRAW:'Добор',MAIN_1:'Развитие I',COMBAT_BEGIN:'Перед боем',DECLARE_ATTACKERS:'Атака',DECLARE_BLOCKERS:'Блоки',COMBAT_DAMAGE:'Урон',COMBAT_END:'После боя',MAIN_2:'Развитие II',END:'Конец',CLEANUP:'Очистка'};
const keywordNames={vigilance:'Бдительность',flying:'Полёт',reach:'Захват',spectral:'Призрачность',spirit_sight:'Видение духов'};
const eventNames={turn_start:'Начало хода',turn_end:'Конец хода',stack_added:'Добавлено в стек',spell_countered:'Карта отменена',spell_fizzled:'Цель стала недопустимой',damage_applied:'Нанесён урон',healed:'Восстановлено здоровье',creature_entered:'Существо вышло на поле',creature_died:'Существо погибло',resource_gained:'Получен ресурс',resource_spent:'Оплачен ресурс',creature_attacked:'Объявлена атака',blockers_declared:'Назначены блоки',effect_token_added:'Прикреплён жетон',effect_token_removed:'Снят жетон',life_paid:'Оплачено жизнями',trigger_skipped:'Триггер пропущен: нет целей',conceded:'Игрок сдался'};
let official,raw,content,game=null,tab='play',mode='bot',viewer='p1',handOff=false,epoch=0,botBusy=false,worker,botTimer,botRequest=null;
let economy='deck_sources',workingDeck=[],drafts=[],selectedAttackers=[],filter='',catalogGroup='all';
let editorWasEdited=false;
let editor={id:'custom:my_card',name:'Новая карта',typeId:'types:creature',cost:{generic:2},attack:2,health:3,abilities:[],effects:[]};
const toast=message=>{const el=document.querySelector('#toast');el.textContent=message;el.style.display='block';clearTimeout(el.timer);el.timer=setTimeout(()=>el.style.display='none',5500);};
function modal(title,body,actions){dialog.innerHTML='<div class="modal-title"><h2>'+esc(title)+'</h2><button class="ghost" id="close-dialog" aria-label="Закрыть">×</button></div>'+body+'<div class="dialog-actions">'+actions+'</div>';dialog.querySelector('#close-dialog').onclick=()=>dialog.close();if(!dialog.open)dialog.showModal();}
const preset=()=>economy==='deck_sources'?'duality_sources_v1':'automatic_energy_v1';
const baseDeck=()=>C.expandDeck(content.decks[economy==='deck_sources'?'duality:starter':'core:starter']);
const who=()=>game?.pendingDecision?.playerId||game?.declaration?.playerId||game?.priorityPlayerId;
const view=()=>game?E.getPlayerView(game,mode==='bot'?'p1':viewer):null;
const cardType=d=>content.cardTypes[d.typeId];
const resourceName=id=>content.resources[id]?.name||id;
function costLabel(cost){if(!cost)return 'Источник';return [...Object.entries(cost.resources||{}).filter(([,n])=>n).map(([id,n])=>n+' '+resourceName(id)),...(cost.generic?[cost.generic+' любой']:[])].join(' · ')||'0';}
function effectText(e){
  const n=typeof e.amount==='number'?e.amount:'X';
  return ({damage:n+' урона',heal:'Восстановить '+n+' здоровья',draw:'Взять '+n+' карт.',destroy:'Уничтожить цель',counter_spell:'Отменить карту в стеке',modify_stat:(e.amount>=0?'+':'')+n+' '+(e.stat==='attack'?'к атаке':'к здоровью'),create_token:'Создать '+n+' фишек',apply_effect_token:'Дать жетон',grant_ability:'Дать способность',suppress_ability:'Подавить способность',return_to_battlefield:'Вернуть с кладбища',exile_top:'Изгнать '+n+' верхних карт',if:'Условный эффект',foreach:'Эффект для каждого',create_continuous_effect:'Временная аура',modify_keyword:e.operation==='remove'?'Подавить свойство':'Дать свойство',gain_resource:'Получить ресурс',gain_armor:'Получить броню',lose_armor:'Потерять броню',remove_effect_token:'Снять жетон',let:'Запомнить значение'})[e.type]||e.type;
}
function cardText(d){
  if(d.text)return d.text;
  const text=[...(d.keywords||[]).map(k=>keywordNames[k]||k),...(d.effects||[]).map(effectText)];
  for(const a of d.abilities||[]){
    if(a.ref)text.push(content.abilities[a.ref]?.name||a.ref);
    else if(a.kind==='resource_activated')text.push('↷ '+Object.entries(a.productionOptions?.[0]?.resources||{}).map(([r,n])=>n+' '+resourceName(r)).join(', '));
    else if(a.kind==='continuous')text.push('Аура: '+(a.modifiers||[]).map(m=>m.operation==='add_stats'?(m.attack||0)+'/'+(m.health||0):m.operation==='grant_ability'?'даёт способность':keywordNames[m.keyword]||m.operation).join(', '));
    else text.push((a.kind==='activated'?'Активация':a.trigger==='on_enter'?'При входе':a.trigger==='on_death'?'При гибели':'Реакция')+': '+(a.effects||[]).map(effectText).join('; '));
  }
  return text.join('. ')||'Надёжная основа вашей стороны.';
}
function glyph(d){const t=cardType(d);if(t?.play.method==='source_deploy')return d.id.includes('dark')?'☾':'☀';if(d.subtypes?.includes('dragon')||d.id.includes('drake'))return '♜';if(t?.components.power_meter)return '♛';if(t?.components.attachment)return '✥';if(t?.components.armor)return '⬡';if(t?.components.health)return '♟';return d.effects?.some(e=>e.type==='counter_spell')?'⌁':d.effects?.some(e=>e.type==='heal')?'✚':'ϟ';}
function cardHTML(d,o=null,{playable=false,selected=false,board=false,attr=''}={}){
  const t=cardType(d),dark=d.id.includes('dark')||d.id.includes('twilight')||d.cost?.resources?.['duality:dark'];
  return '<button type="button" class="card '+(dark?'dark ':'')+(board?'board-card ':'')+(playable?'playable ':'')+(selected?'selected ':'')+(o?.tapped?'tapped':'')+'" '+attr+' aria-label="'+esc(d.name+'. '+cardText(d))+'"><div class="card-top"><span>'+esc(costLabel(d.cost))+'</span><span>'+esc(t?.play.timing==='fast'?'ϟ':'◇')+'</span></div><div class="card-art"><span>'+glyph(d)+'</span></div><div class="card-title">'+esc(d.name)+'</div><div class="card-text">'+esc(cardText(d))+'</div><div class="card-footer"><span>'+esc(t?.name||d.typeId)+'</span>'+(t?.components.health?'<span><b class="stat">'+(o?.attack??d.attack)+'</b> <b class="stat hp">'+(o?.health??d.health)+'</b></span>':t?.components.power_meter?'<b class="stat">✧ '+(o?.power??d.power)+'</b>':'')+'</div></button>';
}
function playerBar(v,p,self){
  const x=v.players[p],label=mode==='bot'?(p==='p1'?'Вы':'Хранитель сумерек'):(p==='p1'?'Игрок 1':'Игрок 2');
  const enabled=v.config.economy.mode==='deck_sources'?v.config.economy.enabledResourceIds:[v.config.economy.resourceId];
  return '<div class="player-bar '+(self?'self':'')+'"><div class="avatar '+(self?'':'enemy')+'">'+(self?'♔':'♛')+'</div><div><div class="player-name">'+label+(v.priorityPlayerId===p?' <span class="pill gold">Приоритет</span>':'')+'</div><div class="row">'+enabled.map(id=>'<span class="resource '+(id.includes('light')?'light':id.includes('dark')?'dark':'energy')+'">'+(id.includes('light')?'☀':id.includes('dark')?'☾':'◆')+' '+(x.pool[id]||0)+(v.config.economy.mode==='automatic_growth'?'/'+x.capacity:'')+'</span>').join('')+'</div></div><div class="grow"></div><div class="zone-info">'+x.deckCount+' в колоде<br>'+x.graveyard.length+' на кладбище</div><div class="health">♥ '+x.health+' <small>/ '+x.maxHealth+'</small></div>'+(!self?'<div class="enemy-hand">'+Array.from({length:Math.min(7,x.handCount)},()=>'<span class="card-back">✧</span>').join('')+'</div>':'')+'</div>';
}
function render(){
  const tabs=[['play','Игровой стол'],['collection','Коллекция'],['editor','Мастерская'],['rules','Как играть']];
  app.innerHTML='<header class="header"><div class="brand"><span class="brand-mark">✧</span><div><strong>MagicCards</strong><small>СВЕТ И ТЬМА</small></div></div><nav class="tabs" aria-label="Разделы">'+tabs.map(([id,label])=>'<button class="tab '+(tab===id?'active':'')+'" data-tab="'+id+'">'+label+'</button>').join('')+'</nav><span class="pill">Локальная игра · v0.1</span></header><main class="main">'+(tab==='play'?renderPlay():tab==='collection'?renderCollection():tab==='editor'?renderEditor():renderRules())+'<footer class="footer">MAGICCARDS · Правила prototype-stack-v1 / 0.12 · Черновики и партии хранятся на этом устройстве</footer></main>';
  for(const el of app.querySelectorAll('[data-tab]'))el.onclick=()=>{if(tab==='editor'&&editorWasEdited)editor=collectEditor();tab=el.dataset.tab;render();};
  bindCommon();if(tab==='play')bindPlay();if(tab==='collection')bindCollection();if(tab==='editor')bindEditor();
}
function renderPlay(){
  if(!game)return '<div class="overlay"><div><div class="eyebrow">КАРТОЧНАЯ СТРАТЕГИЯ</div><h1>У каждого действия<br>есть ответ.</h1><p>Призывайте существ, развивайте источники Света и Тьмы и отвечайте на заклинания соперника. Побеждает тот, кто вовремя передаёт приоритет.</p><div class="row" style="justify-content:center"><button class="primary" id="new-game">Начать партию</button><button id="load-game">Загрузить партию</button></div><p class="small" style="margin-top:22px">Против бота или вдвоём за одним устройством</p></div></div>';
  const v=view(),p=v.playerId,enemy=p==='p1'?'p2':'p1',legal=E.getLegalActions(game,p),myTurn=who()===p&&!game.result;
  if(handOff)return '<div class="overlay"><div><span class="brand-mark">✧</span><h1>Передайте управление</h1><p>Сейчас решение принимает '+(who()==='p1'?'игрок 1':'игрок 2')+'. Закрытые карты появятся после подтверждения.</p><button class="primary" id="reveal">Я готов</button></div></div>';
  const field=id=>{const cards=v.board.filter(o=>o.controllerId===id&&cardType(o.definition).play.method!=='source_deploy');return '<div class="field '+(id===enemy?'enemy ':'')+(!cards.length?'empty':'')+'">'+(cards.length?cards.map(o=>cardHTML(o.definition,o,{board:true,selected:selectedAttackers.some(r=>E.same(r,E.ref(o))),playable:legal.some(a=>a.source&&E.same(a.source,E.ref(o))),attr:'data-instance="'+esc(o.instanceId)+'"'})).join(''):'На этой стороне пока нет существ')+'</div>';};
  const sources=id=>'<div class="source-field">'+v.board.filter(o=>o.controllerId===id&&cardType(o.definition).play.method==='source_deploy').map(o=>'<button class="source '+(o.tapped?'tapped':'')+'" data-instance="'+o.instanceId+'">'+glyph(o.definition)+' '+esc(o.definition.name)+(o.tapped?' ↷':'')+'</button>').join('')+'</div>';
  const phaseHint=game.pendingDecision?'Выберите цели сработавшей способности.':game.declaration?.type==='attackers'?'Выберите своих атакующих на поле и подтвердите атаку. Можно не атаковать.':game.declaration?.type==='blockers'?'Назначьте блокирующих. Новые существа тоже могут блокировать.':game.stack.length?'Вы можете ответить быстрой картой. Два паса разрешат верхний элемент стека.':'Разыграйте карту или передайте приоритет. Два паса переведут игру к следующему шагу.';
  let action=myTurn?(game.pendingDecision?'Выбрать цель':game.declaration?.type==='attackers'?'Подтвердить атаку'+(selectedAttackers.length?' · '+selectedAttackers.length:' · пропустить'):game.declaration?.type==='blockers'?'Назначить блоки':'Передать приоритет'):'Бот принимает решение…';
  return '<div class="page-head"><div><span class="eyebrow">'+(v.config.economy.mode==='deck_sources'?'ДУЭЛЬ ИСТОЧНИКОВ':'АВТОМАТИЧЕСКАЯ ЭНЕРГИЯ')+'</span><h1>Свет и Тьма</h1></div><div class="toolbar"><button id="new-game">Новая партия</button><button id="save-game">Сохранить</button><button id="load-game">Загрузить</button><button id="export-replay">Replay ↓</button><button id="show-zones">Зоны</button>'+(game.fixture?'<button id="export-scenario">Сценарий ↓</button>':'')+'<button id="concede" class="danger">Сдаться</button></div></div>'+(v.result?'<div class="result"><span class="eyebrow">ПАРТИЯ ЗАВЕРШЕНА</span><h2>'+(v.result.type==='draw'?'Ничья':v.result.winner===p?'Победа!':'Победа соперника')+'</h2><p class="muted">Ходов: '+v.turnId+'. '+(v.result.reason==='concede'?'Игрок сдался.':'Здоровье игрока закончилось.')+'</p><button id="result-new" class="primary">Сыграть ещё</button></div>':'')+'<div class="game-layout"><section class="arena" aria-label="Игровой стол">'+playerBar(v,enemy,false)+sources(enemy)+field(enemy)+'<div class="midline">'+(v.combat?.attackers.length?'В бою: '+v.combat.attackers.length+' атакующих':'Поле сражения')+'</div>'+field(p)+sources(p)+playerBar(v,p,true)+'<div class="hand" aria-label="Ваша рука">'+(v.players[p].hand.length?v.players[p].hand.map(o=>cardHTML(o.definition,o,{playable:legal.some(a=>a.card&&E.same(a.card,E.ref(o))),attr:'data-instance="'+o.instanceId+'"'})).join(''):'<p class="muted small">Ваша рука пуста. Новая карта придёт в шаг добора.</p>')+'</div></section><aside class="side"><section class="panel"><div class="row between"><span class="eyebrow">ХОД '+v.turnId+'</span><span class="pill">'+(v.activePlayerId===p?'Ваш ход':'Ход соперника')+'</span></div><div class="turn-title">'+names[v.phase]+'</div><div class="phase-grid">'+E.PHASES.filter(x=>x!=='CLEANUP').map(x=>'<span class="phase '+(x===v.phase?'current':'')+'">'+names[x]+'</span>').join('')+'</div><div class="small muted"><span class="status-dot"></span>'+(myTurn?'Вы принимаете решение':v.result?'Партия завершена':'Решение соперника')+'</div><button class="primary main-action" id="main-action" '+(!myTurn?'disabled':'')+'>'+action+'</button><p class="hint">'+phaseHint+'</p></section><section class="panel"><div class="row between"><h3>Стек эффектов</h3><span class="pill">'+v.stack.length+'</span></div><div class="stack-list">'+(v.stack.length?[...v.stack].reverse().map((i,index)=>'<div class="stack-item"><span class="eyebrow">'+(index===0?'СЛЕДУЮЩИЙ':'ОЖИДАЕТ')+'</span><div>'+esc(i.name)+'</div><small>'+i.itemId+' · '+(i.controllerId===p?'Ваша карта':'Соперник')+'</small></div>').join(''):'<p class="hint">Стек пуст. Последний добавленный эффект разрешается первым.</p>')+'</div></section><section class="panel"><h3>Журнал партии</h3><div class="log" aria-live="polite">'+[...v.events].reverse().filter(e=>eventNames[e.type]).slice(0,18).map(e=>'<div><time>'+e.eventId+'</time>'+eventNames[e.type]+(e.name?' · '+esc(e.name):'')+(e.amount!==undefined?' · '+e.amount:'')+(e.player?' · '+e.player.playerId:'')+'</div>').join('')+'</div></section></aside></div>';
}
function currentScenario(){
  if(!game?.fixture)return null;
  return {scenarioId:'custom:workshop_trial',fixture:structuredClone(game.fixture),commands:structuredClone(game.commands),assertions:[{type:'invariants'},{type:'stack_size',value:game.stack.length},{type:'equals',path:'players.p1.health',value:game.players.p1.health},{type:'equals',path:'players.p2.health',value:game.players.p2.health}]};
}
function exportScenarios(){try{const scenario=currentScenario()||readLocal('scenario',null);return scenario?[scenario]:[];}catch{return [];}}
function bindCommon(){
  app.querySelector('#new-game')?.addEventListener('click',newGameDialog);
  app.querySelector('#result-new')?.addEventListener('click',newGameDialog);
  app.querySelector('#load-game')?.addEventListener('click',loadGameDialog);
}
function newGameDialog(){
  modal('Новая партия','<p class="muted">Настройки фиксируются до конца матча.</p><div class="form-grid"><label>Экономика<select id="setup-economy"><option value="deck_sources">Свет и Тьма · источники из колоды</option><option value="automatic_growth">Автоматическая энергия</option></select></label><label>Соперник<select id="setup-mode"><option value="bot">Игровой бот</option><option value="local">Другой игрок за этим устройством</option></select></label><label>Мест на поле<input id="setup-limit" type="number" min="1" max="32" value="7"></label><label>Seed партии<input id="setup-seed" type="number" min="1" value="'+Math.floor(Math.random()*1000000+1)+'"></label><label class="wide">Ваша колода<select id="setup-deck"><option value="starter">Стартовая колода выбранного режима</option><option value="custom">Колода из конструктора</option></select></label></div><div id="setup-error" class="section-gap"></div>','<button id="start-match" class="primary">Начать игру</button>');
  dialog.querySelector('#setup-economy').value=economy;
  dialog.querySelector('#start-match').onclick=()=>{
    try{
      economy=dialog.querySelector('#setup-economy').value;mode=dialog.querySelector('#setup-mode').value;
      const config={presetId:preset(),limits:{maxCreaturesPerPlayer:Number(dialog.querySelector('#setup-limit').value)}};
      if(dialog.querySelector('#setup-deck').value==='custom')config.decks={p1:workingDeck};
      const next=E.createGame(config,content,Number(dialog.querySelector('#setup-seed').value));
      setGame(next);viewer='p1';handOff=mode==='local'&&who()!==viewer;tab='play';dialog.close();render();scheduleBot();
    }catch(e){dialog.querySelector('#setup-error').innerHTML='<div class="error">'+esc(e.message)+'</div>';}
  };
}
function setGame(next){epoch++;clearTimeout(botTimer);game=next;botBusy=false;botRequest=null;handOff=false;selectedAttackers=[];}
function dispatch(command){
  const r=E.execute(game,command);if(!r.ok){toast(r.error.message+' ['+r.error.code+']');return false;}
  game=r.state;selectedAttackers=[];if(mode==='local'&&who()!==viewer&&!game.result)handOff=true;
  render();scheduleBot();return true;
}
function scheduleBot(){
  if(mode!=='bot'||who()!=='p2'||game.result||botBusy)return;
  const currentEpoch=epoch;botBusy=true;
  setTimeout(()=>{
    if(currentEpoch!==epoch){botBusy=false;return;}
    const context=E.getDecisionContext(game,'p2');
    botRequest={epoch,revision:context.revision,decisionId:context.decisionId};
    worker.postMessage({epoch,context});
    clearTimeout(botTimer);botTimer=setTimeout(()=>{if(currentEpoch===epoch&&botBusy){toast('Бот превысил время выбора. Выполнено резервное действие.');botFallback();}},5000);
  },250);
}
function botFallback(){
  clearTimeout(botTimer);botBusy=false;botRequest=null;
  if(game&&!game.result&&who()==='p2'&&mode==='bot'){
    const template=E.getLegalActions(game,'p2')[0];if(template)dispatch(E.materialize(template));
  }
}
function bindPlay(){
  app.querySelector('#reveal')?.addEventListener('click',()=>{viewer=who();handOff=false;render();});
  app.querySelector('#main-action')?.addEventListener('click',()=>{
    if(game.pendingDecision)return chooseCommand(E.getLegalActions(game,viewer)[0]);
    if(game.declaration?.type==='attackers')return attackDialog();
    if(game.declaration?.type==='blockers')return blockDialog();
    dispatch({type:'PassPriority',actorId:mode==='bot'?'p1':viewer});
  });
  for(const el of app.querySelectorAll('[data-instance]'))el.onclick=()=>inspectCard(el.dataset.instance);
  app.querySelector('#save-game')?.addEventListener('click',()=>{try{const saved={mode,viewer,save:JSON.parse(E.saveGame(game))};writeLocal('game',saved);download('magiccards-save.json',saved);toast('Партия сохранена на устройстве и экспортирована.');}catch(e){toast(e.message);download('magiccards-save.json',{mode,viewer,save:JSON.parse(E.saveGame(game))});}});
  app.querySelector('#export-replay')?.addEventListener('click',()=>download('magiccards-replay.json',E.makeReplay(game)));
  app.querySelector('#export-scenario')?.addEventListener('click',()=>{const scenario=currentScenario();if(scenario){writeLocal('scenario',scenario);download('magiccards-scenario.json',scenario);toast('Сценарий сохранён и добавлен к экспорту набора.');}});
  app.querySelector('#concede')?.addEventListener('click',()=>{modal('Сдаться?','<p class="muted">Сопернику будет засчитана победа.</p>','<button class="danger" id="confirm-concede">Завершить партию</button>');dialog.querySelector('#confirm-concede').onclick=()=>{dialog.close();dispatch({type:'Concede',actorId:mode==='bot'?'p1':viewer});};});
  app.querySelector('#show-zones')?.addEventListener('click',()=>{const v=view();modal('Кладбища и изгнание',Object.entries(v.players).map(([p,x])=>'<h3>'+p+'</h3><p class="muted">'+[...x.graveyard,...x.exile].map(o=>esc(o.definition.name)+' ('+o.zone+')').join(', ')+'</p>').join(''),'');});
}
function labelRef(r){
  if(r.playerId)return r.playerId===(mode==='bot'?'p1':viewer)?'Ваш игрок':'Игрок соперника';
  if(r.itemId)return game.stack.find(i=>i.itemId===r.itemId)?.ability.name||r.itemId;
  const o=E.getObject(game,r),d=game.content.cards[o?.cardId]||game.content.tokens[o?.cardId];return (d?.name||r.instanceId)+' · '+r.instanceId+(o?.zone==='battlefield'?' ('+(E.effectiveView(game)[r.instanceId+'@'+r.generation]?.health??'—')+' зд.)':'');
}
function chooseCommand(template){
  const command=E.materialize(template),targets=template.targets||[],costs=template.costChoices||[];
  const pool=game.players[command.actorId].pool,payment=template.paymentCost;
  const choices=[...targets.map(t=>({...t,kind:'target'})),...costs.map(t=>({...t,kind:'cost'}))];
  const body=choices.map((t,i)=>'<label style="margin-bottom:14px">'+esc(t.kind==='cost'?'Жертва: '+t.id:'Цель: '+t.id)+'<select data-choice="'+i+'" '+(t.count>1?'multiple size="4"':'')+'>'+t.options.map((r,index)=>'<option value="'+index+'">'+esc(labelRef(r))+'</option>').join('')+'</select>'+(t.count>1?'<span class="small">Выберите ровно '+t.count+' (Ctrl / Shift).</span>':'')+'</label>').join('')+(template.productionOptions?'<label>Производство<select id="production-choice">'+template.productionOptions.map(x=>'<option value="'+esc(x.id)+'">'+esc(Object.entries(x.resources).map(([id,n])=>n+' '+resourceName(id)).join(', '))+'</option>').join('')+'</select></label>':'')+(payment?'<fieldset class="payment"><legend>Оплата: '+esc(costLabel(payment))+'</legend><p class="hint">Укажите, сколько каждого ресурса потратить. Точная цена обязательна; остальное оплачивает «любой ресурс».</p><div class="form-grid">'+Object.entries(pool).map(([id,n])=>'<label>'+esc(resourceName(id))+' · в пуле '+n+'<input data-payment="'+esc(id)+'" type="number" min="'+(payment.resources?.[id]||0)+'" max="'+n+'" step="1" value="'+(command.paymentPlan?.[id]||0)+'"></label>').join('')+'</div><div id="payment-status" class="hint" aria-live="polite"></div></fieldset>':'');
  if(!choices.length&&!template.productionOptions&&!payment){dispatch(command);return;}
  modal('Подтвердите действие',body||'<p>Действие не требует целей.</p>','<button class="primary" id="confirm-command">Подтвердить</button>');
  const checkPayment=()=>{
    if(!payment)return true;
    try{const request=Object.fromEntries([...dialog.querySelectorAll('[data-payment]')].map(el=>[el.dataset.payment,Number(el.value)]));command.paymentPlan=E.paymentPlan(pool,payment,request);dialog.querySelector('#payment-status').textContent='Платёж корректен';dialog.querySelector('#confirm-command').disabled=false;return true;}
    catch{dialog.querySelector('#payment-status').textContent='Сумма должна точно покрывать цену и не превышать пул';dialog.querySelector('#confirm-command').disabled=true;return false;}
  };
  for(const input of dialog.querySelectorAll('[data-payment]'))input.oninput=checkPayment;
  checkPayment();
  dialog.querySelector('#confirm-command').onclick=()=>{
    if(!checkPayment())return;
    for(const [i,t]of choices.entries()){
      const selected=[...dialog.querySelector('[data-choice="'+i+'"]').selectedOptions].map(o=>t.options[Number(o.value)]);
      if(selected.length!==t.count)return toast('Нужно выбрать '+t.count+' для '+t.id);
      if(t.kind==='target'){command.targets||={};command.targets[t.id]=t.count===1?selected[0]:selected;}
      else{command.costChoices||={};command.costChoices[t.id]=selected;}
    }
    if(template.productionOptions)command.productionOptionId=dialog.querySelector('#production-choice').value;
    dialog.close();dispatch(command);
  };
}
function inspectCard(id){
  const v=view(),o=[...v.board,...v.players[v.playerId].hand].find(o=>o.instanceId===id);if(!o)return;
  const actions=E.getLegalActions(game,v.playerId);
  if(game.declaration?.type==='attackers'&&game.declaration.playerId===v.playerId&&actions[0]?.attackers.some(r=>E.same(r,E.ref(o)))){
    const r=E.ref(o);selectedAttackers=selectedAttackers.some(x=>E.same(x,r))?selectedAttackers.filter(x=>!E.same(x,r)):[...selectedAttackers,r];render();return;
  }
  const available=actions.filter(a=>a.card&&E.same(a.card,E.ref(o))||a.source&&E.same(a.source,E.ref(o)));
  const d=o.definition;
  modal(d.name,'<div class="row"><div>'+cardHTML(d,o)+'</div><div class="grow"><p>'+esc(cardText(d))+'</p><p class="hint">'+esc(cardType(d).name)+' · '+esc(costLabel(d.cost))+'</p>'+(o.effectTokens?.length?'<p class="hint">Жетоны: '+o.effectTokens.map(t=>esc(content.effectTokens[t.definitionId]?.name||t.definitionId)).join(', ')+'</p>':'')+(o.attachmentHost?'<p class="hint">Прикреплено к: '+esc(labelRef(o.attachmentHost))+'</p>':'')+(!available.length?'<p class="hint">Сейчас карта недоступна для действия. Проверьте приоритет, фазу, ресурс и поворот.</p>':'')+'</div></div>',available.map((a,i)=>'<button class="primary" data-card-action="'+i+'">'+(a.type==='CastCard'?'Разыграть':a.type==='PlayResourceCard'?'Выложить источник':'Активировать: '+esc(a.abilityId))+'</button>').join(''));
  for(const b of dialog.querySelectorAll('[data-card-action]'))b.onclick=()=>{const a=available[Number(b.dataset.cardAction)];dialog.close();chooseCommand(a);};
}
function attackDialog(){
  const template=E.getLegalActions(game,viewer)[0];
  if(!selectedAttackers.length)return dispatch({type:'DeclareAttackers',actorId:viewer,attackers:[]});
  if(template.defenders.length===1)return dispatch({type:'DeclareAttackers',actorId:viewer,attackers:selectedAttackers.map(attacker=>({attacker,defender:template.defenders[0]}))});
  modal('Цели атаки',selectedAttackers.map((a,i)=>'<label>'+esc(labelRef(a))+'<select data-defender="'+i+'">'+template.defenders.map((d,j)=>'<option value="'+j+'">'+esc(labelRef(d))+'</option>').join('')+'</select></label>').join(''),'<button class="primary" id="confirm-attacks">Атаковать</button>');
  dialog.querySelector('#confirm-attacks').onclick=()=>{const attackers=selectedAttackers.map((attacker,i)=>({attacker,defender:template.defenders[Number(dialog.querySelector('[data-defender="'+i+'"]').value)]}));dialog.close();dispatch({type:'DeclareAttackers',actorId:viewer,attackers});};
}
function blockDialog(){
  const template=E.getLegalActions(game,viewer)[0],attackers=game.combat.attackers;
  modal('Назначение блоков','<p class="hint">Одно существо может блокировать одного атакующего. Подтверждённый блок остаётся, даже если защитник погибнет от ответа.</p>'+attackers.map((a,i)=>'<label style="margin:14px 0">'+esc(labelRef(a.attacker))+' → '+esc(labelRef(a.defender))+'<select data-block="'+i+'"><option value="">Не блокировать</option>'+template.pairs.filter(x=>E.same(x.attacker,a.attacker)).map((pair)=>'<option value="'+esc(pair.blocker.instanceId)+'">'+esc(labelRef(pair.blocker))+'</option>').join('')+'</select></label>').join(''),'<button class="primary" id="confirm-blocks">Подтвердить блоки</button>');
  dialog.querySelector('#confirm-blocks').onclick=()=>{const blockers=[];for(const [i,a]of attackers.entries()){const id=dialog.querySelector('[data-block="'+i+'"]').value;if(id)blockers.push({attacker:a.attacker,blocker:template.pairs.find(x=>x.blocker.instanceId===id).blocker});}if(new Set(blockers.map(b=>b.blocker.instanceId)).size!==blockers.length)return toast('Одно существо нельзя назначить дважды.');dialog.close();dispatch({type:'DeclareBlockers',actorId:viewer,blockers});};
}
function loadGameDialog(){
  modal('Загрузить партию','<p class="muted">Продолжите локальное сохранение или откройте файл партии / replay.</p>','<button id="load-local">С этого устройства</button><button class="primary" id="load-file">Открыть JSON</button>');
  const use=data=>{try{if(!data)return;if(data.importError)throw new Error(data.importError);let next;
    if(data.format==='magiccards-replay'){next=E.replay(data);mode='bot';viewer='p1';}
    else {mode=data.mode||'bot';viewer=data.viewer||'p1';next=E.loadGame(data.save||data);}
    setGame(next);content=next.content;handOff=mode==='local'&&who()!==viewer;tab='play';dialog.close();render();scheduleBot();
  }catch(e){toast('Не удалось загрузить: '+e.message);}};
  dialog.querySelector('#load-local').onclick=()=>{try{const data=readLocal('game',null);if(!data)return toast('Локального сохранения ещё нет.');use(data);}catch(e){toast(e.message);}};
  dialog.querySelector('#load-file').onclick=async()=>use(await importJSON());
}

function renderCollection(){
  const counts=Object.fromEntries([...new Set(workingDeck)].map(id=>[id,workingDeck.filter(x=>x===id).length]));
  const cards=Object.values(content.cards).filter(d=>(catalogGroup==='all'||d.id.startsWith(catalogGroup+':'))&&(!filter||(d.name+' '+cardText(d)).toLowerCase().includes(filter.toLowerCase())));
  let deckMessage;try{C.validateDeck(workingDeck,content,C.normalizeConfig({presetId:preset()},content));deckMessage='<span class="success">✓ Колода готова к партии</span>';}catch(e){deckMessage='<span class="small muted">'+esc(e.message)+'</span>';}
  return '<div class="page-head"><div><span class="eyebrow">ВАШ АРСЕНАЛ</span><h1>Коллекция и колода</h1></div><div class="toolbar"><button id="import-pack">Импорт набора</button><button id="export-pack">Экспорт для PR ↓</button></div></div><div class="library-layout"><section><div class="filters"><input id="search-cards" type="search" placeholder="Название карты или способность…" value="'+esc(filter)+'" aria-label="Поиск карт"><select id="catalog-group"><option value="all">Все карты</option><option value="duality">Свет и Тьма</option><option value="core">Классические</option><option value="examples">Механики</option><option value="custom">Ваши черновики</option></select></div><div class="library-grid">'+cards.map(d=>cardHTML(d,null,{attr:'data-catalog="'+esc(d.id)+'"'})).join('')+'</div></section><aside><div class="panel"><div class="row between"><h3>Ваша колода</h3><span class="pill gold">'+workingDeck.length+' / 24</span></div><label>Экономика<select id="deck-economy"><option value="deck_sources">Источники Света и Тьмы</option><option value="automatic_growth">Автоматическая энергия</option></select></label><p class="hint">Нажмите на карту в каталоге, чтобы добавить её. До двух копий; базовые источники без этого ограничения.</p><div class="deck-list">'+Object.entries(counts).map(([id,n])=>'<div class="deck-row"><span>'+esc(content.cards[id]?.name||id)+'</span><button data-minus="'+esc(id)+'" aria-label="Убрать '+esc(content.cards[id]?.name)+'">−</button><b>'+n+'</b><button data-plus="'+esc(id)+'" aria-label="Добавить '+esc(content.cards[id]?.name)+'">+</button></div>').join('')+'</div><p>'+deckMessage+'</p><div class="toolbar"><button id="reset-deck">Стартовая</button><button id="clear-deck">Очистить</button><button id="save-deck">Сохранить</button></div><button class="primary main-action" id="play-deck">Играть этой колодой</button></div><div class="workshop-note">Колода и черновики локальны. Начатая партия использует собственный снимок карт: редактирование не меняет её правила.</div></aside></div>';
}
function bindCollection(){
  app.querySelector('#catalog-group').value=catalogGroup;
  app.querySelector('#deck-economy').value=economy;
  app.querySelector('#search-cards').oninput=e=>{filter=e.target.value;const pos=e.target.selectionStart;render();const input=app.querySelector('#search-cards');input.focus();input.setSelectionRange(pos,pos);};
  app.querySelector('#catalog-group').onchange=e=>{catalogGroup=e.target.value;render();};
  app.querySelector('#deck-economy').onchange=e=>{economy=e.target.value;workingDeck=baseDeck();render();};
  const add=id=>{const config=C.normalizeConfig({presetId:preset()},content),count=workingDeck.filter(x=>x===id).length;if(count>=2&&!config.deck.unlimitedCopyCardIds.includes(id))return toast('В колоде уже две копии этой карты.');if(workingDeck.length>=24)return toast('Колода заполнена. Сначала уберите карту.');workingDeck.push(id);render();};
  for(const el of app.querySelectorAll('[data-catalog]'))el.onclick=()=>add(el.dataset.catalog);
  for(const el of app.querySelectorAll('[data-plus]'))el.onclick=()=>add(el.dataset.plus);
  for(const el of app.querySelectorAll('[data-minus]'))el.onclick=()=>{workingDeck.splice(workingDeck.indexOf(el.dataset.minus),1);render();};
  app.querySelector('#reset-deck').onclick=()=>{workingDeck=baseDeck();render();};
  app.querySelector('#clear-deck').onclick=()=>{workingDeck=[];render();};
  app.querySelector('#save-deck').onclick=()=>{try{C.validateDeck(workingDeck,content,C.normalizeConfig({presetId:preset()},content));writeLocal('deck',{economy,cards:workingDeck});toast('Колода сохранена.');}catch(e){toast(e.message);}};
  app.querySelector('#play-deck').onclick=()=>{newGameDialog();dialog.querySelector('#setup-deck').value='custom';};
  app.querySelector('#export-pack').onclick=()=>download('magiccards-pack.json',{format:'magiccards-pack',version:1,content:raw,deck:{economy,cards:workingDeck},scenarios:exportScenarios()});
  app.querySelector('#import-pack').onclick=importPack;
}
async function importPack(){
  const data=await importJSON();if(!data)return;
  try{
    if(data.importError)throw new Error(data.importError);
    if(data.format!=='magiccards-pack'||data.version!==1)throw new Error('Нужен набор MagicCards версии 1.');
    const compiled=C.validateContent(data.content);
    if(data.deck){const cfg=C.normalizeConfig({presetId:data.deck.economy==='deck_sources'?'duality_sources_v1':'automatic_energy_v1'},compiled);C.validateDeck(data.deck.cards,compiled,cfg);}
    raw=structuredClone(data.content);content=compiled;writeLocal('content',raw);
    if(data.deck){economy=data.deck.economy;workingDeck=[...data.deck.cards];}
    toast('Набор проверен и импортирован. Текущая партия не изменена.');render();
  }catch(e){toast('Импорт отклонён: '+e.message);}
}
const targetOptions=[['none','Без выбранной цели'],['enemy_character','Вражеский игрок или существо'],['friendly_character','Свой игрок или существо'],['enemy_creature','Вражеское существо'],['friendly_creature','Своё существо'],['pending_spell','Ожидающая карта в стеке'],['player','Любой игрок'],['friendly_permanent','Свой объект поля'],['enemy_permanent','Вражеский объект поля'],['enemy_damageable','Вражеская цель для урона'],['graveyard_creature_card','Существо на своём кладбище']];
const effectOptions={damage:'Урон',heal:'Лечение',draw:'Добор',destroy:'Уничтожение',counter_spell:'Отмена карты',modify_stat:'Изменение характеристики',modify_keyword:'Выдать / подавить свойство',create_token:'Создать фишку',apply_effect_token:'Прикрепить жетон',remove_effect_token:'Снять жетон',grant_ability:'Выдать способность',suppress_ability:'Подавить способность',return_to_battlefield:'Вернуть с кладбища',exile_top:'Изгнать верх колоды',gain_resource:'Добавить ресурс',gain_armor:'Добавить броню',lose_armor:'Снять броню',if:'Если / иначе',foreach:'Для каждого',let:'Запомнить количество'};
function selectOptions(options,value){return options.map(([id,label])=>'<option value="'+esc(id)+'" '+(id===value?'selected':'')+'>'+esc(label)+'</option>').join('');}
const dstOptions=[['selected','Выбранная цель'],['controller','Свой игрок'],['opponent','Вражеский игрок'],['source','Источник способности'],['attached_to','Носитель чар'],['all_enemy_creatures','Все вражеские существа'],['all_friendly_creatures','Все свои существа'],['other_friendly_creatures','Другие свои существа'],['all_creatures','Все существа'],['item','Текущий объект цикла']];
function dstId(e){const d=e.target||e.player;return d?.selected?'selected':d?.context||d?.selector||(d?.type==='item'?'item':'controller');}
function effectEditor(e,index){
  const sub=which=>'<div data-branch="'+which+'">'+(e[which]||[]).map((v,i)=>effectEditor(v,i)).join('')+'</div><button type="button" class="small" data-add-branch="'+which+'">+ '+(which==='then'?'Если условие выполнено':which==='else'?'Иначе':'Действие цикла')+'</button>';
  return '<div class="effect-block" data-block="'+index+'" data-original="'+esc(JSON.stringify(e))+'"><div class="row"><select class="grow" aria-label="Операция эффекта" data-field="type">'+selectOptions(Object.entries(effectOptions),e.type)+'</select><button data-remove-block aria-label="Удалить эффект">×</button></div><div class="effect-fields"><label>Получатель<select data-field="destination">'+selectOptions(dstOptions,dstId(e))+'</select></label><label>Количество / величина<input type="number" data-field="amount" value="'+(typeof e.amount==='number'?e.amount:1)+'"></label><label>Вычисление<select data-field="expression">'+selectOptions([['number','Число'],['attack','Текущая атака источника'],['enemies','Число вражеских существ'],['deaths','Число смертей события']],typeof e.amount==='number'||!e.amount?'number':e.amount.type==='count'?'enemies':'attack')+'</select></label>'+(e.type==='modify_stat'?'<label>Характеристика<select data-field="stat">'+selectOptions([['attack','Атака'],['max_health','Максимальное здоровье']],e.stat||'attack')+'</select></label>':'')+(['modify_keyword'].includes(e.type)?'<label>Свойство<select data-field="keyword">'+selectOptions(Object.entries(keywordNames),e.keyword||'flying')+'</select></label><label>Действие<select data-field="operation">'+selectOptions([['grant','Выдать'],['remove','Подавить']],e.operation||'grant')+'</select></label>':'')+(['modify_stat','modify_keyword','apply_effect_token','grant_ability','suppress_ability'].includes(e.type)?'<label>Срок<select data-field="duration">'+selectOptions([['until_end_of_turn','До конца этого хода'],['permanent_on_instance','До ухода получателя'],['until_source_leaves','Пока источник на поле']],e.duration?.type||'until_end_of_turn')+'</select></label>':'')+(['create_token','apply_effect_token','remove_effect_token','grant_ability','suppress_ability'].includes(e.type)?'<label>Определение<select data-field="definition">'+selectOptions(Object.values(e.type==='create_token'?content.tokens:['grant_ability','suppress_ability'].includes(e.type)?content.abilities:content.effectTokens).map(d=>[d.id,d.name]),e.tokenRef||e.definitionId||e.ability?.ref)+'</select></label>':'')+(e.type==='gain_resource'?'<label>Ресурс<select data-field="resource">'+selectOptions(Object.values(content.resources).map(d=>[d.id,d.name]),Object.keys(e.resources||{})[0])+'</select></label>':'')+'</div>'+(e.type==='if'?'<label style="margin-top:10px">Условие<select data-field="condition"><option value="damaged">Выбранная цель повреждена</option><option value="low_health">У своего игрока меньше 10 здоровья</option></select></label>'+sub('then')+sub('else'):e.type==='foreach'?sub('effects'):'')+'</div>';
}
function readEffect(el){
  const field=(name,fallback='')=>el.querySelector(':scope > .effect-fields [data-field="'+name+'"]')?.value??fallback;
  const type=el.querySelector(':scope > .row [data-field="type"]').value,destination=field('destination','controller');
  const target=destination==='selected'?{selected:'victim'}:destination==='item'?{type:'item',name:'item'}:['controller','opponent','source','attached_to'].includes(destination)?{context:destination}:{selector:destination};
  const expression=field('expression'),n=Number(field('amount','1'));
  const amount=expression==='attack'?{type:'coalesce',value:{type:'read_property',object:{context:'source'},property:'attack',read:'effective'},fallback:{type:'read_property',object:{context:'sourceSnapshot'},property:'attack',read:'snapshot'}}:expression==='enemies'?{type:'count',items:{selector:'all_enemy_creatures'}}:expression==='deaths'?{type:'count',items:{type:'read_event',field:'deaths'}}:n;
  const original=JSON.parse(el.dataset.original||'{}');if(!el.dataset.dirty)return original;
  const e={...original,type};
  if(type==='if'){e.condition=el.querySelector(':scope > label [data-field="condition"]').value==='low_health'?{type:'less',left:{type:'read_property',object:{context:'controller'},property:'health',read:'effective'},right:10}:{type:'is_damaged',object:{selected:'victim'}};for(const k of ['then','else'])e[k]=[...el.querySelector(':scope > [data-branch="'+k+'"]').children].filter(x=>x.matches('.effect-block')).map(readEffect);return e;}
  if(type==='foreach'){e.items={selector:'all_enemy_creatures'};e.as='item';e.effects=[...el.querySelector(':scope > [data-branch="effects"]').children].filter(x=>x.matches('.effect-block')).map(readEffect);return e;}
  if(type==='let')return {type,name:'count',value:{type:'count',items:{selector:'all_enemy_creatures'}}};
  if(['draw','exile_top','gain_resource'].includes(type))e.player=target;else if(!['create_token'].includes(type))e.target=target;
  if(!['destroy','counter_spell','grant_ability','suppress_ability','return_to_battlefield','modify_keyword','gain_resource'].includes(type))e.amount=amount;
  if(['modify_stat','modify_keyword','apply_effect_token','grant_ability','suppress_ability'].includes(type))e.duration={type:field('duration','until_end_of_turn')};
  if(type==='modify_stat')e.stat=field('stat','attack');
  if(type==='modify_keyword'){e.keyword=field('keyword','flying');e.operation=field('operation','grant');}
  if(type==='create_token'){e.tokenRef=field('definition');e.controller={context:'controller'};}
  if(['apply_effect_token','remove_effect_token','suppress_ability'].includes(type))e.definitionId=field('definition');
  if(type==='grant_ability')e.ability={ref:field('definition')};
  if(type==='return_to_battlefield')e.controller={context:'controller'};
  if(type==='gain_resource')e.resources={[field('resource')]:amount};
  return e;
}
function currentEffects(){return editor.effects?.length?editor.effects:editor.abilities?.find(a=>a.effects)?.effects||[];}
function renderEditor(){
  const t=cardType(editor)||content.cardTypes['types:creature'],behavior=editor.abilities?.find(a=>a.kind&&!a.ref),kind=behavior?.kind==='activated'?'activated':behavior?.kind==='continuous'?'continuous':behavior?.trigger||'on_resolve';
  return '<div class="page-head"><div><span class="eyebrow">ИДЕЯ → КАРТА → ПАРТИЯ</span><h1>Мастерская</h1></div><div class="toolbar"><button id="new-draft">Новая карта</button><button id="definitions">Типы и определения</button><button id="advanced-json">JSON</button></div></div><div class="editor-layout"><section class="panel"><div class="form-grid"><label>Название<input id="ed-name" value="'+esc(editor.name)+'"></label><label>Идентификатор<input id="ed-id" value="'+esc(editor.id)+'"></label><label>Тип карты<select id="ed-type">'+selectOptions(Object.values(content.cardTypes).filter(t=>!t.abstract).map(t=>[t.id,t.name]),editor.typeId)+'</select></label><label>Подтипы через запятую<input id="ed-subtypes" value="'+esc((editor.subtypes||[]).join(', '))+'" placeholder="dragon, beast"></label><label>Любой ресурс<input id="ed-cost" type="number" min="0" value="'+(editor.cost?.generic||0)+'"></label><div class="form-grid">'+Object.values(content.resources).map(r=>'<label>'+esc(r.name)+'<input data-cost-resource="'+esc(r.id)+'" type="number" min="0" value="'+(editor.cost?.resources?.[r.id]??(t.play.method==='source_deploy'?editor.abilities?.find(a=>a.kind==='resource_activated')?.productionOptions?.[0]?.resources?.[r.id]:0)??0)+'"></label>').join('')+'</div>'+(['attack','health','armor','power_meter'].filter(k=>t.components[k]).map(k=>{const field=k==='power_meter'?'power':k;return '<label>'+({attack:'Атака',health:'Здоровье',armor:'Броня',power:'Сила'}[field])+'<input id="ed-'+field+'" type="number" min="0" value="'+(editor[field]??(field==='health'?3:2))+'"></label>';}).join(''))+'<label class="wide">Описание<input id="ed-text" value="'+esc(editor.text||'')+'" placeholder="Можно оставить пустым: описание составится из эффектов"></label><div class="wide checks">'+Object.entries(keywordNames).map(([id,label])=>'<label><input type="checkbox" data-keyword="'+id+'" '+(editor.keywords?.includes(id)?'checked':'')+'>'+label+'</label>').join('')+'</div></div><div class="section-gap"><h3>Способности</h3><div class="form-grid"><label>Когда выполняется<select id="ed-kind">'+selectOptions([['on_resolve','При разрешении карты'],['on_enter','При входе на поле'],['on_death','При гибели'],['card_drawn','При доборе карты'],['creature_entered','При входе любого существа'],['creature_attacked','При атаке существа'],['turn_start','При начале хода'],['turn_end','При конце хода'],['activated','По активации'],['continuous','Постоянная аура']],kind)+'</select></label><label>Выбираемая цель<select id="ed-target">'+selectOptions(targetOptions,(editor.targets||behavior?.targets)?.[0]?.selector||'none')+'</select></label><label>Цена активации (ресурс)<input id="ed-activation-cost" type="number" min="0" value="'+(behavior?.costs?.find(c=>c.type==='spend_resource')?.generic||0)+'"></label><label>Цена активации (жизни)<input id="ed-life-cost" type="number" min="0" value="'+(behavior?.costs?.find(c=>c.type==='pay_life')?.amount||0)+'"></label><label class="checks"><span><input id="ed-tap" type="checkbox" '+(behavior?.costs?.some(c=>c.type==='tap')?'checked':'')+'> Поворот как стоимость</span></label><label class="checks"><span><input id="ed-sacrifice" type="checkbox" '+(behavior?.costs?.some(c=>c.type==='sacrifice')?'checked':'')+'> Жертва другого своего существа</span></label><label>Библиотечная способность<select id="ed-library"><option value="">Не добавлять</option>'+selectOptions(Object.values(content.abilities).map(a=>[a.id,a.name]),editor.abilities?.find(a=>a.ref)?.ref)+'</select></label><label>Фильтр цели<select id="ed-filter"><option value="">Без фильтра</option><option value="is_damaged">Только повреждённая цель</option></select></label></div><div id="aura-fields" class="'+(kind==='continuous'?'':'hidden')+' effect-block"><p class="hint">Аура пересчитывается, пока источник на поле. Новые подходящие существа также получают её.</p><div class="form-grid"><label>Получатели<select id="aura-selector">'+selectOptions([['other_friendly_creatures','Другие свои существа'],['all_friendly_creatures','Все свои существа'],['all_enemy_creatures','Все вражеские существа'],['self','Сам источник'],['attached_host','Носитель чар']],behavior?.modifiers?.[0]?.selector||'other_friendly_creatures')+'</select></label><label>Атака<input id="aura-attack" type="number" value="'+(behavior?.modifiers?.[0]?.attack??1)+'"></label><label>Здоровье<input id="aura-health" type="number" value="'+(behavior?.modifiers?.[0]?.health??1)+'"></label><label>Выдать способность<select id="aura-ability"><option value="">Без выдачи</option>'+selectOptions(Object.values(content.abilities).map(a=>[a.id,a.name]),behavior?.modifiers?.find(m=>m.operation==='grant_ability')?.ability?.ref)+'</select></label></div></div><div id="effect-list">'+currentEffects().map(effectEditor).join('')+'</div><button id="add-effect" class="section-gap">+ Добавить блок эффекта</button><div class="row section-gap"><button id="add-independent">Сохранить как отдельную активацию</button><span class="small muted">'+(editor.abilities?.length||0)+' способностей в карте</span></div></div><div id="editor-errors" class="section-gap"></div><div class="row section-gap"><button id="save-draft" class="primary">Проверить и сохранить</button><button id="test-card">Испытать</button><button id="export-card">Экспорт ↓</button></div></section><aside><div class="panel"><span class="eyebrow">ПРЕДПРОСМОТР</span><div class="editor-preview">'+cardHTML(editor)+'</div><p class="hint">Обычные карты собираются из полей и блоков. Для полного редактирования сложного определения доступен JSON.</p></div><div class="panel section-gap"><h3>Локальные черновики</h3><div class="deck-list">'+drafts.map(d=>'<div class="deck-row"><span>'+esc(d.name)+'</span><button data-edit-draft="'+esc(d.id)+'">Открыть</button></div>').join('')+'</div><button id="import-editor" class="main-action">Импорт набора</button></div><div class="workshop-note">Разовый жетон остаётся на получателе независимо от карты, которая его выдала. Аура действует только при активном источнике — это разные механики.</div></aside></div>';
}
function collectEditor(){
  if(!editorWasEdited)return structuredClone(editor);
  const val=id=>app.querySelector('#'+id)?.value,checked=id=>!!app.querySelector('#'+id)?.checked;
  const d={id:val('ed-id'),name:val('ed-name'),typeId:val('ed-type'),subtypes:val('ed-subtypes').split(',').map(s=>s.trim()).filter(Boolean),keywords:[...app.querySelectorAll('[data-keyword]:checked')].map(e=>e.dataset.keyword),abilities:[]};
  const t=content.cardTypes[d.typeId],resources={};
  for(const input of app.querySelectorAll('[data-cost-resource]'))if(Number(input.value))resources[input.dataset.costResource]=Number(input.value);
  if(t.play.method==='cast')d.cost={generic:Number(val('ed-cost')),...(Object.keys(resources).length?{resources}:{})};
  for(const [comp,field]of [['health','health'],['attack','attack'],['armor','armor'],['power_meter','power']])if(t.components[comp])d[field]=Number(val('ed-'+field)||0);
  if(val('ed-text'))d.text=val('ed-text');
  const effects=[...app.querySelector('#effect-list').children].map(readEffect),kind=val('ed-kind'),selector=val('ed-target');
  const targets=selector==='none'?[]:[{id:'victim',selector,count:1,...(val('ed-filter')?{filter:{type:'is_damaged',object:{context:'candidate'}}}:{})}];
  if(t.play.method==='source_deploy')d.abilities=[{id:'produce',kind:'resource_activated',costs:[{type:'tap',object:{context:'source'}}],productionOptions:[{id:'one',resources:Object.keys(resources).length?resources:{'duality:light':1}}]}];
  else if(kind==='on_resolve'){if(effects.length)d.effects=effects;if(targets.length)d.targets=targets;}
  else if(kind==='continuous'){
    const m=[{id:'stats',selector:val('aura-selector'),operation:'add_stats',attack:Number(val('aura-attack')),health:Number(val('aura-health'))}];
    if(val('aura-ability'))m.push({id:'grant',selector:val('aura-selector'),operation:'grant_ability',ability:{ref:val('aura-ability')}});
    d.abilities.push({id:'aura',kind:'continuous',activeZones:['battlefield'],modifiers:m});
  }else {
    const a={id:kind==='activated'?'activation':'reaction',kind:kind==='activated'?'activated':'triggered',effects,...(targets.length?{targets}:{})};
    if(kind==='activated'){
      a.speed='fast';a.costs=[];
      if(Number(val('ed-activation-cost')))a.costs.push({type:'spend_resource',generic:Number(val('ed-activation-cost'))});
      if(Number(val('ed-life-cost')))a.costs.push({type:'pay_life',amount:Number(val('ed-life-cost'))});
      if(checked('ed-tap'))a.costs.push({type:'tap',object:{context:'source'}});
      if(checked('ed-sacrifice'))a.costs.push({id:'offering',type:'sacrifice',selector:'friendly_creature',excludeSource:true,count:1});
    }else a.trigger=kind;
    d.abilities.push(a);
  }
  if(val('ed-library'))d.abilities.push({id:'library',ref:val('ed-library')});
  if(t.components.attachment)d.attachTo=editor.attachTo||{selector:'friendly_permanent',filter:{type:'has_capability',object:{context:'candidate'},capability:'health',read:'base'}};
  const form=app.querySelector('.editor-layout>section');
  if(form.dataset.behaviorDirty!=='true'&&!(t.play.method==='source_deploy'&&form.dataset.productionDirty==='true')){
    for(const field of ['abilities','effects','targets','attachTo','afterResolve','activationGroups','tags','colors']){
      if(editor[field]!==undefined)d[field]=structuredClone(editor[field]);else delete d[field];
    }
    return d;
  }
  const originalLibrary=editor.abilities?.find(a=>a.ref);
  const newLibrary=d.abilities.find(a=>a.ref);
  if(newLibrary&&originalLibrary?.ref===newLibrary.ref)Object.assign(newLibrary,structuredClone(originalLibrary));
  const primary=(editor.abilities||[]).find(a=>a.kind&&!a.id?.startsWith('extra_'));
  if(primary&&d.abilities[0]&&!d.abilities[0].ref){d.abilities[0]={...primary,...d.abilities[0],id:primary.id};}
  const preserved=(editor.abilities||[]).filter(a=>a!==primary&&a!==originalLibrary&&!d.abilities.some(x=>x.id===a.id));d.abilities.push(...preserved);
  for(const field of ['tags','colors','activationGroups','afterResolve'])if(editor[field]!==undefined)d[field]=structuredClone(editor[field]);
  return d;
}
function checkDraft(d){
  const next=structuredClone(raw),i=next.cards.findIndex(c=>c.id===d.id);if(i>=0)next.cards[i]=d;else next.cards.push(d);
  return {raw:next,content:C.validateContent(next)};
}
function saveDraft(){
  try{const d=collectEditor(),next=checkDraft(d);editor=d;editorWasEdited=false;raw=next.raw;content=next.content;drafts=drafts.filter(x=>x.id!==d.id);drafts.push(d);writeLocal('drafts',drafts);writeLocal('content',raw);toast('Карта проверена и сохранена.');render();return true;}
  catch(e){app.querySelector('#editor-errors').innerHTML='<div class="error">'+esc(e.message)+'</div>';return false;}
}
function bindEditor(){
  const form=app.querySelector('.editor-layout>section');
  for(const event of ['input','change'])form.addEventListener(event,e=>{editorWasEdited=true;
    if(e.target.closest('.effect-block')||['ed-kind','ed-target','ed-activation-cost','ed-life-cost','ed-tap','ed-sacrifice','ed-library','ed-filter'].includes(e.target.id))form.dataset.behaviorDirty='true';
    if(e.target.dataset.costResource)form.dataset.productionDirty='true';
    let block=e.target.closest('.effect-block');while(block){block.dataset.dirty='true';block=block.parentElement?.closest('.effect-block');}},true);
  app.querySelector('#ed-kind').onchange=()=>{app.querySelector('#aura-fields').classList.toggle('hidden',app.querySelector('#ed-kind').value!=='continuous');};
  app.querySelector('#ed-type').onchange=()=>{editor=collectEditor();render();};
  app.querySelector('#add-effect').onclick=()=>{editorWasEdited=true;form.dataset.behaviorDirty='true';app.querySelector('#effect-list').insertAdjacentHTML('beforeend',effectEditor({type:'damage',target:{selected:'victim'},amount:1},99));bindEffectControls();};
  bindEffectControls();
  app.querySelector('#save-draft').onclick=saveDraft;
  app.querySelector('#add-independent').onclick=()=>{try{const d=collectEditor(),a=d.abilities.find(a=>a.kind==='activated');if(!a)return toast('Сначала выберите «По активации».');a.id='extra_'+Date.now();editor={...d,abilities:[...d.abilities.filter(x=>x.id.startsWith('extra_')),a]};toast('Активация добавлена. Настройте следующую или сохраните карту.');render();}catch(e){toast(e.message);}};
  app.querySelector('#new-draft').onclick=()=>{editor={id:'custom:card_'+Date.now(),name:'Новая карта',typeId:'types:creature',cost:{generic:2},attack:2,health:3,abilities:[]};render();};
  app.querySelector('#test-card').onclick=()=>{if(saveDraft())testCardDialog();};
  app.querySelector('#export-card').onclick=()=>{if(saveDraft())download('magiccards-'+editor.id.replace(':','-')+'.json',{format:'magiccards-pack',version:1,content:raw,scenarios:exportScenarios()});};
  app.querySelector('#advanced-json').onclick=()=>{editor=collectEditor();editorWasEdited=false;modal('JSON определения','<p class="hint">При применении выполняется тот же валидатор, что перед матчем.</p><textarea id="raw-card" style="min-height:370px">'+esc(JSON.stringify(editor,null,2))+'</textarea><div id="raw-error"></div>','<button class="primary" id="apply-raw">Проверить и применить</button>');dialog.querySelector('#apply-raw').onclick=()=>{try{const d=JSON.parse(dialog.querySelector('#raw-card').value);checkDraft(d);editor=d;editorWasEdited=false;dialog.close();render();}catch(e){dialog.querySelector('#raw-error').textContent=e.message;}};};
  app.querySelector('#definitions').onclick=definitionsDialog;
  app.querySelector('#import-editor').onclick=importPack;
  for(const el of app.querySelectorAll('[data-edit-draft]'))el.onclick=()=>{editor=structuredClone(drafts.find(d=>d.id===el.dataset.editDraft));editorWasEdited=false;render();};
}
function bindEffectControls(){
  for(const b of app.querySelectorAll('[data-remove-block]'))b.onclick=()=>{editorWasEdited=true;app.querySelector('.editor-layout>section').dataset.behaviorDirty='true';b.closest('.effect-block').remove();};
  for(const b of app.querySelectorAll('[data-add-branch]'))b.onclick=()=>{editorWasEdited=true;app.querySelector('.editor-layout>section').dataset.behaviorDirty='true';b.closest('.effect-block').dataset.dirty='true';b.previousElementSibling.insertAdjacentHTML('beforeend',effectEditor({type:'damage',target:{context:'opponent'},amount:1},0));bindEffectControls();};
  for(const select of app.querySelectorAll('[data-field="type"]'))select.onchange=()=>{const el=select.closest('.effect-block'),type=select.value;el.outerHTML=effectEditor({type,amount:1,target:{selected:'victim'},then:[],else:[],effects:[]},0);bindEffectControls();};
}
function testCardDialog(){
  modal('Испытать карту','<p class="muted">Сценарий даёт карту в руку и заданные ресурсы. Партия с ботом использует обычную перемешанную колоду.</p><div class="form-grid"><label>Режим<select id="trial-mode"><option value="scenario">Сценарий с открытой настройкой</option><option value="match">Полная партия с ботом</option></select></label><label>Ресурс в сценарии<input id="trial-resource" type="number" value="10" min="0" max="100"></label><label>Фаза<select id="trial-phase">'+selectOptions([['MAIN_1','Первая основная'],['MAIN_2','Вторая основная'],['COMBAT_BEGIN','Перед атакой']],'MAIN_1')+'</select></label><label>Существа на каждой стороне<input id="trial-units" type="number" value="1" min="0" max="6"></label></div>','<button class="primary" id="start-trial">Испытать</button>');
  dialog.querySelector('#start-trial').onclick=()=>{
    try{
      const econ=Object.keys(editor.cost?.resources||{}).some(k=>k!=='core:energy')?'deck_sources':'automatic_growth';economy=econ;
      if(dialog.querySelector('#trial-mode').value==='match'){
        workingDeck=baseDeck();const replace=workingDeck.find(id=>cardType(content.cards[id]).play.method==='cast');for(let i=0;i<2;i++){const at=workingDeck.indexOf(replace);if(at>=0)workingDeck[at]=editor.id;}
        const next=E.createGame({presetId:preset(),decks:{p1:workingDeck}},content,Math.floor(Math.random()*1e6)+1);mode='bot';viewer='p1';setGame(next);
      }else{
        const n=Number(dialog.querySelector('#trial-resource').value),u=Number(dialog.querySelector('#trial-units').value),pools=econ==='deck_sources'?{'duality:light':n,'duality:dark':n}:{'core:energy':n};
        const fixture={presetId:preset(),phase:dialog.querySelector('#trial-phase').value,players:{p1:{pool:{...pools},capacity:n},p2:{pool:{...pools},capacity:n}},hand:{p1:[editor.id]},board:{p1:Array(u).fill('core:recruit'),p2:Array(u).fill('core:sentinel')},deck:{p1:Array(10).fill('core:recruit'),p2:Array(10).fill('core:recruit')}};
        setGame(E.loadFixture(fixture,content));mode='local';viewer='p1';handOff=false;
      }
      tab='play';dialog.close();render();scheduleBot();
    }catch(e){toast(e.message);}
  };
}
function definitionsDialog(){
  modal('Типы и переиспользуемые определения','<p class="hint">Новые типы собираются из известных компонентов. Новую физику игры описывает ядро.</p><label>Что создать<select id="definition-kind"><option value="cardTypes">Тип карты</option><option value="resources">Ресурс</option><option value="effectTokens">Жетон эффекта / маркер</option><option value="abilities">Библиотечная способность из текущих блоков</option><option value="tokens">Фишка из текущей карты</option></select></label><div class="form-grid section-gap"><label>Идентификатор<input id="definition-id" value="custom:new_type"></label><label>Название<input id="definition-name" value="Новое определение"></label><label>Базовый тип<select id="definition-base">'+selectOptions(Object.values(content.cardTypes).filter(t=>!t.abstract).map(t=>[t.id,t.name]),'types:creature')+'</select></label><label>Хранение ресурса<select id="definition-policy"><option value="step_end">До конца шага</option><option value="owner_turn_start">До начала своего хода</option><option value="persistent">Постоянно</option></select></label><label>Бонус атаки жетона<input id="definition-attack" type="number" value="0"></label><label>Бонус здоровья жетона<input id="definition-health" type="number" value="0"></label><label class="checks"><span><input id="definition-armor" type="checkbox"> Добавить броню типу</span></label><label>Свойство жетона<select id="definition-keyword"><option value="">Нет</option>'+selectOptions(Object.entries(keywordNames),'')+'</select></label></div><p class="hint">Броня требует damageable; атака и блок — здоровье, атаку, exhaustion и место unit. Наследование сохраняет зависимости выбранного типа. Жетон с нулевыми бонусами и без свойства — пустой маркер для оплаты.</p><div id="definition-error"></div>','<button class="primary" id="create-definition">Создать и проверить</button>');
  dialog.querySelector('#create-definition').onclick=()=>{
    try{
      const get=id=>dialog.querySelector('#definition-'+id).value,kind=get('kind'),d={id:get('id'),name:get('name')};
      if(kind==='cardTypes'){d.extends=get('base');d.components={};if(dialog.querySelector('#definition-armor').checked)d.components.armor={};}
      if(kind==='resources')d.poolPolicy=get('policy');
      if(kind==='tokens'){Object.assign(d,collectEditor(),{id:d.id,name:d.name});delete d.cost;delete d.targets;delete d.effects;}
      if(kind==='abilities'){
        const card=collectEditor(),behavior=card.abilities.find(a=>a.kind)||{id:'resolve',kind:'on_resolve',effects:card.effects||[]};
        d.stacking='per_source';d.parameters={};d.hostRequirements={all:behavior.kind==='on_resolve'?['one_shot','ability_host']:['permanent','ability_host']};d.activeZones=behavior.kind==='on_resolve'?['stack']:['battlefield'];d.behaviors=[behavior];
      }
      if(kind==='effectTokens'){
        d.components=[];d.hostRequirements={all:['permanent','effect_token_host']};
        for(const [stat,input]of [['attack','attack'],['max_health','health']])if(Number(get(input))){d.components.push({id:stat,kind:'stat',stat,amount:Number(get(input))});d.hostRequirements.all.push(stat==='max_health'?'health':stat);}
        if(get('keyword')){d.components.push({id:'keyword',kind:'keyword',operation:'grant',keyword:get('keyword')});d.hostRequirements.all.push('ability_host');}
      }
      const next=structuredClone(raw);next[kind].push(d);const compiled=C.validateContent(next);raw=next;content=compiled;writeLocal('content',raw);dialog.close();toast('Определение создано.');render();
    }catch(e){dialog.querySelector('#definition-error').innerHTML='<div class="error">'+esc(e.message)+'</div>';}
  };
}
function renderRules(){
  const rules=[['01','Развивайте поле','У каждого игрока 20 здоровья и колода из 24 карт. В основной фазе разыгрывайте существ. По умолчанию ресурс приходит из карт-источников: один источник можно выложить за ход. Нажмите на него и активируйте производство.'],['02','Ресурс живёт до конца шага','Свет и Тьма исчезают при переходе к следующему шагу. Производите их в том же окне, в котором планируете тратить. В альтернативном режиме энергия растёт на 1 в начале своего хода.'],['03','Передавайте приоритет','После своей карты вы сохраняете приоритет. Первый пас даёт сопернику ответить. Второй пас разрешает только верхнюю карту стека. Когда стек пуст, два паса переводят игру к следующему шагу.'],['04','Быстрые ответы','Быстрые карты доступны и в чужой ход, когда у вас приоритет. Ответ может отменить карту, вылечить цель или усилить существо перед боевым уроном. Отмена тоже может быть отменена.'],['05','Атакуйте и блокируйте','Выберите готовых атакующих и подтвердите список. Противник назначает по одному защитнику. Блок не поворачивает существо; новые существа могут блокировать сразу. Полёт требует Полёта или Захвата у блокирующего.'],['06','Создавайте свои карты','В мастерской выберите тип, стоимость, характеристики и блоки эффектов. Проверьте карту, испытайте в сценарии или партии с ботом, затем экспортируйте набор. Действующая партия не меняется при редактировании.']];
  return '<div class="page-head"><div><span class="eyebrow">ПРАВИЛА ПРОТОТИПА</span><h1>Ваш первый ход</h1></div><button id="new-game" class="primary">Начать партию</button></div><div class="rule-grid">'+rules.map(([n,h,p])=>'<section class="panel"><div class="num">'+n+'</div><h2 style="font-size:22px">'+h+'</h2><p>'+p+'</p></section>').join('')+'</div><div class="panel section-gap"><h3>Короткие напоминания</h3><p class="hint">Существа начинают атаковать со следующего своего хода. Отмеченный урон снимается в конце общего хода. Исчезнувший блокирующий не открывает урон игроку. При пустой колоде добор наносит возрастающую усталость. Жетон эффекта и постоянная аура — разные источники изменения характеристик. Сила и броня не восстанавливаются обычным лечением.</p></div>';
}
async function boot(){
  try{
    const response=await fetch(new URL('../../content.json',import.meta.url));if(!response.ok)throw new Error('Не удалось загрузить content.json');official=await response.json();
    try{raw=readLocal('content',null)||official;drafts=readLocal('drafts',[]);}catch(e){raw=official;toast(e.message);}
    for(const [kind,defs]of Object.entries(official))if(Array.isArray(defs)&&Array.isArray(raw[kind]))for(const def of defs)if(!raw[kind].some(d=>(d.id||d.presetId)===(def.id||def.presetId)))raw[kind].push(structuredClone(def));
    try{content=C.validateContent(raw);}catch(e){raw=official;content=C.validateContent(raw);toast('Локальный набор не прошёл проверку. Загружен исходный каталог.');}
    try{const saved=readLocal('deck',null);economy=saved?.economy||'deck_sources';workingDeck=saved?.cards||baseDeck();}catch{workingDeck=baseDeck();}
    worker=new Worker(new URL('../bot/worker.mjs',import.meta.url),{type:'module'});
    worker.onmessage=event=>{
      const d=event.data,expected=botRequest;
      if(!expected||d.epoch!==expected.epoch||d.revision!==expected.revision||d.decisionId!==expected.decisionId||epoch!==expected.epoch||!game||who()!=='p2'||mode!=='bot'||game.revision!==expected.revision)return;
      clearTimeout(botTimer);botBusy=false;botRequest=null;
      if(d.error||!d.command){toast('Бот использует резервное действие.');botFallback();return;}
      if(!dispatch(d.command))botFallback();
    };
    worker.onerror=()=>{if(botRequest&&botRequest.epoch===epoch){toast('Не удалось выполнить решение бота. Выполнено резервное действие.');botFallback();}};
    render();
  }catch(e){app.innerHTML='<main class="boot"><h1>Не удалось открыть игру</h1><p class="error">'+esc(e.message)+'</p><p>Запустите сборку и локальный сервер по инструкции в README.md.</p></main>';}
}
boot();
