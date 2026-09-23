/**
 * JSA membership signup — Google Apps Script bridge (Form responses → Supabase).
 *
 * MOCK / NOT YET DEPLOYED: the Google Form doesn't exist yet, so the column
 * titles in FORM_FIELDS below must be checked against the real form once it's
 * built. Everything else follows the agreed spec in CLAUDE.md.
 *
 * Setup (once, on the shared officer account):
 *  1. Open the form's response Sheet → Extensions → Apps Script, paste this file.
 *  2. Project Settings → Script Properties, add:
 *       SUPABASE_URL       e.g. https://xxxx.supabase.co
 *       SUPABASE_ANON_KEY  the anon key (never in script source)
 *       ACADEMIC_YEAR      e.g. 2026-2027  (update at annual rollover)
 *       LEDGER_SHEET_ID    the finance ledger spreadsheet ID (from its URL)
 *       LEDGER_TAB         the ledger tab name, e.g. Cashflow F26
 *                          (LEDGER_* only needed for the payment auto-verify sweep)
 *  3. Triggers → Add trigger: onFormSubmit, event source "From spreadsheet",
 *     event type "On form submit".
 *  4. Ensure a sheet tab named "Errors" exists (created automatically otherwise).
 *
 * Behavior per submission (see CLAUDE.md "Identity & duplicates"):
 *  - student_id not found        → insert member + pending fee row
 *  - found, no fee this year     → insert pending fee only; set is_active = true
 *  - found, fee already this year→ insert pending fee anyway; the admin tool's
 *                                  pending queue flags it as a duplicate
 *  - member contact info is NEVER auto-updated from resubmissions
 *  - failures are logged to the "Errors" tab; no email plumbing
 */

/* ---------- Form question titles → response mapping ----------
   MUST match the real form's question titles exactly. Y/N interest questions
   are deliberately absent: they stay in the Sheet only. */
var FORM_FIELDS = {
  firstName: "First name",
  lastName: "Last name",
  discord: "Discord username",
  email: "Email",
  studentId: "Student ID",
  gender: "Gender",
  universityYear: "University year",
  plan: "Membership plan",
  paymentMethod: "Payment method",
  screenshot: "Payment screenshot",
};

/* Form labels → DB enum values */
var PLAN_MAP = {
  "Semester 1": "semester_1",
  "Semester 2": "semester_2",
  "Full Year": "full_year",
};
var PAYMENT_MAP = {
  "Venmo": "venmo",
  "Zelle": "zelle",
  "Cash": "cash",
};
var YEAR_MAP = {
  "1st": "1st", "2nd": "2nd", "3rd": "3rd", "4th": "4th", "5+": "5+",
};
var GENDER_MAP = {
  "Male": "male",
  "Female": "female",
  "Other": "other",
  "Prefer not to say": "prefer_not_to_say",
};

/* ---------- Payment auto-verification (treasurer ledger sweep) ----------
   Reads the treasurer's finance ledger (READ-ONLY — the sweep never writes to
   it) and auto-verifies pending fees against confident receipt matches. All
   idempotency state lives in Supabase (membership_fees.auto_match_ref), so the
   sweep can be re-run safely.

   The ledger tab holds three stacked tables in columns A-D, top to bottom:
   Venmo, then Zelle, then Cash. Each table ends in a running-sum row (a cell
   reading "Funds"). Columns: A = date (M/D/YYYY), B = amount, C = payer name,
   D = message. A treasurer-recorded cash row IS official, so cash is matched
   too; cash rows sometimes carry only a first name (see FIRST_NAME_ONLY_METHODS).

   The ledger spreadsheet ID and tab name live in Script Properties
   (LEDGER_SHEET_ID, LEDGER_TAB), not here — same as the Supabase creds — so
   they stay out of the source and can change without editing code. */
var MATCH_METHODS = ["venmo", "zelle", "cash"];
var FIRST_NAME_ONLY_METHODS = ["cash"];      // methods where a first-name-only payer may match
var MATCH_WINDOW_DAYS = 45;                   // receipt must be within N days of the form's paid_date

