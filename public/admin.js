const $ = (s) => document.querySelector(s);
const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : '');
let projects = [], editing = null;

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = 'toast'), 3200);
}
async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'Request failed (HTTP ' + r.status + ')'); e.status = r.status; throw e; }
  return data;
}
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === 'class' ? (n.className = v) : n.setAttribute(k, v);
  kids.flat().forEach((c) => n.append(c));
  return n;
}
const hue = (s) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
const gradFor = (s) => `linear-gradient(135deg, hsl(${hue(s)} 80% 45%), hsl(${(hue(s) + 70) % 360} 80% 30%))`;

/* ---- auth ---- */
function showApp(on) { $('#login').classList.toggle('hidden', on); $('#app').classList.toggle('hidden', !on); }
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/api/login', 'POST', { password: $('#pw').value }); $('#pw').value = ''; await load(); showApp(true); }
  catch (err) { toast(err.message, true); }
};
$('#logout').onclick = async () => { await api('/api/logout', 'POST'); showApp(false); };

/* ---- tabs ---- */
document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
  $('#tab-projects').classList.toggle('hidden', b.dataset.tab !== 'projects');
  $('#tab-settings').classList.toggle('hidden', b.dataset.tab !== 'settings');
}));

/* ---- email settings (where "Let's talk" enquiries are sent) ---- */
const m = { to: $('#mTo'), host: $('#mHost'), port: $('#mPort'), user: $('#mUser'), pass: $('#mPass') };
async function loadEmail() {
  const s = await api('/api/email-settings');
  m.to.value = s.to || ''; m.host.value = s.host || ''; m.port.value = s.port || 465; m.user.value = s.user || '';
  m.pass.value = ''; m.pass.placeholder = s.passSet ? '•••••••• saved — leave blank to keep' : 'Paste your app password';
}
function emailBody() { return { to: m.to.value, host: m.host.value, port: m.port.value, user: m.user.value, pass: m.pass.value }; }
$('#mailForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/api/email-settings', 'PUT', emailBody()); await loadEmail(); toast('Email settings saved — now send a test'); }
  catch (err) { toast(err.message, true); }
};
$('#mTest').onclick = async () => {
  const b = $('#mTest'); b.textContent = 'Sending…'; b.disabled = true;
  try { await api('/api/email-settings', 'PUT', emailBody()); await loadEmail(); await api('/api/email-test', 'POST'); toast('Test email sent — check your inbox ✓'); }
  catch (err) { toast(err.message, true); }
  b.textContent = 'Send test email'; b.disabled = false;
};

/* ---- project list ---- */
function renderList() {
  $('#count').textContent = projects.length;
  const list = $('#list'); list.replaceChildren();
  projects.forEach((p) => {
    const thumb = p.image
      ? el('img', { src: p.image, alt: '', referrerpolicy: 'no-referrer' })
      : el('div', { class: 'mini', style: `--g:${gradFor(p.title)}` }, (p.title[0] || '•').toUpperCase());
    const edit = el('button', { class: 'btn sm' }, p.url ? 'Edit' : 'Add link');
    const del = el('button', { class: 'btn sm danger' }, 'Delete');
    edit.onclick = () => startEdit(p);
    del.onclick = async () => {
      if (!confirm(`Remove "${p.title}" from the portfolio?`)) return;
      try { await api('/api/project?id=' + encodeURIComponent(p.id), 'DELETE'); toast('Removed'); await load(); } catch (e) { toast(e.message, true); }
    };
    list.append(el('div', { class: 'item' }, thumb,
      el('div', {}, el('h4', {}, p.title), el('small', {}, p.url || 'No link yet — add one to show a live preview')),
      el('div', { class: 'acts' }, edit, del)));
  });
}
async function load() { projects = await api('/api/projects'); renderList(); loadEmail().catch(() => {});
  try { const s = await api('/api/site'); $('#sEmail').value = s.contactEmail || ''; $('#sLi').value = s.linkedin || ''; $('#sGh').value = s.github || ''; } catch {}
}

/* ---- form ---- */
const f = { url: $('#url'), title: $('#title'), desc: $('#desc'), image: $('#image'), cat: $('#cat'), tags: $('#tags'), featured: $('#featured') };
function reset() {
  editing = null; $('#form').reset(); f.cat.value = 'Website'; f.featured.checked = true;
  $('#formTitle').textContent = 'Add published work'; $('#save').textContent = 'Add to portfolio';
  $('#cancel').classList.add('hidden'); $('#preview').replaceChildren();
}
function startEdit(p) {
  editing = p; f.url.value = p.url; f.title.value = p.title; f.desc.value = p.description; f.image.value = p.image;
  f.cat.value = p.category; f.tags.value = p.tags.join(', '); f.featured.checked = p.featured;
  $('#formTitle').textContent = 'Edit: ' + p.title; $('#save').textContent = 'Save changes';
  $('#cancel').classList.remove('hidden'); f.url.focus(); scrollTo({ top: 0, behavior: 'smooth' }); showPreview();
}
$('#cancel').onclick = reset;

