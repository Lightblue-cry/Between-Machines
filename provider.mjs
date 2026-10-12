const API = 'https://api.openai.com/v1';

export class ProviderError extends Error {
  constructor(publicMessage, details = null, ambiguous = false) {
    super(publicMessage);
    this.publicMessage = publicMessage;
    this.details = details;
    this.ambiguous = ambiguous;
  }
}

const stringSchema = { type: 'string' };
const proposalSchema = {
  type: 'object', additionalProperties: false,
  properties: { image_prompt: stringSchema, preservation_reason: stringSchema },
  required: ['image_prompt', 'preservation_reason'],
};
const reviewSchema = {
  type: 'object', additionalProperties: false,
  properties: { decision: { type: 'string', enum: ['ACCEPT', 'REVISE'] },
    decision_reason: stringSchema, revision_prompt: stringSchema, intention_update: stringSchema },
  required: ['decision', 'decision_reason', 'revision_prompt', 'intention_update'],
};

export function validateResult(data, kind) {
  const fields = kind === 'proposal' ? ['image_prompt', 'preservation_reason'] :
    ['decision', 'decision_reason', 'revision_prompt', 'intention_update'];
  if (!data || fields.some(key => typeof data[key] !== 'string') || Object.keys(data).some(key => !fields.includes(key))) {
    throw new ProviderError('AI 1 returned an incomplete response. Press Start to retry this step.');
  }
  if (kind === 'proposal' && (!data.image_prompt.trim() || !data.preservation_reason.trim())) {
    throw new ProviderError('AI 1 did not supply a complete proposal. Press Start to retry.');
  }
  if (kind === 'review' && (!['ACCEPT', 'REVISE'].includes(data.decision) ||
    !data.decision_reason.trim() || (data.decision === 'REVISE' && !data.revision_prompt.trim()))) {
    throw new ProviderError('AI 1 did not supply a complete decision. Press Start to retry the review.');
  }
  return Object.fromEntries(fields.map(key => [key, data[key].trim()]));
}

export class OpenAIProvider {
  constructor(getApiKey, fetchImpl = fetch) { this.getApiKey = getApiKey; this.fetch = fetchImpl; }

  async request(endpoint, body, multipart = false, method = 'POST') {
    const key = this.getApiKey();
    if (!key) throw new ProviderError('Add your OpenAI API key in Settings first.');
    let response;
    try {
      response = await this.fetch(`${API}${endpoint}`, {
        method, headers: { Authorization: `Bearer ${key}`,
          ...(multipart ? {} : { 'Content-Type': 'application/json' }) },
        body: method === 'GET' ? undefined : multipart ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(method === 'GET' ? 20000 : 240000),
      });
    } catch {
      throw new ProviderError('The connection was interrupted or timed out. Check your internet connection, then press Start to retry.', null, true);
    }
    let result;
    try { result = await response.json(); }
    catch { throw new ProviderError('The service returned an unreadable response. Your progress is saved.', { status: response.status }, true); }
    const requestId = response.headers.get('x-request-id');
    if (!response.ok) {
      let message = 'The image service could not complete this step. Your progress is saved. Press Start to retry when ready.';
      if (response.status === 401) message = 'The API key was not accepted. Update it in Settings, then press Start.';
      const role = endpoint === '/models' ? 'the model-list check' : endpoint === '/responses' ? 'AI 1' : 'AI 2';
      if (response.status === 403) message = `OpenAI denied access to ${role}'s request. Check API key permissions and model access; the local record contains the specific reason.`;
      if (response.status === 404) message = `OpenAI could not find or grant access to the model selected for ${role}. Check its name and your project's model access.`;
      if (response.status === 429) message = 'The API account reached a rate or billing limit. Check your account, then press Start when ready.';
      if (result.error?.code === 'moderation_blocked') message = 'The service declined this image request. The experiment is paused and its progress is saved.';
      if (result.error?.code === 'unsupported_country_region_territory') {
        message = 'OpenAI rejected this request because its country or region is not supported. Changing models or adding credits will not resolve this error. Check OpenAI API regional availability.';
      }
      const details = { status: response.status, requestId, code: result.error?.code,
        message: String(result.error?.message || '').split(key).join('[redacted]') };
      throw new ProviderError(message, details, response.status >= 500);
    }
    return { result, requestId };
  }

  async checkConnection({ textModel, imageModel }) {
    const { result } = await this.request('/models', undefined, false, 'GET');
    if (!Array.isArray(result.data)) throw new ProviderError('OpenAI returned an unreadable model list. No generations were started.');
    const available = new Set(result.data.map(model => model.id));
    const missing = [textModel, imageModel].filter(model => !available.has(model));
    const message = missing.length
      ? `Connected to OpenAI, but these selected models were not listed: ${missing.join(', ')}. Check model access or choose listed models. No generations were started.`
      : 'Connected to OpenAI. Both selected models are listed. This check does not verify billing or permission to generate images. No generations were started.';
    return { ok: true, message, modelsAvailable: missing.length === 0,
      availableTextModels: [...available].filter(id => /^(gpt-|o[134])/.test(id) && !/(image|audio|realtime|transcribe|tts)/.test(id)).sort().slice(0, 40),
      availableImageModels: [...available].filter(id => /^gpt-image-/.test(id)).sort() };
  }

