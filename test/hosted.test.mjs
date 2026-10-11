import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { acquireCollectionLock, createServer } from '../server.mjs';

const PASSWORD = 'sufficiently-long-test-password';
const ORIGIN = 'https://exhibition.example';
const API_KEY = 'private-hosted-test-api-key';
const SETTINGS = { apiKey: API_KEY, textModel: 'text-test', imageModel: 'image-test', quality: 'medium' };

async function fixture(t, provider = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preserve-hosted-'));
  const dataDir = path.join(directory, 'data');
  let current;
  const open = async () => {
    current = await createServer({ hosted: true, publicUrl: ORIGIN, adminPassword: PASSWORD,
      dataDir, initialSettings: { ...SETTINGS }, provider, gapMs: 0 });
    await new Promise(resolve => current.server.listen(0, '127.0.0.1', resolve));
    return current;
  };
  await open();
  const close = async () => {
    current.engine.pause();
    if (current.engine.worker) await current.engine.worker;
    if (current.server.listening) await new Promise(resolve => current.server.close(resolve));
  };
  t.after(async () => { await close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = (pathname, { method = 'GET', body, cookie, origin = ORIGIN, host = 'exhibition.example', headers = {} } = {}) => {
    const base = `http://127.0.0.1:${current.server.address().port}`;
    return new Promise((resolve, reject) => {
      // Use raw HTTP so the proxy-facing Host is explicit. Node fetch replaces Host.
      const request = http.request(`${base}${pathname}`, { method, headers: { Host: host,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...(origin === null ? {} : { Origin: origin }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) responseHeaders.append(key, item);
          }
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: responseHeaders }));
        });
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  const login = async () => {
    const response = await request('/api/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(response.status, 200);
    const header = response.headers.get('set-cookie');
    assert.ok(header, 'Successful login must set a session cookie');
    return { response, header, cookie: header.split(';')[0] };
  };
  return { directory, dataDir, request, login, get engine() { return current.engine; },
    async restart() { await close(); await open(); } };
}

test('hosted viewers can see the exhibition but cannot control it or retrieve private records', async t => {
  let checks = 0;
  const f = await fixture(t, { checkConnection: async () => { checks++; return { ok: true, message: 'Connected' }; } });
  f.engine.state.sets.push({ number: 1, status: 'working', image_prompt: 'A public image prompt',
    preservation_reason: 'PRIVATE_PRESERVATION', versions: [{ number: 1, filename: 'set-01-v-01.png',
      prompt: 'A public image prompt', decision: 'REVISE', decision_reason: 'PRIVATE_DECISION',
      revision_prompt: 'Public revision instruction for AI 2', intention_update: 'PRIVATE_UPDATE' }] });
  const response = await f.request('/api/state');
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.access.hosted, true);
  assert.equal(state.access.operator, false);
  assert.equal(state.access.credentialsManaged, true);
  assert.ok(JSON.stringify(state).includes('A public image prompt'));
  assert.equal(state.sets[0].versions[0].revision_prompt, 'Public revision instruction for AI 2');
  assert.equal(Object.hasOwn(state.sets[0], 'preservation_reason'), false);
  for (const field of ['decision_reason', 'intention_update']) {
    assert.equal(Object.hasOwn(state.sets[0].versions[0], field), false);
  }
  assert.ok(!JSON.stringify(state).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(state).includes(API_KEY));
  assert.equal((await f.request('/healthz')).status, 200);
  for (const route of ['/api/start', '/api/pause', '/api/settings', '/api/check-connection']) {
    assert.ok([401, 403].includes((await f.request(route, { method: 'POST', body: {} })).status), route);
  }
  for (const route of ['/api/backup', '/api/archive']) {
    assert.ok([401, 403].includes((await f.request(route)).status), route);
    assert.ok([401, 403].includes((await f.request(route, { method: 'HEAD' })).status), `${route} HEAD`);
  }
  for (const route of ['/.env', '/data/state.json', '/data/settings.json', '/records/private.json']) {
    assert.equal((await f.request(route)).status, 404, route);
  }
  assert.equal(checks, 0, 'A public request must never contact the provider');
  assert.equal(f.engine.running, false);
});

test('hosted operator sessions require the right password, origin and host, and logout revokes access', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/login', { method: 'POST', body: { password: 'incorrect-password' } })).status, 401);
  const { cookie, header } = await f.login();
  assert.match(header, /HttpOnly/i);
  assert.match(header, /Secure/i);
  assert.match(header, /SameSite=Strict/i);
  assert.equal((await (await f.request('/api/state', { cookie })).json()).access.operator, true);
  assert.equal((await (await f.request('/api/state', { cookie: `${cookie}tampered` })).json()).access.operator, false);

  for (const origin of [null, 'null', 'https://unrelated.example', 'http://exhibition.example']) {
    assert.equal((await f.request('/api/pause', { method: 'POST', body: {}, cookie, origin })).status, 403);
  }
  assert.equal((await f.request('/api/state', { host: 'unrelated.example',
    headers: { 'X-Forwarded-Host': 'exhibition.example' } })).status, 403);
  assert.equal((await f.request('/api/pause', { method: 'POST', body: {}, cookie })).status, 200);
  const logout = await f.request('/api/logout', { method: 'POST', body: {}, cookie });
  assert.equal(logout.status, 200);
  assert.equal((await (await f.request('/api/state', { cookie })).json()).access.operator, false);
  assert.ok([401, 403].includes((await f.request('/api/pause', { method: 'POST', body: {}, cookie })).status));
});

test('repeated wrong operator passwords are rate limited', async t => {
  const f = await fixture(t);
  const statuses = [];
  for (let attempt = 0; attempt < 11; attempt++) {
    statuses.push((await f.request('/api/login', { method: 'POST', body: { password: 'wrong-password' } })).status);
  }
  assert.equal(statuses[0], 401);
  assert.equal(statuses.at(-1), 429);
});

test('hosted model settings survive restart without saving the API key, and the operator can check access', async t => {
  let checkedSettings;
  const f = await fixture(t, { checkConnection: async settings => {
    checkedSettings = { ...settings }; return { ok: true, message: 'Provider access checked' };
  } });
  let { cookie } = await f.login();
  assert.equal((await f.request('/api/settings', { method: 'POST', cookie,
    body: { apiKey: 'do-not-store-this-new-api-key' } })).status, 400);
  assert.equal((await f.request('/api/settings', { method: 'POST', cookie,
    body: { textModel: 'changed-text-model', imageModel: 'changed-image-model', quality: 'low' } })).status, 200);
  const saved = fs.readFileSync(path.join(f.dataDir, 'settings.json'), 'utf8');
  assert.ok(saved.includes('changed-text-model'));
  assert.ok(!saved.includes(API_KEY));
  assert.ok(!saved.includes('do-not-store-this-new-api-key'));
  assert.ok(!saved.includes('apiKey'));
  assert.equal(fs.existsSync(path.join(f.dataDir, '.env')), false);
  await f.restart();
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.settings.textModel, 'changed-text-model');
  assert.equal(state.settings.imageModel, 'changed-image-model');
  assert.equal(state.settings.quality, 'low');
  assert.equal(state.running, false);
  ({ cookie } = await f.login());
  const checked = await f.request('/api/check-connection', { method: 'POST', cookie, body: {} });
  assert.equal(checked.status, 200);
  assert.equal((await checked.json()).ok, true);
  assert.equal(checkedSettings.textModel, 'changed-text-model');
  assert.equal(checkedSettings.imageModel, 'changed-image-model');
});

