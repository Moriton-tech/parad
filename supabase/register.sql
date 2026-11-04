-- =====================================================================
--  parad.mn — Үнэгүй бүртгэл + дуудлагын оролцооны хураамж (3-р файл)
--  schema.sql болон horses.sql-ийн ДАРАА ажиллуулна. Дахин ажиллуулахад аюулгүй.
-- =====================================================================

-- Тохиргоо
alter table public.parade_settings add column if not exists deposit_amount int not null default 200000 check (deposit_amount >= 0);
alter table public.parade_settings add column if not exists deposit_open boolean not null default false;   -- парад дууссаны дараа нээнэ

-- Бүртгэл: зөвшөөрөл + дуудлагын оролцооны хураамж
alter table public.parade_orders add column if not exists consent_data      boolean not null default false;
alter table public.parade_orders add column if not exists consent_marketing boolean not null default false;
alter table public.parade_orders add column if not exists consent_at        timestamptz;
alter table public.parade_orders add column if not exists dep_status text not null default 'none' check (dep_status in ('none','pending','paid'));
alter table public.parade_orders add column if not exists dep_amount int;
alter table public.parade_orders add column if not exists dep_method text;
alter table public.parade_orders add column if not exists dep_invoice_id text;
alter table public.parade_orders add column if not exists dep_qr_text text;
alter table public.parade_orders add column if not exists dep_qr_image text;
alter table public.parade_orders add column if not exists dep_urls jsonb;
alter table public.parade_orders add column if not exists dep_short_url text;
alter table public.parade_orders add column if not exists dep_payment_id text;
alter table public.parade_orders add column if not exists dep_paid_at timestamptz;
alter table public.parade_orders add column if not exists dep_by text;
create index if not exists parade_orders_dep_idx on public.parade_orders (dep_status) where dep_status <> 'none';

-- Утасны сүүлийн 8 орон (+976 гэх мэтийг тооцохгүй)
create or replace function public.parade_phone8(p text) returns text
language sql immutable as $$ select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 8) $$;

-- Үнэгүй бүртгэл (нэг утас = нэг бүртгэл). Бүртгэл үүсгээд QR пасс (тасалбар) олгоно.
create or replace function public.parade_register(
  p_name text, p_phone text, p_phone2 text, p_email text, p_aimag text, p_sum text, p_title text,
  p_consent_data boolean, p_consent_mkt boolean,
  p_source text default 'online', p_actor text default null, p_ip text default null, p_note text default null)
returns jsonb language plpgsql as $$
declare
  s public.parade_settings;
  o public.parade_orders;
  v_ex public.parade_orders;
  r jsonb;
begin
  select * into s from public.parade_settings where id = 1 for update;
  if p_source = 'online' then
    if not s.sales_open then raise exception 'SALES_CLOSED'; end if;
    if now() >= public.parade_sales_close(s) then raise exception 'SALES_ENDED'; end if;
  end if;
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_phone), '') = '' then raise exception 'BAD_INPUT'; end if;
  if not coalesce(p_consent_data, false) then raise exception 'NO_CONSENT'; end if;

  select * into v_ex from public.parade_orders
   where status = 'paid' and public.parade_phone8(phone) = public.parade_phone8(p_phone)
   order by created_at limit 1;
  if found then
    return jsonb_build_object('ok', true, 'existing', true, 'order', to_jsonb(v_ex),
      'tickets', (select jsonb_agg(jsonb_build_object('number', t.number, 'token', t.token) order by t.number)
                    from public.parade_tickets t where t.order_id = v_ex.id and t.status = 'valid'));
  end if;

  if p_source = 'online' and p_ip is not null
     and (select count(*) from public.parade_orders where client_ip = p_ip and created_at > now() - interval '10 minutes') >= 15 then
    raise exception 'TOO_MANY';
  end if;

  insert into public.parade_orders (code, access_key, name, phone, phone2, email, aimag, sum, title, qty, unit_price, amount,
                                    status, source, pay_method, expires_at, client_ip, note, created_by,
                                    consent_data, consent_marketing, consent_at)
  values (public.parade_code(), public.parade_token() || public.parade_token(), trim(p_name),
          regexp_replace(trim(p_phone), '[^0-9+]', '', 'g'),
          nullif(regexp_replace(coalesce(p_phone2, ''), '[^0-9+]', '', 'g'), ''),
          nullif(lower(trim(coalesce(p_email, ''))), ''), nullif(trim(coalesce(p_aimag, '')), ''),
          nullif(trim(coalesce(p_sum, '')), ''), nullif(trim(coalesce(p_title, '')), ''),
          1, 0, 0, 'pending', case when p_source = 'manual' then 'manual' else 'online' end, 'free',
          now() + interval '5 minutes', p_ip, p_note, p_actor,
          true, coalesce(p_consent_mkt, false), now())
  returning * into o;

  r := public.parade_finalize_order(o.id, null, null, 'free', coalesce(p_actor, 'register'));
  return r || jsonb_build_object('existing', false);
end $$;

-- Дуудлагад оролцох эрх: бүртгэлтэй + оролцооны хураамж төлсөн утас
create or replace function public.parade_can_bid(p_phone text) returns boolean
language sql stable as $$
  select exists (select 1 from public.parade_orders o
                  where o.status = 'paid' and o.dep_status = 'paid'
                    and public.parade_phone8(o.phone) = public.parade_phone8(p_phone)
                    and length(public.parade_phone8(p_phone)) = 8)
$$;

