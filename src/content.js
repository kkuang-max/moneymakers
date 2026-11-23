// Content script. Spots the checkout moment, shows the quick check, and runs
// the courtroom. Screens follow the team's Figma (Low-Mid-Fi Wireframes
// Iteration 2, "Hi-fi prototype"). All UI lives in a shadow root so the store's
// CSS can't touch it, and ours can't break the store.

(() => {
  if (window.__mmLoaded) return;
  window.__mmLoaded = true;

  const flow = globalThis.gicFlow;
  const LIVE_TIMEOUT_MS = 25000;

  // Buttons that mean "I'm buying now". Amazon changes these, so keep a list.
  const BUY_SELECTORS = [
    "#buy-now-button",
    "input[name='proceedToRetailCheckout']",
    "[data-feature-id='proceed-to-checkout-action'] input",
    "input[data-feature-id='proceed-to-checkout-action']",
    "input[name='placeYourOrder1']",
    "#submitOrderButtonId input",
    "[data-gic-buy]", // test page
  ];
  // Fallback: match the button's visible label. Covers "Place your order in CAD" etc.
  const BUY_TEXT = /\b(proceed to (retail )?checkout|place (your )?order|buy now|continue to checkout)\b/i;

  // "Skip these purchases" chips on the settings page. Items whose title matches
  // never trigger a check-in.
  const SKIP_WORDS = {
    groceries: ["grocery", "snack", "coffee", "cereal", "pasta", "rice", "milk", "bread", "oatmeal", "granola"],
    textbooks: ["textbook", "isbn", "workbook", "study guide", "lab manual", "loose-leaf", "loose leaf"],
    medicine: [
      "melatonin", "sleep aid", "vitamin", "supplement", "allergy", "antihistamine", "cold & flu", "cough", "pain relief",
      "ibuprofen", "acetaminophen", "tylenol", "advil", "aspirin", "bandage", "first aid", "prescription", "medicine",
      "thermometer", "contact lens", "sunscreen",
    ],
    bills: [],
    gifts: ["gift"],
    toiletries: ["toothpaste", "toothbrush", "floss", "deodorant", "shampoo", "conditioner", "soap", "tampon", "pads", "razor", "toilet paper", "paper towel"],
    transit: ["transit", "bus pass", "presto", "metrocard"],
  };
  const DEFAULT_SKIPS = ["groceries", "textbooks", "medicine"];

  let pendingButton = null; // the buy button we intercepted
  let allowNextClick = false;

  const log = (...args) => console.log("[MM]", ...args);

  // ---------- characters (Figma "Character" sheet) ----------
  // Art lives in assets/ and is exposed to the page via web_accessible_resources.
  const asset = (p) => chrome.runtime.getURL(`assets/${p}`);
  const img = (p, cls = "") => `<img class="${cls}" src="${asset(p)}" alt="" draggable="false" />`;
  // Two judges. One is picked per check-in, and the same one presides over the trial.
  const JUDGES = ["judge-1", "judge-2"];
  let judge = JUDGES[0];
  const pickJudge = () => (judge = JUDGES[Math.floor(Math.random() * JUDGES.length)]);
  // Two defendants, chosen in Settings ("Your character in court").
  const defendantArt = (settings) => (settings.defendant === "2" ? "defendant-2" : "defendant-1");

  function labelOf(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const labelled = ids.map((id) => document.getElementById(id)?.textContent || "").join(" ");
    // Amazon wraps <input> in <span class="a-button"> with the text in a sibling span.
    const wrapper = el.closest(".a-button")?.textContent || "";
    return [el.value, el.getAttribute("aria-label"), labelled, el.textContent, wrapper].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function findBuyButton(target) {
    const bySelector = target.closest?.(BUY_SELECTORS.join(","));
    if (bySelector) return bySelector;
    const clickable = target.closest?.("input[type=submit], input[type=button], button, a, [role=button], .a-button");
    if (!clickable) return null;
    // If they clicked Amazon's wrapper span, act on the real input inside it.
    const real = clickable.matches(".a-button") ? clickable.querySelector("input, button, a") || clickable : clickable;
    const label = labelOf(real);
    return label.length < 80 && BUY_TEXT.test(label) ? real : null;
  }

  // ---------- scraping ----------

  const text = (sel, root = document) => root.querySelector(sel)?.textContent.trim() || "";
  const firstText = (sels, root = document) => {
    for (const s of sels) {
      const t = text(s, root);
      if (t) return t;
    }
    return "";
  };
  const num = (s) => {
    const m = String(s ?? "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
    return m ? parseFloat(m[1]) : null;
  };

  function pageType() {
    const p = location.pathname;
    if (/\/(gp\/buy|checkout)(\/|$)/.test(p)) return "checkout";
    if (/\/(gp\/cart|cart)(\/|$)/.test(p)) return "cart";
    if (document.querySelector("#productTitle")) return "product";
    return null;
  }

  // Checked on a live amazon.com product page (Nov 2026).
  function scrapeProduct() {
    const title = firstText(["#productTitle"]);
    const price = num(
      firstText([
        "#corePrice_feature_div .a-offscreen",
        "#corePriceDisplay_desktop_feature_div .a-offscreen",
        "#apex_desktop .a-price .a-offscreen",
        ".a-price .a-offscreen",
      ])
    );
    return title ? { items: [{ title, price }], total: price } : null;
  }

  // Cart rows carry data-producttitle / data-price / data-quantity (checked on live amazon.com/cart, Nov 2026).
  // Only read rows inside the active cart: "Saved for later" uses the same row markup.
  function scrapeCart() {
    const seen = new Set();
    const items = [];
    for (const row of document.querySelectorAll("#sc-active-cart .sc-list-item[data-asin], #sc-active-cart [data-asin][data-price]")) {
      const asin = row.dataset.asin;
      if (!asin || seen.has(asin)) continue;
      seen.add(asin);
      const title = row.dataset.producttitle || firstText([".sc-product-title", ".a-truncate-full", "a.sc-product-link"], row);
      if (!title) continue;
      items.push({
        title,
        price: num(row.dataset.price) ?? num(firstText([".a-price .a-offscreen", ".sc-product-price"], row)),
        quantity: parseInt(row.dataset.quantity, 10) || 1,
      });
    }
    const sum = items.reduce((t, i) => t + (i.price || 0) * i.quantity, 0);
    const total = num(firstText(["#sc-subtotal-amount-activecart", "#sc-subtotal-amount-buybox"])) ?? sum;
    return items.length ? { items, total } : null;
  }

  // Find "Order total: CA$12.34" style rows by their text.
  function totalByLabel() {
    const labels = [...document.querySelectorAll("td, span, div, dt, li")].filter(
      (el) => el.children.length <= 2 && /^\s*(order total|total)\s*:?\s*$/i.test(el.textContent)
    );
    for (const el of labels) {
      const row = el.closest(".order-summary-grid, tr, li, .a-row, [class*=row], div");
      const n = num(row?.textContent.replace(el.textContent, ""));
      if (n) return n;
    }
    return null;
  }

  // Checked on live amazon.com Place Your Order page (Nov 2026). Two tables exist: a hidden
  // USD "marketplace" one and the visible "transactional" one in the shopper's currency.
  function scrapeCheckout() {
    const totalText = firstText([
      "#subtotals-transactional-table .grand-total-cell",
      "#subtotals-marketplace-table .grand-total-cell",
      ".grand-total-cell",
      ".grand-total-price",
      "[data-testid='order-summary-total']",
    ]);
    const total = num(totalText) ?? totalByLabel();
    const currency = (totalText.match(/\b(USD|CAD|EUR|GBP|AUD)\b/) || [])[1];
    const titles = [...document.querySelectorAll(".item-title, .lineitem-title-text")].map((el) => el.textContent.trim()).filter(Boolean);
    const items = titles.length ? titles.map((title) => ({ title })) : [{ title: "Your order" }];
    return { items, total, currency };
  }

  function scrapeItem() {
    const type = pageType();
    const data = type === "product" ? scrapeProduct() : type === "cart" ? scrapeCart() : type === "checkout" ? scrapeCheckout() : null;
    if (!data) return null;
    const names = data.items.map((i) => i.title);
    return {
      ...data,
      label: names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1} more`,
      site: location.hostname,
      page: type,
    };
  }

  // ---------- storage ----------

  const getStore = () => chrome.storage.local.get({ settings: {}, history: [], neverItems: [], wishlist: [] });

  const savedTotal = (settings, history) =>
    (Number(settings.savedSoFar) || 0) +
    history.filter((h) => h.outcome === "saved" || h.outcome === "kept").reduce((t, h) => t + (h.total || 0), 0);

  async function logOutcome(item, outcome, extra = {}) {
    const { history } = await getStore();
    history.unshift({ date: Date.now(), title: item.label, total: item.total, outcome, ...extra });
    await chrome.storage.local.set({ history: history.slice(0, 200) });
  }

  async function addToWishlist(item) {
    const { wishlist } = await getStore();
    wishlist.unshift({ date: Date.now(), title: item.label, total: item.total, url: location.href });
    await chrome.storage.local.set({ wishlist: wishlist.slice(0, 100) });
  }

  // Local checks that skip the check-in entirely.
  function skipReason(settings, neverItems, item) {
    if (neverItems.includes(item.label)) return "you asked never to be asked about this item";
    const custom = String(settings.skipCustom || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (custom.some((s) => location.hostname.includes(s))) return "this store is on your skip list";
    const cats = settings.skipCategories || DEFAULT_SKIPS;
    const words = [...cats.flatMap((c) => SKIP_WORDS[c] || []), ...custom];
    // Whole words only, so "iPads" isn't "pads" and "Price" isn't "rice".
    const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matchers = words.map((w) => new RegExp(`(^|[^a-z0-9])${esc(w)}s?($|[^a-z0-9])`, "i"));
    const titles = item.items.map((i) => i.title);
    const hit = (t) => words.find((w, n) => matchers[n].test(t));
    if (titles.length && titles.every(hit)) return `everything here is on your skip list (matched "${hit(titles[0])}")`;
    return null;
  }

  function profileFrom(settings, history) {
    const target = Number(settings.goalAmount) || null;
    return {
      goal: settings.goalName ? { name: settings.goalName, target, by: settings.goalDate || null } : null,
      saved: savedTotal(settings, history),
    };
  }

  // ---------- UI shell ----------

  const host = document.createElement("div");
  host.id = "money-makers-root";
  host.style.cssText = "all:initial; position:fixed; z-index:2147483647; inset:auto;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${CSS()}</style><div id="layer"></div>`;
  const layer = shadow.getElementById("layer");
  document.documentElement.appendChild(host);
  loadFont();

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n, cur) => globalThis.gicMoney(n, cur);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => layer.querySelector(sel);
  const on = (sel, fn) => {
    const el = $(sel);
    if (el) el.onclick = fn;
  };

  function clearUI() {
    layer.innerHTML = "";
    host.style.inset = "auto";
  }
  // Quick check sits top-right over the page. Everything else takes over the page.
  // Pop-ups use the "banknote" frame: ink outline plus an engraved border.
  // `top` is drawn above the pop-up (the judge leaning over it).
  function showPanel(html, top = "") {
    host.style.inset = "0 0 auto auto";
    layer.innerHTML = `<div class="panel-wrap${top ? " has-top" : ""}"><div class="panel-box">${top}<div class="panel" role="dialog">${img(
      "ui/engraved-border.svg",
      "engraved"
    )}${html}</div></div></div>`;
  }
  function showPage(html, cls = "") {
    host.style.inset = "0";
    layer.innerHTML = `<div class="page ${cls}">${html}</div>`;
  }

  // Once you've chosen to go ahead, don't check in again on the next checkout step.
  const CLEARED_KEY = "mmClearedAt";
  const CLEARED_MS = 20 * 60 * 1000;
  const isCleared = () => {
    try {
      return Date.now() - Number(sessionStorage.getItem(CLEARED_KEY) || 0) < CLEARED_MS;
    } catch {
      return false;
    }
  };

  function proceedWithPurchase() {
    try {
      sessionStorage.setItem(CLEARED_KEY, String(Date.now()));
    } catch {}
    clearUI();
    if (pendingButton) {
      allowNextClick = true;
      const btn = pendingButton;
      pendingButton = null;
      btn.click();
    }
  }

  // Urbanist comes from the service worker as bytes (see background.js).
  async function loadFont() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "font" });
      if (!res?.ok) return;
      const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
      const face = new FontFace("Urbanist", bytes.buffer, { weight: "400 700" });
      await face.load();
      document.fonts.add(face);
    } catch (e) {
      log("Font not loaded, using system font.", e?.message);
    }
  }

  // ---------- shared pieces ----------

  function goalMath(profile, item) {
    const g = profile.goal;
    const price = item?.total || 0;
    const before = profile.saved;
    const after = before + price;
    if (g?.target) {
      const pct = (v) => Math.min(100, Math.round((v / g.target) * 100));
      let milestone = "";
      if (pct(before) < 50 && pct(after) >= 50 && pct(after) < 100) milestone = `you're past halfway to ${g.name}.`;
      if (pct(before) < 100 && pct(after) >= 100) milestone = `that's your ${g.name} goal reached.`;
      return { hasGoal: true, target: g.target, before, after, pctBefore: pct(before), pctAfter: pct(after), left: Math.max(g.target - after, 0), milestone };
    }
    const step = 100;
    const next = (Math.floor(before / step) + 1) * step;
    const pct = (v) => Math.min(100, Math.round((v / next) * 100));
    return {
      hasGoal: false,
      target: next,
      before,
      after,
      pctBefore: pct(before),
      pctAfter: pct(after),
      left: Math.max(next - after, 0),
      milestone: after >= next ? `you're past $${next} saved.` : "",
    };
  }

  const clamp = (pct) => Math.max(0, Math.min(100, pct));
  // `preview` draws a faint segment showing where the bar would get to if you skip it.
  const bar = (pct, preview) =>
    `<div class="bar">${preview != null ? `<i class="pre" style="width:${clamp(preview)}%"></i>` : ""}<i style="width:${clamp(pct)}%"></i></div>`;

  // The goal card used on the quick check ("before") and the saved screens ("after").
  function goalCard(profile, m, mode) {
    const g = profile.goal;
    const value = mode === "after" ? m.after : m.before;
    const pct = mode === "after" ? m.pctAfter : m.pctBefore;
    if (m.hasGoal) {
      return `<div class="card goal">
        <div class="tiny">Saved for ${esc(g.name)} so far</div>
        <div class="amount"><b>${money(value)}</b><span>of ${money(m.target)}</span></div>
        ${bar(pct, mode === "before" ? m.pctAfter : null)}
        <div class="bar-foot"><span>${pct}% there</span>${
          mode === "before" ? `<span class="blue">Skip it → ${m.pctAfter}%</span>` : `<span>${money(Math.max(m.target - value, 0))} to go</span>`
        }</div>
      </div>`;
    }
    return `<div class="card goal">
      <div class="row-between"><span class="tiny">You've saved so far</span>${
        mode === "before" ? `<button class="chip gold" data-act="setgoal">+ Set a goal</button>` : ""
      }</div>
      <div class="amount"><b>${money(value)}</b><span>· next milestone ${money(m.target)}</span></div>
      ${bar(pct, mode === "before" ? m.pctAfter : null)}
      <div class="bar-foot"><span>${pct}% of the way</span>${mode === "before" ? `<span class="blue">Skip it → ${m.pctAfter}%</span>` : ""}</div>
    </div>`;
  }

  // Slim goal line on the verdict screens.
  function goalLine(profile) {
    const g = profile.goal;
    if (!g?.target) return "";
    const pct = Math.min(100, Math.round((profile.saved / g.target) * 100));
    return `<div class="card goal-line"><div class="row-between"><span>${esc(g.name)}</span><span class="blue">${money(profile.saved)} of ${money(g.target)}</span></div>${bar(pct)}</div>`;
  }

  // ---------- 02 Quick check ----------

  function showQuickCheck(item, settings, history, note = "") {
    const profile = profileFrom(settings, history);
    const m = goalMath(profile, item);
    const short = globalThis.gicShortName(item.label);
    const the = item.items.length > 1 ? "this cart" : `the ${short}`;
    const price = money(item.total, item.currency);
    const hint = m.milestone
      ? `<div class="hint"><span class="hint-icon">${img("ui/star.svg")}</span><span>This would ${m.hasGoal ? (m.pctAfter >= 100 ? "finish your goal" : "get you past halfway") : `push you past ${money(m.target)} saved`}</span></div>`
      : "";
    // The judge leans over the pop-up. "Hmph. Again?" if you've been here this week.
    pickJudge();
    const recent = history.some((h) => Date.now() - (h.date || 0) < 7 * 24 * 60 * 60 * 1000);
    const peek = `
      <div class="peek ${judge}" aria-hidden="true">
        <div class="peek-head">${img(`characters/${judge}.png`)}</div>
        <i class="sleeve l"></i><i class="sleeve r"></i><i class="cuff l"></i><i class="cuff r"></i>
        <span class="paw l"><i></i><i></i><i></i></span><span class="paw r"><i></i><i></i><i></i></span>
        ${recent ? `<span class="hmph">Hmph. Again?</span>` : ""}
      </div>`;
    showPanel(`
      <div class="panel-head"><span>Quick check</span><button class="icon-btn" data-act="close" aria-label="Close">${img("ui/close.svg")}</button></div>
      ${goalCard(profile, m, "before")}
      <div class="question">
        <h2 class="h3">Do you really need it?</h2>
        <p class="muted">${
          m.hasGoal ? `If you skip ${esc(the)}, ${price} goes to ${esc(profile.goal.name)} instead.` : `If you skip ${esc(the)}, that's ${price} straight into your savings.`
        }</p>
      </div>
      ${note ? `<p class="note">${esc(note)}</p>` : ""}
      ${hint}
      <button class="btn primary" data-act="save">You’re right, I’ll save it</button>
      <button class="btn outline" data-act="court">Yes, I want it<span class="sticker">${img("ui/gavel.svg")}Goes to court</span></button>
      <button class="btn ghost" data-act="never">Never ask about this item</button>`, peek);
    $("[data-act=save]").focus();
    // Flow step 3, "Not now": the X lets the order go through, no guilt message.
    on("[data-act=close]", async () => {
      await logOutcome(item, "not now");
      proceedWithPurchase();
    });
    on("[data-act=setgoal]", () => chrome.runtime.sendMessage({ type: "openOptions" }));
    on("[data-act=save]", () => saveIt(item, settings, history, "checkout", "panel"));
    on("[data-act=court]", () => startTrial(item, settings, history));
    on("[data-act=never]", async () => {
      const { neverItems } = await getStore();
      await chrome.storage.local.set({ neverItems: [...new Set([item.label, ...neverItems])].slice(0, 500) });
      await logOutcome(item, "never");
      proceedWithPurchase();
    });
  }

  // ---------- 03 / 11 Saved ----------

  async function saveIt(item, settings, history, where, style, transcript = []) {
    const profile = profileFrom(settings, history); // before this save
    const m = goalMath(profile, item);
    await logOutcome(item, "saved", { where, transcript });
    await addToWishlist(item);
    pendingButton = null;
    const short = globalThis.gicShortName(item.label);
    const by = profile.goal?.by ? new Date(`${profile.goal.by}T00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
    const html = `
      <div class="confetti" aria-hidden="true">${CONFETTI}</div>
      ${img("ui/medallion.svg", "medallion")}
      <h2 class="h2 center">Nice, you just saved ${money(item.total, item.currency)}</h2>
      ${goalCard(profile, m, "after")}
      ${m.milestone ? `<div class="hint box"><span class="hint-icon">${img("ui/star.svg")}</span><span>Milestone: ${esc(m.milestone)}</span></div>` : ""}
      ${
        m.hasGoal
          ? ""
          : `<button class="card row-link" data-act="goal">${ICON.flag}<span><b>Give your savings a goal</b><small>A trip, a laptop, a safety net. Every dollar you skip counts toward it.</small></span>${ICON.arrow}</button>`
      }
      <div class="card wish"><span class="thumb"></span><span>${esc(short)} is on your Guilty If Charged wishlist.${by ? ` Revisit it after ${esc(by)}.` : ""}</span></div>
      <button class="btn primary" data-act="done">Done</button>`;
    if (style === "panel") showPanel(html);
    else showPage(`<div class="card-lg">${html}</div>`, "centered");
    on("[data-act=done]", clearUI);
    on("[data-act=goal]", () => showGoalSheet(item, profile.saved + (item.total || 0), style));
  }

  // ---------- 16.1 Goal sheet ----------

  function showGoalSheet(item, saved, style) {
    const kinds = [
      ["Trip", ICON.plane],
      ["Safety net", ICON.shield],
      ["Laptop", ICON.laptop],
      ["Something else", ICON.plus],
    ];
    const html = `
      <h2 class="h2">One more thing: What are you saving for?</h2>
      <div class="chips">${kinds.map(([k, i], n) => `<button class="chip${n === 0 ? " on" : ""}" data-kind="${k}">${i}${k}</button>`).join("")}</div>
      <div class="two">
        <label>Name it<input id="gname" value="Spring break" /></label>
        <label>Amount<input id="gamount" inputmode="decimal" placeholder="600" /></label>
      </div>
      <p class="blue center small" id="gpreview"></p>
      <button class="btn primary" data-act="savegoal">Save my goal</button>
      <button class="link" data-act="later">Skip. I'll do it in Settings</button>`;
    if (style === "panel") showPanel(html);
    else showPage(`<div class="card-lg">${html}</div>`, "centered");
    const name = $("#gname");
    const amount = $("#gamount");
    for (const el of [name, amount]) el.addEventListener("keydown", (e) => e.stopPropagation());
    const preview = () => {
      const a = Number(amount.value);
      $("#gpreview").textContent = a > 0 ? `${money(saved)} of ${money(a)} already done. That's ${Math.min(100, Math.round((saved / a) * 100))}%.` : "";
    };
    amount.addEventListener("input", preview);
    for (const chip of layer.querySelectorAll("[data-kind]")) {
      chip.onclick = () => {
        layer.querySelectorAll("[data-kind]").forEach((c) => c.classList.toggle("on", c === chip));
        const k = chip.dataset.kind;
        name.value = k === "Trip" ? "Spring break" : k === "Something else" ? "" : k;
        name.focus();
      };
    }
    on("[data-act=later]", clearUI);
    on("[data-act=savegoal]", async () => {
      if (!name.value.trim() || !(Number(amount.value) > 0)) return amount.focus();
      const { settings } = await getStore();
      await chrome.storage.local.set({ settings: { ...settings, goalName: name.value.trim(), goalAmount: String(Number(amount.value)) } });
      clearUI();
    });
  }

  // ---------- 05-07 Courtroom ----------

  async function courtTurn(stage, ctx, settings, onFallback) {
    if (settings.mode === "openrouter" || settings.mode === "anthropic") {
      try {
        const res = await Promise.race([
          chrome.runtime.sendMessage({ type: "court", stage, ctx }),
          wait(LIVE_TIMEOUT_MS).then(() => ({ ok: false, error: "The AI took too long." })),
        ]);
        if (res?.ok) return res.turn;
        throw new Error(res?.error || "No response");
      } catch (e) {
        log("Live court failed, using the script for this turn:", e.message);
        onFallback?.(e.message);
      }
    } else {
      await wait(650); // a beat so it doesn't feel instant
    }
    return globalThis.gicScripted(stage, ctx);
  }

  async function startTrial(item, settings, history) {
    const profile = profileFrom(settings, history);
    const short = globalThis.gicShortName(item.label);
    const transcript = [];
    const state = { answers: [], round: 1, totalRounds: flow.RULES.rounds, witnessCalled: false, witness: null };
    let warned = false;

    // E07 "Courtroom rounds": a battle-style stage (the judge at the bench, you
    // seen from behind), a status row, the judge's current line and your answer box.
    const pillars = [6.4, 19.5, 83.1, 96.2].map((x) => `<i class="pillar" style="left:calc(${x}% - 13px)"></i>`).join("");
    showPage(`
      <div class="topbar"><span id="round"></span><button class="chip-btn" data-act="leave">Leave trial ${ICON.x}</button></div>
      <div class="court-stage">
        <div class="battle">
          <div class="stage" id="stage" aria-hidden="true">
            ${pillars}<i class="floor"></i>
            ${img("ui/bench-shadow.svg", "bench-shadow")}
            <div class="judge-seat ${judge}">${img(`characters/${judge}.png`, "judge-art")}${img("ui/bench.svg", "bench")}</div>
            ${img("ui/your-shadow.svg", "you-shadow")}
            ${img(`characters/${defendantArt(settings)}.png`, "you-art")}
            <div class="tag judge-tag">
              <div class="tag-title"><b>The Judge</b><span>on the bench</span></div>
              <div class="patience"><small>PATIENCE</small><div class="pbar"><i id="patience"></i></div></div>
            </div>
            <div class="tag you-tag"><div class="tag-title"><b>You</b><span>the defendant</span></div></div>
            <span class="impact"><i></i><i></i><i></i></span>
            <span class="hmm">Hmm!</span>
          </div>
          <div class="status-row">
            <span class="verdict-chip" id="chip" hidden></span>
            <button type="button" class="transcript-btn" data-act="transcript" aria-expanded="false">${img("ui/clock.svg")}<span id="tcount">Transcript</span></button>
          </div>
          <div class="transcript" id="log" role="log" aria-label="Transcript" hidden></div>
          <div class="witness-card" id="witness" hidden></div>
          <div class="prompt" aria-live="polite">
            <small>THE JUDGE</small>
            <p id="prompt"></p>
            ${img("ui/next.svg", "next")}
          </div>
          <form class="composer" id="composer">
            <input id="answer" autocomplete="off" placeholder="Type your answer to the judge…" aria-label="Your answer to the judge" disabled />
            <button class="send" aria-label="Send" disabled>${img("ui/arrow.svg")}</button>
          </form>
        </div>
        <p class="fine">No right or wrong answers. The verdict is advice. You always decide.</p>
      </div>`, "court");

    const logEl = $("#log");
    const input = $("#answer");
    const send = $(".send");
    const roundEl = $("#round");
    const promptEl = $("#prompt");
    const witnessEl = $("#witness");
    const chipEl = $("#chip");
    const setRound = () => (roundEl.textContent = `Round ${state.round} of ${state.totalRounds}`);
    setRound();
    // The judge's patience follows the running score: good answers fill it, weak ones drain it.
    const setPatience = () => ($("#patience").style.width = `${Math.max(8, Math.min(100, 55 + flow.score(state) * 10))}%`);
    setPatience();
    on("[data-act=transcript]", (e) => {
      logEl.hidden = !logEl.hidden;
      e.currentTarget.setAttribute("aria-expanded", String(!logEl.hidden));
      logEl.scrollTop = logEl.scrollHeight;
    });

    // Flow: "Leave trial" (any round) -> back to cart, no verdict.
    on("[data-act=leave]", () => {
      state.left = true;
      logOutcome(item, "left", { where: "courtroom", transcript });
      pendingButton = null;
      clearUI();
      if (pageType() === "checkout") location.href = `${location.origin}/cart`;
    });

    const stage = $("#stage");
    const WHO = { judge: "The judge", defendant: "You", court: "The court" };
    // Every line goes into the transcript drawer. Only the latest judge line and
    // witness testimony are on screen.
    function record(role, text) {
      transcript.push({ role, text });
      const row = document.createElement("p");
      row.className = `line ${role}`;
      row.innerHTML = `<b>${esc(role === "witness" ? state.witness.name : WHO[role])}</b> ${esc(text)}`;
      logEl.appendChild(row);
      logEl.scrollTop = logEl.scrollHeight;
      $("#tcount").textContent = `Transcript · ${transcript.length} line${transcript.length === 1 ? "" : "s"}`;
    }
    function showWitness(body) {
      const w = state.witness;
      const extra = w.role.split(" · ").slice(1).join(" · ");
      witnessEl.className = `witness-card ${w.id}`;
      witnessEl.innerHTML = `<span class="w-icon">${img(w.id === "future" ? "ui/w-future.svg" : "ui/w-history.svg")}</span>
        <div class="testimony"><small>EXPERT WITNESS${extra ? ` · ${esc(extra.toUpperCase())}` : ""}</small><b>${esc(w.name)}</b>${body}</div>`;
      witnessEl.hidden = false;
      stage.classList.add("short");
    }
    function say(role, text) {
      record(role, text);
      if (role === "judge") promptEl.textContent = text;
      else if (role === "witness") showWitness(`<p>${esc(text)}</p>`);
      else if (role === "defendant") {
        // the witness steps down once you've answered their testimony
        witnessEl.hidden = true;
        stage.classList.remove("short");
        // impact marks next to you when you make your point
        stage.classList.remove("hit");
        void stage.offsetWidth;
        stage.classList.add("hit");
      }
    }
    // Key moments (witness, recess, ruling) and how your last answer landed show in the status chip.
    function chip(text, tone) {
      chipEl.hidden = false;
      chipEl.className = `verdict-chip ${tone}`;
      chipEl.innerHTML = `${tone === "good" ? img("ui/check.svg") : ""}<span>${esc(text)}</span>`;
    }
    function moment(text) {
      record("court", text);
      chip(text, "info");
    }
    const LANDED = {
      strong: ["That answer landed", "good"],
      good: ["That answer landed", "good"],
      neutral: ["Noted", "meh"],
      weak: ["That one didn't land", "bad"],
      impulse: ["Sounds like an impulse", "bad"],
    };
    function typing(who = "judge") {
      const dots = `<span class="dots"><i></i><i></i><i></i></span>`;
      if (who === "witness") showWitness(dots);
      else {
        stage.classList.add("thinking");
        promptEl.innerHTML = dots;
      }
      return () => stage.classList.remove("thinking");
    }
    const readPause = (t) => wait(Math.min(1400, 350 + t.length * 12));
    const fallbackNote = (err) => {
      if (warned) return;
      warned = true;
      moment(`AI court unavailable (${err}). Using the scripted court for now.`);
    };
    const ctx = (extra = {}) => ({
      item: { label: item.label, short, total: item.total, currency: item.currency, items: item.items, site: item.site },
      profile,
      transcript,
      answers: state.answers,
      round: state.round,
      rounds_planned: state.totalRounds,
      ...extra,
    });
    async function ask(stage, extra, who = "judge") {
      const stop = typing(who);
      try {
        return await courtTurn(stage, ctx(extra), settings, fallbackNote);
      } finally {
        stop();
      }
    }
    function openInput() {
      input.disabled = send.disabled = false;
      input.value = "";
      input.focus();
    }

    // Opening
    const open = await ask("open");
    say("judge", open.opening);
    await readPause(open.opening);
    say("judge", open.question);
    openInput();

    input.addEventListener("keydown", (e) => e.stopPropagation()); // keep the store's shortcuts out of it
    $("#composer").onsubmit = async (e) => {
      e.preventDefault();
      const answer = input.value.trim();
      if (!answer || input.disabled) return;
      input.disabled = send.disabled = true;
      input.value = "";
      say("defendant", answer);

      const r = await ask("answer", { answer, next_round: state.round + 1 });
      if (state.left) return;
      state.answers.push({ text: answer, strength: r.strength, engaged: r.engaged !== false, unsure: !!r.unsure, claim: r.claim });
      log("Answer scored", r.strength, r.claim, r.engaged ? "" : "(low effort)", "score", flow.score(state));
      setPatience();
      chip(...(LANDED[r.strength] || LANDED.neutral));
      say("judge", r.acknowledge);
      await readPause(r.acknowledge);

      const step = flow.next(state);
      if (step.action === "rule") {
        moment(step.moment);
        await wait(1200);
        if (state.left) return;
        return deliberate(item, settings, history, profile, state, transcript, ctx);
      }
      if (step.action === "witness") {
        moment(step.moment);
        state.witnessCalled = true;
        state.witness = flow.pickWitness(state);
        await wait(600);
        const w = await ask("witness", { witness: state.witness }, "witness");
        say("witness", w.says);
        await readPause(w.says);
        state.round += 1;
        setRound();
        const q = await ask("after_witness", { witness: state.witness });
        say("judge", q.question);
        return openInput();
      }
      if (step.action === "recess") {
        moment(step.moment);
        state.totalRounds += 1;
      }
      state.round += 1;
      setRound();
      say("judge", r.question);
      openInput();
    };
  }

  // ---------- 08 Deliberating ----------

  async function deliberate(item, settings, history, profile, state, transcript, ctx) {
    const verdict = flow.verdict(state);
    const n = state.answers.length;
    const steps = [
      [`Reviewing your ${n === 1 ? "answer" : `${n} answers`}`, `${n} answer${n === 1 ? "" : "s"} on the record`],
      state.witnessCalled ? ["Considering the expert testimony", state.witness.name] : null,
      ["Weighing need versus want", ""],
      [profile.goal ? `Checking it against your ${profile.goal.name} goal` : "Checking it against your savings", ""],
    ].filter(Boolean);
    showPage(`
      <div class="card-lg">
        <div class="rocking">${img("ui/scale.svg")}</div>
        <h2 class="h2 center">The court is deliberating…</h2>
        <p class="muted center">Hang tight, this takes a few seconds.</p>
        <ul class="checks">${steps.map(([t, s]) => `<li><span class="tick">${img("ui/tick.svg")}</span><span><b>${esc(t)}</b>${s ? `<small>${esc(s)}</small>` : ""}</span></li>`).join("")}</ul>
      </div>`, "centered");
    const reasonP = courtTurn("verdict", ctx({ verdict }), settings);
    // Paced so each check reads as real work: about 1.5s per step, then a beat.
    const items = [...layer.querySelectorAll(".checks li")];
    for (const li of items) {
      li.classList.add("active");
      await wait(1500);
      li.classList.replace("active", "done");
      await wait(250);
    }
    const { reason } = await reasonP;
    await wait(700);
    transcript.push({ role: "judge", text: reason });
    showVerdict(item, settings, history, profile, verdict, reason, transcript);
  }

  // ---------- 09 / 10 Verdict: "Save it" or "Go for it" ----------

  function showVerdict(item, settings, history, profile, verdict, reason, transcript) {
    const price = money(item.total, item.currency);
    const V = {
      save: { seal: `<div class="seal blue ring">${ICON.scale}</div>`, title: "Save it for later", box: "blue", primary: `Save ${price}`, secondary: "Appeal and buy anyway" },
      approve: { seal: `<div class="seal green ring">${ICON.check}</div>`, title: "Case approved", box: "green", primary: "Continue to checkout", secondary: "Actually, save it instead" },
    }[verdict];
    showPage(`
      <div class="card-lg">
        ${V.seal}
        <p class="kicker center">The court rules…</p>
        <h2 class="h1 center">${V.title}</h2>
        <div class="reason r-${V.box}">${esc(reason)}</div>
        ${goalLine(profile)}
        <button class="btn primary" data-act="primary">${esc(V.primary)}</button>
        <button class="btn ghost" data-act="secondary">${esc(V.secondary)}</button>
      </div>`, "centered");
    $("[data-act=primary]").focus();
    const record = { where: "courtroom", verdict, transcript };

    // Approved: straight back to checkout. "Totally okay, you thought it
    // through" is only for appealing a "Save it" ruling and buying anyway.
    on("[data-act=primary]", async () => {
      if (verdict === "save") return saveIt(item, settings, history, "courtroom", "page", transcript);
      await logOutcome(item, "approved", record);
      proceedWithPurchase();
    });
    on("[data-act=secondary]", async () => {
      if (verdict === "approve") return saveIt(item, settings, history, "courtroom", "page", transcript);
      await logOutcome(item, "bought", record);
      showTotallyOkay(profile);
    });
  }

  // ---------- 12 Totally okay ----------

  function showTotallyOkay(profile) {
    showPage(`
      <div class="card-lg">
        <h2 class="h1">Totally okay. You thought it through.</h2>
        <p class="muted">Buying things you want is part of the plan too. ${profile.goal ? "Your goal is right where you left it." : "Your savings are right where you left them."}</p>
        ${goalLine(profile)}
        <button class="btn primary" data-act="back">Back to checkout</button>
        <p class="fine center">The trial closes and the store's checkout continues.</p>
      </div>`, "centered");
    on("[data-act=back]", proceedWithPurchase);
  }

  // ---------- triggers ----------

  async function maybeCheckIn() {
    if (isCleared()) {
      log("Already went through a check-in in this tab in the last 20 minutes. Letting it through.");
      return false;
    }
    const { settings, history, neverItems } = await getStore();
    const item = scrapeItem();
    if (!item) {
      log("No item found on this page.", { page: pageType(), path: location.pathname });
      return false;
    }
    const skip = skipReason(settings, neverItems, item);
    if (skip) {
      log(`Skipping: ${skip}.`);
      return false;
    }
    log("Checking in on", item);
    showQuickCheck(item, settings, history);
    return true;
  }

  // Intercept "buy" clicks (capture phase, before the store's handlers).
  document.addEventListener(
    "click",
    async (e) => {
      if (e.composedPath().includes(host)) return; // clicks inside our own UI
      const btn = findBuyButton(e.target);
      if (!btn) return;
      log("Buy button clicked:", labelOf(btn));
      if (allowNextClick) {
        allowNextClick = false;
        return;
      }
      if (isCleared()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      pendingButton = btn;
      const shown = await maybeCheckIn();
      if (!shown) proceedWithPurchase(); // nothing to check, let it through
    },
    true
  );

  // Flow step 2: the nudge appears when you click a checkout button, not before.
  log("Loaded on", pageType() || "an untracked page", location.pathname);

  // ---------- icons ----------

  const svg = (body, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;
  const ICON = {
    scale: svg('<path d="M12 4v16M8 20h8M5 7h14M12 4l-1 3h2z"/><path d="M5 7l-3 6a3 3 0 0 0 6 0L5 7zM19 7l-3 6a3 3 0 0 0 6 0l-3-6z"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'stroke-width="2.4"'),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    arrow: svg('<path d="M9 6l6 6-6 6"/>'),
    flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
    plane: svg('<path d="M3 13l18-7-7 18-2.5-8.5z"/>'),
    shield: svg('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>'),
    laptop: svg('<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
  };

  // Confetti from the Figma "Saved" pop-up (x as % of a 340px card, y in px).
  const CONFETTI = [
    [11, 30, 20, "#224786"], [24, 76, -30, "#224786"], [79, 28, -15, "#C6CCD3"], [86, 84, 35, "#99B4A3"],
    [35, 17, -25, "#224786"], [68, 65, -40, "#C6CCD3"], [6, 86, 45, "#99B4A3"], [92, 43, -20, "#C19F7C"],
  ]
    .map(([x, y, r, c]) => `<i style="left:${x}%;top:${y}px;transform:rotate(${r}deg);background:${c}"></i>`)
    .join("");

  // ---------- styles (tokens from the Figma design system, "sampled from the $100 bill") ----------

  function CSS() {
    return `
:host { all: initial; }
* { box-sizing: border-box; }
#layer {
  --ink: #2B2F36; --seal: #62666F; --slate: #949AA5; --paper: #C6CCD3; --line: #DADADC;
  --bill: #F4F5F7; --white: #FFFFFF;
  --blue: #224786; --blue-tint: #E3E9F3;
  --green: #99B4A3; --green-deep: #3E5E4B; --green-tint: #E3ECE6;
  --gold: #C19F7C; --gold-deep: #7A5A3A; --gold-tint: #F3ECE4;
  font-family: Urbanist, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 14px; line-height: 1.45; color: var(--ink); -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; cursor: pointer; }
input { font: inherit; color: var(--ink); }
svg { width: 18px; height: 18px; flex: none; }

/* ---- shells ---- */
img { display: block; flex: none; }
.panel-wrap { padding: 16px; pointer-events: none; }
.panel-wrap.has-top { padding-top: 106px; }
.panel-box { position: relative; width: 340px; max-width: calc(100vw - 32px); pointer-events: auto; animation: in .22s ease-out; }
/* "Pop-up · banknote": ink outline plus an engraved border */
.panel {
  position: relative; max-height: calc(100vh - 32px); overflow: auto;
  background: var(--bill); border: 1px solid var(--ink); border-radius: 18px; padding: 26px 28px 28px;
  box-shadow: 0 16px 40px rgba(26,31,41,.16);
  display: flex; flex-direction: column; gap: 14px;
}
.has-top .panel { max-height: calc(100vh - 122px); }
.panel > * { position: relative; }
.panel > .engraved { position: absolute; inset: -1px; width: calc(100% + 2px); height: calc(100% + 2px); pointer-events: none; }
.page { position: fixed; inset: 0; background: var(--bill); overflow: auto; animation: fade .2s ease-out; }
.page.centered { display: grid; place-items: center; padding: 24px 16px; }
.card-lg {
  position: relative; width: 420px; max-width: 100%; background: var(--white); border: 1px solid var(--line);
  border-radius: 24px; padding: 32px 32px 28px; display: flex; flex-direction: column; gap: 16px; animation: in .25s ease-out;
}

/* ---- the judge leaning over the quick check ---- */
.peek { position: absolute; left: calc(50% - 89px); top: -90px; width: 178px; height: 110px; z-index: 2; pointer-events: none; }
.peek-head { position: absolute; left: 34px; top: 0; width: 110px; height: 80px; overflow: hidden; }
.peek-head img { width: 110px; height: auto; }
.peek.judge-2 .peek-head img { width: 100px; margin-left: 5px; }
.sleeve { position: absolute; top: 70px; width: 91px; height: 30px; border-radius: 15px; background: var(--robe); box-shadow: 0 3px 6px rgba(42,46,53,.25); }
.sleeve.l { left: 0; } .sleeve.r { left: 87px; }
.cuff { position: absolute; top: 70px; width: 8px; height: 30px; background: var(--cuff); border-block: 1px solid var(--robe); }
.cuff.l { left: 47px; } .cuff.r { left: 123px; }
.paw { position: absolute; top: 68px; width: 34px; height: 34px; border-radius: 17px; background: #FDA3A5; border: 1.6px solid #2A2E35; display: flex; gap: 4px; align-items: flex-end; justify-content: center; padding-bottom: 5.6px; }
.paw.l { left: 55px; } .paw.r { left: 89px; }
.paw i { width: 1.5px; height: 9px; border-radius: 1px; background: #2A2E35; }
.paw i:nth-child(2) { height: 10px; }
.peek { --robe: #2A2E35; --cuff: #FFFFFF; }
.peek.judge-2 { --robe: #27345A; --cuff: #9B2F3A; }
.hmph {
  position: absolute; left: 131px; top: 16px; white-space: nowrap; background: var(--white); border: 1px solid #DCDFE4;
  border-radius: 12px 12px 12px 4px; padding: 6px 12px; font-size: 13px; font-weight: 700; color: #2A2E35;
  filter: drop-shadow(0 2px 3px rgba(42,46,53,.12)); animation: in .3s .25s ease-out both;
}

/* ---- type ---- */
.h1 { margin: 0; font-size: 34px; line-height: 1.2; font-weight: 700; }
.h2 { margin: 0; font-size: 24px; line-height: 1.18; font-weight: 700; }
.h3 { margin: 0; font-size: 16px; line-height: 1.4; font-weight: 700; }
.question { display: flex; flex-direction: column; gap: 4px; }
.kicker { margin: 0; font-size: 14px; font-weight: 600; color: var(--blue); }
.muted { margin: 0; color: var(--seal); font-size: 14px; font-weight: 500; line-height: 1.4; }
.note { margin: 0; font-size: 13px; color: var(--seal); }
.tiny { font-size: 12px; font-weight: 600; color: var(--seal); }
.small { font-size: 13px; }
.fine { margin: 0; font-size: 13px; color: var(--seal); }
.center { text-align: center; align-self: center; }
.blue { color: #1E4384; font-weight: 600; }
.row-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

/* ---- cards ---- */
.card { background: var(--white); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
.panel-head { display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: #000; line-height: 1.4; }
.panel-head .icon-btn { position: absolute; right: -2px; top: -2px; }
.icon-btn { border: 0; background: none; padding: 2px; border-radius: 8px; display: grid; }
.icon-btn img { width: 18px; height: 18px; }
.icon-btn:hover { background: var(--white); }
.goal { display: flex; flex-direction: column; gap: 8px; }
.amount { display: flex; align-items: baseline; gap: 6px; }
.amount b { font-size: 38px; line-height: 1.18; font-weight: 700; color: var(--blue); }
.amount span { color: var(--seal); font-size: 14px; font-weight: 600; }
.bar { position: relative; height: 10px; border-radius: 5px; background: var(--line); overflow: hidden; }
.bar i { position: absolute; left: 0; top: 0; height: 100%; background: var(--blue); border-radius: inherit; transition: width .6s ease-out; }
.bar i.pre { opacity: .3; }
.bar-foot { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; color: var(--seal); }
.goal-line { display: flex; flex-direction: column; gap: 8px; font-weight: 600; font-size: 15px; }
.goal-line .bar { height: 8px; border-radius: 4px; }
.hint { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--gold-deep); }
.hint-icon { width: 22px; height: 22px; border-radius: 50%; background: var(--gold); display: grid; place-items: center; flex: none; }
.hint-icon img { width: 12px; height: 12px; }
.hint.box { background: var(--gold-tint); border-radius: 12px; padding: 12px 14px; gap: 10px; font-size: 14px; }
.hint.box .hint-icon { width: 28px; height: 28px; }
.hint.box .hint-icon img { width: 16px; height: 16px; }
.medallion { width: 68px; height: 80px; align-self: center; }
.wish { display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--seal); background: var(--white); }
.thumb { width: 34px; height: 34px; border-radius: 8px; background: var(--line); flex: none; }
.row-link { display: flex; align-items: center; gap: 12px; text-align: left; width: 100%; }
.row-link span { flex: 1; display: flex; flex-direction: column; }
.row-link small { color: var(--seal); font-size: 12px; }
.row-link:hover { border-color: var(--paper); }

/* ---- buttons (MM Button: primary / secondary / ghost) ---- */
.stack { display: flex; flex-direction: column; gap: 8px; }
.btn { position: relative; width: 100%; min-height: 48px; border-radius: 10px; padding: 12px 20px; font-weight: 600; font-size: 16px; line-height: 1.4; border: 1.5px solid transparent; }
.btn.primary { background: var(--ink); color: var(--white); }
.btn.primary:hover { background: #3a3f48; }
.btn.outline { background: transparent; border-color: var(--paper); }
.btn.outline:hover { border-color: var(--seal); }
.btn.ghost { background: none; font-size: 15px; font-weight: 500; color: var(--seal); }
.btn.ghost:hover { color: var(--ink); text-decoration: underline; }
.sticker {
  position: absolute; right: -8px; top: -14px; transform: rotate(4deg); display: inline-flex; align-items: center; gap: 4px;
  background: #C9A27E; border: 2px solid var(--white); border-radius: 12px; padding: 4px 10px; font-size: 12px; font-weight: 800; color: #2A2E35;
  filter: drop-shadow(0 2px 2px rgba(42,46,53,.15)); pointer-events: none;
}
.sticker img { width: 12px; height: 12px; }
.link { border: 0; background: none; padding: 4px; font-size: 13px; color: var(--seal); align-self: center; }
.link:hover { color: var(--ink); text-decoration: underline; }
.chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--paper); background: var(--white); border-radius: 99px; padding: 4px 11px; font-size: 13px; font-weight: 500; }
.chip svg { width: 14px; height: 14px; }
.chip.on { background: var(--blue-tint); border-color: var(--blue); color: var(--blue); }
.chip.gold { background: var(--gold-tint); border-color: transparent; color: var(--gold-deep); padding: 2px 9px; font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.btn:focus-visible, .link:focus-visible, .chip:focus-visible, .chip-btn:focus-visible, .icon-btn:focus-visible, .transcript-btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

/* ---- forms ---- */
.two { display: grid; grid-template-columns: 1.4fr 1fr; gap: 10px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--seal); }
label input { border: 1px solid var(--paper); border-radius: 10px; padding: 9px 11px; background: var(--white); outline: none; font-size: 14px; }
label input:focus { border-color: var(--blue); }

/* ---- seals ---- */
.seal { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; align-self: center; position: relative; }
.seal svg { width: 30px; height: 30px; }
.seal.blue { background: var(--blue); color: var(--white); }
.seal.green { background: var(--green); color: var(--green-deep); }
.seal.ring { margin: 5px 0; }
.seal.ring::after { content: ""; position: absolute; inset: -5.5px; border-radius: 50%; border: 1.5px dashed currentColor; }
.seal.blue.ring::after { border-color: var(--blue); }
.seal.green.ring::after { border-color: var(--green-deep); }
.confetti { position: absolute; inset: 0 0 auto; height: 110px; pointer-events: none; overflow: hidden; }
.panel > .confetti { position: absolute; }
.confetti i { position: absolute; width: 8px; height: 12px; border-radius: 2px; }

/* ---- verdict ---- */
.reason { border-radius: 12px; padding: 14px 16px; font-size: 15px; font-weight: 500; line-height: 1.4; }
.reason.r-blue { background: var(--blue-tint); }
.reason.r-green { background: var(--green-tint); }
.reason.r-plain { background: var(--bill); border: 1px solid var(--line); }

/* ---- deliberating ---- */
.page.centered .card-lg:has(.rocking) { width: 460px; padding: 36px 32px 32px; gap: 14px; }
.rocking { width: 92px; height: 92px; border-radius: 50%; background: var(--blue-tint); border: 2.5px dashed var(--blue); display: grid; place-items: center; align-self: center; }
.rocking img { width: 42px; height: 42px; animation: rock 1.6s ease-in-out infinite; }
.checks { list-style: none; margin: 0; padding: 8px 0 0; display: flex; flex-direction: column; gap: 12px; }
.checks li { display: flex; gap: 12px; align-items: flex-start; color: var(--slate); font-size: 15px; line-height: 1.4; }
.checks li > span:last-child { display: flex; flex-direction: column; gap: 2px; }
.checks li b { font-weight: 600; }
.checks li small { font-size: 13px; font-weight: 500; color: var(--seal); }
.tick { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--line); flex: none; display: grid; place-items: center; }
.tick img { width: 12px; height: 12px; opacity: 0; }
.checks li.active, .checks li.done { color: var(--ink); }
.checks li.active .tick { border: 2px dashed var(--blue); animation: spin 1.6s linear infinite; }
.checks li.done .tick { background: var(--blue); border-color: var(--blue); }
.checks li.done .tick img { opacity: 1; }

/* ---- courtroom (E07: battle stage) ---- */
.court { display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 13px 24px; font-size: 15px; color: var(--seal); }
.chip-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--paper); background: var(--white); border-radius: 10px; padding: 8px 14px; font-weight: 600; font-size: 14px; color: var(--ink); }
.chip-btn svg { width: 16px; height: 16px; }
.chip-btn:hover { border-color: var(--seal); }
.court-stage { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 8px 16px 28px; }
.battle { width: 660px; max-width: 100%; background: var(--white); border: 1px solid #DCDFE4; border-radius: 20px; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
.stage {
  position: relative; height: 340px; flex: none; overflow: hidden; background: #E3E9F4; border: 1px solid #C3CFE5; border-radius: 16px;
  transition: height .35s ease-out;
}
.stage.short { height: 260px; }
.stage > * { position: absolute; }
.pillar { top: -1px; width: 26px; height: 210px; background: #F3F6FB; border-inline: 1px solid #C3CFE5; }
.floor { left: -1px; right: -1px; top: 199px; bottom: 0; background: #F3F4F6; border-top: 2px solid #C3CFE5; }
.bench-shadow { right: 51px; top: 167px; width: 210px; height: 44px; }
.judge-seat { right: 81px; top: 47px; width: 150px; height: 140px; }
.judge-seat .bench { position: absolute; inset: 0; width: 150px; height: 140px; }
.judge-seat .judge-art { position: absolute; transform-origin: 50% 100%; transition: transform .25s ease-out; }
.judge-seat.judge-1 .judge-art { left: 15px; top: 2px; width: 120px; }
.judge-seat.judge-2 .judge-art { left: 23px; top: 0; width: 104px; }
.stage.thinking .judge-art { animation: ponder 1.2s ease-in-out infinite; }
.you-shadow { left: 9px; bottom: -39px; width: 280px; height: 80px; }
.you-art { left: 58px; bottom: -10px; height: 210px; width: auto; transition: bottom .35s ease-out; }
.stage.short .you-art { height: 180px; }
.stage.hit .you-art { animation: nudge .45s ease-out; }
.tag { background: var(--white); border: 2px solid #2A2E35; border-radius: 12px; padding: 8px 12px; filter: drop-shadow(3px 3px 0 #2A2E35); display: flex; flex-direction: column; gap: 6px; }
.tag-title { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
.tag-title b { font-size: 15px; font-weight: 900; color: #2A2E35; }
.tag-title span { font-size: 11px; font-weight: 700; color: #5B6270; }
.judge-tag { left: 13px; top: 13px; width: 210px; }
.you-tag { right: 13px; bottom: 17px; width: 220px; }
.patience { display: flex; flex-direction: column; gap: 4px; }
.patience small { font-size: 11px; font-weight: 800; letter-spacing: .06em; color: #5B6270; }
.pbar { position: relative; height: 8px; border-radius: 4px; background: #DCDFE4; overflow: hidden; }
.pbar i { position: absolute; inset: 0 auto 0 0; background: #C9A27E; transition: width .6s ease-out; }
.impact { left: 235px; top: 145px; display: flex; gap: 6px; transform: rotate(-8deg); opacity: 0; }
.impact i { width: 6px; height: 18px; border-radius: 3px; background: #1E4384; }
.impact i:nth-child(2) { height: 26px; }
.stage.hit .impact { animation: pop 1.1s ease-out; }
.stage.short .impact { top: 105px; }
.hmm { right: 69px; top: 25px; padding: 4px 10px; border-radius: 12px; background: #2A2E35; color: var(--white); font-size: 13px; font-weight: 900; transform: rotate(4deg) scale(.6); opacity: 0; transition: opacity .2s, transform .2s; }
.stage.thinking .hmm { opacity: 1; transform: rotate(4deg); }
.status-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; }
.verdict-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 12px; font-size: 13px; font-weight: 800; line-height: 1.25; animation: fade .3s ease-out; }
.verdict-chip img { width: 14px; height: 14px; }
.verdict-chip.good { background: #EAF1EB; color: #3F6B45; }
.verdict-chip.meh { background: var(--bill); color: var(--seal); }
.verdict-chip.bad { background: var(--gold-tint); color: var(--gold-deep); }
.verdict-chip.info { background: var(--blue-tint); color: #1E4384; }
.transcript-btn { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: 40px; padding: 0 14px; border-radius: 20px; background: var(--white); border: 1px solid #DCDFE4; font-size: 13px; font-weight: 700; color: #2A2E35; white-space: nowrap; }
.transcript-btn img { width: 14px; height: 14px; }
.transcript-btn:hover { border-color: var(--paper); }
.transcript { max-height: 180px; overflow-y: auto; border: 1px solid #DCDFE4; border-radius: 14px; padding: 10px 14px; background: var(--bill); display: flex; flex-direction: column; gap: 6px; }
.transcript[hidden] { display: none; }
.line { margin: 0; font-size: 13px; line-height: 1.4; color: #3E4450; }
.line b { color: #2A2E35; }
.line.court { color: var(--seal); font-style: italic; }
.witness-card { display: flex; gap: 12px; align-items: flex-start; padding: 12px 16px; border: 2px solid #2A2E35; border-radius: 14px; background: #F4ECE3; filter: drop-shadow(3px 3px 0 #2A2E35); animation: in .3s ease-out; }
.witness-card[hidden] { display: none; }
.witness-card.future { background: var(--white); }
.w-icon { width: 36px; height: 36px; border-radius: 18px; background: var(--white); border: 1.5px solid #2A2E35; display: grid; place-items: center; flex: none; }
.w-icon img { width: 18px; height: 18px; }
.testimony { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.testimony small { font-size: 12px; font-weight: 900; letter-spacing: .1em; color: #6B4A2B; }
.witness-card.future .testimony small { color: #1E4384; }
.testimony b { font-size: 16px; font-weight: 700; color: #2A2E35; }
.testimony p { margin: 0; font-size: 14px; font-weight: 500; line-height: 1.4; color: #3E4450; }
.prompt { position: relative; background: var(--white); border: 2px solid #2A2E35; border-radius: 14px; padding: 12px 16px 18px; filter: drop-shadow(0 4px 0 #2A2E35); display: flex; flex-direction: column; gap: 4px; }
.prompt small { font-size: 12px; font-weight: 900; letter-spacing: .1em; color: #1E4384; }
.prompt p { margin: 0; min-height: 23px; font-size: 18px; font-weight: 700; line-height: 1.3; color: #2A2E35; }
.prompt .next { position: absolute; right: 14px; bottom: 9px; width: 12px; height: 10px; animation: blink 1.2s infinite; }
.dots { display: inline-flex; gap: 4px; padding: 8px 0; }
.dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--slate); animation: blink 1s infinite; }
.dots i:nth-child(2) { animation-delay: .15s; }
.dots i:nth-child(3) { animation-delay: .3s; }
.composer { display: flex; gap: 10px; padding-top: 6px; }
.composer input { flex: 1; min-width: 0; height: 54px; border: 2px solid #2A2E35; border-radius: 14px; padding: 0 16px; font-size: 16px; font-weight: 500; outline: none; background: var(--white); }
.composer input::placeholder { color: #8A909C; }
.composer input:focus { border-color: var(--blue); }
.composer input:disabled { background: var(--bill); }
.send { width: 54px; height: 54px; flex: none; border: 0; border-radius: 14px; background: #2A2E35; display: grid; place-items: center; }
.send img { width: 20px; height: 20px; }
.send:disabled { opacity: .35; cursor: default; }

@keyframes in { from { opacity: 0; transform: translateY(6px); } }
@keyframes fade { from { opacity: 0; } }
@keyframes blink { 50% { opacity: .3; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes rock { 0%, 100% { transform: rotate(-10deg); } 50% { transform: rotate(10deg); } }
@keyframes ponder { 0%, 100% { transform: rotate(0); } 30% { transform: rotate(-3deg); } 70% { transform: rotate(3deg); } }
@keyframes nudge { 30% { transform: translateX(10px); } }
@keyframes pop { 0% { opacity: 0; transform: rotate(-8deg) scale(.4); } 20% { opacity: 1; transform: rotate(-8deg) scale(1.1); } 70% { opacity: 1; } 100% { opacity: 0; transform: rotate(-8deg); } }
@media (prefers-reduced-motion: reduce) { *, *::after { animation: none !important; transition: none !important; } }
@media (max-width: 600px) {
  .battle { padding: 14px; gap: 12px; }
  .stage { height: 280px; }
  .stage.short { height: 220px; }
  .judge-seat { right: 8px; top: 60px; transform: scale(.8); transform-origin: 100% 0; }
  .bench-shadow { right: -20px; top: 165px; }
  .you-art, .stage.short .you-art { left: 6px; height: 140px; }
  .you-shadow { left: -60px; }
  .impact { left: 150px; }
  .stage.short .impact { top: 90px; }
  .judge-tag { width: 170px; }
  .you-tag { width: auto; left: auto; right: 8px; bottom: 8px; padding: 5px 10px; }
  .judge-seat { top: 40px; }
  .hmm { right: 20px; }
  .prompt p { font-size: 16px; }
  .h1 { font-size: 28px; }
  .card-lg { padding: 24px 20px 20px; }
}
@media (max-height: 760px) { .stage { height: 240px; } .stage.short { height: 200px; } .stage .impact { top: 100px; } }
`;
  }
})();
