import { api } from "../api.js";
import { icon } from "../icons.js";
import { $, esc, fmtScore, spinner } from "../ui.js";

// Display names for language codes (the code itself is still shown as a badge).
const LANG_NAME = { RU: "Русский", KZ: "Казахский", EN: "Английский" };
// Lower score threshold used across the product (see scoreClass() in ui.js).
const WEAK_BELOW = 60;

const isNum = (v) => v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v));

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
const dialogsWord = (n) => `${n} ${plural(n, "диалог", "диалога", "диалогов")}`;
const share = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

// Small info icon: the explanation lives in its tooltip, not on screen.
const info = (text) => `<span class="an-info" tabindex="0" role="img" title="${esc(text)}" aria-label="${esc(text)}">${icon("info", { size: 14 })}</span>`;

// Section header used by every panel: muted icon, short title, optional info tooltip and aside.
function head(ic, title, { id = "", tip = "", aside = "" } = {}) {
  return `<header class="an-head">
    <span class="an-head-ic">${icon(ic, { size: 16 })}</span>
    <h3${id ? ` id="${id}"` : ""}>${esc(title)}</h3>${tip ? info(tip) : ""}
    ${aside ? `<div class="an-head-aside">${aside}</div>` : ""}
  </header>`;
}

/**
 * Horizontal bars, one brand hue. Each row: [code] label · value, track below.
 * rows: { code?, lead? (trusted HTML), title, value, hint? } — hint (counts etc.) goes to the row tooltip.
 * ref: optional reference tick (same scale as max).
 */
function hbars(rows, { max = 100, suffix = "", empty = "Нет данных", weakBelow = null, ref = null, split = false } = {}) {
  if (!rows.length) return `<p class="an-nodata">${esc(empty)}</p>`;
  if (split && rows.length > 1) {
    // Two columns, read top-to-bottom: first half on the left, second half on the right.
    const half = Math.ceil(rows.length / 2);
    const opts = { max, suffix, empty, weakBelow, ref };
    return `<div class="an-bars-cols">${hbars(rows.slice(0, half), opts)}${hbars(rows.slice(half), opts)}</div>`;
  }
  const refPos = isNum(ref) ? Math.max(0, Math.min(100, (ref / max) * 100)) : null;
  const body = rows.map((r) => {
    const has = isNum(r.value);
    const w = has ? Math.max(0, Math.min(100, (r.value / max) * 100)) : 0;
    const val = has ? fmtScore(r.value) + suffix : "—";
    const weak = has && weakBelow !== null && r.value < weakBelow;
    const name = `${r.code ? r.code + " " : ""}${r.title}`;
    const tip = `${name}: ${val}${r.hint ? "; " + r.hint : ""}${weak ? `; ниже ${weakBelow}${suffix}` : ""}`;
    return `<li class="an-bar${weak ? " is-weak" : ""}" title="${esc(tip)}">
      <div class="an-bar-top">
        ${r.code ? `<span class="crit-code">${esc(r.code)}</span>` : ""}${r.lead || ""}
        <span class="an-bar-label">${esc(r.title)}</span>
        <span class="an-bar-val">${weak ? icon("alert", { size: 14, cls: "an-weak-ic", label: `Ниже ${weakBelow}${suffix}` }) : ""}${esc(val)}</span>
      </div>
      <div class="an-track"><span class="an-fill" style="width:${w.toFixed(1)}%"></span>${refPos !== null ? `<span class="an-ref" style="left:${refPos.toFixed(1)}%"></span>` : ""}</div>
    </li>`;
  }).join("");
  return `<div class="an-bars-block"><ul class="an-bars" role="list">${body}</ul></div>`;
}

