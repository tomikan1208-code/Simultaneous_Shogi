import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createDashboard, sourceFingerprint, root } from '../dashboard/server.mjs';
import { readLineage, readGenerationHistory, runId } from '../dashboard/history.mjs';
import { generationStats, summarizeRecords, learningSnapshot } from '../dashboard/web/metrics.js';
import { WasmEngine } from '../web/dist/engine.js';
import { PLAY_RULES } from '../web/dist/rules.js';

const baseFolder=resolve(root,'.cache/history-tests');await mkdir(baseFolder,{recursive:true});
const temporary=await mkdtemp(join(baseFolder,'test-'));
const json=async(path,value)=>{await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,JSON.stringify(value));};
const config=JSON.parse(await readFile(join(root,'training/config.json'),'utf8'));
Object.assign(config,{device:'cpu',games_per_generation:2,environments:2,balance:PLAY_RULES.balance,balance_logging:true});
const record=(generation,games=2)=>({generation,timestamp:100+generation,seconds:3,
  self_play:{games,rounds:games*10,seconds:2,new_samples:20,history_games:0,events:{},search:{policy_seconds:.1,preview_seconds:.1,value_seconds:.1,solver_seconds:.1,cells:20,unique_leaves:10},outcomes:Array.from({length:games},()=>({winner:'draw',reason:'repetition'}))},
  optimization:{policy_loss:generation/10,value_loss:generation/100,updates:2,presentations:16},evaluation:[],promoted:false,replay_size:20});
