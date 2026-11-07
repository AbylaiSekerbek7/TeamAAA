import { api } from "../api.js";
import { $, $$, SPEAKER, answerChip, answerOptions, answerText, channelLabel, esc, fmtDate, fmtDuration, fmtScore, role, scoreBadge, spinner, toast } from "../ui.js";
import { jobs } from "../jobs.js";

const EVENT_ICON = {
  escalation: "↪", identity_verified: "🛡", operator_closed: "⏹", client_left: "🚪", connection_lost: "⚡",
  recording_paused: "⏸", recording_resumed: "⏺", operator_joined: "👤",
};

function messageHtml(m, isVoice) {
  if (m.speaker === "system") {
    return `<div class="msg msg-system ${m.duplicate_of !== null ? "dup" : ""}" id="m-${m.id}" data-mid="${m.id}">
      <span class="msg-id">[${m.id}]</span> ${EVENT_ICON[m.event] || "•"} ${esc(m.text)} <span class="msg-time">${esc(m.t_label)}</span>
    </div>`;
  }
  return `<div class="msg msg-${esc(m.speaker)} ${m.duplicate_of !== null ? "dup" : ""} ${m.internal ? "msg-internal" : ""}" id="m-${m.id}" data-mid="${m.id}">
    <div class="msg-meta">
      <span class="msg-id">[${m.id}]</span>
      <b>${esc(SPEAKER[m.speaker] || m.speaker)}</b>${m.internal ? ` <span class="tag" title="Клиент на удержании — оператор консультируется с коллегой">внутр. консультация</span>` : ""}
      <span class="msg-time" title="${esc(m.timestamp)}">${esc(m.t_label)}</span>
      ${isVoice && m.t !== null ? `<button class="play-btn" data-seek="${m.t}" title="Прослушать с этого места">▶</button>` : ""}
      ${m.duplicate_of !== null ? `<span class="muted small">повтор [${m.duplicate_of}]</span>` : ""}
    </div>
    <div class="msg-text">${esc(m.text)}</div>
  </div>`;
}

