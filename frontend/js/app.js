import { api } from "./api.js";
import { $, esc, role, setRole, toast } from "./ui.js";
import { renderList } from "./views/list.js";
import { renderCard } from "./views/card.js";
import { renderAppeals } from "./views/appeals.js";
import { renderChecklists } from "./views/checklists.js";
import { renderAnalytics } from "./views/analytics.js";
import { renderSettings } from "./views/settings.js";
import { jobs } from "./jobs.js";

const NAV = [
  { hash: "#/", label: "Диалоги", match: /^#\/(c\/.*)?$/ },
  { hash: "#/appeals", label: "Апелляции", match: /^#\/appeals/ },
  { hash: "#/checklists", label: "Чек-листы", match: /^#\/checklists/ },
  { hash: "#/analytics", label: "Аналитика", match: /^#\/analytics/ },
  { hash: "#/settings", label: "Настройки", match: /^#\/settings/ },
];

function shell() {
  const root = $("#cqa-app");
  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/">
        <span class="brand-mark">✓</span>
        <span><b>CQA</b><small>Conversation Quality Analytics</small></span>
      </a>
      <nav class="nav" id="nav"></nav>
      <div class="topbar-right">
        <span class="llm-pill" id="llm-pill" title="Статус модели">модель…</span>
        <div class="role-switch" role="group" aria-label="Роль">
          <button data-set-role="supervisor">Супервайзер</button>
          <button data-set-role="reviewer">Проверяющий</button>
        </div>
      </div>
    </header>
    <div id="job-bar"></div>
    <main id="view" class="view"></main>`;
  // Only the two role buttons switch the role (body carries data-role for styling and must not match here).
  root.querySelector(".role-switch").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-set-role]");
    if (!b || b.dataset.setRole === role()) return;
    setRole(b.dataset.setRole);
    paintRole();
    route();
    toast(b.dataset.setRole === "reviewer" ? "Роль: Проверяющий — рассмотрение апелляций" : "Роль: Супервайзер — оценка и подача апелляций");
  });
  paintRole();
}

function paintRole() {
  document.querySelectorAll("button[data-set-role]").forEach((b) => b.classList.toggle("active", b.dataset.setRole === role()));
  document.body.dataset.role = role();
}

function paintNav() {
  const h = location.hash || "#/";
  $("#nav").innerHTML = NAV.map((n) => `<a href="${n.hash}" class="${n.match.test(h) ? "active" : ""}">${esc(n.label)}</a>`).join("");
}

async function refreshHealth() {
  const pill = $("#llm-pill");
  try {
    const h = await api.health();
    if (h.llm.ok && h.model_available) {
      pill.className = "llm-pill ok";
      pill.textContent = `${h.provider === "ollama" ? "Локально" : "API"} · ${h.model}`;
    } else if (h.llm.ok) {
      pill.className = "llm-pill warn";
      pill.textContent = `Модель ${h.model} не найдена`;
    } else {
      pill.className = "llm-pill bad";
      pill.textContent = "LLM недоступна";
    }
  } catch {
    pill.className = "llm-pill bad";
    pill.textContent = "сервер недоступен";
  }
}

let current = null;
let navSeq = 0;
async function route() {
  paintNav();
  const h = location.hash || "#/";
  const main = $("#view");
  if (current && current.destroy) current.destroy();
  current = null;
  const token = ++navSeq;
  // Each navigation renders into its own container; a slower, superseded render is discarded instead of
  // overwriting the page the user has already moved to.
  const host = document.createElement("div");
  main.replaceChildren(host);
  let m, r = null;
  try {
    if ((m = h.match(/^#\/c\/([^/?]+)(?:\?e=(\d+))?/))) r = await renderCard(host, decodeURIComponent(m[1]), m[2] ? Number(m[2]) : null);
    else if (h.startsWith("#/appeals")) r = await renderAppeals(host, h);
    else if (h.startsWith("#/checklists")) r = await renderChecklists(host);
    else if (h.startsWith("#/analytics")) r = await renderAnalytics(host);
    else if (h.startsWith("#/settings")) r = await renderSettings(host);
    else r = await renderList(host);
  } catch (e) {
    if (token === navSeq) host.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`;
  }
  if (token !== navSeq) {
    if (r && r.destroy) r.destroy();
    return;
  }
  current = r;
  window.scrollTo(0, 0);
}

const roleParam = new URLSearchParams(location.search).get("role");
if (roleParam === "reviewer" || roleParam === "supervisor") setRole(roleParam);
shell();
jobs.mount($("#job-bar"));
window.addEventListener("hashchange", route);
route();
refreshHealth();
setInterval(refreshHealth, 30000);
