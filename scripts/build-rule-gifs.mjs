import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { createApplication } from '../server/app.mjs';
import { WasmEngine } from '../web/dist/engine.js';
import { demoScenes } from '../web/dist/rule-demo-scenes.js';
import { buildDemoTimeline } from '../web/dist/rule-demos.js';
import { PLAY_RULES } from '../web/dist/rules.js';

const { GIFEncoder, quantize, applyPalette } = gifenc;

// Record the real component, using its public controls, DOM and CSS animations.
// Browser time advances deterministically; the game and GIF share one resolver.
const speed = 2, frameInterval = 80;
const selected = process.argv.find(arg=>arg.startsWith('--scene='))?.slice(8);
const scenes = selected ? demoScenes.filter(scene=>scene.id===selected) : demoScenes;
assert.ok(scenes.length,'Unknown scene: '+selected);
const output = resolve('docs/rules'), previews = resolve('artifacts/screenshots');
await mkdir(output,{recursive:true});await mkdir(previews,{recursive:true});
const bytes = await readFile('web/dist/engine.wasm'), engine = await WasmEngine.fromBytes(bytes);
const resolveRound = async (position,actions) => {
  const result = engine.call({cmd:'resolve',position,actions,rules:PLAY_RULES});
  assert.ok(result.ok,result.error);return result.value;
};
const folder = await mkdtemp(resolve('artifacts/rule-gifs-'));
const app = await createApplication({dataDir:resolve(folder,'rooms')});
await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
const url = `http://127.0.0.1:${app.server.address().port}/`;
const executablePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
let browser;
const manifest = [];

function encode(frames,width,height) {
  // One palette per loop keeps text, wood and aura colors steady. Reserve index
  // zero for unchanged pixels, so later frames only encode their visual changes.
  const samples = [];
  for (let i=0;i<frames.length;i+=Math.max(1,Math.floor(frames.length/18))) {
    const rgba = PNG.sync.read(frames[i].png).data;
    for (let pixel=0;pixel<rgba.length;pixel+=16) samples.push(rgba[pixel],rgba[pixel+1],rgba[pixel+2],255);
  }
  const colors = quantize(new Uint8Array(samples),255,{format:'rgb565'});
  const palette = [[0,0,0],...colors], gif = GIFEncoder();
  const reference = [];
  let previous = null, pending = null, count = 0, elapsed = 0;
  function flush() {
    if (!pending) return;
    gif.writeFrame(pending.delta,width,height,{palette:count===0 ? palette : undefined,
      transparent:count>0,transparentIndex:0,dispose:1,delay:pending.duration,repeat:0});
    const rgba = new Uint8Array(width*height*4);
    for (let i=0;i<pending.full.length;i++) {
      const color = palette[pending.full[i]], offset = i*4;
      rgba[offset]=color[0];rgba[offset+1]=color[1];rgba[offset+2]=color[2];rgba[offset+3]=255;
    }
    reference.push(createHash('sha256').update(rgba).digest('hex'));count++;
  }
  for (const frame of frames) {
    const png = PNG.sync.read(frame.png);assert.equal(png.width,width);assert.equal(png.height,height);
    const full = applyPalette(png.data,colors,'rgb565');
    for (let i=0;i<full.length;i++) full[i]++;
    const delta = new Uint8Array(full.length);
    let changed = !previous;
    for (let i=0;i<full.length;i++) if (!previous || full[i]!==previous[i]) {delta[i]=full[i];changed=true;}
    const next = elapsed+frame.duration;
    const duration = Math.round(next/10)*10-Math.round(elapsed/10)*10;elapsed=next;
    if (!changed && pending) pending.duration+=duration;
    else {flush();pending={delta,full,duration};}
    previous=full;
  }
  flush();gif.finish();
  return {bytes:Buffer.from(gif.bytes()),frames:count,duration:Math.round(elapsed/10)*10,reference};
}

