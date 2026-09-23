/* =====================================================================
   Pure business logic — fee status, validity computation, duplicate-fee
   detection. No DOM, no Supabase client, no globals besides what's passed
   in. Loaded as a plain <script> in club-admin.html (exposes window.Logic
   only — everything else stays scoped inside this IIFE so it can't
   collide with identically-named bindings in the main app script, which
   shares the same top-level scope across <script> tags) and required
   directly from Node tests (module.exports).
   ===================================================================== */
(function () {

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

/* =====================================================================
   Payment auto-verification matcher (pure core).

   Given the pending fees, their members, and the parsed receipt rows from
   the treasurer's ledger, return ONLY the high-confidence, unambiguous
   fee↔receipt pairs that are safe to auto-verify. Everything uncertain is
   left out and falls to the treasurer's manual queue.

   The Apps Script side (apps-script.gs) mirrors these functions so the
   sweep can run in that runtime, which can't require() this file. This is
   the tested canonical copy — keep the mirror textually in sync.
   ===================================================================== */

// Name tokens, folded for comparison: diacritics stripped, lowercased,
// anything non-alphabetic treated as a separator. "Núñez-Díaz" → [nunez,diaz].
function normalizeNameTokens(s) {
  return String(s == null ? "" : s)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z]+/g, " ")
    .trim().split(/\s+/).filter(Boolean);
}

// Name is a HINT, never identity (CLAUDE.md): require the member's first AND
// last name tokens to both appear in the payer string, order-independent and
// tolerant of extra middle names / "Last, First". Nicknames and misspellings
// deliberately fail here and fall to manual review rather than risk a false
// auto-verify. No fuzzy/edit-distance matching.
function nameTokensSubset(first, last, payerName) {
  const need = normalizeNameTokens(first + " " + last);
  if (need.length === 0) return false;
  const have = Object.create(null);
  normalizeNameTokens(payerName).forEach((t) => { have[t] = true; });
  return need.every((t) => have[t]);
}

// Currency compared with a half-cent tolerance to dodge float noise.
function amountsEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

function isoToUTC_(iso) {
  const parts = String(iso).slice(0, 10).split("-");
  return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}
function withinDays(isoA, isoB, n) {
  return Math.abs(isoToUTC_(isoA) - isoToUTC_(isoB)) / 86400000 <= n;
}

// Returns [{ fee_id, receipt_key, receipt }] for the confident matches only.
//   receipts: [{ method, date (ISO), amount (number), name, key }]
//   membersById: { [member_id]: { first_name, last_name } }
//   consumedKeys: receipt keys already used by a prior auto-verify (skipped)
// Confidence rule — all must hold, else the fee stays pending:
//   method matches, amount === expected membership_plans price (incl. late),
//   receipt date within opts.windowDays of paid_date, and the payer name
//   token-matches the member. Ambiguity in EITHER direction blocks the match:
//   a receipt that matches more than one fee is dropped from all of them, and
//   a fee is only auto-verified when exactly one receipt survives for it.
// Duplicate guard: a fee whose member has another pending/verified fee this year
//   (member_id in opts.duplicateMemberIds) is NEVER auto-verified — per CLAUDE.md,
//   the "already has a fee this year" cluster (double-submits, sem1→full_year
//   upgrades) is the treasurer's to resolve, not the matcher's. Those fees still
//   take part in the ambiguity computation below, so they keep blocking any
//   receipt they could plausibly claim.
function autoVerifyMatches(pendingFees, membersById, receipts, plans, consumedKeys, opts) {
  const windowDays = (opts && opts.windowDays != null) ? opts.windowDays : 45;
  const duplicateMembers = Object.create(null);
  ((opts && opts.duplicateMemberIds) || []).forEach((id) => { duplicateMembers[String(id)] = true; });
  const consumed = Object.create(null);
  (consumedKeys || []).forEach((k) => { consumed[k] = true; });

  const available = (receipts || []).filter(
    (r) => r && r.key && !consumed[r.key] && r.name && Number(r.amount) > 0
  );
  const matchCount = new Map();
  const feeCandidates = new Map();

  (pendingFees || []).forEach((fee) => {
    const member = membersById[fee.member_id];
    if (!member) return;
    const expected = planPrice(fee.academic_year, fee.plan, fee.paid_date, plans);
    if (expected == null) return;
    const cands = available.filter(
      (r) =>
        r.method === fee.payment_method &&
        amountsEqual(r.amount, expected) &&
        withinDays(r.date, fee.paid_date, windowDays) &&
        nameTokensSubset(member.first_name, member.last_name, r.name)
    );
    feeCandidates.set(fee.fee_id, cands);
    cands.forEach((r) => matchCount.set(r, (matchCount.get(r) || 0) + 1));
  });

  const result = [];
  (pendingFees || []).forEach((fee) => {
    if (duplicateMembers[String(fee.member_id)]) return; // treasurer resolves duplicates
    const cands = (feeCandidates.get(fee.fee_id) || []).filter((r) => matchCount.get(r) === 1);
    if (cands.length === 1) {
      result.push({ fee_id: fee.fee_id, receipt_key: cands[0].key, receipt: cands[0] });
    }
  });
  return result;
}

const Logic = {
  idEq, todayISO, isFeeActive, feeRowStatus, computeValidity, planPrice, hasOtherFeeThisYear,
  normalizeNameTokens, nameTokensSubset, amountsEqual, withinDays, autoVerifyMatches,
};

if (typeof module === "object" && module.exports) {
  module.exports = Logic;
} else {
  (typeof self !== "undefined" ? self : this).Logic = Logic;
}

})();
