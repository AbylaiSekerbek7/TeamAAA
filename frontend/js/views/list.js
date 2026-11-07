import { api } from "../api.js";
import { $, $$, channelLabel, esc, fmtDate, scoreBadge, spinner, toast } from "../ui.js";
import { jobs } from "../jobs.js";

const state = {
  lang: "all", channel: "all", status: "all", dataset: "all", q: "",
  selected: new Set(),
  checklist: "auto",
  groupId: "DEV",
};

function filtered(rows) {
  return rows.filter((r) => {
    if (state.lang !== "all" && r.language !== state.lang) return false;
    if (state.channel !== "all" && channelLabel(r.channel) !== state.channel) return false;
    if (state.dataset !== "all" && r.dataset !== state.dataset) return false;
    if (state.status === "new" && (r.eval_status || r.done_status)) return false;
    if (state.status === "done" && r.done_status !== "done") return false;
    if (state.status === "appeal" && !r.appeals_open) return false;
    if (state.status === "gross" && !r.final_gross_error) return false;
    if (state.q && !r.id.toLowerCase().includes(state.q.toLowerCase())) return false;
    return true;
  });
}

function statusCell(r) {
  if (jobs.isBusy(r.id) || r.eval_status === "running" || r.eval_status === "queued") return `<span class="tag tag-run">оценивается…</span>`;
  const last = r.eval_status && r.eval_status !== "done"
    ? ` <span class="tag ${r.eval_status === "error" ? "tag-bad" : ""}" title="${esc(r.last_error || "")}">последний запуск: ${r.eval_status === "error" ? "ошибка" : "отменён"}</span>` : "";
  if (r.done_status !== "done") return (last || `<span class="tag">не оценён</span>`);
  return `<span class="muted small">${fmtDate(r.finished_at)}</span>${last}`;
}

function seg(name, value, options) {
  return `<div class="seg" data-seg="${esc(name)}">${options.map(([v, l]) => `<button data-v="${esc(v)}" class="${state[name] === v ? "active" : ""}">${esc(l)}</button>`).join("")}</div>`;
}

