// Thin REST client. Base URL is configurable for embedding (e.g. Dynamics 365 web resource).
const base = () => (window.CQA_CONFIG && window.CQA_CONFIG.apiBase) || "";

async function request(method, path, body, isForm = false) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(base() + path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.detail) ? (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)) : `Ошибка ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export const api = {
  health: () => request("GET", "/api/health"),
  settings: () => request("GET", "/api/settings"),
  saveSettings: (s) => request("PUT", "/api/settings", s),

  conversations: () => request("GET", "/api/conversations"),
  conversation: (id) => request("GET", `/api/conversations/${encodeURIComponent(id)}`),
  fetchDataset: (groupId) => request("POST", "/api/datasets/fetch", { group_id: groupId }),
  upload: (file, dataset) => {
    const fd = new FormData();
    fd.append("file", file);
    return request("POST", `/api/conversations/upload?dataset=${encodeURIComponent(dataset || "UPLOAD")}`, fd, true);
  },
  audioUrl: (id) => `${base()}/api/audio/${encodeURIComponent(id)}`,
  audioAnalysis: (id) => request("GET", `/api/audio/${encodeURIComponent(id)}/analysis`),
  analyzeAudio: (id) => request("POST", `/api/audio/${encodeURIComponent(id)}/analyze`),

  checklists: () => request("GET", "/api/checklists"),
  activeChecklist: () => request("GET", "/api/checklists/active"),
  checklist: (id) => request("GET", `/api/checklists/${id}`),
  saveChecklist: (data, comment, activate = true, asNew = false) => request("POST", "/api/checklists", { data, comment, activate, as_new: asNew }),
  activateChecklist: (id) => request("POST", `/api/checklists/${id}/activate`),
  deactivateChecklist: (id) => request("POST", `/api/checklists/${id}/deactivate`),
  checklistsByChannel: () => request("GET", "/api/checklists/by-channel"),

  evaluate: (ids, checklistId, extra = {}) => request("POST", "/api/evaluations", { conversation_ids: ids, checklist_id: checklistId, ...extra }),
  evaluation: (id) => request("GET", `/api/evaluations/${id}`),
  jobs: () => request("GET", "/api/jobs"),
  job: (id) => request("GET", `/api/jobs/${id}`),
  cancelJob: (id) => request("POST", `/api/jobs/${id}/cancel`),

  appeals: (status) => request("GET", `/api/appeals${status ? `?status=${status}` : ""}`),
  createAppeal: (payload) => request("POST", "/api/appeals", payload),
  decideAppeal: (id, payload) => request("POST", `/api/appeals/${id}/decision`, payload),

  stats: (dataset) => request("GET", `/api/stats${dataset ? `?dataset=${encodeURIComponent(dataset)}` : ""}`),
  accuracy: (dataset) => request("GET", `/api/accuracy${dataset ? `?dataset=${encodeURIComponent(dataset)}` : ""}`),
  resultsUrl: (dataset) => `${base()}/api/results.json?dataset=${encodeURIComponent(dataset)}`,
  exportUrl: (fmt, dataset) =>`${base()}/api/export.${fmt}${dataset ? `?dataset=${encodeURIComponent(dataset)}` : ""}`,
};
