// Global evaluation-job tracker (progress bar under the top bar).
import { api } from "./api.js";
import { esc, toast } from "./ui.js";

const listeners = new Set();
let el = null;
let timer = null;
let active = new Map();

function fmtEta(s) {
  if (!s) return "";
  const m = Math.floor(s / 60);
  return m ? `≈ ${m} мин ${s % 60} с` : `≈ ${s} с`;
}

function paint() {
  if (!el) return;
  const list = [...active.values()];
  if (!list.length) { el.innerHTML = ""; return; }
  el.innerHTML = list.map((j) => {
    const pct = Math.round((j.done / Math.max(1, j.total)) * 100);
    const running = j.status === "running" || j.status === "queued";
    return `<div class="jobbar ${running ? "" : "done"}">
      <div class="jobbar-text">
        <b>${running ? "Идёт оценка" : "Оценка завершена"}</b>
        <span>${j.done} из ${j.total} · ${esc(j.checklist_name)} · ${esc(j.model || "")}</span>
        ${j.current ? `<span class="muted">сейчас: ${esc(j.current)} (критерий ${esc(j.current_criterion || "")})</span>` : ""}
        ${running && j.eta_seconds ? `<span class="muted">${fmtEta(j.eta_seconds)}, ~${j.avg_seconds} с/диалог</span>` : ""}
        ${j.failed ? `<span class="bad-text">ошибок: ${j.failed}</span>` : ""}
      </div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      ${running ? `<button class="btn btn-ghost btn-sm" data-cancel="${j.id}">Остановить</button>` : `<button class="btn btn-ghost btn-sm" data-dismiss="${j.id}">Скрыть</button>`}
    </div>`;
  }).join("");
}

async function poll() {
  const ids = [...active.keys()].filter((id) => ["queued", "running"].includes(active.get(id).status));
  if (!ids.length) { clearInterval(timer); timer = null; return; }
  for (const id of ids) {
    try {
      const prev = active.get(id);
      const j = await api.job(id);
      active.set(id, j);
      if (j.done !== prev.done || j.status !== prev.status) listeners.forEach((fn) => fn(j));
      if (j.status === "finished" && prev.status !== "finished") {
        const ok = j.items.filter((i) => i.status === "done").length;
        const cancelled = j.items.filter((i) => i.status === "cancelled").length;
        toast(`Оценка завершена: ${ok} из ${j.total}${cancelled ? `, отменено ${cancelled}` : ""}${j.failed ? `, ошибок ${j.failed}` : ""}`, j.failed || cancelled ? "warn" : "ok");
      }
    } catch { /* ignore transient errors */ }
  }
  paint();
}

export const jobs = {
  mount(node) {
    el = node;
    el.addEventListener("click", async (e) => {
      const c = e.target.closest("[data-cancel]");
      if (c) { await api.cancelJob(c.dataset.cancel); toast("Оценка будет остановлена после текущего диалога"); }
      const d = e.target.closest("[data-dismiss]");
      if (d) { active.delete(d.dataset.dismiss); paint(); }
    });
    // Restore running jobs after reload.
    api.jobs().then((list) => list.filter((j) => ["queued", "running"].includes(j.status)).forEach((j) => this.track(j))).catch(() => {});
  },
  track(job) {
    active.set(job.id, job);
    paint();
    if (!timer) timer = setInterval(poll, 1500);
  },
  onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  isBusy(conversationId) {
    for (const j of active.values()) {
      if (!["queued", "running"].includes(j.status)) continue;
      const it = j.items.find((i) => i.conversation_id === conversationId);
      if (it && ["queued", "running"].includes(it.status)) return true;
    }
    return false;
  },
};
