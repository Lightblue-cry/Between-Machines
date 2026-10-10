import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Experiment, atomicWrite } from './engine.mjs';
import { OpenAIProvider } from './provider.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, '.env');
const PUBLIC = path.join(ROOT, 'public');
const COOKIE = 'hundred_years_operator';
const SESSION_MS = 12 * 60 * 60 * 1000;

export function acquireCollectionLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, '.session.lock');
  const owner = { pid: process.pid, host: os.hostname(), token: randomBytes(16).toString('hex') };
  const write = () => fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  try { write(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('The collection lock could not be read. Stop the other exhibition server before inspecting data/.session.lock.'); }
    const pid = typeof previous === 'number' ? previous : previous.pid;
    let active = !pid;
    // Render attaches a persistent disk to one instance at a time. A new
    // container can reuse a PID, so the container hostname is part of the lock.
    if (pid && (typeof previous === 'number' || previous.host === owner.host)) {
      try { process.kill(pid, 0); active = true; }
      catch (check) { active = check.code === 'EPERM'; }
    }
    if (active) throw new Error('This collection is already open. Use its existing browser window.');
    fs.unlinkSync(file);
    write();
  }
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.token === owner.token) fs.unlinkSync(file);
    } catch { /* The lock may already have been released. */ }
  };
}