function onFormSubmit(e) {
  try {
    var row = valuesByTitle_(e);

    var studentId = String(row[FORM_FIELDS.studentId] || "").trim();
    if (!studentId) throw new Error("Submission has no student ID");

    var academicYear = prop_("ACADEMIC_YEAR");
    var plan = requireMap_(PLAN_MAP, row[FORM_FIELDS.plan], "plan");
    var method = requireMap_(PAYMENT_MAP, row[FORM_FIELDS.paymentMethod], "payment method");
    var year = requireMap_(YEAR_MAP, row[FORM_FIELDS.universityYear], "university year");
    var gender = requireMap_(GENDER_MAP, row[FORM_FIELDS.gender], "gender");

    var paidDate = toISODate_(new Date()); // submission timestamp
    var validity = computeValidity_(academicYear, plan);      // throws if periods missing
    var price = planPrice_(academicYear, plan, paidDate);     // throws if plans missing
    var screenshotUrl = driveUrl_(row[FORM_FIELDS.screenshot]);

    // --- Branch on student_id ---
    var existing = sbGet_("members", { student_id: "eq." + studentId });
    var memberId;

    if (existing.length === 0) {
      var inserted = sbInsert_("members", {
        first_name: String(row[FORM_FIELDS.firstName] || "").trim(),
        last_name: String(row[FORM_FIELDS.lastName] || "").trim(),
        email: String(row[FORM_FIELDS.email] || "").trim(),
        discord_username: String(row[FORM_FIELDS.discord] || "").trim() || null,
        student_id: studentId,
        university_year: year,
        gender: gender,
        joined_date: paidDate,
        is_active: true,
        // role defaults to 'member'; notes stays null
      });
      memberId = inserted[0].member_id;
    } else {
      memberId = existing[0].member_id;
      // Re-signup is a clear "I'm back" signal — the ONLY automated is_active write.
      sbPatch_("members", { member_id: "eq." + memberId }, { is_active: true });
      // Contact info intentionally not touched: the resubmission might be the mistake.
    }

    // Fee row is always inserted as pending — duplicates included; the admin
    // tool's pending queue flags "already has a fee this year" for the treasurer.
    var insertedFee = sbInsert_("membership_fees", {
      member_id: memberId,
      academic_year: academicYear,
      plan: plan,
      amount_paid: price,          // treasurer can edit at verification
      paid_date: paidDate,         // ditto
      valid_from: validity.valid_from,
      valid_until: validity.valid_until,
      payment_method: method,
      status: "pending",
      screenshot_url: screenshotUrl,
    })[0];

    // Best-effort auto-verify against a confident ledger match. Isolated so a
    // ledger/matching hiccup NEVER fails the submission — the pending row is
    // already saved and the treasurer queue always catches the rest.
    try {
      tryAutoVerifyFee_(insertedFee, academicYear);
    } catch (autoErr) {
      sweepLog_("onFormSubmit auto-verify skipped for fee " +
        (insertedFee && insertedFee.fee_id) + ": " + (autoErr && autoErr.message ? autoErr.message : autoErr));
    }
  } catch (err) {
    logError_(e, err);
  }
}

// Auto-verify a single just-inserted fee, if it has a confident, unambiguous
// ledger match. Runs the matcher over all pending fees (so the ambiguity guard
// is complete) but only ever commits the one fee we just created. No-op when
// the ledger isn't configured, so the hook stays dormant until LEDGER_* are set.
function tryAutoVerifyFee_(fee, academicYear) {
  if (!fee || !ledgerConfigured_()) return;
  var res = computeAutoMatches_(academicYear);
  var mine = res.matches.filter(function (m) { return idEq_(m.fee_id, fee.fee_id); })[0];
  if (!mine) return; // no confident match → stays pending for the treasurer
  if (applyAutoVerify_(mine.fee_id, mine.receipt_key)) {
    var m = res.membersById[fee.member_id] || {};
    sweepLog_("onFormSubmit auto-verified fee " + mine.fee_id + " (" +
      (m.first_name || "?") + " " + (m.last_name || "?") + ") ← " + mine.receipt_key);
  }
}

function ledgerConfigured_() {
  var p = PropertiesService.getScriptProperties();
  return !!(p.getProperty("LEDGER_SHEET_ID") && p.getProperty("LEDGER_TAB"));
}

/* ---------- Sweep entry points (run from the Apps Script editor) ----------
   sweepDryRun  — logs what WOULD be auto-verified; writes nothing.
   sweepApply   — actually verifies the confident matches.
   Both log to the "Sweep Log" tab of the form-response spreadsheet. */
function sweepDryRun() { sweepAutoVerify_(false); }
function sweepApply() { sweepAutoVerify_(true); }

