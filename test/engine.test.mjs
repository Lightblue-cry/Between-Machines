import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Experiment } from '../engine.mjs';

const prompts = { ai1: 'Director instructions', ai2: 'Image-maker instructions' };
const collectionPrompts = { ...prompts, ai1: fs.readFileSync(new URL('../prompts/ai1.txt', import.meta.url), 'utf8') };
const settings = () => ({ configured: true, textModel: 'test-vision', imageModel: 'test-image', quality: 'medium' });
const decision = (value = 'ACCEPT') => ({ data: {
  decision: value,
  decision_reason: 'Private evaluation of the visible image.',
  revision_prompt: value === 'REVISE' ? 'Move the horizon lower.' : '',
  intention_update: value === 'REVISE' ? 'Private change of intention.' : '',
} });

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function fixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preserve-100-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = { propose: [], generate: [], review: [] };
  const provider = {
    async propose(args) {
      calls.propose.push(args);
      return overrides.propose?.(args, calls.propose.length) ?? { data: {
        image_prompt: 'An image of a carefully mended cloth.',
        preservation_reason: 'Private preservation reason: everyday care matters.',
      } };
    },
    async generate(args) {
      calls.generate.push(args);
      return overrides.generate?.(args, calls.generate.length) ?? { image: Buffer.from(`image-${calls.generate.length}`) };
    },
    async review(args) {
      calls.review.push(args);
      return overrides.review?.(args, calls.review.length) ?? decision();
    },
  };
  const options = { dataDir, provider, prompts: overrides.prompts || prompts, settings, gapMs: 0 };
  const engine = new Experiment(options);
  const saved = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  return { engine, calls, dataDir, options, saved };
}

async function run(engine) {
  engine.start();
  await engine.worker;
}

test('ten rejected versions in each of ten sets stops at 100 images and reveals the exhibition', async t => {
  const { engine, calls, dataDir } = fixture(t, { review: () => decision('REVISE') });
  await run(engine);

  assert.equal(calls.propose.length, 10);
  assert.equal(calls.generate.length, 100);
  assert.equal(calls.review.length, 100, 'the tenth image is still evaluated');
  assert.equal(engine.state.phase, 'exhibition');
  assert.equal(engine.running, false);
  assert.equal(engine.stage, 'complete');
  assert.equal(engine.state.sets.length, 10);
  for (const set of engine.state.sets) {
    assert.equal(set.status, 'unresolved');
    assert.equal(set.versions.length, 10);
    assert.equal(set.versions.at(-1).decision, 'REVISE');
    assert.equal(set.versions.at(-1).revision_prompt, 'Move the horizon lower.');
  }
  assert.equal(fs.readdirSync(path.join(dataDir, 'images')).length, 100);

  engine.start();
  engine.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.worker, null);
  assert.deepEqual(Object.fromEntries(Object.entries(calls).map(([key, value]) => [key, value.length])), {
    propose: 10, generate: 100, review: 100,
  }, 'the completed exhibition never triggers another provider call');
});

test('first-image acceptance ends each set and every new proposal has fresh context', async t => {
  const { engine, calls } = fixture(t);
  await run(engine);

  assert.equal(calls.generate.length, 10);
  assert.equal(calls.review.length, 10);
  assert.equal(engine.state.phase, 'exhibition');
  assert.ok(engine.state.sets.every(set => set.status === 'accepted' && set.versions.length === 1));
  assert.equal(calls.propose.length, 10);
  for (const proposal of calls.propose) {
    assert.deepEqual(Object.keys(proposal).sort(), ['config', 'system']);
    assert.deepEqual(proposal, calls.propose[0], 'previous subjects and judgments are not fed into a new proposal');
  }
  calls.review.forEach((review, i) => {
    assert.equal(review.set.number, i + 1);
    assert.equal(review.set.versions.length, 1);
    assert.deepEqual(review.image, Buffer.from(`image-${i + 1}`), 'AI 1 receives the actual generated image');
  });
});

