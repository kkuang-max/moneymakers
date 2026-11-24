// Fake chrome APIs for the preview page, so the UI runs without the real
// extension storage. Always uses the scripted court.
const store = {
  settings: { goalName: "Spring break", goalAmount: "600", goalDate: "2027-03-07", savedSoFar: "270", mode: "scripted" },
  history: [], recess: {}, neverItems: [], wishlist: [],
};
if (new URLSearchParams(location.search).has("nogoal")) store.settings = { savedSoFar: "84", mode: "scripted" };
window.chrome = {
  storage: { local: { get: async (d) => ({ ...(typeof d === "object" ? d : {}), ...store }), set: async (o) => Object.assign(store, o) } },
  runtime: { sendMessage: async () => ({ ok: false, error: "preview" }), getURL: (p) => `/${p}` },
};
document.addEventListener("submit", (e) => e.preventDefault());

// ?multi: a mixed cart (two things to defend, plus items on the default and toiletries skip lists).
// ?skipall: a cart where everything is on the skip list, so no check-in should appear.
const params = new URLSearchParams(location.search);
if (params.has("multi") || params.has("skipall")) {
  store.settings.skipCategories = ["groceries", "textbooks", "medicine", "toiletries"];
  const rows = params.has("skipall")
    ? [["B0TEST0010", "Colgate Toothpaste, 4 Pack", 12.99], ["B0TEST0011", "Organic Bananas, 2 lb", 2.49]]
    : [["B0TEST0002", "Oversized Fleece Hoodie", 64], ["B0TEST0003", "Crest Toothpaste, 3 Pack", 9.97], ["B0TEST0004", "Quaker Old Fashioned Oatmeal", 6.48]];
  document.addEventListener("DOMContentLoaded", () => {
    const cart = document.getElementById("sc-active-cart");
    if (params.has("skipall")) cart.replaceChildren();
    for (const [asin, title, price] of rows) {
      const row = document.createElement("div");
      row.className = "sc-list-item";
      Object.assign(row.dataset, { asin, price, quantity: "1", producttitle: title });
      row.textContent = `${title}, $${price}`;
      cart.append(row);
    }
  });
}
