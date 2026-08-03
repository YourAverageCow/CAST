const test = require("node:test");
const assert = require("node:assert/strict");
const { shuffle, planBulkVideoAssignment } = require("./bulk-assignment.js");

const LIB = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("shuffle returns a permutation of the same items", () => {
  const shuffled = shuffle(LIB);
  assert.equal(shuffled.length, LIB.length);
  assert.deepEqual([...shuffled].map(x => x.id).sort(), ["a", "b", "c"]);
  // Original array untouched.
  assert.deepEqual(LIB.map(x => x.id), ["a", "b", "c"]);
});

test("planBulkVideoAssignment returns all 'none' when useRandomLibrary is false", () => {
  const plan = planBulkVideoAssignment({ count: 5, videoMode: "separate", useRandomLibrary: false, libraryItems: LIB });
  assert.equal(plan.length, 5);
  assert.ok(plan.every(p => p.source === "none"));
});

test("planBulkVideoAssignment returns all 'none' when the library is empty", () => {
  const plan = planBulkVideoAssignment({ count: 5, videoMode: "same", useRandomLibrary: true, libraryItems: [] });
  assert.ok(plan.every(p => p.source === "none"));
});

test("planBulkVideoAssignment returns all 'none' when libraryItems is missing/null", () => {
  const plan = planBulkVideoAssignment({ count: 3, videoMode: "same", useRandomLibrary: true, libraryItems: null });
  assert.ok(plan.every(p => p.source === "none"));
});

test("'same' mode assigns one repeated itemId to every card", () => {
  const plan = planBulkVideoAssignment({ count: 5, videoMode: "same", useRandomLibrary: true, libraryItems: LIB });
  assert.equal(plan.length, 5);
  const ids = new Set(plan.map(p => p.itemId));
  assert.equal(ids.size, 1);
  assert.ok(LIB.some(item => item.id === [...ids][0]));
  assert.ok(plan.every(p => p.source === "library"));
});

test("'separate' mode never emits 'none' when the library is non-empty", () => {
  for (let trial = 0; trial < 20; trial++) {
    const plan = planBulkVideoAssignment({ count: 10, videoMode: "separate", useRandomLibrary: true, libraryItems: LIB });
    assert.equal(plan.length, 10);
    assert.ok(plan.every(p => p.source === "library" && LIB.some(item => item.id === p.itemId)));
  }
});

test("'separate' mode with a library smaller than count cycles through all items", () => {
  const plan = planBulkVideoAssignment({ count: 9, videoMode: "separate", useRandomLibrary: true, libraryItems: LIB });
  const counts = {};
  for (const p of plan) counts[p.itemId] = (counts[p.itemId] || 0) + 1;
  // 9 cards / 3 items = each item used exactly 3 times across full laps.
  assert.deepEqual(Object.values(counts).sort(), [3, 3, 3]);
});

test("'separate' mode with a single-item library assigns it to every card", () => {
  const plan = planBulkVideoAssignment({ count: 4, videoMode: "separate", useRandomLibrary: true, libraryItems: [{ id: "only" }] });
  assert.ok(plan.every(p => p.source === "library" && p.itemId === "only"));
});

test("result length always equals count, for count 1 through 15", () => {
  for (let count = 1; count <= 15; count++) {
    const samePlan = planBulkVideoAssignment({ count, videoMode: "same", useRandomLibrary: true, libraryItems: LIB });
    const separatePlan = planBulkVideoAssignment({ count, videoMode: "separate", useRandomLibrary: true, libraryItems: LIB });
    assert.equal(samePlan.length, count);
    assert.equal(separatePlan.length, count);
  }
});
