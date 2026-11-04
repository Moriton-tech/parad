// =====================================================================
//  parad.mn — API (Supabase Edge Function: "parade"): тасалбар · адуу · гүү тавих · зарах
//  Нэг файл. Supabase → Edge Functions → Deploy a new function → Via Editor
//  → нэр: parade → энэ файлыг бүтнээр нь тавина → Deploy.
//  ДАРАА НЬ: функцийн тохиргоонд "Verify JWT" (Enforce JWT verification)-ийг УНТРААНА.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6';
import qrcode from 'npm:qrcode-generator@2.0.4';

// ---------------------------------------------------------------- тохиргоо
const env = (k: string, d = '') => (Deno.env.get(k) ?? d).trim();

function serviceKey(): string {
  try {
    const j = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}');
    const k = j.default || Object.values(j)[0];
    if (k) return String(k);
  } catch { /* хуучин түлхүүр рүү шилжинэ */ }
  return env('SUPABASE_SERVICE_ROLE_KEY');
}

const SUPABASE_URL = env('SUPABASE_URL');
const db = createClient(SUPABASE_URL, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });

const QPAY_MODE = env('QPAY_MODE', 'production').toLowerCase();               // production | sandbox
const SANDBOX = QPAY_MODE === 'sandbox';
const QPAY_BASE = env('QPAY_BASE_URL', SANDBOX ? 'https://merchant-sandbox.qpay.mn/v2' : 'https://merchant.qpay.mn/v2').replace(/\/+$/, '');
const QPAY_ID = env('QPAY_CLIENT_ID', SANDBOX ? 'TEST_MERCHANT' : '');
const QPAY_SECRET = env('QPAY_CLIENT_SECRET', SANDBOX ? '123456' : '');
const QPAY_INVOICE_CODE = env('QPAY_INVOICE_CODE', SANDBOX ? 'TEST_INVOICE' : '');
const QPAY_ON = !!(QPAY_ID && QPAY_SECRET && QPAY_INVOICE_CODE);

const FUNC_URL = env('PUBLIC_FUNCTION_URL', `${SUPABASE_URL}/functions/v1/parade`);

const SMTP_USER = env('SMTP_USER');
const SMTP_PASS = env('SMTP_PASS').replace(/\s+/g, '');                        // Gmail app password-ийн хоосон зайг авна
const SMTP_HOST = env('SMTP_HOST', 'smtp.gmail.com');
const SMTP_PORT = Number(env('SMTP_PORT', '465'));
const RESEND_KEY = env('RESEND_API_KEY');
const RESEND_URL = env('RESEND_API_URL', 'https://api.resend.com').replace(/\/+$/, '');
const MAIL_FROM = env('MAIL_FROM', SMTP_USER ? `Parad.mn <${SMTP_USER}>` : 'Parad.mn <onboarding@resend.dev>');
const MAIL_ON = !!(RESEND_KEY || (SMTP_USER && SMTP_PASS));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ---------------------------------------------------------------- туслахууд
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

export const AIMAGS = ['Улаанбаатар', 'Архангай', 'Баян-Өлгий', 'Баянхонгор', 'Булган', 'Говь-Алтай', 'Говьсүмбэр', 'Дархан-Уул',
  'Дорноговь', 'Дорнод', 'Дундговь', 'Завхан', 'Орхон', 'Өвөрхангай', 'Өмнөговь', 'Сүхбаатар', 'Сэлэнгэ', 'Төв', 'Увс', 'Ховд', 'Хөвсгөл', 'Хэнтий', 'Гадаад'];
export const TITLES = ['Сонирхогч', 'Залуу уяач', 'СУА', 'ААУ', 'НАУ', 'МУАУ', 'МУМУ', 'МУТМУ'];

const DB_ERRORS: Record<string, string> = {
  SALES_CLOSED: 'Онлайн борлуулалт түр хаагдсан байна.',
  SALES_ENDED: 'Онлайн борлуулалт дууссан байна.',
  BAD_QTY: 'Тасалбарын тоо буруу байна.',
  BAD_INPUT: 'Нэр, утасны дугаараа бөглөнө үү.',
  TOO_MANY: 'Танд төлөгдөөгүй захиалга байна. Түүнийгээ төлөх эсвэл 20 минут хүлээгээд дахин оролдоно уу.',
  NO_CONSENT: 'Мэдээлэл цуглуулах зөвшөөрлийг заавал сонгоно уу.',
  DEPOSIT_REQUIRED: 'Дуудлагад оролцохын тулд парад дээр бүртгүүлсэн байх бөгөөд оролцооны хураамжаа төлсөн байх ёстой. Бүртгэлийн пасс хуудсаараа төлнө үү.',
  NOT_FOUND: 'Захиалга олдсонгүй.',
  NO_NUMBERS: 'Тасалбарын дугаар хүрэлцэхгүй байна.',
  NO_CANDIDATES: 'Сугалаанд оролцох тасалбар алга (өмнө нь бүгд хожсон эсвэл хэн ч ирээгүй).',
  NOT_PAID: 'Төлөгдөөгүй захиалгыг сэргээх боломжгүй.',
  IS_REFUND: 'Буцаалтын төлөвтэй захиалгыг сэргээх боломжгүй.',
  NOTHING_TO_RESTORE: 'Сэргээх цуцлагдсан тасалбар алга.',
};
function dbError(e: { message?: string }): HttpError {
  const pm = dbError2(e);
  if (pm) return pm;
  const m = String(e?.message || e);
  const [code, arg] = m.split(':');
  if (code === 'SOLD_OUT') {
    const n = Number(arg) || 0;
    return new HttpError(409, n > 0 ? `Зөвхөн ${n} тасалбар үлдсэн байна.` : 'Уучлаарай, тасалбар дууслаа.');
  }
  if (code === 'UNDERPAID') return new HttpError(409, `Төлсөн дүн хүрэлцэхгүй байна (${arg}₮).`);
  if (DB_ERRORS[code]) return new HttpError(code === 'NOT_FOUND' ? 404 : 409, DB_ERRORS[code]);
  console.error('DB error:', m);
  return new HttpError(500, 'Өгөгдлийн сангийн алдаа: ' + m);
}

async function rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw dbError(error);
  return data as T;
}
// deno-lint-ignore no-explicit-any
async function q(p: PromiseLike<{ data: any; error: any }>): Promise<any> {
  const { data, error } = await p;
  if (error) throw dbError(error);
  return data;
}

const money = (n: number) => Number(n || 0).toLocaleString('en-US').replace(/,/g, ',') + '₮';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const WD = ['Ням', 'Даваа', 'Мягмар', 'Лхагва', 'Пүрэв', 'Баасан', 'Бямба'];
function fmtEvent(iso: string) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);                    // Улаанбаатар UTC+8
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} (${WD[d.getUTCDay()]} гараг) ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function safeEq(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const clientIp = (req: Request) =>
  (req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || '').split(',')[0].trim() || null;

function siteBase(settings: any): string {
  let u = String(settings?.site_url || env('SITE_URL') || '').trim();
  if (u && !u.endsWith('/')) u += '/';
  return u;
}
const ticketUrl = (base: string, token: string) => (base ? `${base}ticket.html?t=${token}` : token);

function qrGif(text: string, cell = 6) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cell, 3).replace(/^data:image\/gif;base64,/, '');
}

async function getSettings() {
  return await q(db.from('parade_settings').select('*').eq('id', 1).single());
}

// ---------------------------------------------------------------- QPay
let qpTok: { token: string; exp: number } | null = null;
async function qpayToken(force = false): Promise<string> {
  if (!force && qpTok && qpTok.exp > Date.now() + 60_000) return qpTok.token;
  const r = await fetch(`${QPAY_BASE}/auth/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${QPAY_ID}:${QPAY_SECRET}`) },
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`QPay нэвтрэлт амжилтгүй (${r.status}): ${j.message || j.error || ''}`);
  let exp = Number(j.expires_in) || 0;
  exp = exp > 1e12 ? exp : exp > 1e9 ? exp * 1000 : Date.now() + (exp || 600) * 1000;
  qpTok = { token: j.access_token, exp: Math.min(exp, Date.now() + 50 * 60_000) };
  return qpTok.token;
}
async function qpay(path: string, method = 'GET', body?: unknown): Promise<any> {
  const go = async (tok: string) => fetch(QPAY_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let r = await go(await qpayToken());
  if (r.status === 401) r = await go(await qpayToken(true));
  const txt = await r.text();
  let j: any;
  try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt }; }
  if (!r.ok) throw new Error(`QPay ${r.status}: ${j.message || j.error || txt.slice(0, 200)}`);
  return j;
}
async function qpayCreateInvoice(o: any, s: any) {
  const j = await qpay('/invoice', 'POST', {
    invoice_code: QPAY_INVOICE_CODE,
    sender_invoice_no: o.code,
    invoice_receiver_code: o.phone || 'terminal',
    invoice_description: `${s.event_name} тасалбар x${o.qty} (${o.code})`,
    amount: o.amount,
    callback_url: `${FUNC_URL}?action=callback&code=${encodeURIComponent(o.code)}`,
  });
  if (!j.invoice_id) throw new Error('QPay нэхэмжлэх үүсээгүй: ' + JSON.stringify(j).slice(0, 200));
  return {
    invoice_id: String(j.invoice_id),
    invoice_qr_text: j.qr_text || null,
    invoice_qr_image: j.qr_image || null,
    invoice_short_url: j.qPay_shortUrl || j.qpay_short_url || j.qPay_shortURL || null,
    invoice_urls: Array.isArray(j.urls) ? j.urls.map((u: any) => ({ name: u.name, description: u.description, logo: u.logo, link: u.link })) : [],
  };
}
async function qpayCheck(invoiceId: string): Promise<{ paid: boolean; amount: number; paymentId: string | null }> {
  const j = await qpay('/payment/check', 'POST', { object_type: 'INVOICE', object_id: invoiceId, offset: { page_number: 1, page_limit: 100 } });
  const rows: any[] = Array.isArray(j.rows) ? j.rows : [];
  const paidRows = rows.filter(r => String(r.payment_status || '').toUpperCase() === 'PAID');
  const sum = paidRows.reduce((a, r) => a + Number(r.payment_amount || 0), 0) || (paidRows.length ? Number(j.paid_amount || 0) : 0);
  return { paid: paidRows.length > 0, amount: sum, paymentId: paidRows[0] ? String(paidRows[0].payment_id) : null };
}

