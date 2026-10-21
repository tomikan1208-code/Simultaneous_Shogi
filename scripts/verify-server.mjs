import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { connectionURLs } from './server-addresses.mjs';

const interfaces = { ethernet: [
  { address: '192.168.1.12', internal: false },
  { address: '192.168.1.12', internal: false },
  { address: '2400:1234::10', internal: false },
  { address: 'fe80::1', internal: false },
  { address: 'fd00::1', internal: false },
  { address: '2001:db8::1', internal: false },
  { address: '::1', internal: true },
  { address: '127.0.0.1', internal: true },
] };

test('dual-stack URLs include LAN and global IPv6, excluding scoped/private IPv6 and duplicates', () => {
  assert.deepEqual(connectionURLs({ host: '::', port: 5173, interfaces }), {
    local: 'http://localhost:5173/', lan: ['http://192.168.1.12:5173/'], internet: ['http://[2400:1234::10]:5173/'],
  });
});

test('IPv4-only and specific bindings do not advertise unreachable interfaces', () => {
  assert.deepEqual(connectionURLs({ host: '0.0.0.0', port: 8080, interfaces }), {
    local: 'http://localhost:8080/', lan: ['http://192.168.1.12:8080/'], internet: [],
  });
  assert.deepEqual(connectionURLs({ host: '127.0.0.1', port: 8080, interfaces }), {
    local: 'http://127.0.0.1:8080/', lan: [], internet: [],
  });
  assert.deepEqual(connectionURLs({ host: '2400:1234::10', port: 8080, interfaces }), {
    local: 'http://[2400:1234::10]:8080/', lan: [], internet: ['http://[2400:1234::10]:8080/'],
  });
});

test('configured public URL preserves the external port without querying any service', () => {
  const urls = connectionURLs({ host: '0.0.0.0', port: 5173, publicURL: 'http://203.0.113.10:8080', interfaces: {} });
  assert.deepEqual(urls.internet, ['http://203.0.113.10:8080/']);
  assert.equal(urls.local, 'http://localhost:5173/');
  assert.deepEqual(connectionURLs({ host: '::', port: 5173, publicURL: 'http://[2400:1234::10]:5173', interfaces }).internet, ['http://[2400:1234::10]:5173/']);
});

test('invalid public URLs are rejected before startup', () => {
  for (const publicURL of ['203.0.113.10:5173', 'ftp://example.com', 'http://user:password@example.com']) {
    assert.throws(() => connectionURLs({ host: '::', port: 5173, publicURL, interfaces: {} }), /PUBLIC_URL/);
  }
});

async function verifyRunningServer(host) {
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const dataDir = await mkdtemp(join(artifacts, 'server-'));
  const env = { ...process.env, PORT: '0', DATA_DIR: dataDir, PUBLIC_URL: 'http://shogi.example:8080/' };
  delete env.PUBLIC_ORIGIN;
  if (host) env.HOST = host; else delete env.HOST;
  const child = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 10_000;
    while (!output.includes('このPC:')) {
      assert.equal(child.exitCode, null, errors);
      assert.ok(Date.now() < deadline, `Server startup timed out: ${errors}`);
      await delay(20);
    }
    const url = output.match(/このPC: (http:\/\/\S+)/)?.[1];
    assert.ok(url, output);
    const port = new URL(url).port;
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) })).json(), { ok: true });
    if (output.includes('listen: :::')) assert.deepEqual(await (await fetch(`http://[::1]:${port}/healthz`, { signal: AbortSignal.timeout(5000) })).json(), { ok: true });
    assert.equal((await fetch(url, { signal: AbortSignal.timeout(5000) })).status, 200);
    assert.match(output, /インターネット \(直接接続\): http:\/\/shogi\.example:8080\//);
    const directHeaders = { Host: 'shogi.example:8080', Origin: 'http://shogi.example:8080' };
    const directRequest = (path, { headers = {}, body, ...options } = {}) => new Promise((ready, reject) => {
      const req = httpRequest(new URL(path, url), { ...options, headers: { ...directHeaders, ...headers }, signal: AbortSignal.timeout(5000) }, ready);
      req.once('error', reject); req.end(body);
    });
    const room = await directRequest('api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '直接接続テスト' }) });
    assert.equal(room.statusCode, 201);
    let roomJSON = '';
    for await (const chunk of room) roomJSON += chunk;
    const { token } = JSON.parse(roomJSON);
    const stream = await directRequest('api/events', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
    const [first] = await once(stream, 'data');
    assert.match(first.toString(), /event: state/);
    stream.destroy();
    const models = await directRequest('api/ai/models');
    assert.equal(models.statusCode, 403); models.resume();
    const forbidden = await directRequest('api/rooms', { method: 'POST', headers: { Origin: 'http://unrelated.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '禁止' }) });
    assert.equal(forbidden.statusCode, 403); forbidden.resume();
  } finally {
    child.kill(); await exited;
    assert.ok(resolve(dataDir).startsWith(artifacts + sep));
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('default server serves IPv4/IPv6 directly and displays the configured shared URL', () => verifyRunningServer());
test('explicit loopback binding remains supported with API/SSE and origin checks', () => verifyRunningServer('127.0.0.1'));
