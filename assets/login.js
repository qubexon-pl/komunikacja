"use strict";

// Sign-in the Podavo family way (one account for every Podavo app): a 6-digit code sent by e-mail is the main way in
// and makes the account on first use; a password is optional (set later in the account menu); Google.
const codeForm = document.getElementById("codeForm");
const passwordForm = document.getElementById("passwordForm");
const codeTab = document.getElementById("codeTab");
const passwordTab = document.getElementById("passwordTab");
const message = document.getElementById("formMessage");
const googleButton = document.getElementById("googleButton");
const googleNote = document.getElementById("googleNote");
const emailNote = document.getElementById("emailNote");
const params = new URLSearchParams(location.search);
const returnTo = params.get("returnTo");
let codeEmail = "";
let resendTimer = null;

// In the Android/iOS app the pages are local files and Google sign-in is native (assets/app.native.js).
const nativeApp = Boolean(window.ONWARD && window.ONWARD.native);
// A new sign-in starts a new activity period. Without this, the time of the last activity from an earlier session
// (more than an hour ago) makes the app sign the user out again right after they sign in (assets/app.js, IDLE).
try { localStorage.removeItem("podavo-voyage-last-activity"); } catch {}

function afterSignIn() {
  location.assign(nativeApp ? window.ONWARD.homeUrl() : safeReturnTo(returnTo));
}

function safeReturnTo(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

function showMessage(text, kind = "error") {
  message.textContent = text;
  message.className = text ? `form-message ${kind}` : "form-message";
}

function setMode(mode) {
  const code = mode === "code";
  codeForm.hidden = !code;
  passwordForm.hidden = code;
  codeTab.classList.toggle("active", code);
  passwordTab.classList.toggle("active", !code);
  codeTab.setAttribute("aria-selected", String(code));
  passwordTab.setAttribute("aria-selected", String(!code));
  showMessage("");
  const email = (code ? document.getElementById("loginEmail") : document.getElementById("codeEmail")).value;
  const target = code ? document.getElementById("codeEmail") : document.getElementById("loginEmail");
  if (email && !target.value) target.value = email;
}

function showCodeStep(active) {
  document.getElementById("codeEmailStep").hidden = active;
  document.getElementById("codeStep").hidden = !active;
  document.getElementById("codeEmail").required = !active;
  document.getElementById("loginCode").required = active;
  if (active) {
    document.getElementById("codeSentTo").textContent = `Wysłaliśmy 6-cyfrowy kod na ${codeEmail}. Kod jest ważny 10 minut.`;
    document.getElementById("loginCode").value = "";
    document.getElementById("loginCode").focus();
  }
}

function waitBeforeResend(seconds) {
  const button = document.getElementById("resendCodeButton");
  clearInterval(resendTimer);
  let left = Math.max(0, Math.round(seconds || 0));
  const tick = () => {
    button.disabled = left > 0;
    button.textContent = left > 0 ? `Wyślij nowy kod (${left} s)` : "Wyślij nowy kod";
    if (left-- <= 0) clearInterval(resendTimer);
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

async function postJson(endpoint, values) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Nie udało się wykonać tej operacji.");
  return result;
}

async function withBusyButton(button, action) {
  showMessage("");
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    showMessage(error.message || "Wystąpił błąd połączenia. Spróbuj ponownie.");
  } finally {
    button.disabled = false;
  }
}

async function sendCode(button) {
  const sent = await postJson("/api/auth/code", { email: codeEmail });
  showCodeStep(true);
  waitBeforeResend(sent.resendIn);
  // Development only (AUTH_EMAIL_CONSOLE): the server also returns the code, so it can be tried without e-mail.
  if (sent.devCode) document.getElementById("loginCode").value = sent.devCode;
  showMessage(sent.devCode ? `Tryb deweloperski: kod ${sent.devCode} wpisano za Ciebie.` : "Kod jest w drodze — sprawdź pocztę (także folder spam).", "success");
  return button;
}

codeTab.addEventListener("click", () => setMode("code"));
passwordTab.addEventListener("click", () => setMode("password"));

codeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!document.getElementById("codeStep").hidden) {
    const submit = document.getElementById("verifyCodeButton");
    withBusyButton(submit, async () => {
      const { user } = await postJson("/api/auth/verify", { email: codeEmail, code: document.getElementById("loginCode").value.trim() });
      if (!user) throw new Error("Nie udało się zalogować.");
      afterSignIn();
    });
    return;
  }
  const submit = document.getElementById("sendCodeButton");
  withBusyButton(submit, async () => {
    codeEmail = document.getElementById("codeEmail").value.trim().toLowerCase();
    await sendCode(submit);
  });
});

document.getElementById("resendCodeButton").addEventListener("click", (event) => {
  const button = event.currentTarget;
  withBusyButton(button, () => sendCode(button)).finally(() => waitBeforeResend(60));
});
document.getElementById("changeEmailButton").addEventListener("click", () => {
  clearInterval(resendTimer);
  showCodeStep(false);
  showMessage("");
  document.getElementById("codeEmail").focus();
});

passwordForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const submit = passwordForm.querySelector('button[type="submit"]');
  withBusyButton(submit, async () => {
    await postJson("/api/auth/login", Object.fromEntries(new FormData(passwordForm)));
    afterSignIn();
  });
});

googleButton.addEventListener("click", () => {
  if (googleButton.disabled) return;
  if (!nativeApp) {
    location.assign(googleButton.dataset.href);
    return;
  }
  withBusyButton(googleButton, async () => {
    await window.ONWARD.googleSignIn();
    afterSignIn();
  });
});

fetch("/api/auth/config")
  .then(async (response) => {
    if (!response.ok) throw new Error("Nie udało się pobrać konfiguracji logowania.");
    const config = await response.json();
    const googleEnabled = Boolean(nativeApp ? config.googleNativeEnabled : config.googleEnabled);
    googleButton.disabled = !googleEnabled;
    googleNote.hidden = googleEnabled;
    if (googleEnabled) googleButton.dataset.href = `/api/auth/google?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
    emailNote.hidden = Boolean(config.emailEnabled);
  })
  .catch((error) => {
    googleButton.disabled = true;
    googleNote.hidden = false;
    showMessage(error.message);
  });

if (params.get("error") === "google_signin_failed") {
  showMessage("Logowanie przez Google nie powiodło się. Spróbuj ponownie albo zaloguj się kodem z e-maila.");
} else if (params.get("powod") === "bezczynnosc") {
  showMessage("Wylogowaliśmy Cię po godzinie bez aktywności. Zaloguj się ponownie.", "success");
}

fetch("/api/auth/me")
  .then((response) => (response.ok ? response.json() : null))
  .then((result) => {
    if (result?.user) location.replace(nativeApp ? window.ONWARD.homeUrl() : safeReturnTo(returnTo));
  })
  .catch(() => {});
