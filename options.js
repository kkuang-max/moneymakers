// Settings page (Figma "Settings" window). Every change saves right away.
const form = document.getElementById("form");
const status = document.getElementById("status");
const skipState = { skips: [...DEFAULT_SKIPS], custom: [] };

function flash(msg) {
  status.textContent = msg;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => (status.textContent = ""), 2500);
}

function showMode() {
  const mode = form.elements.mode.value;
  for (const el of document.querySelectorAll(".mode-fields")) el.hidden = el.dataset.mode !== mode;
}

// E17 (no goal yet): "Quick start" suggestions and a "Save goal" button.
// E18 (goal set): "Update goal" plus "Remove goal, just save".
function syncGoalMode(hasGoal) {
  document.getElementById("quickStart").hidden = hasGoal;
  document.getElementById("updateGoal").textContent = hasGoal ? "Update goal" : "Save goal";
  document.getElementById("removeGoal").hidden = !hasGoal;
}

async function save(msg = "Saved") {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const data = Object.fromEntries(new FormData(form));
  await chrome.storage.local.set({ settings: { ...settings, ...data, skipCategories: skipState.skips, skipCustom: skipState.custom.join(", ") } });
  flash(msg);
}

chrome.storage.local.get({ settings: {} }).then(({ settings }) => {
  if (settings.mode === "live") settings.mode = "openrouter"; // older builds
  for (const el of form.elements) {
    if (!el.name || settings[el.name] == null) continue;
    if (el.type === "radio") el.checked = el.value === settings[el.name];
    else el.value = settings[el.name];
  }
  skipState.skips = settings.skipCategories || [...DEFAULT_SKIPS];
  skipState.custom = splitCustom(settings.skipCustom);
  if (settings.mode && settings.mode !== "scripted") document.getElementById("dev").open = true;
  showMode();
  syncGoalMode(!!(settings.goalName && Number(settings.goalAmount)));
  renderSuggestions(document.getElementById("suggest"), { name: form.elements.goalName, amount: form.elements.goalAmount });
  renderSkipEditor(document.getElementById("skips"), skipState, () => save());
});

// Goal fields save with their buttons; everything else saves as you go.
const GOAL_FIELDS = ["goalName", "goalAmount", "goalDate"];
let timer;
form.addEventListener("input", (e) => {
  if (GOAL_FIELDS.includes(e.target.name) || !e.target.name) return;
  clearTimeout(timer);
  timer = setTimeout(save, 500);
});
form.elements.mode.addEventListener("change", () => {
  showMode();
  save();
});

document.getElementById("updateGoal").onclick = async () => {
  const hasGoal = !!(form.elements.goalName.value.trim() && Number(form.elements.goalAmount.value));
  if (form.elements.goalName.value.trim() && !hasGoal) return form.elements.goalAmount.focus();
  await save(hasGoal ? "Goal saved" : "Saved");
  syncGoalMode(hasGoal);
};
document.getElementById("removeGoal").onclick = async () => {
  for (const n of ["goalName", "goalAmount", "goalDate"]) form.elements[n].value = "";
  await save("Goal removed. Skips still add up.");
  syncGoalMode(false);
  form.elements.goalName.dispatchEvent(new Event("input"));
};

const closeTab = () => chrome.tabs.getCurrent((t) => (t ? chrome.tabs.remove(t.id) : window.close()));
document.getElementById("close").onclick = closeTab;
document.getElementById("back").onclick = () => (history.length > 1 ? history.back() : closeTab());

// Items you clicked "Never ask about this item" on, each removable.
async function renderNever() {
  const { neverItems } = await chrome.storage.local.get({ neverItems: [] });
  const box = document.getElementById("never");
  document.getElementById("neverBox").hidden = !neverItems.length;
  box.replaceChildren();
  for (const t of neverItems) {
    const tok = document.createElement("span");
    tok.className = "token";
    const label = document.createElement("span");
    label.textContent = t;
    tok.title = t;
    const x = document.createElement("button");
    x.type = "button";
    x.setAttribute("aria-label", `Ask about ${t} again`);
    x.innerHTML = '<img src="assets/ui/x-blue.svg" alt="" />';
    x.onclick = async () => {
      const { neverItems: all } = await chrome.storage.local.get({ neverItems: [] });
      await chrome.storage.local.set({ neverItems: all.filter((n) => n !== t) });
      renderNever();
      flash("Will ask about it again");
    };
    tok.append(label, x);
    box.append(tok);
  }
}
renderNever();

document.getElementById("reset").onclick = async () => {
  await chrome.storage.local.set({ history: [], recess: {}, wishlist: [], neverItems: [] });
  flash("History cleared");
};