// Захиалгын төлбөрийг QPay-ээс шалгаад төлөгдсөн бол тасалбар олгоно
async function syncOrder(o: any, actor = 'system'): Promise<any> {
  if (!o || !QPAY_ON || !o.invoice_id || o.pay_method !== 'qpay') return o;
  if (!['pending', 'expired', 'cancelled'].includes(o.status)) return o;
  if (Date.now() - new Date(o.created_at).getTime() > 3 * 24 * 3600_000) return o;   // 3 хоногоос хуучныг шалгахгүй
  let chk;
  try { chk = await qpayCheck(o.invoice_id); } catch (e) { console.error('QPay check', o.code, e); return o; }
  if (!chk.paid) return o;
  const r = await rpc('parade_finalize_order', {
    p_order_id: o.id, p_payment_id: chk.paymentId, p_paid_amount: Math.round(chk.amount) || null, p_method: 'qpay', p_actor: actor,
  });
  if (r.ok && !r.already) background(sendOrderEmails(o.id));
  if (!r.ok && r.reason) background(notifyProblem(r.order, r.reason));
  return r.order;
}

// ---------------------------------------------------------------- имэйл
let smtp: any = null;
function mailErr(e: unknown): Error {
  const m = String((e as Error)?.message || e);
  if (/535|Invalid login|Username and Password not accepted|BadCredentials/i.test(m))
    return new Error('Имэйлийн нэвтрэлт амжилтгүй — SMTP_USER болон Gmail App password-оо шалгана уу. (' + m.slice(0, 120) + ')');
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|timeout|Greeting never received/i.test(m))
    return new Error('Имэйлийн сервертэй холбогдож чадсангүй (' + m.slice(0, 120) + ')');
  return e instanceof Error ? e : new Error(m);
}
async function sendMail(m: Parameters<typeof sendMailRaw>[0]) {
  try { await sendMailRaw(m); } catch (e) { throw mailErr(e); }
}
async function sendMailRaw(m: { to: string[]; subject: string; html: string; text: string; attachments?: { filename: string; content: string; cid: string }[] }) {
  const to = m.to.map(s => s.trim()).filter(Boolean);
  if (!to.length) return;
  if (RESEND_KEY) {
    const r = await fetch(`${RESEND_URL}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM, to, subject: m.subject, html: m.html, text: m.text,
        attachments: (m.attachments || []).map(a => ({ filename: a.filename, content: a.content, content_id: a.cid, content_type: 'image/gif' })),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  if (SMTP_USER && SMTP_PASS) {
    smtp ??= nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000,
    });
    await smtp.sendMail({
      from: MAIL_FROM, to: to.join(', '), subject: m.subject, html: m.html, text: m.text,
      attachments: (m.attachments || []).map(a => ({ filename: a.filename, content: a.content, encoding: 'base64', cid: a.cid, contentType: 'image/gif' })),
    });
    return;
  }
  throw new Error('Имэйл тохиргоо хийгдээгүй (SMTP_USER/SMTP_PASS эсвэл RESEND_API_KEY)');
}

const NAVY = '#0c2179', NAVY_D = '#081a5c', GOLD = '#ff6f5e', ACCENT = '#9e231b', CREAM = '#f3f5fb';

function ticketEmail(o: any, tickets: any[], s: any) {
  const base = siteBase(s);
  const att = tickets.map(t => ({ filename: `tasalbar-${t.number}.gif`, content: qrGif(ticketUrl(base, t.token), 6), cid: `qr${t.number}@parade` }));
  const nums = tickets.map(t => '№' + t.number).join(', ');
  const cards = tickets.map(t => `
    <tr><td style="padding:0 0 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${NAVY};border-radius:14px;overflow:hidden">
        <tr>
          <td style="padding:18px 20px;color:#fff;font-family:Arial,sans-serif;vertical-align:middle">
            <div style="font-size:11px;letter-spacing:2px;color:${GOLD};font-weight:bold">ПАРАДЫН ПАСС</div>
            <div style="font-size:30px;font-weight:bold;color:${GOLD};letter-spacing:2px;margin:4px 0">№${t.number}</div>
            <div style="font-size:13px;opacity:.9">${esc(o.name)}</div>
            <div style="font-size:12px;opacity:.75;margin-top:8px">Сугалаа · Дуудлага худалдаа</div>
            ${base ? `<a href="${ticketUrl(base, t.token)}" style="display:inline-block;margin-top:12px;background:${ACCENT};color:#fff;text-decoration:none;font-weight:bold;font-size:13px;padding:8px 14px;border-radius:8px">Пасс нээх →</a>` : ''}
          </td>
          <td width="170" style="padding:14px;background:#fff;text-align:center;vertical-align:middle">
            <img src="cid:qr${t.number}@parade" width="150" height="150" alt="QR ${t.number}" style="display:block;margin:0 auto">
            <div style="font-family:Arial,sans-serif;font-size:10px;color:#666;margin-top:4px">Үүдэнд уншуулна</div>
          </td>
        </tr>
      </table>
    </td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:${CREAM};padding:20px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:16px;overflow:hidden;font-family:Arial,sans-serif;color:#1b211f">
    <tr><td style="background:${NAVY_D};padding:22px 24px;border-bottom:3px solid ${ACCENT}">
      <div style="color:${GOLD};font-size:20px;font-weight:bold;letter-spacing:1px">PARAD.MN</div>
      <div style="color:#e9e4d4;font-size:12px">Үе дамжсан шилмэл удам</div>
    </td></tr>
    <tr><td style="padding:24px">
      <h1 style="margin:0 0 6px;font-size:22px;color:${NAVY}">${esc(s.event_name)} — таны бүртгэлийн пасс</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#555">Сайн байна уу, ${esc(o.name)}! Таны бүртгэл амжилттай боллоо. Үүдэн дээр доорх QR кодыг уншуулж орно. Пасс бүр нэг хүнд.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};border-radius:10px;margin-bottom:18px;font-size:14px">
        <tr><td style="padding:12px 14px">
          <b>Огноо:</b> ${esc(fmtEvent(s.event_at))}<br>
          <b>Байршил:</b> ${esc(s.location)}<br>
          <b>Бүртгэл:</b> ${esc(o.code)}<br>
          <b>Сугалааны дугаар:</b> ${nums}
        </td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}</table>
      <p style="font-size:13px;color:#555;margin:6px 0 0"><b>Сугалаа:</b> парадад ирсэн бүртгэлтэй оролцогчдын дунд эрхийн бичгийн сугалаа явуулна. Пасс дээрх дугаар нь таны сугалааны дугаар. <b>Дуудлага худалдаа:</b> оролцохын тулд оролцооны хураамж төлсөн байх ёстой — пасс хуудсаар төлнө.</p>
      <p style="font-size:13px;color:#555">Асуух зүйл байвал: <b>${esc(s.phone)}</b></p>
    </td></tr>
    <tr><td style="background:${NAVY_D};color:#cfd6ee;font-size:12px;padding:14px 24px">Parad.mn · ${esc(s.location)} · ${esc(s.phone)}</td></tr>
  </table></td></tr></table></body></html>`;
  const text = `${s.event_name} — таны бүртгэлийн пасс\n\n${o.name}, бүртгэл баталгаажлаа.\nОгноо: ${fmtEvent(s.event_at)}\nБайршил: ${s.location}\nЗахиалга: ${o.code}\nТасалбар: ${nums}\n\n` +
    tickets.map(t => `№${t.number}: ${ticketUrl(base, t.token)}`).join('\n') + `\n\nУтас: ${s.phone}`;
  return { subject: `${s.event_name} — таны бүртгэлийн пасс ${nums}`, html, text, attachments: att };
}

function adminEmail(o: any, tickets: any[], s: any, title?: string) {
  const base = siteBase(s);
  const nums = tickets.map(t => t.number).join(', ');
  const rows = [
    ['Захиалга', o.code], ['Нэр', o.name], ['Утас', [o.phone, o.phone2].filter(Boolean).join(', ')], ['Имэйл', o.email || '—'],
    ['Аймаг, сум', [o.aimag, o.sum].filter(Boolean).join(', ') || '—'], ['Цол', o.title || '—'],
    ['Тоо', `${o.qty} ширхэг`], ['Дүн', money(o.paid_amount ?? o.amount)], ['Төлбөр', o.pay_method],
    ['Төлөв', o.status], ['Дугаар', nums || '—'], ['Эх сурвалж', o.source === 'manual' ? `Гараар (${o.created_by || ''})` : 'Онлайн'],
  ];
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b211f">
    <h2 style="color:${NAVY};margin:0 0 10px">${esc(title || `Шинэ бүртгэл: ${o.name}`)}</h2>
    <table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#777">${k}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table>
    ${base ? `<p><a href="${base}admin.html">Админ хэсэг нээх →</a></p>` : ''}</div>`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  return { subject: title || `Шинэ бүртгэл: ${o.name}`, html, text };
}

const notifyList = (s: any) => String(s.notify_email || '').split(/[,;\s]+/).filter(x => x.includes('@'));

async function loadOrderFull(orderId: string) {
  const o = await q(db.from('parade_orders').select('*').eq('id', orderId).single());
  const tickets = await q(db.from('parade_tickets').select('number,token,status').eq('order_id', orderId).eq('status', 'valid').order('number'));
  return { o, tickets };
}

// Төлбөр баталгаажсаны дараах имэйлүүд (худалдан авагч + админ мэдэгдэл). force=true бол дахин илгээнэ.
async function sendOrderEmails(orderId: string, opts: { force?: boolean; notify?: boolean } = {}): Promise<{ sent: boolean; error: string | null }> {
  if (!opts.force) {
    const claimed = await q(db.from('parade_orders').update({ email_sent_at: new Date().toISOString() })
      .eq('id', orderId).is('email_sent_at', null).select('id'));
    if (!claimed?.length) return { sent: false, error: null };
  }
  const s = await getSettings();
  const { o, tickets } = await loadOrderFull(orderId);
  const errors: string[] = [];
  if (o.email && tickets.length) {
    try { await sendMail({ to: [o.email], ...ticketEmail(o, tickets, s) }); }
    catch (e) { errors.push('Худалдан авагч: ' + (e as Error).message); }
  }
  if (opts.notify !== false && !opts.force && notifyList(s).length) {
    try { await sendMail({ to: notifyList(s), ...adminEmail(o, tickets, s) }); }
    catch (e) { errors.push('Админ мэдэгдэл: ' + (e as Error).message); }
  }
  const error = errors.join(' | ') || null;
  await db.from('parade_orders').update({ email_sent_at: new Date().toISOString(), email_error: error }).eq('id', orderId);
  if (error) console.error('Email', o.code, error);
  return { sent: !!o.email && !errors.some(x => x.startsWith('Худалдан')), error };
}

async function notifyProblem(o: any, reason: string) {
  try {
    const s = await getSettings();
    const t = reason === 'SOLD_OUT_REFUND' ? `⚠ Буцаалт хэрэгтэй: тасалбар дууссаны дараа төлсөн (${o.code})`
      : `⚠ Буцаалт хэрэгтэй: цуцлагдсан захиалга төлөгдсөн (${o.code})`;
    if (notifyList(s).length) await sendMail({ to: notifyList(s), ...adminEmail(o, [], s, t) });
  } catch (e) { console.error('notifyProblem', e); }
}

function background(p: Promise<unknown>) {
  const safe = p.catch(e => console.error('background', e));
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(safe);
  return safe;
}

// ---------------------------------------------------------------- нийтийн үйлдлүүд
function publicOrder(o: any, tickets: any[] = [], info?: any) {
  return {
    code: o.code, name: o.name, phone: o.phone, email: o.email, aimag: o.aimag, sum: o.sum, title: o.title, qty: o.qty, amount: o.amount,
    status: o.status, pay_method: o.pay_method, expires_at: o.expires_at, paid_at: o.paid_at, created_at: o.created_at,
    email_sent: !!o.email_sent_at && !o.email_error,
    qpay: o.status === 'pending' && o.pay_method === 'qpay' ? {
      qr_image: o.invoice_qr_image, qr_text: o.invoice_qr_text, short_url: o.invoice_short_url, urls: o.invoice_urls || [],
    } : null,
    bank_info: o.pay_method === 'transfer' ? info?.bank_info || '' : undefined,
    tickets: tickets.map(t => ({ number: t.number, token: t.token })),
  };
}

async function actInfo() {
  const info = await rpc('parade_public_info');
  return { ...info, pay_mode: QPAY_ON ? 'qpay' : (info.bank_info ? 'transfer' : 'none'), qpay_sandbox: QPAY_ON && SANDBOX };
}

async function actCreate(_b: any, _req: Request) {
  throw new HttpError(410, 'Энэ удаагийн парадад тасалбар зарахгүй. Үнэгүй бүртгэлд бүртгүүлнэ үү.');
}

function cleanReg(b: any) {
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const phone = String(b.phone || '').replace(/[^\d+]/g, '');
  const phone2 = String(b.phone2 || '').replace(/[^\d+]/g, '');
  const email = String(b.email || '').trim().toLowerCase();
  const aimag = String(b.aimag || '').trim();
  const sum = String(b.sum || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const title = String(b.title || '').trim();
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Нэрээ зөв оруулна уу.');
  if (!/^\+?\d{8,15}$/.test(phone)) throw new HttpError(400, 'Утасны дугаараа зөв оруулна уу (8 оронтой).');
  if (phone2 && !/^\+?\d{8,15}$/.test(phone2)) throw new HttpError(400, 'Нэмэлт утасны дугаараа зөв оруулна уу.');
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120)) throw new HttpError(400, 'Имэйл хаягаа зөв оруулна уу.');
  if (!AIMAGS.includes(aimag)) throw new HttpError(400, 'Аймгаа сонгоно уу.');
  if (sum.length < 2) throw new HttpError(400, 'Сум / дүүргээ бичнэ үү.');
  if (title && !TITLES.includes(title)) throw new HttpError(400, 'Цолоо зөв сонгоно уу.');
  return { name, phone, phone2, email, aimag, sum, title, consent_data: b.consent_data === true, consent_mkt: b.consent_marketing === true };
}

