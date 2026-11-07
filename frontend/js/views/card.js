import { api } from "../api.js";
import { icon } from "../icons.js";
import { $, $$, SPEAKER, answerChip, answerOptions, answerText, channelLabel, esc, fmtDate, fmtDuration, fmtScore, role, scoreClass, spinner, toast } from "../ui.js";
import { jobs } from "../jobs.js";

// System events of the transcript: icon + tone (colour of the icon only; the text always stays in ink).
const EVENT_ICON = {
  escalation: "arrowRight", operator_joined: "headphones", identity_verified: "shield", operator_closed: "logOut",
  client_left: "logOut", connection_lost: "zap", recording_paused: "pause", recording_resumed: "play",
  hold_start: "pause", hold_end: "play", consult_start: "user", agent_left: "logOut",
};
const EVENT_TONE = {
  identity_verified: "good", connection_lost: "bad", escalation: "info", operator_joined: "info",
  hold_start: "violet", hold_end: "violet", consult_start: "violet", agent_left: "violet",
};
const SPK_ICON = { client: "user", operator: "headphones", bot: "bot" };

// Criterion status derived from the final answer (and the scored fraction for scales).
const KIND = {
  good: { icon: "checkCircle", label: "Соответствует" },
  partial: { icon: "gauge", label: "Частично" },
  bad: { icon: "xCircle", label: "Не соответствует" },
  flag: { icon: "alert", label: "Нарушение выявлено" },
  na: { icon: "minusCircle", label: "Неприменимо" },
  none: { icon: "info", label: "Не оценён" },
};