function sweepAutoVerify_(apply) {
  var academicYear = prop_("ACADEMIC_YEAR");
  var res = computeAutoMatches_(academicYear);
  if (res.pending.length === 0) { sweepLog_("No pending fees for " + academicYear + "."); return; }

  sweepLog_((apply ? "APPLY" : "DRY RUN") + ": " + res.pending.length + " pending, " +
    res.receiptCount + " receipts, " + res.matches.length + " confident match(es).");

  res.matches.forEach(function (m) {
    var member = res.membersById[res.pending.filter(function (f) { return idEq_(f.fee_id, m.fee_id); })[0].member_id];
    var who = member ? (member.first_name + " " + member.last_name) : "?";
    if (!apply) {
      sweepLog_("  would verify fee " + m.fee_id + " (" + who + ") ← " + m.receipt_key);
      return;
    }
    if (applyAutoVerify_(m.fee_id, m.receipt_key)) {
      sweepLog_("  verified fee " + m.fee_id + " (" + who + ") ← " + m.receipt_key);
    } else {
      sweepLog_("  skipped fee " + m.fee_id + " (no longer pending)");
    }
  });

  if (!apply && res.matches.length > 0) sweepLog_("Run sweepApply() to commit these.");
}

// Shared setup for the sweep and the onFormSubmit hook: fetch fees/members/
// plans, read the ledger, and run the matcher over ALL pending fees so the
// cross-member ambiguity guard sees the full picture. Returns the confident
// matches plus the context needed to log/apply them.
function computeAutoMatches_(academicYear) {
  var allFees = sbGet_("membership_fees", { academic_year: "eq." + academicYear });
  var pending = allFees.filter(function (f) { return f.status === "pending"; });
  if (pending.length === 0) return { matches: [], pending: [], membersById: {}, receiptCount: 0 };

  var memberIds = allFees
    .map(function (f) { return f.member_id; })
    .filter(function (v, i, a) { return a.indexOf(v) === i; });
  var members = sbGet_("members", { member_id: "in.(" + memberIds.join(",") + ")" });
  var membersById = {};
  members.forEach(function (m) { membersById[m.member_id] = m; });

  var plans = sbGet_("membership_plans", { academic_year: "eq." + academicYear });
  var receipts = readLedgerReceipts_();
  var usedMap = usedReceiptKeys_(allFees, membersById, receipts, plans);

  var matches = autoVerifyMatches_(pending, membersById, receipts, plans, Object.keys(usedMap), {
    windowDays: MATCH_WINDOW_DAYS,
    firstNameOnlyMethods: FIRST_NAME_ONLY_METHODS,
  });
  return { matches: matches, pending: pending, membersById: membersById, receiptCount: receipts.length };
}

// Idempotent verify: only flips a row that is STILL pending. return=representation
// means 0 rows back = another process already verified it. Returns true if we
// flipped it.
function applyAutoVerify_(feeId, receiptKey) {
  var updated = sbPatchReturning_("membership_fees",
    { fee_id: "eq." + feeId, status: "eq.pending" },
    { status: "verified", verified_at: toISODate_(new Date()),
      verification_source: "auto", auto_match_ref: receiptKey });
  return updated.length > 0;
}

/* ---------- Diagnose why pending fees did NOT auto-verify ----------
   Read-only. Classifies every still-pending fee into an actionable reason and
   logs a per-fee line plus a summary tally to the "Sweep Log" tab. */
function sweepDiagnose() { sweepDiagnose_(); }