-- Нийтэд харагдах мэдээлэлд хураамжийг нэмнэ
create or replace function public.parade_public_info() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'event_name', s.event_name, 'event_at', s.event_at, 'location', s.location, 'phone', s.phone,
    'price', s.price, 'total', s.total, 'start_no', s.start_no, 'max_per_order', s.max_per_order,
    'hold_minutes', s.hold_minutes, 'sales_open', s.sales_open, 'event_public', s.event_public, 'sales_close', public.parade_sales_close(s),
    'bank_info', s.bank_info,
    'deposit_amount', s.deposit_amount, 'deposit_open', s.deposit_open,
    'sold', (select count(*) from public.parade_tickets t where t.status = 'valid'),
    'available', greatest(public.parade_available(), 0),
    'now', now())
  from public.parade_settings s where s.id = 1
$$;

-- Самбарын тоо: бүртгэл, зөвшөөрөл, хураамж
create or replace function public.parade_stats() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'total', s.total, 'price', s.price,
    'sold', (select count(*) from public.parade_tickets where status = 'valid'),
    'sold_online', (select count(*) from public.parade_tickets t join public.parade_orders o on o.id = t.order_id
                     where t.status = 'valid' and o.source = 'online'),
    'sold_manual', (select count(*) from public.parade_tickets t join public.parade_orders o on o.id = t.order_id
                     where t.status = 'valid' and o.source = 'manual'),
    'revenue', (select coalesce(sum(o.paid_amount), 0) from public.parade_orders o where o.status = 'paid'),
    'revenue_qpay', (select coalesce(sum(o.paid_amount), 0) from public.parade_orders o where o.status = 'paid' and o.pay_method = 'qpay'),
    'pending_orders', 0, 'pending_qty', 0,
    'refund_orders', (select count(*) from public.parade_orders where status = 'refund'),
    'email_errors', (select count(*) from public.parade_orders where status = 'paid' and email_error is not null),
    'available', greatest(public.parade_available(), 0),
    'entered', (select count(*) from public.parade_tickets where status = 'valid' and entry_at is not null),
    'food', (select count(*) from public.parade_tickets where status = 'valid' and food_at is not null),
    'drink', (select count(*) from public.parade_tickets where status = 'valid' and drink_at is not null),
    'paid_orders', (select count(*) from public.parade_orders where status = 'paid'),
    'consent_mkt', (select count(*) from public.parade_orders where status = 'paid' and consent_marketing),
    'dep_paid', (select count(*) from public.parade_orders where status = 'paid' and dep_status = 'paid'),
    'dep_amount', (select coalesce(sum(dep_amount), 0) from public.parade_orders where dep_status = 'paid'),
    'by_aimag', coalesce((select jsonb_agg(x order by x.qty desc) from (
        select coalesce(o.aimag, '—') as aimag, count(*) as qty from public.parade_orders o
         where o.status = 'paid' group by 1) x), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(x order by x.day) from (
        select to_char(t.created_at at time zone 'Asia/Ulaanbaatar', 'YYYY-MM-DD') as day, count(*) as qty
          from public.parade_tickets t where t.status = 'valid' group by 1) x), '[]'::jsonb),
    'now', now())
  from public.parade_settings s where s.id = 1
$$;

-- Дуудлага: бүртгэлтэй, хураамж төлсөн хүн л бооцоо тавина
create or replace function public.bid_place(
  p_slug text, p_name text, p_phone text, p_amount bigint, p_ip text default null) returns jsonb
language plpgsql as $$
declare
  s public.pm_settings;
  h public.horses;
  v_top bigint;
  v_min bigint;
  v_ends timestamptz;
begin
  select * into s from public.pm_settings where id = 1;
  select * into h from public.horses where slug = p_slug and published for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if h.sale_mode <> 'auction' then raise exception 'NO_AUCTION'; end if;
  if h.auction_closed or h.sale_status <> 'available' then raise exception 'AUCTION_CLOSED'; end if;
  if h.auction_starts_at is not null and now() < h.auction_starts_at then raise exception 'AUCTION_NOT_STARTED'; end if;
  if h.auction_ends_at is null or now() >= h.auction_ends_at then raise exception 'AUCTION_ENDED'; end if;
  if coalesce(trim(p_name), '') = '' or length(trim(p_name)) < 2 or coalesce(trim(p_phone), '') = '' then raise exception 'BAD_INPUT'; end if;
  if not public.parade_can_bid(p_phone) then raise exception 'DEPOSIT_REQUIRED'; end if;
  if (select count(*) from public.bids where phone = trim(p_phone) and created_at > now() - interval '1 minute') >= 6 then
    raise exception 'RATE';
  end if;

  select max(amount) into v_top from public.bids where horse_id = h.id and not voided;
  v_min := case when v_top is null then coalesce(h.auction_start_price, h.auction_step)
                else v_top + h.auction_step end;
  if p_amount is null or p_amount < v_min then raise exception 'LOW_BID:%', v_min; end if;
  if p_amount > greatest(v_min, 1000000) * 20 then raise exception 'BAD_AMOUNT'; end if;

  insert into public.bids (horse_id, name, phone, amount, client_ip)
  values (h.id, trim(p_name), trim(p_phone), p_amount, p_ip);

  v_ends := h.auction_ends_at;
  if s.auction_extend_min > 0 and h.auction_ends_at - now() < make_interval(mins => s.auction_extend_min) then
    v_ends := now() + make_interval(mins => s.auction_extend_min);
    update public.horses set auction_ends_at = v_ends, updated_at = now() where id = h.id;
  end if;
  return jsonb_build_object('amount', p_amount, 'ends_at', v_ends, 'extended', v_ends <> h.auction_ends_at,
                            'next_min', p_amount + h.auction_step);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'parade_phone8(text)',
    'parade_register(text,text,text,text,text,text,text,boolean,boolean,text,text,text,text)',
    'parade_can_bid(text)', 'parade_public_info()', 'parade_stats()', 'bid_place(text,text,text,bigint,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
