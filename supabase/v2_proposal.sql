-- =====================================================================
--  parad.mn — v2: Парадын саналын засвар (2026-11-27, Билигсайханы санал)
--  ӨМНӨХ файлуудын (schema → horses → seed → register → stud_price → horse_kinds) ДАРАА
--  SQL Editor-т бүтнээр нь хуулж Run. Дахин ажиллуулахад аюулгүй. Байгаа өгөгдлийг устгахгүй.
--
--  Юу нэмэгдэх вэ:
--   1. Тасалбар 2 төрөл: Үзэгч / Адуу худалдан авагч. Үзэгч → худалдан авагч болгоход зөрүүг төлнө.
--   2. Худалдан авагчийн тасалбар бүрэн төлөгдмөгц пайзны дугаар (1, 2, 3…) автоматаар олгоно.
--   3. Дэнчингүй. Хожоод татгалзсан хүнийг «хар жагсаалт»-д оруулна → дахин бооцоо тавихгүй.
--   4. Адуу: лотын дугаар (1–100), эзэн, пасспорт, 3 шинжилгээ, МСУХ батлалт, амжилт (он).
--   5. Нэг эзэнд 2 адуу (тохиргоо) — админ эзэн тус бүрээр нэмж болно.
--   6. Гүү тавих: гүү бэлэн байх огноо/газар, үржил хийх газар/огноо, хариуцагч.
--   7. Хураамж, шимтгэлийн тохиргоо: зарагч 200,000₮, азарга 1,000,000₮, шимтгэл 10%, гүү бүрээс 500,000₮.
-- =====================================================================

-- ---------- 1. Тасалбар: төрөл, пайз, хар жагсаалт ----------
alter table public.parade_settings add column if not exists viewer_price int not null default 0 check (viewer_price >= 0);
alter table public.parade_settings add column if not exists paddle_start int not null default 1 check (paddle_start > 0);
-- deposit_amount = «Адуу худалдан авагч» тасалбарын үнэ (11/27: 100,000₮; өмнө нь 200,000₮ оролцооны хураамж)
update public.parade_settings set deposit_amount = 100000 where id = 1 and deposit_amount = 200000;
alter table public.parade_settings alter column deposit_amount set default 100000;

alter table public.parade_orders add column if not exists kind text not null default 'viewer';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'parade_orders_kind_check') then
    alter table public.parade_orders add constraint parade_orders_kind_check check (kind in ('viewer','buyer'));
  end if;
end $$;
alter table public.parade_orders add column if not exists interests text[] not null default '{}';
alter table public.parade_orders add column if not exists paddle_no int;
alter table public.parade_orders add column if not exists fee_paid int not null default 0;
alter table public.parade_orders add column if not exists notice_ack_at timestamptz;          -- санамжтай танилцсан
alter table public.parade_orders add column if not exists blacklisted boolean not null default false;
alter table public.parade_orders add column if not exists blacklist_reason text;
alter table public.parade_orders add column if not exists blacklisted_at timestamptz;
create unique index if not exists parade_orders_paddle_uq on public.parade_orders (paddle_no) where paddle_no is not null;

-- Тухайн төрлийн тасалбарын үнэ, төлөх үлдэгдэл
create or replace function public.parade_fee_required(p_kind text) returns int
language sql stable as $$
  select case when p_kind = 'buyer' then s.deposit_amount else s.viewer_price end
    from public.parade_settings s where s.id = 1
$$;
create or replace function public.parade_fee_due(o public.parade_orders) returns int
language sql stable as $$ select greatest(public.parade_fee_required(o.kind) - o.fee_paid, 0) $$;