// Distribution of final scores in ten 10-point bins (the last bin includes 100).
// The x axis is labelled at bin edges (0, 10 … 100), so labels never collide on narrow panels;
// the exact range of every column stays in its title / aria-label.
function histogram(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  const range = (i) => `${i * 10}–${i === 9 ? 100 : i * 10 + 9}`;
  const cols = counts.map((n, i) => {
    const text = `${range(i)} баллов: ${dialogsWord(n)}`;
    return `<li class="an-hcol" title="${esc(text)}" aria-label="${esc(text)}">
      <span class="an-hval" aria-hidden="true">${n || ""}</span>
      <span class="an-hbar" aria-hidden="true" style="height:calc((100% - 22px) * ${(n / max).toFixed(4)})"></span>
    </li>`;
  }).join("");
  const sum = (a, b) => counts.slice(a, b).reduce((x, y) => x + y, 0);
  const buckets = [
    ["Ниже 60", sum(0, 6)],
    ["60–79", sum(6, 8)],
    ["80–100", sum(8, 10)],
  ];
  return `<div class="an-histo-box">
      <ul class="an-histo" role="list" aria-label="Распределение итоговых баллов">${cols}</ul>
      <div class="an-hx" aria-hidden="true">${Array.from({ length: 11 }, (_, i) => `<span style="left:${i * 10}%">${i * 10}</span>`).join("")}</div>
    </div>
    <dl class="an-buckets">${buckets.map(([l, n]) => `
      <div class="an-bucket"><dt>${esc(l)}</dt><dd><b>${n}</b><small>${share(n, total)}%</small></dd></div>`).join("")}
    </dl>`;
}

// KPI tile: label + value (+ tiny unit). `icTip` turns the icon into a labelled status mark,
// `title` keeps secondary details in a tooltip, `extra` is trusted HTML placed in the value row.
function kpi({ ic, label, value, unit = "", tone = "", icTip = "", title = "", extra = "" }) {
  return `<article class="kpi an-kpi ${tone}"${title ? ` title="${esc(title)}"` : ""}>
    <div class="an-kpi-head"><span class="kpi-label">${esc(label)}</span><span class="an-kpi-ic"${icTip ? ` title="${esc(icTip)}"` : ""}>${icon(ic, { size: 16, label: icTip })}</span></div>
    <div class="kpi-value">${value}${unit ? `<span class="an-unit">${esc(unit)}</span>` : ""}${extra}</div>
  </article>`;
}

// Level of the average score, shown as the tone of the KPI icon (text stays in its tooltip).
function level(avg) {
  if (!isNum(avg)) return { cls: "", text: "" };
  if (avg >= 85) return { cls: "lvl-ok", text: "Высокий уровень" };
  if (avg >= 60) return { cls: "lvl-mid", text: "Средний уровень" };
  return { cls: "lvl-bad", text: "Низкий уровень" };
}

const answerLabel = (v) => (v === "yes" ? "Да" : v === "no" ? "Нет" : v === "na" ? "N/A" : v === null || v === undefined ? "—" : String(v));

