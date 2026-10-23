import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WasmEngine } from '../web/dist/engine.js';
import { demoScenes } from '../web/dist/rule-demo-scenes.js';
import { buildDemoTimeline } from '../web/dist/rule-demos.js';
import { rankAppearance } from '../web/dist/presentation.js';
import { PLAY_RULES } from '../web/dist/rules.js';

const engine = await WasmEngine.fromBytes(await readFile('web/dist/engine.wasm'));
const call = request => { const result=engine.call(request);assert.equal(result.ok,true,result.error);return result.value; };
const initial = call({cmd:'new',rules:PLAY_RULES});
const timelines = new Map(), resolutions = new Map();
for (const scene of demoScenes) {
  const resolved = [];
  const timeline = await buildDemoTimeline(scene,async (position,actions) => {
    const result = call({cmd:'resolve',position,actions,rules:PLAY_RULES});
    resolved.push(result); return result;
  });
  timelines.set(scene.id,timeline);resolutions.set(scene.id,resolved);
  assert.equal(timeline[0].phase,'intro');
  assert.equal(timeline.at(-1).phase,'rewind');
  assert.ok(timeline.some(step=>step.click && step.sound==='select'),scene.id+': click demonstration');
  assert.deepEqual(timeline.at(-1).position,timeline.find(step=>step.phase==='intro' && step.variant===scene.variants.length-1).position,scene.id+': rewind restores the full starting state');
  assert.equal(timeline.filter(step=>step.phase==='result').length,resolved.length);
  assert.ok(timeline.every(step=>step.duration>=500),scene.id+': slow enough to follow');
}
assert.equal(call({cmd:'view'}).stateHash,initial.stateHash,'Demos must never change the active match');
assert.equal(demoScenes.length,13);
const result = (id,index=0) => resolutions.get(id)[index];
const pawn = (id,index=0) => result(id,index).pieces.find(p=>p.id==='AP');
assert.ok(!result('capture').pieces.some(p=>p.id==='BR'));
assert.equal(result('capture').hands.A.R,1,'The compact capture example demonstrates a low-rank pawn capturing a stopped upgraded rook');
assert.deepEqual(result('capture').pieces.find(p=>p.id==='BG').at,[4,4],'The opponent visibly moves another piece during the ordinary capture');
assert.ok(timelines.get('capture').some(step=>step.pointerSide==='B' && step.selected==='BG' && step.click));
assert.equal(pawn('promotion',0).promoted,true);
assert.equal(pawn('promotion',1).promoted,false);
assert.equal(pawn('promotion',1).upgraded,true);
assert.deepEqual(result('rank').events.find(e=>e.type==='contact').ranks,[4,1]);
assert.ok(result('rank').pieces.some(p=>p.id==='AS'));
assert.ok(!result('rank',1).pieces.some(p=>p.kind==='P'));
assert.equal(result('rank',1).hands.A.P,1);assert.equal(result('rank',1).hands.B.P,1);
assert.deepEqual(result('movement').pieces.find(p=>p.id==='AR').at,[5,4]);
assert.equal(result('movement').captures[0].stage,3,'The rook travels through two intermediate stages before stopping');
assert.deepEqual(result('movement',1).pieces.find(p=>p.id==='AR').at,[5,3]);
assert.equal(result('recapture').captures[0].victim,'AP');
assert.equal(result('recapture').captures[1].reason,'chain');
assert.equal(result('recapture').captures[1].captor,'AG');
assert.equal(result('drop').captures[0].reason,'drop');
assert.equal(result('drop').captures[0].captorRank,0,'A board king defeats the newly dropped rook regardless of rank');
assert.equal(result('drop').hands.A.R,1);
assert.ok(timelines.get('drop').some(step=>step.position.pieces.some(p=>p.side==='B' && p.kind==='R') && !step.position.hands.B.R),'A dropped piece leaves the hand as soon as it appears on the board');
const appearance = (position,id) => rankAppearance(position.pieces.find(p=>p.id===id),{rules:PLAY_RULES,activity:position.activity?.[id]});
assert.equal(appearance(timelines.get('defense')[0].position,'AP').aura,'boosted');
assert.equal(appearance(result('defense'),'AP').aura,'');
assert.equal(appearance(result('fatigue',0),'AP').effective,1);
assert.equal(appearance(result('fatigue',0),'AP').aura,'');
assert.equal(appearance(result('fatigue',1),'AP').effective,0);
assert.equal(appearance(result('fatigue',1),'AP').aura,'reduced');
assert.equal(appearance(result('fatigue',2),'AP').effective,1);
assert.equal(appearance(result('fatigue',2),'AP').aura,'','Recovery follows fatigue in the same three-round example');
assert.equal(result('contact').events.find(e=>e.type==='contact').mode,'swap');
assert.equal(result('double-drop',1).hands.A.R,1);assert.equal(result('double-drop',1).hands.B.B,1);
assert.ok(result('double-drop',1).events.some(e=>e.type==='equal_drop_failure'));
assert.deepEqual(result('king').outcome,{winner:'A',reason:'king_capture_retained'});
assert.equal(result('contact',1).events.some(e=>e.type==='contact'),false);
assert.deepEqual(result('movement',2).pieces.find(p=>p.id==='AR').at,[5,6]);
assert.equal(result('double-drop').hands.A.P,1);
assert.ok(result('double-drop').pieces.some(p=>p.kind==='G'));
assert.ok(result('conditional-drop').pieces.some(p=>p.side==='A' && p.kind==='S'));
assert.equal(result('conditional-drop',1).hands.A.S,1);
assert.equal(result('conditional-drop',1).pieces.some(p=>p.kind==='S'),false);
assert.equal(result('conditional-drop',2).hands.B.P,1);
assert.ok(result('conditional-drop',2).pieces.some(p=>p.side==='A' && p.kind==='P' && p.at[1]===7));
assert.deepEqual(result('king',1).outcome,{winner:'A',reason:'both_kings'});
console.log('All 13 rule topics and their grouped examples verified against real WASM: collision outcomes, conditional moves/drops, rank changes, recovery, victory, rewind and match isolation.');

