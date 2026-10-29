const $ = (s, r = document) => r.querySelector(s);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : '');

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else n.setAttribute(k, v);
  }
  kids.flat().forEach((c) => n.append(c));
  return n;
}
const hue = (s) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
const gradFor = (s) => `linear-gradient(135deg, hsl(${hue(s)} 80% 45%), hsl(${(hue(s) + 70) % 360} 80% 30%))`;

/* ---------- particle network background ---------- */
(function () {
  const c = $('#bg'), g = c.getContext('2d');
  let w, h, pts = [], mouse = { x: -999, y: -999 };
  const resize = () => {
    w = c.width = innerWidth; h = c.height = innerHeight;
    const n = Math.min(110, Math.floor((w * h) / 17000));
    pts = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35 }));
  };
  addEventListener('resize', resize); resize();
  addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  function tick() {
    g.clearRect(0, 0, w, h);
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      const dx = p.x - mouse.x, dy = p.y - mouse.y, d = Math.hypot(dx, dy);
      if (d < 140) { p.x += dx / d * 1.4; p.y += dy / d * 1.4; }
      g.fillStyle = 'rgba(8,145,178,.55)'; g.beginPath(); g.arc(p.x, p.y, 1.4, 0, 6.283); g.fill();
    }
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d < 130) { g.strokeStyle = `rgba(109,59,255,${.22 * (1 - d / 130)})`; g.beginPath(); g.moveTo(pts[i].x, pts[i].y); g.lineTo(pts[j].x, pts[j].y); g.stroke(); }
    }
    if (!reduce) requestAnimationFrame(tick);
  }
  tick();
})();

/* ---------- cursor glow, scroll progress, panel spotlight ---------- */
const glow = $('#glow');
addEventListener('mousemove', (e) => { glow.style.left = e.clientX + 'px'; glow.style.top = e.clientY + 'px'; });
addEventListener('scroll', () => {
  $('#progress').style.width = (scrollY / (document.body.scrollHeight - innerHeight)) * 100 + '%';
}, { passive: true });
document.addEventListener('mousemove', (e) => {
  const p = e.target.closest && e.target.closest('.panel');
  if (!p) return;
  const r = p.getBoundingClientRect();
  p.style.setProperty('--mx', e.clientX - r.left + 'px');
  p.style.setProperty('--my', e.clientY - r.top + 'px');
});

/* ---------- reveal on scroll ---------- */
const io = new IntersectionObserver((es) => es.forEach((e) => {
  if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}), { threshold: .12 });
const observe = (root = document) => root.querySelectorAll('.rv:not(.in)').forEach((n) => io.observe(n));
observe();

/* ---------- typewriter ---------- */
(function () {
  const words = ['Web platforms.', 'Cloud infrastructure.', 'Automated pipelines.', 'Digital products.'];
  const t = $('#type'); let w = 0, i = 0, del = false;
  if (reduce) { t.textContent = words[0]; return; }
  (function step() {
    const word = words[w];
    t.textContent = word.slice(0, i);
    if (!del && i === word.length) { del = true; return setTimeout(step, 1600); }
    if (del && i === 0) { del = false; w = (w + 1) % words.length; }
    i += del ? -1 : 1;
    setTimeout(step, del ? 35 : 75);
  })();
})();

/* ---------- counters ---------- */
function countUp(n, to) {
  if (reduce) { n.textContent = to; return; }
  const t0 = performance.now();
  (function f(t) {
    const p = Math.min(1, (t - t0) / 1200);
    n.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(f);
  })(t0);
}

/* ---------- portfolio ---------- */
let projects = [], active = 'All';

