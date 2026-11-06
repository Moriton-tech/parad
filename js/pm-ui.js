// parad.mn — адууны карт, шошго (нүүр, каталогт нийтлэг)
import { esc, money, mnt, million, KIND, photoOf, studPriceHtml, studState, auctionState, breedGroup } from './app.js?v=2611061045';

export function badges(h) {
  const out = [];
  const s = studState(h);
  if (s.st === 'open') out.push('<span class="badge blue">Гүү тавина</span>');
  else if (s.st === 'full') out.push('<span class="badge red">Дүүрсэн</span>');
  const a = auctionState(h);
  if (a === 'open') out.push('<span class="badge red">Дуудлага</span>');
  else if (a === 'scheduled') out.push('<span class="badge blue">Дуудлага удахгүй</span>');
  else if (h.sale_mode === 'auction' && (a === 'ended' || a === 'closed')) out.push(`<span class="badge grey">${h.sale_status === 'sold' ? 'Зарагдсан' : 'Дуудлага дууссан'}</span>`);
  if (h.sale_mode === 'fixed') {
    if (h.sale_status === 'available') out.push('<span class="badge ok">Зарна</span>');
    else out.push(`<span class="badge grey">${h.sale_status === 'sold' ? 'Зарагдсан' : 'Захиалагдсан'}</span>`);
  }
  return out.join('');
}

export function hcard(h) {
  const ph = photoOf(h, 0, true);
  const s = studState(h);
  const a = auctionState(h);
  const rows = [];
  if (h.stud_enabled) rows.push(`<div class="row"><span>Үржүүлгийн үнэ</span><b>${studPriceHtml(h)}</b></div>`);
  if (h.stud_enabled && s.st !== 'off') rows.push(`<div class="row" style="border:0;padding-top:0;margin-top:0"><span>Үлдсэн суудал</span><b>${s.left}/${s.cap}</b></div>`);
  if (h.sale_mode === 'fixed') rows.push(`<div class="row"><span>Зарах үнэ</span><b>${mnt(h.sale_price)}</b></div>`);
  if (h.sale_mode === 'auction') rows.push(`<div class="row"><span>${h.top_bid ? 'Одоогийн бооцоо' : 'Эхлэх үнэ'}</span><b>${money(h.top_bid || h.auction_start_price || 0)}</b></div>`);
  return `<a class="hc" href="horse.html?s=${encodeURIComponent(h.slug)}">
    <div class="ph${ph ? '' : ' empty'}"${ph ? ` style="background-image:url('${esc(ph)}')"` : ''}>${ph ? '' : 'М'}
      ${h.sort && h.sort < 100 ? `<span class="no">№${h.sort}</span>` : ''}<div class="badges">${badges(h)}</div></div>
    <div class="bd"><h3>${esc(h.name)}</h3>${h.name_en ? `<div class="en">${esc(h.name_en)}</div>` : ''}
      <div class="meta">${esc(KIND[h.kind] || '')}${h.foaled ? ' · ' + h.foaled + ' онд төрсөн' : ''}</div>
      ${h.breed ? `<div class="breed${breedGroup(h.breed) === 'Монгол азарга' ? ' mn' : ''}">${esc(h.breed)}</div>` : ''}
      ${rows.join('')}</div></a>`;
}