if (process.argv.includes('--browser')) {
  const { chromium, expect } = await import('@playwright/test');
  const { createApplication } = await import('../server/app.mjs');
  await mkdir(resolve('artifacts/screenshots'),{recursive:true});
  const folder = await mkdtemp(resolve('artifacts/rule-demos-'));
  const app = await createApplication({dataDir:resolve(folder,'rooms')});
  await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
  let browser;
  try {
    const executablePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
    browser = await chromium.launch({...(executablePath ? {executablePath} : {}),headless:true});
    const page = await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(() => {
      window.demoAudio = {clicks:0,samples:0};
      const tone = OscillatorNode.prototype.start, sample = AudioBufferSourceNode.prototype.start;
      OscillatorNode.prototype.start = function(...args) { window.demoAudio.clicks++; return tone.apply(this,args); };
      AudioBufferSourceNode.prototype.start = function(...args) { window.demoAudio.samples++; return sample.apply(this,args); };
    });
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${app.server.address().port}/`);
    await page.locator('#rules-open').click();
    const dialog = page.locator('#rules-dialog');
    await expect(dialog.locator('.rule-item')).toHaveCount(13);
    await expect(dialog.locator('#rules-speed')).toHaveCount(1);
    await expect(dialog.locator('[data-demo-speed]')).toHaveCount(3);
    await expect(dialog.locator('.rule-item[open]')).toHaveCount(0);
    await page.screenshot({path:resolve('artifacts/screenshots/rules-list.png'),animations:'disabled'});
    for (const {id} of demoScenes) {
      await dialog.locator(`[data-rule="${id}"] > summary`).click();
      const demo = dialog.locator(`#rule-demo-${id}`);
      await expect(demo.locator('[data-demo-play]')).toBeEnabled();
      await expect(demo).toHaveAttribute('data-step','0');
      await expect(dialog.locator('.rule-item[open]')).toHaveCount(1);
      await expect(demo.locator('.demo-cells > span')).toHaveCount(25);
      await expect(demo.locator('.demo-caption')).not.toContainText('読み込めません');
      const steps = timelines.get(id);
      // Advance through the first result and check the rendered board, not just the data.
      const stop = steps.findIndex(step=>step.phase==='result');
      let advanced = 0;
      if (id==='capture') {
        const opponent = steps.findIndex(step=>step.click && step.pointerSide==='B' && step.selected==='BG');
        advanced = steps.slice(0,opponent).reduce((sum,step)=>sum+step.duration,0)+10;
        await page.clock.runFor(advanced);
        await expect(demo.locator('.demo-cursor.demo-opponent')).toHaveClass(/demo-pointer-visible/);
        await page.screenshot({path:resolve('artifacts/screenshots/rules-opponent-cursor.png'),animations:'disabled'});
        const pointer = await demo.locator('.demo-cursor path').evaluate(path=>{
          const tip = new DOMPoint(3,2).matrixTransform(path.getScreenCTM());
          return {x:tip.x,y:tip.y,color:getComputedStyle(path).fill,rotation:getComputedStyle(path.ownerSVGElement).transform};
        });
        const target = await demo.locator('[data-demo-x="3"][data-demo-row="1"]').boundingBox();
        assert.equal(pointer.color,'rgb(239, 113, 105)','Opponent cursor is red');
        assert.equal(pointer.rotation,'matrix(-1, 0, 0, -1, 0, 0)','Opponent cursor faces the opposite direction');
        assert.ok(Math.abs(pointer.x-target.x-target.width/2)<1 && Math.abs(pointer.y-target.y-target.height/2)<1,'Rotating the opponent cursor preserves its tip position');
      }
      if (id==='movement') {
        const selected = steps.findIndex(step=>step.click && step.plans.some(plan=>plan.side==='A'));
        advanced = steps.slice(0,selected).reduce((sum,step)=>sum+step.duration,0)+10;
        await page.clock.runFor(advanced);
        await expect(demo.locator('.demo-cursor')).toHaveClass(/demo-pointer-visible/);
        await page.screenshot({path:resolve('artifacts/screenshots/rules-cursor.png'),animations:'disabled'});
        const cursor = await demo.locator('.demo-cursor').boundingBox(), destination = await demo.locator('[data-demo-x="5"][data-demo-row="0"]').boundingBox();
        assert.ok(Math.abs(cursor.x+2-destination.x-destination.width/2)<1,'Cursor points at the actual chosen destination');
        assert.ok(Math.abs(cursor.y+2-destination.y-destination.height/2)<1,'Cursor and cell use the same coordinate system');
        const collision = steps.findIndex(step=>step.phase==='clash');
        const collisionTime = steps.slice(0,collision).reduce((sum,step)=>sum+step.duration,0)+10;
        await page.clock.runFor(collisionTime-advanced);advanced = collisionTime;
        await expect(demo.locator('.demo-impact')).toBeVisible();
        await page.screenshot({path:resolve('artifacts/screenshots/rules-collision.png'),animations:'disabled'});
      }
      await page.clock.runFor(steps.slice(0,stop).reduce((sum,step)=>sum+step.duration,0)+10-advanced);
      await expect(demo).toHaveAttribute('data-phase','result');
      const results = steps.flatMap((step,index)=>step.phase==='result' ? [index] : []);
      let reached = stop;
      for (const index of results) {
        if (index!==reached) await page.clock.runFor(steps.slice(reached,index).reduce((sum,step)=>sum+step.duration,0));
        reached = index;
        const step = steps[index], variant = demoScenes.find(scene=>scene.id===id).variants[step.variant];
        await expect(demo).toHaveAttribute('data-phase','result');
        if (variant.label) await expect(demo.locator('.demo-variant')).toContainText(variant.label);
        if (id==='promotion') {
          const changed = step.variant===0 ? '.piece.promoted' : '.piece.upgraded';
          await expect(demo.locator('.demo-token:not(.demo-removed) '+changed)).toHaveCount(1);
          if (step.variant===0) await page.screenshot({path:resolve('artifacts/screenshots/rules-promotion.png'),animations:'disabled'});
          else await expect(demo.locator('.demo-upgrade')).toHaveText('+1');
        }
        if (id==='rank') await expect(demo.locator('.demo-token:not(.demo-removed)')).toHaveCount(step.variant===0 ? 1 : 0);
        if (id==='contact') await expect(demo.locator('.demo-token:not(.demo-removed)')).toHaveCount(step.variant===0 ? 0 : 2);
        if (id==='double-drop') await expect(demo.locator('.demo-token:not(.demo-removed)')).toHaveCount(step.variant===0 ? 1 : 0);
        if (id==='conditional-drop' && step.variant===1) await expect(demo.locator('.demo-token:not(.demo-removed) .piece:not(.enemy)')).toHaveCount(0);
        if (id==='movement' && step.variant===0) await expect(demo.locator('.demo-caption')).toContainText('指定した奥へは進みません');
        if (id==='defense') await expect(demo.locator('.demo-token:not(.demo-removed) .rank-boosted')).toHaveCount(0);
        if (id==='fatigue') {
          await expect(demo.locator('.demo-token:not(.demo-removed) .rank-reduced')).toHaveCount(step.round===1 ? 1 : 0);
          if (step.round===1) await page.screenshot({path:resolve('artifacts/screenshots/rules-fatigue.png'),animations:'disabled'});
        }
      }
      await demo.locator('[data-demo-play]').click();
      const paused = await demo.getAttribute('data-step');
      await page.clock.runFor(6000);
      await expect(demo).toHaveAttribute('data-step',paused);
      await demo.locator('[data-demo-reset]').click();
      await expect(demo).toHaveAttribute('data-step','0');
      await page.clock.runFor(3000);
      await expect(demo).toHaveAttribute('data-step','0');
      await demo.locator('[data-demo-play]').click();
      await page.clock.runFor(1600);
      assert.notEqual(await demo.getAttribute('data-step'),'0');
    }
    const active = dialog.locator('#rule-demo-simultaneous');
    await dialog.locator('[data-rule="simultaneous"] > summary').click();
    await expect(active).toHaveAttribute('data-step','0');
    await page.clock.runFor(1600);
    // Change speed mid-step; preserve position and proportionally shorten only
    // the remaining time, rather than restarting the step or the demonstration.
    const speedStep = await active.getAttribute('data-step');
    await dialog.locator('[data-demo-speed="2"]').click();
    await expect(active).toHaveAttribute('data-step',speedStep);
    await expect(active).toHaveAttribute('data-speed','2');
    await page.clock.runFor(300);await expect(active).toHaveAttribute('data-step',speedStep);
    await dialog.locator('[data-demo-speed="4"]').click();
    await expect(active).toHaveAttribute('data-step',speedStep);
    await page.clock.runFor(80);assert.notEqual(await active.getAttribute('data-step'),speedStep);
    // The same setting applies to another scene and to paused playback.
    await dialog.locator('[data-rule="capture"] > summary').click();
    const captureDemo = dialog.locator('#rule-demo-capture');
    await expect(captureDemo).toHaveAttribute('data-speed','4');
    await expect(captureDemo).toHaveAttribute('data-step','0');
    await page.clock.runFor(200);await expect(captureDemo).toHaveAttribute('data-step','0');
    await page.clock.runFor(200);await expect(captureDemo).toHaveAttribute('data-step','1');
    await captureDemo.locator('[data-demo-play]').click();
    await dialog.locator('[data-demo-speed="2"]').click();
    await page.clock.runFor(5000);await expect(captureDemo).toHaveAttribute('data-step','1');
    await dialog.locator('[data-demo-speed="4"]').click();
    await dialog.locator('[data-rule="simultaneous"] > summary').click();
    await expect(active).toHaveAttribute('data-step','0');
    await expect(active).toHaveAttribute('data-speed','4');
    await page.screenshot({path:resolve('artifacts/screenshots/rules-speed.png'),animations:'disabled'});
    // Closing the modal cancels scheduled work; reopening restarts the scene.
    await dialog.locator('[data-close]').click();
    const closed = await active.getAttribute('data-step');
    await page.clock.runFor(5000);assert.equal(await active.getAttribute('data-step'),closed);
    await page.locator('#rules-open').click();await expect(active).toHaveAttribute('data-step','0');
    const audio = await page.evaluate(()=>window.demoAudio);
    assert.ok(audio.clicks>0 && audio.samples>0,'Selection tones and movement/clash samples actually play');
    await active.locator('[data-demo-sound]').click();
    await expect(page.locator('#sound-toggle')).toHaveAttribute('aria-pressed','false');
    await expect(dialog.locator('[data-demo-sound][aria-pressed="false"]')).toHaveCount(13);
    // The small layout must fit on narrow phones and still show the cursor.
    for (const width of [390,320]) {
      await page.setViewportSize({width,height:844});
      await active.scrollIntoViewIfNeeded();
      const layout = await dialog.evaluate(element=>({width:element.clientWidth,content:element.scrollWidth}));
      assert.ok(layout.content<=layout.width,`Rules must fit ${width}px phone: ${JSON.stringify(layout)}`);
    }
    await page.screenshot({path:resolve('artifacts/screenshots/rules-mobile.png'),animations:'disabled'});
    await dialog.locator('[data-close]').click();
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('#rules-open').click();
    await expect(active.locator('[data-demo-play]')).toHaveAttribute('aria-pressed','false');
    const reduced = await active.getAttribute('data-step');
    await page.clock.runFor(5000);assert.equal(await active.getAttribute('data-step'),reduced);
    await active.locator('[data-demo-play]').click();await page.clock.runFor(1600);
    assert.notEqual(await active.getAttribute('data-step'),reduced,'Reduced motion still allows manual playback');
    await page.reload();await page.locator('#rules-open').click();
    await expect(page.locator('[data-demo-speed="4"]')).toHaveAttribute('aria-pressed','true');
    assert.deepEqual(errors,[]);
    console.log('Browser verified: all scenes, red reversed opponent cursor, 1×/2×/4× global speed and persistence, promotion/fatigue, pause/restart, sound, reduced motion and 320px/390px phones.');
  } finally { await browser?.close();await app.close(); }
}
