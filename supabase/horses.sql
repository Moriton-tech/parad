-- =====================================================================
--  parad.mn — Адуу бүртгэл · Азарганд гүү тавих · Азарга зарах (2-р файл)
--  ЭХЭЛЖ schema.sql-ийг ажиллуулсны ДАРАА энийг SQL Editor-т бүтнээр нь хуулж Run.
--  Дахин ажиллуулахад аюулгүй (байгаа өгөгдлийг устгахгүй).
-- =====================================================================

-- ---------- 1. Хүснэгтүүд ----------

-- Сайтын нэмэлт тохиргоо (нэг мөр)
create table if not exists public.pm_settings (
  id                    int primary key default 1 check (id = 1),
  stud_season           text not null default '2027 оны хавар',
  stud_hold_hours       int  not null default 24 check (stud_hold_hours between 1 and 720),
  stud_max_mares        int  not null default 5  check (stud_max_mares between 1 and 50),
  stud_default_capacity int  not null default 10 check (stud_default_capacity between 1 and 200),
  stud_terms            jsonb not null default '[
    "Захиалга нь ажилтан утсаар холбогдож баталгаажуулснаар хүчин төгөлдөр болно.",
    "Гүүг хавар (4–6 сард) баталгаажсан дарааллын дагуу азарганд тавина.",
    "Үржүүлгийн үнийг гүү тавихаас өмнө бүрэн төлнө. «Private» азарганы үнийг тохиролцоно.",
    "Гүү нь эрүүл, ийлдэс/шинжилгээний бичигтэй байх шаардлагатай.",
    "Захиалгаа цуцлах бол дор хаяж 14 хоногийн өмнө мэдэгдэнэ."
  ]'::jsonb,
  sale_note             text not null default 'Худалдан авах хүсэлт илгээсний дараа ажилтан тантай утсаар холбогдож, үзэж танилцуулна.',
  auction_extend_min    int  not null default 5 check (auction_extend_min between 0 and 60),   -- сүүлийн N минутад бооцоо тавибал хугацаа сунана
  contact_phone         text not null default '80881069',
  notify_email          text not null default 'munkhtsetseg@moriton.mn',   -- шинэ захиалга/хүсэлт/бооцооны мэдэгдэл (таслалаар олон)
  bank_info             text not null default '',                          -- үржүүлгийн үнэ, худалдааны төлбөр төлөх данс
  updated_at            timestamptz not null default now()
);
insert into public.pm_settings (id) values (1) on conflict (id) do nothing;

