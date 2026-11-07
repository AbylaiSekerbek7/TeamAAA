import { api } from "../api.js";
import { $, esc, fmtScore, spinner } from "../ui.js";

function hbars(rows, { max = 100, suffix = "", empty = "нет данных" } = {}) {
  if (!rows.length) return `<div class="muted small">${empty}</div>`;
  return `<div class="hbars">${rows.map((r) => {
    const v = r.value;
    const w = v === null || v === undefined ? 0 : Math.max(0, Math.min(100, (v / max) * 100));
    return `<div class="hbar" title="${esc(r.label)}: ${v === null || v === undefined ? "—" : fmtScore(v) + suffix}${r.hint ? " · " + esc(r.hint) : ""}">
      <span class="hbar-label">${esc(r.label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${w}%"></span></span>
      <span class="hbar-val">${v === null || v === undefined ? "—" : fmtScore(v) + suffix}</span>
    </div>`;
  }).join("")}</div>`;
}

function histogram(counts) {
  const max = Math.max(1, ...counts);
  return `<div class="histo">${counts.map((n, i) => `
    <div class="histo-col" title="${i * 10}–${i === 9 ? 100 : i * 10 + 9.99}: ${n} диалогов">
      <span class="histo-n">${n || ""}</span>
      <span class="histo-bar" style="height:${(n / max) * 100}%"></span>
      <span class="histo-x">${i * 10}</span>
    </div>`).join("")}</div>`;
}

export async function renderAnalytics(view) {
  view.innerHTML = spinner();
  const convs = await api.conversations();
  const datasets = [...new Set(convs.map((c) => c.dataset).filter(Boolean))];
  let ds = "";

  async function paint() {
    const [st, acc] = await Promise.all([api.stats(ds), api.accuracy(ds)]);
    view.innerHTML = `
      <section class="page-head">
        <div><h1>Аналитика</h1><p class="muted">По последней оценке каждого диалога с учётом решений по апелляциям.</p></div>
        <div class="head-actions">
          <select class="input" id="ds">${[["", "Все наборы"], ...datasets.map((d) => [d, d])].map(([v, l]) => `<option value="${esc(v)}" ${v === ds ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
          <a class="btn btn-ghost" href="${api.exportUrl("csv", ds)}">Экспорт CSV</a>
          <a class="btn btn-ghost" href="${api.exportUrl("json", ds)}">Экспорт JSON</a>
        </div>
      </section>
      ${!st.count ? `<div class="empty"><h3>Пока нет оценок</h3><p>Запустите оценку диалогов на вкладке «Диалоги».</p></div>` : `
      <div class="tiles">
        <div class="tile"><div class="tile-v">${st.count}</div><div class="tile-l">оценено диалогов</div></div>
        <div class="tile"><div class="tile-v">${fmtScore(st.avg_total)}</div><div class="tile-l">средний итоговый балл</div></div>
        <div class="tile ${st.gross_errors.length ? "tile-bad" : ""}"><div class="tile-v">${st.gross_errors.length ? "⚠ " : ""}${st.gross_errors.length}</div><div class="tile-l">диалогов с грубой ошибкой</div></div>
        <div class="tile"><div class="tile-v">${st.appeals.open}</div><div class="tile-l">открытых апелляций (рассмотрено ${st.appeals.decided})</div></div>
      </div>
      <div class="grid2">
        <section class="panel"><h3>Выполнение критериев, % от максимума</h3>
          ${hbars(st.criteria.filter((c) => c.type !== "flag").map((c) => ({ label: `${c.code || ""} ${c.title}`, value: c.pass_rate, hint: `применим в ${c.applicable} из ${c.n}, N/A: ${c.na}` })), { suffix: "%" })}
          <p class="muted small">Для шкальных критериев — средняя доля от верхней ступени. N/A не учитывается.</p>
        </section>
        <section class="panel"><h3>Распределение итоговых баллов</h3>${histogram(st.histogram)}
          <h3 class="mt">Средний балл по языкам</h3>
          ${hbars(Object.entries(st.by_language).map(([k, v]) => ({ label: k, value: v.avg, hint: `${v.n} диалогов` })))}
          <h3 class="mt">Средний балл по каналам</h3>
          ${hbars(Object.entries(st.by_channel).map(([k, v]) => ({ label: k === "voice call" ? "Звонки" : "Чаты", value: v.avg, hint: `${v.n} диалогов` })))}
        </section>
      </div>
      ${st.gross_errors.length ? `<section class="panel"><h3>⚠ Диалоги с грубыми ошибками</h3><div class="chips">${st.gross_errors.map((id) => `<a class="tag tag-bad" href="#/c/${encodeURIComponent(id)}">${esc(id)}</a>`).join(" ")}</div></section>` : ""}
      `}
      ${acc.dialogs ? `
      <section class="panel">
        <h3>Сверка с эталонной разметкой</h3>
        <p class="muted small">Сравнение ответов ИИ с ручной разметкой (data/labels/*.json) — по каждому критерию и по итоговому баллу. Используется для калибровки промптов.</p>
        <div class="tiles">
          <div class="tile"><div class="tile-v">${acc.criterion_accuracy}%</div><div class="tile-l">совпадение по критериям</div></div>
          <div class="tile"><div class="tile-v">${fmtScore(acc.total_mae)}</div><div class="tile-l">средняя ошибка итога, баллов</div></div>
          <div class="tile"><div class="tile-v">${acc.exact_total} / ${acc.dialogs}</div><div class="tile-l">итог совпал точно</div></div>
        </div>
        ${hbars(acc.criteria.map((c) => ({ label: `${c.code || ""} ${c.title}`, value: c.accuracy, hint: `${c.match} из ${c.n}` })), { suffix: "%" })}
        <details class="mt"><summary>Расхождения по диалогам (${acc.rows.filter((r) => r.mismatches.length).length})</summary>
          <table class="table compact"><thead><tr><th>Диалог</th><th class="num">Эталон</th><th class="num">ИИ</th><th class="num">Ошибка</th><th>Критерии с расхождением</th></tr></thead>
          <tbody>${acc.rows.filter((r) => r.mismatches.length).map((r) => `<tr>
            <td><a class="mono" href="#/c/${encodeURIComponent(r.conversation_id)}">${esc(r.conversation_id)}</a></td>
            <td class="num">${fmtScore(r.expected_total)}</td><td class="num">${fmtScore(r.ai_total)}</td><td class="num">${fmtScore(r.abs_error)}</td>
            <td class="small">${r.mismatches.map((m) => `${esc(m.criterion_id)}: ${esc(m.expected)} → ${esc(m.got)}`).join("; ")}</td></tr>`).join("")}</tbody></table>
        </details>
      </section>` : ""}`;
    $("#ds", view).onchange = (e) => { ds = e.target.value; paint(); };
  }
  await paint();
  return {};
}
