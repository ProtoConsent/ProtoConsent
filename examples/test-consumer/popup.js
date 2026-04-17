// ProtoConsent inter-extension test consumer
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later

const $ = (s) => document.getElementById(s);
const logEl = $("log");

function log(cls, text) {
  const ts = new Date().toLocaleTimeString("en", { hour12: false });
  const line = document.createElement("div");
  line.innerHTML = `<span class="ts">[${ts}]</span> <span class="${cls}">${esc(text)}</span>`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function esc(s) {
  const d = document.createElement("span");
  d.textContent = s;
  return d.innerHTML;
}

function getTargetId() {
  const id = $("targetId").value.trim();
  if (!id) {
    log("err", "ERROR: Paste ProtoConsent extension ID first");
    return null;
  }
  return id;
}

function send(msg) {
  const targetId = getTargetId();
  if (!targetId) return;

  const label = msg.type + (msg.domain ? " (" + msg.domain + ")" : "");
  log("warn", "> " + label);

  chrome.runtime.sendMessage(targetId, msg, (response) => {
    if (chrome.runtime.lastError) {
      log("err", "x " + chrome.runtime.lastError.message);
      return;
    }
    if (!response) {
      log("err", "x No response (silent drop - denylist or flood cooldown?)");
      return;
    }
    if (response.error) {
      log("err", "x " + response.type + ": " + response.error + " - " + response.message);
    } else {
      log("ok", "OK " + JSON.stringify(response, null, 2));
    }
  });
}

// --- Buttons ---

$("btnCaps").addEventListener("click", () => {
  send({ type: "protoconsent:capabilities" });
});

$("btnQuery").addEventListener("click", () => {
  const domain = $("domain").value.trim() || "example.com";
  send({ type: "protoconsent:query", domain });
});

$("btnBadType").addEventListener("click", () => {
  send({ type: "protoconsent:nonexistent" });
});

$("btnBadDomain").addEventListener("click", () => {
  send({ type: "protoconsent:query", domain: "not a domain!!!" });
});

$("btnBurst").addEventListener("click", () => {
  const targetId = getTargetId();
  if (!targetId) return;
  const domain = $("domain").value.trim() || "example.com";
  log("warn", "> Burst: sending 15 queries...");
  for (let i = 0; i < 15; i++) {
    const n = i + 1;
    chrome.runtime.sendMessage(targetId,
      { type: "protoconsent:query", domain },
      (response) => {
        if (chrome.runtime.lastError) {
          log("err", `  #${n} x ${chrome.runtime.lastError.message}`);
          return;
        }
        if (!response) {
          log("err", `  #${n} x No response (silent drop)`);
        } else if (response.error) {
          log("err", `  #${n} x ${response.error}`);
        } else {
          log("ok", `  #${n} OK ${response.profile}`);
        }
      }
    );
  }
});

$("btnClear").addEventListener("click", () => {
  logEl.innerHTML = "";
});

// Persist target ID across popup opens
$("targetId").addEventListener("input", () => {
  chrome.storage.local.set({ _testTargetId: $("targetId").value.trim() });
});
chrome.storage.local.get(["_testTargetId"], (r) => {
  if (r._testTargetId) $("targetId").value = r._testTargetId;
});
