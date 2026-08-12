/* =====================================================================
   Pure business logic — fee status, validity computation, duplicate-fee
   detection. No DOM, no Supabase client, no globals besides what's passed
   in. Loaded as a plain <script> in club-admin.html (exposes window.Logic)
   and required directly from Node tests (module.exports).
   ===================================================================== */

// All IDs compared via String() so int / bigint / uuid columns all work,
// whether the value originates from the DB (typed) or a DOM dataset (string).
function idEq(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// A fee counts toward active membership iff status = 'verified' AND
// valid_until >= today. Never stored as a flag; always computed.
function isFeeActive(member, fees) {
  const today = todayISO();
  return fees
    .filter((f) => idEq(f.member_id, member.member_id))
    .some((f) => f.status === "verified" && f.valid_until && f.valid_until >= today);
}

// Per-row status, evaluated in fixed order: rejected → pending → verified/expired.
// Pending never shows as Expired, even if its dates have lapsed.
function feeRowStatus(f) {
  if (f.status === "rejected") return "rejected";
  if (f.status === "pending") return "pending";
  return f.valid_until && f.valid_until >= todayISO() ? "active" : "expired";
}

function computeValidity(academicYear, plan, academicPeriods) {
  const sem1 = academicPeriods.find((p) => p.academic_year === academicYear && p.semester === 1);
  const sem2 = academicPeriods.find((p) => p.academic_year === academicYear && p.semester === 2);
  if (plan === "semester_1") {
    if (!sem1) return null;
    return { valid_from: sem1.start_date, valid_until: sem1.end_date };
  }
  if (plan === "semester_2") {
    if (!sem2) return null;
    return { valid_from: sem2.start_date, valid_until: sem2.end_date };
  }
  if (plan === "full_year") {
    if (!sem1 || !sem2) return null;
    return { valid_from: sem1.start_date, valid_until: sem2.end_date };
  }
  return null;
}

// Price list lookup — returns null if no membership_plans row exists for the
// pair. Late pricing keys off the actual paid date (not verification time):
// paid_date >= late_from → late_price.
function planPrice(academicYear, plan, paidDate, membershipPlans) {
  const row = membershipPlans.find((p) => p.academic_year === academicYear && p.plan === plan);
  if (!row) return null;
  const late = row.late_from && row.late_price != null && paidDate && paidDate >= row.late_from;
  return Number(late ? row.late_price : row.price);
}

// True when the member has another pending/verified fee row for the same
// academic year — the "double-submit / plan upgrade" flag from CLAUDE.md.
function hasOtherFeeThisYear(fee, allFees) {
  return allFees.some((f) =>
    !idEq(f.fee_id, fee.fee_id) &&
    idEq(f.member_id, fee.member_id) &&
    f.academic_year === fee.academic_year &&
    (f.status === "pending" || f.status === "verified")
  );
}

const Logic = { idEq, todayISO, isFeeActive, feeRowStatus, computeValidity, planPrice, hasOtherFeeThisYear };

if (typeof module === "object" && module.exports) {
  module.exports = Logic;
} else {
  (typeof self !== "undefined" ? self : this).Logic = Logic;
}
