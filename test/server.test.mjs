import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';

test('HTTP interface keeps secrets and live explanations private, and saves only local settings', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preserve-http-'));
  const { server, engine } = await createServer({ dataDir: path.join(dir, 'data'), settingsFile: path.join(dir, '.env'),
    initialSettings: { apiKey: 'private-test-key', textModel: 'text-test', imageModel: 'image-test', quality: 'medium' },
    provider: {}, gapMs: 0 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  engine.state.sets.push({ number: 1, status: 'working', image_prompt: 'Public image instruction',
    preservation_reason: 'PRIVATE_REASON', versions: [{ number: 1, filename: 'set-01-v-01.png', prompt: 'Public prompt',
      decision: 'REVISE', decision_reason: 'PRIVATE_DECISION', revision_prompt: 'Public revision instruction for AI 2', intention_update: 'PRIVATE_UPDATE' }] });
  const publicText = await (await fetch(`${base}/api/state`)).text();
  assert.ok(publicText.includes('Public image instruction'));
  const state = JSON.parse(publicText);
  assert.equal(state.sets[0].versions[0].revision_prompt, 'Public revision instruction for AI 2');
  assert.equal(Object.hasOwn(state.sets[0], 'preservation_reason'), false);
  for (const field of ['decision_reason', 'intention_update']) {
    assert.equal(Object.hasOwn(state.sets[0].versions[0], field), false);
  }
  assert.ok(!publicText.includes('PRIVATE_'));
  assert.ok(!publicText.includes('private-test-key'));
  assert.equal((await fetch(`${base}/api/archive`)).status, 403);
  for (const resource of ['/.env', '/data/state.json', '/records/test.json', '/../.env']) {
    assert.equal((await fetch(`${base}${resource}`)).status, 404);
  }
  assert.equal((await fetch(`${base}/api/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: '{}' })).status, 403);
  const result = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'replacement-test-key', textModel: 'text-test', imageModel: 'image-test', quality: 'low' }) });
  assert.equal(result.status, 200);
  assert.ok(fs.readFileSync(path.join(dir, '.env'), 'utf8').includes('replacement-test-key'));
  assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
  assert.ok(!(await (await fetch(`${base}/api/state`)).text()).includes('replacement-test-key'));
});