test('distinct-interpretation sets get growing summaries without leaking full records or other-set review context', async t => {
  const { engine, calls } = fixture(t, {
    prompts: collectionPrompts,
    propose: (_args, number) => ({ data: {
      image_prompt: `Interpretation ${number}.`, preservation_reason: `Value ${number}.`,
    } }),
    review: args => args.set.number === 1 && args.set.versions.length === 1 ? decision('REVISE') : decision(),
  });
  await run(engine);
  assert.equal(engine.state.phase, 'exhibition');
  assert.equal(calls.propose.length, 10);
  assert.equal(calls.generate.length, 11);
  assert.equal(calls.review.length, 11);
  calls.propose.forEach((proposal, index) => {
    assert.equal(proposal.setNumber, index + 1);
    assert.equal(proposal.totalSets, 10);
    assert.equal(proposal.previousSets.length, index);
    assert.deepEqual(proposal.previousSets, Array.from({ length: index }, (_, previousIndex) => ({
      number: previousIndex + 1,
      image_prompt: `Interpretation ${previousIndex + 1}.`,
      preservation_reason: `Value ${previousIndex + 1}.`,
      ...(previousIndex === 0 ? { latest_image_prompt: 'Move the horizon lower.' } : {}),
    })));
    assert.doesNotMatch(JSON.stringify(proposal.previousSets), /decision_reason|versions|filename|recordId|Private evaluation/);
  });
  assert.equal(calls.propose[0].previousSets.length, 0, 'later sets cannot mutate earlier request context');
  calls.review.forEach(review => {
    assert.equal(Object.hasOwn(review, 'previousSets'), false);
    assert.ok(review.set.versions.every(version => !version.prompt.startsWith('Interpretation ') ||
      version.prompt === `Interpretation ${review.set.number}.`));
  });
});

test('new context policy survives restart and does not replace an older collection policy', async t => {
  for (const originalPrompts of [prompts, collectionPrompts]) {
    let active;
    const f = fixture(t, {
      prompts: originalPrompts,
      review: () => { active.pause(); return decision(); },
    });
    active = f.engine;
    await run(active);
    assert.equal(f.calls.propose.length, 1);
    assert.equal(active.state.sets[0].status, 'accepted');
    const changedPrompts = originalPrompts === prompts ? collectionPrompts : prompts;
    active = new Experiment({ ...f.options, prompts: changedPrompts });
    await run(active);
    assert.equal(f.calls.propose.length, 2);
    assert.equal(f.calls.propose[1].system, originalPrompts.ai1);
    if (originalPrompts === collectionPrompts) {
      assert.equal(f.calls.propose[1].setNumber, 2);
      assert.equal(f.calls.propose[1].previousSets.length, 1);
    } else {
      assert.deepEqual(Object.keys(f.calls.propose[1]).sort(), ['config', 'system']);
    }
  }
});

test('a paused revision exposes AI 2 instructions while keeping reasons private until exhibition', async t => {
  let engine;
  const f = fixture(t, { review: (_args, number) => {
    if (number === 1) { engine.pause(); return decision('REVISE'); }
    return decision();
  } });
  engine = f.engine;
  await run(engine);

  const live = engine.publicState();
  assert.equal(live.phase, 'live');
  assert.equal(live.running, false);
  assert.equal(live.stage, 'paused');
  assert.equal(live.activePrompt, null, 'the revision remains visible without an active generation');
  assert.equal(live.sets[0].versions[0].decision, 'REVISE');
  assert.equal(live.sets[0].versions[0].revision_prompt, 'Move the horizon lower.');
  assert.equal(live.sets[0].image_prompt, 'An image of a carefully mended cloth.');
  assert.equal(Object.hasOwn(live.sets[0], 'preservation_reason'), false);
  for (const field of ['decision_reason', 'intention_update']) {
    assert.equal(Object.hasOwn(live.sets[0].versions[0], field), false);
  }
  assert.doesNotMatch(JSON.stringify(live), /Private/);
  const persisted = f.saved().sets[0];
  assert.match(persisted.preservation_reason, /Private preservation/);
  assert.match(persisted.versions[0].decision_reason, /Private evaluation/);
  assert.match(persisted.versions[0].intention_update, /Private change/);
  assert.equal(persisted.versions[0].revision_prompt, 'Move the horizon lower.');

  await run(engine);
  const exhibition = engine.publicState();
  assert.equal(exhibition.phase, 'exhibition');
  assert.equal(exhibition.sets[0].preservation_reason, persisted.preservation_reason);
  assert.equal(exhibition.sets[0].versions[0].decision_reason, persisted.versions[0].decision_reason);
  assert.equal(exhibition.sets[0].versions[0].intention_update, persisted.versions[0].intention_update);
  assert.equal(exhibition.sets[0].versions[0].revision_prompt, persisted.versions[0].revision_prompt);
  assert.equal(f.calls.generate[1].prompt, 'Move the horizon lower.');
  assert.deepEqual(f.calls.generate[1].previousImage, Buffer.from('image-1'));
  assert.deepEqual(f.calls.review[1].previousImage, Buffer.from('image-1'));
});

test('Pause during generation saves that image and waits for Start before review', { timeout: 5000 }, async t => {
  const entered = deferred();
  const result = deferred();
  const { engine, calls, dataDir, saved } = fixture(t, { generate: (_args, number) => {
    if (number === 1) { entered.resolve(); return result.promise; }
    return { image: Buffer.from(`image-${number}`) };
  } });
  engine.start();
  await entered.promise;
  engine.pause();
  assert.equal(engine.publicState().pauseRequested, true);
  result.resolve({ image: Buffer.from('paused-image') });
  await engine.worker;

  assert.equal(engine.stage, 'paused');
  assert.equal(engine.running, false);
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.review.length, 0);
  assert.equal(saved().sets[0].versions[0].decision, null);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'images', saved().sets[0].versions[0].filename)), Buffer.from('paused-image'));

  await run(engine);
  assert.equal(calls.generate.length, 10, 'resuming reviews the saved image instead of regenerating it');
  assert.equal(calls.review.length, 10);
  assert.deepEqual(calls.review[0].image, Buffer.from('paused-image'));
});

