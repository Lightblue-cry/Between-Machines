import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const LIMITS = Object.freeze({ sets: 10, versions: 10 });
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();

export function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

export class Experiment {
  constructor({ dataDir, provider, prompts, settings, gapMs = 1500 }) {
    this.dataDir = dataDir;
    this.provider = provider;
    this.settings = settings;
    this.gapMs = gapMs;
    this.running = false;
    this.pauseRequested = false;
    this.inFlight = false;
    this.stage = 'idle';
    this.worker = null;
    this.stateFile = path.join(dataDir, 'state.json');
    fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'records'), { recursive: true });
    if (fs.existsSync(this.stateFile)) {
      this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.validateState();
      this.stage = this.state.phase === 'exhibition' ? 'complete' : this.state.sets.length ? 'paused' : 'idle';
      if (this.state.ongoing) {
        this.stage = 'paused';
        this.state.notice = 'A request was interrupted. Start will retry that step; the earlier request may already have been billed.';
        this.state.ongoing = null;
      } else if (this.state.phase !== 'exhibition' && this.state.sets.length) {
        this.state.notice = 'Your progress is saved. Press Start to continue.';
      }
    } else {
      this.state = {
        schemaVersion: 1, id: randomUUID(), createdAt: now(), updatedAt: now(),
        phase: 'live', limits: { ...LIMITS }, prompts, config: null,
        sets: [], error: null, notice: null, ongoing: null, completedAt: null,
      };
    }
    this.save();
  }

  validateState() {
    const s = this.state;
    if (s.schemaVersion !== 1 || !Array.isArray(s.sets) || s.sets.length > LIMITS.sets ||
      s.limits?.sets !== LIMITS.sets || s.limits?.versions !== LIMITS.versions ||
      !['live', 'exhibition'].includes(s.phase) ||
      s.sets.some((set, index) => set.number !== index + 1 || !Array.isArray(set.versions) ||
        set.versions.length > LIMITS.versions || !['working', 'accepted', 'unresolved'].includes(set.status))) {
      throw new Error('The saved collection is not valid. Keep a backup of data/ before inspecting state.json.');
    }
    if (s.phase === 'exhibition' && (s.sets.length !== LIMITS.sets || s.sets.some(set => set.status === 'working'))) {
      throw new Error('The saved exhibition is incomplete. It has not been reset.');
    }
  }

  save() {
    this.state.updatedAt = now();
    atomicWrite(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  start() {
    if (this.state.phase === 'exhibition') return;
    if (this.running || this.worker) return;
    if (!this.settings().configured) throw new Error('Add your OpenAI API key in Settings first.');
    if (!this.state.config) {
      const { textModel, imageModel, quality } = this.settings();
      this.state.config = { textModel, imageModel, quality, size: '1024x1024' };
    }
    this.running = true;
    this.pauseRequested = false;
    this.state.error = null;
    this.state.notice = null;
    this.save();
    this.worker = new Promise(resolve => setImmediate(resolve))
      .then(() => this.loop())
      .finally(() => { this.worker = null; });
  }

  pause() {
    if (this.running) this.pauseRequested = true;
    else if (this.state.phase !== 'exhibition') this.stage = 'paused';
  }

  updateConfig(config) {
    if (!this.state.config || this.state.phase === 'exhibition') return;
    const { textModel, imageModel, quality } = config;
    const next = { ...this.state.config, textModel, imageModel, quality };
    if (JSON.stringify(next) === JSON.stringify(this.state.config)) return;
    this.state.configChanges ||= [];
    this.state.configChanges.push({ at: now(), before: this.state.config, after: next });
    this.state.config = next;
    this.save();
  }

  async loop() {
    try {
      while (!this.pauseRequested && this.state.phase !== 'exhibition') {
        await this.step();
        if (!this.pauseRequested && this.state.phase !== 'exhibition' && this.gapMs) {
          await new Promise(resolve => setTimeout(resolve, this.gapMs));
        }
      }
    } catch (error) {
      // Provider errors are intentionally public-safe; raw replies stay in local records.
      this.state.error = error.publicMessage || 'This step could not finish. Your progress is saved. Check the local records, then press Start to retry.';
      this.state.notice = error.ambiguous ? 'The request may have completed remotely. Retrying could incur another charge.' : null;
      this.stage = 'error';
      this.state.ongoing = null;
      this.save();
    } finally {
      this.running = false;
      this.pauseRequested = false;
      this.inFlight = false;
      if (this.state.phase === 'exhibition') this.stage = 'complete';
      else if (!this.state.error) this.stage = 'paused';
    }
  }

  async operation(kind, set, version, action) {
    this.stage = kind;
    this.inFlight = true;
    const op = { id: randomUUID(), kind, set: set.number, version, startedAt: now() };
    this.state.ongoing = op;
    this.save();
    try {
      const result = await action();
      atomicWrite(path.join(this.dataDir, 'records', `${op.id}.json`), JSON.stringify({
        ...op, finishedAt: now(), config: this.state.config,
        metadata: result.metadata || {}, result: result.data || null,
      }, null, 2));
      return { ...result, recordId: op.id };
    } catch (error) {
      atomicWrite(path.join(this.dataDir, 'records', `${op.id}.json`), JSON.stringify({
        ...op, finishedAt: now(), error: error.publicMessage || error.message,
        details: error.details || null, ambiguous: !!error.ambiguous,
      }, null, 2));
      throw error;
    } finally { this.inFlight = false; }
  }

  commitStep() {
    this.state.ongoing = null;
    this.stage = 'idle';
    this.save();
  }

  async step() {
    let set = this.state.sets.at(-1);
    if (!set || set.status !== 'working') {
      if (this.state.sets.length >= LIMITS.sets) { this.finish(); return; }
      set = { number: this.state.sets.length + 1, status: 'working', createdAt: now(),
        image_prompt: null, preservation_reason: null, versions: [] };
      this.state.sets.push(set);
      this.save();
    }
    if (!set.image_prompt) {
      const result = await this.operation('proposing', set, 1, () => this.provider.propose({
        system: this.state.prompts.ai1, config: this.state.config,
      }));
      set.image_prompt = result.data.image_prompt;
      set.preservation_reason = result.data.preservation_reason;
      set.proposalRecordId = result.recordId;
      this.commitStep();
      return;
    }
    const last = set.versions.at(-1);
    if (!last || last.decision === 'REVISE') {
      if (set.versions.length >= LIMITS.versions) {
        set.status = 'unresolved'; set.completedAt = now();
        this.maybeFinish(); this.commitStep(); return;
      }
      const number = set.versions.length + 1;
      const prompt = last ? last.revision_prompt : set.image_prompt;
      const previousImage = last ? fs.readFileSync(path.join(this.dataDir, 'images', last.filename)) : null;
      const result = await this.operation('generating', set, number, () => this.provider.generate({
        system: this.state.prompts.ai2, prompt, previousImage, config: this.state.config,
      }));
      const filename = `set-${String(set.number).padStart(2, '0')}-v-${String(number).padStart(2, '0')}.png`;
      atomicWrite(path.join(this.dataDir, 'images', filename), result.image);
      set.versions.push({ number, prompt, filename, createdAt: now(), generationRecordId: result.recordId,
        decision: null, decision_reason: null, revision_prompt: null, intention_update: null });
      this.commitStep();
      return;
    }
    if (last.decision === null) {
      const image = fs.readFileSync(path.join(this.dataDir, 'images', last.filename));
      const previous = set.versions.at(-2);
      const previousImage = previous ? fs.readFileSync(path.join(this.dataDir, 'images', previous.filename)) : null;
      const result = await this.operation('reviewing', set, last.number, () => this.provider.review({
        system: this.state.prompts.ai1, set: clone(set), image, previousImage, config: this.state.config,
      }));
      Object.assign(last, result.data, { reviewRecordId: result.recordId, reviewedAt: now() });
      if (last.decision === 'ACCEPT') { set.status = 'accepted'; set.completedAt = now(); }
      else if (set.versions.length >= LIMITS.versions) { set.status = 'unresolved'; set.completedAt = now(); }
      this.maybeFinish();
      this.commitStep();
    }
  }

  maybeFinish() {
    if (this.state.sets.length === LIMITS.sets && this.state.sets.every(s => s.status !== 'working')) this.finish();
  }

  finish() {
    this.state.phase = 'exhibition';
    this.state.completedAt = now();
    this.state.ongoing = null;
    this.save();
  }

  publicState() {
    const reveal = this.state.phase === 'exhibition';
    const { textModel, imageModel, quality, configured } = this.settings();
    const active = this.state.sets.at(-1);
    const activePrompt = this.stage === 'generating' ?
      (active?.versions.at(-1)?.revision_prompt || active?.image_prompt || null) : null;
    return {
      phase: this.state.phase, running: this.running, pauseRequested: this.pauseRequested,
      inFlight: this.inFlight, stage: reveal ? 'complete' : this.stage,
      error: this.state.error, notice: this.state.notice, demo: false,
      activePrompt,
      activeSet: this.state.sets.at(-1)?.number || null, limits: { ...LIMITS },
      settings: { textModel, imageModel, quality, configured, locked: false },
      counts: { setsCompleted: this.state.sets.filter(s => s.status !== 'working').length,
        images: this.state.sets.reduce((n, s) => n + s.versions.length, 0) },
      sets: this.state.sets.map(set => ({
        number: set.number, status: set.status, image_prompt: set.image_prompt,
        ...(reveal ? { preservation_reason: set.preservation_reason } : {}),
        versions: set.versions.map(v => ({ number: v.number, prompt: v.prompt,
          image_url: `/images/${v.filename}`, decision: v.decision,
          ...(reveal ? { decision_reason: v.decision_reason, revision_prompt: v.revision_prompt,
            intention_update: v.intention_update } : {}),
        })),
      })),
    };
  }
}