// Үнэгүй бүртгэл (онлайн) — QR пасс олгоно. Нэг утас = нэг бүртгэл.
async function actRegister(b: any, req: Request) {
  if (b.website) throw new HttpError(400, 'Алдаа');
  const c = cleanReg(b);
  if (!c.consent_data) throw new HttpError(400, 'Мэдээлэл цуглуулах зөвшөөрлийг заавал сонгоно уу.');
  const s = await getSettings();
  if (!s.site_url && typeof b.site === 'string' && /^https:\/\/[^/]+\//.test(b.site)) {
    const origin = req.headers.get('origin') || '';
    if (origin && b.site.startsWith(origin + '/')) await db.from('parade_settings').update({ site_url: b.site }).eq('id', 1);
  }
  const r = await rpc('parade_register', {
    p_name: c.name, p_phone: c.phone, p_phone2: c.phone2, p_email: c.email, p_aimag: c.aimag, p_sum: c.sum, p_title: c.title,
    p_consent_data: c.consent_data, p_consent_mkt: c.consent_mkt, p_source: 'online', p_actor: null, p_ip: clientIp(req), p_note: null,
  });
  if (!r.existing && c.email) background(sendOrderEmails(r.order.id, { notify: false }));
  const t = (r.tickets || [])[0];
  return { token: t?.token, number: t?.number, existing: !!r.existing, name: r.order.name };
}

// ---------- Дуудлагын оролцооны хураамж (QPay)
async function orderByToken(tok: unknown) {
  const t = String(tok || '').trim().toLowerCase();
  if (!/^[a-f0-9]{16,40}$/.test(t)) throw new HttpError(404, 'Пасс олдсонгүй.');
  const tk = await q(db.from('parade_tickets').select('order_id,status').eq('token', t).maybeSingle());
  if (!tk || tk.status !== 'valid') throw new HttpError(404, 'Пасс олдсонгүй.');
  return await q(db.from('parade_orders').select('*').eq('id', tk.order_id).single());
}
function depView(o: any, s: any) {
  return {
    status: o.dep_status, amount: o.dep_amount || s.deposit_amount, open: !!s.deposit_open, paid_at: o.dep_paid_at,
    qpay: o.dep_status === 'pending' ? { qr_image: o.dep_qr_image, qr_text: o.dep_qr_text, short_url: o.dep_short_url, urls: o.dep_urls || [] } : null,
    bank_info: s.bank_info || '',
  };
}
async function depSync(o: any): Promise<any> {
  if (o.dep_status !== 'pending' || !QPAY_ON || !o.dep_invoice_id) return o;
  let chk;
  try { chk = await qpayCheck(o.dep_invoice_id); } catch (e) { console.error('QPay dep check', o.code, e); return o; }
  if (!chk.paid || chk.amount < (o.dep_amount || 0)) return o;
  return await q(db.from('parade_orders').update({
    dep_status: 'paid', dep_paid_at: new Date().toISOString(), dep_payment_id: chk.paymentId, dep_method: 'qpay', updated_at: new Date().toISOString(),
  }).eq('id', o.id).neq('dep_status', 'paid').select('*').maybeSingle()) || o;
}
async function actDepositStart(b: any) {
  let o = await orderByToken(b.t);
  const s = await getSettings();
  if (o.status !== 'paid') throw new HttpError(409, 'Бүртгэл идэвхгүй байна.');
  if (o.dep_status === 'paid') return { deposit: depView(o, s) };
  if (!s.deposit_open) throw new HttpError(409, 'Оролцооны хураамж төлөх хугацаа хараахан нээгдээгүй байна. Парадын дараа нээгдэнэ.');
  if (!QPAY_ON) return { deposit: depView({ ...o, dep_status: 'none' }, s) };       // QPay байхгүй: данс/бэлнээр төлж ажилтан баталгаажуулна
  o = await depSync(o);
  if (o.dep_status === 'pending' && o.dep_qr_text) return { deposit: depView(o, s) };
  const amount = s.deposit_amount;
  const j = await qpay('/invoice', 'POST', {
    invoice_code: QPAY_INVOICE_CODE, sender_invoice_no: o.code + '-D', invoice_receiver_code: o.phone || 'terminal',
    invoice_description: `${s.event_name} дуудлага худалдааны оролцооны хураамж (${o.code})`, amount,
    callback_url: `${FUNC_URL}?action=deposit_callback&code=${encodeURIComponent(o.code)}`,
  });
  if (!j.invoice_id) throw new HttpError(502, 'QPay нэхэмжлэх үүсгэж чадсангүй.');
  o = await q(db.from('parade_orders').update({
    dep_status: 'pending', dep_amount: amount, dep_invoice_id: String(j.invoice_id), dep_qr_text: j.qr_text || null, dep_qr_image: j.qr_image || null,
    dep_short_url: j.qPay_shortUrl || j.qpay_short_url || null,
    dep_urls: Array.isArray(j.urls) ? j.urls.map((u: any) => ({ name: u.name, description: u.description, logo: u.logo, link: u.link })) : [],
  }).eq('id', o.id).select('*').single());
  return { deposit: depView(o, s) };
}
async function actDepositStatus(b: any) {
  let o = await orderByToken(b.t);
  o = await depSync(o);
  return { deposit: depView(o, await getSettings()) };
}
async function actDepositCallback(url: URL) {
  try {
    const c = String(url.searchParams.get('code') || '').trim().toUpperCase();
    const o = await q(db.from('parade_orders').select('*').eq('code', c).maybeSingle());
    if (o) await depSync(o);
  } catch (e) { console.error('dep callback', e); }
  return new Response('SUCCESS', { status: 200, headers: CORS });
}

