// Small UI helpers shared by views.
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function toast(msg, kind = "info", ms = 3500) {
  let box = $("#toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add("hide"), ms);
  setTimeout(() => el.remove(), ms + 400);
}

export function fmtScore(v) {
  if (v === null || v === undefined) return "—";
  return Number(v).toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function scoreClass(v) {
  if (v === null || v === undefined) return "s-none";
  if (v >= 85) return "s-good";
  if (v >= 60) return "s-mid";
  return "s-bad";
}

export function scoreBadge(v, extra = "") {
  return `<span class="score ${scoreClass(v)} ${extra}">${fmtScore(v)}</span>`;
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function fmtDuration(sec) {
  if (sec === null || sec === undefined) return "";
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m} мин ${s} с` : `${s} с`;
}

export const LANG = { RU: "RU", KZ: "KZ", EN: "EN" };
export const SPEAKER = { client: "Клиент", operator: "Оператор", bot: "Бот", system: "Система" };

export function channelLabel(ch) {
  if (!ch) return "";
  return ch.toLowerCase().startsWith("voice") ? "Звонок" : "Чат";
}

export function answerChip(answer, label, type) {
  let cls = "chip";
  if (answer === null || answer === undefined) cls += " chip-none";
  else if (answer === "na") cls += " chip-na";
  else if (type === "flag") cls += answer === "yes" ? " chip-bad" : " chip-good";
  else if (answer === "yes") cls += " chip-good";
  else if (answer === "no") cls += " chip-bad";
  else cls += " chip-scale";
  return `<span class="${cls}">${esc(label ?? answer ?? "—")}</span>`;
}

export function answerOptions(criterion) {
  const opts = [];
  if (criterion.type === "scale") {
    [...criterion.scale].sort((a, b) => b.value - a.value).forEach((s) => opts.push({ value: String(s.value), label: `${s.value} — ${s.description}` }));
  } else if (criterion.type === "flag") {
    opts.push({ value: "yes", label: "Да — нарушение выявлено" }, { value: "no", label: "Нет — нарушений нет" });
  } else {
    opts.push({ value: "yes", label: "Да" }, { value: "no", label: "Нет" });
  }
  if (criterion.na_allowed && criterion.type !== "flag") opts.push({ value: "na", label: "N/A — неприменимо" });
  return opts;
}

export function answerText(criterion, answer) {
  if (answer === null || answer === undefined) return "—";
  if (answer === "na") return "N/A";
  if (criterion.type === "scale") {
    const top = Math.max(...criterion.scale.map((s) => s.value));
    return `${answer} из ${top}`;
  }
  if (criterion.type === "flag") return answer === "yes" ? "Да (нарушение)" : "Нет";
  return answer === "yes" ? "Да" : "Нет";
}

export function modal(html, { wide = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.innerHTML = `<div class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-close]")) close(); });
  document.addEventListener("keydown", function onKey(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } });
  return { el: wrap.firstElementChild, close };
}

export function role() {
  try { return localStorage.getItem("cqa-role") || "supervisor"; } catch { return "supervisor"; }
}

export function setRole(r) {
  try { localStorage.setItem("cqa-role", r); } catch { /* ignore */ }
}

export function spinner(text = "Загрузка…") {
  return `<div class="loading"><span class="spin"></span>${esc(text)}</div>`;
}
