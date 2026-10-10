(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const pad = (number) => String(number).padStart(2, '0');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let state = null;
  let signature = '';
  let selectedSet = null;
  let selectedVersion = null;
  let followLive = true;
  let busy = false;
  let playback = false;
  let playbackTimer = null;
  let promptExpanded = false;
  let settingsLoaded = false;
  let connectionFailed = false;
  let refreshing = null;
  let errorTimer = null;
  let settingsBusy = false;
  let loginBusy = false;
  let visibleImageCount = null;
  let galleryPulseTimer = null;

  function access() { return state?.access || { hosted: false, operator: true, credentialsManaged: false }; }

  function setText(id, value) { byId(id).textContent = value ?? ''; }
  function show(id, visible) { byId(id).hidden = !visible; }

  async function request(url, body) {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || body !== undefined && data.error) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }

  function transientError(message) {
    clearTimeout(errorTimer);
    setText('error', message);
    show('error', true);
    errorTimer = setTimeout(() => { if (!state?.error && !connectionFailed) show('error', false); }, 12000);
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = updateState();
    try { return await refreshing; }
    finally { refreshing = null; }
  }

  async function refreshAccess() {
    if (refreshing) await refreshing;
    settingsLoaded = false;
    signature = '';
    await refresh();
  }

  async function updateState() {
    try {
      const next = await request('/api/state');
      const nextSignature = JSON.stringify(next);
      connectionFailed = false;
      if (nextSignature !== signature) {
        const justCompleted = next.phase === 'exhibition' && state?.phase !== 'exhibition';
        if (state?.access?.operator !== next.access?.operator) settingsLoaded = false;
        state = next;
        signature = nextSignature;
        if (!settingsLoaded) {
          byId('text-model').value = state.settings.textModel || '';
          byId('image-model').value = state.settings.imageModel || '';
          byId('quality').value = state.settings.quality || 'medium';
          settingsLoaded = true;
        }
        if (justCompleted) {
          followLive = false;
          const first = state.sets.find((set) => set.versions.length);
          selectedSet = first?.number ?? null;
          selectedVersion = first?.versions[0]?.number ?? null;
          playback = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          schedulePlayback();
        }
        render();
      } else if (byId('run-state').textContent === 'Connection interrupted') {
        render();
      }
    } catch (error) {
      connectionFailed = true;
      setText('run-state', 'Connection interrupted');
      byId('run-state').className = 'run-state is-error';
      byId('start-button').disabled = true;
      byId('pause-button').disabled = true;
      setText('error', access().hosted ? 'The server is not responding. This page will reconnect automatically.' : 'The local server is not responding. Keep it running; this page will reconnect automatically.');
      show('error', true);
      if (state) renderExchange(state.phase === 'exhibition');
    }
  }

  function chosen() {
    if (!state) return {};
    if (followLive && state.phase === 'live') {
      selectedSet = state.activeSet ?? state.sets[state.sets.length - 1]?.number ?? null;
      const active = state.sets.find((set) => set.number === selectedSet);
      selectedVersion = active?.versions[active.versions.length - 1]?.number ?? null;
    }
    const set = state.sets.find((item) => item.number === selectedSet) || state.sets[state.sets.length - 1];
    const version = set?.versions.find((item) => item.number === selectedVersion) || set?.versions[set.versions.length - 1];
    return { set, version };
  }

  // Presentation only: derive the exchange graphic from the existing public state.
  function renderExchange(exhibition) {
    const activeSet = state.sets.find((item) => item.number === state.activeSet) || state.sets.at(-1);
    const latest = activeSet?.versions.at(-1);
    const moving = !exhibition && state.running && !connectionFailed;
    const activeStage = moving ? state.stage : '';
    let flow = 'waiting';
    let message = exhibition ? 'The exchange is complete. Every version is retained.' : 'Waiting for the first exchange.';
    if (moving) {
      if (state.stage === 'proposing') { flow = 'writing'; message = 'AI 1 is imagining what is worth preserving.'; }
      else if (state.stage === 'generating') {
        flow = latest?.decision === 'REVISE' ? 'revision' : 'prompt';
        message = flow === 'revision' ? 'Revised instructions → AI 2 is making the next version.' : 'Prompt delivered → AI 2 is making the image.';
      } else if (state.stage === 'reviewing') { flow = 'image'; message = 'Image returned → AI 1 is evaluating what it sees.'; }
      else if (activeSet?.status && activeSet.status !== 'working') { flow = 'saved'; message = activeSet.status === 'accepted' ? 'Image accepted. This set is saved in the gallery.' : 'Set unresolved. All versions remain in the gallery.'; }
      else if (latest?.decision === 'REVISE') { flow = 'revision'; message = 'Revision requested → instructions return to AI 2.'; }
      else if (latest && !latest.decision) { flow = 'image'; message = 'Image saved → returning to AI 1 for evaluation.'; }
      else if (activeSet?.image_prompt) { flow = 'prompt'; message = 'Prompt ready → sending it to AI 2.'; }
    } else if (state.error || connectionFailed) message = 'Exchange paused. The saved images remain below.';
    else if (!exhibition && state.sets.length) message = 'Exchange paused. Every completed image is saved.';
    if (state.pauseRequested && moving) message += ' Finishing this step, then pausing.';
    byId('exchange-diagram').dataset.flow = flow;
    byId('exchange-diagram').classList.toggle('is-moving', moving);
    show('exchange-diagram', !exhibition);
    document.querySelectorAll('[data-step]').forEach((step) => {
      const active = step.dataset.step === activeStage;
      step.classList.toggle('active', active);
      if (active) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
    setText('exchange-status', message);
    setText('panel-index', exhibition ? 'ARCHIVE' : activeSet ? `LIVE / SET ${pad(activeSet.number)}` : '01—03');
    byId('gallery-bridge').classList.toggle('is-complete', exhibition);
    const count = state.counts.images;
    if (visibleImageCount !== null && count > visibleImageCount && !exhibition) {
      clearTimeout(galleryPulseTimer);
      byId('gallery-bridge').classList.add('is-saving');
      galleryPulseTimer = setTimeout(() => byId('gallery-bridge').classList.remove('is-saving'), 2400);
    }
    visibleImageCount = count;
  }

  function render() {
    if (!state) return;
    const focusedVersion = document.activeElement?.dataset?.version;
    const focusedSet = document.activeElement?.dataset?.set;
    const exhibition = state.phase === 'exhibition';
    const { hosted, operator, credentialsManaged } = access();
    const settingsLocked = state.running || state.inFlight || exhibition || settingsBusy;
    byId('settings-toggle').innerHTML = `${hosted ? 'Operator' : 'Setup'} <span aria-hidden="true">↗</span>`;
    setText('settings-title', hosted && !operator ? 'Operator access.' : 'Connect the two machines.');
    setText('settings-description', hosted && !operator ? 'Sign in to start, pause or configure the experiment.' : credentialsManaged ? 'The API key is managed in Render. Model settings can be changed while the experiment is paused.' : 'Your key is stored locally and sent only to OpenAI to make requests. Leave the field empty to keep the saved key.');
    show('operator-login-form', hosted && !operator);
    show('settings-form', operator);
    show('operator-session', hosted && operator);
    show('api-key-field', !credentialsManaged);
    document.querySelector('.settings-fields').classList.toggle('managed-credentials', credentialsManaged);
    ['api-key', 'text-model', 'image-model', 'quality', 'save-settings'].forEach((id) => { byId(id).disabled = !operator || settingsLocked; });
    byId('check-connection').disabled = !operator || settingsBusy || state.running || state.inFlight || !state.settings.configured;
    show('backup-button', operator && !state.running && !state.inFlight && state.sets.length > 0);
    if (hosted && !operator) byId('api-key').value = '';
    const { set, version } = chosen();
    const nextPromptIsLive = !exhibition && followLive && state.stage === 'generating' && Boolean(state.activePrompt);
    document.body.classList.toggle('has-collection', state.sets.length > 0);
    document.body.classList.toggle('is-exhibition', exhibition);
    const reasonsPanel = byId('reasons-panel');
    const processPanel = document.querySelector('.process-panel');
    if (exhibition && reasonsPanel.parentElement !== processPanel) {
      processPanel.insertBefore(reasonsPanel, processPanel.querySelector('.prompt-section'));
    } else if (!exhibition && reasonsPanel.parentElement === processPanel) {
      document.querySelector('.viewer-layout').after(reasonsPanel);
    }
    reasonsPanel.setAttribute('aria-labelledby', exhibition ? 'process-title' : 'reasons-title');
    const totalSets = state.limits?.sets || 10;
    const maxVersions = state.limits?.versions || 10;
    const messages = { idle: 'Ready to begin', proposing: 'AI 1 is writing', generating: 'AI 2 is creating', reviewing: 'AI 1 is reviewing', paused: 'Experiment paused', error: 'Needs attention', complete: 'Collection complete' };
    setText('phase-pill', exhibition ? '02 / THE COMPLETED EXHIBITION' : '01 / LIVE EXPERIMENT');
    setText('run-state', exhibition ? (playback ? 'Playing the record' : 'Explore the record') : state.pauseRequested ? 'Pausing…' : messages[state.stage] || 'Ready to begin');
    byId('run-state').className = `run-state${state.running && !state.pauseRequested || exhibition && playback ? ' is-running' : ''}${state.error ? ' is-error' : ''}`;
    show('start-button', operator && !exhibition);
    show('pause-button', operator && !exhibition);
    show('playback-button', exhibition);
    show('download-button', exhibition);
    show('follow-live', !exhibition && !followLive && state.sets.length > 0);
    byId('start-button').disabled = !operator || busy || !state.settings.configured || state.running || state.inFlight;
    byId('pause-button').disabled = !operator || busy || !state.running || state.pauseRequested;
    byId('start-button').innerHTML = `<span aria-hidden="true">▶</span> ${state.sets.length ? 'Resume' : 'Start'}`;
    byId('pause-button').innerHTML = `<span aria-hidden="true">Ⅱ</span> ${state.pauseRequested ? 'Pausing…' : 'Pause'}`;
    byId('playback-button').innerHTML = `<span aria-hidden="true">${playback ? 'Ⅱ' : '▶'}</span> ${playback ? 'Pause playback' : 'Play record'}`;
    show('setup-callout', operator && !hosted && !state.settings.configured && !exhibition);
    const notice = state.pauseRequested ? 'Pausing… the current step will finish and save.' : state.notice;
    setText('notice', notice || '');
    show('notice', Boolean(notice));
    setText('error', state.error || '');
    show('error', Boolean(state.error));

    setText('set-label', `SET ${set ? pad(set.number) : '—'} / ${pad(totalSets)}`);
    setText('version-label', `IMAGE ${version ? pad(version.number) : '—'} / ${pad(maxVersions)}`);
    const image = byId('current-image');
    show('current-image', Boolean(version?.image_url));
    show('empty-image', !version?.image_url);
    byId('image-frame').classList.toggle('has-image', Boolean(version?.image_url));
    if (version?.image_url) {
      if (image.getAttribute('src') !== version.image_url) image.src = version.image_url;
      image.alt = `AI-generated image, set ${set.number}, version ${version.number}. ${version.prompt || set.image_prompt || ''}`;
    } else {
      setText('empty-overline', state.running ? 'AN EXCHANGE IS IN PROGRESS' : 'A SPACE FOR WHAT COMES NEXT');
      byId('empty-title').innerHTML = state.stage === 'generating' ? 'An image<br>is taking shape.' : state.stage === 'proposing' ? 'A possibility<br>is being imagined.' : 'The first image<br>has yet to be imagined.';
      setText('empty-detail', state.running ? 'Image generation can take a few minutes.' : `${totalSets} sets. Up to ${maxVersions} images in each.`);
    }
    let outcome = '';
    if (version?.decision === 'ACCEPT') outcome = 'Accepted';
    else if (version?.decision === 'REVISE') outcome = set.status === 'unresolved' && version.number === set.versions[set.versions.length - 1]?.number ? 'Unresolved · revision limit reached' : 'Revision requested';
    else if (version) outcome = 'Awaiting AI 1’s decision';
    setText('image-outcome', outcome);
    show('image-outcome', Boolean(outcome));
    byId('image-outcome').classList.toggle('is-accepted', version?.decision === 'ACCEPT');
    setText('image-caption', version ? `${version.number === 1 ? 'Initial image' : `Revision ${version.number - 1}`} · Set ${pad(set.number)}${nextPromptIsLive ? ' · Previous image; the next revision is being made' : !followLive && !exhibition ? ' · Viewing a saved image' : ''}` : 'Images will appear here as the exchange unfolds.');
    document.querySelector('.recording-note').lastChild.textContent = exhibition ? ' Complete record' : 'Saved as it happens';

    setText('panel-eyebrow', exhibition ? 'BEHIND THE IMAGE' : 'THE EXCHANGE');
    setText('panel-index', exhibition ? 'ARCHIVE' : '01—03');
    byId('process-title').textContent = exhibition ? 'Why this image?' : 'A thought becomes an image.';
    show('process-steps', !exhibition);
    renderExchange(exhibition);
    const prompt = nextPromptIsLive ? state.activePrompt : version?.prompt || set?.image_prompt || '';
    setText('prompt-label', !exhibition && !followLive ? 'SELECTED IMAGE PROMPT' : nextPromptIsLive && version ? 'NEXT REVISION PROMPT' : version && version.number > 1 ? 'REVISION PROMPT' : 'IMAGE PROMPT');
    setText('prompt-copy', prompt || 'AI 1’s image instructions will appear here. Its reasons stay out of view until all ten sets are complete.');
    const promptLimit = exhibition ? 170 : 320;
    byId('prompt-copy').className = `prompt-copy${!prompt ? ' is-empty' : ''}${prompt.length > promptLimit && !promptExpanded ? ' is-collapsed' : ''}`;
    show('prompt-expand', prompt.length > promptLimit);
    setText('prompt-expand', promptExpanded ? 'Read less −' : 'Read more +');
    byId('prompt-expand').setAttribute('aria-expanded', String(promptExpanded));
    setText('panel-footnote', exhibition ? 'Every image and decision is saved. This exhibition makes no further AI requests.' : 'The machines continue until an image is accepted, or the set reaches ten images.');

    const versions = set?.versions || [];
    byId('version-strip').innerHTML = versions.map((item) => `<button type="button" class="version-button" data-version="${item.number}" aria-pressed="${item.number === version?.number}" aria-label="View image ${item.number}${item.decision === 'ACCEPT' ? ', accepted' : ''}"><img src="${escapeHtml(item.image_url)}" alt="" loading="lazy"><span>${pad(item.number)} ${item.decision === 'ACCEPT' ? '↗' : ''}</span></button>`).join('');
    show('version-strip', versions.length > 0);
    show('reasons-panel', exhibition && Boolean(set));
    if (exhibition && set) {
      setText('preservation-reason', set.preservation_reason || 'No preservation statement was recorded.');
      setText('decision-reason-title', version?.decision === 'ACCEPT' ? 'Why accept it?' : version?.decision === 'REVISE' ? 'Why request a revision?' : 'AI 1’s decision');
      setText('decision-reason', version?.decision_reason || 'No evaluation was recorded for this image.');
      show('intention-update-container', Boolean(version?.intention_update));
      setText('intention-update', version?.intention_update || '');
    }
    setText('archive-eyebrow', exhibition ? 'TEN QUESTIONS OF LASTING VALUE' : 'THE ACCUMULATING RECORD');
    byId('archive-title').innerHTML = exhibition ? 'The complete record<span class="lime-dot">.</span>' : 'A collection in the making<span class="lime-dot">.</span>';
    byId('completed-count').innerHTML = `${pad(state.counts.setsCompleted)}<span>/${pad(totalSets)}</span>`;
    setText('image-count', pad(state.counts.images));
    setText('archive-description', exhibition ? 'Ten independent exchanges. Every version, including those left unresolved. Select a set to explore its record.' : 'Each set begins with the same question. Select a set to follow its images.');
    byId('gallery').innerHTML = Array.from({ length: totalSets }, (_, index) => {
      const item = state.sets.find((candidate) => candidate.number === index + 1);
      const last = item?.versions[item.versions.length - 1];
      const status = item?.status === 'accepted' ? 'Accepted' : item?.status === 'unresolved' ? 'Unresolved' : item ? 'In progress' : '';
      return `<button type="button" class="set-card${last ? '' : ' is-placeholder'}${!exhibition && item?.number === state.activeSet ? ' is-live' : ''}" data-set="${index + 1}" ${item ? '' : 'disabled'} aria-pressed="${set?.number === index + 1}" aria-label="Set ${index + 1}${status ? `, ${status}` : ', not started'}"><div class="set-card-image">${last ? `<img src="${escapeHtml(last.image_url)}" alt="" loading="lazy">` : `<span class="placeholder-number">${pad(index + 1)}</span>`}${status ? `<span class="card-status${item?.status === 'accepted' ? ' accepted' : ''}">${status}</span>` : ''}</div><div class="set-card-meta"><span>SET ${pad(index + 1)}</span><span>${item ? `${item.versions.length} ${item.versions.length === 1 ? 'IMAGE' : 'IMAGES'}` : 'TO COME'}</span></div></button>`;
    }).join('');
    setText('footer-note', state.demo ? 'Demonstration mode · No paid AI requests' : exhibition ? `${state.counts.images} images · 10 sets · Complete saved record` : '10 sets · Up to 9 revisions per set · Every version retained');
    if (focusedVersion) document.querySelector(`[data-version="${Number(focusedVersion)}"]`)?.focus({ preventScroll: true });
    else if (focusedSet) document.querySelector(`[data-set="${Number(focusedSet)}"]`)?.focus({ preventScroll: true });
  }

  function select(setNumber, versionNumber) {
    selectedSet = setNumber;
    selectedVersion = versionNumber;
    followLive = false;
    promptExpanded = false;
    if (playback) { playback = false; schedulePlayback(); }
    render();
  }

  function schedulePlayback() {
    clearTimeout(playbackTimer);
    if (!playback || state?.phase !== 'exhibition') return;
    playbackTimer = setTimeout(() => {
      const all = state.sets.flatMap((set) => set.versions.map((version) => ({ set: set.number, version: version.number })));
      const current = all.findIndex((item) => item.set === selectedSet && item.version === selectedVersion);
      const next = all[(current + 1) % all.length];
      if (next) { selectedSet = next.set; selectedVersion = next.version; promptExpanded = false; render(); }
      schedulePlayback();
    }, 16000);
  }

  async function control(action) {
    if (busy || !access().operator) return;
    busy = true;
    render();
    try { await request(`/api/${action}`, {}); await refresh(); }
    catch (error) { transientError(error.message); }
    finally { busy = false; if (state) { byId('start-button').disabled = !access().operator || !state.settings.configured || state.running || state.inFlight; byId('pause-button').disabled = !access().operator || !state.running || state.pauseRequested; } }
  }

  function openSettings(open) {
    show('settings-panel', open);
    byId('settings-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      const target = access().hosted && !access().operator ? 'operator-password' : access().credentialsManaged ? 'text-model' : 'api-key';
      byId(target).focus();
      byId('settings-panel').scrollIntoView({ block: 'start' });
    }
  }

  byId('start-button').addEventListener('click', () => { followLive = true; control('start'); });
  byId('pause-button').addEventListener('click', () => control('pause'));
  byId('follow-live').addEventListener('click', () => { followLive = true; promptExpanded = false; render(); });
  byId('settings-toggle').addEventListener('click', () => openSettings(byId('settings-panel').hidden));
  byId('settings-close').addEventListener('click', () => { openSettings(false); byId('settings-toggle').focus(); });
  byId('setup-inline').addEventListener('click', () => openSettings(true));
  byId('prompt-expand').addEventListener('click', () => { promptExpanded = !promptExpanded; render(); });
  byId('gallery').addEventListener('click', (event) => {
    const card = event.target.closest('[data-set]');
    if (!card || card.disabled) return;
    const set = state.sets.find((item) => item.number === Number(card.dataset.set));
    select(set.number, state.phase === 'exhibition' ? set.versions[0]?.number : set.versions[set.versions.length - 1]?.number);
    if (!window.matchMedia('(min-width: 1000px) and (min-height: 600px)').matches) byId('experiment').scrollIntoView({ block: 'start' });
  });
  byId('version-strip').addEventListener('click', (event) => {
    const button = event.target.closest('[data-version]');
    if (button) select(chosen().set.number, Number(button.dataset.version));
  });
  byId('playback-button').addEventListener('click', () => { playback = !playback; schedulePlayback(); render(); });
  byId('fullscreen').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { transientError('Full screen is not available in this browser. You can use the browser’s full-screen control.'); }
  });
  document.addEventListener('fullscreenchange', () => {
    byId('fullscreen').setAttribute('aria-label', document.fullscreenElement ? 'Exit full screen' : 'Enter full screen');
  });
  byId('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!access().operator || settingsBusy || state?.running || state?.inFlight || state?.phase === 'exhibition') return;
    settingsBusy = true;
    render();
    setText('settings-message', 'Saving settings…');
    try {
      const payload = { textModel: byId('text-model').value.trim(), imageModel: byId('image-model').value.trim(), quality: byId('quality').value };
      if (!access().credentialsManaged && byId('api-key').value.trim()) payload.apiKey = byId('api-key').value.trim();
      await request('/api/settings', payload);
      byId('api-key').value = '';
      setText('settings-message', 'Settings saved. Use Start when you are ready.');
      await refresh();
    } catch (error) { setText('settings-message', error.message); }
    finally { settingsBusy = false; render(); }
  });

  byId('operator-login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (loginBusy) return;
    loginBusy = true;
    byId('operator-login').disabled = true;
    setText('login-message', 'Signing in…');
    try {
      await request('/api/login', { password: byId('operator-password').value });
      byId('operator-password').value = '';
      setText('login-message', '');
      await refreshAccess();
      setText('settings-message', 'Signed in. Save any changes before checking the connection.');
    } catch (error) { setText('login-message', error.message); }
    finally { loginBusy = false; byId('operator-login').disabled = false; }
  });
  byId('operator-logout').addEventListener('click', async () => {
    byId('operator-logout').disabled = true;
    try {
      await request('/api/logout', {});
      byId('api-key').value = '';
      await refreshAccess();
      setText('login-message', 'Signed out. The exhibition remains available.');
    } catch (error) { setText('settings-message', error.message); }
    finally { byId('operator-logout').disabled = false; }
  });
  byId('check-connection').addEventListener('click', async () => {
    if (!access().operator || settingsBusy || state?.running || state?.inFlight) return;
    settingsBusy = true;
    render();
    setText('settings-message', 'Checking the saved key and models. No images will be generated.');
    try {
      const result = await request('/api/check-connection', {});
      setText('settings-message', result.message || 'Connected. No images were generated.');
    } catch (error) { setText('settings-message', error.message); }
    finally { settingsBusy = false; render(); }
  });

  refresh();
  setInterval(refresh, 1200);
})();