function evidenceHtml(ids, msgs, answer) {
  if (!ids || !ids.length) return `<div class="evidence-empty muted small">Реплика не указана</div>`;
  const title = answer === "na" ? "Основание N/A" : answer === "no" || answer === 0 ? "Проверенный участок / где ожидалось действие" : "Доказательство";
  return `<div class="evidence"><div class="evidence-title">${title}</div>${ids.map((id) => {
    const m = msgs[id];
    if (!m) return "";
    const short = m.text.length > 140 ? m.text.slice(0, 140) + "…" : m.text;
    return `<button class="ev" data-goto="${id}" title="Перейти к реплике">
      <span class="ev-id">[${id}] ${esc(m.t_label)} · ${esc(SPEAKER[m.speaker] || m.speaker)}</span>
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
    const pts = c.type === "flag" ? `<span class="muted small">без баллов</span>`
      : row.applicable ? `<span class="pts"><b>${fmtScore(row.points)}</b> / ${fmtScore(row.effective_weight)} б.</span><span class="muted small" title="Базовый вес из чек-листа и вес после перераспределения N/A">вес ${c.weight}${row.effective_weight !== c.weight ? ` → ${fmtScore(row.effective_weight)}` : ""}</span>`
      : `<span class="muted small">исключён из расчёта (вес ${c.weight} перераспределён)</span>`;
    return `<article class="crit ${finalAnswer === "na" ? "crit-na" : ""} ${c.type === "flag" && finalAnswer === "yes" ? "crit-flag" : ""}" id="crit-${esc(c.id)}">
      <header class="crit-head">
        <span class="crit-code">${esc(c.code || "")}</span>
        <h4>${esc(c.title)}</h4>
        <div class="crit-answer">
          ${ov ? `<span class="strike" title="Исходная оценка ИИ">${esc(answerText(c, r.answer))}</span> → ` : ""}
          ${answerChip(finalAnswer, answerText(c, finalAnswer), c.type)}
        </div>
      </header>
      <div class="crit-points">${pts}${r.source === "rule" ? `<span class="conf" title="Критерий формальный: проверен детерминированным правилом по ключевым словам и системным событиям">⚙ проверено правилом</span>` : ""}${r.confidence !== undefined && r.votes && r.votes.length > 1 ? `<span class="conf ${r.confidence < 1 ? "conf-low" : ""}" title="Согласие голосов модели: ${esc(r.votes.join(", "))}">уверенность ${Math.round(r.confidence * 100)}%</span>` : ""}</div>
      <p class="crit-expl">${esc(r.explanation || "")}</p>
      ${evidenceHtml(r.evidence_ids, msgs, finalAnswer)}
      ${r.analysis ? `<button class="link small" data-analysis="${esc(c.id)}">${showAnalysis.has(c.id) ? "Скрыть ход рассуждения" : "Показать ход рассуждения модели"}</button>
        ${showAnalysis.has(c.id) ? `<p class="analysis">${esc(r.analysis)}</p>` : ""}` : ""}
      ${ov ? `<div class="override">✎ Изменено проверяющим (${esc(ov.reviewer || "")}): <b>${esc(answerText(c, ov.previous))} → ${esc(answerText(c, ov.answer))}</b>. Причина: ${esc(ov.reason)}</div>` : ""}
      ${decided.filter((a) => a.decision === "confirm").map((a) => `<div class="override confirm">✔ Апелляция #${a.id} отклонена, оценка подтверждена. Причина: ${esc(a.reviewer_comment)}</div>`).join("")}
      <footer class="crit-foot">
        ${openAppeal ? `<span class="tag tag-warn">На апелляции #${openAppeal.id}</span> <a class="link small" href="#/appeals?id=${openAppeal.id}">${role() === "reviewer" ? "Рассмотреть" : "Открыть"}</a>`
          : role() === "supervisor" ? `<button class="btn btn-ghost btn-sm" data-appeal="${esc(c.id)}">Оспорить</button>` : ""}
      </footer>
      <div class="appeal-form" id="af-${esc(c.id)}" hidden></div>
    </article>`;
  }

  function resultHtml() {
    if (!ev) {
      return `<div class="empty"><h3>Диалог ещё не оценён</h3><p>Выберите чек-лист и запустите оценку — модель проверит каждый критерий и укажет реплики-доказательства.</p></div>`;
    }
    if (ev.status !== "done") {
      const busy = ["queued", "running"].includes(ev.status) || jobs.isBusy(convId);
      return `<div class="empty">${busy ? `<span class="spin"></span><h3>Оценка выполняется…</h3><p>Результат появится автоматически.</p>` : `<h3>Оценка не завершена</h3><p>${esc(ev.error || ev.status)}</p>`}</div>`;
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
    return `
      ${missing.length ? `<div class="override">⚠ Модель не смогла оценить: ${missing.map((id) => esc((crits.find((c) => c.id === id) || {}).title || id)).join(", ")}. Итог не рассчитан — запустите переоценку или задайте оценку через апелляцию.</div>` : ""}
      <div class="summary">
        <div class="summary-score">
          <div class="big">${scoreBadge(ev.final_total, "score-xl")}</div>
          <div class="summary-cap">${score.total_calculated ? "итоговый балл из 100" : missing.length ? "итог не рассчитан — есть неоценённые критерии" : "итог не рассчитывается — нет применимых критериев"}</div>
          ${changed ? `<div class="small">ИИ: <span class="strike">${fmtScore(ev.total)}</span> → после апелляции: <b>${fmtScore(ev.final_total)}</b></div>` : ""}
        </div>
        <div class="summary-side">
          ${score.gross_error ? `<div class="gross">⚠ Грубая ошибка</div>` : `<div class="gross-ok">Грубых ошибок нет</div>`}
          <div class="small muted">N/A: ${naCount} · применимый вес ${fmtScore(score.applicable_weight)} → нормирован до 100</div>
          <div class="small muted">${esc(ev.checklist.name)} v${ev.checklist.version} · ${esc(ev.model || "")}</div>
          <div class="small muted">${fmtDate(ev.finished_at)} · ${fmtDuration((ev.result.duration_ms || 0) / 1000)} · ${(ev.result.prompt_tokens + ev.result.completion_tokens).toLocaleString("ru-RU")} токенов</div>
        </div>
      </div>
      ${sections.length ? `<div class="sections">${sections.map((s) => `
        <div class="section-row">
          <span>${esc(s.section)}</span>
          <div class="bar"><div style="width:${s.percent ?? 0}%"></div></div>
          <span class="mono small">${s.points === null ? "N/A" : `${fmtScore(s.points)} / ${fmtScore(s.max_points)}`}</span>
        </div>`).join("")}</div>` : ""}
      <div class="crits">${crits.map(criterionCard).join("")}</div>
      <details class="facts"><summary>Факты, извлечённые системой автоматически (подсказки для модели)</summary>
        <ul>${factsList(conv.facts)}</ul></details>`;
  }

  function factsList(f) {
    const items = [];
    items.push(`Язык клиента: <b>${esc(f.client_language || "—")}</b>; первая реплика оператора: ${f.first_operator_message_id !== null ? `<a class="link" data-goto="${f.first_operator_message_id}">[${f.first_operator_message_id}]</a>` : "нет"}`);
    items.push(`Подтверждение личности: ${f.identity_verified_ids.length ? f.identity_verified_ids.map((i) => `<a class="link" data-goto="${i}">[${i}]</a>`).join(", ") : "нет"}`);
    if (f.ending) items.push(`Завершение: <a class="link" data-goto="${f.ending.message_id}">[${f.ending.message_id}]</a> ${esc(f.ending.label)}`);
    f.long_operator_gaps.forEach((g) => items.push(`Пауза ${g.seconds} с перед ответом оператора <a class="link" data-goto="${g.operator_id}">[${g.operator_id}]</a>`));
    if (f.duplicates.length) items.push(`Повторы распознавания: ${f.duplicates.length}`);
    if (f.internal_ids && f.internal_ids.length) items.push(`Внутренняя консультация с коллегой (клиент на удержании): [${f.internal_ids[0]}]–[${f.internal_ids[f.internal_ids.length - 1]}]`);
    const cm = f.call_metrics;
    if (cm) items.push(`<b>Метрики звонка</b> (по таймингам распознавания): длительность ${fmtDuration(cm.duration_sec)}, на удержании ${cm.hold_sec} с,
      доля речи оператора ${cm.operator_share}%${cm.operator_wpm ? `, темп речи оператора ≈ ${cm.operator_wpm} слов/мин` : ""},
      самая длинная пауза вне удержания ${cm.longest_silence_sec} с${cm.longest_silence_before_id !== null ? ` (перед <a class="link" data-goto="${cm.longest_silence_before_id}">[${cm.longest_silence_before_id}]</a>)` : ""}`);
    if (f.duration_sec) items.push(`Длительность: ${fmtDuration(f.duration_sec)}`);
    return items.map((i) => `<li>${i}</li>`).join("");
  }

  function paint() {
    const c = conv.conversation;
    const evs = conv.evaluations;
    const activeId = checklists.find((x) => x.is_active)?.id;
    view.innerHTML = `
      <section class="card-head">
        <a href="#/" class="link">← Все диалоги</a>
        <div class="card-title">
          <h1 class="mono">${esc(c.id)}</h1>
          <span class="tag">${channelLabel(c.channel)}</span><span class="tag">${esc(c.language || "")}</span><span class="tag">${esc(c.dataset || "")}</span>
          <span class="muted small">${conv.messages.length} реплик</span>
        </div>
        <div class="card-actions">
          ${evs.length > 1 ? `<select id="ev-select" class="input input-sm" aria-label="История оценок">${evs.map((e) => `<option value="${e.id}" ${ev && e.id === ev.id ? "selected" : ""}>Оценка #${e.id} · ${fmtDate(e.finished_at || e.created_at)} · ${e.status === "done" ? fmtScore(e.final_total) : e.status}</option>`).join("")}</select>` : ""}
          <select id="cl-select" class="input input-sm" aria-label="Чек-лист"><option value="auto" selected>Авто: чек-лист по каналу</option>${checklists.map((x) => `<option value="${x.id}">${esc(x.name)} v${x.version}${x.is_active ? " (активный)" : ""}</option>`).join("")}</select>
          <button class="btn btn-primary" id="run-eval">${ev ? "Переоценить" : "Оценить"}</button>
        </div>
      </section>
      <div class="card-grid">
        <section class="pane transcript-pane">
          ${conv.is_voice ? `<div class="player">
              <audio id="audio" controls preload="none" src="${api.audioUrl(convId)}"></audio>
              <div class="muted small">Запись звонка. Нажмите ▶ у реплики или на доказательство, чтобы перейти к фрагменту. Время отсчитывается от начала записи.</div>
            </div>` : ""}
          <div class="transcript" id="transcript">${conv.messages.map((m) => messageHtml(m, conv.is_voice)).join("")}</div>
        </section>
        <section class="pane result-pane">${resultHtml()}</section>
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
    if (audio && m && m.t !== null) seek(audio, m.t);
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
    if (s) { const a = $("#audio", view); if (a) seek(a, Number(s.dataset.seek)); return; }
    const an = e.target.closest("[data-analysis]");
    if (an) { const id = an.dataset.analysis; showAnalysis.has(id) ? showAnalysis.delete(id) : showAnalysis.add(id); repaintResult(); return; }
    const ap = e.target.closest("[data-appeal]");
    if (ap) { openAppealForm(ap.dataset.appeal); return; }
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
      <label class="field"><span>Комментарий к апелляции *</span>
        <textarea class="input" rows="3" id="ap-comment" placeholder="Почему оценка неверна? Сошлитесь на реплики, например [9]."></textarea></label>
      <label class="field"><span>Предлагаемая оценка (необязательно)</span>
        <select class="input" id="ap-proposed"><option value="">— не указывать —</option>${answerOptions(c).map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join("")}</select></label>
      <div class="row-actions"><button class="btn btn-primary btn-sm" id="ap-send">Подать апелляцию</button><button class="btn btn-ghost btn-sm" id="ap-cancel">Отмена</button></div>`;
    $("#ap-comment", box).focus();
    $("#ap-cancel", box).onclick = () => { box.hidden = true; box.innerHTML = ""; };
    $("#ap-send", box).onclick = async () => {
      const comment = $("#ap-comment", box).value.trim();
      if (!comment) return toast("Добавьте комментарий", "warn");
      try {
        const a = await api.createAppeal({ evaluation_id: ev.id, criterion_id: cid, comment, proposed_answer: $("#ap-proposed", box).value || null, author: "Супервайзер" });
        toast(`Апелляция #${a.id} сохранена и передана проверяющему`, "ok");
        ev = await api.evaluation(ev.id);
        repaintResult();
      } catch (err) { toast(err.message, "bad"); }
    };
  }

  paint();
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
    if (alive) paint();
  });
  return { destroy() { alive = false; off(); view.removeEventListener("click", onClick); } };
}