let runs=join(temporary,'runs'), selected, app, browser;
try {
  if(process.argv.includes('--main-run')) {
    runs=join(root,'dashboard/runs');
    selected=runId(await (await import('node:fs/promises')).realpath(join(runs,'continued-1792501129163')));
  } else {
    const parent=join(runs,'parent'),child=join(runs,'child');
    const checkpoint=Buffer.from('Synthetic checkpoint used only for lineage identity tests');
    const source=await sourceFingerprint();
    const manifest={format:'simultaneous-shogi/training-v1',schema:'simultaneous-shogi/net-v2-62x24',name:'history fixture',created:100,
      generation:2,source_fingerprint:source,rules_hash:'a'.repeat(64),rules:PLAY_RULES,config,hardware:{device:'cpu'},
      champion_generation:2,champion_checkpoint:'checkpoints/g0002.pt',latest_checkpoint:'checkpoints/g0002.pt',replay_file:'replay/g0002.npz',rng_file:'replay/g0002.rng.json'};
    await json(join(parent,'manifest.json'),manifest);
    await mkdir(join(parent,'checkpoints'),{recursive:true});await writeFile(join(parent,'checkpoints/g0002.pt'),checkpoint);
    for(const generation of [1,2,3])await json(join(parent,`generations/g${String(generation).padStart(4,'0')}.json`),record(generation));
    const p={kind:'state_continuation',run:parent,checkpoint:'checkpoints/g0002.pt',generation:2,source_fingerprint:source,sha256:createHash('sha256').update(checkpoint).digest('hex')};
    const childConfig={...config,games_per_generation:4,environments:3};
    const childManifest={...manifest,name:'continued fixture',created:200,generation:3,config:childConfig,parent:p};
    await json(join(child,'manifest.json'),childManifest);
    await json(join(child,'generations/g0003.json'),record(3,4));await json(join(child,'generations/g0004.json'),record(4,999));
    await json(join(child,'status.json'),{phase:'stopped',generation:3,updated:200,device:'cpu'});
    const engine=await WasmEngine.fromBytes(await readFile(join(root,'web/dist/engine.wasm')));
    const call=arg=>{const result=engine.call(arg);assert.equal(result.ok,true,result.error);return result.value;};
    call({cmd:'new',rules:PLAY_RULES});
    for(const side of ['A','B'])call({cmd:'submit',side,action:call({cmd:'actions',side})[0].action});
    await json(join(parent,'games/g0002-000.json'),{generation:2,replay:call({cmd:'export'})});
    selected=runId(child);
    const run={id:selected,dir:child,manifest:childManifest};
    const valid=await readLineage(run,[runs]);
    assert.equal(valid.lineage.length,2);assert.deepEqual(valid.warnings,[]);
    const history=await readGenerationHistory(valid.lineage);
    assert.deepEqual(history.map(r=>r.generation),[1,2,3],'Parent and child uncommitted records stay excluded');
    assert.equal(history[0].config.games_per_generation,2);assert.equal(history[2].config.games_per_generation,4);
    assert.equal(summarizeRecords(history).games,8);assert.equal(summarizeRecords(history).drawRate,1);
    assert.equal(generationStats({self_play:{games:4,rounds:40},optimization:{}}).drawRate,null,'Missing outcomes are not zero draws');
    assert.equal(learningSnapshot(history).recent.generations,1,'Budget changes start a separate analysis window');
    const wrong=await readLineage({...run,manifest:{...childManifest,parent:{...p,sha256:'b'.repeat(64)}}},[runs]);
    assert.equal(wrong.lineage.length,1);assert.equal(wrong.warnings.length,1);
    const outside=await readLineage(run,[child]);assert.equal(outside.lineage.length,1,'An ancestor outside allowed roots is never read');
    const different=await readLineage({...run,manifest:{...childManifest,rules_hash:'c'.repeat(64)}},[runs]);
    assert.equal(different.lineage.length,1,'Different rules never share a history graph');
  }
  const settings=join(temporary,'local.json');
  const savedSettings=process.argv.includes('--main-run')?JSON.parse(await readFile(join(root,'dashboard/local.json'),'utf8')).training:config;
  await json(settings,{source_dir:'',training:savedSettings});
  app=await createDashboard({runsDir:runs,configFile:settings});
  await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const api=async path=>{const response=await fetch(base+path);assert.equal(response.ok,true,await response.clone().text());return response.json();};
  const state=await api(`/api/state?run=${selected}`);
  const target=process.argv.includes('--main-run')?160:2;
  assert.equal(state.selected.history.length,process.argv.includes('--main-run')?169:3);
  assert.ok(state.selected.artifacts.some(name=>name.includes('/ancestor-')&&name.startsWith('games/')));
  const data=await api(`/api/generation?run=${selected}&generation=${target}`);
  assert.equal(data.generation,target);assert.equal(data.inherited,true);
  assert.equal((await fetch(base+`/api/generation?run=${selected}&generation=999999`)).status,400);
  if(target===160){assert.equal(data.optimization.policy_loss,2.874953269958496);assert.equal(generationStats(data).meanRounds,33.1875);}
  const executablePath=process.env.CHROME_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser=await chromium.launch({...(executablePath?{executablePath}:{}),headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  if(process.argv.includes('--main-run')){
    const current=await api('/api/state');
    assert.equal(current.selected.warm_start?.run,selected);
    await page.goto(`${base}/?run=${current.selected.id}`);
    await expect(page.locator('[data-history-run]')).toBeVisible();
    await page.locator('[data-history-run]').click();
    await expect(page.locator('#generationDetailTitle')).toContainText('G169 の詳細');
    await expect(page.locator('#historyPersistence')).toContainText('169世代');
  }
  await page.goto(`${base}/?run=${selected}`);
  await expect(page.locator(`#generationTable button[data-gen="${target}"]`)).toBeVisible();
  await page.locator(`#generationTable button[data-gen="${target}"]`).click();
  await expect(page.locator('#generationDetailTitle')).toHaveText(`G${target} の詳細`);
  const metric=label=>page.locator('#generationDetail .gen-metric').filter({has:page.locator('.gen-metric-label',{hasText:label})});
  if(target===160){await expect(metric('方策損失')).toContainText('2.8750');await expect(metric('価値損失')).toContainText('0.0952');await expect(metric('平均対局ラウンド')).toContainText('33.19');}
  await expect(page.locator('#historyPersistence')).toContainText('停止後も保存');
  await expect(page.locator('#generationDetail .detail-config')).toContainText(target===160?'32局／世代・同時8対局':'2局／世代・同時2対局');
  const file=state.selected.artifacts.find(name=>name.startsWith('games/')&&name.includes(`g${String(target).padStart(4,'0')}-`));
  await page.locator('#generationReplay').selectOption(file);
  await page.waitForTimeout(3300);
  await expect(page.locator('#generationReplay'),'Polling must not reset the selected replay').toHaveValue(file);
  await page.locator('#viewGenerationReplay').click();
  await expect(page.locator('#view-analysis')).toBeVisible();
  await expect(page.locator('#replayVerified')).toContainText('検証済み');
  await expect(page.locator('#board .board-cell')).toHaveCount(81);
  await page.reload();
  await expect(page.locator('#generationDetailTitle')).toHaveText(`G${target} の詳細`);
  await page.locator('#latestGeneration').click();
  await expect(page.locator('#generationDetailTitle')).toContainText('（最新）');
  await page.locator('[data-view="charts"]').click();
  await expect(page.locator('#roundsChart svg')).toHaveCount(1);await expect(page.locator('#drawChart svg')).toHaveCount(1);
  await page.locator(`#lossChart [data-gen="${target}"]`).first().click();
  await expect(page.locator('#view-overview')).toBeVisible();await expect(page.locator('#generationDetailTitle')).toHaveText(`G${target} の詳細`);
  await mkdir(join(root,'artifacts/screenshots'),{recursive:true});
  await page.locator('#generationDetailCard').screenshot({path:join(root,`artifacts/screenshots/generation-${target}-detail.png`)});
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await page.screenshot({path:join(root,`artifacts/screenshots/generation-${target}-desktop.png`),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Mobile page must fit');
  await page.screenshot({path:join(root,`artifacts/screenshots/generation-${target}-mobile.png`),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(`History and browser checks passed: G${target}, inherited loss/round/outcome/config data, hash-verified replay, table/chart selection, polling/reload persistence and desktop/mobile layout.`);
} finally {
  await browser?.close();await app?.close();
  assert.ok(resolve(temporary).startsWith(baseFolder+sep));
  await rm(temporary,{recursive:true,force:true});
}
