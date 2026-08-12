-- Migration: agreed schema changes (see CLAUDE.md "Agreed schema changes")
-- Run once against the existing Supabase database (SQL editor or psql).
-- Idempotent: safe to rerun after a partial failure.
--
-- The DB contains mock data (kept for testing the UI, not real imports), so:
--   * old payment_method values are remapped before the new check is added
--     (bank_transfer → zelle, online → venmo; cash stays cash)
--   * existing fee rows get status = 'verified' so mock history renders as
--     Verified/Expired instead of flooding the new pending queue
-- Note: discord was agreed as a new column, but the DB already has it as
-- members.discord_username — nothing to add there.

BEGIN;

-- 1. members.student_id — permanent identity, backstop against duplicate rows
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS student_id text UNIQUE;

-- 2. membership_fees.status + screenshot_url
--    Backfill BEFORE tightening the default's meaning: pre-existing (mock)
--    rows are treated as already-verified payments.
ALTER TABLE public.membership_fees
  ADD COLUMN IF NOT EXISTS status character varying,
  ADD COLUMN IF NOT EXISTS screenshot_url text;

UPDATE public.membership_fees SET status = 'verified' WHERE status IS NULL;

ALTER TABLE public.membership_fees
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN status SET NOT NULL;

ALTER TABLE public.membership_fees
  DROP CONSTRAINT IF EXISTS membership_fees_status_check;
ALTER TABLE public.membership_fees
  ADD CONSTRAINT membership_fees_status_check
    CHECK (status::text = ANY (ARRAY['pending'::character varying, 'verified'::character varying, 'rejected'::character varying]::text[]));

-- 3. payment_method enum migration: cash/bank_transfer/online → venmo/zelle/cash
--    Remap existing (mock) rows first, then swap the check constraint.
ALTER TABLE public.membership_fees
  DROP CONSTRAINT IF EXISTS membership_fees_payment_method_check;

UPDATE public.membership_fees SET payment_method = 'zelle' WHERE payment_method = 'bank_transfer';
UPDATE public.membership_fees SET payment_method = 'venmo' WHERE payment_method = 'online';

ALTER TABLE public.membership_fees
  ADD CONSTRAINT membership_fees_payment_method_check
    CHECK (payment_method::text = ANY (ARRAY['venmo'::character varying, 'zelle'::character varying, 'cash'::character varying]::text[]));
ALTER TABLE public.membership_fees
  ALTER COLUMN payment_method SET DEFAULT 'cash'::character varying;

-- 4. membership_plans — single source of truth for prices; one row per plan
--    per academic year. Admin tool and Apps Script both read from here.
CREATE TABLE IF NOT EXISTS public.membership_plans (
  plan_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  academic_year character varying NOT NULL,
  plan character varying NOT NULL
    CHECK (plan::text = ANY (ARRAY['semester_1'::character varying, 'semester_2'::character varying, 'full_year'::character varying]::text[])),
  price numeric NOT NULL,
  UNIQUE (academic_year, plan)
);

-- Tables created via the dashboard's Table Editor get RLS enabled by default,
-- which silently hides all rows from the anon key (empty reads, blocked
-- writes). This project's security model is RLS off everywhere (see CLAUDE.md).
ALTER TABLE public.membership_plans DISABLE ROW LEVEL SECURITY;

-- 5. Late-signup pricing: full late price stored per plan row (not a +N rule
--    in code). A payment is late iff paid_date >= late_from. Null late_from
--    or late_price = no late pricing for that row.
ALTER TABLE public.membership_plans
  ADD COLUMN IF NOT EXISTS late_from date,
  ADD COLUMN IF NOT EXISTS late_price numeric;

-- 6. university_year: rename 'postgrad' → '5+' (drop the check constraint
--    first so the update isn't rejected by the old 'postgrad'-allowing rule,
--    then re-add it with '5+').
ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS members_university_year_check;

UPDATE public.members SET university_year = '5+' WHERE university_year = 'postgrad';

ALTER TABLE public.members
  ADD CONSTRAINT members_university_year_check
    CHECK (university_year::text = ANY (ARRAY['1st'::character varying, '2nd'::character varying, '3rd'::character varying, '4th'::character varying, '5+'::character varying]::text[]));

COMMIT;

-- Seed 2026-2027 prices: $15/semester, $25/full year, +$5 after Oct 3.
-- (Semester 2's cutoff can be moved later by editing its late_from.)
INSERT INTO public.membership_plans (academic_year, plan, price, late_from, late_price) VALUES
  ('2026-2027', 'semester_1', 15.00, '2026-10-03', 20.00),
  ('2026-2027', 'semester_2', 15.00, '2026-10-03', 20.00),
  ('2026-2027', 'full_year', 25.00, '2026-10-03', 30.00)
ON CONFLICT (academic_year, plan) DO UPDATE
  SET price = EXCLUDED.price, late_from = EXCLUDED.late_from, late_price = EXCLUDED.late_price;

-- ---------------------------------------------------------------------------
-- Annual seed template (edit values, run each academic year BEFORE the signup
-- form opens — fee inserts fail validity computation without period rows).
-- ---------------------------------------------------------------------------
-- INSERT INTO public.academic_periods (academic_year, semester, start_date, end_date) VALUES
--   ('2026-2027', 1, '2026-09-01', '2026-12-20'),
--   ('2026-2027', 2, '2027-01-10', '2027-05-15');
--
-- INSERT INTO public.membership_plans (academic_year, plan, price, late_from, late_price) VALUES
--   ('2027-2028', 'semester_1', 15.00, '2027-10-01', 20.00),
--   ('2027-2028', 'semester_2', 15.00, '2027-10-01', 20.00),
--   ('2027-2028', 'full_year', 25.00, '2027-10-01', 30.00);
