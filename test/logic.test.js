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
  normalizeNameTokens,
  nameTokensSubset,
  nameMatches,
  amountsEqual,
  withinDays,
  autoVerifyMatches,
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

describe("name matching", () => {
  test("normalizeNameTokens folds case, diacritics, and punctuation", () => {
    assert.deepEqual(normalizeNameTokens("Núñez-Díaz, José"), ["nunez", "diaz", "jose"]);
  });
  test("subset match is order-independent", () => {
    assert.equal(nameTokensSubset("Jane", "Doe", "Doe Jane"), true);
  });
  test("tolerates an extra middle name in the payer string", () => {
    assert.equal(nameTokensSubset("Jane", "Doe", "Jane A Doe"), true);
  });
  test("requires BOTH first and last to be present", () => {
    assert.equal(nameTokensSubset("Jane", "Doe", "Jane"), false);
  });
  test("nickname does not match (falls to manual)", () => {
    assert.equal(nameTokensSubset("Robert", "Smith", "Rob Smith"), false);
  });
  test("empty member name never matches", () => {
    assert.equal(nameTokensSubset("", "", "Jane Doe"), false);
  });
});

describe("nameMatches (method-aware)", () => {
  const cashOnly = ["cash"];
  test("full name matches for any method", () => {
    assert.equal(nameMatches("Jane", "Doe", "Jane Doe", "venmo", cashOnly), true);
    assert.equal(nameMatches("Jane", "Doe", "Jane Doe", "cash", cashOnly), true);
  });
  test("first-name-only matches for cash", () => {
    assert.equal(nameMatches("Jane", "Doe", "Jane", "cash", cashOnly), true);
  });
  test("first-name-only does NOT match for venmo/zelle", () => {
    assert.equal(nameMatches("Jane", "Doe", "Jane", "venmo", cashOnly), false);
    assert.equal(nameMatches("Jane", "Doe", "Jane", "zelle", cashOnly), false);
  });
  test("cash with a wrong last name does not match", () => {
    assert.equal(nameMatches("Jane", "Doe", "Jane Smith", "cash", cashOnly), false);
  });
  test("cash last-name-only does not match (must include first name)", () => {
    assert.equal(nameMatches("Jane", "Doe", "Doe", "cash", cashOnly), false);
  });
});

describe("autoVerifyMatches", () => {
  const plans = [
    { academic_year: "2026-2027", plan: "semester_1", price: 15, late_from: "2026-09-18", late_price: 20 },
    { academic_year: "2026-2027", plan: "full_year", price: 25, late_from: "2026-09-18", late_price: 30 },
  ];
  const membersById = {
    1: { first_name: "Jane", last_name: "Doe" },
    2: { first_name: "John", last_name: "Doe" },
    3: { first_name: "Akira", last_name: "Tanaka" },
  };
  // paid_date after the 9/18 cutoff → expected semester_1 price is the late $20.
  function fee(over) {
    return Object.assign(
      { fee_id: 10, member_id: 1, academic_year: "2026-2027", plan: "semester_1",
        paid_date: "2026-09-22", payment_method: "venmo" },
      over
    );
  }
  function receipt(over) {
    return Object.assign(
      { method: "venmo", date: "2026-09-20", amount: 20, name: "Jane Doe", key: "k1" },
      over
    );
  }

  test("verifies a single confident match (amount = late price)", () => {
    const out = autoVerifyMatches([fee()], membersById, [receipt()], plans, []);
    assert.deepEqual(out.map((m) => [m.fee_id, m.receipt_key]), [[10, "k1"]]);
  });

  test("underpayment (paid base price, late expected) does NOT match", () => {
    const out = autoVerifyMatches([fee()], membersById, [receipt({ amount: 15 })], plans, []);
    assert.deepEqual(out, []);
  });

  test("method mismatch does NOT match", () => {
    const out = autoVerifyMatches([fee()], membersById, [receipt({ method: "zelle" })], plans, []);
    assert.deepEqual(out, []);
  });

  test("name mismatch does NOT match", () => {
    const out = autoVerifyMatches([fee()], membersById, [receipt({ name: "Someone Else" })], plans, []);
    assert.deepEqual(out, []);
  });

  test("receipt outside the date window does NOT match", () => {
    const out = autoVerifyMatches([fee()], membersById, [receipt({ date: "2026-06-01" })], plans, [], { windowDays: 45 });
    assert.deepEqual(out, []);
  });

  test("already-consumed receipt key is skipped", () => {
    const out = autoVerifyMatches([fee()], membersById, [receipt()], plans, ["k1"]);
    assert.deepEqual(out, []);
  });

  test("one receipt matching two members (name collision) blocks BOTH", () => {
    // Both Jane Doe and John Doe token-match a receipt named just "Doe"? No —
    // subset requires first name too. Use a receipt that matches neither fully
    // is not the case here; construct two members whose full names both appear.
    const fees = [
      fee({ fee_id: 10, member_id: 1 }),
      fee({ fee_id: 11, member_id: 2 }),
    ];
    // Receipt name contains Jane, John, and Doe → matches both members.
    const out = autoVerifyMatches(fees, membersById, [receipt({ name: "Jane John Doe" })], plans, []);
    assert.deepEqual(out, []);
  });

  test("one member with two pending fees + one receipt blocks the match", () => {
    const fees = [fee({ fee_id: 10 }), fee({ fee_id: 11 })];
    const out = autoVerifyMatches(fees, membersById, [receipt()], plans, []);
    assert.deepEqual(out, []);
  });

  test("one fee with two candidate receipts stays manual", () => {
    const receipts = [receipt({ key: "k1" }), receipt({ key: "k2" })];
    const out = autoVerifyMatches([fee()], membersById, receipts, plans, []);
    assert.deepEqual(out, []);
  });

  test("cash first-name-only auto-verifies a lone matching member", () => {
    const cashFee = fee({ payment_method: "cash" });
    const cashReceipt = receipt({ method: "cash", name: "Jane", key: "kc" });
    const out = autoVerifyMatches([cashFee], membersById, [cashReceipt], plans, []);
    assert.deepEqual(out.map((m) => m.receipt_key), ["kc"]);
  });

  test("cash first-name shared by two pending members stays manual", () => {
    // member 1 Jane Doe, add a second pending Jane (different last name).
    const members = Object.assign({}, membersById, { 4: { first_name: "Jane", last_name: "Roe" } });
    const fees = [
      fee({ fee_id: 10, member_id: 1, payment_method: "cash" }),
      fee({ fee_id: 12, member_id: 4, payment_method: "cash" }),
    ];
    const cashReceipt = receipt({ method: "cash", name: "Jane", key: "kc" });
    const out = autoVerifyMatches(fees, members, [cashReceipt], plans, []);
    assert.deepEqual(out, []);
  });

  test("two independent members each match their own receipt", () => {
    const fees = [
      fee({ fee_id: 10, member_id: 1 }),
      fee({ fee_id: 20, member_id: 3, payment_method: "zelle" }),
    ];
    const receipts = [
      receipt({ key: "kA", name: "Jane Doe" }),
      receipt({ key: "kB", method: "zelle", name: "Akira Tanaka" }),
    ];
    const out = autoVerifyMatches(fees, membersById, receipts, plans, []);
    assert.deepEqual(out.map((m) => [m.fee_id, m.receipt_key]).sort(), [[10, "kA"], [20, "kB"]]);
  });
});
