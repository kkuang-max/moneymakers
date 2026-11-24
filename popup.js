// Toolbar popup (Figma "Home window": E15 no goal, E16 goal set): goal or savings, stats, recent cases.
const $ = (id) => document.getElementById(id);
const money = (n) => (n == null ? "" : Number.isInteger(+n) ? `$${+n}` : `$${(+n).toFixed(2)}`);
const NAMES = { judge: "The judge", witness: "Expert witness", defendant: "You", court: "The court" };

$("settings").onclick = () => chrome.runtime.openOptionsPage();
$("close").onclick = () => window.close();
$("setGoal").onclick = () => chrome.runtime.openOptionsPage();

const isSave = (h) => h.outcome === "saved" || h.outcome === "kept";

async function render() {
  const { history, settings } = await chrome.storage.local.get({ history: [], settings: {} });
  const saved = (Number(settings.savedSoFar) || 0) + history.filter(isSave).reduce((t, h) => t + (h.total || 0), 0);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  $("month").textContent = money(history.filter((h) => isSave(h) && h.date >= monthStart).reduce((t, h) => t + (h.total || 0), 0));
  $("cases").textContent = history.filter((h) => h.where === "courtroom").length;

  const target = Number(settings.goalAmount) || 0;
  const main = $("main");
  if (settings.goalName && target) {
    $("cta").hidden = true;
    const pct = Math.min(100, Math.round((saved / target) * 100));
    const by = settings.goalDate ? ` · by ${shortDate(settings.goalDate)}` : "";
    main.innerHTML = `<span class="tiny">Your goal</span><span class="big"></span><div class="bar"><i style="width:${pct}%"></i></div>
      <div class="row"><span class="blue">${money(saved)} saved</span><span class="muted">${money(Math.max(target - saved, 0))} to go${by}</span></div>`;
    main.querySelector(".big").textContent = settings.goalName;
  } else {
    // No goal: savings toward the next $100 milestone, plus the "Saving for something?" prompt.
    $("cta").hidden = false;
    const next = (Math.floor(saved / 100) + 1) * 100;
    main.innerHTML = `<span class="tiny">Your savings</span><span class="big">${money(saved)} saved</span><div class="bar"><i style="width:${Math.round((saved / next) * 100)}%"></i></div>
      <div class="row"><span class="blue">Next milestone ${money(next)}</span><span class="muted">${money(next - saved)} to go</span></div>`;
    const sug = $("suggest");
    sug.innerHTML = GOAL_SUGGESTIONS.map(([n, a]) => `<button type="button" data-name="${n}" data-amount="${a}">${n}<span>$${a}</span></button>`).join("");
    sug.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      await chrome.storage.local.set({ settings: { ...settings, goalName: b.dataset.name, goalAmount: b.dataset.amount } });
      render();
    };
  }

  $("recentTitle").hidden = $("history").hidden = !history.length;
  if (!history.length) return;
  const list = $("history");
  list.innerHTML = "";
  for (const h of history.slice(0, 8)) {
    const [icon, cls, tag, tagCls] =
      isSave(h) ? ["case-saved.svg", "", `Saved ${money(h.total)}`, "blue"]
      : h.outcome === "approved" ? ["case-approved.svg", "green", "Case approved", "green"]
      : h.outcome === "never" ? ["close-18.svg", "plain", "Won't ask again", ""]
      : h.outcome === "not now" ? ["close-18.svg", "plain", "Not now", ""]
      : h.outcome === "left" ? ["close-18.svg", "plain", "Left trial", ""]
      : ["case-approved.svg", "plain", "Bought", ""];
    const li = document.createElement("li");
    const when = new Date(h.date).toDateString() === new Date().toDateString() ? "Today" : new Date(h.date).toLocaleDateString([], { month: "short", day: "numeric" });
    const where = h.where === "courtroom" ? "Courtroom" : isSave(h) ? "Skipped at checkout" : "Checkout";
    li.innerHTML = `<span class="ic ${cls}"><img src="assets/ui/${icon}" alt="" /></span><span class="t"><b></b><span>${when} · ${where}</span></span><span class="tag ${tagCls}">${tag}</span>`;
    li.querySelector("b").textContent = h.title;
    li.title = "Show transcript";
    li.tabIndex = 0;
    li.onclick = li.onkeydown = (e) => (e.type === "click" || e.key === "Enter") && showTranscript(h);
    list.appendChild(li);
  }
}
render();

function showTranscript(h) {
  const tx = $("tx");
  const lines = h.transcript || [];
  tx.innerHTML = "";
  if (!lines.length) tx.append(Object.assign(document.createElement("p"), { textContent: "No courtroom transcript for this one." }));
  for (const l of lines) {
    const p = document.createElement("p");
    if (l.role === "court") {
      p.className = "court";
      p.textContent = l.text;
    } else {
      const b = document.createElement("b");
      b.textContent = `${NAMES[l.role] || l.role}: `;
      p.append(b, l.text);
    }
    tx.append(p);
  }
  if (lines.length) {
    const plain = [`${h.title} (${money(h.total) || "no price"}) -> ${h.verdict || ""} / ${h.outcome}`, ...lines.map((l) => (l.role === "court" ? `[${l.text}]` : `${NAMES[l.role] || l.role}: ${l.text}`))].join("\n");
    const copy = Object.assign(document.createElement("button"), { className: "btn small", textContent: "Copy transcript" });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(plain);
      copy.textContent = "Copied";
    };
    tx.append(copy);
  }
  tx.hidden = false;
  tx.scrollIntoView({ block: "nearest" });
}
