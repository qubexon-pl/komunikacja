"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const sql = require("mssql");
const { AuthError, SESSION_TTL_SECONDS, createAccounts, mdmConfig } = require("./accounts");

const scrypt = promisify(crypto.scrypt);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function normalizeEmail(value) {
  if (typeof value !== "string") throw new AuthError("Podaj prawidłowy adres e-mail.", 400);
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) throw new AuthError("Podaj prawidłowy adres e-mail.", 400);
  return email;
}

function safeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    return "/";
  }
  try {
    const url = new URL(value, "https://local.invalid");
    return url.origin === "https://local.invalid" ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new AuthError("Hasło musi mieć od 12 do 256 znaków.", 400);
  }
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

async function verifyPassword(password, encodedHash) {
  if (typeof password !== "string" || typeof encodedHash !== "string") return false;
  const parts = encodedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nText, rText, pText, saltText, keyText] = parts;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(keyText, "base64url");
  if (n !== SCRYPT_OPTIONS.N || r !== SCRYPT_OPTIONS.r || p !== SCRYPT_OPTIONS.p || salt.length !== 16 || expected.length !== 64) return false;
  const actual = await scrypt(password, salt, expected.length, SCRYPT_OPTIONS);
  return crypto.timingSafeEqual(actual, expected);
}

function isConsoleEmailEnabled(env = process.env) {
  return env.AUTH_EMAIL_CONSOLE === "true" && env.NODE_ENV !== "production";
}

function isSmtpConfigured(env = process.env) {
  return Boolean(env.SMTP_HOST?.trim() && env.SMTP_USER?.trim() && env.SMTP_PASS?.trim() && env.SMTP_FROM?.trim());
}

function isEmailConfigured(env = process.env) {
  return Boolean(
    (isConsoleEmailEnabled(env) || isSmtpConfigured(env) || (env.SENDGRID_API_KEY?.trim() && env.SENDGRID_FROM_EMAIL?.trim()))
    && env.AUTH_CODE_PEPPER?.length >= 32,
  );
}

async function sendSmtpEmail(env, { to, subject, text }) {
  const nodemailer = require("nodemailer");
  const port = Number(env.SMTP_PORT?.trim() || 465);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST.trim(),
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER.trim(), pass: env.SMTP_PASS.trim() },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  await transport.sendMail({ from: env.SMTP_FROM.trim(), to, subject, text });
}

