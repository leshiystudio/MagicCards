// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 MagicCards contributors

const PREFIX='magiccards:v1:';
export function readLocal(key,fallback){try{const value=localStorage.getItem(PREFIX+key);return value?JSON.parse(value):fallback;}catch(error){throw new Error('Не удалось прочитать локальные данные: '+error.message);}}
export function writeLocal(key,value){try{localStorage.setItem(PREFIX+key,JSON.stringify(value));}catch(error){throw new Error('Не удалось сохранить данные. Экспортируйте файл: '+error.message);}}
export function download(name,value){const blob=new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export async function importJSON(){return new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.onchange=async()=>{try{const file=input.files[0];if(!file)return resolve(null);if(file.size>5*1024*1024)throw new Error('Файл больше 5 МБ');resolve(JSON.parse(await file.text()));}catch(error){resolve({importError:error.message});}};input.oncancel=()=>resolve(null);input.click();});}
