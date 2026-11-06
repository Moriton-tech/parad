// parad.mn — нийтлэг туслах функцууд
import { CONFIG } from './config.js?v=2611061230';
import qrcode from './vendor/qrcode.mjs';

export const configured = !/YOUR-PROJECT|YOUR-PUBLISHABLE/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_KEY);
const BASE = String(CONFIG.SUPABASE_URL || '').replace(/\/+$/, '');
export const FN_URL = CONFIG.FUNCTION_URL || BASE + '/functions/v1/parade';

const READ_ONLY = new Set(['info', 'horses', 'horse', 'ticket', 'deposit_status', 'stud_status', 'status']);
export async function api(action, body = {}, token) {
  if (!configured) throw new Error('Сайтын тохиргоо (js/config.js) хийгдээгүй байна.');
  const send = () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);                 // гацахаас сэргийлж 20 сек хүлээгээд таслана
    return fetch(FN_URL, {
      method: 'POST', signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_KEY,
        // админ бол хэрэглэгчийн токен; эс бөгөөс хуучин anon (JWT) түлхүүр байвал түүнийг дамжуулна
        ...(token ? { Authorization: 'Bearer ' + token } : String(CONFIG.SUPABASE_KEY).split('.').length === 3 ? { Authorization: 'Bearer ' + CONFIG.SUPABASE_KEY } : {}),
      },
      body: JSON.stringify({ action, ...body }),
    }).finally(() => clearTimeout(timer));
  };
  let r;
  try {
    try { r = await send(); }
    catch (e) { if (!READ_ONLY.has(action)) throw e; await new Promise(ok => setTimeout(ok, 800)); r = await send(); }   // уншдаг хүсэлтийг нэг удаа дахин оролдоно
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'Сервер удаан хариу өгөөгүй. Дахин оролдоно уу.' : 'Сервертэй холбогдож чадсангүй. Интернэтээ шалгаад дахин оролдоно уу.');
  }
  let j = {};
  try { j = await r.json(); } catch { /* хоосон */ }
  if (!r.ok) { const e = new Error(j.error || `Алдаа (${r.status})`); e.status = r.status; throw e; }
  return j;
}

