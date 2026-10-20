import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createDashboard, root } from '../dashboard/server.mjs';

const folder = await mkdtemp(join(root,'.cache/balance-dashboard-'));
const runs = join(folder,'runs'), configFile=join(folder,'local.json');
const python=join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
execFileSync(python,['-c',`
import json,sys
from pathlib import Path
from training.common import load_config
from training.train import Trainer
config=load_config(overrides=dict(generations=0,games_per_generation=2,environments=2,workers=1,candidates=2,cheap_candidates=2,regret_iterations=8,updates=1,batch_size=2,eval_pairs=1,channels=8,device='cpu',history_fraction=0))
trainer=Trainer(Path(sys.argv[1])/'fixture',config)
trainer.generation=101
trainer.commit_checkpoint()
Path(sys.argv[2]).write_text(json.dumps(dict(source_dir='',training=config)),encoding='utf-8')
`,runs,configFile],{cwd:root,stdio:'inherit'});
const app=await createDashboard({runsDir:runs,configFile});
await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
const base=`http://127.0.0.1:${app.server.address().port}`;
let browser;
async function state() {return (await fetch(base+'/api/state')).json();}
async function until(check,label,timeout=180000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {const s=await state();if(check(s))return s;await new Promise(done=>setTimeout(done,250));}
  throw new Error('Timed out: '+label+': '+JSON.stringify(await state()));
}
try {
  const executablePath=process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser=await chromium.launch({...(executablePath ? {executablePath}:{}),headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);
  await page.getByRole('button',{name:'ルール比較',exact:true}).click();
  await expect(page.locator('#view-balance')).toBeVisible();
  await expect(page.locator('#balanceSource')).toContainText('G101');
  await page.locator('#balancePairs').fill('1');
  await page.locator('#balanceInit').click();
  let s=await until(s=>!s.job&&s.experiments.length===1&&s.experiments[0].children.length===10,'ten branches');
  assert.equal(s.last_job.code,0);
  assert.equal(s.experiments[0].manifest.parent.generation,101);
  await expect(page.locator('#balanceShort')).toBeEnabled();
  await expect(page.locator('#balanceProgress tbody tr')).toHaveCount(10);
  await expect(page.locator('#balanceRule')).toHaveValue('D+B2-C1');
  await page.locator('#balanceShort').click();
  s=await until(s=>!s.job&&s.experiments[0]?.report?.results.length===10,'all frozen comparisons');
  assert.equal(s.last_job.code,0,JSON.stringify(s.logs));
  assert.ok(s.experiments[0].report.results.every(r=>r.stage==='short'&&r.games===2));
  await expect(page.locator('#balanceResults tbody tr')).toHaveCount(10,{timeout:15000});
  await expect(page.locator('#balanceResults')).toContainText('短期');
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    const sizes=await page.evaluate(()=>({width:innerWidth,content:document.documentElement.scrollWidth}));
    assert.ok(sizes.content<=sizes.width,JSON.stringify(sizes));
    await mkdir(join(root,'artifacts/screenshots'),{recursive:true});
    await page.screenshot({path:join(root,`artifacts/screenshots/balance-${width}.png`),fullPage:true});
  }
  const response=await fetch(base+`/api/experiment/export?experiment=${s.experiments[0].id}`);
  assert.equal(response.status,200);
  const archive=join(folder,'logs.zip');await writeFile(archive,Buffer.from(await response.arrayBuffer()));
  const names=JSON.parse(execFileSync(python,['-c','import zipfile,json,sys;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',archive],{encoding:'utf8'}));
  assert.ok(names.includes('report.json'));
  assert.ok(names.some(name=>name.endsWith('rounds.jsonl.gz')));
  assert.ok(names.some(name=>name.includes('self-replay-1.json')));
  const trainingRequest=page.waitForRequest(request=>request.url().endsWith('/api/experiment/run')&&request.method()==='POST');
  await page.locator('#balanceTrain').click();
  assert.equal((await trainingRequest).postDataJSON().rule,'D+B2-C1');
  await until(s=>!!s.job,'training controller started');
  await page.locator('#stopJob').click();
  s=await until(s=>!s.job&&s.experiments[0].status.phase==='stopped','graceful experiment stop');
  assert.equal(s.last_job.code,0,JSON.stringify(s.logs));
  assert.deepEqual(errors,[]);
  console.log('Balance dashboard passed: real Chromium desktop/mobile, G101 branch selection, ten frozen-model comparisons, full evidence ZIP, controller start/stop and no page overflow. Screenshots: artifacts/screenshots/balance-*.png');
} finally {
  await browser?.close();
  await app.close();
}