  async text({ system, content, schema, kind, config }) {
    const { result, requestId } = await this.request('/responses', {
      model: config.textModel, instructions: system,
      input: [{ role: 'user', content }], store: false,
      text: { format: { type: 'json_schema', name: kind, strict: true, schema } },
    });
    const chunks = (result.output || []).flatMap(item => item.content || []);
    if (chunks.some(item => item.type === 'refusal')) {
      throw new ProviderError('AI 1 declined this step. The experiment is paused and the existing images are saved.');
    }
    if (result.status && result.status !== 'completed') {
      throw new ProviderError('AI 1 did not complete this step. Press Start to retry.', { status: result.status, requestId });
    }
    const output = chunks.filter(item => item.type === 'output_text').map(item => item.text).join('');
    let parsed;
    try { parsed = JSON.parse(output); }
    catch { throw new ProviderError('AI 1 returned an unreadable decision. Press Start to retry.', { requestId, output }); }
    const data = validateResult(parsed, kind);
    // Saved collections retain their own system prompt. Enforce the new constraint
    // only when that prompt explicitly declares it, leaving older records usable.
    const wordLimit = Number(system.match(/^PROMPT WORD LIMIT: (\d+)\s*$/m)?.[1]);
    const promptField = kind === 'proposal' ? 'image_prompt' : data.decision === 'REVISE' ? 'revision_prompt' : null;
    if (Number.isSafeInteger(wordLimit) && wordLimit > 0 && promptField) {
      const wordCount = data[promptField].split(/\s+/u).length;
      if (wordCount > wordLimit) {
        throw new ProviderError(
          `AI 1 returned a ${wordCount}-word prompt; this experiment allows at most ${wordLimit}. The experiment is paused. Press Start to retry this step.`,
          { code: 'prompt_word_limit', requestId, responseId: result.id, model: result.model,
            usage: result.usage, field: promptField, wordCount, wordLimit, output },
        );
      }
    }
    return { data, metadata: { requestId, responseId: result.id, model: result.model,
      usage: result.usage, output, inputText: content.filter(c => c.type === 'input_text').map(c => c.text) } };
  }

  propose({ system, config, setNumber = 1, totalSets = 10, previousSets = [] }) {
    // The saved system prompt determines the experiment's context policy.
    // Older collections keep their original independent-set behavior.
    let text = 'Begin a new set. Develop your image proposal for “An image worth preserving for the next hundred years.” Return image_prompt and preservation_reason.';
    if (/^COLLECTION MODE: DISTINCT INTERPRETATIONS\s*$/m.test(system)) {
      text = `Begin set ${setNumber} of ${totalSets}. Develop a conceptually and visually distinct interpretation of “An image worth preserving for the next hundred years.”\n` +
        `Earlier sets, supplied only as reference for avoiding repetition:\n${JSON.stringify(previousSets)}\n` +
        'Choose a different subject, reason for preservation and visual approach from those already explored. Return image_prompt and preservation_reason.';
    }
    return this.text({ system, config, schema: proposalSchema, kind: 'proposal',
      content: [{ type: 'input_text', text }] });
  }

  review({ system, set, image, previousImage, config }) {
    const record = {
      original_image_prompt: set.image_prompt, original_preservation_reason: set.preservation_reason,
      versions: set.versions.map(v => ({ version: v.number, prompt: v.prompt, decision: v.decision,
        decision_reason: v.decision_reason, revision_prompt: v.revision_prompt, intention_update: v.intention_update })),
    };
    const content = [{ type: 'input_text', text:
      `Review the latest image. Here is this set's proposal and recorded exchange:\n${JSON.stringify(record)}\nReturn your decision and the other review fields.` }];
    if (previousImage) content.push(
      { type: 'input_text', text: 'Previous image, supplied for comparison:' },
      { type: 'input_image', image_url: `data:image/png;base64,${previousImage.toString('base64')}`, detail: 'high' },
    );
    content.push({ type: 'input_text', text: 'Latest image: make your ACCEPT or REVISE decision about this image.' },
      { type: 'input_image', image_url: `data:image/png;base64,${image.toString('base64')}`, detail: 'high' });
    return this.text({ system, config, content, schema: reviewSchema, kind: 'review' });
  }

  async generate({ system, prompt, previousImage, config }) {
    const fullPrompt = `${system}\n\nAI 1’S ${previousImage ? 'REVISION INSTRUCTIONS' : 'IMAGE PROMPT'}:\n${prompt}`;
    const fields = { model: config.imageModel, prompt: fullPrompt,
      size: config.size || '1024x1024', quality: config.quality, n: '1', output_format: 'png' };
    let reply;
    if (previousImage) {
      const body = new FormData();
      for (const [key, value] of Object.entries(fields)) body.append(key, value);
      body.append('image[]', new Blob([previousImage], { type: 'image/png' }), 'previous.png');
      reply = await this.request('/images/edits', body, true);
    } else {
      reply = await this.request('/images/generations', { ...fields, n: 1 });
    }
    const encoded = reply.result.data?.[0]?.b64_json;
    if (!encoded) throw new ProviderError('The service did not return an image. Your progress is saved.', { requestId: reply.requestId }, true);
    const image = Buffer.from(encoded, 'base64');
    if (image.length < 8 || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new ProviderError('The service returned an unexpected image format. Your progress is saved.', { requestId: reply.requestId }, true);
    }
    return { image, metadata: { requestId: reply.requestId, model: config.imageModel,
      usage: reply.result.usage, created: reply.result.created, action: previousImage ? 'edit' : 'generate',
      fullPrompt, quality: config.quality, size: fields.size,
      providerRevisedPrompt: reply.result.data?.[0]?.revised_prompt || null } };
  }
}