-- Төлбөр орж ирэх (dep_status → paid) бүрт: төлсөн дүн, пайзны дугаар
create or replace function public.parade_orders_fee() returns trigger
language plpgsql as $$
declare v_start int;
begin
  if new.dep_status = 'paid' and (tg_op = 'INSERT' or old.dep_status is distinct from 'paid') then
    new.fee_paid := greatest(new.fee_paid, public.parade_fee_required(new.kind));
  elsif tg_op = 'UPDATE' and old.dep_status = 'paid' and new.dep_status <> 'paid' and new.kind = old.kind then
    new.fee_paid := 0;                                     -- админ «төлөөгүй» болгож буцаасан
  end if;
  if new.kind = 'buyer' and new.dep_status = 'paid' and new.paddle_no is null then
    perform pg_advisory_xact_lock(hashtext('parade_paddle'));
    select paddle_start into v_start from public.parade_settings where id = 1;
    select greatest(coalesce(max(paddle_no) + 1, v_start), v_start) into new.paddle_no from public.parade_orders;
  end if;
  if new.blacklisted and (tg_op = 'INSERT' or not old.blacklisted) then new.blacklisted_at := now(); end if;
  if not new.blacklisted then new.blacklisted_at := null; end if;
  return new;
end $$;
drop trigger if exists parade_orders_fee on public.parade_orders;
create trigger parade_orders_fee before insert or update on public.parade_orders
  for each row execute function public.parade_orders_fee();

-- Өмнө нь дуудлагын оролцооны хураамж (200,000₮) төлсөн хүмүүс → «Адуу худалдан авагч» (пайзтай)
update public.parade_orders
   set kind = 'buyer', fee_paid = greatest(fee_paid, coalesce(dep_amount, 0), (select deposit_amount from public.parade_settings where id = 1))
 where status = 'paid' and dep_status = 'paid' and kind = 'viewer';

-- Үнэгүй (тасалбар 0₮) үзэгч бол төлбөр шаардахгүй — dep_status 'none' хэвээр, fee_due = 0.

-- Бүртгэл: төрөл, сонирхол, санамж (хуучин 13 аргументтэй хувилбарыг солино)
drop function if exists public.parade_register(text,text,text,text,text,text,text,boolean,boolean,text,text,text,text);
create or replace function public.parade_register(
  p_name text, p_phone text, p_phone2 text, p_email text, p_aimag text, p_sum text, p_title text,
  p_consent_data boolean, p_consent_mkt boolean,
  p_source text default 'online', p_actor text default null, p_ip text default null, p_note text default null,
  p_kind text default 'viewer', p_interests text[] default '{}', p_notice_ack boolean default false)
returns jsonb language plpgsql as $$
declare
  s public.parade_settings;
  o public.parade_orders;
  v_ex public.parade_orders;
  v_kind text := case when p_kind = 'buyer' then 'buyer' else 'viewer' end;
  r jsonb;
begin
  select * into s from public.parade_settings where id = 1 for update;
  if p_source = 'online' then
    if not s.sales_open then raise exception 'SALES_CLOSED'; end if;
    if now() >= public.parade_sales_close(s) then raise exception 'SALES_ENDED'; end if;
  end if;
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_phone), '') = '' then raise exception 'BAD_INPUT'; end if;
  if not coalesce(p_consent_data, false) then raise exception 'NO_CONSENT'; end if;
  if v_kind = 'buyer' and coalesce(array_length(p_interests, 1), 0) = 0 then raise exception 'NO_INTERESTS'; end if;
  if v_kind = 'buyer' and not coalesce(p_notice_ack, false) then raise exception 'NO_NOTICE'; end if;

  select * into v_ex from public.parade_orders
   where status = 'paid' and public.parade_phone8(phone) = public.parade_phone8(p_phone)
   order by created_at limit 1 for update;
  if found then
    -- Өмнө нь үзэгчээр бүртгүүлсэн хүн одоо худалдан авагч болох бол төрлийг нь сольж, зөрүүг төлүүлнэ
    if v_kind = 'buyer' and v_ex.kind = 'viewer' then
      update public.parade_orders
         set kind = 'buyer', interests = p_interests, notice_ack_at = now(),
             dep_status = case when dep_status = 'paid' then 'none' else dep_status end,
             dep_invoice_id = null, dep_qr_text = null, dep_qr_image = null, dep_urls = null, dep_short_url = null,
             updated_at = now()
       where id = v_ex.id returning * into v_ex;
    end if;
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
                                    consent_data, consent_marketing, consent_at, kind, interests, notice_ack_at)
  values (public.parade_code(), public.parade_token() || public.parade_token(), trim(p_name),
          regexp_replace(trim(p_phone), '[^0-9+]', '', 'g'),
          nullif(regexp_replace(coalesce(p_phone2, ''), '[^0-9+]', '', 'g'), ''),
          nullif(lower(trim(coalesce(p_email, ''))), ''), nullif(trim(coalesce(p_aimag, '')), ''),
          nullif(trim(coalesce(p_sum, '')), ''), nullif(trim(coalesce(p_title, '')), ''),
          1, 0, 0, 'pending', case when p_source = 'manual' then 'manual' else 'online' end, 'free',
          now() + interval '5 minutes', p_ip, p_note, p_actor,
          true, coalesce(p_consent_mkt, false), now(), v_kind, coalesce(p_interests, '{}'),
          case when p_notice_ack then now() end)
  returning * into o;

  r := public.parade_finalize_order(o.id, null, null, 'free', coalesce(p_actor, 'register'));
  return r || jsonb_build_object('existing', false);
