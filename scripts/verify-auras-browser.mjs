import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { WasmEngine } from '../web/dist/engine.js';
import { PLAY_RULES } from '../web/dist/rules.js';

const engine=await WasmEngine.fromBytes(await readFile('web/dist/engine.wasm'));
const call=request=>{const result=engine.call(request);assert.equal(result.ok,true,result.error);return result.value;};
const move=(side,piece,to,choice='none')=>({type:'move',side,piece,to,choice});
call({cmd:'new',rules:PLAY_RULES,position:{pieces:[{id:'AK',side:'A',kind:'K',at:[9,9]},
  {id:'BK',side:'B',kind:'K',at:[9,1]},{id:'AR',side:'A',kind:'R',at:[5,4]}]}});
for(const action of [move('A','AR',[5,3],'upgrade'),move('B','BK',[8,1]),move('A','AR',[5,4]),move('B','BK',[9,1])])call({cmd:'submit',side:action.side,action});
const tired=call({cmd:'export'});
for(const action of [move('A','AK',[8,9]),move('B','BK',[8,1])])call({cmd:'submit',side:action.side,action});
const recovered=call({cmd:'export'});
for(const action of [move('A','AR',[5,7]),move('B','BK',[9,1])])call({cmd:'submit',side:action.side,action});
const recoveredHome=call({cmd:'export'});
const folder=await mkdtemp(resolve('artifacts/aura-browser-'));
await mkdir(resolve('artifacts/screenshots'),{recursive:true});
const app=await createApplication({dataDir:join(folder,'rooms')});
await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
let browser;
try {
  const executablePath=process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser=await chromium.launch({...(executablePath?{executablePath}:{}),headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('shogi-settings',JSON.stringify({reduced:true,sound:false})));
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.locator('#mode-local').click();await page.locator('#start-game').click();
  await expect(page.locator('#board .rank-boosted')).toHaveCount(40);
  async function load(replay) {
    await page.locator('#replay-file').setInputFiles({name:'aura.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(replay))});
    await expect(page.locator('#menu-open')).toBeEnabled();
    await expect(page.locator('#replay-panel')).toBeVisible();
  }
  await load(tired);
  await page.locator('#replay-round').selectOption('2');
  await expect(page.locator('#stage-label')).toHaveText('開始局面');
  await expect(page.locator('[data-piece="AR"].rank-boosted')).toHaveCount(0);
  await expect(page.locator('[data-piece="AR"] .rank-badge')).toHaveText('7');
  await page.locator('#return-live').click();
  await expect(page.locator('[data-piece="AR"].rank-reduced')).toHaveCount(1);
  await expect(page.locator('[data-piece="AR"] .rank-badge')).toHaveText('6');
  const purple=await page.locator('[data-piece="AR"]').evaluate(piece=>({filter:getComputedStyle(piece).filter,opacity:getComputedStyle(piece.querySelector('.piece-aura')).opacity}));
  assert.match(purple.filter,/119, 49, 183/);assert.ok(Number(purple.opacity)>0);
  await page.screenshot({path:resolve('artifacts/screenshots/aura-purple-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve('artifacts/screenshots/aura-purple-mobile.png'),fullPage:true});
  await load(recovered);await page.locator('#return-live').click();
  await expect(page.locator('[data-piece="AR"].rank-boosted')).toHaveCount(0);
  await expect(page.locator('[data-piece="AR"].rank-reduced')).toHaveCount(0);
  await expect(page.locator('[data-piece="AR"] .rank-badge')).toHaveText('7');
  await load(recoveredHome);await page.locator('#return-live').click();
  await expect(page.locator('[data-piece="AR"].rank-boosted')).toHaveCount(1);
  await expect(page.locator('[data-piece="AR"] .rank-badge')).toHaveText('8');
  await expect(page.locator('[data-piece="AR"].rank-reduced')).toHaveCount(0);
  const blue=await page.locator('[data-piece="AR"]').evaluate(piece=>getComputedStyle(piece).filter);
  assert.match(blue,/48, 133, 244/);
  await page.screenshot({path:resolve('artifacts/screenshots/aura-recovered-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('Aura browser checks passed: blue home defense, correct round-start rank, purple second-move fatigue, blue recovery, actual CSS colors and mobile fit.');
} finally {await browser?.close();await app.close();}