function showPreview() {
  const box = $('#preview'); box.replaceChildren();
  if (!f.title.value && !f.url.value) return;
  const thumb = el('div', { class: 'thumb' });
  const ph = el('div', { class: 'ph', style: `--g:${gradFor(f.title.value || 'x')}` }, (f.title.value[0] || '•').toUpperCase());
  thumb.append(ph);
  if (safeHref(f.image.value) || /^\/api\/image\//.test(f.image.value)) {
    const img = el('img', { src: f.image.value, alt: '', referrerpolicy: 'no-referrer' });
    img.onload = () => ph.remove(); img.onerror = () => img.remove(); thumb.prepend(img);
  }
  thumb.append(el('span', { class: 'badge' }, f.cat.value || 'Project'));
  box.append(el('div', { class: 'card' }, thumb, el('div', { class: 'body' }, el('h3', {}, f.title.value || 'Untitled'), el('p', {}, f.desc.value))));
}
['title', 'desc', 'image', 'cat'].forEach((k) => f[k].addEventListener('input', showPreview));

$('#fetch').onclick = async () => {
  if (!f.url.value) return toast('Paste a link first', true);
  const b = $('#fetch'); b.textContent = 'Fetching…'; b.disabled = true;
  try {
    const m = await api('/api/preview', 'POST', { url: f.url.value });
    f.url.value = m.url; f.title.value = m.title; if (m.description) f.desc.value = m.description; if (m.image) f.image.value = m.image;
    showPreview(); toast(m.image || m.description ? 'Details fetched' : 'Link saved — site gave no preview, fill in details manually');
  } catch (e) { toast(e.message, true); }
  b.textContent = 'Fetch details'; b.disabled = false;
};
/* ---- upload a preview image: shrunk in the browser first so it stays small and fast ---- */
const MAX_BYTES = 450 * 1024;
function shrink(file) {
  return new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(src);
      let w = Math.min(1200, img.width), q = 0.85;
      const c = document.createElement('canvas');
      (function attempt() {
        c.width = w; c.height = Math.round((img.height * w) / img.width);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        const data = c.toDataURL('image/jpeg', q);
        if (data.length * 0.75 <= MAX_BYTES || w < 400) return resolve(data);
        q = Math.max(0.6, q - 0.08); w = Math.round(w * 0.85); attempt();
      })();
    };
    img.onerror = () => reject(new Error('That file is not an image we can read.'));
    img.src = src;
  });
}
$('#upBtn').onclick = () => $('#upFile').click();
$('#upFile').onchange = async () => {
  const file = $('#upFile').files[0]; if (!file) return;
  const b = $('#upBtn'); b.textContent = 'Uploading…'; b.disabled = true;
  try {
    const r = await api('/api/upload', 'POST', { data: await shrink(file) });
    f.image.value = r.url; showPreview(); toast('Image uploaded ✓');
  } catch (e) { toast(e.message, true); }
  b.textContent = 'Upload image'; b.disabled = false; $('#upFile').value = '';
};

// pasting a link into an empty form fetches its details automatically
f.url.addEventListener('paste', () => setTimeout(() => { if (!editing && !f.title.value) $('#fetch').click(); }, 50));

$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const body = { url: f.url.value, title: f.title.value, description: f.desc.value, image: f.image.value, category: f.cat.value, tags: f.tags.value, featured: f.featured.checked };
  try {
    if (editing) { await api('/api/project?id=' + encodeURIComponent(editing.id), 'PUT', body); toast('Saved'); }
    else { await api('/api/projects', 'POST', body); toast('Added to portfolio ✓'); }
    reset(); await load();
  } catch (err) { toast(err.message, true); }
};

/* ---- settings ---- */
$('#siteForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/api/site', 'PUT', { contactEmail: $('#sEmail').value, linkedin: $('#sLi').value, github: $('#sGh').value }); toast('Settings saved'); }
  catch (err) { toast(err.message, true); }
};
$('#pwForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/api/password', 'POST', { password: $('#np').value }); $('#np').value = ''; toast('Password updated'); }
  catch (err) { toast(err.message, true); }
};

/* ---- boot: already signed in? ---- */
api('/api/me').then(() => load().then(() => showApp(true))).catch(() => showApp(false));
