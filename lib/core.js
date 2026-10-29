// The whole API. Shared by the local server (server.js) and the Vercel function (api/[...path].js).
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const store = require('./store');
const SEED = require('./seed');

const SESSION_MS = 1000 * 60 * 60 * 8;
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const defaultSite = () => ({ contactEmail: '', linkedin: '', github: '' });
const defaultSmtp = () => ({ host: '', port: 465, user: '', pass: '', to: '' });

// ---- config: session secret, admin password hash, public site settings, email settings ----
async function loadConfig() {
  let cfg = await store.get('config', null);
  if (!cfg) {
    // First run. On a server with files we can generate and print a password; on Vercel it must come from ADMIN_PASSWORD.
    let pw = process.env.ADMIN_PASSWORD, generated = false;
    if (!pw && !store.remote) { pw = crypto.randomBytes(6).toString('hex'); generated = true; }
    if (!pw) return null;
    const salt = crypto.randomBytes(16).toString('hex');
    cfg = { secret: crypto.randomBytes(32).toString('hex'), salt, hash: hashPw(pw, salt), site: defaultSite(), smtp: defaultSmtp() };
    await store.set('config', cfg);
    if (generated) console.log(`\n  First run — admin password: ${pw}\n  (change it in the admin Settings tab)\n`);
  }
  cfg.site = cfg.site || defaultSite();
  cfg.smtp = cfg.smtp || defaultSmtp();
  return cfg;
}

// ---- sessions: signed, expiring cookie ----
const sign = (cfg, v) => crypto.createHmac('sha256', cfg.secret).update(v).digest('hex');
function makeSession(cfg) { const exp = String(Date.now() + SESSION_MS); return exp + '.' + sign(cfg, exp); }
function validSession(req, cfg) {
  if (!cfg) return false;
  const m = /(?:^|;\s*)tm_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(cfg, exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- link metadata (title / description / image) ----
async function isSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  // Block internal addresses so the preview fetcher can't be used to probe private networks.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) return null;
  const priv = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|fe80)/i;
  if (addrs.some((a) => priv.test(a.address))) return null;
  return u;
}
const decode = (s = '') => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
function metaContent(html, keys) {
  for (const key of keys) {
    const tag = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i').exec(html);
    if (tag) { const c = /content=["']([^"']*)["']/i.exec(tag[0]); if (c && c[1]) return decode(c[1]); }
  }
  return '';
}
async function fetchMeta(raw) {
  const u = await isSafeUrl(raw);
  if (!u) throw new Error('That URL is not valid or not publicly reachable.');
  const out = { url: u.href, title: u.hostname.replace(/^www\./, ''), description: '', image: '' };
  try {
    const res = await fetch(u.href, {
      redirect: 'follow', signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TMSolutionsPortfolioBot/1.0)', Accept: 'text/html' },
    });
    const html = (await res.text()).slice(0, 600000);
    const title = metaContent(html, ['og:title', 'twitter:title']) || decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1]);
    if (title) out.title = title.slice(0, 120);
    out.description = metaContent(html, ['og:description', 'twitter:description', 'description']).slice(0, 300);
    const img = metaContent(html, ['og:image', 'twitter:image']);
    if (img) { try { out.image = new URL(img, res.url || u.href).href; } catch {} }
  } catch { /* site blocked us or timed out — admin can fill details manually */ }
  return out;
}

// ---- email: minimal SMTP client (implicit TLS on 465, STARTTLS otherwise) ----
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
function splitEmails(s) {
  const list = String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  return list.length && list.every((x) => EMAIL_RE.test(x)) ? list : null;
}
function mailCfg(cfg) {
  const e = process.env, s = cfg.smtp;
  return {
    host: e.SMTP_HOST || s.host, port: Number(e.SMTP_PORT || s.port) || 465,
    user: e.SMTP_USER || s.user, pass: e.SMTP_PASS || s.pass, to: e.MAIL_TO || s.to || cfg.site.contactEmail,
  };
}
const mailReady = (c) => Boolean(c.host && c.user && c.pass && splitEmails(c.to) && EMAIL_RE.test(c.user));

