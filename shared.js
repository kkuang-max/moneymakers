// Pieces shared by the setup flow (welcome.html) and Settings (options.html).

const GOAL_SUGGESTIONS = [
  ["Spring break trip", 600],
  ["New laptop", 900],
  ["Concert tickets", 150],
  ["Emergency fund", 500],
];
const SKIP_CATEGORIES = ["groceries", "textbooks", "medicine", "bills", "gifts", "toiletries", "transit"];
const DEFAULT_SKIPS = ["groceries", "textbooks", "medicine"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// "Spring break trip $600" chips that fill in the goal fields.
function renderSuggestions(el, { name, amount, onPick }) {
  el.innerHTML = GOAL_SUGGESTIONS.map(([n, a]) => `<button type="button" data-name="${n}" data-amount="${a}">${n}<span>$${a}</span></button>`).join("");
  const sync = () => {
    for (const b of el.children) b.classList.toggle("on", b.dataset.name === name.value.trim() && b.dataset.amount === String(Number(amount.value)));
  };
  el.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    name.value = b.dataset.name;
    amount.value = b.dataset.amount;
    sync();
    onPick?.();
  };
  name.addEventListener("input", sync);
  amount.addEventListener("input", sync);
  sync();
  return sync;
}

// Skip-list chips plus "Add a product or store" with removable items.
// state = { skips: [...categories], custom: [...words] }
function renderSkipEditor(root, state, onChange) {
  const chips = root.querySelector(".chips");
  const input = root.querySelector("input");
  const tokens = root.querySelector(".tokens");
  const draw = () => {
    chips.innerHTML = SKIP_CATEGORIES.map(
      (k) => `<button type="button" class="chip${state.skips.includes(k) ? " on" : ""}" data-skip="${k}" aria-pressed="${state.skips.includes(k)}"><img src="assets/ui/chip-check.svg" alt="" />${cap(k)}</button>`
    ).join("");
    tokens.innerHTML = "";
    for (const w of state.custom) {
      const t = document.createElement("span");
      t.className = "token";
      t.textContent = w;
      const x = document.createElement("button");
      x.type = "button";
      x.setAttribute("aria-label", `Remove ${w}`);
      x.innerHTML = `<img src="assets/ui/x-blue.svg" alt="" />`;
      x.onclick = () => {
        state.custom = state.custom.filter((c) => c !== w);
        draw();
        onChange();
      };
      t.append(x);
      tokens.append(t);
    }
  };
  chips.onclick = (e) => {
    const k = e.target.closest("[data-skip]")?.dataset.skip;
    if (!k) return;
    state.skips = state.skips.includes(k) ? state.skips.filter((s) => s !== k) : [...state.skips, k];
    draw();
    onChange();
  };
  const add = () => {
    const words = input.value.split(",").map((s) => s.trim()).filter(Boolean);
    if (!words.length) return;
    state.custom = [...new Set([...state.custom, ...words])];
    input.value = "";
    draw();
    onChange();
  };
  root.querySelector("[data-add]")?.addEventListener("click", add);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  });
  draw();
}

// "Groceries, Textbooks, Medicine and 2 more"
function skipSummary(skips, custom = []) {
  const all = [...SKIP_CATEGORIES.filter((k) => skips.includes(k)).map(cap), ...custom];
  if (!all.length) return "Nothing yet";
  return all.length <= 3 ? all.join(", ").replace(/, ([^,]*)$/, " and $1") : `${all.slice(0, 3).join(", ")} and ${all.length - 3} more`;
}

const splitCustom = (s) => String(s || "").split(",").map((w) => w.trim()).filter(Boolean);
const shortDate = (iso) => (iso ? new Date(`${iso}T00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
