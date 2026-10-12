import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OpenAIProvider } from '../provider.mjs';

const config = { textModel: 'vision-test', imageModel: 'image-test', quality: 'medium', size: '1024x1024' };
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { 'x-request-id': 'test-request' } });
const textResponse = data => jsonResponse({ id: 'test', status: 'completed', model: 'vision-test',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data) }] }] });
const limitedSystem = readFileSync(new URL('../prompts/ai1.txt', import.meta.url), 'utf8');
const words = count => Array.from({ length: count }, (_, index) => `word${index + 1}`).join(' ');

test('new collections allow 20-word prompts and pause on 21 words for proposals and revisions', async t => {
  assert.match(limitedSystem, /^PROMPT WORD LIMIT: 20$/m);
  for (const kind of ['proposal', 'review']) {
    for (const wordCount of [20, 21]) {
      await t.test(`${kind}: ${wordCount} words`, async () => {
        let calls = 0;
        const field = kind === 'proposal' ? 'image_prompt' : 'revision_prompt';
        const prompt = words(wordCount).replace(' ', '\n\t');
        const data = kind === 'proposal'
          ? { image_prompt: prompt, preservation_reason: words(80) }
          : { decision: 'REVISE', revision_prompt: prompt, decision_reason: words(80), intention_update: words(70) };
        const p = new OpenAIProvider(() => 'test-key', async () => {
          calls++;
          return textResponse(data);
        });
        const result = kind === 'proposal'
          ? p.propose({ system: limitedSystem, config })
          : p.review({ system: limitedSystem, config, image: png, set: { versions: [] } });
        if (wordCount === 20) {
          assert.deepEqual((await result).data, data);
        } else {
          await assert.rejects(result, error => {
            assert.match(error.publicMessage, /21-word prompt.*at most 20/);
            assert.equal(error.details.code, 'prompt_word_limit');
            assert.equal(error.details.field, field);
            assert.equal(error.details.wordCount, 21);
            assert.equal(error.details.wordLimit, 20);
            assert.equal(error.details.requestId, 'test-request');
            assert.equal(error.details.output, JSON.stringify(data));
            assert.equal(error.ambiguous, false);
            return true;
          });
        }
        assert.equal(calls, 1, 'no automatic retry or extra paid request');
      });
    }
  }
});

test('AI 1 receives the set number and prior summaries only for the distinct-interpretations experiment', async () => {
  assert.match(limitedSystem, /^COLLECTION MODE: DISTINCT INTERPRETATIONS$/m);
  const requests = [];
  const p = new OpenAIProvider(() => 'test-key', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return textResponse({ image_prompt: 'A new interpretation.', preservation_reason: 'A different form of value.' });
  });
  const previousSets = [{ number: 1, image_prompt: 'Earlier image.', preservation_reason: 'Earlier value.' }];
  await p.propose({ system: limitedSystem, config, setNumber: 1, totalSets: 10, previousSets: [] });
  await p.propose({ system: limitedSystem, config, setNumber: 2, totalSets: 10, previousSets });
  await p.propose({ system: 'PROMPT WORD LIMIT: 30\nOriginal director instructions.', config,
    setNumber: 2, totalSets: 10, previousSets });
  assert.match(requests[0].input[0].content[0].text, /Begin set 1 of 10/);
  assert.match(requests[0].input[0].content[0].text, /\n\[\]\n/);
  const newContext = requests[1].input[0].content;
  assert.equal(newContext.length, 1, 'no extra image or model requests');
  assert.equal(newContext[0].type, 'input_text');
  assert.match(newContext[0].text, /Begin set 2 of 10/);
  assert.ok(newContext[0].text.includes(JSON.stringify(previousSets)));
  assert.equal(requests[2].input[0].content[0].text,
    'Begin a new set. Develop your image proposal for “An image worth preserving for the next hundred years.” Return image_prompt and preservation_reason.');
  assert.equal(requests.length, 3);
});

test('saved 30-word and 49-word collections retain their declared limits', async () => {
  for (const limit of [30, 49]) {
    const data = { image_prompt: words(limit), preservation_reason: 'Original value.' };
    const p = new OpenAIProvider(() => 'test-key', async () => textResponse(data));
    assert.deepEqual((await p.propose({ system: `PROMPT WORD LIMIT: ${limit}`, config })).data, data);
  }
});

test('ACCEPT remains autonomous with no revision prompt and explanations are not word-limited', async () => {
  const data = { decision: 'ACCEPT', decision_reason: words(80), revision_prompt: '', intention_update: words(70) };
  const p = new OpenAIProvider(() => 'test-key', async () => textResponse(data));
  assert.deepEqual((await p.review({ system: limitedSystem, config, image: png, set: { versions: [] } })).data, data);
});

test('saved collections without the new system marker keep their original prompt behavior', async () => {
  const system = 'Original system prompt without a word limit.';
  const proposal = { image_prompt: words(65), preservation_reason: 'Preserve this.' };
  const review = { decision: 'REVISE', decision_reason: 'Revise this.', revision_prompt: words(65), intention_update: '' };
  let calls = 0;
  const p = new OpenAIProvider(() => 'test-key', async () => textResponse(calls++ === 0 ? proposal : review));
  assert.deepEqual((await p.propose({ system, config })).data, proposal);
  assert.deepEqual((await p.review({ system, config, image: png, set: { versions: [] } })).data, review);
  assert.equal(calls, 2);
});

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