async function orderByCode(code: string) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^MP-[A-Z0-9]{6}$/.test(c)) throw new HttpError(404, 'Захиалга олдсонгүй.');
  const o = await q(db.from('parade_orders').select('*').eq('code', c).maybeSingle());
  if (!o) throw new HttpError(404, 'Захиалга олдсонгүй.');
  return o;
}

async function actStatus(b: any) {
  let o = await orderByCode(b.code);
  if (!safeEq(String(b.key || ''), o.access_key)) throw new HttpError(404, 'Захиалга олдсонгүй.');
  o = await syncOrder(o, 'status');
  if (o.status === 'pending' && new Date(o.expires_at).getTime() < Date.now()) {
    o = await q(db.from('parade_orders').update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', o.id).eq('status', 'pending').select('*').maybeSingle()) || o;
  }
  const tickets = o.status === 'paid'
    ? await q(db.from('parade_tickets').select('number,token').eq('order_id', o.id).eq('status', 'valid').order('number')) : [];
  const info = await rpc('parade_public_info');
  return { order: publicOrder(o, tickets, info), event: info };
}

async function actTicket(b: any) {
  const t = String(b.t || '').trim().toLowerCase();
  if (!/^[a-f0-9]{16,40}$/.test(t)) throw new HttpError(404, 'Тасалбар олдсонгүй.');
  const tk = await q(db.from('parade_tickets').select('number,token,status,holder_name,entry_at,food_at,drink_at,order_id').eq('token', t).maybeSingle());
  if (!tk) throw new HttpError(404, 'Тасалбар олдсонгүй.');
  let o = await q(db.from('parade_orders').select('*').eq('id', tk.order_id).single());
  o = await depSync(o);
  const info = await rpc('parade_public_info');
  const { order_id: _x, ...ticket } = tk;
  return { ticket: { ...ticket, holder_name: tk.holder_name || o.name, order_code: o.code }, event: info, deposit: depView(o, await getSettings()) };
}

async function actCallback(url: URL) {
  try {
    const o = await orderByCode(url.searchParams.get('code') || '');
    await syncOrder(o, 'qpay-callback');
  } catch (e) { console.error('callback', e); }
  return new Response('SUCCESS', { status: 200, headers: CORS });
}

async function actLookup(b: any) {
  const c = String(b.contact || '').trim().toLowerCase();
  const generic = { ok: true, message: 'Хэрэв энэ мэдээллээр төлөгдсөн захиалга байвал тасалбарыг таны имэйл рүү дахин илгээлээ. Имэйлээ (Spam хавтсыг ч) шалгана уу.' };
  let query = db.from('parade_orders').select('id,email,email_sent_at').eq('status', 'paid').limit(5);
  if (c.includes('@')) query = query.eq('email', c);
  else {
    const p = c.replace(/[^\d+]/g, '');
    if (p.length < 8) throw new HttpError(400, 'Утас эсвэл имэйлээ зөв оруулна уу.');
    query = query.eq('phone', p);
  }
  const orders = await q(query);
  for (const o of orders || []) {
    if (!o.email) continue;
    if (o.email_sent_at && Date.now() - new Date(o.email_sent_at).getTime() < 2 * 60_000) continue;  // 2 минутын хязгаар
    await db.from('parade_orders').update({ email_sent_at: new Date().toISOString() }).eq('id', o.id);
    background(sendOrderEmails(o.id, { force: true }));
  }
  return generic;
}

// ================================================================= parad.mn: адуу · гүү тавих · зарах
const STUD_ERRORS: Record<string, string> = {
  STUD_CLOSED: 'Энэ азарга одоогоор гүү тавих захиалга авахгүй байна.',
  STUD_TOO_MANY: 'Танд хүлээгдэж буй захиалга олон байна. Ажилтан баталгаажуулсны дараа дахин оролдоно уу.',
  NO_AUCTION: 'Энэ адуу дуудлага худалдаанд ороогүй байна.',
  AUCTION_CLOSED: 'Энэ дуудлага хаагдсан байна.',
  AUCTION_NOT_STARTED: 'Дуудлага хараахан эхлээгүй байна.',
  AUCTION_ENDED: 'Дуудлагын хугацаа дууссан байна.',
  RATE: 'Хэт олон бооцоо тавьлаа. Нэг минут хүлээгээд дахин оролдоно уу.',
  BAD_AMOUNT: 'Бооцооны дүн хэт өндөр байна. Нэмэлт тэг бичсэн эсэхээ шалгана уу.',
};
function dbError2(e: { message?: string }): HttpError | null {
  const m = String(e?.message || e);
  const [code, arg] = m.split(':');
  if (code === 'FULL') {
    const n = Number(arg) || 0;
    return new HttpError(409, n > 0 ? `Энэ азарганд ${n} суудал л үлдсэн байна.` : 'Уучлаарай, энэ азарга дүүрсэн байна.');
  }
  if (code === 'BAD_MARES') return new HttpError(400, `Гүүний тоо 1–${Number(arg) || 5} хооронд байна.`);
  if (code === 'LOW_BID') return new HttpError(409, `Бооцоо дор хаяж ${money(Number(arg))} байх ёстой.`);
  if (STUD_ERRORS[code]) return new HttpError(409, STUD_ERRORS[code]);
  return null;
}

const cleanTxt = (v: unknown, max: number) => String(v ?? '').replace(/[<>\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanPhone = (v: unknown) => String(v ?? '').replace(/[^\d+]/g, '');
const okPhone = (v: string) => /^\+?\d{8,15}$/.test(v);
const maskName = (n: string) => String(n || '').trim().split(/\s+/).map(w => (w.length <= 1 ? w : w[0] + '.')).join(' ');
const maskCode = (c: string) => String(c || '').replace(/^(.{3}).*(.{2})$/, '$1••••$2');

async function pmSettings() {
  return await q(db.from('pm_settings').select('*').eq('id', 1).single());
}
function publicSite(s: any) {
  return {
    season: s.stud_season, hold_hours: s.stud_hold_hours, max_mares: s.stud_max_mares, terms: s.stud_terms,
    sale_note: s.sale_note, phone: s.contact_phone, bank_info: s.bank_info, extend_min: s.auction_extend_min,
  };
}
const pmNotify = (s: any) => String(s.notify_email || '').split(/[,;\s]+/).filter((x: string) => x.includes('@'));

async function pmMail(subject: string, rows: [string, string][]) {
  const s = await pmSettings();
  const to = pmNotify(s);
  if (!to.length || !MAIL_ON) return;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px"><h3 style="color:#0b3a48;margin:0 0 10px">${esc(subject)}</h3>
    <table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) =>
      `<tr><td style="padding:6px 10px;border:1px solid #e2ddd0;background:#f7f5ef;font-weight:bold;width:38%">${esc(k)}</td><td style="padding:6px 10px;border:1px solid #e2ddd0">${esc(v)}</td></tr>`).join('')}</table></div>`;
  await sendMail({ to, subject, html, text });
}

const fmtMnt = (n: number | null | undefined) => (n == null ? 'тохиролцоно' : money(Number(n)));

async function horseBySlug(slug: string) {
  const list = await rpc<any[]>('horses_public');
  const h = list.find((x: any) => x.slug === slug);
  if (!h) throw new HttpError(404, 'Адуу олдсонгүй.');
  return h;
}

async function actHorses() {
  const [horses, s, info] = await Promise.all([rpc('horses_public'), pmSettings(), rpc('parade_public_info')]);
  return { horses, site: publicSite(s), event: { ...info, pay_mode: QPAY_ON ? 'qpay' : (info.bank_info ? 'transfer' : 'none') }, now: new Date().toISOString() };
}

async function actHorse(b: any) {
  const slug = cleanTxt(b.slug, 70);
  const [h, s] = await Promise.all([horseBySlug(slug), pmSettings()]);
  const queue = h.stud_enabled
    ? (await q(db.from('stud_bookings').select('code,mares,queue_from,status').eq('horse_id', h.id).in('status', ['confirmed', 'done']).order('queue_from')))
      .map((r: any) => ({ code: maskCode(r.code), mares: r.mares, queue_from: r.queue_from, status: r.status }))
    : [];
  const bids = h.sale_mode === 'auction'
    ? (await q(db.from('bids').select('name,amount,created_at').eq('horse_id', h.id).eq('voided', false).order('amount', { ascending: false }).limit(15)))
      .map((r: any) => ({ name: maskName(r.name), amount: r.amount, at: r.created_at }))
    : [];
  return { horse: h, queue, bids, site: publicSite(s), now: new Date().toISOString() };
}

async function actStudCreate(b: any, req: Request) {
  if (b.website) throw new HttpError(400, 'Алдаа');
  const name = cleanTxt(b.name, 80), phone = cleanPhone(b.phone);
  const mares = Math.floor(Number(b.mares));
  if (name.length < 2) throw new HttpError(400, 'Нэрээ оруулна уу.');
  if (!okPhone(phone)) throw new HttpError(400, 'Утасны дугаар буруу байна (8 оронтой байх ёстой).');
  if (!Number.isFinite(mares) || mares < 1) throw new HttpError(400, 'Гүүний тоог сонгоно уу.');
  const slug = cleanTxt(b.slug, 70);
  const r = await rpc('stud_create', {
    p_slug: slug, p_name: name, p_phone: phone, p_mares: mares, p_mare_info: cleanTxt(b.mare_info, 500),
    p_location: cleanTxt(b.location, 120), p_note: cleanTxt(b.note, 500), p_ip: clientIp(req),
  });
  const h = await horseBySlug(slug).catch(() => null);
  background(pmMail(`Шинэ захиалга ${r.code}: ${h?.name || slug} азарга — ${name} (${mares} гүү)`, [
    ['Код', r.code], ['Азарга', h?.name || slug], ['Захиалагч', name], ['Утас', phone], ['Гүүний тоо', String(mares)],
    ['Гүүний мэдээлэл', r.mare_info || '—'], ['Аймаг, сум', r.location || '—'], ['Тайлбар', r.note || '—'],
    ['Үнэ (нэг гүү)', fmtMnt(h?.stud_price)],
  ]));
  return { code: r.code };
}

async function studPublic(code: string) {
  const c = String(code || '').trim().toUpperCase().replace(/^GT-?/, 'GT-');
  if (!/^GT-[A-Z0-9]{6}$/.test(c)) throw new HttpError(404, 'Кодын хэлбэр буруу байна (GT-XXXXXX).');
  const bk = await q(db.from('stud_bookings').select('*').eq('code', c).maybeSingle());
  if (!bk) throw new HttpError(404, 'Ийм дугаартай захиалга олдсонгүй.');
  const [s, list] = await Promise.all([pmSettings(), rpc<any[]>('horses_public')]);
  const h = list.find((x: any) => x.id === bk.horse_id) || null;
  const holdMs = s.stud_hold_hours * 3600_000;
  const expiresAt = new Date(new Date(bk.pending_since).getTime() + holdMs).toISOString();
  const status = bk.status === 'pending' && Date.now() > new Date(expiresAt).getTime() ? 'expired' : bk.status;
  const unit = bk.unit_price ?? (h ? h.stud_price : null);
  return {
    booking: {
      code: bk.code, status, owner_name: bk.owner_name, phone: bk.phone, mares: bk.mares, mare_info: bk.mare_info, location: bk.location,
      note: bk.note, queue_from: bk.queue_from, unit_price: unit, amount: bk.amount ?? (unit == null ? null : unit * bk.mares), paid: bk.paid,
      created_at: bk.created_at, expires_at: expiresAt, confirmed_at: bk.confirmed_at, cancel_reason: bk.cancel_reason,
    },
    horse: h ? { slug: h.slug, name: h.name, name_en: h.name_en, photos: h.photos, stud_price: h.stud_price, stud_fee: h.stud_fee, stud_discount: h.stud_discount } : null,
    site: publicSite(s),
  };
}
const actStudStatus = (b: any) => studPublic(b.code);

async function actInquire(b: any, req: Request) {
  if (b.website) throw new HttpError(400, 'Алдаа');
  const name = cleanTxt(b.name, 80), phone = cleanPhone(b.phone);
  const kind = b.kind === 'reserve' ? 'reserve' : 'inquiry';
  const offer = b.offer === '' || b.offer == null ? null : Math.round(Number(b.offer));
  if (name.length < 2) throw new HttpError(400, 'Нэрээ оруулна уу.');
  if (!okPhone(phone)) throw new HttpError(400, 'Утасны дугаар буруу байна (8 оронтой байх ёстой).');
  if (offer != null && (!Number.isFinite(offer) || offer < 0 || offer > 100_000_000_000)) throw new HttpError(400, 'Санал болгох үнэ буруу байна.');
  const h = await horseBySlug(cleanTxt(b.slug, 70));
  if (h.sale_mode !== 'fixed' || h.sale_status === 'sold') throw new HttpError(409, 'Энэ адуу одоогоор зарагдахгүй байна.');
  const recent = await q(db.from('sale_inquiries').select('id', { count: 'exact', head: false }).eq('phone', phone).eq('horse_id', h.id)
    .gte('created_at', new Date(Date.now() - 3600_000).toISOString()));
  if ((recent || []).length >= 3) throw new HttpError(429, 'Хүсэлт өмнө нь илгээгдсэн байна. Ажилтан тантай удахгүй холбогдоно.');
  await q(db.from('sale_inquiries').insert({
    horse_id: h.id, name, phone, kind, offer, message: cleanTxt(b.message, 800) || null, client_ip: clientIp(req),
  }));
  background(pmMail(`${kind === 'reserve' ? 'Авахыг хүссэн' : 'Асуулга'}: ${h.name} — ${name}`, [
    ['Адуу', h.name], ['Нэр', name], ['Утас', phone], ['Төрөл', kind === 'reserve' ? 'Авах хүсэлт' : 'Асуулга'],
    ['Санал болгосон үнэ', offer == null ? '—' : money(offer)], ['Зарах үнэ', fmtMnt(h.sale_price)], ['Тайлбар', cleanTxt(b.message, 800) || '—'],
  ]));
  return { ok: true };
}

async function actBid(b: any, req: Request) {
  if (b.website) throw new HttpError(400, 'Алдаа');
  const name = cleanTxt(b.name, 80), phone = cleanPhone(b.phone);
  const amount = Math.round(Number(b.amount));
  if (name.length < 2) throw new HttpError(400, 'Нэрээ оруулна уу.');
  if (!okPhone(phone)) throw new HttpError(400, 'Утасны дугаар буруу байна (8 оронтой байх ёстой).');
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Бооцооны дүнгээ оруулна уу.');
  const r = await rpc('bid_place', { p_slug: cleanTxt(b.slug, 70), p_name: name, p_phone: phone, p_amount: amount, p_ip: clientIp(req) });
  return r;
}

// ---------------------------------------------------------------- админ (адуу, гүү тавих, зарах)
const HORSE_TEXT = ['name', 'name_en', 'color', 'breed', 'tamga', 'microchip', 'sire', 'dam', 'description', 'notes', 'pedigree_img', 'sold_to_name', 'sold_to_phone'];
const HORSE_INT = ['foaled', 'sort', 'stud_discount', 'stud_capacity'];
const HORSE_BIG = ['stud_fee', 'stud_price_new', 'sale_price', 'auction_start_price', 'auction_step', 'sold_price'];
const HORSE_BOOL = ['published', 'stud_enabled', 'stud_active', 'auction_closed'];
const HORSE_TS = ['auction_starts_at', 'auction_ends_at', 'sold_at'];

function horsePatch(h: any): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const k of HORSE_TEXT) if (k in h) p[k] = cleanTxt(h[k], k === 'description' || k === 'notes' ? 3000 : 300) || null;
  for (const k of HORSE_INT) if (k in h) p[k] = h[k] === '' || h[k] == null ? null : Math.round(Number(h[k]));
  for (const k of HORSE_BIG) if (k in h) p[k] = h[k] === '' || h[k] == null ? null : Math.round(Number(h[k]));
  for (const k of HORSE_BOOL) if (k in h) p[k] = !!h[k];
  for (const k of HORSE_TS) if (k in h) p[k] = h[k] ? new Date(h[k]).toISOString() : null;
  if ('kind' in h) {
    if (!['stallion', 'mare', 'colt', 'filly', 'gelding'].includes(h.kind)) throw new HttpError(400, 'Төрөл буруу байна.');
    p.kind = h.kind;
  }
  if ('sale_mode' in h) {
    if (!['none', 'fixed', 'auction'].includes(h.sale_mode)) throw new HttpError(400, 'Зарах төрөл буруу байна.');
    p.sale_mode = h.sale_mode;
  }
  if ('sale_status' in h) {
    if (!['available', 'reserved', 'sold'].includes(h.sale_status)) throw new HttpError(400, 'Зарах төлөв буруу байна.');
    p.sale_status = h.sale_status;
  }
  if ('photos' in h) {
    const arr = Array.isArray(h.photos) ? h.photos : [];
    p.photos = arr.slice(0, 12).map((x: any) => ({ u: String(x?.u || '').slice(0, 600), t: String(x?.t || x?.u || '').slice(0, 600) }))
      .filter((x: any) => /^(https:\/\/|img\/)/.test(x.u));
  }
  for (const k of Object.keys(p)) if (Number.isNaN(p[k] as number)) throw new HttpError(400, `«${k}» талбарын утга буруу байна.`);
  if (p.pedigree_img && !/^(https:\/\/|img\/)/.test(String(p.pedigree_img))) p.pedigree_img = null;
  return p;
}
function slugify(s: string) {
  const map: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', ө: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ү: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return s.toLowerCase().split('').map(c => map[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

// Админ: хуучин «гүү тавих» (Firebase) захиалгыг оруулах
function legacyDate(v: any): string | null {
  if (!v) return null;
  const d = typeof v === 'object' && v.seconds != null ? new Date(v.seconds * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function adminPm(action: string, b: any, me: { email: string; role: string }) {
  switch (action) {
    case 'admin_pm_stats':
      return await rpc('pm_stats');

    case 'admin_pm_settings_get':
      return { settings: await pmSettings() };
    case 'admin_pm_settings_save': {
      const s = b.settings || {};
      const p: any = { updated_at: new Date().toISOString() };
      for (const k of ['stud_season', 'sale_note', 'contact_phone', 'notify_email', 'bank_info']) if (k in s) p[k] = cleanTxt(s[k], 1000);
      for (const k of ['stud_hold_hours', 'stud_max_mares', 'stud_default_capacity', 'auction_extend_min']) if (k in s) p[k] = Math.round(Number(s[k]));
      if ('stud_terms' in s) p.stud_terms = (Array.isArray(s.stud_terms) ? s.stud_terms : String(s.stud_terms).split('\n')).map((x: any) => cleanTxt(x, 400)).filter(Boolean).slice(0, 20);
      const r = await q(db.from('pm_settings').update(p).eq('id', 1).select('*').single());
      log(me.email, 'pm_settings', p);
      return { settings: r };
    }

    case 'admin_horses': {
      const horses = await rpc('horses_public', { p_all: true });
      return { horses, site: publicSite(await pmSettings()) };
    }
    case 'admin_horse_save': {
      const h = b.horse || {};
      const p = horsePatch(h);
      if (!h.id) {
        if (!p.name) throw new HttpError(400, 'Адууны нэрийг оруулна уу.');
        let slug = cleanTxt(h.slug, 60).toLowerCase() || slugify(String(p.name)) || 'horse';
        if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) slug = 'horse-' + Math.random().toString(36).slice(2, 7);
        const exist = await q(db.from('horses').select('id').eq('slug', slug).maybeSingle());
        if (exist) slug = slug + '-' + Math.random().toString(36).slice(2, 5);
        const row = await q(db.from('horses').insert({ ...p, slug }).select('id,slug').single());
        log(me.email, 'horse_add', { id: row.id, slug });
        return { ok: true, id: row.id, slug: row.slug };
      }
      if ('name' in p && !p.name) throw new HttpError(400, 'Адууны нэрийг оруулна уу.');
      p.updated_at = new Date().toISOString();
      await q(db.from('horses').update(p).eq('id', h.id));
      log(me.email, 'horse_edit', { id: h.id, keys: Object.keys(p) });
      return { ok: true, id: h.id };
    }
    case 'admin_horse_delete': {
      const id = String(b.id || '');
      const [a, c, d] = await Promise.all([
        db.from('stud_bookings').select('id', { count: 'exact', head: true }).eq('horse_id', id),
        db.from('sale_inquiries').select('id', { count: 'exact', head: true }).eq('horse_id', id),
        db.from('bids').select('id', { count: 'exact', head: true }).eq('horse_id', id),
      ]);
      if ((a.count || 0) + (c.count || 0) + (d.count || 0) > 0)
        throw new HttpError(409, 'Энэ адуунд захиалга/хүсэлт/бооцоо холбогдсон тул устгах боломжгүй. «Сайтад харуулах» сонголтыг унтрааж нууна уу.');
      await q(db.from('horses').delete().eq('id', id));
      log(me.email, 'horse_delete', { id });
      return { ok: true };
    }
    case 'admin_horse_photo': {                           // base64 (data: угтваргүй) JPEG/PNG/WebP, ≤ 3MB
      const slug = cleanTxt(b.slug, 70).toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug)) throw new HttpError(400, 'Адууг эхлээд хадгална уу.');
      const raw = String(b.data || '').replace(/^data:[^,]+,/, '');
      const bin = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
      if (!bin.length || bin.length > 3 * 1024 * 1024) throw new HttpError(400, 'Зураг хоосон эсвэл 3MB-аас том байна.');
      const type = ['image/jpeg', 'image/png', 'image/webp'].includes(b.type) ? b.type : 'image/jpeg';
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      const path = `${slug}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const up = await db.storage.from('horses').upload(path, bin, { contentType: type, upsert: false });
      if (up.error) throw new HttpError(500, 'Зураг хадгалж чадсангүй: ' + up.error.message);
      return { url: db.storage.from('horses').getPublicUrl(path).data.publicUrl };
    }

    case 'admin_stud_list': {
      let qy = db.from('stud_bookings').select('*, horses(name,slug,stud_capacity,stud_fee,stud_discount)').order('created_at', { ascending: false }).limit(2000);
      if (b.horse_id) qy = qy.eq('horse_id', b.horse_id);
      return { bookings: await q(qy), site: publicSite(await pmSettings()) };
    }
    case 'admin_stud_add': {                               // утсаар/биечлэн ирсэн захиалгыг админ бүртгэх
      const h = await q(db.from('horses').select('slug').eq('id', b.horse_id).single());
      const name = cleanTxt(b.name, 80), phone = cleanPhone(b.phone);
      if (name.length < 2 || !okPhone(phone)) throw new HttpError(400, 'Нэр, утасны дугаараа зөв оруулна уу.');
      const r = await rpc('stud_create', { p_slug: h.slug, p_name: name, p_phone: phone, p_mares: Math.round(Number(b.mares)), p_mare_info: cleanTxt(b.mare_info, 500), p_location: cleanTxt(b.location, 120), p_note: cleanTxt(b.note, 500), p_ip: null });
      if (b.confirm) await rpc('stud_confirm', { p_code: r.code, p_actor: me.email });
      log(me.email, 'stud_add', { code: r.code, confirm: !!b.confirm });
      return { ok: true, code: r.code };
    }
    case 'admin_stud_confirm': {
      const r = await rpc('stud_confirm', { p_code: b.code, p_actor: me.email });
      log(me.email, 'stud_confirm', { code: b.code });
      return { ok: true, booking: r };
    }
    case 'admin_stud_cancel': {
      const r = await rpc('stud_cancel', { p_code: b.code, p_reason: cleanTxt(b.reason, 300) });
      log(me.email, 'stud_cancel', { code: b.code, reason: b.reason });
      return { ok: true, booking: r };
    }
    case 'admin_stud_update': {
      const code = String(b.code || '').toUpperCase();
      const p: any = { updated_at: new Date().toISOString() };
      if ('paid' in b) p.paid = !!b.paid;
      if ('admin_note' in b) p.admin_note = cleanTxt(b.admin_note, 800) || null;
      for (const k of ['owner_name', 'mare_info', 'location']) if (k in b) p[k] = cleanTxt(b[k], 500) || null;
      if ('phone' in b) { const ph = cleanPhone(b.phone); if (!okPhone(ph)) throw new HttpError(400, 'Утасны дугаар буруу.'); p.phone = ph; }
      if ('unit_price' in b) {
        p.unit_price = b.unit_price === '' || b.unit_price == null ? null : Math.round(Number(b.unit_price));
        const cur = await q(db.from('stud_bookings').select('mares').eq('code', code).single());
        p.amount = p.unit_price == null ? null : p.unit_price * cur.mares;
      }
      if ('status' in b) {
        if (!['done', 'confirmed'].includes(b.status)) throw new HttpError(400, 'Төлөв буруу.');
        const cur = await q(db.from('stud_bookings').select('status').eq('code', code).single());
        if (!['confirmed', 'done'].includes(cur.status)) throw new HttpError(409, 'Зөвхөн баталгаажсан захиалгыг «Хийгдсэн» болгоно.');
        p.status = b.status;
      }
      await q(db.from('stud_bookings').update(p).eq('code', code));
      log(me.email, 'stud_update', { code, ...p });
      return { ok: true };
    }
    case 'admin_stud_import': {                            // хуучин Firebase «bookings»-ийг JSON-оор оруулах
      const rows: any[] = Array.isArray(b.rows) ? b.rows : [];
      if (!rows.length) throw new HttpError(400, 'Импортлох өгөгдөл хоосон байна.');
      const horses = await q(db.from('horses').select('id,slug,stud_fee,stud_discount'));
      const bySlug = new Map<string, any>(horses.map((h: any) => [h.slug, h]));
      const have = new Set<string>((await q(db.from('stud_bookings').select('code').limit(10000))).map((r: any) => r.code));
      let added = 0, skipped = 0; const errors: string[] = []; const touched = new Set<string>();
      const toInsert: any[] = [];
      for (const r of rows) {
        const code = String(r.code || '').toUpperCase().trim();
        const h = bySlug.get(String(r.stallion || r.slug || r.horse || ''));
        if (!/^GT-[A-Z0-9]{6}$/.test(code)) { errors.push(`Код буруу: ${code || '(хоосон)'}`); continue; }
        if (!h) { errors.push(`${code}: азарга олдсонгүй (${r.stallion || r.slug || '—'}). Эхлээд seed.sql ажиллуулсан эсэхээ шалгана уу.`); continue; }
        if (have.has(code)) { skipped++; continue; }
        const status = ['pending', 'confirmed', 'done', 'cancelled', 'expired'].includes(r.status) ? r.status : 'pending';
        const mares = Math.max(1, Math.round(Number(r.mares || 1)));
        const unitMn = r.unitPrice ?? r.unit_price;                                  // хуучин систем: сая ₮
        const unit = unitMn == null || unitMn === '' ? null : (Number(unitMn) < 100000 ? Math.round(Number(unitMn) * 1e6) : Math.round(Number(unitMn)));
        const created = legacyDate(r.createdAt ?? r.created_at) || new Date().toISOString();
        const claim = r.transferClaimedAt ? `Шилжүүлсэн гэж тэмдэглэсэн (${legacyDate(r.transferClaimedAt)?.slice(0, 16)})${r.payerName ? ' · ' + r.payerName : ''}` : null;
        toInsert.push({
          code, horse_id: h.id, owner_name: cleanTxt(r.ownerName ?? r.owner_name, 80) || '—', phone: cleanPhone(r.phone) || '00000000',
          mares, mare_info: cleanTxt(r.mareInfo ?? r.mare_info, 500) || null, location: cleanTxt(r.location, 120) || null, note: cleanTxt(r.note, 500) || null,
          status, unit_price: unit, amount: unit == null ? null : unit * mares, paid: !!(r.paid ?? false),
          admin_note: cleanTxt([r.adminNote, claim].filter(Boolean).join(' | '), 800) || null, cancel_reason: cleanTxt(r.cancelReason ?? r.cancel_reason, 300) || null,
          pending_since: legacyDate(r.pendingSince ?? r.pending_since) || created,
          confirmed_at: status === 'confirmed' || status === 'done' ? (legacyDate(r.confirmedAt ?? r.confirmed_at) || created) : null,
          created_at: created, legacy: true,
        });
        have.add(code); touched.add(h.id); added++;
      }
      for (let i = 0; i < toInsert.length; i += 100) await q(db.from('stud_bookings').insert(toInsert.slice(i, i + 100)));
      for (const id of touched) await db.rpc('stud_requeue', { p_horse: id });
      log(me.email, 'stud_import', { added, skipped, errors: errors.length });
      return { ok: true, added, skipped, errors: errors.slice(0, 30) };
    }

    case 'admin_inquiries': {
      let qy = db.from('sale_inquiries').select('*, horses(name,slug,sale_price)').order('created_at', { ascending: false }).limit(1000);
      if (b.status) qy = qy.eq('status', b.status);
      return { inquiries: await q(qy) };
    }
    case 'admin_inquiry_set': {
      const p: any = {};
      if (b.status) { if (!['new', 'contacted', 'closed'].includes(b.status)) throw new HttpError(400, 'Төлөв буруу.'); p.status = b.status; }
      if ('admin_note' in b) p.admin_note = cleanTxt(b.admin_note, 800) || null;
      await q(db.from('sale_inquiries').update(p).eq('id', b.id));
      return { ok: true };
    }
    case 'admin_bids':
      return { bids: await q(db.from('bids').select('*').eq('horse_id', b.horse_id).order('amount', { ascending: false }).order('created_at', { ascending: true }).limit(500)) };
    case 'admin_bid_void': {
      await q(db.from('bids').update({ voided: !!b.voided }).eq('id', b.id));
      log(me.email, 'bid_void', { id: b.id, voided: !!b.voided });
      return { ok: true };
    }
    case 'admin_auction_close': {
      const r = await rpc('auction_close', { p_horse: b.horse_id, p_actor: me.email });
      log(me.email, 'auction_close', { horse: b.horse_id, ...r });
      return { ok: true, result: r };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- админ
async function staffFrom(req: Request, need: 'admin' | 'staff') {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!tok || tok.split('.').length !== 3) throw new HttpError(401, 'Нэвтэрнэ үү.');
  const { data, error } = await db.auth.getUser(tok);
  if (error || !data?.user?.email) throw new HttpError(401, 'Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.');
  const email = data.user.email.toLowerCase();
  const st = await q(db.from('parade_staff').select('email,role').eq('email', email).maybeSingle());
  if (!st) throw new HttpError(403, `${email} хэрэглэгч энэ системд эрхгүй байна.`);
  if (need === 'admin' && st.role !== 'admin') throw new HttpError(403, 'Энэ үйлдэлд админ эрх хэрэгтэй.');
  return st as { email: string; role: string };
}
const log = (actor: string, action: string, detail: unknown) =>
  db.from('parade_log').insert({ actor, action, detail }).then(() => {}, () => {});

