const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  idEq,
  todayISO,
  isFeeActive,
  feeRowStatus,
  computeValidity,
  planPrice,
  hasOtherFeeThisYear,
} = require("../logic.js");

// Dates relative to "today" so the suite doesn't rot as the calendar moves.
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
const TODAY = todayISO();
const YESTERDAY = addDays(-1);
const TOMORROW = addDays(1);

describe("idEq", () => {
  test("coerces number and string IDs as equal", () => {
    assert.equal(idEq(7, "7"), true);
  });
  test("null/undefined never match, even to each other", () => {
    assert.equal(idEq(null, null), false);
    assert.equal(idEq(undefined, undefined), false);
    assert.equal(idEq(null, 1), false);
  });
  test("different values do not match", () => {
    assert.equal(idEq(1, 2), false);
  });
});

describe("feeRowStatus", () => {
  test("rejected wins regardless of dates", () => {
    assert.equal(feeRowStatus({ status: "rejected", valid_until: TOMORROW }), "rejected");
  });
  test("pending never reads as expired, even with lapsed dates", () => {
    assert.equal(feeRowStatus({ status: "pending", valid_until: YESTERDAY }), "pending");
  });
  test("verified + future valid_until is active", () => {
    assert.equal(feeRowStatus({ status: "verified", valid_until: TOMORROW }), "active");
  });
  test("verified + valid_until === today is active (inclusive boundary)", () => {
    assert.equal(feeRowStatus({ status: "verified", valid_until: TODAY }), "active");
  });
  test("verified + past valid_until is expired", () => {
    assert.equal(feeRowStatus({ status: "verified", valid_until: YESTERDAY }), "expired");
  });
});

describe("isFeeActive", () => {
  const member = { member_id: 1 };

  test("true when a verified fee is currently valid", () => {
    const fees = [{ member_id: 1, status: "verified", valid_until: TOMORROW }];
    assert.equal(isFeeActive(member, fees), true);
  });
  test("false for a pending fee, even with a future valid_until", () => {
    const fees = [{ member_id: 1, status: "pending", valid_until: TOMORROW }];
    assert.equal(isFeeActive(member, fees), false);
  });
  test("false for a verified but expired fee", () => {
    const fees = [{ member_id: 1, status: "verified", valid_until: YESTERDAY }];
    assert.equal(isFeeActive(member, fees), false);
  });
  test("false for a rejected fee", () => {
    const fees = [{ member_id: 1, status: "rejected", valid_until: TOMORROW }];
    assert.equal(isFeeActive(member, fees), false);
  });
  test("true if any of several fees is currently verified", () => {
    const fees = [
      { member_id: 1, status: "verified", valid_until: YESTERDAY },
      { member_id: 1, status: "verified", valid_until: TOMORROW },
    ];
    assert.equal(isFeeActive(member, fees), true);
  });
  test("false with no fees at all", () => {
    assert.equal(isFeeActive(member, []), false);
  });
  test("ignores other members' fees", () => {
    const fees = [{ member_id: 2, status: "verified", valid_until: TOMORROW }];
    assert.equal(isFeeActive(member, fees), false);
  });
});

describe("computeValidity", () => {
  const periods = [
    { academic_year: "2026-2027", semester: 1, start_date: "2026-08-17", end_date: "2026-12-20" },
    { academic_year: "2026-2027", semester: 2, start_date: "2027-01-10", end_date: "2027-05-15" },
  ];

  test("semester_1 spans sem1 start to sem1 end", () => {
    assert.deepEqual(computeValidity("2026-2027", "semester_1", periods), {
      valid_from: "2026-08-17",
      valid_until: "2026-12-20",
    });
  });
  test("semester_2 spans sem2 start to sem2 end", () => {
    assert.deepEqual(computeValidity("2026-2027", "semester_2", periods), {
      valid_from: "2027-01-10",
      valid_until: "2027-05-15",
    });
  });
  test("full_year spans sem1 start to sem2 end", () => {
    assert.deepEqual(computeValidity("2026-2027", "full_year", periods), {
      valid_from: "2026-08-17",
      valid_until: "2027-05-15",
    });
  });
  test("null when the academic year has no matching period rows", () => {
    assert.equal(computeValidity("1999-2000", "semester_1", periods), null);
  });
  test("full_year is null if only one semester's period exists", () => {
    const onlySem1 = [periods[0]];
    assert.equal(computeValidity("2026-2027", "full_year", onlySem1), null);
  });
  test("null for an unknown plan value", () => {
    assert.equal(computeValidity("2026-2027", "monthly", periods), null);
  });
});

describe("planPrice", () => {
  const plans = [
    { academic_year: "2026-2027", plan: "semester_1", price: 15, late_from: "2026-10-03", late_price: 20 },
    { academic_year: "2026-2027", plan: "full_year", price: 25, late_from: null, late_price: null },
  ];

  test("null when no plan row matches", () => {
    assert.equal(planPrice("2099-2100", "semester_1", "2026-09-01", plans), null);
  });
  test("regular price before the late cutoff", () => {
    assert.equal(planPrice("2026-2027", "semester_1", "2026-10-02", plans), 15);
  });
  test("late price on the cutoff date itself (inclusive)", () => {
    assert.equal(planPrice("2026-2027", "semester_1", "2026-10-03", plans), 20);
  });
  test("late price after the cutoff", () => {
    assert.equal(planPrice("2026-2027", "semester_1", "2026-11-01", plans), 20);
  });
  test("no late tier when late_from/late_price are null", () => {
    assert.equal(planPrice("2026-2027", "full_year", "2027-06-01", plans), 25);
  });
});

describe("hasOtherFeeThisYear", () => {
  const fee = { fee_id: 1, member_id: 1, academic_year: "2026-2027" };

  test("true when another pending fee exists for the same member/year", () => {
    const all = [fee, { fee_id: 2, member_id: 1, academic_year: "2026-2027", status: "pending" }];
    assert.equal(hasOtherFeeThisYear(fee, all), true);
  });
  test("true when another verified fee exists for the same member/year", () => {
    const all = [fee, { fee_id: 2, member_id: 1, academic_year: "2026-2027", status: "verified" }];
    assert.equal(hasOtherFeeThisYear(fee, all), true);
  });
  test("false when the other row was rejected", () => {
    const all = [fee, { fee_id: 2, member_id: 1, academic_year: "2026-2027", status: "rejected" }];
    assert.equal(hasOtherFeeThisYear(fee, all), false);
  });
  test("false for a different academic year", () => {
    const all = [fee, { fee_id: 2, member_id: 1, academic_year: "2025-2026", status: "pending" }];
    assert.equal(hasOtherFeeThisYear(fee, all), false);
  });
  test("false for a different member", () => {
    const all = [fee, { fee_id: 2, member_id: 2, academic_year: "2026-2027", status: "pending" }];
    assert.equal(hasOtherFeeThisYear(fee, all), false);
  });
  test("excludes itself even if present in the list", () => {
    assert.equal(hasOtherFeeThisYear(fee, [fee]), false);
  });
});