function smtpSend(cfg, mail) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const to = splitEmails(cfg.to);
  const body = b64(mail.text).replace(/(.{76})/g, '$1\r\n');
  const data = [
    `From: "TM Solutions Website" <${cfg.user}>`,
    `To: ${to.join(', ')}`,
    mail.replyTo && EMAIL_RE.test(mail.replyTo) ? `Reply-To: <${mail.replyTo}>` : null,
    `Subject: =?UTF-8?B?${b64(mail.subject.replace(/[\r\n]+/g, ' '))}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${cfg.user.split('@')[1]}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body,
  ].filter((l) => l !== null).join('\r\n');

  return new Promise((resolve, reject) => {
    let sock, buf = '', pending = null, finished = false;
    const fail = (e) => {
      if (finished) return; finished = true; clearTimeout(timer); try { sock.destroy(); } catch {}
      if (!e.message) e = new Error(`Couldn't connect to ${cfg.host}:${cfg.port} (${e.code || 'network error'}). Check the server name and port.`);
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('The email server took too long to respond.')), 15000);
    const check = () => {
      if (!pending || !buf.endsWith('\r\n')) return;
      const lines = buf.split('\r\n');
      if (!/^\d{3} /.test(lines[lines.length - 2])) return; // multi-line reply not finished yet
      const text = buf, p = pending; buf = ''; pending = null; p(text);
    };
    const wire = (s) => {
      sock = s; s.setEncoding('utf8');
      s.on('data', (d) => { buf += d; check(); });
      s.on('error', fail);
      s.on('close', () => fail(new Error('The email server closed the connection.')));
    };
    const cmd = async (line, ok) => {
      if (line !== null) sock.write(line + '\r\n');
      const r = await new Promise((res) => { pending = res; check(); });
      if (!ok.includes(r.slice(0, 3))) throw new Error('Email server said: ' + r.trim().split('\r\n').pop());
      return r;
    };
    (async () => {
      const secure = cfg.port === 465;
      wire(secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port }));
      await cmd(null, ['220']);
      await cmd('EHLO tmsolutions.local', ['250']);
      if (!secure) {
        await cmd('STARTTLS', ['220']);
        const plain = sock; plain.removeAllListeners('data'); plain.removeAllListeners('close');
        const t = tls.connect({ socket: plain, servername: cfg.host });
        wire(t);
        await new Promise((r) => t.once('secureConnect', r));
        await cmd('EHLO tmsolutions.local', ['250']);
      }
      await cmd('AUTH LOGIN', ['334']);
      await cmd(b64(cfg.user), ['334']);
      await cmd(b64(cfg.pass), ['235']);
      await cmd(`MAIL FROM:<${cfg.user}>`, ['250']);
      for (const r of to) await cmd(`RCPT TO:<${r}>`, ['250', '251']);
      await cmd('DATA', ['354']);
      sock.write(data + '\r\n.\r\n');
      await cmd(null, ['250']);
      finished = true; clearTimeout(timer);
      try { sock.write('QUIT\r\n'); sock.end(); } catch {}
      resolve();
    })().catch((e) => fail(/^Email server said: 535|authentication/i.test(e.message) ? new Error('Login was rejected — check the email address and app password.') : e));
  });
}

// ---- helpers ----
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer-when-downgrade' };
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { ...SEC_HEADERS, ...(isObj ? { 'Content-Type': 'application/json' } : {}), ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined) { // Vercel has already consumed and parsed the stream
      try {
        const b = req.body;
        resolve(Buffer.isBuffer(b) ? JSON.parse(b.toString() || '{}') : typeof b === 'string' ? JSON.parse(b || '{}') : b || {});
      } catch { reject(new Error('Bad JSON')); }
      return;
    }
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 100000) { reject(new Error('Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Bad JSON')); } });
  });
}
const clean = (s, n) => String(s || '').trim().slice(0, n);
const httpOrEmpty = (s) => { try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };

function normalise(input, base = {}) {
  const url = httpOrEmpty(input.url ?? base.url);
  if (!url) throw new Error('A valid http(s) link is required.');
  return {
    ...base,
    url,
    title: clean(input.title ?? base.title, 120) || new URL(url).hostname,
    description: clean(input.description ?? base.description, 300),
    image: httpOrEmpty(input.image ?? base.image),
    category: clean(input.category ?? base.category, 40) || 'Project',
    tags: (Array.isArray(input.tags) ? input.tags : String(input.tags ?? (base.tags || []).join(',')).split(','))
      .map((t) => clean(t, 24)).filter(Boolean).slice(0, 6),
    featured: Boolean(input.featured ?? base.featured),
  };
}
const getProjects = async () => (await store.get('projects', null)) ?? SEED;