function readTarGzip(bytes) {
  const tar = gunzipSync(bytes);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim() || '0', 8);
    assert.ok(Number.isFinite(size) && size >= 0, 'Tar entries must have a valid size');
    entries.set(`${prefix ? `${prefix}/` : ''}${name}`.replace(/^\.\//, ''), tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('an operator backup includes the saved collection and omits credentials and runtime files', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  const image = Buffer.from('test-image-data');
  const record = JSON.stringify({ result: { preservation_reason: 'Research record' } });
  fs.writeFileSync(path.join(f.dataDir, 'images/set-01-v-01.png'), image);
  fs.writeFileSync(path.join(f.dataDir, 'records/example.json'), record);
  for (const filename of ['.env', '.session.lock', 'settings.json']) {
    fs.writeFileSync(path.join(f.dataDir, filename), 'PRIVATE_CONFIG');
  }
  const response = await f.request('/api/backup', { cookie });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') || '', /attachment/i);
  const entries = readTarGzip(Buffer.from(await response.arrayBuffer()));
  assert.ok(entries.has('state.json'));
  assert.equal(JSON.parse(entries.get('state.json')).id, f.engine.state.id);
  assert.deepEqual(entries.get('images/set-01-v-01.png'), image);
  assert.equal(entries.get('records/example.json').toString(), record);
  for (const name of entries.keys()) {
    assert.ok(!/\.env|\.session\.lock|settings\.json/.test(name), name);
  }
});

test('backup waits for a paused experiment and finished request before copying the collection', async t => {
  let resolveProposal;
  let proposed;
  const started = new Promise(resolve => { proposed = resolve; });
  const f = await fixture(t, { propose: async () => {
    proposed();
    return await new Promise(resolve => { resolveProposal = resolve; });
  } });
  const { cookie } = await f.login();
  assert.equal((await f.request('/api/start', { method: 'POST', cookie, body: {} })).status, 200);
  await started;
  try {
    assert.equal((await f.request('/api/backup', { cookie })).status, 409);
    assert.equal((await f.request('/api/pause', { method: 'POST', cookie, body: {} })).status, 200);
    assert.equal((await f.request('/api/backup', { cookie })).status, 409, 'Pause must still finish the active request');
  } finally {
    f.engine.pause();
    resolveProposal({ data: { image_prompt: 'An archive of everyday life', preservation_reason: 'An ordinary day matters' } });
    await f.engine.worker;
  }
  assert.equal(f.engine.running, false);
  const saved = await f.request('/api/backup', { cookie });
  assert.equal(saved.status, 200);
  const entries = readTarGzip(Buffer.from(await saved.arrayBuffer()));
  assert.equal(JSON.parse(entries.get('state.json')).sets[0].image_prompt, 'An archive of everyday life');
});

test('collection locks reject an active owner, reclaim a retired container and release only their own token', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preserve-lock-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const lockFile = path.join(dataDir, '.session.lock');
  const release = acquireCollectionLock(dataDir);
  assert.throws(() => acquireCollectionLock(dataDir), /already open/);
  release();
  assert.equal(fs.existsSync(lockFile), false);

  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: `${os.hostname()}-retired-container`, token: 'stale' }));
  const releaseNew = acquireCollectionLock(dataDir);
  const owned = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(owned.host, os.hostname());
  assert.equal(owned.pid, process.pid);
  assert.notEqual(owned.token, 'stale');
  fs.writeFileSync(lockFile, JSON.stringify({ ...owned, token: 'replacement-owner' }));
  releaseNew();
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'replacement-owner');
});