end $$;

-- Үзэгч → худалдан авагч (пасс хуудаснаас)
create or replace function public.parade_upgrade(p_order uuid, p_interests text[], p_notice_ack boolean)
returns jsonb language plpgsql as $$
declare o public.parade_orders;
begin
  if coalesce(array_length(p_interests, 1), 0) = 0 then raise exception 'NO_INTERESTS'; end if;
  if not coalesce(p_notice_ack, false) then raise exception 'NO_NOTICE'; end if;
  select * into o from public.parade_orders where id = p_order for update;
  if not found or o.status <> 'paid' then raise exception 'NOT_FOUND'; end if;
  if o.kind = 'buyer' then
    update public.parade_orders set interests = p_interests, notice_ack_at = coalesce(notice_ack_at, now()), updated_at = now()
     where id = o.id returning * into o;
    return to_jsonb(o);
  end if;
  update public.parade_orders
     set kind = 'buyer', interests = p_interests, notice_ack_at = now(),
         dep_status = 'none', dep_invoice_id = null, dep_qr_text = null, dep_qr_image = null, dep_urls = null, dep_short_url = null,
         updated_at = now()
   where id = o.id returning * into o;
  return to_jsonb(o);
end $$;

-- Дуудлагад оролцох эрх: худалдан авагчийн тасалбар бүрэн төлсөн, хар жагсаалтад ороогүй
create or replace function public.parade_can_bid(p_phone text) returns boolean
language sql stable as $$
  select exists (select 1 from public.parade_orders o
                  where o.status = 'paid' and o.kind = 'buyer' and o.dep_status = 'paid' and not o.blacklisted
                    and public.parade_phone8(o.phone) = public.parade_phone8(p_phone)
                    and length(public.parade_phone8(p_phone)) = 8)
$$;

create or replace function public.parade_public_info() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'event_name', s.event_name, 'event_at', s.event_at, 'location', s.location, 'phone', s.phone,
    'price', s.price, 'total', s.total, 'start_no', s.start_no, 'max_per_order', s.max_per_order,
    'hold_minutes', s.hold_minutes, 'sales_open', s.sales_open, 'event_public', s.event_public, 'sales_close', public.parade_sales_close(s),
    'bank_info', s.bank_info,
    'deposit_amount', s.deposit_amount, 'deposit_open', s.deposit_open,
    'buyer_price', s.deposit_amount, 'viewer_price', s.viewer_price,
    'sold', (select count(*) from public.parade_tickets t where t.status = 'valid'),
    'available', greatest(public.parade_available(), 0),
    'now', now())
  from public.parade_settings s where s.id = 1
$$;

