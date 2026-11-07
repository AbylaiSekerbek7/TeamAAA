import { api } from "../api.js";
import { icon } from "../icons.js";
import { $, SPEAKER, answerChip, answerOptions, answerText, channelLabel, esc, fmtDate, fmtScore, role, scoreBadge, spinner, toast } from "../ui.js";

// Criterion titles arrive as "07 Завершение": the numeric code is shown as a separate code badge.
function critTitle(title) {
  const m = /^(\d{1,3})\s+(.+)$/.exec(String(title || ""));
  return m ? `<span class="crit-code">${esc(m[1])}</span><span>${esc(m[2])}</span>` : `<span>${esc(title || "")}</span>`;
}

function statusTag(a, short = false) {
  if (a.status === "open") return `<span class="tag tag-warn">${icon("clock", { size: 12 })}${short ? "Открыта" : "На рассмотрении"}</span>`;
  if (a.decision === "change") return `<span class="tag tag-run">${icon("edit", { size: 12 })}${short ? "Изменено" : "Оценка изменена"}</span>`;
  return `<span class="tag tag-ok">${icon("check", { size: 12 })}${short ? "Подтверждено" : "Оценка подтверждена"}</span>`;
}

function signed(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const r = Math.round(v * 100) / 100;
  if (!r) return "0";
  return `${r > 0 ? "+" : "−"}${fmtScore(Math.abs(r))}`;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}

// Small info icon carrying a hint in its tooltip instead of a visible help line.
function hint(text) {
  return `<span class="apl-hint" role="img" title="${esc(text)}" aria-label="${esc(text)}">${icon("info", { size: 14 })}</span>`;
}