// Sign-in is the Podavo family's shared account (src/accounts.js, database podavo-mdm). This service adds what is
// podavo.voyage's own: e-mail delivery, the user's favourites and preferences, and deleting the Voyage data.
function createAuthService(pool, {
  adminEmails = process.env.ADMIN_EMAILS || "",
  sendEmail: sendEmailOverride,
  emailConfig = process.env,
  mdm = null,
  accounts: accountsOverride = null,
} = {}) {
  async function sendSendGridEmail({ to, subject, text }) {
    if (!isEmailConfigured(emailConfig)) throw new AuthError("Usługa e-mail nie jest skonfigurowana.", 503);
    const sendgrid = require("@sendgrid/mail");
    sendgrid.setApiKey(emailConfig.SENDGRID_API_KEY.trim());
    const [response] = await sendgrid.send({ to, from: emailConfig.SENDGRID_FROM_EMAIL.trim(), subject, text });
    if (!response || !Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`SendGrid returned status ${response?.statusCode ?? "unknown"}.`);
    }
  }
  async function logEmailToConsole({ to, subject, text }) {
    console.log(`[AUTH_EMAIL_CONSOLE] To: ${to}\nSubject: ${subject}\n${text}`);
  }
  function defaultDelivery() {
    if (isConsoleEmailEnabled(emailConfig)) return logEmailToConsole;
    if (isSmtpConfigured(emailConfig)) return (message) => sendSmtpEmail(emailConfig, message);
    return sendSendGridEmail;
  }
  const deliverEmail = sendEmailOverride || defaultDelivery();
  async function deliver(message) {
    if (!sendEmailOverride && !isEmailConfigured(emailConfig)) throw new AuthError("Usługa e-mail nie jest skonfigurowana.", 503);
    await deliverEmail(message);
  }
  // Any other message to a user, such as a price alert.
  const sendNotice = (message) => deliver(message);

  // The shared accounts database is opened on first use, so the app starts (and its tests run) without it.
  let mdmPool = null;
  const mdmConnection = () => (mdmPool ||= (mdm ? Promise.resolve(mdm) : new sql.ConnectionPool(mdmConfig()).connect()).catch((error) => { mdmPool = null; throw error; }));
  const audiences = [process.env.GOOGLE_CLIENT_ID, ...String(process.env.GOOGLE_NATIVE_CLIENT_IDS || "").split(",")].map((v) => String(v || "").trim()).filter(Boolean);
  const accounts = accountsOverride || createAccounts({ mdm: mdmConnection, local: pool, deliver, adminEmails,
    devCodes: isConsoleEmailEnabled(emailConfig), googleAudiences: audiences });

  async function getFavorites(userId) {
    const result = await pool.request().input("userId", sql.UniqueIdentifier, userId)
      .query("SELECT favorites FROM dbo.UserFavorites WHERE user_id = @userId;");
    return result.recordset[0] ? JSON.parse(result.recordset[0].favorites) : [];
  }
  async function getPreferences(userId) {
    const result = await pool.request().input("userId", sql.UniqueIdentifier, userId)
      .query("SELECT preferences FROM dbo.UserPreference WHERE user_id = @userId;");
    return result.recordset[0] ? JSON.parse(result.recordset[0].preferences) : {};
  }
  async function savePreferences(userId, preferences) {
    await pool.request()
      .input("userId", sql.UniqueIdentifier, userId)
      .input("preferences", sql.NVarChar(sql.MAX), JSON.stringify(preferences))
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        UPDATE dbo.UserPreference WITH (UPDLOCK, SERIALIZABLE) SET preferences = @preferences, updated_at = SYSUTCDATETIME() WHERE user_id = @userId;
        IF @@ROWCOUNT = 0
          INSERT INTO dbo.UserPreference (user_id, preferences) VALUES (@userId, @preferences);
        COMMIT TRANSACTION;
      `);
  }
  async function saveFavorites(userId, favorites) {
    await pool.request()
      .input("userId", sql.UniqueIdentifier, userId)
      .input("favorites", sql.NVarChar(sql.MAX), JSON.stringify(favorites))
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        -- Two saves at once must not both try to insert the first row.
        UPDATE dbo.UserFavorites WITH (UPDLOCK, SERIALIZABLE) SET favorites = @favorites, updated_at = SYSUTCDATETIME() WHERE user_id = @userId;
        IF @@ROWCOUNT = 0
          INSERT INTO dbo.UserFavorites (user_id, favorites) VALUES (@userId, @favorites);
        COMMIT TRANSACTION;
      `);
  }

  // Voyage's own data of a person who leaves the app (the shared account is handled in accounts.js).
  async function deleteLocal(userId) {
    await pool.request().input("userId", sql.UniqueIdentifier, userId).query(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      DELETE FROM dbo.UserFavorites WHERE user_id = @userId;
      DELETE FROM dbo.UserPreference WHERE user_id = @userId;
      IF OBJECT_ID(N'dbo.EmailChallenge', N'U') IS NOT NULL DELETE FROM dbo.EmailChallenge WHERE user_id = @userId;
      IF OBJECT_ID(N'dbo.AuthSession', N'U') IS NOT NULL DELETE FROM dbo.AuthSession WHERE user_id = @userId;
      IF OBJECT_ID(N'dbo.ExternalIdentity', N'U') IS NOT NULL DELETE FROM dbo.ExternalIdentity WHERE user_id = @userId;
      IF OBJECT_ID(N'dbo.LocalCredential', N'U') IS NOT NULL DELETE FROM dbo.LocalCredential WHERE user_id = @userId;
      DELETE FROM dbo.AppUser WHERE user_id = @userId;
      COMMIT TRANSACTION;
    `);
  }

  return {
    sendNotice,
    getFavorites, saveFavorites, getPreferences, savePreferences,
    resolveSession: accounts.resolveSession,
    revokeSession: accounts.revokeSession,
    startEmailLogin: accounts.startEmailLogin,
    verifyEmailLogin: accounts.verifyEmailLogin,
    loginWithPassword: accounts.loginWithPassword,
    passwordStatus: accounts.passwordStatus,
    setPassword: accounts.setPassword,
    removePassword: accounts.removePassword,
    saveOAuthState: accounts.saveOAuthState,
    consumeOAuthState: accounts.consumeOAuthState,
    signInWithGoogle: accounts.signInWithGoogle,
    signInWithGoogleToken: accounts.signInWithGoogleToken,
    startAccountDeletion: (user) => accounts.startAccountDeletion(user),
    confirmAccountDeletion: (user, code) => accounts.confirmAccountDeletion(user, code, deleteLocal),
  };
}

module.exports = {
  AuthError,
  SESSION_TTL_SECONDS,
  createAuthService,
  hashPassword,
  isEmailConfigured,
  normalizeEmail,
  safeReturnTo,
  sendSmtpEmail,
  verifyPassword,
};