export async function renderList(view) {
  view.innerHTML = spinner();
  let rows = [];
  let checklists = [];
  let byChannel = {};

  async function load() {
    [rows, checklists, byChannel] = await Promise.all([api.conversations(), api.checklists(), api.checklistsByChannel()]);
  }
  await load();

  function paint() {
    const list = filtered(rows);
    const datasets = [...new Set(rows.map((r) => r.dataset).filter(Boolean))];
    const allSel = list.length && list.every((r) => state.selected.has(r.id));
    const evaluated = rows.filter((r) => r.final_total !== null && r.final_total !== undefined);
    const avg = evaluated.length ? evaluated.reduce((s, r) => s + r.final_total, 0) / evaluated.length : null;
    view.innerHTML = `
      <section class="page-head">
        <div>
          <h1>Диалоги</h1>
          <p class="muted">${rows.length} диалогов · оценено ${evaluated.length}${avg !== null ? ` · средний балл ${avg.toFixed(2)}` : ""} · грубых ошибок ${rows.filter((r) => r.final_gross_error).length}</p>
        </div>
        <div class="head-actions">
          <div class="inline-form">
            <input id="group-id" class="input" value="${esc(state.groupId)}" placeholder="group_id" aria-label="group_id">
            <button class="btn" id="fetch-btn">Загрузить набор из API</button>
          </div>
          <label class="btn btn-ghost">Загрузить JSON-файл<input type="file" id="file-in" accept=".json,application/json" hidden></label>
        </div>
      </section>

      ${rows.length === 0 ? `<div class="empty"><h3>Диалогов пока нет</h3><p>Загрузите набор из API организаторов (group_id, например <b>DEV</b>) или JSON-файл с транскриптами.</p></div>` : `
      <section class="toolbar">
        ${seg("lang", state.lang, [["all", "Все языки"], ["RU", "RU"], ["KZ", "KZ"], ["EN", "EN"]])}
        ${seg("channel", state.channel, [["all", "Все каналы"], ["Чат", "Чаты"], ["Звонок", "Звонки"]])}
        ${seg("status", state.status, [["all", "Все"], ["new", "Не оценены"], ["done", "Оценены"], ["appeal", "Апелляции"], ["gross", "Грубые ошибки"]])}
        ${datasets.length > 1 ? seg("dataset", state.dataset, [["all", "Все наборы"], ...datasets.map((d) => [d, d])]) : ""}
        <input class="input search" id="q" placeholder="Поиск по ID" value="${esc(state.q)}">
      </section>

      <section class="actionbar">
        <span><b>${state.selected.size}</b> выбрано</span>
        <label class="muted small">Чек-лист
          <select id="cl-select" class="input input-sm">
            <option value="auto" ${state.checklist === "auto" ? "selected" : ""}>Авто: по каналу (чаты → ${esc(byChannel["agent chat"]?.name || "нет")}, звонки → ${esc(byChannel["voice call"]?.name || "нет")})</option>
            ${checklists.map((c) => `<option value="${c.id}" ${String(state.checklist) === String(c.id) ? "selected" : ""}>${esc(c.name)} v${c.version}${c.is_active ? " (активный)" : ""}</option>`).join("")}
          </select>
        </label>
        <button class="btn btn-primary" id="eval-sel" ${state.selected.size ? "" : "disabled"}>Оценить выбранные</button>
        <button class="btn btn-ghost" id="eval-new">Оценить все неоценённые в фильтре</button>
        <span class="spacer"></span>
        <a class="btn btn-ghost btn-sm" href="${api.exportUrl("csv", state.dataset === "all" ? "" : state.dataset)}" title="Итоги и ответы по критериям (последняя оценка каждого диалога, с учётом апелляций)">Экспорт CSV</a>
        <a class="btn btn-ghost btn-sm" href="${api.exportUrl("json", state.dataset === "all" ? "" : state.dataset)}" title="Полный результат: ответы, объяснения, доказательства">Экспорт JSON</a>
      </section>

      <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th class="w-check"><input type="checkbox" id="sel-all" ${allSel ? "checked" : ""} aria-label="Выбрать все"></th>
          <th>ID диалога</th><th>Набор</th><th>Канал</th><th>Язык</th><th class="num">Реплик</th>
          <th class="num">Итог</th><th>Грубая ошибка</th><th>Апелляции</th><th>Оценка</th>
        </tr></thead>
        <tbody>
          ${list.map((r) => `
          <tr data-id="${esc(r.id)}" class="row-link">
            <td class="w-check"><input type="checkbox" data-sel="${esc(r.id)}" ${state.selected.has(r.id) ? "checked" : ""} aria-label="Выбрать ${esc(r.id)}"></td>
            <td><a href="#/c/${encodeURIComponent(r.id)}" class="mono">${esc(r.id)}</a></td>
            <td class="muted">${esc(r.dataset || "")}</td>
            <td>${r.has_audio ? "🎧 " : "💬 "}${channelLabel(r.channel)}</td>
            <td><span class="lang">${esc(r.language || "")}</span></td>
            <td class="num">${r.n_messages}</td>
            <td class="num">${r.done_status === "done" ? scoreBadge(r.final_total) + (r.final_total !== r.total ? ` <span class="muted small" title="До апелляции">(${esc(r.total ?? "—")})</span>` : "") : "—"}</td>
            <td>${r.final_gross_error ? `<span class="tag tag-bad">⚠ да</span>` : r.done_status === "done" ? `<span class="muted">нет</span>` : ""}</td>
            <td>${r.appeals_open ? `<span class="tag tag-warn">открыта: ${r.appeals_open}</span>` : r.appeals_total ? `<span class="muted small">рассмотрено: ${r.appeals_total}</span>` : ""}</td>
            <td>${statusCell(r)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      ${list.length === 0 ? `<div class="empty small">Нет диалогов по выбранным фильтрам</div>` : ""}
      </div>`}`;
    bind(list);
  }

  function bind(list) {
    $("#cl-select", view)?.addEventListener("change", (e) => { state.checklist = e.target.value; });
    $("#group-id", view)?.addEventListener("input", (e) => { state.groupId = e.target.value; });
    $("#fetch-btn", view)?.addEventListener("click", async (e) => {
      const gid = $("#group-id", view).value.trim();
      if (!gid) return toast("Укажите group_id", "warn");
      e.target.disabled = true;
      e.target.textContent = "Загрузка…";
      try {
        const r = await api.fetchDataset(gid);
        toast(`Загружено диалогов: ${r.imported} (набор ${r.dataset})`, "ok");
        state.dataset = "all";
        await load();
        paint();
      } catch (err) {
        toast(err.message, "bad", 6000);
        e.target.disabled = false;
        e.target.textContent = "Загрузить набор из API";
      }
    });
    $("#file-in", view)?.addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const r = await api.upload(f, "UPLOAD");
        toast(`Загружено диалогов: ${r.imported}`, "ok");
        await load();
        paint();
      } catch (err) { toast(err.message, "bad", 6000); }
    });
    $$("[data-seg]", view).forEach((s) => s.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      state[s.dataset.seg] = b.dataset.v;
      paint();
    }));
    const q = $("#q", view);
    q?.addEventListener("input", () => {
      state.q = q.value;
      const pos = q.selectionStart;
      paint();
      const nq = $("#q", view);
      nq.focus();
      nq.setSelectionRange(pos, pos);
    });
    $("#sel-all", view)?.addEventListener("change", (e) => {
      list.forEach((r) => (e.target.checked ? state.selected.add(r.id) : state.selected.delete(r.id)));
      paint();
    });
    $$("[data-sel]", view).forEach((c) => c.addEventListener("change", (e) => {
      e.stopPropagation();
      e.target.checked ? state.selected.add(c.dataset.sel) : state.selected.delete(c.dataset.sel);
      paint();
    }));
    $$("tr.row-link", view).forEach((tr) => tr.addEventListener("click", (e) => {
      if (e.target.closest("input,a,button")) return;
      location.hash = `#/c/${encodeURIComponent(tr.dataset.id)}`;
    }));
    const run = async (ids) => {
      if (!ids.length) return toast("Нет диалогов для оценки", "warn");
      const v = state.checklist;
      const clId = v === "auto" ? "auto" : Number(v);
      try {
        const job = await api.evaluate(ids, clId);
        jobs.track(job);
        toast(`Запущена оценка ${ids.length} диалогов`, "ok");
        state.selected.clear();
        await load();
        paint();
      } catch (err) { toast(err.message, "bad"); }
    };
    $("#eval-sel", view)?.addEventListener("click", () => run([...state.selected]));
    $("#eval-new", view)?.addEventListener("click", () => run(list.filter((r) => r.done_status !== "done" && !jobs.isBusy(r.id)).map((r) => r.id)));
  }

  paint();
  const off = jobs.onUpdate(async () => { await load(); if (document.activeElement?.id !== "q") paint(); });
  return { destroy: off };
}