create or replace function public.parade_stats() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'total', s.total, 'price', s.price,
    'sold', (select count(*) from public.parade_tickets where status = 'valid'),
    'sold_online', (select count(*) from public.parade_tickets t join public.parade_orders o on o.id = t.order_id
                     where t.status = 'valid' and o.source = 'online'),
    'sold_manual', (select count(*) from public.parade_tickets t join public.parade_orders o on o.id = t.order_id
                     where t.status = 'valid' and o.source = 'manual'),
    'revenue', (select coalesce(sum(o.fee_paid), 0) from public.parade_orders o where o.status = 'paid'),
    'revenue_qpay', (select coalesce(sum(o.fee_paid), 0) from public.parade_orders o where o.status = 'paid' and o.dep_method = 'qpay'),
    'pending_orders', 0, 'pending_qty', 0,
    'refund_orders', (select count(*) from public.parade_orders where status = 'refund'),
    'email_errors', (select count(*) from public.parade_orders where status = 'paid' and email_error is not null),
    'available', greatest(public.parade_available(), 0),
    'entered', (select count(*) from public.parade_tickets where status = 'valid' and entry_at is not null),
    'food', (select count(*) from public.parade_tickets where status = 'valid' and food_at is not null),
    'drink', (select count(*) from public.parade_tickets where status = 'valid' and drink_at is not null),
    'paid_orders', (select count(*) from public.parade_orders where status = 'paid'),
    'consent_mkt', (select count(*) from public.parade_orders where status = 'paid' and consent_marketing),
    'viewers', (select count(*) from public.parade_orders where status = 'paid' and kind = 'viewer'),
    'buyers', (select count(*) from public.parade_orders where status = 'paid' and kind = 'buyer'),
    'dep_paid', (select count(*) from public.parade_orders where status = 'paid' and kind = 'buyer' and dep_status = 'paid'),
    'dep_amount', (select coalesce(sum(fee_paid), 0) from public.parade_orders where status = 'paid' and kind = 'buyer'),
    'blacklisted', (select count(*) from public.parade_orders where blacklisted),
    'by_aimag', coalesce((select jsonb_agg(x order by x.qty desc) from (
        select coalesce(o.aimag, '—') as aimag, count(*) as qty,
               count(*) filter (where o.kind = 'buyer') as buyers from public.parade_orders o
         where o.status = 'paid' group by 1) x), '[]'::jsonb),
    'interests', coalesce((select jsonb_agg(x order by x.qty desc) from (
        select i as interest, count(*) as qty from public.parade_orders o, unnest(o.interests) i
         where o.status = 'paid' and o.kind = 'buyer' group by 1) x), '[]'::jsonb),
    'interests_by_aimag', coalesce((select jsonb_agg(x order by x.aimag, x.qty desc) from (
        select coalesce(o.aimag, '—') as aimag, i as interest, count(*) as qty from public.parade_orders o, unnest(o.interests) i
         where o.status = 'paid' and o.kind = 'buyer' group by 1, 2) x), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(x order by x.day) from (
        select to_char(t.created_at at time zone 'Asia/Ulaanbaatar', 'YYYY-MM-DD') as day, count(*) as qty
          from public.parade_tickets t where t.status = 'valid' group by 1) x), '[]'::jsonb),
    'now', now())
  from public.parade_settings s where s.id = 1
$$;