function sweepDiagnose_() {
  var academicYear = prop_("ACADEMIC_YEAR");
  var allFees = sbGet_("membership_fees", { academic_year: "eq." + academicYear });
  var pending = allFees.filter(function (f) { return f.status === "pending"; });
  if (pending.length === 0) { sweepLog_("Diagnose: no pending fees."); return; }

  // Members for ALL fees, so used-receipt inference can see verified members too.
  var memberIds = allFees
    .map(function (f) { return f.member_id; })
    .filter(function (v, i, a) { return a.indexOf(v) === i; });
  var members = sbGet_("members", { member_id: "in.(" + memberIds.join(",") + ")" });
  var membersById = {};
  members.forEach(function (m) { membersById[m.member_id] = m; });

  var plans = sbGet_("membership_plans", { academic_year: "eq." + academicYear });
  var receipts = readLedgerReceipts_();

  // Receipt key → the verified fee already accounting for it (auto + hand-verified).
  var consumedBy = usedReceiptKeys_(allFees, membersById, receipts, plans);

  var tally = {};
  sweepLog_("── DIAGNOSE " + pending.length + " pending (" + academicYear + ") ──");
  pending.forEach(function (fee) {
    var m = membersById[fee.member_id] || {};
    var who = (m.first_name || "?") + " " + (m.last_name || "?");
    var expected = planPriceLocal_(fee.academic_year, fee.plan, fee.paid_date, plans);
    var r = diagnoseFee_(fee, m, expected, receipts, allFees, consumedBy);
    tally[r.code] = (tally[r.code] || 0) + 1;
    sweepLog_("  [" + r.code + "] fee " + fee.fee_id + " " + who + " · " + fee.plan +
      " · " + fee.payment_method + " · exp $" + (expected == null ? "?" : expected) +
      " — " + r.detail);
  });
  var sum = Object.keys(tally).sort().map(function (k) { return k + "=" + tally[k]; }).join(", ");
  sweepLog_("── Summary: " + sum + " ──");
}

// Returns { code, detail } explaining why one pending fee didn't auto-verify.
function diagnoseFee_(fee, member, expected, receipts, allFees, consumedBy) {
  var dup = allFees.filter(function (f) {
    return !idEq_(f.fee_id, fee.fee_id) && idEq_(f.member_id, fee.member_id) && f.status === "verified";
  });
  if (dup.length) return { code: "DUPLICATE", detail: "member already verified via fee " + dup[0].fee_id };

  if (expected == null) return { code: "NO_PRICE", detail: "no membership_plans row for " + fee.plan };

  var fnOnly = FIRST_NAME_ONLY_METHODS;
  var methodRx = receipts.filter(function (r) { return r.method === fee.payment_method; });
  if (!methodRx.length) return { code: "NO_RECEIPT", detail: "no " + fee.payment_method + " rows in ledger" };

  var nameRx = methodRx.filter(function (r) {
    return nameMatches_(member.first_name, member.last_name, r.name, r.method, fnOnly);
  });
  var nameAmt = nameRx.filter(function (r) { return amountsEqual_(r.amount, expected); });
  var nameAmtWin = nameAmt.filter(function (r) { return withinDays_(r.date, fee.paid_date, MATCH_WINDOW_DAYS); });

  if (nameAmtWin.length) {
    var fresh = nameAmtWin.filter(function (r) { return !consumedBy[r.key]; });
    if (!fresh.length) {
      return { code: "RECEIPT_USED", detail: "matching receipt already used by fee " +
        consumedBy[nameAmtWin[0].key] + " (likely a duplicate submission)" };
    }
    return { code: "AMBIGUOUS", detail: nameAmtWin.length +
      " candidate receipt(s) sharing this name/amount — needs a manual pick" };
  }
  if (nameAmt.length) {
    return { code: "DATE_WINDOW", detail: "name+amount match but receipt " + nameAmt[0].date +
      " is >" + MATCH_WINDOW_DAYS + "d from paid_date " + fee.paid_date };
  }
  if (nameRx.length) {
    var amts = nameRx.slice(0, 3).map(function (r) { return "$" + r.amount; }).join(", ");
    return { code: "AMOUNT", detail: "payer name found but amount off: ledger " + amts +
      " vs expected $" + expected + " (under/over-payment?)" };
  }
  var amtWin = methodRx.filter(function (r) {
    return amountsEqual_(r.amount, expected) && withinDays_(r.date, fee.paid_date, MATCH_WINDOW_DAYS) && !consumedBy[r.key];
  });
  if (amtWin.length) {
    var names = amtWin.slice(0, 3).map(function (r) { return r.name; }).join("; ");
    return { code: "NAME", detail: "amount matches but no name match — paid under a different name? " + names };
  }
  return { code: "NO_RECEIPT", detail: "no " + fee.payment_method + " receipt near $" +
    expected + " within " + MATCH_WINDOW_DAYS + "d of " + fee.paid_date };
}

