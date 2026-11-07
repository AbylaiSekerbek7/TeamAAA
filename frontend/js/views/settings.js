import { api } from "../api.js";
import { $, esc, spinner, toast } from "../ui.js";

export async function renderSettings(view) {
  view.innerHTML = spinner();
  let [s, h] = await Promise.all([api.settings(), api.health()]);

  function paint() {
    const models = h.llm.models || [];
    view.innerHTML = `
      <section class="page-head"><div><h1>Настройки</h1><p class="muted">Модель оценки и источник данных. Изменения применяются к следующим запускам оценки.</p></div></section>
      <div class="grid2">
        <section class="panel">
          <h3>Модель оценки</h3>
          <div class="status-line ${h.llm.ok ? "ok-text" : "bad-text"}">${h.llm.ok ? `✔ Подключено · моделей: ${models.length}` : `✕ Нет подключения: ${esc(h.llm.error || "")}`}</div>
          <label class="field"><span>Провайдер</span>
            <select class="input" id="provider">
              <option value="ollama" ${s.provider === "ollama" ? "selected" : ""}>Локальная модель (Ollama)</option>
              <option value="openai_compat" ${s.provider === "openai_compat" ? "selected" : ""}>OpenAI-совместимый API (LM Studio, vLLM, облако)</option>
            </select></label>
          <div id="ollama-fields" ${s.provider === "ollama" ? "" : "hidden"}>
            <label class="field"><span>Адрес Ollama</span><input class="input" id="ollama_url" value="${esc(s.ollama_url)}"></label>
          </div>
          <div id="oa-fields" ${s.provider === "openai_compat" ? "" : "hidden"}>
            <label class="field"><span>Base URL</span><input class="input" id="base_url" value="${esc(s.base_url)}" placeholder="http://127.0.0.1:1234/v1"></label>
            <label class="field"><span>API key</span><input class="input" id="api_key" value="${esc(s.api_key)}" placeholder="не обязателен для локальных серверов"></label>
          </div>
          <label class="field"><span>Модель</span>
            <input class="input" id="model" value="${esc(s.model)}" list="model-list">
            <datalist id="model-list">${models.map((m) => `<option value="${esc(m)}">`).join("")}</datalist></label>
          <div class="ce-row">
            <label class="field narrow"><span>Temperature</span><input class="input" type="number" step="0.1" min="0" max="2" id="temperature" value="${s.temperature}"></label>
            <label class="field narrow"><span>Голосов (self-consistency)</span><select class="input" id="votes">${[1, 3, 5].map((v) => `<option ${Number(s.votes) === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
            <label class="field narrow"><span>Контекст, токенов</span><input class="input" type="number" step="1024" id="num_ctx" value="${s.num_ctx}"></label>
          </div>
          <label class="toggle"><input type="checkbox" id="think" ${s.think ? "checked" : ""}> Режим рассуждения (thinking) — точнее, но медленнее</label>
          <p class="muted small">При нескольких голосах модель оценивает каждый критерий N раз, ответ выбирается большинством, а доля согласия показывается как уверенность.</p>
        </section>
        <section class="panel">
          <h3>Источник данных</h3>
          <label class="field"><span>URL API организаторов (параметр group_id подставляется автоматически)</span>
            <textarea class="input mono small" rows="5" id="org_api_url">${esc(s.org_api_url)}</textarea></label>
          <h3 class="mt">Стоимость оценки</h3>
          <p class="small">${s.provider === "ollama"
            ? "Модель работает локально на GPU: внешних вызовов и оплаты нет — стоимость одной оценки 0 ₽ (только электроэнергия). Одна оценка = по одному вызову модели на каждый критерий × число голосов."
            : "Платный API: стоимость ≈ (входные токены × цена входа + выходные × цена выхода) по тарифу провайдера. Количество токенов каждой оценки показано в карточке диалога."}</p>
        </section>
      </div>
      <div class="save-bar"><button class="btn btn-primary" id="save">Сохранить настройки</button></div>`;
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