-- ---------- 2. Адуу: лот, эзэн, пасспорт, шинжилгээ, МСУХ, амжилт ----------
alter table public.horses add column if not exists lot_no int check (lot_no is null or lot_no between 1 and 9999);
create unique index if not exists horses_lot_uq on public.horses (lot_no) where lot_no is not null;
alter table public.horses add column if not exists owner_name  text;
alter table public.horses add column if not exists owner_phone text;
alter table public.horses add column if not exists owner_aimag text;
alter table public.horses add column if not exists owner_sum   text;
alter table public.horses add column if not exists has_passport boolean not null default false;
alter table public.horses add column if not exists passport_img text;
alter table public.horses add column if not exists test_yam       text not null default 'pending';
alter table public.horses add column if not exists test_niiluuleg text not null default 'pending';
alter table public.horses add column if not exists test_hachig    text not null default 'pending';
alter table public.horses add column if not exists msuh_status text not null default 'pending';
alter table public.horses add column if not exists msuh_note   text;
alter table public.horses add column if not exists reg_fee_paid boolean not null default false;
alter table public.horses add column if not exists achievements jsonb not null default '[]'::jsonb;   -- [{"t":"Улсын баяр наадам","y":2019,"w":"эцэг"}]
alter table public.horses add column if not exists sold_paddle int;
alter table public.horses add column if not exists sold_order uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'horses_tests_check') then
    alter table public.horses add constraint horses_tests_check check (
      test_yam in ('pending','negative','positive') and test_niiluuleg in ('pending','negative','positive')
      and test_hachig in ('pending','negative','positive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'horses_msuh_check') then
    alter table public.horses add constraint horses_msuh_check check (msuh_status in ('pending','approved','rejected'));
  end if;
end $$;

-- Шалгалт бүрэн давсан эсэх: МСУХ баталсан + 3 шинжилгээ сөрөг (+ азарга бол пасспорттой)
create or replace function public.horse_verified(h public.horses) returns boolean
language sql immutable as $$
  select h.msuh_status = 'approved' and h.test_yam = 'negative' and h.test_niiluuleg = 'negative' and h.test_hachig = 'negative'
         and (h.kind <> 'stallion' or h.has_passport)
$$;

create or replace function public.horses_public(p_all boolean default false) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.sort, x.name), '[]'::jsonb) from (
    select h.id, h.slug, h.kind, h.name, h.name_en, h.foaled, h.color, h.breed, h.tamga, h.microchip, h.sire, h.dam,
           h.description, h.notes, h.photos, h.pedigree_img, h.published, h.sort,
           h.stud_enabled, h.stud_active, h.stud_fee, h.stud_discount, public.horse_stud_price(h) as stud_price, h.stud_capacity,
           h.stud_price_new,
           h.sale_mode, h.sale_price, h.sale_status, h.auction_start_price, h.auction_step,
           h.auction_starts_at, h.auction_ends_at, h.auction_closed,
           h.lot_no, h.has_passport, h.achievements, public.horse_verified(h) as verified,
           h.owner_aimag,
           case when p_all then h.owner_name end as owner_name,
           case when p_all then h.owner_phone end as owner_phone,
           case when p_all then h.owner_sum end as owner_sum,
           case when p_all then h.passport_img end as passport_img,
           case when p_all then h.test_yam end as test_yam,
           case when p_all then h.test_niiluuleg end as test_niiluuleg,
           case when p_all then h.test_hachig end as test_hachig,
           case when p_all then h.msuh_status end as msuh_status,
           case when p_all then h.msuh_note end as msuh_note,
           case when p_all then h.reg_fee_paid end as reg_fee_paid,
           case when p_all then h.sold_to_name end as sold_to_name,
           case when p_all then h.sold_to_phone end as sold_to_phone,
           case when p_all then h.sold_paddle end as sold_paddle,
           case when p_all then h.sold_order end as sold_order,
           case when p_all then h.sold_at end as sold_at,
           h.sold_price,
           coalesce((select sum(b.mares) from public.stud_bookings b
                      where b.horse_id = h.id and b.status in ('confirmed','done')), 0)::int as confirmed_mares,
           coalesce((select sum(b.mares) from public.stud_bookings b
                      where b.horse_id = h.id and b.status = 'pending'
                        and b.pending_since > now() - make_interval(hours => s.stud_hold_hours)), 0)::int as pending_mares,
           (select max(d.amount) from public.bids d where d.horse_id = h.id and not d.voided) as top_bid,
           (select count(*) from public.bids d where d.horse_id = h.id and not d.voided)::int as bid_count
      from public.horses h cross join public.pm_settings s
     where s.id = 1 and (p_all or h.published)) x
$$;

