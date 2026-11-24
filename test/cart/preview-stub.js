// Fake chrome APIs for the preview page, so the UI runs without the real
// extension storage. Always uses the scripted court.
const store = {
  settings: { goalName: "Spring break", goalAmount: "600", goalDate: "2027-03-07", savedSoFar: "270", mode: "scripted" },
  history: [], recess: {}, neverItems: [], wishlist: [],
};
if (new URLSearchParams(location.search).has("nogoal")) store.settings = { savedSoFar: "84", mode: "scripted" };
window.chrome = {
  storage: { local: { get: async (d) => ({ ...(typeof d === "object" ? d : {}), ...store }), set: async (o) => Object.assign(store, o) } },
  runtime: { id: "preview", sendMessage: async () => ({ ok: false, error: "preview" }), getURL: (p) => `/${p}` },
};
document.addEventListener("submit", (e) => e.preventDefault());

// ?multi: a mixed cart (two things to defend, plus items on the default and toiletries skip lists).
// ?skipall: a cart where everything is on the skip list, so no check-in should appear.
// ?vague: only "Bounty Select-A-Size" selected. Its name has no skip words, but its
// product page (/dp/B0TEST0006, served by the test runner) is "Household Supplies".
// ?vague2: the same plus a hoodie.
const params = new URLSearchParams(location.search);
const only = params.has("skipall") || params.has("vague");
if (params.has("multi") || only || params.has("vague2")) {
  store.settings.skipCategories = ["groceries", "textbooks", "medicine", "toiletries"];
  const bounty = ["B0TEST0006", "Bounty Select-A-Size, 6 Double Rolls", 13.49];
  const rows = params.has("skipall")
    ? [["B0TEST0010", "Colgate Toothpaste, 4 Pack", 12.99], ["B0TEST0011", "Organic Bananas, 2 lb", 2.49]]
    : params.has("vague")
    ? [bounty]
    : params.has("vague2")
    ? [bounty, ["B0TEST0002", "Oversized Fleece Hoodie", 64]]
    : [
        ["B0TEST0002", "Oversized Fleece Hoodie", 64],
        ["B0TEST0003", "Crest Toothpaste, 3 Pack", 9.97],
        ["B0TEST0004", "Quaker Old Fashioned Oatmeal", 6.48],
        ["B0TEST0005", "Sony WH-1000XM5 Headphones (left unticked)", 348, false],
      ];
  // Each row gets Amazon's "select" checkbox, plus an unticked "This is a gift" box
  // that must not count as unselecting the item.
  document.addEventListener("DOMContentLoaded", () => {
    const cart = document.getElementById("sc-active-cart");
    if (only || params.has("vague2")) cart.replaceChildren();
    for (const [asin, title, price, selected = true] of rows) {
      const row = document.createElement("div");
      row.className = "sc-list-item";
      Object.assign(row.dataset, { asin, price, quantity: "1", producttitle: title });
      const pick = Object.assign(document.createElement("input"), { type: "checkbox", checked: selected });
      const pickWrap = Object.assign(document.createElement("span"), { className: "sc-item-check-checkbox-selector" });
      pickWrap.append(pick);
      const gift = document.createElement("label");
      gift.className = "sc-gift-option";
      gift.append(Object.assign(document.createElement("input"), { type: "checkbox" }), " This is a gift");
      row.append(pickWrap, ` ${title}, $${price} `, gift);
      cart.append(row);
    }
  });
}
