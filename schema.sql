-- Club Admin database schema
-- Derived from schema.txt (Supabase/Postgres). Runnable as-is: sequences are
-- replaced with GENERATED ALWAYS AS IDENTITY and tables are ordered so that
-- every foreign key references a table already created above it.

CREATE TABLE public.academic_periods (
  period_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  academic_year character varying NOT NULL,
  semester integer NOT NULL CHECK (semester = ANY (ARRAY[1, 2])),
  start_date date NOT NULL,
  end_date date NOT NULL
);

CREATE TABLE public.fams (
  fam_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name character varying NOT NULL UNIQUE,
  description text,
  color character varying
);

CREATE TABLE public.members (
  member_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  first_name character varying NOT NULL,
  last_name character varying NOT NULL,
  email character varying NOT NULL UNIQUE,
  gender character varying CHECK (gender::text = ANY (ARRAY['male'::character varying, 'female'::character varying, 'other'::character varying, 'prefer_not_to_say'::character varying]::text[])),
  university_year character varying CHECK (university_year::text = ANY (ARRAY['1st'::character varying, '2nd'::character varying, '3rd'::character varying, '4th'::character varying, '5+'::character varying]::text[])),
  role character varying DEFAULT 'member'::character varying CHECK (role::text = ANY (ARRAY['member'::character varying, 'president'::character varying, 'vice_president'::character varying, 'vp_finance'::character varying, 'vp_marketing'::character varying, 'vp_operations'::character varying, 'vp_events'::character varying, 'vp_mentorship'::character varying, 'vp_careers'::character varying, 'events_committee'::character varying, 'fams_committee'::character varying, 'skip_committee'::character varying, 'marketing_committee'::character varying]::text[])),
  joined_date date NOT NULL DEFAULT CURRENT_DATE,
  is_active boolean DEFAULT true,
  notes text,
  discord_username text,
  student_id text UNIQUE
);

CREATE TABLE public.membership_fees (
  fee_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id integer NOT NULL REFERENCES public.members(member_id),
  academic_year character varying NOT NULL,
  plan character varying NOT NULL CHECK (plan::text = ANY (ARRAY['semester_1'::character varying, 'semester_2'::character varying, 'full_year'::character varying]::text[])),
  amount_paid numeric NOT NULL,
  paid_date date NOT NULL DEFAULT CURRENT_DATE,
  valid_from date NOT NULL,
  valid_until date NOT NULL,
  payment_method character varying DEFAULT 'cash'::character varying CHECK (payment_method::text = ANY (ARRAY['venmo'::character varying, 'zelle'::character varying, 'cash'::character varying]::text[])),
  status character varying NOT NULL DEFAULT 'pending' CHECK (status::text = ANY (ARRAY['pending'::character varying, 'verified'::character varying, 'rejected'::character varying]::text[])),
  screenshot_url text,
  verified_at date,
  verification_source text CHECK (verification_source IS NULL OR verification_source IN ('auto', 'manual')),
  auto_match_ref text
);

-- Single source of truth for prices; one row per plan per academic year.
-- Late pricing: a payment is late iff paid_date >= late_from; it then costs
-- late_price (stored as the full amount, not a surcharge). Nulls = no late tier.
CREATE TABLE public.membership_plans (
  plan_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  academic_year character varying NOT NULL,
  plan character varying NOT NULL CHECK (plan::text = ANY (ARRAY['semester_1'::character varying, 'semester_2'::character varying, 'full_year'::character varying]::text[])),
  price numeric NOT NULL,
  late_from date,
  late_price numeric,
  UNIQUE (academic_year, plan)
);

CREATE TABLE public.fam_memberships (
  fam_membership_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id integer NOT NULL REFERENCES public.members(member_id),
  fam_id integer NOT NULL REFERENCES public.fams(fam_id),
  joined_date date NOT NULL DEFAULT CURRENT_DATE,
  fam_role character varying DEFAULT 'member'::character varying CHECK (fam_role::text = ANY (ARRAY['member'::character varying, 'fam_leader'::character varying, 'co_leader'::character varying]::text[])),
  assignment_method character varying DEFAULT 'selected'::character varying CHECK (assignment_method::text = ANY (ARRAY['selected'::character varying, 'requested'::character varying, 'transferred'::character varying]::text[])),
  is_current boolean DEFAULT true
);
