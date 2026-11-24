// First-time setup (Figma "Setup pages", S1-S5). Opens in a tab right after install.
// S1 welcome -> S2 goal (optional) -> S3 skip list -> S4 all set -> S5 "lives in the toolbar".
const app = document.getElementById("app");
const state = { step: 0, goalName: "", goalAmount: "", goalDate: "", skips: [...DEFAULT_SKIPS], custom: [] };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

chrome.storage.local.get({ settings: {} }).then(({ settings }) => {
  Object.assign(state, {
    goalName: settings.goalName || "",
    goalAmount: settings.goalAmount || "",
    goalDate: settings.goalDate || "",
    skips: settings.skipCategories || [...DEFAULT_SKIPS],
    custom: splitCustom(settings.skipCustom),
  });
  render();
});

async function save() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    settings: {
      ...settings,
      goalName: state.goalName,
      goalAmount: state.goalAmount,
      goalDate: state.goalDate,
      skipCategories: state.skips,
      skipCustom: state.custom.join(", "),
      setupDone: state.step >= 4 || !!settings.setupDone,
    },
  });
}

const go = (step) => {
  state.step = step;
  render();
  window.scrollTo(0, 0);
};

const stepHeader = (n) => `<div class="top">
  <button class="back-circle" data-back aria-label="Back"><img src="assets/ui/back-18.svg" alt="" /></button>
  <div class="progress">${[1, 2, 3].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}<span>Step ${n} of 3</span></div>
</div>`;
const backLink = `<button class="text-back" data-back><img src="assets/ui/back-16.svg" alt="" />Back</button>`;

const STEPS = [
  // S1 · Welcome
  () => `<section class="setup center">
    <img class="logo" src="assets/ui/logo.svg" alt="" />
    <h1>Welcome to Money Makers</h1>
    <p class="lead">A quick, friendly check before you buy. Skip what you don’t need, and watch your savings grow.</p>
    <div class="how">
      <div><span class="ic"><img src="assets/ui/bag.svg" alt="" /></span><b>We check in at checkout</b><p>Only when you’re about to buy, never while you browse.</p></div>
      <div><span class="ic"><img src="assets/ui/scale-22.svg" alt="" /></span><b>You make the call</b><p>Save it, or make your case to the judge. You always decide.</p></div>
      <div><span class="ic"><img src="assets/ui/flag.svg" alt="" /></span><b>Skips become savings</b><p>Every “not today” adds up toward what you really want.</p></div>
    </div>
    <button class="btn primary" data-next>Get started</button>
  </section>`,

  // S2 · Goal (optional)
  () => `<section class="setup">
    ${stepHeader(1)}
    <h1>What are you saving for?</h1>
    <p class="lead">A goal makes every skip feel like progress. It’s optional, and you can change it anytime.</p>
    <div class="pick"><span class="tiny">Pick one to start</span><div class="suggest" id="suggest"></div></div>
    <div class="fields">
      <label class="field">Goal<input id="gname" placeholder="Spring break trip" value="${esc(state.goalName)}" /></label>
      <label class="field">Amount<input id="gamount" type="number" min="1" step="1" placeholder="600" value="${esc(state.goalAmount)}" /></label>
      <label class="field">By<input id="gdate" type="date" value="${esc(state.goalDate)}" /></label>
    </div>
    <div class="nav">${backLink}<div class="right"><button class="btn ghost" data-skip-goal>Skip, I’ll just save</button><button class="btn primary" data-next>Continue</button></div></div>
  </section>`,

  // S3 · Skip list
  () => `<section class="setup">
    ${stepHeader(2)}
    <h1>What should we never ask about?</h1>
    <p class="lead">Essentials won’t trigger a check-in. Pick from the list or add your own.</p>
    <div id="skips">
      <div class="chips"></div>
      <div class="add-row" style="margin-top:18px"><label class="field">Add a product or store<input placeholder="Contact lenses, Chegg" /></label><button class="btn secondary" type="button" data-add>Add</button></div>
      <div class="tokens" style="margin-top:12px"></div>
    </div>
    <div class="nav">${backLink}<div class="right"><button class="btn primary" data-next>Continue</button></div></div>
  </section>`,

  // S4 · All set
  () => {
    const amount = Number(state.goalAmount);
    const goal =
      state.goalName && amount
        ? `<div class="card goal-card"><span class="tiny">Your goal</span><span class="name">${esc(state.goalName)}</span><div class="bar"><i style="width:0"></i></div>
            <div class="row"><span class="blue">$0 of $${amount}</span><span class="muted">${state.goalDate ? `by ${shortDate(state.goalDate)}` : ""}</span></div></div>`
        : `<div class="card goal-card"><span class="tiny">Your savings</span><span class="name">$0 saved</span><div class="bar"><i style="width:0"></i></div>
            <div class="row"><span class="blue">Next milestone $100</span><span class="muted">No goal yet, that’s fine</span></div></div>`;
    return `<section class="setup center">
      ${stepHeader(3)}
      <span class="check-coin"><img src="assets/ui/check-34.svg" alt="" /></span>
      <h1>You’re all set</h1>
      <p class="lead">Next time you check out, we’ll pop in with a quick check. That’s it.</p>
      ${goal}
      <div class="tip"><span class="ic"><img src="assets/ui/check-16.svg" alt="" /></span><span><b>Never asks about</b> ${esc(skipSummary(state.skips, state.custom))}</span></div>
      <div class="tip"><span class="ic"><img src="assets/ui/pin.svg" alt="" /></span><span><b>Pin the jar</b> to your toolbar so your savings are one click away</span></div>
      <button class="btn primary wide" data-next>Finish setup</button>
    </section>`;
  },

  // S5 · Lives in the toolbar
  () => `<div class="done-page">
    <span class="ghost-title">You’re ready</span>
    <div class="search">Head to a store and check out as usual</div>
    <div class="coach" role="dialog" aria-label="Money Makers lives here">
      <img class="pointer" src="assets/ui/pointer.svg" alt="" />
      <div class="box">
        <b>Money Makers lives here</b>
        <p>Click the jar anytime to see your savings or change your goal. We’ll pop up on our own when you’re about to check out.</p>
        <button data-close>Got it</button>
      </div>
    </div>
  </div>`,
];

function render() {
  app.innerHTML = STEPS[state.step]();
  const $ = (s) => app.querySelector(s);
  for (const b of app.querySelectorAll("[data-back]")) b.onclick = () => go(state.step - 1);

  if (state.step === 1) {
    const name = $("#gname"), amount = $("#gamount"), date = $("#gdate");
    renderSuggestions($("#suggest"), { name, amount });
    const keep = () => Object.assign(state, { goalName: name.value.trim(), goalAmount: amount.value ? String(Number(amount.value)) : "", goalDate: date.value });
    for (const el of [name, amount, date]) el.addEventListener("input", keep);
    $("[data-skip-goal]").onclick = () => {
      Object.assign(state, { goalName: "", goalAmount: "", goalDate: "" });
      go(2);
    };
    $("[data-next]").onclick = () => {
      keep();
      if (state.goalName && !(Number(state.goalAmount) > 0)) return amount.focus();
      go(2);
    };
    return;
  }
  if (state.step === 2) renderSkipEditor($("#skips"), state, () => {});
  if (state.step === 4) {
    save();
    $("[data-close]").onclick = () => chrome.tabs.getCurrent((t) => (t ? chrome.tabs.remove(t.id) : window.close()));
    $("[data-close]").focus();
    return;
  }
  $("[data-next]").onclick = async () => {
    if (state.step === 3) await save();
    go(state.step + 1);
  };
}