function critKind(c, answer, row) {
  if (answer === null || answer === undefined) return "none";
  if (answer === "na") return "na";
  if (c.type === "flag") return answer === "yes" ? "flag" : "good";
  if (c.type === "scale") {
    const f = row && typeof row.fraction === "number" ? row.fraction : null;
    if (f === null) return "partial";
    return f >= 1 ? "good" : f <= 0 ? "bad" : "partial";
  }
  return answer === "yes" ? "good" : "bad";
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// Display-only number formatting (ru-RU decimal comma); non-numeric values pass through unchanged.
function num(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return v;
  const x = Number(v);
  return Number.isFinite(x) ? x.toLocaleString("ru-RU") : v;
}

// Criterion code as a small mono chip followed by its title (instead of «08 · Title»).
function critLabel(code, title) {
  return `${code ? `<span class="crit-code">${esc(code)}</span>` : ""}<span>${esc(title)}</span>`;
}

const EV_STATUS = { queued: "в очереди", running: "выполняется", error: "ошибка", cancelled: "отменена" };

function messageHtml(m, isVoice) {
  const dup = m.duplicate_of !== null;
  if (m.speaker === "system") {
    const tone = EVENT_TONE[m.event] || "neutral";
    return `<div class="msg msg-system cd-sys cd-sys--${tone} ${dup ? "dup" : ""}" id="m-${m.id}" data-mid="${m.id}">
      <span class="cd-sys-pill">${icon(EVENT_ICON[m.event] || "info", { size: 13 })}<span class="cd-sys-text">${esc(m.text)}</span><span class="msg-time">${esc(m.t_label)}</span><span class="msg-id">[${m.id}]</span></span>
    </div>`;
  }
  const who = SPEAKER[m.speaker] || m.speaker;
  return `<div class="msg msg-${esc(m.speaker)} ${dup ? "dup" : ""} ${m.internal ? "msg-internal" : ""}" id="m-${m.id}" data-mid="${m.id}">
    <span class="cd-av cd-av--${esc(m.speaker)}" aria-hidden="true">${icon(SPK_ICON[m.speaker] || "user", { size: 14 })}</span>
    <div class="cd-bubble">
      <div class="msg-meta">
        <b>${esc(who)}</b>
        <span class="msg-time" title="${esc(m.timestamp)}">${esc(m.t_label)}</span>
        <span class="msg-id">[${m.id}]</span>
        ${m.internal ? `<span class="tag tag-violet" title="Клиент на удержании — оператор консультируется с коллегой">${icon("lock", { size: 11 })}Консультация</span>` : ""}
        ${dup ? `<span class="tag" title="Повтор распознавания реплики [${m.duplicate_of}]">${icon("copy", { size: 11 })}Повтор [${m.duplicate_of}]</span>` : ""}
        ${isVoice && m.t !== null ? `<button type="button" class="play-btn" data-seek="${m.t}" title="Прослушать с ${esc(m.t_label)}" aria-label="Прослушать запись с ${esc(m.t_label)}">${icon("play", { size: 10 })}</button>` : ""}
      </div>
      <div class="msg-text">${esc(m.text)}</div>
    </div>
  </div>`;
}

function evidenceHtml(ids, msgs) {
  if (!ids || !ids.length) return `<div class="evidence-empty cd-ev-empty">${icon("info", { size: 13 })}Доказательство не указано</div>`;
  return `<div class="evidence">${ids.map((id) => {
    const m = msgs[id];
    if (!m) return "";
    const short = m.text.length > 140 ? m.text.slice(0, 140) + "…" : m.text;
    return `<button type="button" class="ev" data-goto="${esc(id)}" title="Перейти к реплике [${esc(id)}] в транскрипте">
      <span class="ev-id">${icon(SPK_ICON[m.speaker] || "info", { size: 12 })}<span class="cd-ev-who">${esc(SPEAKER[m.speaker] || m.speaker)}</span><span class="cd-ev-ref">[${esc(id)}]</span>${m.t_label ? `<span class="cd-ev-t">${esc(m.t_label)}</span>` : ""}${icon("arrowRight", { size: 12, cls: "ev-go" })}</span>
      <span class="ev-text">${esc(short)}</span></button>`;
  }).join("")}</div>`;
}

export async function renderCard(view, convId, evalId) {
  view.innerHTML = spinner();
  let conv, ev = null, checklists = [];
  let showAnalysis = new Set();

  async function load() {
    [conv, checklists] = await Promise.all([api.conversation(convId), api.checklists()]);
    const evs = conv.evaluations;
    let target = evalId ? evs.find((e) => e.id === evalId) : evs.find((e) => e.status === "done") || evs[0];
    ev = target && target.status === "done" ? await api.evaluation(target.id) : (target || null);
  }
  await load();

  const msgs = Object.fromEntries(conv.messages.map((m) => [m.id, m]));

  function criterionCard(c) {
    const r = ev.result.criteria[c.id] || {};
    const ov = (ev.final && ev.final.overrides && ev.final.overrides[c.id]) || null;
    const score = ev.final_score || ev.result.score;
    const row = score.criteria[c.id] || {};
    const finalAnswer = ov ? ov.answer : r.answer;
    const openAppeal = ev.appeals.find((a) => a.criterion_id === c.id && a.status === "open");
    const decided = ev.appeals.filter((a) => a.criterion_id === c.id && a.status === "decided");
    const kind = critKind(c, finalAnswer, row);
    const k = KIND[kind];
    // Weight / rule / vote details live in a tooltip; only points (and a low-confidence warning) stay visible.
    const hasConf = r.confidence !== undefined && r.votes && r.votes.length > 1;
    const tip = [
      c.type === "flag" ? "" : row.applicable ? `Вес ${c.weight}${row.effective_weight !== c.weight ? ` → ${fmtScore(row.effective_weight)}` : ""}` : `Вес ${c.weight} перераспределён (N/A)`,
      hasConf ? `Уверенность ${Math.round(r.confidence * 100)}% (${r.votes.join(", ")})` : "",
    ].filter(Boolean).join(" · ");
    const pts = c.type === "flag" ? `<span class="cd-weight">без баллов</span>`
      : row.applicable ? `<span class="pts"><b>${fmtScore(row.points)}</b> / ${fmtScore(row.effective_weight)} б.</span>`
      : `<span class="cd-weight">исключён</span>`;
    const open = showAnalysis.has(c.id);
    const analysisBtn = r.analysis ? `<button type="button" class="link small cd-toggle" data-analysis="${esc(c.id)}" aria-expanded="${open}">${icon(open ? "chevronDown" : "chevronRight", { size: 14 })}Ход рассуждения</button>` : "";
    const appealPart = openAppeal
      ? `<span class="tag tag-warn">${icon("scale", { size: 12 })}Апелляция #${openAppeal.id}</span><a class="link small cd-appeal-link" href="#/appeals?id=${openAppeal.id}">${role() === "reviewer" ? "Рассмотреть" : "Открыть"}${icon("arrowRight", { size: 13 })}</a>`
      : role() === "supervisor" ? `<button type="button" class="btn btn-ghost btn-sm cd-appeal" data-appeal="${esc(c.id)}" title="Подать апелляцию на оценку критерия">${icon("scale", { size: 14 })}Оспорить</button>` : "";
    return `<article class="crit cd-crit cd-k-${kind} ${finalAnswer === "na" ? "crit-na" : ""} ${c.type === "flag" && finalAnswer === "yes" ? "crit-flag" : ""}" id="crit-${esc(c.id)}">
      <header class="crit-head">
        <span class="cd-crit-ic" title="${k.label}">${icon(k.icon, { size: 18 })}<span class="sr-only">${k.label}</span></span>
        <div class="cd-crit-title">
          ${c.code ? `<span class="crit-code">${esc(c.code)}</span>` : ""}
          <h4>${esc(c.title)}</h4>
        </div>
        <div class="crit-answer">
          ${ov ? `<span class="strike" title="Исходная оценка ИИ">${esc(answerText(c, r.answer))}</span>${icon("arrowRight", { size: 12, cls: "cd-ans-arrow" })}` : ""}
          ${answerChip(finalAnswer, answerText(c, finalAnswer), c.type)}
        </div>
      </header>
      <div class="crit-points" title="${esc(tip)}">${pts}${r.source === "rule" ? `<span class="conf" title="Критерий формальный: проверен детерминированным правилом по ключевым словам и системным событиям">${icon("settings", { size: 11 })}правило</span>` : ""}${hasConf && r.confidence < 1 ? `<span class="conf conf-low" title="Согласие голосов модели: ${esc(r.votes.join(", "))}">${icon("gauge", { size: 11 })}${Math.round(r.confidence * 100)}%</span>` : ""}</div>
      ${r.explanation ? `<p class="crit-expl">${esc(r.explanation)}</p>` : ""}
      ${evidenceHtml(r.evidence_ids, msgs)}
      ${ov ? `<div class="override cd-note" title="Изменено проверяющим: ${esc(answerText(c, ov.previous))} → ${esc(answerText(c, ov.answer))}">${icon("edit", { size: 14 })}<div><b>${esc(ov.reviewer || "Проверяющий")}:</b> ${esc(ov.reason)}</div></div>` : ""}
      ${decided.filter((a) => a.decision === "confirm").map((a) => `<div class="override confirm cd-note" title="Апелляция отклонена, оценка подтверждена">${icon("checkCircle", { size: 14 })}<div><b>Апелляция #${a.id} отклонена:</b> ${esc(a.reviewer_comment)}</div></div>`).join("")}
      ${analysisBtn || appealPart ? `<footer class="crit-foot">${analysisBtn}<div class="cd-foot-actions">${appealPart}</div></footer>` : ""}
      ${r.analysis && open ? `<p class="analysis">${esc(r.analysis)}</p>` : ""}
      <div class="appeal-form" id="af-${esc(c.id)}" hidden></div>
    </article>`;
  }

  function resultHead(extra = "") {
    return `<div class="cd-pane-head cd-rhead"><h2>${icon("clipboard", { size: 17 })}Оценка</h2>${extra}</div>`;
  }

  function resultHtml() {
    if (!ev) {
      return `${resultHead()}<div class="cd-empty">
        <span class="cd-empty-ic">${icon("clipboard", { size: 22 })}</span>
        <h3>Диалог не оценён</h3>
        <button type="button" class="btn btn-primary btn-sm" data-run-eval>${icon("play", { size: 14 })}Оценить</button></div>`;
    }
    if (ev.status !== "done") {
      const busy = ["queued", "running"].includes(ev.status) || jobs.isBusy(convId);
      return `${resultHead()}
        <div class="cd-empty">${busy
          ? `<span class="spin cd-spin-lg"></span><h3>Оценка выполняется…</h3>`
          : `<span class="cd-empty-ic cd-empty-ic--bad">${icon("alert", { size: 22 })}</span><h3>Оценка не завершена</h3><p>${esc(ev.error || ev.status)}</p>`}</div>`;
    }
    const cl = ev.checklist.data;
    const score = ev.final_score || ev.result.score;
    const changed = ev.final_total !== ev.total;
    const crits = cl.criteria.filter((c) => c.enabled !== false);
    const sections = score.sections.filter((s) => s.weighted);
    const overrides = (ev.final && ev.final.overrides) || {};
    const finalAns = (c) => (overrides[c.id] ? overrides[c.id].answer : (ev.result.criteria[c.id] || {}).answer);
    const naCount = crits.filter((c) => finalAns(c) === "na").length;
    const missing = score.missing || [];

    const openAppeals = ev.appeals.filter((a) => a.status === "open").length;
    const status = openAppeals ? `<span class="tag tag-warn">${icon("scale", { size: 12 })}На апелляции</span>`
      : Object.keys(overrides).length ? `<span class="tag tag-violet">${icon("edit", { size: 12 })}Скорректирована</span>`
        : `<span class="tag tag-ok">${icon("check", { size: 12 })}Оценён</span>`;

    const total = ev.final_total;
    const tone = scoreClass(total).replace("s-", "");
    const pct = total === null || total === undefined ? 0 : Math.max(0, Math.min(100, Number(total)));
    const grossRaw = score.gross_error_criteria;
    const grossIds = Array.isArray(grossRaw) ? grossRaw : grossRaw ? [grossRaw] : [];
    const grossNames = grossIds.map((id) => {
      const cc = cl.criteria.find((x) => x.id === id);
      return `<span class="cd-gross-i">${cc ? critLabel(cc.code, cc.title) : `<span>${esc(id)}</span>`}</span>`;
    });
    const tokens = (ev.result.prompt_tokens + ev.result.completion_tokens).toLocaleString("ru-RU");
    const when = fmtDate(ev.finished_at) || "—";
    const took = fmtDuration((ev.result.duration_ms || 0) / 1000);

    const tally = { good: 0, partial: 0, bad: 0, na: 0 };
    crits.forEach((c) => {
      const kd = critKind(c, finalAns(c), score.criteria[c.id]);
      if (kd === "flag") tally.bad++;
      else if (kd in tally) tally[kd]++;
    });
    // Verb agrees with the number: «1 соответствует», «8 соответствуют».
    const agree = (n, one, many) => (n % 10 === 1 && n % 100 !== 11 ? one : many);
    const tallyHtml = [
      ["good", "checkCircle", (n) => agree(n, "соответствует", "соответствуют")], ["partial", "gauge", () => "частично"],
      ["bad", "xCircle", (n) => agree(n, "не соответствует", "не соответствуют")], ["na", "minusCircle", () => "N/A"],
    ].filter(([key]) => tally[key]).map(([key, ic, l]) => `<span class="cd-tally-i cd-k-${key}" title="${tally[key]} ${l(tally[key])}">${icon(ic, { size: 12 })}<b>${tally[key]}</b><span class="sr-only">${l(tally[key])}</span></span>`).join("");

    return `${resultHead(`<span class="cd-rhead-id">#${ev.id}</span><span class="spacer"></span>${status}`)}
      <div class="cd-rbody">
      ${missing.length ? `<div class="cd-callout cd-callout--warn" role="status">${icon("alert", { size: 16 })}<div>Не оценены: ${missing.map((id) => esc((crits.find((c) => c.id === id) || {}).title || id)).join(", ")}</div></div>` : ""}
      <div class="cd-summary">
        <div class="cd-ring cd-ring--${tone}" style="--p:${pct}" role="img" aria-label="Итоговый балл: ${fmtScore(total)} из 100" title="Итоговый балл">
          <div class="cd-ring-in"><b class="${fmtScore(total).length > 3 ? "cd-ring-long" : ""}">${fmtScore(total)}</b><span>из 100</span></div>
        </div>
        <div class="cd-sum-side">
          ${score.gross_error
            ? `<div class="cd-verdict cd-verdict--bad">${icon("alert", { size: 18 })}<div><b>Грубая ошибка</b>${grossNames.length ? `<span class="cd-gross">${grossNames.join("")}</span>` : ""}</div></div>`
            : `<div class="cd-verdict cd-verdict--ok">${icon("shield", { size: 18 })}<div><b>Грубых ошибок нет</b></div></div>`}
          ${!score.total_calculated ? `<div class="cd-sum-note">${icon("info", { size: 13 })}${missing.length ? "Итог не рассчитан" : "Нет применимых критериев"}</div>` : ""}
          ${changed ? `<div class="cd-changed" title="Изменено по апелляции: ИИ ${fmtScore(ev.total)} → ${fmtScore(ev.final_total)}">${icon("scale", { size: 14 })}<span>По апелляции: <span class="cd-nowrap"><span class="strike">${fmtScore(ev.total)}</span> → <b>${fmtScore(ev.final_total)}</b></span></span></div>` : ""}
          <div class="cd-sum-meta">
            <span title="Чек-лист">${icon("clipboard", { size: 13 })}<span class="cd-sum-cl">${esc(ev.checklist.name)} v${esc(ev.checklist.version)}</span></span>
            <span title="Оценено">${icon("clock", { size: 13 })}${esc(when)}</span>
          </div>
        </div>
      </div>
      ${sections.length ? `<section class="cd-block" aria-label="Разделы чек-листа">
        <h3 class="cd-block-title">${icon("layers", { size: 14 })}Разделы</h3>
        <div class="cd-secs">${sections.map((s) => {
          const p = s.percent ?? 0;
          const st = s.points === null ? "none" : scoreClass(p).replace("s-", "");
          return `<div class="cd-sec" title="${s.points === null ? "N/A" : `${fmtScore(s.points)} / ${fmtScore(s.max_points)} б.`}">
            <span class="cd-sec-name">${esc(s.section)}</span>
            <div class="cd-bar cd-bar--${st}" aria-hidden="true"><i style="width:${p}%"></i></div>
            <span class="cd-sec-pct">${s.points === null ? "N/A" : `${Math.round(p)}%`}</span>
          </div>`;
        }).join("")}</div></section>` : ""}
      <section class="cd-block" aria-label="Критерии">
        <div class="cd-block-row">
          <h3 class="cd-block-title">${icon("list", { size: 14 })}Критерии <span class="cd-count">${crits.length}</span></h3>
          <div class="cd-tally">${tallyHtml}</div>
        </div>
        <div class="crits">${crits.map(criterionCard).join("")}</div>
      </section>
      <details class="cd-facts"><summary>${icon("chevronRight", { size: 14, cls: "cd-chev" })}<span>Подробнее</span></summary>
        <div class="cd-more">
          <dl class="cd-kv">
            <div class="cd-kv-model"><dt>Модель</dt><dd title="${esc(ev.model || "")}">${esc(ev.model || "—")}</dd></div>
            <div><dt>Токены</dt><dd>${tokens}</dd></div>
            <div title="Время работы модели над оценкой"><dt>Длительность</dt><dd>${esc(took)}</dd></div>
            <div><dt>Критериев N/A</dt><dd>${naCount}</dd></div>
            <div title="Вес неприменимых (N/A) критериев перераспределяется между остальными, итог нормируется до 100"><dt>Применимый вес</dt><dd>${fmtScore(score.applicable_weight)}</dd></div>
          </dl>
          <ul class="cd-facts-list" title="Факты, извлечённые системой автоматически (подсказки для модели)">${factsList(conv.facts)}</ul>
        </div></details>
      </div>`;
  }

  // Facts extracted automatically (hints for the model); the dialog duration is already in the page head.
  function factsList(f) {
    const ref = (id) => `<a class="link" data-goto="${id}">[${id}]</a>`;
    const items = [];
    items.push(`Язык клиента: <b>${esc(f.client_language || "—")}</b>`);
    items.push(`Первая реплика оператора: ${f.first_operator_message_id !== null ? ref(f.first_operator_message_id) : "нет"}`);
    items.push(`Подтверждение личности: ${f.identity_verified_ids.length ? f.identity_verified_ids.map(ref).join(", ") : "нет"}`);
    if (f.ending) items.push(`Завершение: ${ref(f.ending.message_id)} ${esc(f.ending.label)}`);
    f.long_operator_gaps.forEach((g) => items.push(`Пауза ${esc(num(g.seconds))} с перед ${ref(g.operator_id)}`));
    if (f.duplicates.length) items.push(`Повторы распознавания: ${f.duplicates.length}`);
    if (f.internal_ids && f.internal_ids.length) items.push(`Консультация с коллегой: [${f.internal_ids[0]}]–[${f.internal_ids[f.internal_ids.length - 1]}]`);
    const cm = f.call_metrics;
    if (cm) items.push(`Звонок: удержание ${esc(num(cm.hold_sec))} с, речь оператора ${esc(num(cm.operator_share))}%${cm.operator_wpm ? `, темп ≈ ${esc(num(cm.operator_wpm))} сл/мин` : ""}, макс. пауза ${esc(num(cm.longest_silence_sec))} с${cm.longest_silence_before_id !== null ? ` (перед ${ref(cm.longest_silence_before_id)})` : ""}`);
    return items.map((i) => `<li>${i}</li>`).join("");
  }

  function paint() {
    const c = conv.conversation;
    const evs = conv.evaluations;
    const activeId = checklists.find((x) => x.is_active)?.id;
    const isCall = channelLabel(c.channel) === "Звонок";
    const f = conv.facts || {};
    const dur = f.duration_sec ? fmtDuration(f.duration_sec) : "";
    const n = conv.messages.length;
    const replies = `${n} ${plural(n, "реплика", "реплики", "реплик")}`;
    view.innerHTML = `<div class="cd">
      <section class="cd-head" aria-label="Диалог">
        <div class="cd-head-main">
          <a href="#/" class="cd-back" title="Вернуться к списку диалогов" aria-label="Вернуться к списку диалогов">${icon("arrowLeft", { size: 18 })}</a>
          <span class="cd-title-ic" aria-hidden="true">${icon(isCall ? "phone" : "message", { size: 20 })}</span>
          <div class="cd-title">
            <h1 class="cd-id"${c.dataset ? ` title="Набор данных: ${esc(c.dataset)}"` : ""}>${esc(c.id)}</h1>
            <ul class="cd-meta">
              <li title="Канал">${esc(channelLabel(c.channel))}</li>
              ${c.language ? `<li title="Язык диалога">${esc(c.language)}</li>` : ""}
              ${dur ? `<li title="Длительность диалога, ${replies}">${esc(dur)}</li>` : `<li>${replies}</li>`}
            </ul>
          </div>
        </div>
        <div class="cd-actions">
          ${evs.length > 1 ? `<select id="ev-select" class="input input-sm cd-sel" aria-label="История оценок" title="История оценок">${evs.map((e) => `<option value="${e.id}" ${ev && e.id === ev.id ? "selected" : ""}>#${e.id} · ${fmtDate(e.finished_at || e.created_at)} · ${e.status === "done" ? fmtScore(e.final_total) : esc(EV_STATUS[e.status] || e.status)}</option>`).join("")}</select>` : ""}
          <select id="cl-select" class="input input-sm cd-sel" aria-label="Чек-лист" title="Чек-лист для оценки"><option value="auto" selected>Чек-лист: авто</option>${checklists.map((x) => `<option value="${x.id}">${esc(x.name)} v${esc(x.version)}${x.is_active ? " (активный)" : ""}</option>`).join("")}</select>
          <button type="button" class="btn btn-primary" id="run-eval">${icon(ev ? "refresh" : "play", { size: 15 })}${ev ? "Переоценить" : "Оценить"}</button>
        </div>
      </section>
      <div class="card-grid cd-grid">
        <section class="pane transcript-pane" aria-label="Транскрипт диалога">
          <div class="cd-ttop">
            <div class="cd-pane-head">
              <h2>${icon("message", { size: 17 })}Транскрипт</h2>
            </div>
            ${conv.is_voice ? `<div class="player">
              <audio id="audio" controls preload="none" src="${esc(api.audioUrl(convId))}"></audio>
            </div>` : ""}
          </div>
          ${conv.is_voice ? `<div id="audio-panel" class="audio-panel"></div>` : ""}
          <div class="transcript" id="transcript">${conv.messages.map((m) => messageHtml(m, conv.is_voice)).join("")}</div>
        </section>
        <section class="pane result-pane" aria-label="Результат оценки">${resultHtml()}</section>
      </div>
    </div>`;
    bind();
  }

  function goto(id) {
    const el = $(`#m-${id}`, view);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    $$(".msg.flash", view).forEach((x) => x.classList.remove("flash"));
    el.classList.add("flash");
    const m = msgs[id];
    const audio = $("#audio", view);
    if (audio && m && m.t !== null) seek(audio, audioTime(m));
  }

  // Precise recording offset from the audio analysis (Whisper ↔ transcript alignment); falls back to transcript time.
  function audioTime(m) {
    const at = analysis && analysis.audio_t ? analysis.audio_t[String(m.id)] : undefined;
    return at !== undefined && at !== null ? at : m.t;
  }

  let analysis = null;
  let analysisTimer = null;
  // Timeline speaker colours (validated categorical set: brand / info / light violet; client is the neutral party).
  const SPK_COLOR = { operator: "var(--brand)", client: "var(--muted)", bot: "var(--info)", internal: "color-mix(in srgb, var(--violet) 60%, var(--surface))", unknown: "var(--muted-2)" };
  const SPK_NAME = { operator: "Оператор", client: "Клиент", bot: "Голосовое меню", internal: "Консультация", unknown: "Не определено" };

  async function loadAnalysis() {
    if (!conv.is_voice) return;
    try { analysis = await api.audioAnalysis(convId); } catch { analysis = null; }
    paintAnalysis();
    clearTimeout(analysisTimer);
    if (analysis && analysis.status === "running") analysisTimer = setTimeout(loadAnalysis, 4000);
  }

  function paintAnalysis() {
    const box = $("#audio-panel", view);
    if (!box) return;
    const a = analysis || { status: "none" };
    if (a.status === "none" || a.status === "error") {
      const err = a.status === "error";
      box.innerHTML = `<div class="cd-ap-cta ${err ? "cd-ap-cta--err" : ""}">
        <span class="cd-ap-ic">${icon(err ? "alert" : "waveform", { size: 18 })}</span>
        <div class="cd-ap-cta-text"><b>${err ? "Ошибка анализа записи" : "Запись не проанализирована"}</b>${err ? `<span>${esc(a.error || "")}</span>` : ""}</div>
        <button type="button" class="btn btn-sm" id="run-audio" title="Распознавание речи (Whisper, локально), паузы, темп речи, разборчивость. Выполняется и автоматически перед оценкой звонка.">${icon(err ? "refresh" : "waveform", { size: 14 })}${err ? "Повторить" : "Анализировать"}</button></div>`;
      $("#run-audio", box).onclick = async () => { await api.analyzeAudio(convId); toast("Анализ записи запущен (≈ 1 мин)", "ok"); loadAnalysis(); };
      return;
    }
    if (a.status === "running") {
      box.innerHTML = `<div class="cd-ap-cta"><span class="cd-ap-ic"><span class="spin"></span></span><div class="cd-ap-cta-text"><b>Идёт анализ записи…</b></div></div>`;
      return;
    }
    const mt = a.metrics;
    const dur = mt.duration_sec || 1;
    const segs = (a.segments || []);
    const has = (v) => v !== null && v !== undefined && v !== "—";
    // Labels are static markup (may contain a soft hyphen); values are escaped.
    const tile = (ic, v, unit, l, hint = "") => `<div class="mini-tile" title="${esc(hint)}"><b>${has(v) ? esc(num(v)) : "—"}${has(v) && unit ? `<small>${unit}</small>` : ""}</b><span class="cd-tile-l">${icon(ic, { size: 12 })}<span>${l}</span></span></div>`;
    const op = mt.operator, cl = mt.client;
    box.innerHTML = `
      <div class="cd-ap-head"><span class="cd-ap-title" title="Whisper ${esc(a.whisper_model || "")}">${icon("waveform", { size: 15 })}Анализ записи</span></div>
      <div class="mini-tiles cd-stats">
        ${tile("headphones", op.wpm ? op.wpm : "—", "сл/мин", "Темп оператора", "Темп речи оператора по распознаванию с таймингами слов")}
        ${tile("user", cl.wpm ? cl.wpm : "—", "сл/мин", "Темп клиента", "Темп речи клиента")}
        ${tile("waveform", op.confidence !== null && op.confidence !== undefined ? op.confidence : "—", "%", "Разборчивость", "Разборчивость оператора: средняя уверенность распознавания его слов — косвенная оценка дикции")}
        ${tile("pause", mt.pauses.length, "", "Паузы ≥&nbsp;5&nbsp;с", "Тишина вне удержания после подключения оператора")}
        ${tile("clock", Math.round(mt.hold_sec), "с", "Удержание", "Время, когда клиент был на удержании")}
      </div>
      <div class="cd-tl">
        <div class="timeline" id="timeline" title="Шкала записи: кто говорит; красные метки — паузы. Нажмите, чтобы перейти к моменту.">
          ${segs.map((s) => `<span class="tl-seg" style="left:${(s.start / dur) * 100}%;width:${Math.max(0.25, ((s.end - s.start) / dur) * 100)}%;background:${SPK_COLOR[s.speaker] || SPK_COLOR.unknown}" data-at="${s.start}" title="${esc(SPK_NAME[s.speaker] || s.speaker)} ${fmtTime(s.start)}: ${esc(s.text)}"></span>`).join("")}
          ${mt.pauses.map((p) => `<span class="tl-pause" style="left:${(p.start / dur) * 100}%;width:${Math.max(0.4, (p.sec / dur) * 100)}%" data-at="${p.start}" title="Пауза ${esc(num(p.sec))} с"></span>`).join("")}
        </div>
        <div class="cd-tl-axis" aria-hidden="true"><span>00:00</span><span>${fmtTime(mt.duration_sec || 0)}</span></div>
      </div>
      <div class="tl-legend">${["operator", "client", "bot", "internal"].filter((k) => segs.some((s) => s.speaker === k)).map((k) => `<span><i style="background:${SPK_COLOR[k]}"></i>${SPK_NAME[k]}</span>`).join("")}<span title="Пауза ≥ 5 с"><i class="pause-i"></i>Пауза</span></div>
      ${mt.pauses.length ? `<div class="cd-pauses">${mt.pauses.map((p) => `<button type="button" class="cd-chipbtn" data-at="${p.start}" title="Перейти к паузе на ${fmtTime(p.start)}" aria-label="Перейти к паузе на ${fmtTime(p.start)}, длительность ${esc(num(p.sec))} с">${icon("pause", { size: 11 })}<span class="cd-chipbtn-t">${fmtTime(p.start)}</span><span class="cd-chipbtn-d">${esc(num(p.sec))}&nbsp;с</span></button>`).join("")}</div>` : ""}
      <details class="cd-details"><summary>${icon("chevronRight", { size: 13, cls: "cd-chev" })}<span>Расшифровка аудио</span></summary>
        <div class="cd-wmeta" title="Смещение записи относительно транскрипта найдено автоматически по совпадениям реплик — переход к реплике точный">Whisper ${esc(a.whisper_model || "")} · ${esc(num(a.seconds))} с · синхронизация по ${esc(mt.alignment.anchors)} репликам</div>
        <div class="whisper">${segs.map((s) => `<div class="cd-wl"><button type="button" class="link small mono" data-at="${s.start}">${fmtTime(s.start)}</button><span class="cd-spk"><i style="background:${SPK_COLOR[s.speaker] || SPK_COLOR.unknown}"></i>${esc(SPK_NAME[s.speaker] || s.speaker)}:</span> <span>${esc(s.text)}</span></div>`).join("")}</div>
      </details>`;
    box.querySelectorAll("[data-at]").forEach((el) => el.addEventListener("click", (e) => {
      e.stopPropagation();
      const audio = $("#audio", view);
      if (audio) seek(audio, Number(el.dataset.at));
    }));
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  }

  function seek(audio, t) {
    const go = () => { audio.currentTime = Math.max(0, t - 1); audio.play().catch(() => {}); };
    if (audio.readyState >= 1) go();
    else { audio.addEventListener("loadedmetadata", go, { once: true }); audio.load(); }
  }

  function bind() {
    $("#ev-select", view)?.addEventListener("change", (e) => { location.hash = `#/c/${encodeURIComponent(convId)}?e=${e.target.value}`; });
    $("#run-eval", view).addEventListener("click", async () => {
      try {
        const v = $("#cl-select", view).value;
        const job = await api.evaluate([convId], v === "auto" ? "auto" : Number(v));
        jobs.track(job);
        toast("Оценка запущена", "ok");
        evalId = null;
        await load();
        paint();
      } catch (e) { toast(e.message, "bad"); }
    });
    view.addEventListener("click", onClick);
  }

  async function onClick(e) {
    const g = e.target.closest("[data-goto]");
    if (g) { e.preventDefault(); goto(Number(g.dataset.goto)); return; }
    const s = e.target.closest("[data-seek]");
    if (s) {
      const a = $("#audio", view);
      const mm = msgs[Number(s.closest("[data-mid]")?.dataset.mid)];
      if (a) seek(a, mm ? audioTime(mm) : Number(s.dataset.seek));
      return;
    }
    const an = e.target.closest("[data-analysis]");
    if (an) { const id = an.dataset.analysis; showAnalysis.has(id) ? showAnalysis.delete(id) : showAnalysis.add(id); repaintResult(); return; }
    const ap = e.target.closest("[data-appeal]");
    if (ap) { openAppealForm(ap.dataset.appeal); return; }
    // Empty-state shortcut: same action as the «Оценить» button in the page head.
    if (e.target.closest("[data-run-eval]")) $("#run-eval", view)?.click();
  }

  function repaintResult() {
    const pane = $(".result-pane", view);
    const st = pane.scrollTop;
    pane.innerHTML = resultHtml();
    pane.scrollTop = st;
  }

  function openAppealForm(cid) {
    const c = ev.checklist.data.criteria.find((x) => x.id === cid);
    const box = $(`#af-${CSS.escape(cid)}`, view);
    box.hidden = false;
    box.innerHTML = `
      <div class="cd-af-head">${icon("scale", { size: 15 })}<b>Апелляция</b><span class="cd-af-info" title="Апелляция будет передана проверяющему; после его решения итог пересчитается автоматически." aria-label="Апелляция будет передана проверяющему; после его решения итог пересчитается автоматически.">${icon("info", { size: 14 })}</span></div>
      <label class="field"><span>Комментарий *</span>
        <textarea class="input" rows="3" id="ap-comment" placeholder="Почему оценка неверна? Ссылки на реплики: [9]"></textarea></label>
      <label class="field"><span>Предлагаемая оценка</span>
        <select class="input" id="ap-proposed"><option value="">Не указывать</option>${answerOptions(c).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</select></label>
      <div class="row-actions"><button type="button" class="btn btn-primary btn-sm" id="ap-send">${icon("check", { size: 14 })}Отправить</button><button type="button" class="btn btn-ghost btn-sm" id="ap-cancel">Отмена</button></div>`;
    $("#ap-comment", box).focus();
    $("#ap-cancel", box).onclick = () => { box.hidden = true; box.innerHTML = ""; };
    $("#ap-send", box).onclick = async () => {
      const comment = $("#ap-comment", box).value.trim();
      if (!comment) return toast("Добавьте комментарий", "warn");
      try {
        const a = await api.createAppeal({ evaluation_id: ev.id, criterion_id: cid, comment, proposed_answer: $("#ap-proposed", box).value || null, author: "Супервайзер" });
        toast(`Апелляция #${a.id} отправлена проверяющему`, "ok");
        ev = await api.evaluation(ev.id);
        repaintResult();
      } catch (err) { toast(err.message, "bad"); }
    };
  }

  paint();
  loadAnalysis();
  // Repaint only when THIS dialog's evaluation changes state (not on every tick of a batch),
  // so playback and a half-written appeal are not wiped.
  const seen = new Map();
  let alive = true;
  const off = jobs.onUpdate(async (j) => {
    const item = j.items.find((i) => i.conversation_id === convId);
    if (!item) return;
    const key = `${j.id}:${item.evaluation_id}`;
    if (seen.get(key) === item.status) return;
    const first = !seen.has(key);
    seen.set(key, item.status);
    if (first && item.status === "queued") return;
    if (!["done", "error", "cancelled", "running"].includes(item.status)) return;
    await load();
    if (alive) { paint(); loadAnalysis(); }
  });
  return { destroy() { alive = false; clearTimeout(analysisTimer); off(); view.removeEventListener("click", onClick); } };
}
