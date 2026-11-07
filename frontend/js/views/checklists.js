import { api } from "../api.js";
import { icon } from "../icons.js";
import { $, $$, esc, fmtDate, modal, spinner, toast } from "../ui.js";
import { jobs } from "../jobs.js";

const TYPE_LABEL = { binary: "Да / Нет", scale: "Шкала", flag: "Флаг нарушения" };
const CHANNEL_LABEL = { "agent chat": "Чаты", "voice call": "Звонки" };
const CHANNEL_ICON = { "agent chat": "message", "voice call": "phone" };
const AUTO_LABEL = {
  contact_greeting_name: "приветствие + имя + язык клиента в первой реплике оператора",
  closing_farewell: "прощание в последней реплике оператора / обрыв чата",
  gross_violation: "предложение услуг в обход компании по устойчивым фразам; раскрытие данных до идентификации",
};

// Russian plural: plural(5, "критерий", "критерия", "критериев") -> "критериев".
function plural(n, one, few, many) {
  const v = Math.abs(Number(n) || 0);
  if (!Number.isInteger(v)) return few;
  const m10 = v % 10, m100 = v % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function channelTags(ch) {
  if (!ch || !ch.length) return `<span class="clx-chan-tag">${icon("globe", { size: 12 })}Все каналы</span>`;
  return ch.map((c) => `<span class="clx-chan-tag">${icon(CHANNEL_ICON[c] || "layers", { size: 12 })}${esc(CHANNEL_LABEL[c] || c)}</span>`).join("");
}

// Small info icon carrying a hint in its tooltip (instead of a visible help line).
function tip(text) {
  return `<span class="clx-tip" role="img" title="${esc(text)}" aria-label="${esc(text)}">${icon("info", { size: 14 })}</span>`;
}

// Label of a rule field with a small semantic marker (icon + text, never colour alone).
function ruleLabel(kind, text, extra = "") {
  const ic = { yes: "check", no: "x", na: "minusCircle", flag: "alert", what: "info", scale: "gauge" }[kind];
  return `<span class="clx-rule-lbl"><i class="clx-mk clx-mk-${kind}" aria-hidden="true">${icon(ic, { size: 12 })}</i><span>${text}</span>${extra}</span>`;
}

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
  // Display only: which collapsible blocks are open, so a repaint does not fold them back.
  let rulesOpen = false;
  const guideOpen = new WeakSet();

  function weightSum() {
    return draft.criteria.filter((c) => c.enabled !== false && c.type !== "flag").reduce((s, c) => s + Number(c.weight || 0), 0);
  }

  function critEditor(c, i) {
    const off = c.enabled === false;
    const isFlag = c.type === "flag";
    let rules;
    if (c.type === "scale") {
      rules = `
        <label class="field clx-rule">${ruleLabel("what", "Что оценивается")}<textarea class="input clx-grow" rows="1" data-f="yes_rule">${esc(c.yes_rule)}</textarea></label>
        <div class="field clx-rule">${ruleLabel("scale", "Шкала", tip("Верхняя ступень даёт полный вес"))}
          <div class="clx-scale">
            ${c.scale.map((s, k) => `<div class="clx-scale-row">
              <input class="input clx-scale-val" type="number" step="1" data-scale="${k}" data-sf="value" value="${esc(s.value)}" aria-label="Баллы ступени ${k + 1}">
              <textarea class="input clx-grow" rows="1" data-scale="${k}" data-sf="description" placeholder="Описание ступени" aria-label="Описание ступени ${k + 1}">${esc(s.description)}</textarea>
              <button type="button" class="icon-btn danger" data-act="scale-del" data-k="${k}" title="Удалить ступень" aria-label="Удалить ступень ${k + 1}">${icon("trash", { size: 15 })}</button></div>`).join("")}
            <div><button type="button" class="btn btn-ghost btn-sm clx-scale-add" data-act="scale-add">${icon("plus", { size: 14 })}Добавить ступень</button></div>
          </div></div>`;
    } else {
      rules = `
        <label class="field clx-rule">${isFlag ? ruleLabel("flag", "Нарушение") : ruleLabel("yes", "Да")}<textarea class="input clx-grow" rows="2" data-f="yes_rule">${esc(c.yes_rule)}</textarea></label>
        <label class="field clx-rule">${ruleLabel(isFlag ? "yes" : "no", "Нет")}<textarea class="input clx-grow" rows="1" data-f="no_rule">${esc(c.no_rule)}</textarea></label>`;
    }
    const autoHint = c.auto_check
      ? `Автопроверка правилом: ${AUTO_LABEL[c.auto_check.type] || c.auto_check.type}. Действует, пока формулировки «Да» / «N/A» не изменены; при изменении критерия решает только модель.`
      : "";
    return `<article class="ce clx-crit ${off ? "ce-off" : ""} ${isFlag ? "is-flag" : ""}" data-i="${i}">
      <header class="clx-crit-head">
        <input class="input clx-code" data-f="code" value="${esc(c.code)}" aria-label="Код критерия" title="Код критерия">
        <input class="input title clx-title" data-f="title" value="${esc(c.title)}" placeholder="Название критерия" aria-label="Название критерия">
        ${c.auto_check ? `<span class="clx-auto" role="note" title="${esc(autoHint)}" aria-label="${esc(autoHint)}">${icon("zap", { size: 12 })}Автопроверка<button type="button" class="clx-auto-off" data-act="ac-off" title="Отключить автопроверку" aria-label="Отключить автопроверку">${icon("x", { size: 12 })}</button></span>` : ""}
        <div class="clx-tools">
          <span class="clx-move">
            <button type="button" class="icon-btn" data-act="up" title="Переместить выше" aria-label="Переместить критерий выше">${icon("arrowUp", { size: 15 })}</button>
            <button type="button" class="icon-btn" data-act="down" title="Переместить ниже" aria-label="Переместить критерий ниже">${icon("arrowDown", { size: 15 })}</button>
          </span>
          <label class="clx-switch" title="Учитывать критерий при оценке"><input type="checkbox" data-f="enabled" ${c.enabled !== false ? "checked" : ""}><span>В оценке</span></label>
          <button type="button" class="icon-btn danger" data-act="del" title="Удалить критерий" aria-label="Удалить критерий">${icon("trash", { size: 15 })}</button>
        </div>
      </header>
      <div class="clx-crit-body">
        <div class="clx-meta-row">
          <label class="field"><span>Секция</span><input class="input" data-f="section" value="${esc(c.section)}" list="sections"></label>
          <label class="field"><span>Тип</span><select class="input" data-f="type">${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}" ${c.type === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label class="field"><span>Вес</span><input class="input" type="number" min="0" step="1" data-f="weight" value="${esc(c.weight)}" ${isFlag ? "disabled" : ""}></label>
          <label class="clx-check ${isFlag ? "is-disabled" : ""}"><input type="checkbox" data-f="na_allowed" ${c.na_allowed ? "checked" : ""} ${isFlag ? "disabled" : ""}><span>Разрешён N/A</span></label>
        </div>
        <div class="clx-rules">
          ${rules}
          ${c.na_allowed && !isFlag ? `<label class="field clx-rule">${ruleLabel("na", "N/A")}<textarea class="input clx-grow" rows="1" data-f="na_rule">${esc(c.na_rule)}</textarea></label>` : ""}
        </div>
        <details class="clx-disclose clx-guidance" ${guideOpen.has(c) ? "open" : ""}>
          <summary>${icon("chevronRight", { size: 14 })}<span>Пояснения для модели</span></summary>
          <textarea class="input" rows="3" data-f="guidance" aria-label="Пояснения и примеры для модели">${esc(c.guidance)}</textarea>
        </details>
      </div>
    </article>`;
  }

  function familyList() {
    const keys = [...new Set(versions.map((v) => v.key))];
    const draftCard = selected.id == null ? `<section class="clx-fam clx-fam-draft is-current">
        <header class="clx-fam-head">
          <span class="clx-fam-ic">${icon("edit", { size: 17 })}</span>
          <div class="clx-fam-title"><b class="clx-live-name">${esc(draft.name || "Новый чек-лист")}</b>
            <div class="clx-fam-tags"><span class="tag tag-warn" title="Ещё не сохранён">${icon("edit", { size: 12 })}Черновик</span></div></div>
        </header>
      </section>` : "";
    return `${draftCard}${keys.map((key) => {
      const fam = versions.filter((v) => v.key === key);
      const act = fam.find((v) => v.is_active);
      const head = act || fam[0];
      const ch = head.data.channels || [];
      const current = fam.some((v) => v.id === selected.id);
      return `<section class="clx-fam ${current ? "is-current" : ""}">
        <header class="clx-fam-head">
          <span class="clx-fam-ic">${icon(ch.length === 1 ? CHANNEL_ICON[ch[0]] || "clipboard" : "clipboard", { size: 17 })}</span>
          <div class="clx-fam-title"><b>${esc(head.name)}</b>
            <div class="clx-fam-tags">${channelTags(ch)}${act ? "" : `<span class="tag">${icon("minusCircle", { size: 12 })}Не активен</span>`}</div></div>
        </header>
        <div class="clx-vers">
          ${fam.map((v) => `<button type="button" class="clx-ver ${v.id === selected.id ? "active" : ""}" data-v="${v.id}" ${v.id === selected.id ? 'aria-current="true"' : ""} title="${v.data.criteria.length} ${plural(v.data.criteria.length, "критерий", "критерия", "критериев")}">
            <span class="clx-ver-top"><b>Версия ${esc(v.version)}</b><span class="clx-ver-date">${fmtDate(v.created_at)}</span>${v.is_active ? `<span class="tag tag-ok">${icon("check", { size: 12 })}Активная</span>` : ""}</span>
            ${v.comment ? `<span class="clx-ver-comment" title="${esc(v.comment)}">${esc(v.comment)}</span>` : ""}
          </button>`).join("")}
        </div>
      </section>`;
    }).join("")}`;
  }

  function paint() {
    const sum = weightSum();
    const sections = [...new Set(draft.criteria.map((c) => c.section).filter(Boolean))];
    const total = draft.criteria.length;
    const enabledN = draft.criteria.filter((c) => c.enabled !== false).length;
    const flagN = draft.criteria.filter((c) => c.type === "flag").length;
    const isNew = selected.id == null;
    // A checklist loaded via «Импорт JSON» that belongs to another family: the header must describe the editor, not the selected version.
    const foreign = !isNew && (draft.key || "") !== (selected.data.key || "");
    const sumOk = sum === 100;
    const fill = Math.max(0, Math.min(100, sum));
    const headIcon = isNew ? "edit" : foreign ? "upload" : "clipboard";
    const headTitle = isNew ? "Новый чек-лист"
      : foreign ? `<span class="clx-live-name">${esc(draft.name || "Новый чек-лист")}</span>`
      : `${esc(selected.name)} <span class="clx-ver-pill" title="Версия от ${esc(fmtDate(selected.created_at))}">v${esc(selected.version)}</span>`;
    const headTag = isNew ? `<span class="tag tag-warn" title="Ещё не сохранён">${icon("edit", { size: 12 })}Черновик</span>`
      : foreign ? `<span class="tag tag-warn" title="Загружен из файла JSON, не сохранён">${icon("upload", { size: 12 })}Из файла</span>`
      : selected.is_active ? `<span class="tag tag-ok" title="Используется при оценке в режиме «Авто»">${icon("checkCircle", { size: 12 })}Активная</span>`
      : `<span class="tag" title="Не используется при оценке в режиме «Авто»">${icon("minusCircle", { size: 12 })}Не активна</span>`;
    const statsHint = `${total} ${plural(total, "критерий", "критерия", "критериев")} · ${enabledN} в оценке · ${sections.length} ${plural(sections.length, "секция", "секции", "секций")} · ${flagN} ${plural(flagN, "флаг", "флага", "флагов")} нарушения`;
    view.innerHTML = `<div class="clx">
      <section class="page-head">
        <div><h1>Чек-листы</h1></div>
        <div class="head-actions">
          <button type="button" class="btn" id="export-cl" title="Скачать редактируемый чек-лист в формате JSON">${icon("download", { size: 15 })}Экспорт JSON</button>
          <label class="btn clx-file" title="Загрузить чек-лист из файла JSON в редактор">${icon("upload", { size: 15 })}Импорт JSON<input type="file" id="import-cl" accept=".json" class="sr-only"></label>
          <button type="button" class="btn clx-new" id="new-cl">${icon("plus", { size: 15 })}Новый чек-лист</button>
        </div>
      </section>
      <div class="split clx-split">
        <aside class="split-list clx-list" aria-label="Чек-листы и версии">
          ${familyList()}
        </aside>
        <section class="split-detail clx-detail">
          <div class="clx-card">
            <header class="clx-card-head">
              <span class="clx-head-ic">${icon(headIcon, { size: 18 })}</span>
              <div class="clx-head-title"><h2>${headTitle}</h2>${headTag}</div>
              ${isNew || foreign ? "" : `<div class="clx-head-actions">
                <span class="clx-ver-hint" role="img" title="Действия с версией доступны после сохранения изменений" aria-label="Действия с версией доступны после сохранения изменений">${icon("info", { size: 14 })}</span>
                ${!selected.is_active && !dirty ? `<button type="button" class="btn btn-sm" id="activate-cl" title="Сделать эту версию активной">${icon("checkCircle", { size: 14 })}Сделать активной</button>` : ""}
                ${selected.is_active && !dirty && draft.key ? `<button type="button" class="btn btn-sm btn-ghost" id="deactivate-cl" title="Не использовать этот чек-лист при оценке «Авто»">${icon("minusCircle", { size: 14 })}Отключить</button>` : ""}
                ${!dirty ? `<button type="button" class="btn btn-sm" id="apply-cl">${icon("play", { size: 14 })}Применить к диалогам…</button>` : ""}
              </div>`}
            </header>
            <div class="clx-card-body">
              <div class="clx-params">
                <label class="field"><span>Название</span><input class="input" id="cl-name" value="${esc(draft.name)}"></label>
                <div class="field clx-chan-field" role="group" aria-labelledby="clx-chan-lbl"><span class="clx-lbl"><span id="clx-chan-lbl">Каналы</span>${tip("Для оценки в режиме «Авто». Не отмечено — все каналы.")}</span>
                  <div class="clx-chan-row">${Object.entries(CHANNEL_LABEL).map(([v, l]) => `<label class="clx-chan"><input type="checkbox" data-channel="${v}" ${(draft.channels || []).includes(v) ? "checked" : ""}>${icon(CHANNEL_ICON[v], { size: 15 })}<span>${l}</span></label>`).join("")}</div>
                </div>
              </div>
              <details class="clx-disclose clx-rules-field" ${rulesOpen ? "open" : ""}>
                <summary>${icon("chevronRight", { size: 14 })}<span>Общие правила</span>${tip("Передаются модели")}</summary>
                <textarea class="input" rows="5" id="cl-rules" aria-label="Общие правила оценки">${esc(draft.general_rules || "")}</textarea>
              </details>
            </div>
          </div>
          <datalist id="sections">${sections.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>
          <div class="clx-sec-head">
            <h3>Критерии</h3>
            <span class="clx-count" title="${esc(statsHint)}" aria-label="${esc(statsHint)}">${total}</span>
          </div>
          <div class="ce-list clx-crit-list">${draft.criteria.map(critEditor).join("")}</div>
          <button type="button" class="clx-add" id="add-crit">${icon("plus", { size: 16 })}Добавить критерий</button>
          <div class="save-bar clx-savebar">
            <div class="clx-weights ${sumOk ? "is-ok" : "is-warn"}" title="${sumOk ? "Сумма весов критериев, участвующих в оценке" : "Сумма весов не равна 100: итоговая оценка нормируется до 100 баллов"}">
              ${icon(sumOk ? "checkCircle" : "alert", { size: 15 })}<span>Сумма весов</span><b>${sum}</b><span class="clx-of">из 100</span>
              <div class="clx-meter" role="meter" aria-label="Сумма весов" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${fill}" aria-valuetext="${sum} из 100${sumOk ? "" : ", итог нормируется до 100 баллов"}"><i style="width:${fill}%"></i></div>
            </div>
            ${dirty ? `<span class="tag tag-warn" title="Есть несохранённые изменения">Не сохранено</span>` : ""}
            <label class="clx-switch clx-sb-activate" title="Сохранённая версия сразу будет использоваться при оценке в режиме «Авто»"><input type="checkbox" id="cl-activate" checked><span>Активировать</span></label>
            <div class="clx-save-actions">
              <input class="input" id="cl-comment" placeholder="Комментарий к версии" aria-label="Комментарий к версии">
              ${draft.key ? `<button type="button" class="btn" id="save-as-new" title="Сохранить как новый чек-лист">${icon("copy", { size: 15 })}Сохранить копией</button>` : ""}
              <button type="button" class="btn btn-primary" id="save-cl">${icon("check", { size: 15 })}${draft.key ? "Сохранить версию" : "Создать чек-лист"}</button>
            </div>
          </div>
        </section>
      </div></div>`;
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
    t.title = "Есть несохранённые изменения";
    t.textContent = "Не сохранено";
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
    $("#cl-name", view).oninput = (e) => {
      draft.name = e.target.value; dirty = true; markDirty();
      // Display only: keep the draft card / imported header in sync with the name being typed.
      $$(".clx-live-name", view).forEach((n) => { n.textContent = draft.name || "Новый чек-лист"; });
    };
    $("#cl-rules", view).oninput = (e) => { draft.general_rules = e.target.value; dirty = true; markDirty(); };
    const rulesBox = $(".clx-rules-field", view);
    rulesBox.addEventListener("toggle", () => { rulesOpen = rulesBox.open; });
    $$(".ce", view).forEach((art) => {
      const i = Number(art.dataset.i);
      const guide = $(".clx-guidance", art);
      guide.addEventListener("toggle", () => { const c = draft.criteria[i]; if (guide.open) guideOpen.add(c); else guideOpen.delete(c); });
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
      const nc = blankCriterion(draft.criteria.length + 1);
      guideOpen.add(nc);
      draft.criteria.push(nc);
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
      const nc = blankCriterion(1);
      guideOpen.add(nc);
      draft = { key: "", name: "Новый чек-лист", description: "", channels: [], general_rules: selected.data.general_rules || "",
        criteria: [nc] };
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
      toast("Чек-лист отключён", "ok");
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
        toast("Загружено в редактор", "ok");
      } catch (err) { toast(err.message, "bad"); }
    };
  }

  async function applyDialog() {
    const convs = await api.conversations();
    const datasets = [...new Set(convs.map((c) => c.dataset))];
    const m = modal(`
      <div class="clx-modal-head">
        <span class="clx-head-ic">${icon("play", { size: 17 })}</span>
        <h3>Применить «${esc(selected.name)} v${esc(selected.version)}»</h3>
      </div>
      <label class="field"><span>Набор диалогов</span><select class="input" id="ap-ds">${datasets.map((d) => `<option value="${esc(d)}">${esc(d)} (${convs.filter((c) => c.dataset === d).length})</option>`).join("")}<option value="__all">Все (${convs.length})</option></select></label>
      <div class="row-actions clx-modal-actions"><button type="button" class="btn btn-ghost" data-close>Отмена</button><button type="button" class="btn btn-primary" id="ap-go">${icon("play", { size: 14 })}Запустить оценку</button></div>`);
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