// ---- Хурдан ачаалалт: өмнөх хариу (localStorage) эсвэл статик snapshot-оор шууд зурж, дараа нь серверээс шинэчилнэ.
// onData(data, stale) хоёр удаа дуудагдаж болно: эхлээд кэшээр (stale=true), дараа нь шинэ датаар (stale=false).
const SNAPSHOT = { horses: 'data/horses.json' };
const ckey = (action, body) => 'parad_c:' + action + ':' + JSON.stringify(body || {});
export async function apiCached(action, body, onData) {
  const key = ckey(action, body);
  let shown = false;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch { /* хувийн цонх */ }
  const fresh = api(action, body);
  if (!cached && SNAPSHOT[action]) {
    // Анхны зочин: CDN дээрх статик хуулбар нь API-аас хамаагүй хурдан ирнэ
    cached = await Promise.race([
      fetch(SNAPSHOT[action], { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null),
      fresh.then(() => null, () => null),
    ]);
  }
  if (cached && cached.d) { shown = true; try { onData(cached.d, true); } catch (e) { console.error(e); } }
  try {
    const d = await fresh;
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch { /* дүүрсэн */ }
    onData(d, false);
    return d;
  } catch (e) {
    if (shown) { console.warn(e); return cached.d; }
    throw e;
  }
}

// ---- Supabase нэвтрэлт (админ) — номын сангүйгээр
export const auth = {
  key: 'parad_admin_session',
  get() { try { return JSON.parse(localStorage.getItem(this.key) || 'null'); } catch { return this._mem || null; } },
  set(s) { this._mem = s; try { s ? localStorage.setItem(this.key, JSON.stringify(s)) : localStorage.removeItem(this.key); } catch { /* хувийн цонх */ } },
  async call(grant, body) {
    const r = await fetch(`${BASE}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_KEY }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(/invalid/i.test(j.error_description || j.msg || '') ? 'Имэйл эсвэл нууц үг буруу байна.' : (j.error_description || j.msg || 'Нэвтэрч чадсангүй'));
    const s = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: (j.expires_at || (Date.now() / 1000 + (j.expires_in || 3600))), email: j.user?.email };
    this.set(s);
    return s;
  },
  login(email, password) { return this.call('password', { email, password }); },
  async token() {
    const s = this.get();
    if (!s) return null;
    if (s.expires_at * 1000 - Date.now() > 60_000) return s.access_token;
    try { return (await this.call('refresh_token', { refresh_token: s.refresh_token })).access_token; }
    catch { this.set(null); return null; }
  },
  logout() { this.set(null); },
};

// ---- форматлах
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = n => Number(n || 0).toLocaleString('en-US') + '₮';
const p2 = n => String(n).padStart(2, '0');
export const WD = ['Ням', 'Даваа', 'Мягмар', 'Лхагва', 'Пүрэв', 'Баасан', 'Бямба'];
// Улаанбаатарын цагаар (UTC+8)
const ub = v => { const d = new Date(v); return new Date(d.getTime() + 8 * 3600_000); };
export const fmtDT = v => { if (!v) return ''; const d = ub(v); return `${d.getUTCFullYear()}.${p2(d.getUTCMonth() + 1)}.${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
export const fmtTime = v => { if (!v) return ''; const d = ub(v); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
export const fmtDay = v => { const d = ub(v); return `${d.getUTCFullYear()}.${p2(d.getUTCMonth() + 1)}.${p2(d.getUTCDate())}`; };
export const fmtWeekday = v => WD[ub(v).getUTCDay()] + ' гараг';
export const param = k => new URLSearchParams(location.search).get(k);
export const siteBase = () => location.origin + location.pathname.replace(/[^/]*$/, '');
export const ticketLink = token => siteBase() + 'ticket.html?t=' + token;

// ---- QR (SVG)
export function qrSvg(text, { margin = 2, ecl = 'M', dark = '#050f3d' } = {}) {
  const qr = qrcode(0, ecl);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), size = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR код"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="${dark}"/></svg>`;
}

// ---- тоолуур
export function startCountdown(el, targetIso, serverNow, { compact = false, onLive } = {}) {
  const offset = serverNow ? new Date(serverNow).getTime() - Date.now() : 0;
  const target = new Date(targetIso).getTime();
  const box = (v, l) => `<div class="cd-box"><b>${v}</b><small>${l}</small></div>`;
  let timer;
  const tick = () => {
    const ms = target - (Date.now() + offset);
    if (ms <= 0) {
      el.innerHTML = `<div class="cd-live">Парад эхэллээ!</div>`;
      clearInterval(timer); onLive && onLive();
      return;
    }
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    el.innerHTML = (compact ? '' : '<div class="label">Парад эхлэхэд</div>') +
      box(d, 'өдөр') + box(p2(h), 'цаг') + box(p2(m), 'минут') + box(p2(sec), 'секунд');
  };
  tick();
  timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

// ---- жижиг туслахууд
export function toast(msg, ms = 2600) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}
export const store = {
  get(k, d = null) { try { return JSON.parse(localStorage.getItem('parade_' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('parade_' + k, JSON.stringify(v)); } catch { /* */ } },
};
export function rememberOrder(code, key) {
  const list = store.get('orders', []).filter(o => o.code !== code);
  list.unshift({ code, key, at: Date.now() });
  store.set('orders', list.slice(0, 10));
}

export const ICONS = {
  cal: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  pin: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  phone: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
  clock: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  check: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9a3 3 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a3 3 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z"/><path d="M14 5v2M14 11v2M14 17v2"/></svg>',
  gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/></svg>',
  gavel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m14 13-8.4 8.4a1.5 1.5 0 0 1-2.1-2.1L12 11"/><path d="m16 16 6-6"/><path d="m8 8 6-6"/><path d="m9 7 8 8"/><path d="m21 11-8-8"/></svg>',
  food: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/></svg>',
  drink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14l-1.6 16.2A2 2 0 0 1 15.4 21H8.6a2 2 0 0 1-2-1.8z"/><path d="M5.5 8h13"/></svg>',
  okBig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

// ---- адуу, гүү тавих, зарах: нийтлэг туслахууд
export const mnt = n => (n == null || n === '' ? 'Тохиролцоно' : money(n));
export const million = n => { const v = Number(n) / 1e6; return (Number.isInteger(v) ? v : v.toFixed(2).replace(/\.?0+$/, '')) + ' сая ₮'; };
// Ангилал: Цэвэр азарга / Монгол азарга (админд санал болгох жагсаалт)
export const BREEDS = {
  'Цэвэр азарга': ['Цэвэр Англи', 'Цэвэр Араб', 'Англи-Араб', 'Ахалтеке'],
  'Монгол азарга': ['Монгол цэвэр', 'Монгол эрлийз', 'Монгол – Галшар', 'Монгол – Дархад', 'Монгол – Тэс'],
};
export const breedGroup = b => (!b ? '' : /монгол/i.test(b) ? 'Монгол азарга' : 'Цэвэр азарга');
// Төрөл — насаар нь (жагсаалтын дараалал админд ингэж харагдана)
export const KIND = {
  foal: 'Унага', yearling: 'Даага', shudlen: 'Шүдлэн', hyazaalan: 'Хязаалан', soyolon: 'Соёолон',
  colt: 'Үрээ', stallion: 'Азарга', gelding: 'Морь', filly: 'Байдас', mare: 'Гүү',
};
export const photoOf = (h, i = 0, thumb = false) => { const p = (h.photos || [])[i]; return p ? (thumb ? p.t || p.u : p.u) : null; };
// Үржүүлгийн үнэ (хямдралтай бол хуучин үнийг зураастай)
export const discPct = (fee, price) => Math.round((1 - Number(price) / Number(fee)) * 100);
export function studPriceHtml(h) {
  if (h.stud_fee == null) return 'Private';
  if (h.stud_price != null && h.stud_price < h.stud_fee) return `<s class="old-price">${million(h.stud_fee)}</s> <span class="new-price">${million(h.stud_price)}</span> <span class="disc-tag">-${discPct(h.stud_fee, h.stud_price)}%</span>`;
  return million(h.stud_fee);
}
export const studState = h => {
  const left = Math.max(0, (h.stud_capacity || 0) - (h.confirmed_mares || 0));
  const st = !h.stud_enabled ? 'off' : !h.stud_active ? 'closed' : left <= 0 ? 'full' : 'open';
  return { left, st, cap: h.stud_capacity || 0 };
};
export function auctionState(h, nowMs = Date.now()) {
  if (h.sale_mode !== 'auction') return 'none';
  if (h.auction_closed || h.sale_status !== 'available') return 'closed';
  if (h.auction_starts_at && new Date(h.auction_starts_at).getTime() > nowMs) return 'scheduled';
  if (!h.auction_ends_at || new Date(h.auction_ends_at).getTime() <= nowMs) return 'ended';
  return 'open';
}
export const slugify = t => {
  const m = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', ө: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ү: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return String(t || '').toLowerCase().split('').map(c => m[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
};
// Энэ төхөөрөмж дээр хадгалсан гүү тавих захиалгын кодууд
export function rememberStud(code) {
  const list = store.get('stud', []).filter(c => c !== code);
  list.unshift(code); store.set('stud', list.slice(0, 15));
}

export function renderChrome(info, active = '') {
  const h = document.getElementById('site-header');
  const ev = info && info.event_public;
  if (h) h.innerHTML = `<div class="container">
    <a class="brand" href="index.html"><img src="img/parad-wordmark.png" alt="Parad.mn"></a>
    <nav class="nav">
      <a href="stallions.html"${active === 'horses' && !/[?&]f=sale/.test(location.search) ? ' class="on"' : ''}>Азарга</a>
      <a href="stallions.html?f=sale"${active === 'horses' && /[?&]f=sale/.test(location.search) ? ' class="on"' : ''}>Худалдах адуу</a>
      <a href="booking.html" class="hide-sm${active === 'booking' ? ' on' : ''}">Захиалга шалгах</a>
      ${store.get('pass') ? `<a href="ticket.html?t=${encodeURIComponent(store.get('pass'))}" class="cta">Миний пасс</a>` : ev && info.sales_open ? '<a href="register.html#register" class="cta">Бүртгүүлэх</a>' : '<a href="register.html" class="cta">Парад</a>'}
    </nav></div>`;
  const f = document.getElementById('site-footer');
  const phone = (info && (info.phone || info.contact_phone)) || '';
  if (f) f.innerHTML = `<div class="container">
    <div><img class="foot-logo" src="img/parad-logo-onnavy.png" alt="Parad.mn — Үе дамжсан шилмэл удам"><br>Монгол гадаад азарганд үржүүлгийн гүүний бүртгэл<br>${phone ? `Утас: <a href="tel:${esc(String(phone).replace(/\D/g, ''))}">${esc(phone)}</a>` : ''}</div>
    <div><a href="register.html">Парад · Бүртгэл</a> · <a href="stallions.html">Азарга</a> · <a href="booking.html">Захиалга шалгах</a></div></div>`;
  if (!configured && !document.querySelector('.cfg-warn')) document.body.insertAdjacentHTML('afterbegin', '<div class="cfg-warn"><b>Тохиргоо дутуу:</b> js/config.js файлд Supabase-ийн URL, түлхүүрийг оруулна уу (README-г үзнэ үү).</div>');
}

// ---------- Мөнгөн дүнгийн талбар: бичих үед мянгатын таслал (1,000,000). <input data-money> гэж тэмдэглэнэ.
const groupDigits = v => String(v ?? '').replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export const moneyVal = v => { const d = String(v ?? '').replace(/[^\d]/g, ''); return d === '' ? null : Number(d); };
export function formatMoneyInputs(root = document) {
  root.querySelectorAll?.('input[data-money]').forEach(el => { if (el !== document.activeElement) el.value = groupDigits(el.value); });
}
if (typeof document !== 'undefined') {
  document.addEventListener('input', e => {
    const el = e.target; if (!el.matches || !el.matches('input[data-money]')) return;
    const pos = el.selectionStart ?? el.value.length, digitsBefore = el.value.slice(0, pos).replace(/[^\d]/g, '').length;
    const out = groupDigits(el.value); el.value = out;
    let i = 0, seen = 0; while (i < out.length && seen < digitsBefore) { if (/\d/.test(out[i])) seen++; i++; }
    try { el.setSelectionRange(i, i); } catch { /* зарим төрөлд дэмжихгүй */ }
  }, true);
  // илгээхийн өмнө таслалыг арилгана — бусад код Number(value)-гаар уншдаг
  document.addEventListener('submit', e => {
    const f = e.target; f.querySelectorAll?.('input[data-money]').forEach(el => { el.value = el.value.replace(/[^\d]/g, ''); });
    setTimeout(() => formatMoneyInputs(f), 0);
  }, true);
  document.addEventListener('focusout', e => { if (e.target.matches?.('input[data-money]')) e.target.value = groupDigits(e.target.value); }, true);
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) formatMoneyInputs(n.matches?.('input[data-money]') ? n.parentNode : n); })
    .observe(document.documentElement, { childList: true, subtree: true });
  formatMoneyInputs();
}
