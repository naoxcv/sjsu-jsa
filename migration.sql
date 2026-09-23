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

-- 7. members.role — add committee roles (rank-and-file committee membership,
--    coexisting with the existing vp_* leadership roles). No existing rows
--    are affected, only the allowed set is widened, so no UPDATE needed
--    before the constraint swap.
ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS members_role_check;

ALTER TABLE public.members
  ADD CONSTRAINT members_role_check
    CHECK (role::text = ANY (ARRAY['member'::character varying, 'president'::character varying, 'vice_president'::character varying, 'vp_finance'::character varying, 'vp_marketing'::character varying, 'vp_operations'::character varying, 'vp_events'::character varying, 'vp_mentorship'::character varying, 'vp_careers'::character varying, 'events_committee'::character varying, 'fams_committee'::character varying, 'skip_committee'::character varying, 'marketing_committee'::character varying]::text[]));

-- 8. Payment auto-verification audit trail. A fee auto-verified from the
--    treasurer's ledger records when, that it was automatic, and which receipt
--    it matched (auto_match_ref = the content-hash key of that ledger row).
--    auto_match_ref doubles as the idempotency marker: the sweep loads all
--    existing keys and never re-uses a receipt. verification_source is 'auto'
--    or 'manual' (null on pre-existing/mock rows).
ALTER TABLE public.membership_fees
  ADD COLUMN IF NOT EXISTS verified_at date,
  ADD COLUMN IF NOT EXISTS verification_source text,
  ADD COLUMN IF NOT EXISTS auto_match_ref text;

ALTER TABLE public.membership_fees
  DROP CONSTRAINT IF EXISTS membership_fees_verification_source_check;
ALTER TABLE public.membership_fees
  ADD CONSTRAINT membership_fees_verification_source_check
    CHECK (verification_source IS NULL OR verification_source IN ('auto', 'manual'));

-- 9. Drop UNIQUE (member_id, academic_year, plan). It contradicted the
--    documented duplicate handling: a repeat/upgrade/re-signup submission is
--    meant to insert another pending fee that the treasurer reconciles in the
--    pending queue, not fail at the DB. The constraint ignored status, so it
--    also blocked a legitimate resubmission after a prior fee was rejected.
--    (Was dropped directly on the live DB; recorded here so replays match. Never
--    existed in schema.sql, so from-scratch builds were already correct.)
ALTER TABLE public.membership_fees
  DROP CONSTRAINT IF EXISTS membership_fees_member_id_academic_year_plan_key;

COMMIT;

-- Seed 2026-2027 prices: $15/semester, $25/full year, +$5 late.
-- late_from is the FIRST day the late price applies (inclusive: paid_date >=
-- late_from is late). On-time deadline is 9/18, so late starts 9/19 — set
-- late_from to the day AFTER the deadline, not the deadline itself.
-- (Semester 2's cutoff can be moved later by editing its late_from.)
INSERT INTO public.membership_plans (academic_year, plan, price, late_from, late_price) VALUES
  ('2026-2027', 'semester_1', 15.00, '2026-09-19', 20.00),
  ('2026-2027', 'semester_2', 15.00, '2026-09-19', 20.00),
  ('2026-2027', 'full_year', 25.00, '2026-09-19', 30.00)
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
