import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../provider.mjs';

const config = { textModel: 'vision-test', imageModel: 'image-test', quality: 'medium', size: '1024x1024' };
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { 'x-request-id': 'test-request' } });
const textResponse = data => jsonResponse({ id: 'test', status: 'completed', model: 'vision-test',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data) }] }] });

test('connection checks only read the model list and distinguish missing models from a failed connection', async () => {
  const requests = [];
  const p = new OpenAIProvider(() => 'test-key', async (url, options) => {
    requests.push({ url, options });
    return jsonResponse({ data: [{ id: config.textModel }, { id: config.imageModel }] });
  });
  const connected = await p.checkConnection(config);
  assert.equal(connected.modelsAvailable, true);
  assert.match(connected.message, /does not verify billing/);
  const missing = await p.checkConnection({ ...config, imageModel: 'missing-image-model' });
  assert.equal(missing.ok, true);
  assert.equal(missing.modelsAvailable, false);
  assert.match(missing.message, /missing-image-model/);
  for (const request of requests) {
    assert.equal(request.url, 'https://api.openai.com/v1/models');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.body, undefined);
  }
});

test('AI 1 sends approved instructions, strict schema, and actual image bytes for review', async () => {
  let request;
  const p = new OpenAIProvider(() => 'test-key', async (url, options) => {
    request = JSON.parse(options.body);
    assert.equal(url, 'https://api.openai.com/v1/responses');
    return textResponse({ decision: 'REVISE', decision_reason: 'A visible detail is missing.', revision_prompt: 'Add that detail.', intention_update: '' });
  });
  await p.review({ system: 'Approved director instructions', config, image: png, previousImage: png,
    set: { image_prompt: 'Original prompt', preservation_reason: 'Original value', versions: [{ number: 1, prompt: 'Original prompt', decision: null }] } });
  assert.equal(request.instructions, 'Approved director instructions');
  assert.equal(request.store, false);
  assert.equal(request.text.format.strict, true);
  const images = request.input[0].content.filter(item => item.type === 'input_image');
  assert.equal(images.length, 2);
  assert.equal(images.at(-1).image_url, `data:image/png;base64,${png.toString('base64')}`);
  assert.ok(request.input[0].content[0].text.includes('Original value'));
});

test('AI 2 sends initial generation as JSON and revisions as multipart with previous image', async () => {
  const requests = [];
  const p = new OpenAIProvider(() => 'test-key', async (url, options) => {
    requests.push({ url, options });
    return jsonResponse({ data: [{ b64_json: png.toString('base64') }], usage: { total_tokens: 10 } });
  });
  await p.generate({ system: 'Approved renderer instructions', prompt: 'Make an image', config });
  await p.generate({ system: 'Approved renderer instructions', prompt: 'Change the light', previousImage: png, config });
  assert.equal(requests[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(JSON.parse(requests[0].options.body).n, 1);
  assert.equal(JSON.parse(requests[0].options.body).output_format, 'png');
  assert.equal(requests[1].url, 'https://api.openai.com/v1/images/edits');
  const body = requests[1].options.body;
  assert.ok(body instanceof FormData);
  assert.ok(body.get('prompt').includes('Change the light'));
  assert.deepEqual(Buffer.from(await body.get('image[]').arrayBuffer()), png);
  assert.equal(requests[1].options.headers['Content-Type'], undefined);
});

test('Refusals, malformed decisions and interrupted requests pause without automatic retries', async () => {
  let calls = 0;
  const p = new OpenAIProvider(() => 'test-key', async () => {
    calls++;
    throw new Error('Network stopped');
  });
  await assert.rejects(p.propose({ system: 'system', config }), error => error.ambiguous === true);
  assert.equal(calls, 1);
  const malformed = new OpenAIProvider(() => 'test-key', async () => textResponse({
    decision: 'REVISE', decision_reason: 'Change needed', revision_prompt: '', intention_update: '',
  }));
  await assert.rejects(malformed.review({ system: 'system', config, image: png,
    set: { versions: [] } }), /complete decision/);
  const refused = new OpenAIProvider(() => 'test-key', async () => jsonResponse({
    output: [{ content: [{ type: 'refusal', refusal: 'No.' }] }],
  }));
  await assert.rejects(refused.propose({ system: 'system', config }), /declined/);
});

test('Regional access errors are distinguished from model and permission failures', async () => {
  for (const entry of [
    { status: 403, code: 'unsupported_country_region_territory', expected: /country or region is not supported/ },
    { status: 403, code: 'permission_denied', expected: /denied access to AI 1/ },
    { status: 404, code: 'model_not_found', expected: /model selected for AI 1/ },
  ]) {
    let calls = 0;
    const p = new OpenAIProvider(() => 'test-secret-key', async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: entry.code, message: 'Failure involving test-secret-key' } }),
        { status: entry.status });
    });
    await assert.rejects(p.propose({ system: 'system', config }), error => {
      assert.match(error.publicMessage, entry.expected);
      assert.equal(error.details.code, entry.code);
      assert.equal(error.details.status, entry.status);
      assert.equal(error.details.message, 'Failure involving [redacted]');
      assert.equal(error.ambiguous, false);
      return true;
    });
    assert.equal(calls, 1);
  }
});
