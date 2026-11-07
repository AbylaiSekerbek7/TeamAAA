import { api } from "../api.js";
import { icon } from "../icons.js";
import { $, $$, channelLabel, esc, fmtDate, scoreBadge, scoreClass, spinner, toast } from "../ui.js";
import { jobs } from "../jobs.js";

const state = {
  lang: "all", channel: "all", status: "all", dataset: "all", q: "",
  selected: new Set(),
  checklist: "auto",
  groupId: "DEV",
};

function matches(r, s) {
  if (s.lang !== "all" && r.language !== s.lang) return false;
  if (s.channel !== "all" && channelLabel(r.channel) !== s.channel) return false;
  if (s.dataset !== "all" && r.dataset !== s.dataset) return false;
  if (s.status === "new" && (r.eval_status || r.done_status)) return false;
  if (s.status === "done" && r.done_status !== "done") return false;
  if (s.status === "appeal" && !r.appeals_open) return false;
  if (s.status === "gross" && !r.final_gross_error) return false;
  if (s.q && !r.id.toLowerCase().includes(s.q.toLowerCase())) return false;
  return true;
}

function filtered(rows, s = state) {
  return rows.filter((r) => matches(r, s));
}

const nf1 = (v) => Number(v).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function statusCell(r) {
  if (jobs.isBusy(r.id) || r.eval_status === "running" || r.eval_status === "queued") {
    return `<span class="tag tag-run lv-tag">${icon("refresh", { size: 12, cls: "lv-rot" })}Оценивается…</span>`;
  }
  const failed = r.eval_status === "error";
  const last = r.eval_status && r.eval_status !== "done"
    ? `<span class="tag lv-tag ${failed ? "tag-bad" : ""}" title="${esc(failed ? (r.last_error || "Последний запуск завершился ошибкой") : "Последний запуск отменён")}">${icon(failed ? "alert" : "xCircle", { size: 12 })}${failed ? "Ошибка запуска" : "Запуск отменён"}</span>` : "";
  if (r.done_status !== "done") {
    return `<div class="lv-status">${last || `<span class="tag lv-tag">${icon("clock", { size: 12 })}Не оценён</span>`}</div>`;
  }
  const when = fmtDate(r.finished_at);
  return `<div class="lv-status"><span class="lv-done" title="${esc(`Оценён ${when}`)}">${icon("checkCircle", { size: 14 })}<span class="lv-date">${esc(when)}</span></span>${last}</div>`;
}

// options: [value, label, iconName?]
function seg(name, label, options) {
  return `<div class="lv-filter">
    <span class="sr-only" id="lv-f-${esc(name)}">${esc(label)}</span>
    <div class="seg" data-seg="${esc(name)}" role="group" aria-labelledby="lv-f-${esc(name)}">${options.map(([v, l, ic]) => `<button type="button" data-v="${esc(v)}" class="${state[name] === v ? "active" : ""}" aria-pressed="${state[name] === v}">${ic ? icon(ic, { size: 14 }) : ""}${esc(l)}</button>`).join("")}</div>
  </div>`;
}

function statusTabs(rows) {
  const tabs = [["all", "Все", "list"], ["new", "Не оценены", "clock"], ["done", "Оценены", "checkCircle"], ["appeal", "Апелляции", "scale"], ["gross", "Грубые ошибки", "alert"]];
  return `<div class="lv-tabs" data-seg="status" role="group" aria-label="Статус оценки">${tabs.map(([v, l, ic]) => {
    const n = filtered(rows, { ...state, status: v }).length;
    const on = state.status === v;
    return `<button type="button" data-v="${esc(v)}" class="lv-tab ${on ? "active" : ""} ${v === "gross" && n ? "lv-tab-bad" : ""}" aria-pressed="${on}">${icon(ic, { size: 15 })}<span>${esc(l)}</span><span class="lv-count">${n}</span></button>`;
  }).join("")}</div>`;
}

// average final score of the shown rows (the counts live in the status tabs)
function avgScore(list) {
  const evaluated = list.filter((r) => r.final_total !== null && r.final_total !== undefined);
  if (!evaluated.length) return "";
  const avg = evaluated.reduce((s, r) => s + r.final_total, 0) / evaluated.length;
  return `<span class="lv-avg" title="${esc(`Средний итоговый балл, оценено: ${evaluated.length}`)}">Средний балл <span class="score ${scoreClass(avg)}">${nf1(avg)}</span></span>`;
}