try {
  browser = await chromium.launch({...(executablePath ? {executablePath} : {}),headless:true,args:['--mute-audio']});
  const page = await browser.newPage({viewport:{width:540,height:1100},deviceScaleFactor:1,reducedMotion:'no-preference'});
  const errors = [];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('shogi-settings',JSON.stringify({sound:false,reduced:false,demoSpeed:2})));
  await page.clock.install({time:new Date('2026-10-23T00:00:00Z')});
  await page.goto(url);await page.clock.pauseAt(new Date('2026-10-23T00:01:00Z'));
  await page.addStyleTag({content:`
    .rules-dialog[open] { animation:none;max-width:520px;width:520px;max-height:1080px;padding:20px; }
    .rule-demo { width:420px;height:480px;margin:0 auto;border-radius:8px; }
    .demo-heading { height:32px;padding:10px 16px 0; }
    .demo-body { height:448px;display:flex;flex-direction:column;gap:16px;padding:0 20px 16px; }
    .demo-stage { width:248px;max-width:248px;flex-shrink:0;margin:0 auto; }
    .demo-explanation { width:100%;align-self:stretch;padding:0; }
    .demo-caption { height:56px;min-height:56px;margin:6px 0 10px;font-size:13px;line-height:1.9; }
    .demo-phase { font-size:10px; }
    .demo-footer,.demo-progress,.demo-legend { display:none; }
  `});
  await page.locator('#rules-dialog').evaluate(dialog=>dialog.showModal());
  await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(()=>{window.ruleGifAnimations=new WeakMap();});
  let recording;
  await page.route('**/__recording.gif',route=>route.fulfill({contentType:'image/gif',body:recording}));
  for (const [sceneIndex,scene] of scenes.entries()) {
    const steps = await buildDemoTimeline(scene,resolveRound);
    const details = page.locator(`[data-rule="${scene.id}"]`), demo = page.locator(`#rule-demo-${scene.id}`);
    await details.evaluate(element=>{element.open=true;});
    await expect(demo).toHaveAttribute('data-step','0');
    await demo.evaluate(element=>element.scrollIntoView({block:'center',behavior:'instant'}));
    const box = await demo.boundingBox();assert.ok(box);
    const clip = {x:Math.floor(box.x),y:Math.floor(box.y),width:Math.round(box.width),height:Math.round(box.height)};
    assert.equal(clip.width,420);assert.equal(clip.height,480);
    const frames = [];
    for (let index=0;index<steps.length;index++) {
      await expect(demo).toHaveAttribute('data-step',String(index));
      const duration = steps[index].duration/speed;
      const motion = await demo.evaluate((element,rate)=>{
        let maximum = 0;
        for (const animation of element.getAnimations({subtree:true})) {
          if (!window.ruleGifAnimations.has(animation)) {
            animation.pause();animation.currentTime=0;
            window.ruleGifAnimations.set(animation,{start:performance.now(),rate});
          }
          const end = Number(animation.effect?.getComputedTiming().endTime ?? 0);
          if (Number.isFinite(end)) maximum=Math.max(maximum,(end-Number(animation.currentTime ?? 0))/rate);
        }
        return maximum;
      },speed);
      const animateUntil = Math.min(motion,duration-20), offsets = [0];
      for (let offset=frameInterval;offset<animateUntil;offset+=frameInterval) offsets.push(offset);
      if (animateUntil-offsets.at(-1)>=30) offsets.push(animateUntil);
      let previous = 0;
      for (let sample=0;sample<offsets.length;sample++) {
        const offset = offsets[sample];
        if (offset>previous) await page.clock.runFor(offset-previous);previous=offset;
        await demo.evaluate(element=>{
          for (const animation of element.getAnimations({subtree:true})) {
            const info=window.ruleGifAnimations.get(animation);
            if (info) animation.currentTime=(performance.now()-info.start)*info.rate;
          }
        });
        const png = await page.screenshot({clip,animations:'allow',caret:'hide'});
        const held = (offsets[sample+1] ?? duration)-offset;
        frames.push({png,duration:held});
        if (sample===0 && steps[index].phase==='result' && steps[index].variant===0 && steps[index].round===0) await writeFile(resolve(previews,`readme-${scene.id}.png`),png);
      }
      // Complete the old transitions before the game's timer changes targets.
      await demo.evaluate((element,remaining)=>{
        for (const animation of element.getAnimations({subtree:true})) {
          const info=window.ruleGifAnimations.get(animation);
          if (info) animation.currentTime=(performance.now()+remaining-info.start)*info.rate;
        }
      },duration-previous);
      await page.clock.runFor(duration-previous);
    }
    const gif = encode(frames,clip.width,clip.height);recording=gif.bytes;
    // Decode actual GIF frames in Chrome and compare their full composited pixels
    // to the intended palette frames, including transparency between movements.
    const checks = [...new Set([0,Math.floor(gif.frames/2),gif.frames-1])];
    const decoded = await page.evaluate(async indices=>{
      const data = await (await fetch('/__recording.gif')).arrayBuffer();
      const decoder = new ImageDecoder({data,type:'image/gif'});await decoder.tracks.ready;
      const checks=[];
      for (const frameIndex of indices) {
        const frame=await decoder.decode({frameIndex}), rgba=new Uint8Array(frame.image.allocationSize({format:'RGBA'}));
        await frame.image.copyTo(rgba,{format:'RGBA'});
        const digest=await crypto.subtle.digest('SHA-256',rgba);
        checks.push([...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join(''));frame.image.close();
      }
      const result={frames:decoder.tracks.selectedTrack.frameCount,checks};decoder.close();return result;
    },checks);
    assert.equal(decoded.frames,gif.frames);assert.deepEqual(decoded.checks,checks.map(index=>gif.reference[index]));
    await writeFile(resolve(output,scene.id+'.gif'),gif.bytes);
    manifest.push({id:scene.id,title:scene.title,width:clip.width,height:clip.height,frames:gif.frames,durationMs:gif.duration,bytes:gif.bytes.length,sha256:createHash('sha256').update(gif.bytes).digest('hex')});
    await details.evaluate(element=>{element.open=false;});
    console.log(`${sceneIndex+1}/${scenes.length} ${scene.id}: ${gif.frames} frames, ${(gif.duration/1000).toFixed(1)}s, ${Math.round(gif.bytes.length/1024)} KiB; decoded pixels verified`);
  }
  assert.deepEqual(errors,[]);
  if (!selected) {
    await writeFile(resolve(output,'manifest.json'),JSON.stringify({speed,loop:true,rules:PLAY_RULES,demos:manifest},null,2)+'\n');
    const readmePath=resolve('README.md'), readme=await readFile(readmePath,'utf8');
    const start='<!-- animated-rules:start -->', end='<!-- animated-rules:end -->';
    const guide=[start,'','## 動くルールガイド','',
      '普通の将棋と違うところを、ゲーム内と同じ実演で紹介します。見出しを開くと、小盤面のGIFで動きを確認できます。',
      '', '実演は2倍速で繰り返します。音付き再生・速度の切り替えは、ゲーム内の「遊び方」から利用できます。','',
      ...demoScenes.flatMap((scene,index)=>[
        `<details${index===0 ? ' open' : ''}>`,`<summary><strong>${index+1}. ${scene.title}</strong></summary>`,'',
        scene.description,'',`![${scene.title}の実演](docs/rules/${scene.id}.gif)`,'',...(scene.note ? [scene.note,''] : []),'</details>','',
      ]), '詳しい裁定は [ルール仕様書](RULES.md) を参照してください。','',end,''].join('\n');
    let updated;
    if (readme.includes(start)) updated=readme.slice(0,readme.indexOf(start))+guide+readme.slice(readme.indexOf(end)+end.length).replace(/^\r?\n/,'');
    else {const at=readme.indexOf('## 起動');assert.ok(at>0);updated=readme.slice(0,at)+guide+'\n'+readme.slice(at);}
    await writeFile(readmePath,updated);
    console.log(`README updated with ${manifest.length} animated rules; total ${(manifest.reduce((sum,item)=>sum+item.bytes,0)/1024/1024).toFixed(2)} MiB.`);
  }
} finally {await browser?.close();await app.close();}
