// Pure logic for the batch composer's bulk-generate video assignment — no
// DOM, no File/Blob, no IndexedDB. Given a count and a library of
// {id, ...} items, decides which library item (if any) each of the `count`
// new batch cards should get. The actual File-fetching/applying (reading
// the blob out of IndexedDB, calling setBatchCardBackground) is DOM/Browser-
// API-coupled glue and lives in app.js — this module only produces the plan.

// Fisher-Yates shuffle. Cosmetic randomness (which stock video looks least
// repetitive next to which), not anything security-sensitive — Math.random
// is fine, no need for crypto-grade shuffling here.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Returns an array of length `count`, each entry describing what background
// source that card should get:
//   { source: "none" }                      — leave for manual upload
//   { source: "library", itemId: "<id>" }    — assign this library item
//
// videoMode "same" picks one random item and reuses it for every card.
// videoMode "separate" shuffles the library and cycles through it — once
// every item has been used, it reshuffles and continues, rather than
// stopping when the library is smaller than `count` or repeating the same
// fixed order every lap.
function planBulkVideoAssignment({ count, videoMode, useRandomLibrary, libraryItems }) {
  const plan = Array.from({ length: count }, () => ({ source: "none" }));
  if (!useRandomLibrary || !libraryItems || libraryItems.length === 0) return plan;

  if (videoMode === "same") {
    const pick = libraryItems[Math.floor(Math.random() * libraryItems.length)];
    return plan.map(() => ({ source: "library", itemId: pick.id }));
  }

  let pool = [];
  return plan.map(() => {
    if (pool.length === 0) pool = shuffle(libraryItems);
    return { source: "library", itemId: pool.pop().id };
  });
}

// Same {source} shape as planBulkVideoAssignment, but for an explicit,
// user-ordered list of library item ids (the numbered multi-select picker)
// instead of a random pick. Picks are honored in click order; fewer picks
// than `count` cycles through that same order to fill the remaining slots
// (not reshuffled — the user's deliberate order is preserved on each lap),
// mirroring planBulkVideoAssignment's shuffle-and-cycle behavior for
// "separate + random" but without the shuffle, since order here was chosen
// on purpose. More picks than `count` just uses the first `count` of them.
function planManualAssignment({ count, orderedItemIds }) {
  if (!orderedItemIds || orderedItemIds.length === 0) {
    return Array.from({ length: count }, () => ({ source: "none" }));
  }
  return Array.from({ length: count }, (_, i) => ({
    source: "library",
    itemId: orderedItemIds[i % orderedItemIds.length],
  }));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { shuffle, planBulkVideoAssignment, planManualAssignment };
}