function row(r) {
  const call = channelLabel(r.channel) === "Звонок";
  const sel = state.selected.has(r.id);
  return `
          <tr data-id="${esc(r.id)}" class="row-link ${sel ? "lv-selected" : ""}">
            <td class="w-check"><input type="checkbox" data-sel="${esc(r.id)}" ${sel ? "checked" : ""} aria-label="Выбрать ${esc(r.id)}"></td>
            <td><a href="#/c/${encodeURIComponent(r.id)}" class="mono lv-id">${esc(r.id)}</a></td>
            <td><span class="lv-ds">${esc(r.dataset || "")}</span></td>
            <td><span class="lv-ch">${icon(call ? "phone" : "message", { size: 14 })}${esc(channelLabel(r.channel))}${r.has_audio ? `<span class="lv-audio" title="Есть аудиозапись" role="img" aria-label="Есть аудиозапись">${icon("waveform", { size: 13 })}</span>` : ""}</span></td>
            <td>${r.language ? `<span class="lang">${esc(r.language)}</span>` : ""}</td>
            <td class="num">${esc(r.n_messages ?? "")}</td>
            <td class="num"><span class="lv-total">${r.done_status === "done" ? (r.final_total !== r.total ? `<span class="lv-prev" title="Итог до апелляции">было ${esc(r.total ?? "—")}</span>` : "") + scoreBadge(r.final_total) : `<span class="lv-dash">—</span>`}</span></td>
            <td class="lv-gross">${r.final_gross_error ? `<span class="tag tag-bad lv-tag">${icon("alert", { size: 12 })}Да</span>` : r.done_status === "done" ? `<span class="lv-no">Нет</span>` : `<span class="lv-dash">—</span>`}</td>
            <td>${r.appeals_open ? `<span class="tag tag-warn lv-tag">${icon("scale", { size: 12 })}Открыта: ${esc(r.appeals_open)}</span>` : r.appeals_total ? `<span class="lv-reviewed">${icon("check", { size: 12 })}Рассмотрено: ${esc(r.appeals_total)}</span>` : `<span class="lv-dash">—</span>`}</td>
            <td>${statusCell(r)}</td>
            <td class="lv-go" aria-hidden="true">${icon("chevronRight", { size: 16 })}</td>
          </tr>`;
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

  const FETCH_LABEL = `${icon("cloud", { size: 16 })}<span>Загрузить</span>`;

  function paint() {
    const list = filtered(rows);
    const datasets = [...new Set(rows.map((r) => r.dataset).filter(Boolean))];
    const allSel = list.length && list.every((r) => state.selected.has(r.id));
    const pending = list.filter((r) => r.done_status !== "done" && !jobs.isBusy(r.id)).length;
    const autoTitle = `Авто: чаты → ${byChannel["agent chat"]?.name || "нет"}, звонки → ${byChannel["voice call"]?.name || "нет"}`;
    const nSel = state.selected.size;
    const exportDs = state.dataset === "all" ? "" : state.dataset;
    view.innerHTML = `
      <section class="page-head lv-head">
        <h1>Диалоги</h1>
        <div class="lv-source" role="group" aria-label="Источник данных">
          <div class="lv-input-group">
            <span class="lv-addon" aria-hidden="true">group_id</span>
            <input id="group-id" class="input" value="${esc(state.groupId)}" placeholder="DEV" aria-label="Идентификатор набора (group_id)" autocomplete="off" spellcheck="false">
            <button type="button" class="btn" id="fetch-btn" title="Загрузить набор из API">${FETCH_LABEL}</button>
          </div>
          <label class="btn lv-upload" role="button" tabindex="0" title="Загрузить JSON-файл с диалогами">${icon("upload", { size: 16 })}<span>JSON-файл</span><input type="file" id="file-in" accept=".json,application/json" hidden></label>
        </div>
      </section>

      ${rows.length === 0 ? `
      <section class="lv-empty">
        <span class="lv-empty-ic">${icon("inbox", { size: 28 })}</span>
        <h3>Диалогов пока нет</h3>
        <button type="button" class="btn btn-primary" id="lv-empty-fetch">${icon("cloud", { size: 16 })}Загрузить набор</button>
      </section>` : `
      <section class="lv-grid" aria-label="Список диалогов">
        <div class="lv-grid-head">
          ${statusTabs(rows)}
          <label class="search-wrap lv-search">
            ${icon("search", { size: 16 })}
            <input class="input search" id="q" type="search" placeholder="Поиск по ID" value="${esc(state.q)}" aria-label="Поиск по ID диалога" autocomplete="off" spellcheck="false">
          </label>
        </div>

        <div class="toolbar lv-filters">
          <div class="lv-filter-set">
            ${seg("lang", "Язык", [["all", "Все"], ["RU", "RU"], ["KZ", "KZ"], ["EN", "EN"]])}
            ${seg("channel", "Канал", [["all", "Все"], ["Чат", "Чаты", "message"], ["Звонок", "Звонки", "phone"]])}
            ${datasets.length > 1 ? seg("dataset", "Набор", [["all", "Все"], ...datasets.map((d) => [d, d])]) : ""}
          </div>
          <div class="lv-export" role="group" aria-label="Экспорт результатов">
            <a class="btn btn-sm" href="${esc(api.exportUrl("csv", exportDs))}" title="Экспорт CSV: итоги и ответы по критериям (последняя оценка каждого диалога, с учётом апелляций)">${icon("download", { size: 14 })}<span class="sr-only">Экспорт </span>CSV</a>
            <a class="btn btn-sm" href="${esc(api.exportUrl("json", exportDs))}" title="Экспорт JSON: полный результат — ответы, объяснения, доказательства">${icon("download", { size: 14 })}<span class="sr-only">Экспорт </span>JSON</a>
          </div>
        </div>

        <div class="actionbar lv-actions ${nSel ? "has-sel" : ""}">
          <span class="lv-sel" aria-live="polite">${nSel
            ? `${icon("checkCircle", { size: 16 })}Выбрано: <b>${nSel}</b> <button type="button" class="link lv-clear" id="lv-clear-sel">Снять выбор</button>`
            : ""}</span>
          <span class="spacer"></span>
          <label class="lv-cl">
            <span>Чек-лист</span>
            <select id="cl-select" class="input input-sm" title="${esc(state.checklist === "auto" ? autoTitle : "Чек-лист для оценки")}">
              <option value="auto" title="${esc(autoTitle)}" ${state.checklist === "auto" ? "selected" : ""}>Авто</option>
              ${checklists.map((c) => `<option value="${esc(c.id)}" ${String(state.checklist) === String(c.id) ? "selected" : ""}>${esc(c.name)} v${esc(c.version)}${c.is_active ? " (активный)" : ""}</option>`).join("")}
            </select>
          </label>
          <button type="button" class="btn" id="eval-new" title="Оценить все неоценённые диалоги в текущем фильтре">${icon("layers", { size: 15 })}Оценить неоценённые<span class="lv-btn-count">${pending}</span></button>
          <button type="button" class="btn btn-primary" id="eval-sel" ${nSel ? "" : "disabled"}>${icon("play", { size: 14 })}Оценить выбранные${nSel ? `<span class="lv-btn-count">${nSel}</span>` : ""}</button>
        </div>

        <div class="lv-table-wrap">
        <table class="table lv-table">
          <thead><tr>
            <th class="w-check"><input type="checkbox" id="sel-all" ${allSel ? "checked" : ""} aria-label="Выбрать все"></th>
            <th>ID</th><th>Набор</th><th>Канал</th><th>Язык</th><th class="num">Реплик</th>
            <th class="num">Итог</th><th class="lv-gross">Грубая ошибка</th><th>Апелляции</th><th>Статус</th><th class="lv-go"><span class="sr-only">Открыть</span></th>
          </tr></thead>
          <tbody>
            ${list.map(row).join("")}
          </tbody>
        </table>
        ${list.length === 0 ? `
        <div class="lv-noresult">
          <span class="lv-empty-ic">${icon("search", { size: 22 })}</span>
          <b>Ничего не найдено</b>
          <button type="button" class="btn btn-sm" id="lv-reset">${icon("refresh", { size: 14 })}Сбросить фильтры</button>
        </div>` : ""}
        </div>

        <div class="lv-foot">
          <span class="lv-shown">Показано <b>${list.length}</b> из ${rows.length}${avgScore(list)}</span>
          <span class="lv-legend" role="group" aria-label="Шкала итогового балла" title="Шкала итогового балла">
            <span title="Норма"><i class="lv-sw lv-sw-good"></i>85–100</span>
            <span title="Зона внимания"><i class="lv-sw lv-sw-mid"></i>60–84</span>
            <span title="Критично"><i class="lv-sw lv-sw-bad"></i>&lt;60</span>
          </span>
        </div>
      </section>`}`;
    bind(list);
  }

  function bind(list) {
    $("#cl-select", view)?.addEventListener("change", (e) => { state.checklist = e.target.value; });
    $("#group-id", view)?.addEventListener("input", (e) => { state.groupId = e.target.value; });
    $("#fetch-btn", view)?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const gid = $("#group-id", view).value.trim();
      if (!gid) return toast("Укажите group_id", "warn");
      btn.disabled = true;
      btn.innerHTML = `<span class="spin"></span><span>Загрузка…</span>`;
      try {
        const r = await api.fetchDataset(gid);
        toast(`Загружено диалогов: ${r.imported} (набор ${r.dataset})`, "ok");
        state.dataset = "all";
        await load();
        paint();
      } catch (err) {
        toast(err.message, "bad", 6000);
        btn.disabled = false;
        btn.innerHTML = FETCH_LABEL;
      }
    });
    $("#lv-empty-fetch", view)?.addEventListener("click", () => $("#fetch-btn", view)?.click());
    $(".lv-upload", view)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file-in", view)?.click(); }
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
    $("#lv-reset", view)?.addEventListener("click", () => {
      Object.assign(state, { lang: "all", channel: "all", status: "all", dataset: "all", q: "" });
      paint();
    });
    $("#lv-clear-sel", view)?.addEventListener("click", () => { state.selected.clear(); paint(); });
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
