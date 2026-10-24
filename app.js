/* YenBaht — income & expense tracker with a yen and a baht wallet.
   Plain JS, no build step. Data lives in this device's storage and,
   when connected, is mirrored to the user's own Google Sheet. */
'use strict';

const VERSION = '1.0.0';
const SYM = { JPY: '¥', THB: '฿' };
const FLAG = { JPY: '🇯🇵', THB: '🇹🇭' };
const OTHER = { JPY: 'THB', THB: 'JPY' };
const DEFAULT_CATS = {
  expense: ['🍙 Food', '🛒 Groceries', '🚃 Transport', '☕ Cafe', '🛍️ Shopping', '💡 Bills',
    '🏠 Rent', '🎉 Fun', '💊 Health', '✈️ Travel', '👨‍👩‍👧 Family', '📦 Other'],
  income: ['💼 Salary', '💻 Side job', '🎁 Gift', '↩️ Refund', '📈 Investment', '📦 Other'],
};
const FRESH_AFTER = 10 * 60 * 1000; // reopening after this long starts a clean entry

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const str = v => (v == null ? '' : String(v));
const pad = n => String(n).padStart(2, '0');

/* ---------------- storage ---------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('yb.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('yb.' + k, JSON.stringify(v)); } catch (e) { toast('Phone storage is full — export a backup'); } },
};
const S = {
  tx: store.get('tx', []),
  cfg: Object.assign({
    syncUrl: '', secret: '', autoWallet: true, lastWallet: 'JPY',
    lastPull: 0, lastSync: 0, cats: JSON.parse(JSON.stringify(DEFAULT_CATS)), hideInstall: false,
  }, store.get('cfg', {})),
};
const saveTx = () => store.set('tx', S.tx);
const saveCfg = () => store.set('cfg', S.cfg);

/* ---------------- money & dates ---------------- */
const round = (a, w) => (w === 'JPY' ? Math.round(a) : Math.round(a * 100) / 100);
function fmt(a, w, signed) {
  a = Number(a) || 0;
  const dec = w === 'THB' && Math.round(Math.abs(a) * 100) % 100 ? 2 : 0;
  const s = Math.abs(a).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (a < 0 ? '−' : signed && a > 0 ? '+' : '') + SYM[w] + s;
}
function parseNum(s) { return parseFloat(String(s == null ? '' : s).replace(/[,\s¥￥฿]/g, '')); }
function formatBuf(b) {
  if (!b) return '';
  const [i, d] = b.split('.');
  const ii = Number(i || 0).toLocaleString('en-US');
  return d !== undefined ? ii + '.' + d : ii;
}
const monthKey = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1); };
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
function shiftMonth(m, n) { const [y, mo] = m.split('-').map(Number); return monthKey(new Date(y, mo - 1 + n, 1)); }
function monthLabel(m, short) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', short ? { month: 'short' } : { month: 'long', year: 'numeric' });
}
const fmtTime = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const fmtWhen = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + fmtTime(t);
function toLocalInput(t) { return dayKey(t) + 'T' + fmtTime(t); }
function fromLocalInput(v) {
  if (!v) return 0;
  const [d, tm] = v.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [h, mi] = (tm || '12:00').split(':').map(Number);
  return new Date(y, m - 1, dd, h, mi).getTime();
}
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return fmtWhen(t);
}
function tzWallet() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz === 'Asia/Tokyo' ? 'JPY' : tz === 'Asia/Bangkok' ? 'THB' : null;
  } catch (e) { return null; }
}

/* ---------------- records ---------------- */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}
function mkTx(o) {
  const now = Date.now();
  return Object.assign({
    id: uuid(), time: now, wallet: 'JPY', type: 'expense', amount: 0, category: '', merchant: '', note: '',
    toWallet: '', toAmount: '', source: 'manual', updated: now, deleted: false, dirty: true,
  }, o);
}
function addTx(t) { S.tx.push(t); saveTx(); scheduleSync(); }
function updateTx(t, patch) { Object.assign(t, patch, { updated: Math.max(Date.now(), (t.updated || 0) + 1), dirty: true }); saveTx(); scheduleSync(); }
function removeTx(t) { updateTx(t, { deleted: true }); }

function balance(w) {
  let b = 0;
  for (const t of S.tx) {
    if (t.deleted) continue;
    const a = Number(t.amount) || 0;
    if (t.type === 'transfer') {
      if (t.wallet === w) b -= a;
      if (t.toWallet === w) b += Number(t.toAmount) || 0;
    } else if (t.wallet === w) {
      b += t.type === 'expense' ? -a : a; // income and balance adjustments add
    }
  }
  return round(b, w);
}
function monthTotals(m, w, maxDay) {
  const r = { expense: 0, income: 0, byCat: {}, incCat: {} };
  for (const t of S.tx) {
    if (t.deleted || t.wallet !== w || monthKey(t.time) !== m) continue;
    if (maxDay && new Date(t.time).getDate() > maxDay) continue;
    const a = Number(t.amount) || 0;
    const c = t.category || 'Needs category';
    if (t.type === 'expense') { r.expense += a; r.byCat[c] = (r.byCat[c] || 0) + a; }
    else if (t.type === 'income') { r.income += a; r.incCat[c] = (r.incCat[c] || 0) + a; }
  }
  r.expense = round(r.expense, w);
  r.income = round(r.income, w);
  return r;
}
const needsReview = t => !t.deleted && (t.type === 'expense' || t.type === 'income') && (!t.category || !(t.amount > 0));
const reviewList = () => S.tx.filter(needsReview).sort((a, b) => a.time - b.time);
function srcLabel(t) {
  const s = t.source || '';
  if (s.startsWith('auto')) return s.slice(5).trim() || 'Apple Pay';
  if (s === 'paypay') return 'PayPay';
  return s === 'manual' || !s ? '' : s;
}

/* ---------------- categories ---------------- */
function parseCat(line) {
  const s = line.trim();
  const i = s.indexOf(' ');
  if (i < 0 || /^[\p{L}\p{N}]/u.test(s)) return { e: '•', n: s };
  return { e: s.slice(0, i), n: s.slice(i + 1).trim() };
}
const cats = type => (S.cfg.cats[type] || DEFAULT_CATS[type]).map(parseCat).filter(c => c.n);
const catExists = (name, type) => !!name && cats(type === 'income' ? 'income' : 'expense').some(c => c.n === name);
function catEmoji(name) {
  if (!name || name === 'Needs category') return '❔';
  for (const type of ['expense', 'income']) { const c = cats(type).find(x => x.n === name); if (c) return c.e; }
  return '•';
}
function otherName(type) {
  const list = cats(type === 'income' ? 'income' : 'expense');
  const o = list.find(c => /other/i.test(c.n));
  return (o || list[list.length - 1]).n;
}
const catBtn = c => `<button class="cat" data-cat="${esc(c.n)}"><span class="e">${c.e}</span><span class="n">${esc(c.n)}</span></button>`;