// ---- API ----
async function api(req, res, pathname) {
  const method = req.method;
  // Behind a host's proxy every request arrives from the proxy, so read the real visitor IP it forwards.
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
  const secureCookie = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const sameOrigin = () => !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;

  if (pathname === '/api/projects' && method === 'GET') {
    return send(res, 200, await getProjects(), { 'Cache-Control': 'no-store' });
  }
  const config = await loadConfig();
  if (pathname === '/api/site' && method === 'GET') {
    return send(res, 200, config ? config.site : defaultSite(), { 'Cache-Control': 'no-store' });
  }

  if (pathname === '/api/contact' && method === 'POST') {
    // public "Let's talk" form: validated, rate-limited, emailed to the owners
    if (!sameOrigin()) return send(res, 403, { error: 'Bad origin.' });
    if ((await store.rate.peek('contact:' + ip)) >= 5) return send(res, 429, { error: 'Too many messages — please try again later.' });
    const b = await readBody(req);
    if (b.website) return send(res, 200, { ok: true }); // honeypot: bots fill this, humans never see it
    const name = clean(b.name, 80), email = clean(b.email, 120), message = clean(b.message, 2000), topic = clean(b.topic, 40);
    if (!name) return send(res, 400, { error: 'Please tell us your name.' });
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Please enter a valid email address.' });
    if (message.length < 10) return send(res, 400, { error: 'Please write a few more words about your project.' });
    await store.rate.hit('contact:' + ip, 3600);
    const mc = config && mailCfg(config);
    if (!mc || !mailReady(mc)) {
      console.error('Contact form used but email is not configured (admin → Settings → Email).');
      return send(res, 503, { error: 'Our contact form is temporarily unavailable. Please try again later.' });
    }
    try {
      await smtpSend(mc, {
        replyTo: email,
        subject: `New website enquiry from ${name}${topic ? ' — ' + topic : ''}`,
        text: `You have a new enquiry from the TM Solutions website.\n\nName:  ${name}\nEmail: ${email}\nTopic: ${topic || '-'}\n\nMessage:\n${message}\n\n— Reply to this email to respond directly to ${name}.`,
      });
    } catch (e) {
      console.error('Email send failed:', e.message);
      return send(res, 502, { error: "We couldn't send your message right now. Please try again in a few minutes." });
    }
    return send(res, 201, { ok: true });
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (!config) return send(res, 503, { error: 'Admin is not set up yet. Add an ADMIN_PASSWORD environment variable and redeploy.' });
    if ((await store.rate.peek('login:' + ip)) >= 8) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const { password } = await readBody(req);
    const a = Buffer.from(hashPw(String(password || ''), config.salt)), b = Buffer.from(config.hash);
    if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
      await store.rate.hit('login:' + ip, 600);
      return send(res, 401, { error: 'Incorrect password.' });
    }
    return send(res, 200, { ok: true }, {
      'Set-Cookie': `tm_session=${makeSession(config)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secureCookie}`,
    });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': `tm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}` });
  }

  // everything below needs an admin session
  if (!validSession(req, config)) return send(res, 401, { error: 'Not signed in.' });
  if (method !== 'GET' && !sameOrigin()) return send(res, 403, { error: 'Bad origin.' }); // CSRF

  if (pathname === '/api/me') return send(res, 200, { ok: true });

  if (pathname === '/api/email-settings' && method === 'GET') {
    const s = config.smtp;
    return send(res, 200, { host: s.host, port: s.port, user: s.user, to: s.to, passSet: Boolean(s.pass), fromEnv: Boolean(process.env.SMTP_HOST) }, { 'Cache-Control': 'no-store' });
  }
  if (pathname === '/api/email-settings' && method === 'PUT') {
    const b = await readBody(req);
    const to = clean(b.to, 300);
    if (to && !splitEmails(to)) return send(res, 400, { error: 'Enter valid email address(es) to receive enquiries, separated by commas.' });
    config.smtp = {
      host: clean(b.host, 120), port: Number(b.port) || 465, user: clean(b.user, 120), to,
      pass: b.pass ? String(b.pass).replace(/\s/g, '').slice(0, 200) : config.smtp.pass, // keep the saved password unless a new one is typed
    };
    await store.set('config', config);
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/email-test' && method === 'POST') {
    const mc = mailCfg(config);
    if (!mailReady(mc)) return send(res, 400, { error: 'Fill in and save the email settings first.' });
    try {
      await smtpSend(mc, { replyTo: mc.user, subject: 'TM Solutions website — test email', text: 'Success! Enquiries from your website contact form will arrive in this inbox.' });
    } catch (e) { return send(res, 502, { error: e.message }); }
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/preview' && method === 'POST') {
    const { url } = await readBody(req);
    return send(res, 200, await fetchMeta(url));
  }
  if (pathname === '/api/projects' && method === 'POST') {
    const body = await readBody(req);
    const list = await getProjects();
    const item = normalise(body, { id: crypto.randomUUID(), createdAt: new Date().toISOString() });
    await store.set('projects', [item, ...list]);
    return send(res, 201, item);
  }
  const m = /^\/api\/projects\/([\w-]+)$/.exec(pathname);
  if (m) {
    const list = [...(await getProjects())];
    const i = list.findIndex((p) => p.id === m[1]);
    if (i < 0) return send(res, 404, { error: 'Not found.' });
    if (method === 'PUT') {
      list[i] = normalise(await readBody(req), list[i]);
      await store.set('projects', list);
      return send(res, 200, list[i]);
    }
    if (method === 'DELETE') {
      list.splice(i, 1);
      await store.set('projects', list);
      return send(res, 200, { ok: true });
    }
  }
  if (pathname === '/api/site' && method === 'PUT') {
    const b = await readBody(req);
    config.site = { contactEmail: clean(b.contactEmail, 120), linkedin: httpOrEmpty(b.linkedin), github: httpOrEmpty(b.github) };
    await store.set('config', config);
    return send(res, 200, config.site);
  }
  if (pathname === '/api/password' && method === 'POST') {
    const { password } = await readBody(req);
    if (String(password || '').length < 8) return send(res, 400, { error: 'Use at least 8 characters.' });
    config.hash = hashPw(password, config.salt);
    await store.set('config', config);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found.' });
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    await api(req, res, pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, /^Database/.test(e.message) ? 500 : 400, { error: /^Database/.test(e.message) ? 'The database is unavailable right now. Please try again.' : e.message || 'Request failed.' });
  }
}

module.exports = { handle };