// Parse the ledger's stacked inflow tables into normalized receipt rows.
// READ-ONLY. Segments Venmo/Zelle/Cash by the "Funds" running-sum rows; only
// rows whose method is in MATCH_METHODS are returned.
function readLedgerReceipts_() {
  var ledgerId = prop_("LEDGER_SHEET_ID");
  var ledgerTab = prop_("LEDGER_TAB");
  var ss = SpreadsheetApp.openById(ledgerId);
  var sh = ss.getSheetByName(ledgerTab);
  if (!sh) throw new Error("Ledger tab not found: '" + ledgerTab + "' in " + ledgerId);
  var last = sh.getLastRow();
  if (last < 1) return [];
  var vals = sh.getRange(1, 1, last, 4).getValues(); // columns A-D

  var methods = ["venmo", "zelle", "cash"];
  var idx = 0;
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (isSummaryRow_(row)) { idx++; continue; }      // "Funds ..." ends a table
    if (idx >= methods.length) break;                  // past the cash table
    var method = methods[idx];
    if (MATCH_METHODS.indexOf(method) < 0) continue;   // skip cash rows

    var d = toDate_(row[0]);
    if (!d) continue;                                   // header/label/blank row
    var amount = parseAmount_(row[1]);
    if (!(amount > 0)) continue;
    var name = String(row[2] == null ? "" : row[2]).trim();
    if (!name) continue;

    var dateIso = toISODate_(d);
    out.push({
      method: method,
      date: dateIso,
      amount: amount,
      name: name,
      key: receiptKey_(method, dateIso, amount, name),
    });
  }
  return out;
}

// A running-sum row carries the word "Funds" (or "Total") in some cell.
function isSummaryRow_(row) {
  for (var i = 0; i < row.length; i++) {
    var s = String(row[i] == null ? "" : row[i]).trim().toLowerCase();
    if (s === "funds" || s.indexOf("funds") === 0 || s === "total") return true;
  }
  return false;
}

function toDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v == null ? "" : v).trim();
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseAmount_(v) {
  if (typeof v === "number") return v;
  return Number(String(v == null ? "" : v).replace(/[^0-9.]/g, ""));
}

// Content-hash key: stable across row inserts (no row index), and identical
// rows collapse to one key — which the matcher treats as ambiguous anyway.
function receiptKey_(method, dateIso, amount, name) {
  return method + "|" + dateIso + "|" + Number(amount).toFixed(2) + "|" +
    normalizeNameTokens_(name).join(" ");
}

// Map of ledger receipt key → the verified fee that already accounts for it.
// Two sources: the explicit auto_match_ref stamped by prior sweeps, PLUS keys
// inferred by matching every verified fee against the ledger — the latter
// covers treasurer hand-verifications, which don't stamp auto_match_ref. This
// keeps the sweep from re-using an already-credited payment (e.g. on a
// duplicate submission) and keeps the diagnostic from offering used rows as
// candidates. Inference is name-bounded, so it can only over-reserve a row for
// the person it names — the safe direction (a missed auto-match stays manual).
function usedReceiptKeys_(allFees, membersById, receipts, plans) {
  var used = {};
  allFees.forEach(function (f) { if (f.auto_match_ref) used[f.auto_match_ref] = f.fee_id; });
  allFees.forEach(function (fee) {
    if (fee.status !== "verified") return;
    var m = membersById[fee.member_id];
    if (!m) return;
    var expected = planPriceLocal_(fee.academic_year, fee.plan, fee.paid_date, plans);
    if (expected == null) return;
    receipts.forEach(function (r) {
      if (used[r.key]) return;
      if (r.method === fee.payment_method &&
          amountsEqual_(r.amount, expected) &&
          withinDays_(r.date, fee.paid_date, MATCH_WINDOW_DAYS) &&
          nameMatches_(m.first_name, m.last_name, r.name, r.method, FIRST_NAME_ONLY_METHODS)) {
        used[r.key] = fee.fee_id;
      }
    });
  });
  return used;
}

function sweepLog_(msg) {
  Logger.log(msg);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName("Sweep Log") || ss.insertSheet("Sweep Log");
  tab.appendRow([new Date(), msg]);
}

/* ---------- Auto-verify matcher (MIRROR of logic.js) ----------
   Keep textually in sync with logic.js — that copy is unit-tested; this one
   runs in Apps Script, which can't require() it. planPriceLocal_ mirrors
   logic.js planPrice (array lookup); the existing planPrice_ does its own
   network fetch and is used only by onFormSubmit. */