/* ---------------- auto-categorize (learns from your choices) ---------------- */
function merchantKeys(m) {
  const s = str(m).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const toks = s.split(' ');
  while (toks.length > 1 && /(店|支店|branch|\d+)$/.test(toks[toks.length - 1])) toks.pop();
  return toks.length > 1 ? [toks.join(' '), 'w:' + toks[0]] : [toks[0]];
}
function merchantIndex() {
  const idx = new Map();
  S.tx.filter(t => !t.deleted && t.category && t.merchant)
    .sort((a, b) => a.updated - b.updated)
    .forEach(t => merchantKeys(t.merchant).forEach(k => idx.set(k, t.category)));
  return idx;
}
const TRANSIT = /(JR|鉄道|電鉄|電車|メトロ|地下鉄|交通局|バス|改札|railway|metro|station|transit|東急|小田急|京王|西武|東武|京急|京成|相鉄|都営|モノレール|ゆりかもめ|りんかい|BTS|MRT)/i;
const TRANSIT_CARD = /(suica|pasmo|icoca|manaca|toica|kitaca|nimoca|sugoca|hayakaken|pitapa)/i;
function guessCategory(t, idx) {
  for (const k of merchantKeys(t.merchant)) {
    const c = idx.get(k);
    if (c && catExists(c, t.type)) return c;
  }
  if (t.type === 'expense' && catExists('Transport', 'expense') &&
      (TRANSIT.test(t.merchant || '') || (TRANSIT_CARD.test(t.source || '') && !str(t.merchant).trim()))) return 'Transport';
  return '';
}
function autoCategorize() {
  const pending = S.tx.filter(t => !t.deleted && !t.category && (t.type === 'expense' || t.type === 'income'));
  if (!pending.length) return 0;
  const idx = merchantIndex();
  let n = 0;
  for (const t of pending) {
    const c = guessCategory(t, idx);
    if (c) { t.category = c; t.updated = Date.now(); t.dirty = true; n++; }
  }
  if (n) { saveTx(); scheduleSync(); }
  return n;
}

/* ---------------- UI state ---------------- */
const ui = {
  view: 'add', wallet: S.cfg.lastWallet === 'THB' ? 'THB' : 'JPY', type: 'expense',
  buf: '', buf2: '', side: 'from', note: '', date: null,
  hist: { month: monthKey(Date.now()), wallet: 'ALL' },
  statsMonth: monthKey(Date.now()),
  hiddenAt: 0,
};
if (S.cfg.autoWallet) { const w = tzWallet(); if (w) ui.wallet = w; }

/* ---------------- render ---------------- */
function render() {
  renderWallets();
  setDot();
  if (ui.view === 'add') renderAdd();
  else if (ui.view === 'history') renderHistory();
  else renderStats();
}

function renderWallets() {
  const m = monthKey(Date.now());
  $('#wallets').innerHTML = ['JPY', 'THB'].map(w => {
    const spent = monthTotals(m, w).expense;
    return `<button class="wallet ${ui.wallet === w ? 'on' : ''}" data-w="${w}" aria-pressed="${ui.wallet === w}">
      <div class="w-name">${FLAG[w]} ${w}</div>
      <div class="w-bal">${fmt(balance(w), w)}</div>
      <div class="w-sub">${spent ? 'Spent ' + fmt(spent, w) + ' this month' : 'Nothing spent this month'}</div>
    </button>`;
  }).join('');
  document.body.dataset.wallet = ui.wallet;
}