// Two outcome metrics next to the tabs (the open / decided counts already sit on the tabs themselves).
function statsStrip(list) {
  const decided = list.filter((a) => a.status !== "open");
  if (!decided.length) return "";
  const changed = decided.filter((a) => a.decision === "change").length;
  const shifts = decided.filter((a) => a.total_before != null && a.total_after != null).map((a) => a.total_after - a.total_before);
  const avg = shifts.length ? shifts.reduce((s, x) => s + x, 0) / shifts.length : null;
  const cell = (label, value, tip) => `<div class="apl-sum-i" title="${esc(tip)}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  return `<dl class="apl-sum" aria-label="Сводка по апелляциям">
    ${cell("Изменено оценок", `${Math.round((changed / decided.length) * 100)}%`, `Доля изменённых оценок: ${changed} из ${decided.length}`)}
    ${cell("Среднее изменение", avg === null ? "—" : signed(avg), "Среднее изменение итога, баллов на диалог")}
  </dl>`;
}

export async function renderAppeals(view, hash) {
  const params = new URLSearchParams(hash.split("?")[1] || "");
  let tab = params.get("tab") || "open";
  let selectedId = params.get("id") ? Number(params.get("id")) : null;
  view.innerHTML = spinner();
  let list = [];

  async function load() {
    list = await api.appeals();
    if (selectedId) {
      const a = list.find((x) => x.id === selectedId);
      if (a) tab = a.status === "open" ? "open" : "decided";
    }
  }
  await load();

  function itemHtml(a) {
    const on = a.id === selectedId;
    const decided = a.status !== "open";
    const score = decided
      ? `<span class="apl-item-score"><span>${fmtScore(a.total_before)}</span>${icon("arrowRight", { size: 12 })}<b>${fmtScore(a.total_after)}</b></span>`
      : `<span class="apl-item-score"><b>${fmtScore(a.final_total ?? a.total_before)}</b></span>`;
    const tip = `Апелляция #${a.id}${a.author ? ` · ${a.author}` : ""}`;
    return `
      <button type="button" class="apl-item ${on ? "active" : ""}" data-ap="${esc(a.id)}" title="${esc(tip)}" ${on ? 'aria-current="true"' : ""}>
        <span class="apl-item-title">${critTitle(a.criterion_title)}</span>
        <span class="apl-item-meta">${decided ? statusTag(a, true) : ""}<span class="mono">${esc(a.conversation_id)}</span>${a.created_at ? `<span>${esc(fmtDate(a.created_at))}</span>` : ""}${score}</span>
      </button>`;
  }

  function paint() {
    const items = list.filter((a) => (tab === "open" ? a.status === "open" : a.status !== "open"));
    if (!selectedId && items.length) selectedId = items[0].id;
    const openCount = list.filter((a) => a.status === "open").length;
    const decidedCount = list.length - openCount;
    const emptyDetail = !list.length
      ? `<h3>Апелляций пока нет</h3>`
      : tab === "open"
        ? `<h3>Открытых апелляций нет</h3>`
        : `<h3>Рассмотренных апелляций нет</h3>`;
    view.innerHTML = `
      <div class="apl">
        <section class="page-head"><h1>Апелляции</h1></section>
        <div class="apl-bar">
          <div class="tabs apl-tabs" role="group" aria-label="Статус апелляций">
            <button type="button" data-tab="open" class="${tab === "open" ? "active" : ""}" aria-pressed="${tab === "open"}">${icon("clock", { size: 15 })}Открытые<span class="apl-count">${openCount}</span></button>
            <button type="button" data-tab="decided" class="${tab === "decided" ? "active" : ""}" aria-pressed="${tab === "decided"}">${icon("checkCircle", { size: 15 })}Рассмотренные<span class="apl-count">${decidedCount}</span></button>
          </div>
          ${statsStrip(list)}
        </div>
        <div class="split apl-split ${items.length ? "" : "is-empty"}">
          ${items.length ? `<aside class="split-list apl-list" aria-label="${tab === "open" ? "Открытые апелляции" : "Рассмотренные апелляции"}">${items.map(itemHtml).join("")}</aside>` : ""}
          <section class="split-detail apl-detail" id="ap-detail">${items.length ? spinner() : `
            <div class="apl-empty">${icon(list.length ? "checkCircle" : "inbox", { size: 28 })}${emptyDetail}
              ${list.length ? "" : `<a class="btn btn-sm" href="#/" title="Апелляцию подают из карточки диалога кнопкой «Оспорить» у критерия">${icon("inbox", { size: 15 })}Перейти к диалогам</a>`}</div>`}</section>
        </div>
      </div>`;
    view.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { tab = b.dataset.tab; selectedId = null; paint(); });
    view.querySelectorAll("[data-ap]").forEach((b) => b.onclick = () => { selectedId = Number(b.dataset.ap); paint(); });
    if (items.length && selectedId) renderDetail(items.find((a) => a.id === selectedId) || items[0]);
  }

  async function renderDetail(a) {
    const box = $("#ap-detail", view);
    const [ev, conv] = await Promise.all([api.evaluation(a.evaluation_id), api.conversation(a.conversation_id)]);
    const c = ev.checklist.data.criteria.find((x) => x.id === a.criterion_id);
    const r = ev.result.criteria[a.criterion_id] || {};
    const msgs = conv.messages;
    const ids = new Set();
    (a.original.evidence_ids || []).forEach((id) => { for (let k = id - 2; k <= id + 2; k++) if (k >= 0 && k < msgs.length) ids.add(k); });
    if (!ids.size) msgs.slice(-6).forEach((m) => ids.add(m.id));
    const ev_ids = new Set(a.original.evidence_ids || []);
    let prev = null;
    const fragment = [...ids].sort((x, y) => x - y).map((id) => {
      const m = msgs[id];
      const gap = prev !== null && id - prev > 1 ? `<div class="apl-gap"><span>Пропущено: ${id - prev - 1}</span></div>` : "";
      prev = id;
      const isEv = ev_ids.has(id);
      return `${gap}
        <div class="apl-line sp-${esc(m.speaker)} ${isEv ? "is-ev" : ""}">
          <div class="apl-line-meta"><span class="apl-line-id">[${esc(id)}]</span><span class="apl-line-time">${esc(m.t_label)}</span><span class="apl-line-who">${esc(SPEAKER[m.speaker] || m.speaker)}</span>${isEv ? `<span class="sr-only">Доказательство</span>` : ""}</div>
          <div class="apl-line-text">${esc(m.text)}</div>
        </div>`;
    }).join("");
    // Evidence lines listed in the header, so lines below the scroll window are not missed.
    const evList = [...ev_ids].sort((x, y) => x - y);
    const legend = evList.length
      ? `<span class="apl-legend" title="Реплики, на которые ссылается ИИ"><i aria-hidden="true"></i>Доказательства: <span class="apl-legend-ids">${evList.map((i) => `[${esc(i)}]`).join(", ")}</span></span>`
      : `<span class="apl-legend" title="ИИ не указал реплики, показан конец диалога">${icon("info", { size: 13 })}Без доказательств</span>`;

    const isOpen = a.status === "open";
    const canDecide = role() === "reviewer" && isOpen;
    const dis = canDecide ? "" : "disabled";
    const hasProposed = a.proposed_answer !== null && a.proposed_answer !== undefined;
    const changed = a.decision === "change";
    const finalAnswer = changed ? a.new_answer : a.original.answer;
    const chip = (ans) => answerChip(ans, answerText(c, ans), c.type);
    const info = conv.conversation || {};
    const channel = channelLabel(info.channel);
    const cl = ev.checklist || {};

    // Which scale step / answer each party chose — shown next to the criterion rules.
    const marks = (val) => {
      const out = [];
      if (String(a.original.answer) === val) out.push(`<span class="tag">${icon("cpu", { size: 12 })}ИИ</span>`);
      if (hasProposed && String(a.proposed_answer) === val) out.push(`<span class="tag tag-run">${icon("message", { size: 12 })}Предложено</span>`);
      if (!isOpen && String(finalAnswer) === val) out.push(`<span class="tag tag-ok">${icon("check", { size: 12 })}Решение</span>`);
      return out.join("");
    };
    const rules = c.type === "scale"
      ? c.scale.map((s) => [String(s.value), String(s.value), s.description])
      : [
        ["yes", "Да", c.yes_rule],
        ["no", "Нет", c.no_rule || (c.type === "flag" ? "Нарушений не выявлено." : "Требование не выполнено.")],
        ...(c.na_allowed ? [["na", "N/A", c.na_rule]] : []),
      ];
    const ruleRows = rules.map(([val, label, text]) => {
      const m = marks(val);
      return `<div class="apl-rule ${m ? "is-hit" : ""}"><span class="apl-rule-val">${esc(label)}</span><span class="apl-rule-text">${esc(text || "")}</span><span class="apl-rule-marks">${m}</span></div>`;
    }).join("");
    // Secondary metadata (checklist, section, weight) lives behind one «Подробнее» together with the methodology.
    const weight = Number(c.weight);
    const ruleMeta = [
      cl.name ? `<span class="apl-meta">${icon("clipboard", { size: 13 })}${esc(cl.name)}${cl.version ? `, v${esc(cl.version)}` : ""}</span>` : "",
      c.section ? `<span class="apl-meta">${icon("layers", { size: 13 })}${esc(c.section)}</span>` : "",
      Number.isFinite(weight) && weight > 0 ? `<span class="apl-meta">${icon("scale", { size: 13 })}Вес: ${esc(weight)} ${plural(weight, "балл", "балла", "баллов")}</span>` : "",
    ].join("");
    const more = ruleMeta || c.guidance
      ? `<details class="apl-guide"><summary>${icon("chevronRight", { size: 14 })}Подробнее</summary>
          ${ruleMeta ? `<div class="apl-guide-meta">${ruleMeta}</div>` : ""}
          ${c.guidance ? `<div class="apl-guide-text">${esc(c.guidance)}</div>` : ""}
        </details>`
      : "";

    const decisionHtml = isOpen ? `
      <section class="apl-card apl-decision ${canDecide ? "" : "is-locked"}" aria-label="Решение проверяющего">
        <div class="apl-card-head">
          <h3 class="apl-card-title">${icon(canDecide ? "scale" : "lock", { size: 15 })}Решение</h3>
          ${canDecide ? "" : `<span class="apl-card-meta" title="Чтобы рассмотреть апелляцию, переключите роль на «Проверяющий» вверху справа">Принимает проверяющий</span>`}
        </div>
        <div class="apl-card-body">
          <div class="apl-options" role="${canDecide ? "radiogroup" : "group"}" aria-label="Вариант решения">
            <label class="apl-option">
              <input type="radio" name="dec" value="confirm" checked ${dis}>
              <span class="apl-option-icon">${icon("checkCircle", { size: 16 })}</span>
              <b>Подтвердить оценку</b>
            </label>
            <label class="apl-option">
              <input type="radio" name="dec" value="change" ${dis}>
              <span class="apl-option-icon">${icon("edit", { size: 16 })}</span>
              <b>Изменить оценку</b>
            </label>
          </div>
          <label class="field" id="new-ans-field" hidden><span>Новая оценка</span>
            <select class="input" id="new-ans">${answerOptions(c).filter((o) => o.value !== String(a.original.answer)).map((o) => `<option value="${esc(o.value)}" ${String(a.proposed_answer) === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>
          <label class="field apl-reason-field"><span class="apl-field-label">Причина <span class="apl-req" aria-hidden="true">*</span>${hint("Например: оператор попрощался в реплике [11], критерий выполнен.")}</span><textarea class="input" id="reason" rows="3" aria-required="true" ${dis}></textarea></label>
          <div class="apl-decision-foot">
            <button type="button" class="btn btn-primary" id="decide" ${dis} title="Итог диалога будет пересчитан">${icon("check", { size: 16 })}Сохранить решение</button>
          </div>
        </div>
      </section>` : `
      <section class="apl-card apl-decided" aria-label="Решение проверяющего">
        <div class="apl-card-head">
          <h3 class="apl-card-title">${icon("checkCircle", { size: 15 })}Решение принято</h3>
          <div class="apl-head-meta">
            <span class="apl-card-meta">${icon("userCheck", { size: 13 })}${esc(a.reviewer || "—")}</span>
            ${a.decided_at ? `<span class="apl-card-meta">${icon("clock", { size: 13 })}${esc(fmtDate(a.decided_at))}</span>` : ""}
          </div>
        </div>
        <div class="apl-card-body">
          <blockquote class="apl-quote is-decision" aria-label="Причина решения">${esc(a.reviewer_comment)}</blockquote>
        </div>
      </section>`;

    // At-a-glance strip: what the AI said, what the appeal asked for and — once decided — the outcome.
    const verdict = isOpen
      ? `<div class="apl-vcell"><span class="apl-label">Итог диалога</span><span>${scoreBadge(ev.final_total)}</span></div>`
      : `<div class="apl-vcell"><span class="apl-label">Решение</span><span>${chip(finalAnswer)}</span></div>
         <div class="apl-vcell apl-vcell-wide"><span class="apl-label">Итог диалога</span><span class="apl-transition"><span class="apl-old">${fmtScore(a.total_before)}</span>${icon("arrowRight", { size: 16 })}<span class="sr-only">стал</span>${scoreBadge(a.total_after)}<span class="apl-delta" title="Изменение итога, баллов">${esc(signed(a.total_before != null && a.total_after != null ? a.total_after - a.total_before : null))}</span></span></div>`;

    box.innerHTML = `
      <header class="apl-dhead">
        <div class="apl-dhead-main">
          <h2 class="apl-dtitle" title="Апелляция #${esc(a.id)}">${c.code ? `<span class="crit-code">${esc(c.code)}</span>` : ""}<span>${esc(c.title)}</span></h2>
          <div class="apl-dmeta">
            ${statusTag(a)}
            ${channel ? `<span class="apl-meta">${icon(conv.is_voice ? "phone" : "message", { size: 13 })}${esc(channel)}</span>` : ""}
            ${info.language ? `<span class="lang">${esc(info.language)}</span>` : ""}
          </div>
        </div>
        <a class="btn btn-sm apl-open" href="#/c/${encodeURIComponent(a.conversation_id)}?e=${esc(a.evaluation_id)}" title="Открыть карточку диалога ${esc(a.conversation_id)}">Диалог <span class="mono">${esc(a.conversation_id)}</span>${icon("external", { size: 14 })}</a>
      </header>
      <div class="apl-dbody">
        <div class="apl-verdict ${isOpen ? "" : "is-decided"}">
          <div class="apl-vcell"><span class="apl-label">Оценка ИИ</span><span>${chip(a.original.answer)}</span></div>
          <div class="apl-vcell"><span class="apl-label">Предложено</span><span>${hasProposed ? chip(a.proposed_answer) : `<span class="apl-none">—</span>`}</span></div>
          ${verdict}
        </div>

        <div class="apl-cols">
          <section class="apl-card">
            <div class="apl-card-head"><h3 class="apl-card-title">${icon("scale", { size: 15 })}Позиции сторон</h3></div>
            <div class="apl-card-body apl-args">
              <div class="apl-arg">
                <div class="apl-label">${icon("cpu", { size: 13 })}Обоснование ИИ</div>
                ${a.original.explanation || r.explanation ? `<p class="apl-expl">${esc(a.original.explanation || r.explanation || "")}</p>` : `<p class="apl-none">—</p>`}
              </div>
              <div class="apl-arg">
                <div class="apl-arg-head">
                  <div class="apl-label">${icon("message", { size: 13 })}Довод апелляции</div>
                  <div class="apl-byline">${a.author ? `<span>${esc(a.author)}</span>` : ""}${a.created_at ? `<span>${esc(fmtDate(a.created_at))}</span>` : ""}</div>
                </div>
                <blockquote class="apl-quote">${esc(a.comment)}</blockquote>
              </div>
            </div>
          </section>
          <section class="apl-card">
            <div class="apl-card-head">
              <h3 class="apl-card-title">${icon(conv.is_voice ? "phone" : "message", { size: 15 })}Фрагмент диалога</h3>
              ${legend}
            </div>
            <div class="apl-frag" tabindex="0" role="region" aria-label="Фрагмент диалога, доказательства выделены">${fragment}</div>
          </section>
        </div>

        <section class="apl-card">
          <div class="apl-card-head"><h3 class="apl-card-title">${icon("clipboard", { size: 15 })}Правила критерия</h3></div>
          <div class="apl-rules">${ruleRows}</div>
          ${more}
        </section>

        ${decisionHtml}
      </div>`;
    if (canDecide) {
      box.querySelectorAll("input[name=dec]").forEach((r) => r.onchange = () => { $("#new-ans-field", box).hidden = r.value !== "change" || !r.checked; });
      $("#decide", box).onclick = async () => {
        const decision = box.querySelector("input[name=dec]:checked").value;
        const reason = $("#reason", box).value.trim();
        if (!reason) return toast("Укажите причину решения", "warn");
        try {
          const res = await api.decideAppeal(a.id, { decision, reason, new_answer: decision === "change" ? $("#new-ans", box).value : null, reviewer: "Проверяющий" });
          toast(`Решение сохранено. Итог: ${fmtScore(res.total_before)} → ${fmtScore(res.final_total)}`, "ok", 6000);
          await load();
          tab = "decided";
          paint();
        } catch (e) { toast(e.message, "bad"); }
      };
    }
  }

  paint();
  return {};
}