function normalizeNameTokens_(s) {
  return String(s == null ? "" : s)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z]+/g, " ")
    .trim().split(/\s+/).filter(function (t) { return t; });
}
function nameTokensSubset_(first, last, payerName) {
  var need = normalizeNameTokens_(first + " " + last);
  if (need.length === 0) return false;
  var have = {};
  normalizeNameTokens_(payerName).forEach(function (t) { have[t] = true; });
  return need.every(function (t) { return have[t]; });
}
function nameMatches_(first, last, payerName, method, firstNameOnlyMethods) {
  var need = normalizeNameTokens_(first + " " + last);
  var have = normalizeNameTokens_(payerName);
  if (need.length === 0 || have.length === 0) return false;
  var haveSet = {};
  have.forEach(function (t) { haveSet[t] = true; });
  if (need.every(function (t) { return haveSet[t]; })) return true;
  if ((firstNameOnlyMethods || []).indexOf(method) >= 0) {
    var needSet = {};
    need.forEach(function (t) { needSet[t] = true; });
    if (haveSet[need[0]] && have.every(function (t) { return needSet[t]; })) return true;
  }
  return false;
}
function amountsEqual_(a, b) { return Math.abs(Number(a) - Number(b)) < 0.005; }
function isoToUTC__(iso) {
  var p = String(iso).slice(0, 10).split("-");
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
function withinDays_(a, b, n) { return Math.abs(isoToUTC__(a) - isoToUTC__(b)) / 86400000 <= n; }
function planPriceLocal_(academicYear, plan, paidDate, plans) {
  var row = plans.filter(function (p) {
    return p.academic_year === academicYear && p.plan === plan;
  })[0];
  if (!row) return null;
  var late = row.late_from && row.late_price != null && paidDate && paidDate >= row.late_from;
  return Number(late ? row.late_price : row.price);
}
function idEq_(a, b) {
  return a != null && b != null && String(a) === String(b);
}
function autoVerifyMatches_(pendingFees, membersById, receipts, plans, consumedKeys, opts) {
  var windowDays = (opts && opts.windowDays != null) ? opts.windowDays : 45;
  var firstNameOnlyMethods = (opts && opts.firstNameOnlyMethods) || ["cash"];
  var consumed = {};
  (consumedKeys || []).forEach(function (k) { consumed[k] = true; });

  var available = (receipts || []).filter(function (r) {
    return r && r.key && !consumed[r.key] && r.name && Number(r.amount) > 0;
  });
  available.forEach(function (r, i) { r.__i = i; });
  var counts = available.map(function () { return 0; });
  var feeCand = {};

  (pendingFees || []).forEach(function (fee) {
    var member = membersById[fee.member_id];
    if (!member) return;
    var expected = planPriceLocal_(fee.academic_year, fee.plan, fee.paid_date, plans);
    if (expected == null) return;
    var cands = available.filter(function (r) {
      return r.method === fee.payment_method &&
        amountsEqual_(r.amount, expected) &&
        withinDays_(r.date, fee.paid_date, windowDays) &&
        nameMatches_(member.first_name, member.last_name, r.name, r.method, firstNameOnlyMethods);
    });
    feeCand[fee.fee_id] = cands;
    cands.forEach(function (r) { counts[r.__i]++; });
  });

  var result = [];
  (pendingFees || []).forEach(function (fee) {
    var cands = (feeCand[fee.fee_id] || []).filter(function (r) { return counts[r.__i] === 1; });
    if (cands.length === 1) {
      result.push({ fee_id: fee.fee_id, receipt_key: cands[0].key, receipt: cands[0] });
    }
  });
  return result;
}

/* ---------- Supabase REST helpers ---------- */

function sbHeaders_() {
  var key = prop_("SUPABASE_ANON_KEY");
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  };
}

function sbGet_(table, filters) {
  var qs = Object.keys(filters).map(function (k) {
    return encodeURIComponent(k) + "=" + encodeURIComponent(filters[k]);
  }).join("&");
  var resp = UrlFetchApp.fetch(prop_("SUPABASE_URL") + "/rest/v1/" + table + "?" + qs, {
    headers: sbHeaders_(),
    muteHttpExceptions: true,
  });
  return parseOrThrow_(resp, "GET " + table);
}