const ORDER_COLS = 'id,code,name,phone,phone2,aimag,sum,title,email,qty,unit_price,amount,status,source,pay_method,invoice_id,payment_id,paid_amount,paid_at,expires_at,email_sent_at,email_error,note,created_by,created_at,updated_at,consent_data,consent_marketing,dep_status,dep_amount,dep_method,dep_paid_at,dep_by';

const SETTING_KEYS = ['event_name', 'event_at', 'sales_until', 'location', 'phone', 'price', 'start_no', 'total', 'max_per_order',
  'hold_minutes', 'transfer_hold_hours', 'sales_open', 'event_public', 'bank_info', 'notify_email', 'site_url', 'deposit_amount', 'deposit_open'];

async function admin(action: string, b: any, req: Request) {
  const staffOnly = ['admin_me', 'admin_stats', 'admin_scan', 'admin_find', 'admin_register'];
  const me = await staffFrom(req, staffOnly.includes(action) ? 'staff' : 'admin');

  switch (action) {
    case 'admin_me':
      return { email: me.email, role: me.role, qpay: QPAY_ON, qpay_mode: QPAY_ON ? QPAY_MODE : 'off', mail: MAIL_ON, mail_via: RESEND_KEY ? 'resend' : (SMTP_USER ? 'smtp' : 'off') };

    case 'admin_stats':
      return await rpc('parade_stats');

    case 'admin_orders': {
      const rows = await q(db.from('parade_orders')
        .select(ORDER_COLS + ',parade_tickets(id,number,token,status,entry_at,food_at,drink_at)')
        .order('created_at', { ascending: false }).limit(3000));
      return { orders: rows };
    }

    case 'admin_order_check': {
      const o = await q(db.from('parade_orders').select('*').eq('id', b.id).single());
      if (!o.invoice_id) throw new HttpError(400, 'Энэ захиалга QPay нэхэмжлэхгүй.');
      const before = o.status;
      const after = await syncOrder(o, me.email);
      let qpayInfo = null;
      try { qpayInfo = await qpayCheck(o.invoice_id); } catch (e) { qpayInfo = { error: (e as Error).message }; }
      return { before, after: after.status, qpay: qpayInfo };
    }

    case 'admin_order_confirm': {                    // данс/бэлнээр төлсөн гэж гараар баталгаажуулах
      const method = ['qpay', 'transfer', 'cash', 'card', 'free'].includes(b.method) ? b.method : null;
      const cur = await q(db.from('parade_orders').select('status').eq('id', b.id).single());
      if (!['pending', 'expired'].includes(cur.status)) throw new HttpError(409, 'Зөвхөн хүлээгдэж буй эсвэл хугацаа дууссан захиалгыг баталгаажуулна.');
      const r = await rpc('parade_finalize_order', { p_order_id: b.id, p_payment_id: null, p_paid_amount: null, p_method: method, p_actor: me.email });
      if (!r.ok) throw new HttpError(409, r.reason === 'SOLD_OUT_REFUND' ? 'Тасалбар хүрэлцэхгүй байна — захиалгыг «буцаалт» төлөвт орууллаа.' : 'Цуцлагдсан захиалгыг баталгаажуулах боломжгүй.');
      if (!r.already) background(sendOrderEmails(b.id));
      log(me.email, 'confirm', { id: b.id, method });
      return r;
    }

    case 'admin_order_cancel': {
      const o = await q(db.from('parade_orders').select('*').eq('id', b.id).single());
      if (o.status === 'pending' && o.invoice_id && QPAY_ON) {
        const synced = await syncOrder(o, me.email);                                     // цуцлахаас өмнө төлсөн эсэхийг шалгана
        if (synced.status === 'paid') throw new HttpError(409, 'Энэ захиалга дөнгөж төлөгдсөн байна. Хуудсаа шинэчилнэ үү.');
        try { await qpay(`/invoice/${o.invoice_id}`, 'DELETE'); } catch (e) { console.error('cancel invoice', e); }
      }
      await q(db.from('parade_tickets').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('order_id', o.id).eq('status', 'valid'));
      const note = [o.note, b.reason ? `Цуцалсан: ${b.reason}` : 'Цуцалсан', me.email].filter(Boolean).join(' · ');
      await q(db.from('parade_orders').update({ status: o.status === 'refund' ? 'refund' : 'cancelled', note, updated_at: new Date().toISOString() }).eq('id', o.id));
      log(me.email, 'cancel_order', { code: o.code, status: o.status });
      return { ok: true };
    }

    case 'admin_order_restore':
    case 'admin_ticket_restore': {                   // санамсаргүй цуцалсныг буцаах
      let orderId = b.id;
      if (action === 'admin_ticket_restore') {
        const t = await q(db.from('parade_tickets').select('order_id').eq('id', b.id).single());
        orderId = t.order_id;
      }
      const r = await rpc('parade_restore', { p_order_id: orderId, p_ticket_id: action === 'admin_ticket_restore' ? b.id : null, p_actor: me.email });
      if (r.renumbered > 0) background(sendOrderEmails(orderId, { force: true }));   // дугаар өөрчлөгдсөн бол шинэ тасалбар имэйлээр
      return r;
    }

    case 'admin_order_refunded': {                   // буцаалт хийгдсэн гэж тэмдэглэх
      const o = await q(db.from('parade_orders').select('note').eq('id', b.id).single());
      await q(db.from('parade_orders').update({ status: 'cancelled', note: [o.note, `Мөнгө буцаасан · ${me.email}`].filter(Boolean).join(' · ') }).eq('id', b.id).eq('status', 'refund'));
      log(me.email, 'refunded', { id: b.id });
      return { ok: true };
    }

    case 'admin_order_update': {
      const patch: any = { updated_at: new Date().toISOString() };
      if (b.name) patch.name = String(b.name).trim();
      if (b.phone !== undefined) patch.phone = String(b.phone).replace(/[^\d+]/g, '');
      if (b.email !== undefined) patch.email = String(b.email).trim().toLowerCase() || null;
      if (b.phone2 !== undefined) patch.phone2 = String(b.phone2).replace(/[^\d+]/g, '') || null;
      if (b.aimag !== undefined) patch.aimag = String(b.aimag).trim() || null;
      if (b.sum !== undefined) patch.sum = String(b.sum).trim() || null;
      if (b.title !== undefined) patch.title = String(b.title).trim() || null;
      if (b.note !== undefined) patch.note = String(b.note);
      await q(db.from('parade_orders').update(patch).eq('id', b.id));
      if (patch.name) await q(db.from('parade_tickets').update({ holder_name: patch.name }).eq('order_id', b.id));
      log(me.email, 'update_order', { id: b.id, ...patch });
      return { ok: true };
    }

    case 'admin_resend': {
      const o = await q(db.from('parade_orders').select('id,status,email').eq('id', b.id).single());
      if (o.status !== 'paid') throw new HttpError(400, 'Зөвхөн төлөгдсөн захиалгад илгээнэ.');
      if (!o.email) throw new HttpError(400, 'Имэйл хаяг алга. Эхлээд имэйл нэмнэ үү.');
      const r = await sendOrderEmails(o.id, { force: true });
      if (r.error) throw new HttpError(502, r.error);
      return { ok: true };
    }

    case 'admin_resend_failed': {                   // имэйл очоогүй бүх төлөгдсөн захиалгад дахин илгээх (нэг удаад 15)
      if (!MAIL_ON) throw new HttpError(400, 'Имэйл тохиргоо (SMTP_USER/SMTP_PASS) хийгдээгүй байна.');
      const rows = await q(db.from('parade_orders').select('id,code,email,email_error,email_sent_at')
        .eq('status', 'paid').not('email', 'is', null)
        .or('email_error.not.is.null,email_sent_at.is.null').order('created_at').limit(15));
      const results: { code: string; ok: boolean; error: string | null }[] = [];
      for (const o of rows || []) {
        const r = await sendOrderEmails(o.id, { force: true });
        results.push({ code: o.code, ok: !r.error, error: r.error });
      }
      const left = await q(db.from('parade_orders').select('id', { count: 'exact', head: true })
        .eq('status', 'paid').not('email', 'is', null).or('email_error.not.is.null,email_sent_at.is.null'));
      log(me.email, 'resend_failed', { sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
      return { results, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
    }

    case 'admin_tickets': {
      const rows = await q(db.from('parade_tickets')
        .select('id,number,token,status,holder_name,entry_at,entry_by,food_at,food_by,drink_at,drink_by,cancelled_at,created_at,parade_orders(id,code,name,phone,phone2,aimag,sum,title,email,pay_method,source)')
        .order('number').limit(5000));
      return { tickets: rows };
    }

    case 'admin_ticket_cancel': {
      await q(db.from('parade_tickets').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', b.id));
      log(me.email, 'cancel_ticket', { id: b.id });
      return { ok: true };
    }

    case 'admin_ticket_reset': {                     // уншуулсныг буцаах
      const col = ({ entry: 'entry', food: 'food', drink: 'drink' } as any)[b.mode];
      if (!col) throw new HttpError(400, 'mode буруу');
      await q(db.from('parade_tickets').update({ [`${col}_at`]: null, [`${col}_by`]: null }).eq('id', b.id));
      log(me.email, 'reset_scan', { id: b.id, mode: col });
      return { ok: true };
    }

    case 'admin_scan': {
      const mode = ['entry', 'food', 'drink', 'info'].includes(b.mode) ? b.mode : 'entry';
      return await rpc('parade_scan', { p_code: String(b.code || ''), p_mode: mode, p_actor: me.email });
    }

    case 'admin_register': {                         // танхимд ажилтан гараар бүртгэх
      const c = cleanReg(b);
      const r = await rpc('parade_register', {
        p_name: c.name, p_phone: c.phone, p_phone2: c.phone2, p_email: c.email, p_aimag: c.aimag, p_sum: c.sum, p_title: c.title,
        p_consent_data: b.consent_data === true, p_consent_mkt: b.consent_marketing === true, p_source: 'manual', p_actor: me.email, p_ip: null,
        p_note: b.note ? String(b.note).slice(0, 300) : null,
      });
      if (!r.existing && c.email) background(sendOrderEmails(r.order.id, { notify: false }));
      log(me.email, 'register', { code: r.order?.code, existing: r.existing });
      return r;
    }

    case 'admin_deposit_mark': {                     // оролцооны хураамж төлсөн (бэлэн/данс) эсвэл буцаах
      const s = await getSettings();
      if (b.paid === false) {
        await q(db.from('parade_orders').update({ dep_status: 'none', dep_paid_at: null, dep_method: null, dep_by: me.email, updated_at: new Date().toISOString() }).eq('id', b.id));
      } else {
        const method = ['cash', 'transfer', 'card', 'qpay'].includes(b.method) ? b.method : 'cash';
        await q(db.from('parade_orders').update({
          dep_status: 'paid', dep_amount: s.deposit_amount, dep_method: method, dep_paid_at: new Date().toISOString(), dep_by: me.email, updated_at: new Date().toISOString(),
        }).eq('id', b.id).eq('status', 'paid'));
      }
      log(me.email, 'deposit_mark', { id: b.id, paid: b.paid !== false, method: b.method });
      return { ok: true };
    }

    case 'admin_issue': {
      const method = ['cash', 'transfer', 'card', 'qpay', 'free'].includes(b.method) ? b.method : 'cash';
      const qty = Math.floor(Number(b.qty));
      const amount = b.amount === '' || b.amount == null ? null : Math.max(0, Math.round(Number(b.amount)));
      const r = await rpc('parade_issue_manual', {
        p_name: String(b.name || '').trim(), p_phone: String(b.phone || '').replace(/[^\d+]/g, ''),
        p_email: String(b.email || '').trim().toLowerCase(), p_qty: qty, p_method: method,
        p_amount: amount, p_note: b.note ? String(b.note) : null, p_actor: me.email,
      });
      const extra: any = {};
      if (b.phone2) extra.phone2 = String(b.phone2).replace(/[^\d+]/g, '');
      if (b.aimag) extra.aimag = String(b.aimag).trim();
      if (b.sum) extra.sum = String(b.sum).trim();
      if (b.title) extra.title = String(b.title).trim();
      if (r.ok && Object.keys(extra).length) await db.from('parade_orders').update(extra).eq('id', r.order.id);
      if (r.ok) background(sendOrderEmails(r.order.id));
      log(me.email, 'issue', { code: r.order?.code, qty, method });
      return r;
    }

    case 'admin_draw': {
      const r = await rpc('parade_draw', { p_prize: String(b.prize || ''), p_pool: b.pool === 'entered' ? 'entered' : 'all', p_actor: me.email });
      log(me.email, 'draw', r);
      return r;
    }
    case 'admin_draws':
      return { draws: await q(db.from('parade_draws').select('*').order('id', { ascending: false }).limit(500)) };
    case 'admin_draw_void': {
      await q(db.from('parade_draws').update({ voided: true }).eq('id', b.id));
      log(me.email, 'draw_void', { id: b.id });
      return { ok: true };
    }

    case 'admin_settings_get':
      return { settings: await getSettings() };
    case 'admin_settings_save': {
      const patch: any = { updated_at: new Date().toISOString() };
      for (const k of SETTING_KEYS) if (b.settings && k in b.settings) patch[k] = b.settings[k] === '' && ['sales_until'].includes(k) ? null : b.settings[k];
      for (const k of ['price', 'start_no', 'total', 'max_per_order', 'hold_minutes', 'transfer_hold_hours', 'deposit_amount']) if (k in patch) patch[k] = Math.round(Number(patch[k]));
      if ('sales_open' in patch) patch.sales_open = !!patch.sales_open;
      if ('event_public' in patch) patch.event_public = !!patch.event_public;
      if ('deposit_open' in patch) patch.deposit_open = !!patch.deposit_open;
      if ('total' in patch) {
        const sold = (await rpc('parade_stats')).sold;
        if (patch.total < sold) throw new HttpError(400, `Нийт тоо борлогдсон (${sold})-оос бага байж болохгүй.`);
      }
      const s = await q(db.from('parade_settings').update(patch).eq('id', 1).select('*').single());
      log(me.email, 'settings', patch);
      return { settings: s };
    }

    case 'admin_staff_list':
      return { staff: await q(db.from('parade_staff').select('*').order('created_at')) };
    case 'admin_staff_add': {
      const email = String(b.email || '').trim().toLowerCase();
      const role = b.role === 'admin' ? 'admin' : 'staff';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Имэйл буруу.');
      let note = '';
      if (b.password) {
        if (String(b.password).length < 6) throw new HttpError(400, 'Нууц үг дор хаяж 6 тэмдэгт.');
        const { error } = await db.auth.admin.createUser({ email, password: String(b.password), email_confirm: true });
        if (error) note = /already|registered|exists/i.test(error.message) ? 'Хэрэглэгч өмнө нь бүртгэлтэй байсан — нууц үг өөрчлөгдөөгүй.' : 'Хэрэглэгч үүсгэхэд алдаа: ' + error.message;
      }
      await q(db.from('parade_staff').upsert({ email, role }));
      log(me.email, 'staff_add', { email, role });
      return { ok: true, note };
    }
    case 'admin_staff_remove': {
      const email = String(b.email || '').toLowerCase();
      if (email === me.email) throw new HttpError(400, 'Өөрийгөө хасах боломжгүй.');
      await q(db.from('parade_staff').delete().eq('email', email));
      log(me.email, 'staff_remove', { email });
      return { ok: true };
    }

    case 'admin_test_email': {
      const to = String(b.to || '').trim() || me.email;
      const s = await getSettings();
      const qr = qrGif(siteBase(s) || 'https://example.com', 5);
      await sendMail({
        to: [to], subject: `${s.event_name} — туршилтын имэйл`,
        html: `<div style="font-family:Arial,sans-serif"><h2 style="color:${NAVY}">Имэйл ажиллаж байна ✓</h2><p>Энэ бол тасалбарын системийн туршилтын имэйл. Доорх QR зураг харагдаж байвал тасалбарын QR ч харагдана.</p><img src="cid:test@parade" width="140" height="140" alt="QR"></div>`,
        text: 'Имэйл ажиллаж байна.', attachments: [{ filename: 'qr.gif', content: qr, cid: 'test@parade' }],
      });
      return { ok: true, to };
    }

    case 'admin_test_qpay': {
      if (!QPAY_ON) return { ok: false, message: 'QPay тохиргоо (QPAY_CLIENT_ID, QPAY_CLIENT_SECRET, QPAY_INVOICE_CODE) хийгдээгүй.' };
      await qpayToken(true);
      return { ok: true, message: `QPay холболт амжилттай (${SANDBOX ? 'туршилтын sandbox' : 'жинхэнэ'} горим).` };
    }

    case 'admin_log':
      return { log: await q(db.from('parade_log').select('*').order('id', { ascending: false }).limit(300)) };
  }
  const pmRes = await adminPm(action, b, me);
  if (pmRes !== undefined) return pmRes;
  throw new HttpError(400, 'Үл мэдэгдэх үйлдэл: ' + action);
}

// ---------------------------------------------------------------- серверийн гол хэсэг
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === 'POST') {
    const txt = await req.text();
    try { body = txt ? JSON.parse(txt) : {}; } catch { body = {}; }
  }
  const action = String(url.searchParams.get('action') || body.action || 'info');
  try {
    switch (action) {
      case 'info': return json(await actInfo());
      case 'create': return json(await actCreate(body, req));
      case 'register': return json(await actRegister(body, req));
      case 'deposit_start': return json(await actDepositStart(body));
      case 'deposit_status': return json(await actDepositStatus(body));
      case 'deposit_callback': return await actDepositCallback(url);
      case 'status': return json(await actStatus(body));
      case 'ticket': return json(await actTicket(body.t ? body : { t: url.searchParams.get('t') }));
      case 'lookup': return json(await actLookup(body));
      case 'callback': return await actCallback(url);
      case 'horses': return json(await actHorses());
      case 'horse': return json(await actHorse(body.slug ? body : { slug: url.searchParams.get('slug') }));
      case 'stud_create': return json(await actStudCreate(body, req));
      case 'stud_status': return json(await actStudStatus(body));
      case 'inquire': return json(await actInquire(body, req));
      case 'bid': return json(await actBid(body, req));
    }
    if (action.startsWith('admin_')) return json(await admin(action, body, req));
    throw new HttpError(400, 'Үл мэдэгдэх үйлдэл');
  } catch (e) {
    const err = e instanceof HttpError ? e : new HttpError(500, (e as Error)?.message || 'Алдаа гарлаа');
    if (err.status >= 500) console.error(action, e);
    return json({ error: err.message }, err.status);
  }
});
