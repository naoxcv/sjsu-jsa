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

function onFormSubmit(e) {
  try {
    var row = valuesByTitle_(e);

    var studentId = String(row[FORM_FIELDS.studentId] || "").trim();
    if (!studentId) throw new Error("Submission has no student ID");

    var academicYear = prop_("ACADEMIC_YEAR");
    var plan = requireMap_(PLAN_MAP, row[FORM_FIELDS.plan], "plan");
    var method = requireMap_(PAYMENT_MAP, row[FORM_FIELDS.paymentMethod], "payment method");
    var year = requireMap_(YEAR_MAP, row[FORM_FIELDS.universityYear], "university year");

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
        joined_date: paidDate,
        is_active: true,
        // role defaults to 'member'; gender and notes stay null
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
    sbInsert_("membership_fees", {
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
    });
  } catch (err) {
    logError_(e, err);
  }
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
