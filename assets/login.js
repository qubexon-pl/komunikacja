"use strict";

const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const forgotPasswordForm = document.getElementById("forgotPasswordForm");
const loginTab = document.getElementById("loginTab");
const registerTab = document.getElementById("registerTab");
const message = document.getElementById("formMessage");
const googleButton = document.getElementById("googleButton");
const googleNote = document.getElementById("googleNote");
const emailNote = document.getElementById("emailNote");
const params = new URLSearchParams(location.search);
const returnTo = params.get("returnTo");
const loginViews = [
  googleButton,
  document.querySelector(".divider"),
  document.querySelector(".form-tabs"),
  document.querySelector(".privacy-note"),
];
let emailEnabled = false;
let googleEnabled = false;
let verificationPending = false;
let resetCodeRequested = false;

function safeReturnTo(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

function showMessage(text, kind = "error") {
  message.textContent = text;
  message.className = text ? `form-message ${kind}` : "form-message";
}

function setMode(mode) {
  const isLogin = mode === "login";
  loginForm.hidden = !isLogin;
  registerForm.hidden = isLogin;
  forgotPasswordForm.hidden = true;
  for (const element of loginViews) element.hidden = false;
  googleNote.hidden = googleEnabled;
  emailNote.hidden = emailEnabled;
  loginTab.classList.toggle("active", isLogin);
  registerTab.classList.toggle("active", !isLogin);
  loginTab.setAttribute("aria-selected", String(isLogin));
  registerTab.setAttribute("aria-selected", String(!isLogin));
  document.getElementById("form-title").textContent = isLogin ? "Zaloguj się" : "Utwórz konto";
  showMessage("");
}

function setForgotMode(active) {
  loginForm.hidden = active;
  registerForm.hidden = true;
  forgotPasswordForm.hidden = !active;
  for (const element of loginViews) element.hidden = active;
  googleNote.hidden = active || googleEnabled;
  emailNote.hidden = active || emailEnabled;
  if (active) {
    document.getElementById("form-title").textContent = "Odzyskaj hasło";
    document.getElementById("resetEmail").value = document.getElementById("loginEmail").value;
    showMessage("");
  } else {
    setMode("login");
  }
}

function resetForgotForm() {
  resetCodeRequested = false;
  document.getElementById("passwordResetStep").hidden = true;
  for (const id of ["resetCode", "newPassword"]) {
    const input = document.getElementById(id);
    input.required = false;
    input.value = "";
  }
  document.getElementById("resetSubmitButton").firstChild.textContent = "Wyślij kod ";
}

async function postJson(endpoint, values) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
  const result = await response.json();
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

function registrationValues() {
  return {
    displayName: document.getElementById("registerName").value,
    email: document.getElementById("registerEmail").value,
    password: document.getElementById("registerPassword").value,
  };
}

loginTab.addEventListener("click", () => setMode("login"));
registerTab.addEventListener("click", () => {
  if (!registerTab.disabled) setMode("register");
});

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const submit = loginForm.querySelector('button[type="submit"]');
  withBusyButton(submit, async () => {
    await postJson("/api/auth/login", Object.fromEntries(new FormData(loginForm)));
    location.assign(safeReturnTo(returnTo));
  });
});

registerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (verificationPending) {
    const submit = document.getElementById("registerSubmit");
    withBusyButton(submit, async () => {
      const { email } = registrationValues();
      const { user } = await postJson("/api/auth/verify-email", {
        email,
        code: document.getElementById("verificationCode").value.trim(),
      });
      if (!user) throw new Error("Nie udało się potwierdzić adresu e-mail.");
      location.assign(safeReturnTo(returnTo));
    });
    return;
  }

  const submit = document.getElementById("startRegistrationButton");
  withBusyButton(submit, async () => {
    await postJson("/api/auth/register", registrationValues());
    verificationPending = true;
    document.getElementById("registrationDetails").hidden = true;
    document.getElementById("verificationStep").hidden = false;
    document.getElementById("verificationCode").required = true;
    document.getElementById("verificationCode").focus();
    showMessage("Kod potwierdzający został wysłany na Twój adres e-mail.", "success");
  });
});

document.getElementById("resendVerificationButton").addEventListener("click", (event) => {
  withBusyButton(event.currentTarget, async () => {
    await postJson("/api/auth/register", registrationValues());
    showMessage("Wysłaliśmy nowy kod. Sprawdź pocztę e-mail.", "success");
  });
});

document.getElementById("editRegistrationButton").addEventListener("click", () => {
  verificationPending = false;
  document.getElementById("verificationStep").hidden = true;
  document.getElementById("registrationDetails").hidden = false;
  document.getElementById("verificationCode").required = false;
  document.getElementById("verificationCode").value = "";
  showMessage("");
  document.getElementById("registerEmail").focus();
});

document.getElementById("forgotPasswordButton").addEventListener("click", () => setForgotMode(true));
document.getElementById("backToLoginButton").addEventListener("click", () => {
  resetForgotForm();
  setForgotMode(false);
});

forgotPasswordForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const submit = document.getElementById("resetSubmitButton");
  withBusyButton(submit, async () => {
    const email = document.getElementById("resetEmail").value;
    if (!resetCodeRequested) {
      await postJson("/api/auth/forgot-password", { email });
      resetCodeRequested = true;
      document.getElementById("passwordResetStep").hidden = false;
      document.getElementById("resetCode").required = true;
      document.getElementById("newPassword").required = true;
      submit.firstChild.textContent = "Zmień hasło ";
      document.getElementById("resetCode").focus();
      showMessage("Jeśli konto z hasłem istnieje, kod został wysłany na ten adres.", "success");
      return;
    }

    await postJson("/api/auth/reset-password", {
      email,
      code: document.getElementById("resetCode").value.trim(),
      password: document.getElementById("newPassword").value,
    });
    resetForgotForm();
    setForgotMode(false);
    showMessage("Hasło zostało zmienione. Możesz się teraz zalogować.", "success");
  });
});

googleButton.addEventListener("click", () => {
  if (!googleButton.disabled) location.assign(googleButton.dataset.href);
});

fetch("/api/auth/config")
  .then(async (response) => {
    if (!response.ok) throw new Error("Nie udało się pobrać konfiguracji logowania.");
    const config = await response.json();
    googleEnabled = Boolean(config.googleEnabled);
    googleButton.disabled = !googleEnabled;
    googleNote.hidden = googleEnabled;
    if (googleEnabled) {
      googleButton.dataset.href = `/api/auth/google?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
    }
    emailEnabled = Boolean(config.emailEnabled);
    registerTab.disabled = !emailEnabled;
    document.getElementById("forgotPasswordButton").hidden = !emailEnabled;
    emailNote.hidden = emailEnabled;
  })
  .catch((error) => {
    googleButton.disabled = true;
    googleNote.hidden = false;
    registerTab.disabled = true;
    document.getElementById("forgotPasswordButton").hidden = true;
    emailNote.hidden = false;
    showMessage(error.message);
  });

if (params.get("error") === "google_account_exists") {
  showMessage("To konto już istnieje. Zaloguj się przy użyciu wcześniej wybranej metody.");
} else if (params.get("error") === "google_signin_failed") {
  showMessage("Logowanie przez Google nie powiodło się. Spróbuj ponownie lub użyj adresu e-mail.");
}

fetch("/api/auth/me")
  .then((response) => response.ok ? response.json() : null)
  .then((result) => {
    if (result?.user) location.replace(safeReturnTo(returnTo));
  })
  .catch(() => {});