function calibration(acc) {
  const byId = Object.fromEntries(acc.criteria.map((c) => [c.id, c]));
  const diffRows = acc.rows.filter((r) => r.mismatches.length);
  const exactShare = share(acc.exact_total, acc.dialogs);
  const stat = (label, value, tip = "") => `<div class="an-stat"${tip ? ` title="${esc(tip)}"` : ""}><span class="an-stat-l">${esc(label)}</span><span class="an-stat-v">${value}</span></div>`;
  const deviation = (r) => {
    if (!isNum(r.abs_error)) return "—";
    const d = isNum(r.ai_total) && isNum(r.expected_total) ? Number(r.ai_total) - Number(r.expected_total) : 0;
    if (!d) return `<span class="an-dev">${fmtScore(r.abs_error)}</span>`;
    const up = d > 0;
    return `<span class="an-dev" title="${up ? "Оценка ИИ выше эталона" : "Оценка ИИ ниже эталона"}">${icon(up ? "arrowUp" : "arrowDown", { size: 13, label: up ? "выше эталона" : "ниже эталона" })}${up ? "+" : "−"}${fmtScore(r.abs_error)}</span>`;
  };
  const mm = (m) => {
    const c = byId[m.criterion_id];
    const code = c && c.code ? c.code : m.criterion_id;
    const title = `${c ? (c.code ? c.code + " " : "") + c.title : m.criterion_id}: эталон ${answerLabel(m.expected)}, ИИ ${answerLabel(m.got)}`;
    return `<span class="an-mm" title="${esc(title)}"><b>${esc(code)}</b><span class="sr-only">эталон</span>${esc(answerLabel(m.expected))}${icon("arrowRight", { size: 12, cls: "an-mm-arrow" })}<span class="sr-only">, ИИ</span>${esc(answerLabel(m.got))}</span>`;
  };
  // Mean absolute error of the total, with the unit agreed to the number as displayed:
  // a fractional value takes «балла» (5,64 балла), a whole one follows the usual plural rule.
  const mae = Number(acc.total_mae);
  const maeShown = Math.round(mae * 100) / 100;
  const maeUnit = Number.isFinite(maeShown) && Number.isInteger(maeShown) ? plural(maeShown, "балл", "балла", "баллов") : "балла";
  return `
    <section class="panel an-panel an-calib" aria-labelledby="an-calib-title">
      ${head("cpu", "Сверка с эталоном", { id: "an-calib-title", tip: "Ответы ИИ против ручной разметки экспертов (data/labels/*.json)" })}
      <div class="an-stats">
        ${stat("Точность критериев", `${fmtScore(acc.criterion_accuracy)}%`, "Доля ответов ИИ, совпавших с эталоном")}
        ${stat("Ошибка итога", `${fmtScore(acc.total_mae)}<span class="an-unit">${maeUnit}</span>`, "Средняя ошибка итога на диалог, из 100")}
        ${stat("Точный итог", `${esc(acc.exact_total)}<span class="an-unit">из ${esc(acc.dialogs)}</span>`, `${exactShare}% диалогов совпали с эталоном`)}
      </div>
      <h4 class="an-sub">По критериям</h4>
      ${hbars(acc.criteria.map((c) => ({ code: c.code || "", title: c.title, value: c.accuracy, hint: `совпало ${c.match} из ${c.n}` })), { suffix: "%", split: acc.criteria.length > 4 })}
      <details class="an-details">
        <summary>${icon("chevronRight", { size: 16, cls: "an-chev" })}Диалоги с расхождениями <span class="an-count">${diffRows.length}</span></summary>
        ${diffRows.length ? `<div class="an-table-wrap">
          <table class="table compact an-table"><thead><tr><th>Диалог</th><th class="num">Эталон</th><th class="num">ИИ</th><th class="num">Ошибка</th><th>Критерии</th></tr></thead>
          <tbody>${diffRows.map((r) => `<tr>
            <td><a class="mono" href="#/c/${encodeURIComponent(r.conversation_id)}">${esc(r.conversation_id)}</a></td>
            <td class="num">${fmtScore(r.expected_total)}</td><td class="num">${fmtScore(r.ai_total)}</td><td class="num">${deviation(r)}</td>
            <td><div class="an-mm-list">${r.mismatches.map(mm).join("")}</div></td></tr>`).join("")}</tbody></table>
        </div>` : `<p class="an-nodata an-pad">Расхождений нет.</p>`}
      </details>
    </section>`;
}