function renderAdd() {
  const isX = ui.type === 'transfer';
  const n = reviewList().length;
  const inbox = $('#inbox');
  inbox.hidden = !n;
  if (n) inbox.innerHTML = `⚡ <span><b>${n}</b> new ${n > 1 ? 'payments need' : 'payment needs'} a category</span><span class="go">Sort ›</span>`;
  $$('#type-seg button').forEach(b => b.classList.toggle('on', b.dataset.type === ui.type));
  $('#amount').hidden = isX;
  $('#cats').hidden = isX;
  $('#xfer').hidden = !isX;
  if (isX) renderXfer();
  else {
    $('#cats').innerHTML = cats(ui.type).map(catBtn).join('');
    renderAmount();
  }
  renderKeypad();
  renderMeta();
}
function renderAmount() {
  const el = $('#amount');
  el.innerHTML = `<span class="sym">${SYM[ui.wallet]}</span>${formatBuf(ui.buf) || '0'}<span class="caret"></span>`;
  el.classList.toggle('zero', !ui.buf);
  $('#cats').classList.toggle('dim', !(parseFloat(ui.buf) > 0));
}
function renderXfer() {
  const from = ui.wallet, to = OTHER[from];
  const a = parseFloat(ui.buf) || 0, b = parseFloat(ui.buf2) || 0;
  let mid = 'Tap a box, then type the amount';
  if (a && b) {
    const jpy = from === 'JPY' ? a : b, thb = from === 'THB' ? a : b;
    mid = `Rate: ฿1 = ¥${(jpy / thb).toFixed(2)}`;
  }
  $('#xfer').innerHTML = `
    <button class="xf ${ui.side === 'from' ? 'on' : ''}" data-side="from">
      <span class="xf-l">Send from<br>${FLAG[from]} ${from}</span><span class="xf-v ${from}">${SYM[from]}${formatBuf(ui.buf) || '0'}</span></button>
    <div class="xf-mid">↓ ${mid}</div>
    <button class="xf ${ui.side === 'to' ? 'on' : ''}" data-side="to">
      <span class="xf-l">Arrives in<br>${FLAG[to]} ${to}</span><span class="xf-v ${to}">${SYM[to]}${formatBuf(ui.buf2) || '0'}</span></button>
    <button class="primary" id="xf-save" ${a > 0 && b > 0 ? '' : 'disabled'}>Save transfer</button>`;
}
function activeWallet() { return ui.type === 'transfer' && ui.side === 'to' ? OTHER[ui.wallet] : ui.wallet; }
function renderKeypad() {
  const k = activeWallet() === 'THB' ? '.' : '00';
  const el = $('#k-dot');
  el.dataset.k = k;
  el.textContent = k;
}
function dateLabel() {
  if (!ui.date) return 'Today';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (ui.date === dayKey(y)) return 'Yesterday';
  const [yy, m, d] = ui.date.split('-').map(Number);
  return new Date(yy, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function renderMeta() {
  $('#date-label').textContent = dateLabel();
  $('#date-chip').classList.toggle('set', !!ui.date);
  const di = $('#date-input');
  di.max = dayKey(Date.now());
  di.value = ui.date || dayKey(Date.now());
  if ($('#note').value !== ui.note) $('#note').value = ui.note;
}

function itemHTML(t, showWallet) {
  let ic, t1, warn = false, amt, extra = [];
  const src = srcLabel(t);
  if (t.type === 'transfer') {
    ic = '⇄'; t1 = 'Transfer';
    amt = `<div class="amt">${fmt(-t.amount, t.wallet)}<small>→ ${fmt(t.toAmount, t.toWallet)}</small></div>`;
  } else if (t.type === 'adjust') {
    ic = '⚖️'; t1 = 'Balance adjustment';
    amt = `<div class="amt">${fmt(t.amount, t.wallet, true)}</div>`;
  } else {
    ic = catEmoji(t.category);
    t1 = t.category || t.merchant || 'Needs category';
    warn = !t.category || !(t.amount > 0);
    if (t.category && t.merchant) extra.push(esc(t.merchant));
    amt = t.amount > 0
      ? `<div class="amt ${t.type === 'income' ? 'inc' : ''}">${fmt(t.type === 'income' ? t.amount : -t.amount, t.wallet, true)}</div>`
      : `<div class="amt"><small>amount?</small></div>`;
  }
  if (t.note) extra.push(esc(t.note));
  const badges = (showWallet ? `<span class="badge ${t.wallet}">${t.wallet}</span>` : '') + (src ? `<span class="badge">${esc(src)}</span>` : '');
  return `<button class="item" data-id="${esc(t.id)}">
    <span class="ic">${ic}</span>
    <span class="tx"><div class="t1 ${warn ? 'warn' : ''}">${esc(t1)}</div><div class="t2">${badges}${fmtTime(t.time)}${extra.length ? ' · ' + extra.join(' · ') : ''}</div></span>
    ${amt}</button>`;
}

function renderHistory() {
  const h = ui.hist;
  const cur = monthKey(Date.now());
  const list = S.tx.filter(t => !t.deleted && monthKey(t.time) === h.month &&
    (h.wallet === 'ALL' || t.wallet === h.wallet || t.toWallet === h.wallet)).sort((a, b) => b.time - a.time);
  const wallets = h.wallet === 'ALL' ? ['JPY', 'THB'] : [h.wallet];
  const sums = wallets.map(w => {
    const m = monthTotals(h.month, w);
    return `<div class="sum"><span class="f">${FLAG[w]}</span><span><span class="lbl">Out</span><b>${fmt(m.expense, w)}</b></span><span class="in"><span class="lbl">In</span><b>${fmt(m.income, w)}</b></span></div>`;
  }).join('');
  const days = [];
  for (const t of list) {
    const k = dayKey(t.time);
    if (!days.length || days[days.length - 1].k !== k) days.push({ k, items: [] });
    days[days.length - 1].items.push(t);
  }
  const body = days.map(d => {
    const spent = wallets.map(w => {
      const s = d.items.reduce((a, t) => a + (t.type === 'expense' && t.wallet === w ? t.amount : 0), 0);
      return s ? fmt(-round(s, w), w) : '';
    }).filter(Boolean).join(' · ');
    const [y, m, dd] = d.k.split('-').map(Number);
    const label = new Date(y, m - 1, dd).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    return `<div class="day-h"><span>${label}</span><span>${spent}</span></div>
      <div class="list">${d.items.map(t => itemHTML(t, h.wallet === 'ALL')).join('')}</div>`;
  }).join('');
  $('#view-history').innerHTML = `
    <div class="bar-head">
      <div class="month-nav"><button class="icon-btn" data-m="-1" aria-label="Previous month">‹</button><b>${monthLabel(h.month)}</b>
        <button class="icon-btn" data-m="1" aria-label="Next month" ${h.month >= cur ? 'disabled' : ''}>›</button></div>
      <div class="seg small">${['ALL', 'JPY', 'THB'].map(w => `<button data-hw="${w}" class="${h.wallet === w ? 'on' : ''}">${w === 'ALL' ? 'Both' : FLAG[w] + ' ' + w}</button>`).join('')}</div>
    </div>
    <div class="sums">${sums}</div>
    ${body || '<div class="empty">No records this month.</div>'}`;
}

function renderStats() {
  const w = ui.wallet;
  const mk = ui.statsMonth;
  const cur = monthKey(Date.now());
  const isCur = mk === cur;
  const m = monthTotals(mk, w);
  const [y, mo] = mk.split('-').map(Number);
  const days = isCur ? new Date().getDate() : new Date(y, mo, 0).getDate();
  const pm = shiftMonth(mk, -1);
  const prev = monthTotals(pm, w, isCur ? days : 0);
  const net = round(m.income - m.expense, w);
  let note = m.expense ? `Average ${fmt(round(m.expense / days, w), w)} a day` : 'No spending recorded';
  if (prev.expense > 0 && m.expense > 0) {
    const p = Math.round((m.expense / prev.expense - 1) * 100);
    note += ` · ${p > 0 ? '▲ ' + p + '% more' : p < 0 ? '▼ ' + -p + '% less' : 'same'} than ${monthLabel(pm, true)}${isCur ? ' 1–' + days : ''}`;
  }
  const bars = (obj, total, kind) => {
    const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '';
    const max = rows[0][1];
    return `<div class="bars">${rows.map(([name, val]) => `
      <div class="bar-row"><div class="bar-top"><span class="nm">${catEmoji(name)} ${esc(name)}</span>
        <span class="val">${fmt(round(val, w), w)}<small>${Math.round(val / total * 100)}%</small></span></div>
        <div class="bar-track"><div class="bar-fill ${kind}" style="width:${(val / max * 100).toFixed(1)}%"></div></div></div>`).join('')}</div>`;
  };
  $('#view-stats').innerHTML = `
    <div class="bar-head">
      <div class="month-nav"><button class="icon-btn" data-m="-1" aria-label="Previous month">‹</button><b>${monthLabel(mk)}</b>
        <button class="icon-btn" data-m="1" aria-label="Next month" ${isCur ? 'disabled' : ''}>›</button></div>
      <div class="st-title">${FLAG[w]} ${w} wallet · tap a wallet above to switch</div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">Spent</div><div class="v">${fmt(m.expense, w)}</div></div>
      <div class="tile"><div class="k">Earned</div><div class="v" style="color:var(--good)">${fmt(m.income, w)}</div></div>
      <div class="tile"><div class="k">Net</div><div class="v">${fmt(net, w, true)}</div></div>
    </div>
    <div class="st-note">${note}</div>
    ${m.expense ? `<div class="sec-h">SPENDING BY CATEGORY</div>${bars(m.byCat, m.expense, '')}` : ''}
    ${m.income ? `<div class="sec-h">INCOME BY CATEGORY</div>${bars(m.incCat, m.income, 'inc')}` : ''}
    ${!m.expense && !m.income ? '<div class="empty">Nothing recorded for this wallet in this month.</div>' : ''}`;
}

function showView(v) {
  ui.view = v;
  for (const x of ['add', 'history', 'stats']) $('#view-' + x).hidden = x !== v;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  render();
  if (v !== 'add') $('#view-' + v).scrollTop = 0;
}

/* ---------------- quick add ---------------- */
function setWallet(w) {
  if (w === ui.wallet) return;
  if (ui.type === 'transfer') [ui.buf, ui.buf2] = [ui.buf2, ui.buf];
  ui.wallet = w;
  S.cfg.lastWallet = w;
  saveCfg();
  const jpyKey = ui.wallet === 'JPY' ? 'buf' : 'buf2';
  ui[jpyKey] = ui[jpyKey].split('.')[0];
  render();
}
function press(k) {
  const key = ui.type === 'transfer' && ui.side === 'to' ? 'buf2' : 'buf';
  const w = activeWallet();
  let b = ui[key];
  if (k === 'del') b = b.slice(0, -1);
  else if (k === '.') {
    if (w !== 'THB' || b.includes('.')) return;
    b = (b || '0') + '.';
  } else {
    if (b.includes('.')) {
      if (b.split('.')[1].length + k.length > 2) return;
    } else {
      if (b === '0') b = '';
      if (!b && k === '00') return;
      if ((b + k).length > 9) return;
    }
    b += k;
  }
  ui[key] = b;
  if (ui.type === 'transfer') renderXfer(); else renderAmount();
}
function entryTime() {
  if (!ui.date || ui.date === dayKey(Date.now())) return Date.now();
  const [y, m, d] = ui.date.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0).getTime();
}
function resetEntry() { ui.buf = ''; ui.buf2 = ''; ui.note = ''; ui.side = 'from'; ui.type = 'expense'; }
function quickSave(cat) {
  const amt = round(parseFloat(ui.buf) || 0, ui.wallet);
  if (!(amt > 0)) { shake('#amount'); return; }
  const t = mkTx({ wallet: ui.wallet, type: ui.type, amount: amt, category: cat, note: ui.note.trim(), time: entryTime() });
  addTx(t);
  resetEntry();
  render();
  toast(`${t.type === 'income' ? 'Income' : 'Saved'} ${fmt(amt, t.wallet)} · ${catEmoji(cat)} ${cat}`, () => { removeTx(t); render(); });
}
function saveTransfer() {
  const from = ui.wallet, to = OTHER[from];
  const a = round(parseFloat(ui.buf) || 0, from), b = round(parseFloat(ui.buf2) || 0, to);
  if (!(a > 0) || !(b > 0)) { shake('#xfer'); return; }
  const t = mkTx({ type: 'transfer', wallet: from, amount: a, toWallet: to, toAmount: b, note: ui.note.trim(), time: entryTime() });
  addTx(t);
  resetEntry();
  render();
  toast(`Transfer saved: ${fmt(a, from)} → ${fmt(b, to)}`, () => { removeTx(t); render(); });
}

/* ---------------- toast & helpers ---------------- */
let toastTimer = 0;
function toast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button>Undo</button>' : ''}`;
  if (undo) el.querySelector('button').onclick = () => { el.classList.remove('show'); undo(); toast('Undone'); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 4500 : 2600);
}
function shake(el) {
  el = typeof el === 'string' ? $(el) : el;
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { window.prompt('Copy this:', text); return false; }
}