function card(p, i) {
  const href = safeHref(p.url);
  const thumb = el('div', { class: 'thumb' });
  const ph = el('div', { class: 'ph', style: `--g:${gradFor(p.title)}` }, (p.title.replace(/^[^A-Za-z0-9]+/, '')[0] || '•').toUpperCase());
  thumb.append(ph);
  if (p.image) {
    const img = el('img', { src: p.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.onload = () => ph.remove();
    img.onerror = () => img.remove();
    thumb.prepend(img);
  }
  thumb.append(el('span', { class: 'badge' }, p.category));
  if (p.featured) thumb.append(el('span', { class: 'badge star' }, '★ Featured'));

  let host = '';
  try { host = new URL(href).hostname.replace(/^www\./, ''); } catch {}
  const body = el('div', { class: 'body' },
    el('h3', {}, p.title),
    p.description ? el('p', {}, p.description) : '',
    p.tags.length ? el('div', { class: 'tags' }, p.tags.map((t) => el('span', {}, t))) : '',
    el('div', { class: 'visit' }, el('em', {}, host || 'Link coming soon'), href ? el('b', {}, 'Visit ↗') : ''),
  );
  const node = el(href ? 'a' : 'div', { class: 'card rv', style: `--d:${Math.min(i, 6) * .08}s` }, thumb, body);
  if (href) { node.href = href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
  if (!reduce) tilt(node);
  return node;
}

function tilt(n) {
  n.addEventListener('mousemove', (e) => {
    const r = n.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
    n.style.transform = `rotateY(${x * 10}deg) rotateX(${-y * 10}deg) translateY(-6px)`;
  });
  n.addEventListener('mouseleave', () => { n.style.transform = ''; });
}

function render() {
  const grid = $('#work-grid');
  grid.replaceChildren();
  const list = projects.filter((p) => active === 'All' || p.category === active);
  if (!list.length) grid.append(el('div', { class: 'empty' }, 'New projects are on the way.'));
  list.forEach((p, i) => grid.append(card(p, i)));
  observe(grid);

  const cats = ['All', ...new Set(projects.map((p) => p.category))];
  const f = $('#filters'); f.replaceChildren();
  if (cats.length > 2) cats.forEach((c) => {
    const b = el('button', { class: 'chip' + (c === active ? ' on' : '') }, c);
    b.onclick = () => { active = c; render(); };
    f.append(b);
  });
}

async function init() {
  $('#yr').textContent = new Date().getFullYear();
  const [pr, site] = await Promise.all([
    fetch('/api/projects').then((r) => r.json()).catch(() => []),
    fetch('/api/site').then((r) => r.json()).catch(() => ({})),
  ]);
  projects = pr;
  render();
  countUp($('#statProjects'), projects.length);
  document.querySelectorAll('[data-count="2"]').forEach((n) => countUp(n, 2));

  const names = [...projects.map((p) => p.title), 'Software', 'DevOps', 'Cloud', 'Automation'];
  const m = $('#marquee');
  [...names, ...names].forEach((t) => m.append(el('span', {}, t)));

  if (site.contactEmail) $('#alt').append('Prefer email? ', el('a', { href: 'mailto:' + site.contactEmail + '?subject=Project%20enquiry' }, site.contactEmail));
  const soc = $('#social');
  if (safeHref(site.linkedin)) soc.append(el('a', { class: 'btn sm', href: site.linkedin, target: '_blank', rel: 'noopener noreferrer' }, 'LinkedIn'));
  if (safeHref(site.github)) soc.append(el('a', { class: 'btn sm', href: site.github, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub'));
}
init();

/* ---------- "Let's talk" contact form ---------- */
(function () {
  const form = $('#cform'), err = $('#cerr'), btn = $('#csend');
  // nav / hero buttons focus the form once the scroll lands
  document.querySelectorAll('a[href="#contact"]').forEach((a) => a.addEventListener('click', () => setTimeout(() => $('#cName').focus({ preventScroll: true }), 700)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const data = Object.fromEntries(new FormData(form));
    if (!data.name.trim()) return (err.textContent = 'Please tell us your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email.trim())) return (err.textContent = 'Please enter a valid email address.');
    if (data.message.trim().length < 10) return (err.textContent = 'Please write a few more words about your project.');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || 'Something went wrong. Please try again.');
      form.classList.add('hidden'); $('#cdone').classList.remove('hidden'); form.reset();
    } catch (ex) {
      err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Send message →';
    }
  });
})();
