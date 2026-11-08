import { api } from "../api.js";
import { icon } from "../icons.js";
import { $, esc, spinner, toast } from "../ui.js";

const PROVIDER_LABEL = { ollama: "Ollama (локально)", openai_compat: "OpenAI-совместимый API" };
const WHISPER_LABEL = { tiny: "tiny (быстрая)", base: "base", small: "small (баланс)", medium: "medium (точная)" };
const DEVICE_LABEL = { cpu: "CPU", cuda: "GPU (CUDA)" };

// Optional hint: a small info icon with a native tooltip and an accessible name.
const tip = (text) => `<span class="st-tip" role="img" title="${esc(text)}" aria-label="${esc(text)}">${icon("info", { size: 14 })}</span>`;

// Section header: icon tile, short title (+ hint) and an optional status tag / switch on the right.
function secHead(id, ic, title, aside = "", hint = "") {
  return `<header class="st-sec-head">
    <span class="st-sec-ic">${icon(ic, { size: 18 })}</span>
    <div class="st-sec-title"><h2 id="${id}">${esc(title)}</h2>${hint ? tip(hint) : ""}</div>
    ${aside ? `<div class="st-sec-aside">${aside}</div>` : ""}
  </header>`;
}

export async function renderSettings(view) {
  view.innerHTML = spinner();
  let [s, h] = await Promise.all([api.settings(), api.health()]);

  function paint() {
    const models = h.llm.models || [];
    const local = s.provider === "ollama";
    const votes = Number(s.votes) || 1;
    const audioOn = s.audio_analysis !== false;
    const sourceSet = !!s.org_api_url;
    const modelFound = h.llm.ok && h.model_available !== false;

    // Connection state: ok / connected but the selected model is missing / no connection.
    // The header tag always shows it; the banner appears only when something needs attention.
    const conn = !h.llm.ok
      ? { cls: "bad", ic: "xCircle", tag: "Нет подключения", text: "Сервер не отвечает — проверьте адрес", detail: h.llm.error || "" }
      : !modelFound
        ? { cls: "warn", ic: "alert", tag: "Модель не найдена", text: `«${s.model}» нет на сервере — выберите доступную` }
        : { cls: "ok", ic: "check", tag: "Подключено" };
    const connTag = `<span class="tag tag-${conn.cls}">${icon(conn.ic, { size: 12 })}${conn.tag}</span>`;
    const sourceTag = sourceSet
      ? `<span class="tag tag-ok">${icon("check", { size: 12 })}Настроен</span>`
      : `<span class="tag tag-warn">${icon("alert", { size: 12 })}Не задан</span>`;
    const facts = local
      ? [["Внешние вызовы", "Нет"], ["Вызовов на оценку", `Критерии × ${esc(votes)}`], ["Данные", "На своём сервере"]]
      : [["Расчёт", "Токены × тариф"], ["Вызовов на оценку", `Критерии × ${esc(votes)}`], ["Расход токенов", "В карточке диалога"]];

    view.innerHTML = `
      <div class="st-page">
      <section class="page-head"><h1>Настройки</h1></section>

      <div class="st-grid">
        <section class="panel st-sec" aria-labelledby="st-h-model">
          ${secHead("st-h-model", "cpu", "Модель оценки", connTag)}
          <div class="st-sec-body">
            ${conn.cls !== "ok" ? `<div class="st-status st-status-${conn.cls}" role="status">
              ${icon(conn.ic, { size: 16 })}
              <div><b>${esc(conn.text)}</b>
                ${conn.detail ? `<details class="st-tech"><summary>Подробнее</summary><code class="mono">${esc(conn.detail)}</code></details>` : ""}
              </div>
            </div>` : ""}

            <label class="field"><span>Провайдер</span>
              <select class="input" id="provider">${Object.entries(PROVIDER_LABEL).map(([v, l]) => `<option value="${v}" ${s.provider === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>

            <div id="ollama-fields" ${s.provider === "ollama" ? "" : "hidden"}>
              <label class="field"><span>Адрес Ollama</span><input class="input mono" id="ollama_url" value="${esc(s.ollama_url)}" spellcheck="false" autocomplete="off"></label>
            </div>
            <div id="oa-fields" ${s.provider === "openai_compat" ? "" : "hidden"}>
              <div class="st-cols st-cols-2">
                <label class="field"><span>Base URL</span><input class="input mono" id="base_url" value="${esc(s.base_url)}" placeholder="http://127.0.0.1:1234/v1" spellcheck="false" autocomplete="off"></label>
                <label class="field"><span>API-ключ</span><input class="input mono" id="api_key" value="${esc(s.api_key)}" placeholder="необязательно" spellcheck="false" autocomplete="off"></label>
              </div>
            </div>

            <label class="field st-field-model"><span>Модель</span>
              <input class="input mono" id="model" value="${esc(s.model)}" list="model-list" spellcheck="false" autocomplete="off">
              <datalist id="model-list">${models.map((m) => `<option value="${esc(m)}">`).join("")}</datalist></label>
            ${models.length ? `<div class="st-models" role="group" title="Доступно на сервере" aria-label="Модели, доступные на сервере">
              ${models.map((m) => `<span class="st-model ${m === s.model ? "is-active" : ""}">${m === s.model ? icon("check", { size: 12 }) : ""}${esc(m)}</span>`).join("")}
            </div>` : ""}

            <div class="st-cols st-cols-3 st-params">
              <label class="field"><span>Температура${tip("0 — стабильный результат")}</span>
                <input class="input" type="number" step="0.1" min="0" max="2" id="temperature" value="${esc(s.temperature)}"></label>
              <label class="field"><span>Голосов на критерий${tip("Критерий оценивается N раз: итог по большинству, уверенность — доля согласия. Время × N.")}</span>
                <select class="input" id="votes">${[1, 3, 5].map((v) => `<option ${Number(s.votes) === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
              <label class="field"><span>Контекст, токенов</span>
                <input class="input" type="number" step="1024" id="num_ctx" value="${esc(s.num_ctx)}"></label>
            </div>

            <label class="st-switch" for="think">
              <span class="st-switch-text"><b>Режим рассуждения${tip("Точнее, но медленнее")}</b></span>
              <input type="checkbox" role="switch" id="think" ${s.think ? "checked" : ""}>
            </label>
          </div>
        </section>

        <div class="st-col">
          <section class="panel st-sec st-audio" aria-labelledby="st-h-audio">
            ${secHead("st-h-audio", "waveform", "Анализ аудиозаписей",
              `<label class="st-switch st-switch-bare" for="audio_analysis" title="Выключено — оценка только по транскрипту">
                <input type="checkbox" role="switch" id="audio_analysis" aria-labelledby="st-h-audio" ${audioOn ? "checked" : ""}>
              </label>`)}
            <div class="st-sec-body">
              <div class="st-cols st-cols-2">
                <label class="field"><span>Модель Whisper</span>
                  <select class="input" id="whisper_model">${["tiny", "base", "small", "medium"].map((m) => `<option value="${m}" ${s.whisper_model === m ? "selected" : ""}>${WHISPER_LABEL[m]}</option>`).join("")}</select></label>
                <label class="field"><span>Устройство</span>
                  <select class="input" id="whisper_device">${Object.entries(DEVICE_LABEL).map(([v, l]) => `<option value="${v}" ${s.whisper_device === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
              </div>
            </div>
          </section>

          <section class="panel st-sec" aria-labelledby="st-h-source">
            ${secHead("st-h-source", "cloud", "Источник данных", sourceTag,
              "Адрес содержит ключ доступа (sig) — храните конфиденциально. group_id подставляется автоматически.")}
            <div class="st-sec-body">
              <textarea class="input mono st-url" rows="6" id="org_api_url" aria-label="URL API организаторов" spellcheck="false" autocomplete="off" placeholder="https://…/invoke?api-version=1&amp;…&amp;sig=…">${esc(s.org_api_url)}</textarea>
            </div>
          </section>
        </div>
      </div>

      <section class="panel st-cost" aria-labelledby="st-h-cost">
        <div class="st-cost-title"><span class="st-sec-ic">${icon("gauge", { size: 18 })}</span><h2 id="st-h-cost">Стоимость</h2></div>
        <div class="st-cost-main"${local ? ' title="Только электроэнергия"' : ""}>
          <span class="st-cost-value">${local ? "Бесплатно" : "По тарифу"}</span>
        </div>
        <dl class="st-facts">${facts.map(([t, d]) => `<div><dt>${t}</dt><dd>${d}</dd></div>`).join("")}</dl>
      </section>

      <div class="save-bar st-savebar">
        <button class="btn btn-primary" id="save" title="Применится при следующем запуске оценки">${icon("check", { size: 16 })}Сохранить</button>
      </div>
      </div>`;
    $("#provider", view).onchange = (e) => {
      $("#ollama-fields", view).hidden = e.target.value !== "ollama";
      $("#oa-fields", view).hidden = e.target.value !== "openai_compat";
    };
    $("#save", view).onclick = async () => {
      const v = (id) => $(`#${id}`, view)?.value;
      try {
        s = await api.saveSettings({
          provider: v("provider"), ollama_url: v("ollama_url"), base_url: v("base_url"), api_key: v("api_key"),
          model: v("model"), temperature: v("temperature"), votes: v("votes"), num_ctx: v("num_ctx"),
          think: $("#think", view).checked, org_api_url: v("org_api_url"),
          audio_analysis: $("#audio_analysis", view).checked, whisper_model: v("whisper_model"), whisper_device: v("whisper_device"),
        });
        h = await api.health();
        toast("Настройки сохранены", "ok");
        paint();
      } catch (e) { toast(e.message, "bad"); }
    };
  }
  paint();
  return {};
}
