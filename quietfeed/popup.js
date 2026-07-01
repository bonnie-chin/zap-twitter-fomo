const DEFAULTS = {
  enabled: true,
  hideMetrics: true,
  hideIdentity: true,
  hideText: false,
  hideChrome: true,
  layout: "minimal",
};

const TOGGLES = ["enabled", "hideMetrics", "hideIdentity", "hideText", "hideChrome"];

const $ = (id) => document.getElementById(id);

let cfg = { ...DEFAULTS };

function render() {
  TOGGLES.forEach((k) => ($(k).checked = !!cfg[k]));

  $("controls").classList.toggle("disabled", !cfg.enabled);
  $("masterHint").textContent = cfg.enabled ? "All changes active" : "Showing X normally";

  document.querySelectorAll("#layout button").forEach((b) => {
    b.classList.toggle("active", b.dataset.layout === cfg.layout);
  });
}

function save(patch) {
  Object.assign(cfg, patch);
  chrome.storage.sync.set(patch);
  render();
  // Nudge the active tab so the change lands instantly.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "quietfeed:refresh", cfg }, () => void chrome.runtime.lastError);
    }
  });
}

function init() {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    cfg = { ...DEFAULTS, ...stored };
    render();
  });

  TOGGLES.forEach((k) => {
    $(k).addEventListener("change", (e) => save({ [k]: e.target.checked }));
  });

  document.querySelectorAll("#layout button").forEach((b) => {
    b.addEventListener("click", () => save({ layout: b.dataset.layout }));
  });

  $("reset").addEventListener("click", () => save({ ...DEFAULTS }));
}

document.addEventListener("DOMContentLoaded", init);