test('repeated Start clicks cannot create parallel workers or duplicate proposals', { timeout: 5000 }, async t => {
  const entered = deferred();
  const result = deferred();
  const { engine, calls } = fixture(t, { propose: (_args, number) => {
    if (number === 1) { entered.resolve(); return result.promise; }
    return { data: { image_prompt: 'Mended cloth', preservation_reason: 'Care' } };
  } });
  engine.start();
  const worker = engine.worker;
  engine.start();
  await entered.promise;
  engine.start();
  engine.start();
  assert.equal(engine.worker, worker);
  assert.equal(calls.propose.length, 1);
  assert.equal(calls.generate.length, 0);
  result.resolve({ data: { image_prompt: 'Mended cloth', preservation_reason: 'Care' } });
  await worker;
  assert.equal(calls.propose.length, 10);
  assert.equal(calls.generate.length, 10);
  assert.equal(calls.review.length, 10);
});

test('reopening preserves progress and remains paused until explicitly started', async t => {
  let first;
  const f = fixture(t, { generate: (_args, number) => {
    if (number === 1) first.pause();
    return { image: Buffer.from(`image-${number}`) };
  } });
  first = f.engine;
  await run(first);
  const savedFilename = first.state.sets[0].versions[0].filename;
  const reopened = new Experiment(f.options);
  assert.equal(reopened.running, false);
  assert.equal(reopened.stage, 'paused');
  assert.equal(reopened.worker, null);
  assert.equal(reopened.state.sets[0].versions[0].filename, savedFilename);
  assert.equal(f.calls.generate.length, 1);
  assert.equal(f.calls.review.length, 0);

  await run(reopened);
  assert.equal(f.calls.propose.length, 10);
  assert.equal(f.calls.generate.length, 10);
  assert.equal(f.calls.review.length, 10);
  assert.equal(reopened.state.phase, 'exhibition');
  const complete = new Experiment(f.options);
  await run(complete);
  assert.equal(complete.state.phase, 'exhibition');
  assert.equal(f.calls.generate.length, 10, 'reopening a finished collection cannot reset its limits');
});

test('provider failure pauses safely and retry preserves the generated image', async t => {
  const { engine, calls, dataDir, saved } = fixture(t, { review: (_args, number) => {
    if (number === 1) {
      const error = new Error('private provider diagnostic');
      error.publicMessage = 'Review failed. Press Start to retry.';
      error.ambiguous = true;
      throw error;
    }
    return decision();
  } });
  await run(engine);
  assert.equal(engine.running, false);
  assert.equal(engine.stage, 'error');
  assert.equal(engine.publicState().error, 'Review failed. Press Start to retry.');
  assert.match(engine.publicState().notice, /another charge/);
  assert.doesNotMatch(JSON.stringify(engine.publicState()), /private provider diagnostic/);
  assert.equal(saved().sets[0].versions.length, 1);
  assert.equal(saved().sets[0].versions[0].decision, null);
  assert.equal(saved().ongoing, null);
  assert.equal(calls.generate.length, 1);
  const records = fs.readdirSync(path.join(dataDir, 'records')).map(name => JSON.parse(fs.readFileSync(path.join(dataDir, 'records', name), 'utf8')));
  assert.ok(records.some(record => record.error === 'Review failed. Press Start to retry.' && record.ambiguous));

  await run(engine);
  assert.equal(calls.generate.length, 10);
  assert.equal(calls.review.length, 11, 'only the failed review is repeated');
  assert.equal(engine.state.error, null);
  assert.equal(engine.state.phase, 'exhibition');
});

test('an interrupted request is reported on reopening without automatically retrying', async t => {
  const { engine, options, calls, saved } = fixture(t);
  engine.state.ongoing = { kind: 'generating', set: 1, version: 1 };
  engine.save();
  const reopened = new Experiment(options);
  assert.equal(reopened.running, false);
  assert.equal(reopened.worker, null);
  assert.equal(reopened.stage, 'paused');
  assert.match(reopened.publicState().notice, /interrupted/);
  assert.match(reopened.publicState().notice, /already have been billed/);
  assert.equal(saved().ongoing, null);
  assert.equal(calls.propose.length + calls.generate.length + calls.review.length, 0);
  await run(reopened);
  assert.equal(reopened.state.phase, 'exhibition');
  assert.equal(calls.generate.length, 10);
});
