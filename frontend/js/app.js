import { api } from "./api.js";
import { icon } from "./icons.js";
import { $, esc, role, setRole, toast } from "./ui.js";
import { renderList } from "./views/list.js";
import { renderCard } from "./views/card.js";
import { renderAppeals } from "./views/appeals.js";
import { renderChecklists } from "./views/checklists.js";
import { renderAnalytics } from "./views/analytics.js";
import { renderSettings } from "./views/settings.js";
import { jobs } from "./jobs.js";

const NAV = [
  { section: "Контроль качества", items: [
    { hash: "#/", label: "Диалоги", icon: "inbox", match: /^#\/(c\/.*)?$/ },
    { hash: "#/appeals", label: "Апелляции", icon: "scale", match: /^#\/appeals/, badge: "appeals" },
    { hash: "#/analytics", label: "Аналитика", icon: "chart", match: /^#\/analytics/ },
  ] },
  { section: "Администрирование", items: [
    { hash: "#/checklists", label: "Чек-листы", icon: "clipboard", match: /^#\/checklists/ },
    { hash: "#/settings", label: "Настройки", icon: "settings", match: /^#\/settings/ },
  ] },
];

const ROLES = {
  supervisor: { label: "Супервайзер", icon: "user", initials: "СВ", desc: "Оценка и подача апелляций" },
  reviewer: { label: "Проверяющий", icon: "userCheck", initials: "ПР", desc: "Рассмотрение апелляций" },
};

const params = new URLSearchParams(location.search);
if (params.get("embed") === "1") document.body.classList.add("embed");
const roleParam = params.get("role");
if (roleParam === "reviewer" || roleParam === "supervisor") setRole(roleParam);

function shell() {
  const root = $("#cqa-app");
  root.innerHTML = `
    <div class="app">
      <aside class="sidebar" aria-label="Навигация">
        <a class="sb-brand" href="#/">
          <span class="sb-mark">${icon("shield", { size: 20 })}</span>
          <span class="sb-title"><small>Freedom Broker</small><b>Контроль качества</b></span>
        </a>
        <div id="nav"></div>
        <div class="sb-foot">
          <div class="sb-status" id="llm-status"><span class="dot"></span><span>Проверка модели…</span></div>
          <div class="sb-meta">CQA, версия 1.0</div>
        </div>
      </aside>
      <div class="main">
        <header class="appbar">
          <div class="crumbs" id="crumbs"></div>
          <div class="appbar-right">
            <div class="role-switch" role="group" aria-label="Роль пользователя">
              ${Object.entries(ROLES).map(([k, r]) => `<button type="button" data-set-role="${k}" title="${esc(r.desc)}">${icon(r.icon, { size: 15 })}${esc(r.label)}</button>`).join("")}
            </div>
            <div class="user-chip" id="user-chip"></div>
          </div>
        </header>
        <div id="job-bar"></div>
        <main id="view" class="view"></main>
      </div>
    </div>`;
  // Only the two role buttons switch the role (body carries data-role for styling and must not match here).
  root.querySelector(".role-switch").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-set-role]");
    if (!b || b.dataset.setRole === role()) return;
    setRole(b.dataset.setRole);
    paintRole();
    route();
    toast(`Роль: ${ROLES[b.dataset.setRole].label} — ${ROLES[b.dataset.setRole].desc.toLowerCase()}`);
  });
  paintRole();
}

function paintRole() {
  document.querySelectorAll("button[data-set-role]").forEach((b) => b.classList.toggle("active", b.dataset.setRole === role()));
  document.body.dataset.role = role();
  const r = ROLES[role()] || ROLES.supervisor;
  $("#user-chip").innerHTML = `<span class="avatar" title="${esc(r.label)}" aria-label="${esc(r.label)}">${r.initials}</span>`;
}

let badges = { appeals: 0 };
function paintNav() {
  const h = location.hash || "#/";
  $("#nav").innerHTML = NAV.map((g) => `
    <div class="sb-section">${esc(g.section)}</div>
    <nav class="sb-nav" aria-label="${esc(g.section)}">${g.items.map((n) => {
      const on = n.match.test(h);
      return `<a href="${n.hash}" class="nav-item ${on ? "active" : ""}" ${on ? 'aria-current="page"' : ""}>
        ${icon(n.icon, { size: 18 })}<span>${esc(n.label)}</span>
        ${n.badge && badges[n.badge] ? `<span class="nav-badge" title="Открытых апелляций">${badges[n.badge]}</span>` : ""}
      </a>`;
    }).join("")}</nav>`).join("");
}

function paintCrumbs() {
  const h = location.hash || "#/";
  let parts;
  let m;
  if ((m = h.match(/^#\/c\/([^/?]+)/))) parts = [["#/", "Диалоги"], [null, decodeURIComponent(m[1])]];
  else if (h.startsWith("#/appeals")) parts = [[null, "Апелляции"]];
  else if (h.startsWith("#/checklists")) parts = [[null, "Администрирование"], [null, "Чек-листы"]];
  else if (h.startsWith("#/analytics")) parts = [[null, "Аналитика"]];
  else if (h.startsWith("#/settings")) parts = [[null, "Администрирование"], [null, "Настройки"]];
  else parts = [[null, "Диалоги"]];
  $("#crumbs").innerHTML = parts.map(([href, label], i) => {
    const last = i === parts.length - 1;
    const sep = i ? icon("chevronRight", { size: 14 }) : "";
    return `${sep}${last ? `<b>${esc(label)}</b>` : href ? `<a href="${href}">${esc(label)}</a>` : `<span>${esc(label)}</span>`}`;
  }).join("");
}

async function refreshHealth() {
  const box = $("#llm-status");
  try {
    const h = await api.health();
    const where = h.provider === "ollama" ? "локально" : "API";
    if (h.llm.ok && h.model_available) {
      box.className = "sb-status ok";
      box.innerHTML = `<span class="dot"></span><span>Модель ${esc(h.model)}, ${where}</span>`;
    } else if (h.llm.ok) {
      box.className = "sb-status warn";
      box.innerHTML = `<span class="dot"></span><span>Модель ${esc(h.model)} не найдена</span>`;
    } else {
      box.className = "sb-status bad";
      box.innerHTML = `<span class="dot"></span><span>Модель недоступна</span>`;
    }
  } catch {
    box.className = "sb-status bad";
    box.innerHTML = `<span class="dot"></span><span>Сервер недоступен</span>`;
  }
}

async function refreshBadges() {
  try {
    const open = await api.appeals("open");
    if (open.length !== badges.appeals) { badges.appeals = open.length; paintNav(); }
  } catch { /* ignore */ }
}

let current = null;
let navSeq = 0;
async function route() {
  paintNav();
  paintCrumbs();
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
    if (token === navSeq) host.innerHTML = `<div class="empty">${icon("alert", { size: 28 })}<h3>Не удалось открыть страницу</h3><p>${esc(e.message)}</p></div>`;
  }
  if (token !== navSeq) {
    if (r && r.destroy) r.destroy();
    return;
  }
  current = r;
  window.scrollTo(0, 0);
  refreshBadges();
}

shell();
jobs.mount($("#job-bar"));
window.addEventListener("hashchange", route);
route();
refreshHealth();
refreshBadges();
setInterval(refreshHealth, 30000);
setInterval(refreshBadges, 20000);