/* ---------------- bottom sheet ---------------- */
let sheetOnClose = null;
function openSheet(title, html, mount, onClose) {
  const wrap = $('#sheet');
  wrap.innerHTML = `<div class="sheet-back"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" id="sheet-x" aria-label="Close">✕</button></div>
    <div class="sheet-body">${html}</div></div>`;
  wrap.classList.add('open');
  wrap.querySelector('.sheet-back').onclick = closeSheet;
  $('#sheet-x').onclick = closeSheet;
  sheetOnClose = onClose || null;
  if (mount) mount(wrap.querySelector('.sheet-body'));
}
function closeSheet() {
  const wrap = $('#sheet');
  if (!wrap.classList.contains('open')) return;
  wrap.classList.remove('open');
  wrap.innerHTML = '';
  const f = sheetOnClose;
  sheetOnClose = null;
  if (f) f();
  render();
}
const sheetOpen = () => $('#sheet').classList.contains('open');
const segHTML = (name, opts, val) => `<div class="seg" data-f="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === val ? 'on' : ''}">${l}</button>`).join('')}</div>`;

/* ---------------- sort auto-recorded payments ---------------- */
function openReview() {
  if (!reviewList().length) return;
  openSheet('Sort payments', '<div id="rv"></div>', body => {
    const box = $('#rv', body);
    const draw = () => {
      const list = reviewList();
      if (!list.length) { closeSheet(); toast('All sorted ✓'); return; }
      const t = list[0];
      const kind = t.type === 'income' ? 'income' : 'expense';
      const sortable = list.filter(x => x.amount > 0).length;
      box.innerHTML = `
        <div class="rv-card">
          <div class="rv-top">${srcLabel(t) ? `<span class="badge">${esc(srcLabel(t))}</span>` : ''}<span>${esc(fmtWhen(t.time))}</span><span class="rv-left">${list.length} left</span></div>
          <div class="rv-merchant">${esc(t.merchant || t.note || 'No shop name')}</div>
          ${t.amount > 0
            ? `<div class="rv-amt">${fmt(kind === 'income' ? t.amount : -t.amount, t.wallet, true)}</div>`
            : `<label class="rv-missing">Amount wasn't sent — type it, or delete this one:<input id="rv-amt" inputmode="decimal" placeholder="${SYM[t.wallet]}0" autocomplete="off"></label>`}
        </div>
        <div class="rv-cats">${cats(kind).map(catBtn).join('')}</div>
        <div class="btns"><button class="danger" id="rv-del">Delete</button>${sortable > 1 ? `<button class="secondary" id="rv-other">All ${sortable} → ${esc(otherName(kind))}</button>` : ''}</div>`;
    };
    box.addEventListener('click', e => {
      const t = reviewList()[0];
      if (!t) return;
      const b = e.target.closest('.cat');
      if (b) {
        const patch = { category: b.dataset.cat };
        if (!(t.amount > 0)) {
          const inp = $('#rv-amt', box);
          const v = parseNum(inp.value);
          if (!(v > 0)) { shake(inp); inp.focus(); return; }
          patch.amount = round(v, t.wallet);
        }
        updateTx(t, patch);
        autoCategorize(); // same shop elsewhere in the list gets sorted too
        draw();
        return;
      }
      if (e.target.closest('#rv-del')) { removeTx(t); draw(); return; }
      if (e.target.closest('#rv-other')) {
        for (const x of reviewList()) if (x.amount > 0 && !x.category) updateTx(x, { category: otherName(x.type) });
        draw();
      }
    });
    draw();
  });
}

/* ---------------- edit a record ---------------- */
function openEdit(t) {
  const isX = t.type === 'transfer', isAdj = t.type === 'adjust';
  let type = t.type, wallet = t.wallet, cat = t.category;
  const title = isX ? 'Edit transfer' : isAdj ? 'Balance adjustment' : 'Edit record';
  const html = `<div class="form">
    ${!isX && !isAdj ? segHTML('type', [['expense', 'Expense'], ['income', 'Income']], type) : ''}
    ${segHTML('wallet', [['JPY', FLAG.JPY + ' JPY'], ['THB', FLAG.THB + ' THB']], wallet)}
    <label class="field"><span>${isX ? 'Sent' : isAdj ? 'Change (+ or −)' : 'Amount'}</span><input id="ed-amt" inputmode="${isAdj ? 'text' : 'decimal'}" value="${t.amount || ''}" autocomplete="off"></label>
    ${isX ? `<label class="field"><span id="ed-to-l">Arrived (${OTHER[wallet]})</span><input id="ed-to" inputmode="decimal" value="${t.toAmount || ''}" autocomplete="off"></label>` : ''}
    ${!isX && !isAdj ? '<div class="field"><span>Category</span><div class="chips" id="ed-cats"></div></div>' : ''}
    <label class="field"><span>Date &amp; time</span><input id="ed-time" type="datetime-local" value="${toLocalInput(t.time)}"></label>
    ${t.merchant ? `<div class="field"><span>Shop</span><div class="ro">${esc(t.merchant)}</div></div>` : ''}
    <label class="field"><span>Note</span><input id="ed-note" value="${esc(t.note)}" autocomplete="off"></label>
    ${srcLabel(t) ? `<p class="hint">Recorded by: ${esc(srcLabel(t))}</p>` : ''}
    <div class="btns"><button class="danger" id="ed-del">Delete</button><button class="primary" id="ed-save">Save</button></div></div>`;
  openSheet(title, html, body => {
    const drawCats = () => {
      const box = $('#ed-cats', body);
      if (box) box.innerHTML = cats(type).map(c => `<button type="button" class="chipb ${c.n === cat ? 'on' : ''}" data-c="${esc(c.n)}">${c.e} ${esc(c.n)}</button>`).join('');
    };
    drawCats();
    body.addEventListener('click', e => {
      const sb = e.target.closest('.seg[data-f] button');
      if (sb) {
        const seg = sb.parentElement;
        $$('button', seg).forEach(b => b.classList.toggle('on', b === sb));
        if (seg.dataset.f === 'type') { type = sb.dataset.v; if (!catExists(cat, type)) cat = ''; drawCats(); }
        else { wallet = sb.dataset.v; const l = $('#ed-to-l', body); if (l) l.textContent = `Arrived (${OTHER[wallet]})`; }
        return;
      }
      const cb = e.target.closest('.chipb');
      if (cb) { cat = cb.dataset.c; drawCats(); return; }
      if (e.target.closest('#ed-del')) {
        removeTx(t);
        closeSheet();
        toast('Deleted', () => { updateTx(t, { deleted: false }); render(); });
        return;
      }
      if (e.target.closest('#ed-save')) {
        const amtEl = $('#ed-amt', body);
        const amt = parseNum(amtEl.value.replace('−', '-'));
        if (isAdj ? !amt : !(amt > 0)) { shake(amtEl); return; }
        const patch = {
          wallet,
          amount: round(isAdj ? amt : Math.abs(amt), wallet),
          note: $('#ed-note', body).value.trim(),
          time: fromLocalInput($('#ed-time', body).value) || t.time,
        };
        if (!isX && !isAdj) { patch.type = type; patch.category = cat; }
        if (isX) {
          const toEl = $('#ed-to', body);
          const to = parseNum(toEl.value);
          if (!(to > 0)) { shake(toEl); return; }
          patch.toWallet = OTHER[wallet];
          patch.toAmount = round(to, OTHER[wallet]);
        }
        updateTx(t, patch);
        closeSheet();
        toast('Saved');
      }
    });
  });
}

/* ---------------- settings ---------------- */
function shortcutUrl() {
  const u = S.cfg.syncUrl;
  return u ? u + (u.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(S.cfg.secret) : '';
}
function syncStatusText() {
  if (!S.cfg.syncUrl) return 'Not connected. Connect a Google Sheet to auto-record Suica / Apple Pay payments and keep a backup.';
  if (sync$.busy) return 'Syncing…';
  if (sync$.err) return '⚠️ ' + sync$.err;
  return S.cfg.lastSync ? '✓ Connected · synced ' + ago(S.cfg.lastSync) : 'Not synced yet.';
}
function refreshSyncStatus() {
  const el = $('#s-status');
  if (el) { el.textContent = syncStatusText(); el.classList.toggle('err', !!sync$.err); }
}
function openSettings() { openSheet('Settings', '<div id="st"></div>', mountSettings); }
function mountSettings(body) {
  const c = S.cfg;
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return '?'; } })();
  const live = S.tx.filter(t => !t.deleted).length;
  const box = $('#st', body);
  box.innerHTML = `
    <div class="group-t">Balances</div>
    <div class="group">
      ${['JPY', 'THB'].map(w => `<label class="field" style="margin-bottom:8px"><span>${FLAG[w]} ${w} — what I have now</span>
        <div class="inline"><input class="num" id="bal-${w}" inputmode="decimal" placeholder="${esc(fmt(balance(w), w))}" autocomplete="off"><button type="button" class="mini" data-bal="${w}">Set</button></div></label>`).join('')}
      <p class="hint">Type what you really have. The app adds a "balance adjustment" so the wallet matches.</p>
    </div>

    <div class="group-t">Wallet</div>
    <div class="group"><label class="row"><span>Pick wallet by time zone<small>In Japan → ¥, in Thailand → ฿ (now: ${esc(tz)})</small></span>
      <input type="checkbox" switch id="auto-w" ${c.autoWallet ? 'checked' : ''}></label></div>

    <div class="group-t">Auto-record & backup</div>
    <div class="group">
      <label class="field"><span>Google Apps Script URL</span><input id="s-url" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(c.syncUrl)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="field"><span>Secret word</span><input id="s-secret" value="${esc(c.secret)}" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"></label>
      <button class="primary" id="s-connect" style="width:100%">${c.syncUrl ? 'Save & sync now' : 'Connect'}</button>
      <p class="hint" id="s-status"></p>
      ${c.syncUrl ? `<div class="btns"><button class="secondary" id="s-copy">Copy Shortcut URL</button><button class="secondary" id="s-test">Send test</button></div>` : ''}
      <p class="hint"><a href="guide.html#sheet">Step-by-step setup guide →</a></p>
    </div>

    <div class="group-t">PayPay</div>
    <div class="group">
      <label class="secondary file">Import PayPay history (CSV)<input type="file" id="pp-file" accept=".csv,text/csv,text/comma-separated-values,text/plain"></label>
      <p class="hint">Download a month of history in the PayPay app, then pick the file here. Already-imported payments are skipped. <a href="guide.html#paypay">How →</a></p>
    </div>

    <div class="group-t">Categories</div>
    <div class="group">
      <label class="field"><span>Expense — one per line: emoji, space, name</span><textarea id="c-exp" rows="7">${esc((c.cats.expense || []).join('\n'))}</textarea></label>
      <label class="field"><span>Income</span><textarea id="c-inc" rows="4">${esc((c.cats.income || []).join('\n'))}</textarea></label>
      <div class="btns" style="margin-top:0"><button class="secondary" id="c-save">Save categories</button><button class="link" id="c-reset">Reset</button></div>
    </div>

    <div class="group-t">Backup</div>
    <div class="group">
      <div class="btns" style="margin-top:0"><button class="secondary" id="b-json">Export backup</button><button class="secondary" id="b-csv">Export CSV</button></div>
      <label class="secondary file">Restore a backup<input type="file" id="b-file" accept=".json,application/json"></label>
    </div>
    <p class="foot">YenBaht ${VERSION} · ${live} records · <a href="guide.html">Setup guide</a></p>`;
  refreshSyncStatus();

  $$('[data-bal]', box).forEach(b => b.onclick = () => {
    const w = b.dataset.bal;
    const inp = $('#bal-' + w, box);
    const v = parseNum(inp.value.replace('−', '-'));
    if (isNaN(v)) { shake(inp); inp.focus(); return; }
    const delta = round(v - balance(w), w);
    if (!delta) { toast(`${w} is already ${fmt(v, w)}`); return; }
    addTx(mkTx({ wallet: w, type: 'adjust', amount: delta, note: 'Balance set to ' + fmt(v, w) }));
    inp.value = '';
    inp.placeholder = fmt(balance(w), w);
    renderWallets();
    toast(`${w} balance set to ${fmt(v, w)}`);
  });
  $('#auto-w', box).onchange = e => { S.cfg.autoWallet = e.target.checked; saveCfg(); };

  $('#s-connect', box).onclick = async () => {
    const url = $('#s-url', box).value.trim();
    const secret = $('#s-secret', box).value.trim();
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) { toast('That isn’t an Apps Script web app URL'); shake('#s-url'); return; }
    if (url && !secret) { toast('Type your secret word too'); shake('#s-secret'); return; }
    if (url !== S.cfg.syncUrl) { S.cfg.lastPull = 0; S.tx.forEach(t => { t.dirty = true; }); saveTx(); }
    S.cfg.syncUrl = url;
    S.cfg.secret = secret;
    sync$.err = '';
    saveCfg();
    if (!url) { mountSettings(body); toast('Disconnected'); setDot(); return; }
    refreshSyncStatus();
    const ok = await sync(true);
    if (sheetOpen() && $('#st')) mountSettings(body);
    if (ok) toast('Connected ✓');
  };
  if ($('#s-copy', box)) $('#s-copy', box).onclick = async () => { if (await copyText(shortcutUrl())) toast('Shortcut URL copied'); };
  if ($('#s-test', box)) $('#s-test', box).onclick = async () => {
    try {
      await api('GET', null, { amount: '1', merchant: 'Test payment', card: 'Test' });
      toast('Test sent — fetching it…');
      await sync(true);
      toast('Test arrived ✓ — close Settings to see it');
    } catch (e) { toast('Test failed: ' + e.message); }
  };

  $('#pp-file', box).onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importPayPay(f); };

  $('#c-save', box).onclick = () => {
    const lines = id => $(id, box).value.split('\n').map(s => s.trim()).filter(Boolean);
    const ex = lines('#c-exp'), inc = lines('#c-inc');
    if (!ex.length || !inc.length) { toast('Keep at least one category in each list'); return; }
    S.cfg.cats = { expense: ex, income: inc };
    saveCfg();
    toast('Categories saved');
  };
  $('#c-reset', box).onclick = () => {
    if (!confirm('Put the categories back to the defaults?')) return;
    S.cfg.cats = JSON.parse(JSON.stringify(DEFAULT_CATS));
    saveCfg();
    mountSettings(body);
  };

  $('#b-json', box).onclick = () => shareFile(`yenbaht-backup-${dayKey(Date.now())}.json`,
    JSON.stringify({ app: 'yenbaht', version: 1, exported: new Date().toISOString(), cats: S.cfg.cats, tx: S.tx.map(wire) }), 'application/json');
  $('#b-csv', box).onclick = () => shareFile(`yenbaht-${dayKey(Date.now())}.csv`, toCSV(), 'text/csv');
  $('#b-file', box).onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreBackup(f); };
}

/* ---------------- sync with the Google Sheet ---------------- */
const sync$ = { busy: false, err: '', timer: 0, again: false };
function setDot() {
  $('#sync-dot').className = 'dot ' + (!S.cfg.syncUrl ? '' : sync$.busy ? 'busy' : sync$.err ? 'err' : 'ok');
}
function scheduleSync(ms) {
  if (!S.cfg.syncUrl) return;
  clearTimeout(sync$.timer);
  sync$.timer = setTimeout(() => sync(), ms == null ? 1500 : ms);
}
const wire = t => ({
  id: t.id, time: t.time, wallet: t.wallet, type: t.type, amount: t.amount, category: t.category, merchant: t.merchant,
  note: t.note, toWallet: t.toWallet, toAmount: t.toAmount, source: t.source, updated: t.updated, deleted: !!t.deleted,
});
function fromWire(r) {
  const types = ['expense', 'income', 'transfer', 'adjust'];
  return {
    id: str(r.id), time: Number(r.time) || Date.now(), wallet: r.wallet === 'THB' ? 'THB' : 'JPY',
    type: types.includes(r.type) ? r.type : 'expense', amount: Number(r.amount) || 0,
    category: str(r.category), merchant: str(r.merchant), note: str(r.note),
    toWallet: r.toWallet === 'THB' || r.toWallet === 'JPY' ? r.toWallet : '',
    toAmount: r.toAmount === '' || r.toAmount == null ? '' : Number(r.toAmount) || 0,
    source: str(r.source), updated: Number(r.updated) || 0,
    deleted: r.deleted === true || String(r.deleted).toUpperCase() === 'TRUE', dirty: false,
  };
}
async function api(method, body, params) {
  const u = new URL(S.cfg.syncUrl);
  u.searchParams.set('k', S.cfg.secret || '');
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let res;
  try {
    // A plain-text body keeps this a "simple" request, which Apps Script accepts cross-origin.
    res = await fetch(u.toString(), { method, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal, cache: 'no-store', redirect: 'follow' });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'The sheet took too long to answer'
      : !navigator.onLine ? 'Offline — will sync later'
      : 'Couldn’t reach the sheet. Check the URL, and that the deployment’s access is “Anyone”.');
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('That URL didn’t answer like the YenBaht script. It should end in /exec.'); }
  if (!j.ok) throw new Error(j.error === 'Wrong secret' ? 'Wrong secret word' : j.error || 'Script error');
  return j;
}
function merge(rows) {
  const byId = new Map(S.tx.map(t => [t.id, t]));
  let changed = false;
  for (const r of rows) {
    if (!r || !r.id) continue;
    const t = fromWire(r);
    const cur = byId.get(t.id);
    if (!cur) { S.tx.push(t); byId.set(t.id, t); changed = true; }
    else if (t.updated > cur.updated) { Object.assign(cur, t); changed = true; }
    else if (t.updated === cur.updated && cur.dirty) cur.dirty = false;
  }
  return changed;
}
async function sync(manual) {
  if (!S.cfg.syncUrl) return false;
  if (sync$.busy) { sync$.again = true; return false; }
  sync$.busy = true;
  setDot();
  refreshSyncStatus();
  try {
    const dirty = S.tx.filter(t => t.dirty);
    for (let i = 0; i < dirty.length; i += 300) {
      const chunk = dirty.slice(i, i + 300);
      await api('POST', { tx: chunk.map(wire) });
      const sent = new Map(chunk.map(t => [t.id, t.updated]));
      for (const t of S.tx) if (t.dirty && sent.get(t.id) === t.updated) t.dirty = false;
      saveTx();
    }
    const res = await api('GET', null, { since: S.cfg.lastPull || 0 });
    const changed = merge(res.rows || []);
    S.cfg.lastPull = res.now;
    S.cfg.lastSync = Date.now();
    saveCfg();
    if (changed) { autoCategorize(); saveTx(); render(); }
    sync$.err = '';
    return true;
  } catch (e) {
    sync$.err = e.message || String(e);
    if (manual) toast(sync$.err);
    return false;
  } finally {
    sync$.busy = false;
    setDot();
    refreshSyncStatus();
    if (sync$.again) { sync$.again = false; scheduleSync(300); }
  }
}

/* ---------------- PayPay CSV import ---------------- */
async function readText(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) { try { text = new TextDecoder('shift_jis').decode(buf); } catch (e) { /* keep utf-8 */ } }
  return text.replace(/^﻿/, '');
}
function parseCSV(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
function detectCols(header) {
  const H = header.map(h => h.trim());
  const find = (re, not) => H.findIndex(h => re.test(h) && !(not && not.test(h)));
  return {
    date: find(/取引日|日時|日付|date/i),
    out: find(/出金|支払.*金額|利用金額/, /海外|通貨|レート/),
    inn: find(/入金/, /海外|通貨|レート/),
    amount: find(/金額|amount/i, /海外|出金|入金|レート/),
    content: find(/取引内容|内容|種別|type/i),
    merchant: find(/取引先|店舗|加盟店|相手|merchant/i),
    id: find(/取引番号|番号|transaction id/i),
  };
}
function parseDate(s) {
  const m = String(s).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})(?:\D+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0).getTime();
}
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function classifyPP(r, c) {
  const g = i => (i >= 0 ? str(r[i]).trim() : '');
  const num = s => { const v = parseFloat(s.replace(/[^0-9.\-]/g, '')); return isNaN(v) ? 0 : v; };
  const time = parseDate(g(c.date));
  if (!time) return null;
  const content = g(c.content);
  const merchant = g(c.merchant) || content;
  let out = num(g(c.out)), inn = num(g(c.inn));
  if (c.out < 0 && c.inn < 0) {
    const a = num(g(c.amount));
    if (a < 0) out = -a;
    else if (/入金|受け取|受取|返金|もらう|チャージ/.test(content)) inn = a;
    else out = a;
  }
  let kind, why = '', cat = '';
  if (/チャージ/.test(content)) { kind = 'skip'; why = 'Top-up (your own money moving)'; }
  else if (out > 0) kind = 'expense';
  else if (inn > 0) {
    if (/ポイント|付与|獲得/.test(content)) { kind = 'skip'; why = 'Points'; }
    else { kind = 'income'; if (/返金|キャンセル|取消|取り消し/.test(content)) cat = 'Refund'; }
  } else return null;
  const amount = Math.round(out > 0 ? out : inn);
  const no = g(c.id).replace(/\s/g, '');
  const id = 'pp-' + (no || hash([time, amount, merchant, content].join('|')));
  return { id, time, amount, kind, why, merchant, content, cat };
}
async function importPayPay(file) {
  let rows;
  try { rows = parseCSV(await readText(file)); } catch (e) { toast('Couldn’t read that file'); return; }
  let col = null, hi = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const c = detectCols(rows[i]);
    if (c.date >= 0 && (c.out >= 0 || c.amount >= 0)) { col = c; hi = i; break; }
  }
  if (!col) {
    openSheet('PayPay import', `<p>This file's columns weren't recognised, so nothing was imported.</p>
      <p class="hint">First line of the file:<br><code>${esc((rows[0] || []).join(', ').slice(0, 300))}</code></p>`);
    return;
  }
  const have = new Set(S.tx.map(t => t.id));
  const items = [];
  for (const r of rows.slice(hi + 1)) {
    const it = classifyPP(r, col);
    if (!it) continue;
    it.dup = have.has(it.id);
    it.on = it.kind !== 'skip' && !it.dup;
    items.push(it);
  }
  items.sort((a, b) => a.time - b.time);
  if (!items.length) { toast('No payments found in that file'); return; }
  const fresh = items.filter(i => !i.dup).length;
  openSheet('Import from PayPay', `
    <p class="hint" style="margin-top:0">${items.length} transactions in the file${items.length - fresh ? ` · ${items.length - fresh} already imported` : ''}. Untick anything you don't want.</p>
    <div class="group" style="padding:0 12px">${items.map((it, i) => `
      <label class="pp-row ${it.dup ? 'off' : ''}"><input type="checkbox" data-i="${i}" ${it.on ? 'checked' : ''} ${it.dup ? 'disabled' : ''}>
        <span class="d">${new Date(it.time).getMonth() + 1}/${new Date(it.time).getDate()}</span>
        <span class="m">${esc(it.merchant)}<small>${it.dup ? 'already imported' : it.why || esc(it.content)}</small></span>
        <span class="a ${it.kind === 'income' ? 'inc' : ''}">${fmt(it.kind === 'expense' ? -it.amount : it.amount, 'JPY', it.kind === 'income')}</span></label>`).join('')}
    </div>
    <div class="sticky-foot"><button class="primary" id="pp-go" style="width:100%"></button></div>`, body => {
    const go = $('#pp-go', body);
    const count = () => { const n = items.filter(i => i.on).length; go.textContent = n ? `Import ${n}` : 'Nothing selected'; go.disabled = !n; };
    body.addEventListener('change', e => { const i = e.target.dataset.i; if (i != null) { items[i].on = e.target.checked; count(); } });
    count();
    go.onclick = () => {
      const idx = merchantIndex();
      let n = 0;
      for (const it of items) {
        if (!it.on) continue;
        const type = it.kind === 'income' ? 'income' : 'expense';
        const t = mkTx({ id: it.id, time: it.time, wallet: 'JPY', type, amount: it.amount, merchant: it.merchant,
          note: it.content && it.content !== it.merchant ? it.content : '', source: 'paypay' });
        t.category = catExists(it.cat, type) ? it.cat : guessCategory(t, idx);
        S.tx.push(t);
        n++;
      }
      saveTx();
      scheduleSync();
      closeSheet();
      const left = reviewList().length;
      toast(`Imported ${n} from PayPay${left ? ` · ${left} to sort` : ''}`);
    };
  });
}

/* ---------------- backup ---------------- */
async function shareFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function toCSV() {
  const q = v => { const s = str(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['date', 'time', 'wallet', 'type', 'amount', 'category', 'merchant', 'note', 'to_wallet', 'to_amount', 'source'];
  const rows = S.tx.filter(t => !t.deleted).sort((a, b) => a.time - b.time).map(t =>
    [dayKey(t.time), fmtTime(t.time), t.wallet, t.type, t.amount, t.category, t.merchant, t.note, t.toWallet, t.toAmount, t.source].map(q).join(','));
  return '﻿' + [head.join(','), ...rows].join('\n');
}
async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('That isn’t a backup file'); return; }
  if (!data || !Array.isArray(data.tx)) { toast('That isn’t a YenBaht backup'); return; }
  if (!confirm(`Restore ${data.tx.length} records from this backup? Records already here stay; the newer version of each wins.`)) return;
  const byId = new Map(S.tx.map(t => [t.id, t]));
  let n = 0;
  for (const r of data.tx) {
    const t = fromWire(r);
    if (!t.id) continue;
    const cur = byId.get(t.id);
    if (!cur) { t.dirty = true; S.tx.push(t); n++; }
    else if (t.updated > cur.updated) { Object.assign(cur, t, { dirty: true }); n++; }
  }
  if (data.cats && Array.isArray(data.cats.expense) && Array.isArray(data.cats.income)) S.cfg.cats = data.cats;
  saveTx();
  saveCfg();
  scheduleSync();
  closeSheet();
  toast(`Restored ${n} records`);
}

/* ---------------- events ---------------- */
function bind() {
  $('#wallets').onclick = e => { const b = e.target.closest('.wallet'); if (b) setWallet(b.dataset.w); };
  $('#btn-settings').onclick = openSettings;
  $('#tabs').onclick = e => { const b = e.target.closest('button'); if (b) showView(b.dataset.view); };
  $('#inbox').onclick = openReview;
  $('#install-x').onclick = () => { S.cfg.hideInstall = true; saveCfg(); $('#install').hidden = true; };

  $('#type-seg').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    ui.type = b.dataset.type;
    ui.side = 'from';
    if (ui.wallet === 'JPY') ui.buf = ui.buf.split('.')[0];
    renderAdd();
  };
  $('#cats').onclick = e => { const b = e.target.closest('.cat'); if (b) quickSave(b.dataset.cat); };
  $('#xfer').onclick = e => {
    const s = e.target.closest('[data-side]');
    if (s) { ui.side = s.dataset.side; renderXfer(); renderKeypad(); return; }
    if (e.target.closest('#xf-save')) saveTransfer();
  };

  let lpTimer = 0, suppress = false;
  $('#keypad').addEventListener('click', e => {
    const b = e.target.closest('.key');
    if (!b) return;
    if (suppress) { suppress = false; return; }
    press(b.dataset.k);
  });
  const del = $('#k-del');
  del.addEventListener('pointerdown', () => {
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      suppress = true;
      if (ui.type === 'transfer' && ui.side === 'to') ui.buf2 = ''; else ui.buf = '';
      if (ui.type === 'transfer') renderXfer(); else renderAmount();
    }, 450);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => del.addEventListener(ev, () => clearTimeout(lpTimer)));
  del.addEventListener('contextmenu', e => e.preventDefault());

  $('#note').addEventListener('input', e => { ui.note = e.target.value; });
  $('#note').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  $('#date-input').addEventListener('change', e => {
    const v = e.target.value;
    ui.date = v && v !== dayKey(Date.now()) ? v : null;
    renderMeta();
  });

  $('#view-history').onclick = e => {
    const m = e.target.closest('[data-m]');
    if (m) { ui.hist.month = shiftMonth(ui.hist.month, +m.dataset.m); renderHistory(); return; }
    const w = e.target.closest('[data-hw]');
    if (w) { ui.hist.wallet = w.dataset.hw; renderHistory(); return; }
    const it = e.target.closest('[data-id]');
    if (it) { const t = S.tx.find(x => x.id === it.dataset.id); if (t) openEdit(t); }
  };
  $('#view-stats').onclick = e => {
    const m = e.target.closest('[data-m]');
    if (m) { ui.statsMonth = shiftMonth(ui.statsMonth, +m.dataset.m); renderStats(); }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { ui.hiddenAt = Date.now(); return; }
    if (ui.hiddenAt && Date.now() - ui.hiddenAt > FRESH_AFTER && !sheetOpen()) {
      // Treat a reopen like a fresh launch: clean keypad, today's date, wallet from time zone.
      resetEntry();
      ui.date = null;
      if (S.cfg.autoWallet) { const w = tzWallet(); if (w) ui.wallet = w; }
      ui.hist.month = ui.statsMonth = monthKey(Date.now());
      showView('add');
    } else render();
    sync();
  });
  window.addEventListener('online', () => sync());
}

function init() {
  bind();
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  $('#install').hidden = !(isIOS && !standalone && !S.cfg.hideInstall);
  autoCategorize();
  render();
  sync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
init();
