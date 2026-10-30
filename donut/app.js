(() => {
  'use strict';

  // ───────── 히어로: 1280×800 시안을 화면 폭에 맞춰 스케일 ─────────
  const hero = document.querySelector('.hero');
  const narrow = window.matchMedia('(max-width: 759px)');
  function fitHero() {
    const s = narrow.matches ? 1 : Math.min(document.documentElement.clientWidth / 1280, 1.5);
    hero.style.setProperty('--s', s.toFixed(4));
  }
  fitHero();
  window.addEventListener('resize', fitHero);
  narrow.addEventListener('change', fitHero);

  // ───────── 무용담 ─────────
  const logs = window.DONUT_ARCHIVE || [];
  const tagColor = { 질주: 'var(--pink)', 단속: 'var(--cyan)', 일상: 'var(--yellow)', 사고: '#ff6b4a' };
  const list = document.getElementById('logs');
  const empty = document.getElementById('logs-empty');

  document.querySelectorAll('[data-archive-count]').forEach(el => { el.textContent = logs.length; });

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderLogs(filter) {
    list.replaceChildren();
    const rows = logs
      .map((log, i) => ({ ...log, no: i + 1 }))
      .filter(log => filter === 'all' || log.tag === filter)
      .reverse(); // 최신 무용담이 위로
    for (const log of rows) {
      const li = el('li', 'log');
      li.style.setProperty('--c', tagColor[log.tag] || 'var(--pink)');
      const meta = el('div', 'log-meta');
      meta.append(el('span', 'log-no', '#' + String(log.no).padStart(2, '0')), el('span', null, log.date), el('span', 'log-tag', log.tag));
      li.append(meta, el('h3', null, log.title), el('p', null, log.body));
      if (log.loss) li.append(el('div', 'loss', '손실: ' + log.loss));
      list.append(li);
    }
    empty.hidden = rows.length > 0;
  }

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => {
        c.classList.toggle('on', c === chip);
        c.setAttribute('aria-pressed', c === chip);
      });
      renderLogs(chip.dataset.filter);
    });
  });
  document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', c.classList.contains('on')));
  renderLogs('all');

  // ───────── 방명록 낙서 (이 브라우저에만 저장) ─────────
  const KEY = 'donut-gang-wall-v1';
  const seed = [
    { name: '신드롬', msg: '빵 빵—!! 다녀감', ink: 'cyan', r: -6, seed: true },
    { name: '리아', msg: '도넛 한 입만 ♡', ink: 'pink', r: 4, seed: true },
    { name: '총장', msg: '여기 낙서 금지 (아님)', ink: 'yellow', r: -2, seed: true },
  ];
  const wall = document.getElementById('wall');
  const form = document.getElementById('gb-form');

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  function save(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* 저장 불가(시크릿 창 등) — 화면에만 남음 */ }
  }

  let mine = load();

  function renderWall() {
    wall.replaceChildren();
    const all = [...seed, ...mine.map((t, i) => ({ ...t, idx: i }))];
    for (const t of all) {
      const box = el('div', 'tag ' + (t.ink || 'pink'));
      box.style.setProperty('--r', (t.r || 0) + 'deg');
      box.append(el('span', 'tag-msg', t.msg), el('span', 'tag-by', '— ' + (t.name || '익명 라이더') + (t.date ? ' · ' + t.date : '')));
      if (!t.seed) {
        const del = el('button', 'tag-del', '✕');
        del.type = 'button';
        del.setAttribute('aria-label', '낙서 지우기');
        del.addEventListener('click', () => {
          mine.splice(t.idx, 1);
          save(mine);
          renderWall();
        });
        box.append(del);
      }
      wall.append(box);
    }
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    const data = new FormData(form);
    const msg = String(data.get('msg') || '').trim();
    if (!msg) return;
    const d = new Date();
    mine.push({
      name: String(data.get('name') || '').trim().slice(0, 16),
      msg: msg.slice(0, 120),
      ink: data.get('ink') || 'pink',
      r: Math.round((Math.random() * 14 - 7) * 10) / 10,
      date: `${d.getMonth() + 1}.${d.getDate()}`,
    });
    save(mine);
    renderWall();
    form.msg.value = '';
    form.msg.focus();
  });
  form.msg.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });

  renderWall();
})();