export async function renderAnalytics(view) {
  view.innerHTML = spinner();
  const convs = await api.conversations();
  const datasets = [...new Set(convs.map((c) => c.dataset).filter(Boolean))];
  let ds = "";

  async function paint() {
    view.classList.add("an-busy");
    let st, acc;
    try {
      [st, acc] = await Promise.all([api.stats(ds), api.accuracy(ds)]);
    } finally {
      view.classList.remove("an-busy");
    }
    const grossN = st.gross_errors.length;
    const avgRef = st.count ? st.avg_total : null;
    const lvl = level(st.avg_total);
    // Legend for the reference tick (languages, channels), kept in each panel's header.
    const refKey = isNum(avgRef) ? `<span class="an-legend" title="Отметка на шкале — среднее по набору: ${esc(fmtScore(avgRef))}"><span class="an-ref-key" aria-hidden="true"></span>Среднее</span>` : "";
    view.innerHTML = `
      <section class="page-head an-page-head">
        <div class="an-title"><h1>Аналитика</h1></div>
        <div class="head-actions an-actions">
          <label class="an-ds" for="ds" title="Набор данных">${icon("layers", { size: 16 })}<span class="sr-only">Набор данных</span></label>
          <select class="input input-sm" id="ds">${[["", "Все наборы"], ...datasets.map((d) => [d, d])].map(([v, l]) => `<option value="${esc(v)}" ${v === ds ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
          <a class="btn btn-sm" href="${esc(api.exportUrl("csv", ds))}" title="Скачать оценки в формате CSV">${icon("download", { size: 15 })}<span class="sr-only">Экспорт </span>CSV</a>
          <a class="btn btn-sm" href="${esc(api.exportUrl("json", ds))}" title="Скачать оценки в формате JSON">${icon("download", { size: 15 })}<span class="sr-only">Экспорт </span>JSON</a>
          ${ds ? `<a class="btn btn-sm" href="${esc(api.resultsUrl(ds))}" download="results.json" title="Результаты набора ${esc(ds)} в формате организаторов (JSON 1.0)">${icon("download", { size: 15 })}results.json</a>` : ""}
        </div>
      </section>
      ${!st.count ? `<div class="empty an-empty">${icon("chart", { size: 28 })}<h3>Оценок пока нет</h3><a class="btn btn-sm" href="#/">${icon("inbox", { size: 15 })}Открыть диалоги</a></div>` : `
      <div class="kpis an-kpis">
        ${kpi({ ic: "clipboard", label: "Оценено диалогов", value: esc(st.count) })}
        ${kpi({ ic: "gauge", label: "Средний балл", value: fmtScore(st.avg_total), unit: "из 100", tone: lvl.cls, icTip: lvl.text })}
        ${kpi({ ic: grossN ? "alert" : "shield", label: "Грубые ошибки", value: grossN, tone: grossN ? "bad" : "good",
          title: grossN ? `${share(grossN, st.count)}% от оценённых` : "Не выявлено" })}
        ${kpi({ ic: "scale", label: "Апелляции", value: esc(st.appeals.open), unit: "открыто", title: `Рассмотрено: ${st.appeals.decided}`,
          extra: `<a class="an-kpi-link" href="#/appeals">Перейти${icon("arrowRight", { size: 13 })}</a>` })}
      </div>
      <div class="an-grid an-grid-main">
        <section class="panel an-panel">
          ${head("check", "Выполнение критериев", { tip: `Доля от максимального балла, %. Шкальные — средняя доля от верхней ступени, N/A не учитывается. Значок ⚠ — ниже ${WEAK_BELOW}%.` })}
          ${hbars(st.criteria.filter((c) => c.type !== "flag").map((c) => ({ code: c.code || "", title: c.title, value: c.pass_rate, hint: `применим в ${c.applicable} из ${c.n}, N/A: ${c.na}` })), { suffix: "%", weakBelow: WEAK_BELOW })}
        </section>
        <section class="panel an-panel">
          ${head("chart", "Распределение баллов")}
          ${histogram(st.histogram)}
        </section>
      </div>
      <div class="an-grid an-grid-sub">
        <section class="panel an-panel">
          ${head("globe", "Балл по языкам", { aside: refKey })}
          ${hbars(Object.entries(st.by_language).map(([k, v]) => ({ lead: `<span class="lang">${esc(k)}</span>`, title: LANG_NAME[k] || k, value: v.avg, hint: dialogsWord(v.n) })), { ref: avgRef })}
        </section>
        <section class="panel an-panel">
          ${head("headphones", "Балл по каналам", { aside: refKey })}
          ${hbars(Object.entries(st.by_channel).map(([k, v]) => ({ lead: `<span class="an-ch-ic">${icon(k === "voice call" ? "phone" : "message", { size: 14 })}</span>`, title: k === "voice call" ? "Звонки" : "Чаты", value: v.avg, hint: dialogsWord(v.n) })), { ref: avgRef })}
        </section>
        ${grossN ? `<section class="panel an-panel an-gross-panel">
          ${head("alert", "Грубые ошибки")}
          <ul class="an-gross" role="list">${st.gross_errors.map((id) => `<li><a class="tag tag-bad" href="#/c/${encodeURIComponent(id)}" title="Открыть диалог ${esc(id)}">${icon("alert", { size: 13 })}<span class="mono">${esc(id)}</span>${icon("chevronRight", { size: 13 })}</a></li>`).join("")}</ul>
        </section>` : ""}
      </div>
      `}
      ${acc.dialogs ? calibration(acc) : ""}`;
    $("#ds", view).onchange = (e) => { ds = e.target.value; paint(); };
  }
  await paint();
  return {};
}
