import { api } from "../api.js";
import { $, $$, esc, fmtDate, modal, spinner, toast } from "../ui.js";
import { jobs } from "../jobs.js";

const TYPE_LABEL = { binary: "Да / Нет", scale: "Шкала баллов", flag: "Флаг нарушения (без баллов)" };
const CHANNEL_LABEL = { "agent chat": "Чаты", "voice call": "Звонки" };
const AUTO_LABEL = {
  contact_greeting_name: "приветствие + имя + язык клиента в первой реплике оператора",
  closing_farewell: "прощание в последней реплике оператора / обрыв чата",
};

function blankCriterion(n) {
  return { id: "", code: String(n).padStart(2, "0"), section: "", title: "", type: "binary", weight: 10, na_allowed: false,
    yes_rule: "", no_rule: "", na_rule: "", guidance: "", scale: [], enabled: true };
}

export async function renderChecklists(view) {
  view.innerHTML = spinner();
  let versions = await api.checklists();
  let selected = versions.find((v) => v.is_active) || versions[0];
  let draft = structuredClone(selected.data);
  let dirty = false;

  function weightSum() {
    return draft.criteria.filter((c) => c.enabled !== false && c.type !== "flag").reduce((s, c) => s + Number(c.weight || 0), 0);
  }

  function critEditor(c, i) {
    return `<article class="ce ${c.enabled === false ? "ce-off" : ""}" data-i="${i}">
      <header class="ce-head">
        <input class="input code" data-f="code" value="${esc(c.code)}" aria-label="Код" title="Код">
        <input class="input title" data-f="title" value="${esc(c.title)}" placeholder="Название критерия" aria-label="Название">
        <div class="ce-tools">
          <button class="icon-btn" data-act="up" title="Выше">↑</button>
          <button class="icon-btn" data-act="down" title="Ниже">↓</button>
          <label class="toggle" title="Включён в оценку"><input type="checkbox" data-f="enabled" ${c.enabled !== false ? "checked" : ""}> вкл</label>
          <button class="icon-btn danger" data-act="del" title="Удалить">✕</button>
        </div>
      </header>
      <div class="ce-row">
        <label class="field"><span>Секция</span><input class="input" data-f="section" value="${esc(c.section)}" list="sections"></label>
        <label class="field"><span>Тип ответа</span><select class="input" data-f="type">${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}" ${c.type === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field narrow"><span>Вес</span><input class="input" type="number" min="0" step="1" data-f="weight" value="${esc(c.weight)}" ${c.type === "flag" ? "disabled" : ""}></label>
        <label class="field check"><input type="checkbox" data-f="na_allowed" ${c.na_allowed ? "checked" : ""} ${c.type === "flag" ? "disabled" : ""}> <span>Разрешён N/A</span></label>
      </div>
      ${c.type === "scale" ? `
        <label class="field"><span>Что оценивается</span><input class="input" data-f="yes_rule" value="${esc(c.yes_rule)}"></label>
        <div class="field"><span>Шкала (верхняя ступень даёт полный вес)</span>
          <div class="scale-rows">${c.scale.map((s, k) => `<div class="scale-row">
            <input class="input narrow" type="number" step="1" data-scale="${k}" data-sf="value" value="${esc(s.value)}" aria-label="Баллы">
            <input class="input" data-scale="${k}" data-sf="description" value="${esc(s.description)}" placeholder="Описание ступени">
            <button class="icon-btn danger" data-act="scale-del" data-k="${k}" title="Удалить ступень">✕</button></div>`).join("")}
            <button class="btn btn-ghost btn-sm" data-act="scale-add">+ ступень</button></div></div>`
      : `<label class="field"><span>${c.type === "flag" ? "Да (нарушение) — когда" : "Да — когда"}</span><textarea class="input" rows="2" data-f="yes_rule">${esc(c.yes_rule)}</textarea></label>
         <label class="field"><span>Нет — когда (необязательно)</span><input class="input" data-f="no_rule" value="${esc(c.no_rule)}"></label>`}
      ${c.na_allowed && c.type !== "flag" ? `<label class="field"><span>N/A — когда</span><input class="input" data-f="na_rule" value="${esc(c.na_rule)}"></label>` : ""}
      <label class="field"><span>Пояснения и примеры для модели</span><textarea class="input" rows="3" data-f="guidance">${esc(c.guidance)}</textarea></label>
      ${c.auto_check ? `<div class="autocheck small">⚙ Автопроверка правилом: <b>${esc(AUTO_LABEL[c.auto_check.type] || c.auto_check.type)}</b>. Действует, пока формулировки «Да» / «N/A» не изменены; при изменении критерия решает только модель.
        <button class="link small" data-act="ac-off">отключить</button></div>` : ""}
    </article>`;
  }

  function paint() {
    const sum = weightSum();
    const sections = [...new Set(draft.criteria.map((c) => c.section).filter(Boolean))];
    view.innerHTML = `
      <section class="page-head">
        <div><h1>Чек-листы</h1><p class="muted">Критерии, веса, шкалы и правила N/A. Каждое сохранение создаёт новую версию; оценки хранят версию, по которой они сделаны.</p></div>
        <div class="head-actions">
          <button class="btn" id="new-cl">+ Новый чек-лист</button>
          <button class="btn btn-ghost" id="export-cl">Экспорт JSON</button>
          <label class="btn btn-ghost">Импорт JSON<input type="file" id="import-cl" accept=".json" hidden></label>
        </div>
      </section>
      <div class="split">
        <aside class="split-list">
          ${[...new Set(versions.map((v) => v.key))].map((key) => {
            const fam = versions.filter((v) => v.key === key);
            const act = fam.find((v) => v.is_active);
            const ch = (act || fam[0]).data.channels || [];
            return `<div class="cl-family">
              <div class="cl-family-head"><b>${esc((act || fam[0]).name)}</b>
                <span class="small muted">${ch.length ? ch.map((c) => CHANNEL_LABEL[c] || c).join(", ") : "все каналы"}${act ? "" : " · не активен"}</span></div>
              ${fam.map((v) => `<button class="ap-item ${v.id === selected.id ? "active" : ""}" data-v="${v.id}">
                <div>v${v.version} ${v.is_active ? `<span class="tag tag-ok">активная</span>` : ""} <span class="small muted">${fmtDate(v.created_at)} · ${v.data.criteria.length} крит.</span></div>
                ${v.comment ? `<div class="small">${esc(v.comment)}</div>` : ""}
              </button>`).join("")}
            </div>`;
          }).join("")}
        </aside>
        <section class="split-detail">
          <div class="ce-top">
            <div class="ce-row">
              <label class="field"><span>Название чек-листа</span><input class="input" id="cl-name" value="${esc(draft.name)}"></label>
              <div class="field narrow-wide"><span>Применяется к каналам (при оценке «Авто»)</span>
                <div class="radio-row">${Object.entries(CHANNEL_LABEL).map(([v, l]) => `<label class="toggle"><input type="checkbox" data-channel="${v}" ${(draft.channels || []).includes(v) ? "checked" : ""}> ${l}</label>`).join("")}
                <span class="muted small">не отмечено — все каналы</span></div></div>
            </div>
            <label class="field"><span>Общие правила оценки (передаются модели)</span><textarea class="input" rows="5" id="cl-rules">${esc(draft.general_rules || "")}</textarea></label>
          </div>
          <datalist id="sections">${sections.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>
          <div class="ce-list">${draft.criteria.map(critEditor).join("")}</div>
          <button class="btn btn-ghost" id="add-crit">+ Добавить критерий</button>
          <div class="save-bar">
            <span class="${sum === 100 ? "ok-text" : "warn-text"}">Сумма весов: <b>${sum}</b>${sum === 100 ? "" : " — итог всё равно нормируется до 100 баллов"}</span>
            ${dirty ? `<span class="tag tag-warn">есть несохранённые изменения</span>` : ""}
            <input class="input" id="cl-comment" placeholder="Комментарий к версии (что изменено)">
            <label class="toggle"><input type="checkbox" id="cl-activate" checked> сделать активным</label>
            <button class="btn btn-primary" id="save-cl">${draft.key ? "Сохранить новую версию" : "Создать чек-лист"}</button>
            ${draft.key ? `<button class="btn" id="save-as-new">Сохранить как новый чек-лист</button>` : ""}
            ${selected.is_active && !dirty && draft.key ? `<button class="btn btn-ghost" id="deactivate-cl" title="Не использовать этот чек-лист при оценке «Авто»">Отключить</button>` : ""}
            ${!selected.is_active && !dirty ? `<button class="btn" id="activate-cl">Сделать эту версию активной</button>` : ""}
            ${!dirty ? `<button class="btn" id="apply-cl">Применить к диалогам…</button>` : ""}
          </div>
        </section>
      </div>`;
    bind();
  }

  function setField(i, f, el) {
    const c = draft.criteria[i];
    if (el.type === "checkbox") c[f] = el.checked;
    else if (f === "weight") c[f] = Number(el.value);
    else c[f] = el.value;
    if (f === "type") {
      if (c.type === "scale" && (!c.scale || c.scale.length < 2)) c.scale = [{ value: 10, description: "" }, { value: 5, description: "" }, { value: 0, description: "" }];
      if (c.type === "flag") { c.weight = 0; c.na_allowed = false; }
    }
    dirty = true;
    if (["type", "na_allowed", "enabled", "weight"].includes(f)) paint();
    else markDirty();
  }

  function markDirty() {
    const bar = $(".save-bar", view);
    if (!bar || $(".tag-warn", bar)) return;
    const t = document.createElement("span");
    t.className = "tag tag-warn";
    t.textContent = "есть несохранённые изменения";
    bar.insertBefore(t, bar.children[1]);
    $("#apply-cl", view)?.remove();
    $("#activate-cl", view)?.remove();
  }

  function bind() {
    $$("[data-v]", view).forEach((b) => b.onclick = () => {
      if (dirty && !confirm("Есть несохранённые изменения. Переключиться без сохранения?")) return;
      selected = versions.find((v) => v.id === Number(b.dataset.v));
      draft = structuredClone(selected.data);
      dirty = false;
      paint();
    });
    $("#cl-name", view).oninput = (e) => { draft.name = e.target.value; dirty = true; markDirty(); };
    $("#cl-rules", view).oninput = (e) => { draft.general_rules = e.target.value; dirty = true; markDirty(); };
    $$(".ce", view).forEach((art) => {
      const i = Number(art.dataset.i);
      $$("[data-f]", art).forEach((el) => {
        el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" || el.type === "number" ? "change" : "input", () => setField(i, el.dataset.f, el));
      });
      $$("[data-scale]", art).forEach((el) => el.addEventListener("input", () => {
        const s = draft.criteria[i].scale[Number(el.dataset.scale)];
        s[el.dataset.sf] = el.dataset.sf === "value" ? Number(el.value) : el.value;
        dirty = true;
        markDirty();
      }));
      $$("[data-act]", art).forEach((b) => b.onclick = () => {
        const cr = draft.criteria;
        const act = b.dataset.act;
        if (act === "up" && i > 0) [cr[i - 1], cr[i]] = [cr[i], cr[i - 1]];
        if (act === "down" && i < cr.length - 1) [cr[i + 1], cr[i]] = [cr[i], cr[i + 1]];
        if (act === "del") { if (!confirm(`Удалить критерий «${cr[i].title || cr[i].code}»?`)) return; cr.splice(i, 1); }
        if (act === "scale-add") cr[i].scale.push({ value: 0, description: "" });
        if (act === "scale-del") cr[i].scale.splice(Number(b.dataset.k), 1);
        if (act === "ac-off") cr[i].auto_check = null;
        dirty = true;
        paint();
      });
    });
    $("#add-crit", view).onclick = () => {
      draft.criteria.push(blankCriterion(draft.criteria.length + 1));
      dirty = true;
      paint();
      const last = $$(".ce", view).pop();
      last?.scrollIntoView({ behavior: "smooth", block: "center" });
      $(".title", last)?.focus();
    };
    $$("[data-channel]", view).forEach((cb) => cb.onchange = () => {
      const set = new Set(draft.channels || []);
      cb.checked ? set.add(cb.dataset.channel) : set.delete(cb.dataset.channel);
      draft.channels = [...set];
      dirty = true;
      markDirty();
    });
    $("#new-cl", view).onclick = () => {
      if (dirty && !confirm("Есть несохранённые изменения. Начать новый чек-лист без сохранения?")) return;
      draft = { key: "", name: "Новый чек-лист", description: "", channels: [], general_rules: selected.data.general_rules || "",
        criteria: [blankCriterion(1)] };
      selected = { id: null, is_active: false, data: draft };
      dirty = true;
      paint();
      $("#cl-name", view).select();
    };
    $("#save-as-new", view)?.addEventListener("click", () => save(true));
    $("#deactivate-cl", view)?.addEventListener("click", async () => {
      await api.deactivateChecklist(selected.id);
      versions = await api.checklists();
      selected = versions.find((v) => v.id === selected.id);
      toast("Чек-лист отключён и не будет выбираться автоматически", "ok");
      paint();
    });
    $("#save-cl", view).onclick = () => save(false);
    async function save(asNew) {
      try {
        if (asNew && draft.name === selected.data.name) draft.name = `${draft.name} (копия)`;
        const saved = await api.saveChecklist(draft, $("#cl-comment", view).value.trim(), $("#cl-activate", view).checked, asNew);
        toast(`Сохранено: ${saved.name} v${saved.version}${saved.is_active ? " (активный)" : ""}`, "ok");
        versions = await api.checklists();
        selected = versions.find((v) => v.id === saved.id);
        draft = structuredClone(selected.data);
        dirty = false;
        paint();
      } catch (e) { toast(e.message, "bad", 6000); }
    };
    $("#activate-cl", view)?.addEventListener("click", async () => {
      await api.activateChecklist(selected.id);
      versions = await api.checklists();
      selected = versions.find((v) => v.id === selected.id);
      toast("Версия активирована", "ok");
      paint();
    });
    $("#apply-cl", view)?.addEventListener("click", applyDialog);
    $("#export-cl", view).onclick = () => {
      const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `checklist_${draft.key || "cqa"}.json`;
      a.click();
    };
    $("#import-cl", view).onchange = async (e) => {
      try {
        const data = JSON.parse(await e.target.files[0].text());
        if (!Array.isArray(data.criteria)) throw new Error("В файле нет списка criteria");
        draft = data;
        dirty = true;
        paint();
        toast("Чек-лист загружен в редактор — проверьте и сохраните", "ok");
      } catch (err) { toast(err.message, "bad"); }
    };
  }

  async function applyDialog() {
    const convs = await api.conversations();
    const datasets = [...new Set(convs.map((c) => c.dataset))];
    const m = modal(`
      <h3>Применить «${esc(selected.name)} v${selected.version}»</h3>
      <p class="muted">Запустить оценку диалогов по этой версии чек-листа. Предыдущие оценки сохранятся в истории.</p>
      <label class="field"><span>Набор диалогов</span><select class="input" id="ap-ds">${datasets.map((d) => `<option value="${esc(d)}">${esc(d)} (${convs.filter((c) => c.dataset === d).length})</option>`).join("")}<option value="__all">Все (${convs.length})</option></select></label>
      <div class="row-actions"><button class="btn btn-primary" id="ap-go">Запустить оценку</button><button class="btn btn-ghost" data-close>Отмена</button></div>`);
    $("#ap-go", m.el).onclick = async () => {
      const ds = $("#ap-ds", m.el).value;
      const ids = convs.filter((c) => ds === "__all" || c.dataset === ds).map((c) => c.id);
      try {
        const job = await api.evaluate(ids, selected.id);
        jobs.track(job);
        toast(`Оценка ${ids.length} диалогов запущена`, "ok");
        m.close();
      } catch (e) { toast(e.message, "bad"); }
    };
  }

  paint();
  return {};
}
