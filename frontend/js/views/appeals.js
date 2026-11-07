import { api } from "../api.js";
import { $, SPEAKER, answerChip, answerOptions, answerText, esc, fmtDate, fmtScore, role, scoreBadge, spinner, toast } from "../ui.js";

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

  function paint() {
    const items = list.filter((a) => (tab === "open" ? a.status === "open" : a.status !== "open"));
    if (!selectedId && items.length) selectedId = items[0].id;
    view.innerHTML = `
      <section class="page-head">
        <div><h1>Апелляции</h1>
        <p class="muted">${role() === "reviewer" ? "Вы — проверяющий: изучите доказательства, подтвердите или измените оценку и укажите причину." : "Вы — супервайзер: здесь видно состояние поданных апелляций. Для принятия решения переключитесь на роль «Проверяющий»."}</p></div>
      </section>
      <div class="tabs">
        <button data-tab="open" class="${tab === "open" ? "active" : ""}">Открытые (${list.filter((a) => a.status === "open").length})</button>
        <button data-tab="decided" class="${tab === "decided" ? "active" : ""}">Рассмотренные (${list.filter((a) => a.status !== "open").length})</button>
      </div>
      <div class="split">
        <aside class="split-list">${items.length ? items.map((a) => `
          <button class="ap-item ${a.id === selectedId ? "active" : ""}" data-ap="${a.id}">
            <div><b>#${a.id}</b> <span class="mono">${esc(a.conversation_id)}</span></div>
            <div class="small">${esc(a.criterion_title)}</div>
            <div class="small muted">${fmtDate(a.created_at)} · ${esc(a.author || "")}</div>
            ${a.status !== "open" ? `<div class="small">${a.decision === "change" ? "Изменено" : "Подтверждено"} · ${fmtScore(a.total_before)} → ${fmtScore(a.total_after)}</div>` : ""}
          </button>`).join("") : `<div class="empty small">Нет апелляций</div>`}
        </aside>
        <section class="split-detail" id="ap-detail">${items.length ? spinner() : `<div class="empty"><h3>Апелляций нет</h3><p>Апелляцию подают из карточки диалога кнопкой «Оспорить» у критерия.</p></div>`}</section>
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
    const fragment = [...ids].sort((x, y) => x - y).map((id) => {
      const m = msgs[id];
      return `<div class="frag ${ev_ids.has(id) ? "frag-ev" : ""} frag-${esc(m.speaker)}"><span class="msg-id">[${id}] ${esc(m.t_label)}</span> <b>${esc(SPEAKER[m.speaker] || m.speaker)}:</b> ${esc(m.text)}</div>`;
    }).join("");
    const canDecide = role() === "reviewer" && a.status === "open";
    box.innerHTML = `
      <div class="ap-head">
        <h2>Апелляция #${a.id} · ${esc(c.code || "")} ${esc(c.title)}</h2>
        <a class="link" href="#/c/${encodeURIComponent(a.conversation_id)}?e=${a.evaluation_id}">Открыть карточку диалога ${esc(a.conversation_id)} →</a>
      </div>
      <div class="ap-grid">
        <div class="ap-block">
          <div class="label">Спорная оценка</div>
          <div>${answerChip(a.original.answer, answerText(c, a.original.answer), c.type)} <span class="muted small">итог диалога сейчас: ${scoreBadge(ev.final_total)}</span></div>
          <p class="crit-expl">${esc(a.original.explanation || r.explanation || "")}</p>
          <div class="label">Комментарий апелляции · ${esc(a.author || "")} · ${fmtDate(a.created_at)}</div>
          <blockquote>${esc(a.comment)}</blockquote>
          ${a.proposed_answer !== null && a.proposed_answer !== undefined ? `<div class="small">Предложено: <b>${esc(answerText(c, a.proposed_answer))}</b></div>` : ""}
        </div>
        <div class="ap-block">
          <div class="label">Фрагмент диалога (доказательства выделены)</div>
          <div class="fragment">${fragment}</div>
        </div>
      </div>
      <div class="ap-block">
        <div class="label">Критерий</div>
        <div class="small">${c.type === "scale" ? c.scale.map((s) => `<div><b>${s.value}</b> — ${esc(s.description)}</div>`).join("") : `<div><b>Да</b> — ${esc(c.yes_rule)}</div>${c.na_allowed ? `<div><b>N/A</b> — ${esc(c.na_rule)}</div>` : ""}`}</div>
      </div>
      ${a.status === "open" ? `
      <div class="ap-block decision ${canDecide ? "" : "disabled"}">
        <div class="label">Решение проверяющего</div>
        ${canDecide ? "" : `<p class="muted small">Решение принимает проверяющий. Переключите роль вверху справа.</p>`}
        <div class="radio-row">
          <label><input type="radio" name="dec" value="confirm" checked ${canDecide ? "" : "disabled"}> Подтвердить оценку</label>
          <label><input type="radio" name="dec" value="change" ${canDecide ? "" : "disabled"}> Изменить оценку</label>
        </div>
        <label class="field" id="new-ans-field" hidden><span>Новая оценка</span>
          <select class="input" id="new-ans">${answerOptions(c).filter((o) => o.value !== String(a.original.answer)).map((o) => `<option value="${o.value}" ${String(a.proposed_answer) === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>
        <label class="field"><span>Причина решения *</span><textarea class="input" id="reason" rows="3" ${canDecide ? "" : "disabled"} placeholder="Например: оператор попрощался в реплике [11], критерий выполнен."></textarea></label>
        <button class="btn btn-primary" id="decide" ${canDecide ? "" : "disabled"}>Сохранить решение и пересчитать итог</button>
      </div>` : `
      <div class="ap-block decided-block">
        <div class="label">Решение · ${esc(a.reviewer || "")} · ${fmtDate(a.decided_at)}</div>
        <div>${a.decision === "change" ? `Оценка изменена: <b>${esc(answerText(c, a.original.answer))} → ${esc(answerText(c, a.new_answer))}</b>` : "Оценка подтверждена"}</div>
        <div class="small">Причина: ${esc(a.reviewer_comment)}</div>
        <div class="result-line">Итог диалога: <span class="strike">${fmtScore(a.total_before)}</span> → ${scoreBadge(a.total_after)}</div>
        <div class="small muted">В карточке сохранены исходная оценка ИИ, решение и финальный результат.</div>
      </div>`}`;
    if (canDecide) {
      box.querySelectorAll("input[name=dec]").forEach((r) => r.onchange = () => { $("#new-ans-field", box).hidden = r.value !== "change" || !r.checked; });
      $("#decide", box).onclick = async () => {
        const decision = box.querySelector("input[name=dec]:checked").value;
        const reason = $("#reason", box).value.trim();
        if (!reason) return toast("Укажите причину решения", "warn");
        try {
          const res = await api.decideAppeal(a.id, { decision, reason, new_answer: decision === "change" ? $("#new-ans", box).value : null, reviewer: "Проверяющий" });
          toast(`Решение сохранено. Итог: ${fmtScore(a.total_before)} → ${fmtScore(res.final_total)}`, "ok", 6000);
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
