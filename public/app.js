(function () {
  "use strict";
  const form = document.getElementById("login-form");
  const idInput = document.getElementById("erp-id");
  const dobInput = document.getElementById("date-of-birth");
  const status = document.getElementById("login-status");
  const button = document.getElementById("login-button");
  const notice = document.getElementById("eligibility-notice");

  document.getElementById("close-notice").addEventListener("click", () => {
    notice.hidden = true;
    idInput.focus({ preventScroll: true });
  });
  document.getElementById("focus-login").addEventListener("click", () => {
    idInput.focus({ preventScroll: true });
    document.getElementById("candidate-login").scrollIntoView({ block: "start", behavior: scrollBehavior() });
  });

  function fieldError(input, errorId, message) {
    const error = document.getElementById(errorId);
    error.textContent = message;
    error.hidden = !message;
    input.setAttribute("aria-invalid", message ? "true" : "false");
  }
  function showStatus(message) { status.textContent = message; status.hidden = !message; }
  function scrollBehavior() { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"; }
  function syncDateAppearance() { dobInput.setAttribute("data-has-value", String(Boolean(dobInput.value))); }
  syncDateAppearance();
  dobInput.addEventListener("input", syncDateAppearance);
  dobInput.addEventListener("change", syncDateAppearance);
  idInput.addEventListener("blur", () => { idInput.value = EPRSValidation.normalizeId(idInput.value); });
  for (const [input, errorId] of [[idInput, "erp-error"], [dobInput, "dob-error"]]) {
    input.addEventListener("input", () => { fieldError(input, errorId, ""); showStatus(""); });
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (button.disabled) return;
    showStatus("");
    const value = EPRSValidation.validate(idInput.value, dobInput.value);
    idInput.value = value.erpId;
    fieldError(idInput, "erp-error", value.idError);
    fieldError(dobInput, "dob-error", value.dobError);
    if (value.idError || value.dobError) { (value.idError ? idInput : dobInput).focus(); return; }
    notice.hidden = false;
    notice.scrollIntoView({ block: "start", behavior: scrollBehavior() });
    button.disabled = true;
    form.setAttribute("aria-busy", "true");
    form.setAttribute("data-log-status", "sending");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const base = (window.RMO_CONFIG?.loggingApiBaseUrl || "").replace(/\/$/, "");
      const response = await fetch(base + "/api/log-attempt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollmentNumber: value.erpId }),
        credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.saved !== true) throw new Error("The login record could not be saved. Please try again.");
      form.setAttribute("data-log-status", "saved");
    } catch {
      form.setAttribute("data-log-status", "failed");
      showStatus("The login record could not be saved. Please try again.");
    } finally {
      clearTimeout(timer);
      button.disabled = false;
      form.removeAttribute("aria-busy");
    }
  });
})();
