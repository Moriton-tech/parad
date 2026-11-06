-- parad.mn — Адууны төрлийг насаар нь нэмэх (Унага, Даага, Шүдлэн, Хязаалан, Соёолон, Байдас)
-- Хуучин утгууд (stallion, mare, colt, filly, gelding) хэвээр. Дахин ажиллуулж болно.
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.horses'::regclass and contype = 'c'
           and pg_get_constraintdef(oid) ilike '%kind%' loop
    execute format('alter table public.horses drop constraint %I', c);
  end loop;
end $$;
alter table public.horses add constraint horses_kind_check check (kind in
  ('foal','yearling','shudlen','hyazaalan','soyolon','colt','stallion','gelding','filly','mare'));
