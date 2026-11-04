-- =====================================================================
--  parad.mn — Үржүүлгийн хямдралыг ХУВИАР биш ҮНЭЭР оруулах
--  horses.stud_price_new: хямдарсан үнэ (₮). Хоосон бол хямдралгүй.
--  stud_discount (%) нь триггерээр автоматаар тооцогдоно (зөвхөн харуулахад).
--  Нэмэлт, дахин ажиллуулж болно.
-- =====================================================================
alter table public.horses add column if not exists stud_price_new bigint check (stud_price_new is null or stud_price_new >= 0);

create or replace function public.horse_stud_price(h public.horses) returns bigint
language sql immutable as $$
  select case when h.stud_fee is null then null
              when h.stud_price_new is not null then least(h.stud_price_new, h.stud_fee)
              else round(h.stud_fee * (100 - h.stud_discount) / 100.0)::bigint end
$$;

create or replace function public.horses_sync_discount() returns trigger
language plpgsql as $$
begin
  if new.stud_price_new is not null and (new.stud_fee is null or new.stud_fee <= 0 or new.stud_price_new >= new.stud_fee) then
    new.stud_price_new := null;
  end if;
  if new.stud_price_new is null then
    -- хуучин % хямдралыг хадгална (үнэ оруулаагүй үед)
    if tg_op = 'UPDATE' and old.stud_price_new is not null then new.stud_discount := 0; end if;
  else
    new.stud_discount := greatest(0, least(90, round(100 - new.stud_price_new * 100.0 / new.stud_fee)))::int;
  end if;
  return new;
end $$;

drop trigger if exists horses_sync_discount on public.horses;
create trigger horses_sync_discount before insert or update on public.horses
  for each row execute function public.horses_sync_discount();