-- ---------- 3. Хураамж, шимтгэл, эзний хязгаар ----------
alter table public.pm_settings add column if not exists seller_reg_fee   bigint not null default 200000  check (seller_reg_fee >= 0);
alter table public.pm_settings add column if not exists stallion_reg_fee bigint not null default 1000000 check (stallion_reg_fee >= 0);
alter table public.pm_settings add column if not exists commission_pct   numeric(5,2) not null default 10 check (commission_pct between 0 and 100);
alter table public.pm_settings add column if not exists mare_org_fee     bigint not null default 500000  check (mare_org_fee >= 0);
alter table public.pm_settings add column if not exists seller_max_horses int not null default 2 check (seller_max_horses between 1 and 100);
alter table public.pm_settings add column if not exists achievement_min_year int check (achievement_min_year is null or achievement_min_year between 1950 and 2100);
alter table public.pm_settings add column if not exists pay_within_hours int not null default 24 check (pay_within_hours between 1 and 720);
alter table public.pm_settings add column if not exists handover_hours   int not null default 48 check (handover_hours between 1 and 720);
alter table public.pm_settings add column if not exists payout_days      int not null default 3  check (payout_days between 0 and 60);

-- Эзэн тус бүрийн хязгаарыг нэмэх (админ). phone8 = утасны сүүлийн 8 орон.
create table if not exists public.horse_owner_limits (
  phone8     text primary key check (phone8 ~ '^\d{8}$'),
  max_horses int  not null check (max_horses between 1 and 100),
  note       text,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.horse_owner_limits enable row level security;
revoke all on public.horse_owner_limits from anon, authenticated;
grant all on public.horse_owner_limits to service_role;

-- Тухайн эзний зарах адууны тоо, хязгаар
create or replace function public.owner_horse_limit(p_phone text) returns int
language sql stable as $$
  select coalesce((select max_horses from public.horse_owner_limits where phone8 = public.parade_phone8(p_phone)),
                  (select seller_max_horses from public.pm_settings where id = 1))
$$;

-- ---------- 4. Гүү тавих: логистик ----------
alter table public.stud_bookings add column if not exists mare_ready_date  date;
alter table public.stud_bookings add column if not exists mare_ready_place text;
alter table public.stud_bookings add column if not exists breeding_place   text;
alter table public.stud_bookings add column if not exists breeding_date    date;
alter table public.stud_bookings add column if not exists contact_name     text;
alter table public.stud_bookings add column if not exists contact_phone    text;
alter table public.stud_bookings add column if not exists org_fee          bigint;   -- зохион байгуулагчийн орлого (гүү × mare_org_fee), баталгаажих үед

drop function if exists public.stud_create(text,text,text,int,text,text,text,text);
create or replace function public.stud_create(
  p_slug text, p_name text, p_phone text, p_mares int, p_mare_info text,
  p_location text, p_note text, p_ip text default null,
  p_ready_date date default null, p_ready_place text default null,
  p_contact_name text default null, p_contact_phone text default null) returns jsonb
language plpgsql as $$
declare
  s public.pm_settings;
  h public.horses;
  v_used int;
  b public.stud_bookings;
begin
  select * into s from public.pm_settings where id = 1;
  select * into h from public.horses where slug = p_slug and published for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not h.stud_enabled or not h.stud_active then raise exception 'STUD_CLOSED'; end if;
  if coalesce(trim(p_name), '') = '' or length(trim(p_name)) < 2 or coalesce(trim(p_phone), '') = '' then raise exception 'BAD_INPUT'; end if;
  if p_mares is null or p_mares < 1 or p_mares > s.stud_max_mares then raise exception 'BAD_MARES:%', s.stud_max_mares; end if;

  select coalesce(sum(mares), 0) into v_used from public.stud_bookings
   where horse_id = h.id and status in ('confirmed', 'done');
  if h.stud_capacity - v_used <= 0 then raise exception 'FULL:0'; end if;
  if p_mares > h.stud_capacity - v_used then raise exception 'FULL:%', h.stud_capacity - v_used; end if;

  if (select count(*) from public.stud_bookings
       where status = 'pending' and phone = trim(p_phone)
         and pending_since > now() - make_interval(hours => s.stud_hold_hours)) >= 5
     or (p_ip is not null and (select count(*) from public.stud_bookings
       where status = 'pending' and client_ip = p_ip
         and pending_since > now() - make_interval(hours => s.stud_hold_hours)) >= 15) then
    raise exception 'STUD_TOO_MANY';
  end if;

  insert into public.stud_bookings (code, horse_id, owner_name, phone, mares, mare_info, location, note, client_ip,
                                    mare_ready_date, mare_ready_place, breeding_place, contact_name, contact_phone)
  values (public.stud_code(), h.id, trim(p_name), trim(p_phone), p_mares,
          nullif(trim(coalesce(p_mare_info, '')), ''), nullif(trim(coalesce(p_location, '')), ''),
          nullif(trim(coalesce(p_note, '')), ''), p_ip,
          p_ready_date, nullif(trim(coalesce(p_ready_place, '')), ''), null,
          nullif(trim(coalesce(p_contact_name, '')), ''), nullif(trim(coalesce(p_contact_phone, '')), ''))
  returning * into b;
  return to_jsonb(b);
end $$;

-- Баталгаажих үед зохион байгуулагчийн орлогыг (гүү × mare_org_fee) тогтооно
create or replace function public.stud_org_fee() returns trigger
language plpgsql as $$
begin
  if new.status in ('confirmed','done') and new.org_fee is null then
    new.org_fee := new.mares * (select mare_org_fee from public.pm_settings where id = 1);
  end if;
  if new.status in ('cancelled','expired') then new.org_fee := null; end if;
  return new;
end $$;
drop trigger if exists stud_org_fee on public.stud_bookings;
create trigger stud_org_fee before insert or update on public.stud_bookings
  for each row execute function public.stud_org_fee();

-- Самбар: шимтгэл, зохион байгуулагчийн орлого
create or replace function public.pm_stats() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'horses', (select count(*) from public.horses),
    'stallions', (select count(*) from public.horses where kind = 'stallion'),
    'stud_horses', (select count(*) from public.horses where stud_enabled),
    'stud_pending', (select count(*) from public.stud_bookings where status = 'pending'),
    'stud_confirmed', (select count(*) from public.stud_bookings where status in ('confirmed','done')),
    'stud_mares', (select coalesce(sum(mares), 0) from public.stud_bookings where status in ('confirmed','done')),
    'stud_amount', (select coalesce(sum(amount), 0) from public.stud_bookings where status in ('confirmed','done')),
    'stud_paid', (select coalesce(sum(amount), 0) from public.stud_bookings where status in ('confirmed','done') and paid),
    'stud_org_fee', (select coalesce(sum(org_fee), 0) from public.stud_bookings where status in ('confirmed','done')),
    'sale_new', (select count(*) from public.sale_inquiries where status = 'new'),
    'auctions_open', (select count(*) from public.horses where sale_mode = 'auction' and not auction_closed
                       and auction_ends_at > now() and (auction_starts_at is null or auction_starts_at <= now())),
    'bids', (select count(*) from public.bids where not voided),
    'lots', (select count(*) from public.horses where lot_no is not null),
    'verified', (select count(*) from public.horses h where public.horse_verified(h)),
    'sold_count', (select count(*) from public.horses where sale_status = 'sold'),
    'sold_amount', (select coalesce(sum(sold_price), 0) from public.horses where sale_status = 'sold'),
    'commission', (select coalesce(round(sum(sold_price) * s.commission_pct / 100), 0) from public.horses where sale_status = 'sold'),
    'reg_fees', (select coalesce(sum(case when kind = 'stallion' and stud_enabled then s.stallion_reg_fee else s.seller_reg_fee end), 0)
                   from public.horses where reg_fee_paid),
    'now', now())
  from public.pm_settings s where s.id = 1
$$;

-- ---------- 5. Эрх: зөвхөн Edge Function (service_role) ----------
do $$
declare f text;
begin
  foreach f in array array[
    'parade_fee_required(text)', 'parade_fee_due(public.parade_orders)', 'parade_orders_fee()',
    'parade_register(text,text,text,text,text,text,text,boolean,boolean,text,text,text,text,text,text[],boolean)',
    'parade_upgrade(uuid,text[],boolean)', 'parade_can_bid(text)', 'parade_public_info()', 'parade_stats()',
    'horse_verified(public.horses)', 'horses_public(boolean)', 'owner_horse_limit(text)',
    'stud_create(text,text,text,int,text,text,text,text,date,text,text,text)', 'stud_org_fee()', 'pm_stats()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