-- Адууны бүртгэл (админ өөрөө бүртгэнэ): азарга, гүү, унага…
create table if not exists public.horses (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  kind          text not null default 'stallion' check (kind in ('stallion','mare','colt','filly','gelding')),
  name          text not null,
  name_en       text,
  foaled        int check (foaled between 1950 and 2100),
  color         text,
  breed         text,
  tamga         text,
  microchip     text,
  sire          text,
  dam           text,
  description   text,
  notes         text,
  photos        jsonb not null default '[]'::jsonb,        -- [{"u":"зураг","t":"жижиг зураг"}]
  pedigree_img  text,
  published     boolean not null default true,              -- сайтад харагдах эсэх
  sort          int not null default 100,
  -- Азарганд гүү тавих
  stud_enabled  boolean not null default false,
  stud_active   boolean not null default true,              -- false бол захиалга хаалттай
  stud_fee      bigint check (stud_fee is null or stud_fee >= 0),   -- ₮ (нэг гүү); null = Private (тохиролцоно)
  stud_discount int not null default 0 check (stud_discount between 0 and 90),
  stud_capacity int not null default 10 check (stud_capacity between 1 and 200),
  -- Зарах
  sale_mode     text not null default 'none' check (sale_mode in ('none','fixed','auction')),
  sale_price    bigint check (sale_price is null or sale_price >= 0),  -- ₮ (тогтмол үнэ)
  sale_status   text not null default 'available' check (sale_status in ('available','reserved','sold')),
  auction_start_price bigint check (auction_start_price is null or auction_start_price >= 0),
  auction_step  bigint not null default 500000 check (auction_step > 0),
  auction_starts_at timestamptz,
  auction_ends_at   timestamptz,
  auction_closed    boolean not null default false,
  sold_to_name  text,
  sold_to_phone text,
  sold_price    bigint,
  sold_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists horses_pub_idx on public.horses (published, sort);

-- Гүү тавих захиалга (кодыг нь мэддэг хүн л харна: GT-XXXXXX)
create table if not exists public.stud_bookings (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  horse_id      uuid not null references public.horses(id) on delete restrict,
  owner_name    text not null,
  phone         text not null,
  mares         int  not null check (mares between 1 and 50),
  mare_info     text,
  location      text,
  note          text,
  status        text not null default 'pending' check (status in ('pending','confirmed','done','cancelled','expired')),
  unit_price    bigint,                                      -- баталгаажих үеийн нэг гүүний үнэ (₮); null = тохиролцоно
  amount        bigint,
  paid          boolean not null default false,
  admin_note    text,
  cancel_reason text,
  queue_from    int,                                         -- дарааллын эхний дугаар (гүү бүрт нэг)
  pending_since timestamptz not null default now(),
  confirmed_at  timestamptz,
  legacy        boolean not null default false,              -- хуучин Firebase системээс импортолсон
  client_ip     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists stud_bookings_horse_idx on public.stud_bookings (horse_id, status);
create index if not exists stud_bookings_phone_idx on public.stud_bookings (phone);

-- Худалдан авах хүсэлт (тогтмол үнэтэй, эсвэл санал)
create table if not exists public.sale_inquiries (
  id         uuid primary key default gen_random_uuid(),
  horse_id   uuid not null references public.horses(id) on delete cascade,
  name       text not null,
  phone      text not null,
  message    text,
  offer      bigint,                                       -- санал болгож буй үнэ (₮)
  kind       text not null default 'inquiry' check (kind in ('inquiry','reserve')),
  status     text not null default 'new' check (status in ('new','contacted','closed')),
  admin_note text,
  client_ip  text,
  created_at timestamptz not null default now()
);
create index if not exists sale_inq_horse_idx on public.sale_inquiries (horse_id, created_at desc);

-- Дуудлагын бооцоо
create table if not exists public.bids (
  id         bigint generated always as identity primary key,
  horse_id   uuid not null references public.horses(id) on delete cascade,
  name       text not null,
  phone      text not null,
  amount     bigint not null check (amount > 0),
  voided     boolean not null default false,
  client_ip  text,
  created_at timestamptz not null default now()
);
create index if not exists bids_horse_idx on public.bids (horse_id, amount desc);

-- ---------- 2. Хамгаалалт: хөтчөөс шууд хандахгүй (зөвхөн Edge Function) ----------
alter table public.pm_settings    enable row level security;
alter table public.horses         enable row level security;
alter table public.stud_bookings  enable row level security;
alter table public.sale_inquiries enable row level security;
alter table public.bids           enable row level security;
revoke all on public.pm_settings, public.horses, public.stud_bookings, public.sale_inquiries, public.bids from anon, authenticated;
grant all on public.pm_settings, public.horses, public.stud_bookings, public.sale_inquiries, public.bids to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Зургийн сан (нийтэд харагдана; зөвхөн Edge Function бичнэ)
insert into storage.buckets (id, name, public) values ('horses', 'horses', true)
  on conflict (id) do update set public = true;

-- ---------- 3. Функцууд ----------

-- Үржүүлгийн үнэ хямдралтайгаар (₮); Private бол null
create or replace function public.horse_stud_price(h public.horses) returns bigint
language sql immutable as $$
  select case when h.stud_fee is null then null
              else round(h.stud_fee * (100 - h.stud_discount) / 100.0)::bigint end
$$;

-- Захиалгын код: GT-XXXXXX
create or replace function public.stud_code() returns text
language plpgsql volatile as $$
declare
  a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  c text;
begin
  loop
    c := 'GT-';
    for i in 1..6 loop
      c := c || substr(a, 1 + floor(random() * length(a))::int, 1);
    end loop;
    exit when not exists (select 1 from public.stud_bookings where code = c);
  end loop;
  return c;
end $$;

-- Баталгаажсан захиалгуудын дарааллыг (баталгаажсан цагаар) дахин тооцно
create or replace function public.stud_requeue(p_horse uuid) returns void
language sql as $$
  with q as (
    select id, 1 + coalesce(sum(mares) over (order by confirmed_at, created_at
                                             rows between unbounded preceding and 1 preceding), 0)::int as from_no
      from public.stud_bookings where horse_id = p_horse and status in ('confirmed', 'done'))
  update public.stud_bookings b set queue_from = q.from_no, updated_at = now() from q where b.id = q.id;
$$;

-- Нийтэд харагдах бүх адуу + үлдэгдэл тоо
create or replace function public.horses_public(p_all boolean default false) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.sort, x.name), '[]'::jsonb) from (
    select h.id, h.slug, h.kind, h.name, h.name_en, h.foaled, h.color, h.breed, h.tamga, h.microchip, h.sire, h.dam,
           h.description, h.notes, h.photos, h.pedigree_img, h.published, h.sort,
           h.stud_enabled, h.stud_active, h.stud_fee, h.stud_discount, public.horse_stud_price(h) as stud_price, h.stud_capacity,
           h.sale_mode, h.sale_price, h.sale_status, h.auction_start_price, h.auction_step,
           h.auction_starts_at, h.auction_ends_at, h.auction_closed,
           case when p_all then h.sold_to_name end as sold_to_name,
           case when p_all then h.sold_to_phone end as sold_to_phone,
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

-- Гүү тавих захиалга үүсгэх (азарганы мөрийг түгжиж, суудал хэтрэхээс сэргийлнэ)
create or replace function public.stud_create(
  p_slug text, p_name text, p_phone text, p_mares int, p_mare_info text,
  p_location text, p_note text, p_ip text default null) returns jsonb
language plpgsql as $$
declare
  s public.pm_settings;
  h public.horses;
  v_used int;
  v_pending int;
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

  -- Хуурамчаар олон захиалахаас сэргийлнэ
  if (select count(*) from public.stud_bookings
       where status = 'pending' and phone = trim(p_phone)
         and pending_since > now() - make_interval(hours => s.stud_hold_hours)) >= 5
     or (p_ip is not null and (select count(*) from public.stud_bookings
       where status = 'pending' and client_ip = p_ip
         and pending_since > now() - make_interval(hours => s.stud_hold_hours)) >= 15) then
    raise exception 'STUD_TOO_MANY';
  end if;

  insert into public.stud_bookings (code, horse_id, owner_name, phone, mares, mare_info, location, note, client_ip)
  values (public.stud_code(), h.id, trim(p_name), trim(p_phone), p_mares,
          nullif(trim(coalesce(p_mare_info, '')), ''), nullif(trim(coalesce(p_location, '')), ''),
          nullif(trim(coalesce(p_note, '')), ''), p_ip)
  returning * into b;
  return to_jsonb(b);
end $$;

-- Баталгаажуулах (админ). Хугацаа нь дууссан/цуцлагдсаныг ч админ сэргээж болно.
create or replace function public.stud_confirm(p_code text, p_actor text default null) returns jsonb
language plpgsql as $$
declare
  b public.stud_bookings;
  h public.horses;
  v_used int;
  v_unit bigint;
begin
  select * into b from public.stud_bookings where code = upper(trim(p_code)) for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if b.status in ('confirmed', 'done') then return to_jsonb(b); end if;
  select * into h from public.horses where id = b.horse_id for update;
  select coalesce(sum(mares), 0) into v_used from public.stud_bookings
   where horse_id = h.id and status in ('confirmed', 'done') and id <> b.id;
  if v_used + b.mares > h.stud_capacity then raise exception 'FULL:%', greatest(h.stud_capacity - v_used, 0); end if;
  v_unit := coalesce(b.unit_price, public.horse_stud_price(h));
  update public.stud_bookings
     set status = 'confirmed', confirmed_at = now(), cancel_reason = null,
         unit_price = v_unit, amount = case when v_unit is null then null else v_unit * b.mares end,
         updated_at = now()
   where id = b.id returning * into b;
  perform public.stud_requeue(h.id);
  select * into b from public.stud_bookings where id = b.id;
  return to_jsonb(b);
end $$;

create or replace function public.stud_cancel(p_code text, p_reason text default null) returns jsonb
language plpgsql as $$
declare b public.stud_bookings;
begin
  select * into b from public.stud_bookings where code = upper(trim(p_code)) for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  perform 1 from public.horses where id = b.horse_id for update;
  update public.stud_bookings
     set status = 'cancelled', cancel_reason = nullif(trim(coalesce(p_reason, '')), ''), queue_from = null, updated_at = now()
   where id = b.id returning * into b;
  perform public.stud_requeue(b.horse_id);
  select * into b from public.stud_bookings where id = b.id;
  return to_jsonb(b);
end $$;

-- Дуудлагын бооцоо тавих
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
  if (select count(*) from public.bids where phone = trim(p_phone) and created_at > now() - interval '1 minute') >= 6 then
    raise exception 'RATE';
  end if;

  select max(amount) into v_top from public.bids where horse_id = h.id and not voided;
  v_min := case when v_top is null then coalesce(h.auction_start_price, h.auction_step)
                else v_top + h.auction_step end;
  if p_amount is null or p_amount < v_min then raise exception 'LOW_BID:%', v_min; end if;
  if p_amount > greatest(v_min, 1000000) * 20 then raise exception 'BAD_AMOUNT'; end if;   -- алдаж нэмэлт 0 бичихээс сэргийлнэ

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

-- Дуудлага хаах (админ): хамгийн өндөр бооцоотой хүнийг тэмдэглэнэ
create or replace function public.auction_close(p_horse uuid, p_actor text default null) returns jsonb
language plpgsql as $$
declare
  h public.horses;
  d public.bids;
begin
  select * into h from public.horses where id = p_horse for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into d from public.bids where horse_id = h.id and not voided order by amount desc, created_at asc limit 1;
  if found then
    update public.horses set auction_closed = true, sale_status = 'reserved',
           sold_to_name = d.name, sold_to_phone = d.phone, sold_price = d.amount, updated_at = now()
     where id = h.id;
    return jsonb_build_object('winner', d.name, 'phone', d.phone, 'amount', d.amount);
  end if;
  update public.horses set auction_closed = true, updated_at = now() where id = h.id;
  return jsonb_build_object('winner', null);
end $$;

-- Самбарын тоо
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
    'sale_new', (select count(*) from public.sale_inquiries where status = 'new'),
    'auctions_open', (select count(*) from public.horses where sale_mode = 'auction' and not auction_closed
                       and auction_ends_at > now() and (auction_starts_at is null or auction_starts_at <= now())),
    'bids', (select count(*) from public.bids where not voided),
    'now', now())
$$;

-- ---------- 4. Функцуудыг зөвхөн Edge Function (service_role) дуудна ----------
do $$
declare f text;
begin
  foreach f in array array[
    'horse_stud_price(public.horses)', 'stud_code()', 'stud_requeue(uuid)', 'horses_public(boolean)',
    'stud_create(text,text,text,int,text,text,text,text)', 'stud_confirm(text,text)', 'stud_cancel(text,text)',
    'bid_place(text,text,text,bigint,text)', 'auction_close(uuid,text)', 'pm_stats()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