function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    return match ? [[match[1], match[2].replace(/^(["'])(.*)\1$/, '$2').trim()]] : [];
  }));
}
const equalSecret = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export async function createServer({ dataDir = path.join(ROOT, 'data'), provider, initialSettings, gapMs = 1500,
  settingsFile = ENV_FILE, hosted = false, publicUrl = '', adminPassword = '' } = {}) {
  let site;
  if (hosted) {
    try { site = new URL(publicUrl); } catch { throw new Error('Set PUBLIC_URL or RENDER_EXTERNAL_URL to the exhibition HTTPS address.'); }
    if (site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/' || site.search || site.hash) {
      throw new Error('The public URL must be an HTTPS origin without a path or credentials.');
    }
    if (adminPassword.length < 16) throw new Error('Set ADMIN_PASSWORD to at least 16 characters before hosting this exhibition.');
  }
  const env = hosted ? process.env : { ...readEnv(), ...process.env };
  const settings = { ...(initialSettings || {
    apiKey: env.OPENAI_API_KEY || '', textModel: env.AI1_MODEL || 'gpt-4.1',
    imageModel: env.AI2_MODEL || 'gpt-image-2.5-flare', quality: env.IMAGE_QUALITY || 'medium',
  }) };
  const hostedSettings = path.join(dataDir, 'settings.json');
  if (hosted && fs.existsSync(hostedSettings)) {
    const saved = JSON.parse(fs.readFileSync(hostedSettings, 'utf8'));
    for (const key of ['textModel', 'imageModel']) {
      if (typeof saved[key] === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(saved[key])) settings[key] = saved[key];
    }
    if (['low', 'medium', 'high', 'auto'].includes(saved.quality)) settings.quality = saved.quality;
  }
  const providerInstance = provider || new OpenAIProvider(() => settings.apiKey);
  const engine = new Experiment({ dataDir, provider: providerInstance, gapMs,
    prompts: { ai1: fs.readFileSync(path.join(ROOT, 'prompts/ai1.txt'), 'utf8'),
      ai2: fs.readFileSync(path.join(ROOT, 'prompts/ai2.txt'), 'utf8') },
    settings: () => ({ ...settings, configured: !!settings.apiKey }),
  });
  engine.updateConfig(settings);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const sessions = new Map();
  let failedLogins = [];
  let checking = false;
  let lastCheck = 0;
  let backingUp = false;
  const setCookie = (res, token, maxAge) => res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
  const cookieToken = req => req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const operatorFor = req => {
    if (!hosted) return true;
    const token = cookieToken(req);
    const expiry = sessions.get(token);
    if (expiry && expiry > Date.now()) return true;
    if (token) sessions.delete(token);
    return false;
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (hosted) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const send = (status, object) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(object));
    };
    // Render health checks don't need an operator cookie or the public Host.
    if (req.url === '/healthz' && ['GET', 'HEAD'].includes(req.method)) return send(200, { ok: true });
    const port = server.address()?.port;
    const hosts = hosted ? [site.host] : [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) return send(403, { error: 'Use the configured exhibition address.' });
    let url;
    try { url = new URL(req.url, hosted ? site.origin : `http://${req.headers.host}`); }
    catch { return send(400, { error: 'Invalid address.' }); }
    if (!hosts.includes(url.host)) return send(403, { error: 'Use the configured exhibition address.' });
    const operator = operatorFor(req);
    try {
      if (req.method === 'POST') {
        const originOK = hosted ? req.headers.origin === site.origin :
          !req.headers.origin || hosts.some(host => req.headers.origin === `http://${host}`);
        if (!originOK || !req.headers['content-type']?.startsWith('application/json')) {
          return send(403, { error: 'Use the exhibition page to control this session.' });
        }
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 16384) return send(413, { error: 'This request is too large.' });
        }
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'Invalid request.' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'Invalid request.' });
        if (url.pathname === '/api/login') {
          if (!hosted) return send(200, { ok: true });
          failedLogins = failedLogins.filter(time => time > Date.now() - 60000);
          if (failedLogins.length >= 10) return send(429, { error: 'Too many sign-in attempts. Wait one minute before trying again.' });
          if (typeof body.password !== 'string' || !equalSecret(body.password, adminPassword)) {
            failedLogins.push(Date.now());
            return send(401, { error: 'The operator password was not accepted.' });
          }
          for (const [token, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(token);
          if (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
          const token = randomBytes(32).toString('hex');
          sessions.set(token, Date.now() + SESSION_MS);
          setCookie(res, token, SESSION_MS / 1000);
          return send(200, { ok: true });
        }
        if (!operator) return send(401, { error: 'Sign in as the operator to use these controls.' });
        if (url.pathname === '/api/logout') {
          sessions.delete(cookieToken(req));
          setCookie(res, '', 0);
          return send(200, { ok: true });
        }
        if (url.pathname === '/api/start') {
          if (backingUp || checking) return send(409, { error: 'Wait for the download or connection check to finish.' });
          engine.start(); return send(200, { ok: true });
        }
        if (url.pathname === '/api/pause') { engine.pause(); return send(200, { ok: true }); }
        if (url.pathname === '/api/check-connection') {
          if (engine.running || engine.inFlight || engine.worker || backingUp || checking) return send(409, { error: 'Pause and wait for the current step to finish before checking the connection.' });
          if (Date.now() - lastCheck < 10000) return send(429, { error: 'Wait a few seconds before checking again.' });
          if (!settings.apiKey) return send(400, { error: hosted ? 'Add OPENAI_API_KEY in Render Environment first.' : 'Save your OpenAI API key in Setup first.' });
          lastCheck = Date.now(); checking = true;
          try { return send(200, await providerInstance.checkConnection(settings)); }
          finally { checking = false; }
        }
        if (url.pathname === '/api/settings') {
          if (engine.running || engine.inFlight || engine.worker || backingUp || checking) return send(409, { error: 'Pause and wait for the current step to finish before updating Setup.' });
          if (hosted && body.apiKey) return send(400, { error: 'Manage OPENAI_API_KEY in Render Environment.' });
          const next = { ...settings };
          for (const key of ['textModel', 'imageModel']) {
            if (body[key] !== undefined) {
              if (typeof body[key] !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(body[key])) return send(400, { error: 'Enter a valid model name.' });
              next[key] = body[key];
            }
          }
          if (body.quality !== undefined) {
            if (!['low', 'medium', 'high', 'auto'].includes(body.quality)) return send(400, { error: 'Choose an available image quality.' });
            next.quality = body.quality;
          }
          if (body.apiKey) {
            if (typeof body.apiKey !== 'string' || /\s/.test(body.apiKey) || body.apiKey.length < 10 || body.apiKey.length > 1024) return send(400, { error: 'Enter your API key without spaces or line breaks.' });
            next.apiKey = body.apiKey;
          }
          if (hosted) {
            atomicWrite(hostedSettings, JSON.stringify({ textModel: next.textModel, imageModel: next.imageModel, quality: next.quality }, null, 2));
          } else {
            atomicWrite(settingsFile, `OPENAI_API_KEY=${next.apiKey}\nAI1_MODEL=${next.textModel}\nAI2_MODEL=${next.imageModel}\nIMAGE_QUALITY=${next.quality}\nPORT=${port}\n`);
          }
          Object.assign(settings, next);
          engine.updateConfig(next);
          return send(200, { ok: true });
        }
        return send(404, { error: 'Not found.' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'Method not allowed.' });
      if (url.pathname === '/api/state') {
        const state = engine.publicState();
        state.access = { hosted, operator, credentialsManaged: hosted };
        if (hosted && !operator) { state.error = null; state.notice = null; }
        return send(200, state);
      }
      if (url.pathname === '/api/backup') {
        if (!operator) return send(401, { error: 'Sign in as the operator to save the experiment files.' });
        if (engine.running || engine.inFlight || engine.worker || backingUp || checking) return send(409, { error: 'Pause and wait for the current step to finish before saving files.' });
        if (req.method === 'HEAD') return send(200, { ok: true });
        backingUp = true;
        const archive = spawn('tar', ['-czf', '-', '-C', dataDir, 'state.json', 'images', 'records'], { stdio: ['ignore', 'pipe', 'ignore'] });
        archive.on('error', () => {
          backingUp = false;
          if (!res.headersSent) send(500, { error: 'The file download could not be prepared.' });
          else res.destroy();
        });
        archive.on('spawn', () => {
          res.writeHead(200, { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store',
            'Content-Disposition': 'attachment; filename="hundred-years-files.tar.gz"' });
          archive.stdout.pipe(res, { end: false });
        });
        archive.on('close', code => {
          backingUp = false;
          if (code === 0) res.end(); else res.destroy();
        });
        res.on('close', () => { if (archive.exitCode === null) archive.kill(); });
        return;
      }
      if (url.pathname === '/api/archive') {
        if (engine.state.phase !== 'exhibition') return send(403, { error: 'The full record becomes available after all ten sets finish.' });
        res.setHeader('Content-Disposition', 'attachment; filename="hundred-years-record.json"');
        return send(200, engine.state);
      }
      if (url.pathname === '/api/prompts') return send(200, engine.state.prompts);
      let file;
      if (/^\/images\/set-\d{2}-v-\d{2}\.png$/.test(url.pathname)) {
        file = path.join(dataDir, 'images', path.basename(url.pathname));
      } else {
        const routes = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/app.js': 'app.js' };
        if (!routes[url.pathname]) return send(404, { error: 'Not found.' });
        file = path.join(PUBLIC, routes[url.pathname]);
      }
      if (!fs.existsSync(file)) return send(404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': file.includes(`${path.sep}images${path.sep}`) ? 'public, max-age=3600' : 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      send(400, { error: error.publicMessage || (error.message?.startsWith('Add your') ? error.message : 'The request could not be completed. Your saved collection has not been reset.') });
    }
  });
  return { server, engine };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hosted = process.env.APP_MODE === 'hosted' || process.env.RENDER === 'true';
  const env = hosted ? process.env : { ...readEnv(), ...process.env };
  const port = Number(env.PORT || 8787);
  const publicUrl = env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '';
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(ROOT, 'data');
  const bindHost = hosted ? '0.0.0.0' : '127.0.0.1';
  let releaseLock;
  let instance;
  try {
    if (hosted && !env.DATA_DIR) throw new Error('Set DATA_DIR to a directory on the persistent disk before hosting.');
    if (hosted && !env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY in Render Environment before hosting.');
    releaseLock = acquireCollectionLock(dataDir);
    instance = await createServer({ hosted, dataDir, publicUrl, adminPassword: env.ADMIN_PASSWORD || '' });
  } catch (error) {
    releaseLock?.(); console.error(error.message); process.exit(1);
  }
  const { server, engine } = instance;
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Use the existing exhibition window.`);
    else console.error('The exhibition could not start:', error.message);
    releaseLock(); process.exitCode = 1;
  });
  server.listen(port, bindHost, () => {
    const url = hosted ? publicUrl : `http://127.0.0.1:${server.address().port}`;
    console.log(`\nFor the next hundred years\n${url}\n\nImages and decisions are saved in: ${dataDir}\n${hosted ? 'Operator sign-in is required to start generation.' : 'Keep this window open during the exhibition.'}\n`);
    if (!hosted && process.argv.includes('--open')) {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      const child = spawn(command, [url], { stdio: 'ignore', detached: true });
      child.on('error', () => {}); child.unref();
    }
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    engine.pause();
    console.log('Stopping after the current step. Saved progress will resume paused next time.');
    server.close();
    const finish = () => { releaseLock(); process.exit(0); };
    // The Blueprint gives Render 300 seconds; a provider request times out at 240.
    const fallback = setTimeout(finish, 250000); fallback.unref();
    Promise.resolve(engine.worker).finally(finish);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
