import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { createFixtures } from './test-fixtures.mjs';

const artifacts = resolve('artifacts');
await mkdir(resolve(artifacts, 'screenshots'), { recursive: true });
const dataRoot = await mkdtemp(resolve(artifacts, 'browser-'));
const apps = [], errors = [];
let browser;
const fixtures = await createFixtures();
async function server(name, options = {}) {
  const app = await createApplication({ dataDir: resolve(dataRoot, name), ...options }); apps.push(app);
  await new Promise(resolveListen => app.server.listen(0, '127.0.0.1', resolveListen));
  return `http://127.0.0.1:${app.server.address().port}`;
}
const cell = (page, x, y) => page.locator(`#board [data-x="${x}"][data-y="${y}"]`);
const ready = page => expect(page.locator('#menu-open')).toBeEnabled({ timeout: 15000 });
async function shot(page, name) { await page.screenshot({ path: resolve(artifacts, 'screenshots', name + '.png'), animations: 'disabled', fullPage: true }); }
async function fit(page, label) {
  const layout = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth, board: (() => { const r = document.querySelector('#board').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() }));
  assert.ok(layout.content <= layout.viewport, `${label}: horizontal overflow ${JSON.stringify(layout)}`);
  if (layout.board.width) { assert.ok(Math.abs(layout.board.width - layout.board.height) < 2, `${label}: board must be square`); assert.ok(layout.board.x >= 0 && layout.board.x + layout.board.width <= layout.viewport, `${label}: board fits`); }
}
async function checkArena(page, label) {
  await page.locator('#game-screen').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
  const layout = await page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
    return { width:innerWidth, height:innerHeight, board:rect('.board-surround'), top:rect('.opponent-rack'), bottom:rect('.self-rack'), history:rect('.game-sidebar'), header:rect('.app-header'), menu:rect('#menu-open') };
  });
  assert.ok(layout.header.height <= 54,`${label}: compact game header`);
  assert.ok(layout.menu.left > layout.width - 70,`${label}: menu on the far right`);
  const {board,top,bottom,history} = layout;
  if (layout.width > 1100) {
    assert.ok(top.right < board.left && bottom.left > board.right,`${label}: racks flank the board`);
    assert.ok(board.top < 70 && board.bottom <= layout.height + 1,`${label}: board fits below the compact header ${JSON.stringify(layout)}`);
    assert.ok(top.top < board.top + 120 && bottom.bottom <= board.bottom + 1,`${label}: opponent above left and player below right`);
    assert.ok(history.bottom <= bottom.top,`${label}: kifu stops above the player's rack`);
    assert.ok(Math.abs(history.left - bottom.left) < 1 && Math.abs(history.width - bottom.width) < 1,`${label}: record and own rack share a wide rail`);
    assert.ok(bottom.width >= 240 && bottom.height >= (layout.height > 700 ? 300 : 240),`${label}: enlarged player's rack`);
  } else {
    assert.ok(top.top > board.bottom && bottom.top > board.bottom,`${label}: both mobile racks below the board`);
    assert.ok(history.top >= Math.max(top.bottom,bottom.bottom),`${label}: kifu below both racks`);
  }
  if (layout.width >= 1900 && layout.height >= 1000) assert.ok(board.width >= 1000,`${label}: desktop board uses the available height`);
  if (layout.width === 1280 && layout.height >= 800) assert.ok(board.width >= 700,`${label}: enlarged laptop board`);
}
async function checkPieceRatios(page) {
  const ratios = await page.evaluate(() => {
    const ratio = element => { const r = element.getBoundingClientRect(); return r.width/r.height; };
    return { board:ratio(document.querySelector('#board .piece')), hands:[...document.querySelectorAll('.hand-piece .piece')].map(ratio) };
  });
  for (const value of ratios.hands) assert.ok(Math.abs(value - ratios.board) < .004,`hand silhouette matches board ratio: ${value} / ${ratios.board}`);
}
async function importReplay(page, replay) {
  await page.locator('#replay-file').setInputFiles({ name: 'test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
  await expect(page.locator('#start-game')).toBeEnabled();
  await expect(page.locator('#game-screen')).toBeVisible();
}
try {
  const executablePath = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const a = await desktop.newPage(), b = await mobile.newPage();
  for (const page of [a, b]) {
    await page.addInitScript(() => {
      window.shogiAudioSamples = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        window.shogiAudioSamples.push({duration:this.buffer?.duration,channels:this.buffer?.numberOfChannels});
        return start.apply(this,args);
      };
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      // Closing a deliberately interrupted SSE response is a handled transport
      // error, and Chromium still reports it in its resource console.
      const transport = /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_CLOSED|INCOMPLETE_CHUNKED_ENCODING|FAILED)/.test(message.text());
      if (message.type() === 'error' && !transport) errors.push(message.text());
    });
  }
  const standard = await server('standard');
  await a.goto(standard); await expect(a.locator('#home-screen')).toBeVisible();
  await expect(a.locator('#game-screen')).toBeHidden(); await fit(a, 'desktop home'); await shot(a, 'home-desktop');
  for (const width of [320, 360, 720, 1024]) { await a.setViewportSize({width,height:800}); await fit(a, 'home '+width); }
  await a.setViewportSize({width:1280,height:900});
  await b.goto(standard); await fit(b, 'mobile home'); await shot(b, 'home-mobile');
  await a.locator('#mode-cpu').click(); await a.locator('#start-game').click(); await ready(a);
  await expect(a.locator('#board .piece')).toHaveCount(40); await fit(a, 'desktop game'); await checkArena(a,'desktop game'); await shot(a, 'game-desktop');
  for (const width of [320, 360, 720, 721, 900, 1024, 1100, 1101]) { await a.setViewportSize({width,height:800}); await fit(a, 'game '+width); await checkArena(a,'game '+width); }
  await a.setViewportSize({width:1920,height:1080}); await checkArena(a,'full HD'); await shot(a,'game-full-hd');
  await a.setViewportSize({width:1280,height:900});
  await cell(a, 7, 7).click(); await cell(a, 7, 6).click(); await ready(a);
  await expect(a.locator('#round-number')).toHaveText('02'); await expect(a.locator('.history-row')).toHaveCount(1);
  await expect(a.locator('#tab-replay')).toBeHidden(); await expect(a.locator('.history-row')).toBeDisabled();
  await expect(a.locator('#input-hint')).toHaveText('');
  await expect.poll(() => a.evaluate(() => window.shogiAudioSamples.length)).toBe(1);
  const placement = await a.evaluate(() => window.shogiAudioSamples[0]);
  assert.ok(Math.abs(placement.duration - .4882539682539683) < .0001); assert.equal(placement.channels,1);
  await a.locator('#sound-toggle').click(); await cell(a,7,6).click(); await cell(a,7,5).click(); await ready(a);
  assert.equal(await a.evaluate(() => window.shogiAudioSamples.length),1,'muted moves do not play the sample');
  await a.locator('#sound-toggle').click();
  await b.locator('#mode-cpu').click(); await b.locator('#start-game').click(); await ready(b); await fit(b, 'mobile game'); await checkArena(b,'mobile game'); await shot(b, 'game-mobile');
  await cell(b, 7, 7).tap(); await cell(b, 7, 6).tap(); await ready(b); await expect(b.locator('#round-number')).toHaveText('02');
  const fullHand = structuredClone(fixtures.promotion);
  fullHand.initial.hands.A = {R:1,B:1,G:1,S:1,N:1,L:1,P:9};
  fullHand.initial.hands.B = {R:1,B:1,G:1,S:1,N:1,L:1,P:9};
  await importReplay(b, fullHand); await b.locator('#continue-game').click(); await ready(b);
  await b.setViewportSize({width:320,height:844}); await fit(b, 'all seven hand kinds at 320');
  await expect(b.locator('#hand-bottom .hand-piece')).toHaveCount(7);
  await expect(b.locator('#hand-top .hand-piece .piece')).toHaveCount(7);
  await expect(b.locator('#hand-bottom .hand-piece .piece')).toHaveCount(7);
  await checkPieceRatios(b);
  const shape = await b.locator('#hand-bottom .piece').first().evaluate(element => getComputedStyle(element,'::before').clipPath);
  assert.ok(shape.startsWith('polygon('),'captured pieces use the shogi silhouette');
  await shot(b,'hands-mobile-320');
  await b.locator('#hand-bottom [data-kind="P"]').scrollIntoViewIfNeeded(); await b.locator('#hand-bottom [data-kind="P"]').tap();
  await expect(b.locator('#board .available').first()).toBeVisible(); await b.locator('#clear-selection').click();
  await b.setViewportSize({width:390,height:844});
  await importReplay(a,fixtures.longRecord); await a.locator('#continue-game').click(); await ready(a);
  await expect(a.locator('.history-row')).toHaveCount(30); await expect(a.locator('#tab-replay')).toBeHidden();
  await a.setViewportSize({width:1920,height:1080}); await checkArena(a,'full hand desktop'); await checkPieceRatios(a); await shot(a,'hands-full-hd');
  for (const viewport of [{width:1101,height:800},{width:1280,height:600},{width:1280,height:900}]) {
    await a.setViewportSize(viewport); await fit(a,'full hands '+JSON.stringify(viewport)); await checkArena(a,'full hands '+JSON.stringify(viewport)); await checkPieceRatios(a);
  }
  await a.setViewportSize({width:1920,height:1080});
  const scrolling = await a.locator('#history').evaluate(element => element.scrollHeight > element.clientHeight);
  assert.ok(scrolling,'long records scroll inside their area, above the hand tray');
  await a.locator('#history-toggle').click(); await expect(a.locator('#game-sidebar')).toBeHidden(); await expect(a.locator('#hand-bottom')).toBeVisible(); await shot(a,'history-hidden-desktop');
  await a.reload(); await a.locator('#mode-cpu').click(); await a.locator('#start-game').click(); await ready(a);
  await expect(a.locator('#game-sidebar')).toBeHidden(); await expect(a.locator('#history-toggle')).toHaveAttribute('aria-pressed','false');
  await a.locator('#history-toggle').click(); await expect(a.locator('#game-sidebar')).toBeVisible();
  await a.setViewportSize({width:1280,height:900});

  await importReplay(a, fixtures.promotion); await a.locator('#continue-game').click(); await ready(a);
  const colors = await a.evaluate(() => ({ normal: getComputedStyle(document.querySelector('[data-piece="AR"] .piece-symbol')).color, promoted: getComputedStyle(document.querySelector('[data-piece="BS"] .piece-symbol')).color, upgraded: getComputedStyle(document.querySelector('[data-piece="AB"] .piece-symbol')).color }));
  assert.equal(colors.normal, 'rgb(48, 41, 30)'); assert.equal(colors.promoted, 'rgb(180, 50, 43)'); assert.equal(colors.upgraded, 'rgb(36, 93, 165)');
  assert.ok(await a.evaluate(async () => { await document.fonts.ready; return [...document.fonts].some(font => font.family === 'Shogi Brush' && font.status === 'loaded') && getComputedStyle(document.querySelector('.piece.promoted .piece-symbol')).fontFamily.includes('Shogi Brush'); }),'bundled brush font is loaded for changed glyphs');
  await cell(a, 5, 4).click(); await cell(a, 5, 3).click(); await expect(a.locator('#choice-popover')).toBeVisible();
  await expect(a.locator('[data-choice]')).toHaveCount(2); await expect(a.locator('[data-choice="none"]')).toHaveCount(0);
  await shot(a, 'promotion-desktop');
  await a.locator('[data-choice="upgrade"]').click(); await ready(a);
  await expect(cell(a, 5, 3).locator('.piece.upgraded')).toHaveCount(1);
  await cell(a, 5, 3).click(); await cell(a, 5, 2).click(); await expect(a.locator('#choice-popover')).toBeHidden(); await ready(a);
  await expect(a.locator('#round-number')).toHaveText('03'); await expect(cell(a, 5, 2).locator('.piece.upgraded')).toHaveCount(1);
  await expect(cell(a, 5, 2).locator('.piece-symbol')).toHaveText('飛');
  await importReplay(b,fixtures.forcedPromotion); await b.locator('#continue-game').click(); await ready(b);
  await cell(b,5,2).tap(); await cell(b,5,1).tap(); await expect(b.locator('#choice-popover')).toBeHidden(); await ready(b);
  await expect(cell(b,5,1).locator('.piece.promoted')).toHaveCount(1); await expect(cell(b,5,1).locator('.piece-symbol')).toHaveText('と'); await shot(b,'forced-promotion-mobile');
  await a.locator('#resign').click(); await a.locator('#confirm-accept').click(); await expect(a.locator('#result-title')).toHaveText('敗北'); await shot(a, 'defeat-desktop');
  await a.locator('#result-final').click(); await a.locator('#show-result').click(); await a.locator('#result-review').click(); await ready(a);
  await expect(a.locator('#replay-round')).toHaveValue('1');
  await a.locator('#show-result').click(); await a.locator('#result-rematch').click(); await ready(a); await expect(a.locator('#board .piece')).toHaveCount(40);
  await importReplay(a, fixtures.draw); await a.locator('#show-result').click(); await expect(a.locator('#result-title')).toHaveText('引き分け'); await shot(a, 'draw-desktop'); await a.locator('#result-final').click();

  const online = await server('online', { initialPosition: fixtures.collision.initial, graceMs: 45_000 });
  await a.goto(online); await b.goto(online);
  await a.locator('#mode-online').click(); await a.locator('#player-name').fill('棋士 あお'); await a.locator('#online-submit').click();
  await expect(a.locator('#room-screen')).toBeVisible(); await expect(a.locator('#room-ready')).toBeEnabled();
  const code = await a.locator('#room-number').innerText(); assert.match(code, /^\d{6}$/);
  await b.locator('#mode-online').click(); await b.locator('#join-tab').click(); await b.locator('#player-name').fill('棋士 あか'); await b.locator('#room-code').fill(code); await b.locator('#online-submit').click();
  await expect(b.locator('#room-screen')).toBeVisible(); await expect(b.locator('#room-ready')).toBeEnabled();
  await expect(a.locator('#room-players')).toContainText('棋士 あか'); await shot(a, 'room-desktop'); await shot(b, 'room-mobile'); await fit(b, 'mobile room');
  await a.locator('#room-ready').click(); await b.locator('#room-ready').click(); await ready(a); await ready(b);
  await expect(a.locator('#game-screen')).toBeVisible(); await expect(b.locator('#game-screen')).toBeVisible();
  await cell(a, 5, 7).click(); await cell(a, 5, 5).click(); await expect(a.locator('#input-hint')).toContainText('相手の一手');
  await expect(cell(b, 5, 7).locator('.piece')).toHaveCount(1); await expect(b.locator('.history-row')).toHaveCount(0);
  await a.reload(); await ready(a); await expect(a.locator('#input-hint')).toContainText('相手の一手');
  await cell(b, 5, 5).tap(); await cell(b, 5, 6).tap();
  await expect(a.locator('#clash-overlay')).toBeVisible(); await expect(a.locator('#clash-content')).toContainText('格 6'); await expect(a.locator('#clash-content')).toContainText('格 1');
  await expect.poll(() => a.evaluate(() => window.shogiAudioSamples.some(sample => Math.abs(sample.duration - .5095238095238095) < .0001))).toBe(true);
  await shot(a, 'clash-desktop'); await shot(b, 'clash-mobile');
  await ready(a); await ready(b); await expect(a.locator('#round-number')).toHaveText('02');
  await expect(cell(a, 5, 6).locator('[data-piece="AR"]')).toHaveCount(1);
  await mobile.setOffline(true); await expect(a.locator('#connection-notice')).toBeVisible({timeout:35000});
  await mobile.setOffline(false); await expect(a.locator('#connection-notice')).toBeHidden({timeout:15000}); await ready(b);
  await b.locator('#resign').click(); await b.locator('#confirm-accept').click();
  await expect(a.locator('#result-title')).toHaveText('勝利'); await expect(b.locator('#result-title')).toHaveText('敗北'); await shot(a, 'victory-desktop');
  await b.locator('#result-rematch').click(); await expect(b.locator('#room-screen')).toBeVisible(); await b.locator('#room-ready').click();
  await a.locator('#result-final').click(); await a.locator('#tab-replay').click(); await ready(a); await expect(a.locator('#stage-label')).toHaveText('開始局面');
  await a.locator('#stage-next').click(); await expect(a.locator('#stage-label')).toHaveText('段階 1');
  await a.locator('#show-result').click(); await a.locator('#result-rematch').click(); await expect(a.locator('#room-screen')).toBeVisible(); await a.locator('#room-ready').click();
  await ready(a); await ready(b); await expect(a.locator('#round-number')).toHaveText('01'); await expect(b.locator('#round-number')).toHaveText('01');
  await b.locator('#game-home').click(); await b.locator('#confirm-accept').click(); await expect(b.locator('#home-screen')).toBeVisible();
  await expect(a.locator('#result-detail')).toHaveText('対戦相手が退出しました');
  await a.locator('#result-rematch').click(); await expect(a.locator('#room-players')).toContainText('対戦相手を待つ');
  assert.deepEqual(errors, [], 'browser errors');
  console.log('Browser integration passed in isolated desktop and mobile Chromium contexts: board/hand aspect ratios, wide racks, bounded long records and persistent hide toggle, right-side menu, actual WAV placement/clash playback and mute, post-game-only review, actual WASM, immediate moves, promotion colors/choices, all results, AI rematch, real room/create/join/ready, secret commitment/reload, collision presentation, network recovery, online rematch and leave. Screenshots: artifacts/screenshots.');
} catch (error) {
  if (browser) for (const [i, context] of browser.contexts().entries()) for (const [j, page] of context.pages().entries()) await shot(page, `failure-${i}-${j}`).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await Promise.all(apps.map(app => app.close()));
  const target = resolve(dataRoot); assert.ok(target.startsWith(artifacts + sep)); await rm(target, { recursive: true, force: true });
}