function sbInsert_(table, body) {
  var headers = sbHeaders_();
  headers.Prefer = "return=representation";
  var resp = UrlFetchApp.fetch(prop_("SUPABASE_URL") + "/rest/v1/" + table, {
    method: "post",
    headers: headers,
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  return parseOrThrow_(resp, "INSERT " + table);
}

function sbPatch_(table, filters, body) {
  var qs = Object.keys(filters).map(function (k) {
    return encodeURIComponent(k) + "=" + encodeURIComponent(filters[k]);
  }).join("&");
  var resp = UrlFetchApp.fetch(prop_("SUPABASE_URL") + "/rest/v1/" + table + "?" + qs, {
    method: "patch",
    headers: sbHeaders_(),
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  return parseOrThrow_(resp, "PATCH " + table);
}

// Like sbPatch_ but asks PostgREST to return the affected rows, so the caller
// can tell whether the filter actually matched anything (0 rows = lost a race).
function sbPatchReturning_(table, filters, body) {
  var qs = Object.keys(filters).map(function (k) {
    return encodeURIComponent(k) + "=" + encodeURIComponent(filters[k]);
  }).join("&");
  var headers = sbHeaders_();
  headers.Prefer = "return=representation";
  var resp = UrlFetchApp.fetch(prop_("SUPABASE_URL") + "/rest/v1/" + table + "?" + qs, {
    method: "patch",
    headers: headers,
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  return parseOrThrow_(resp, "PATCH " + table);
}

function parseOrThrow_(resp, context) {
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(context + " failed (" + code + "): " + resp.getContentText());
  }
  var text = resp.getContentText();
  return text ? JSON.parse(text) : [];
}

/* ---------- Domain lookups (mirror club-admin.html logic) ---------- */

function computeValidity_(academicYear, plan) {
  var periods = sbGet_("academic_periods", { academic_year: "eq." + academicYear });
  var sem1 = periods.filter(function (p) { return p.semester === 1; })[0];
  var sem2 = periods.filter(function (p) { return p.semester === 2; })[0];
  var v = null;
  if (plan === "semester_1" && sem1) v = { valid_from: sem1.start_date, valid_until: sem1.end_date };
  if (plan === "semester_2" && sem2) v = { valid_from: sem2.start_date, valid_until: sem2.end_date };
  if (plan === "full_year" && sem1 && sem2) v = { valid_from: sem1.start_date, valid_until: sem2.end_date };
  if (!v) throw new Error("No academic_periods rows for " + academicYear + " / " + plan + " — seed them before opening the form");
  return v;
}

// Late pricing keys off the actual paid date (the submission timestamp here):
// paidDate >= late_from → late_price. ISO-string comparison, same as the tool.
function planPrice_(academicYear, plan, paidDate) {
  var rows = sbGet_("membership_plans", { academic_year: "eq." + academicYear, plan: "eq." + plan });
  if (rows.length === 0) throw new Error("No membership_plans row for " + academicYear + " / " + plan);
  var row = rows[0];
  var late = row.late_from && row.late_price != null && paidDate >= row.late_from;
  return Number(late ? row.late_price : row.price);
}

/* ---------- Sheet / form plumbing ---------- */

// Map response values by question title so column reordering can't break us.
// A renamed question leaves duplicate same-titled columns, and namedValues
// then returns multiple entries — take the first non-empty one.
function valuesByTitle_(e) {
  var out = {};
  if (e.namedValues) {
    Object.keys(e.namedValues).forEach(function (title) {
      var vals = e.namedValues[title] || [];
      var v = "";
      for (var i = 0; i < vals.length; i++) {
        if (String(vals[i]).trim() !== "") { v = vals[i]; break; }
      }
      out[title] = v;
    });
  }
  return out;
}

// Case-insensitive on purpose: officers tweaking form option capitalization
// ("Full Year" vs "Full year") must not break submissions.
function requireMap_(map, label, what) {
  var wanted = String(label || "").trim().toLowerCase();
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === wanted) return map[keys[i]];
  }
  throw new Error("Unknown " + what + " label: '" + label + "'");
}

// File-upload answers arrive as Drive URLs (comma-joined if multiple).
function driveUrl_(answer) {
  var s = String(answer || "").trim();
  return s ? s.split(",")[0].trim() : null;
}

function toISODate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function prop_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error("Missing script property: " + name);
  return v;
}

function logError_(e, err) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tab = ss.getSheetByName("Errors") || ss.insertSheet("Errors");
  tab.appendRow([
    new Date(),
    String(err && err.message ? err.message : err),
    JSON.stringify(e && e.namedValues ? e.namedValues : {}),
  ]);
}
