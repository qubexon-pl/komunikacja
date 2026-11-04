"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const sql = require("mssql");

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const EMAIL_CODE_TTL_SECONDS = 10 * 60;
const EMAIL_CODE_RESEND_SECONDS = 60;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

class AuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "AuthError";
    this.statusCode = statusCode;
  }
}

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

const DUMMY_HASH = "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function toUser(row) {
  return {
    id: row.user_id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: Boolean(row.is_admin),
  };
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

function codeHash(purpose, email, code, pepper) {
  return crypto.createHmac("sha256", pepper).update(`${purpose}:${email}:${code}`).digest("hex");
}

function createAuthService(pool, {
  adminEmails = process.env.ADMIN_EMAILS || "",
  sendEmail: sendEmailOverride,
  emailConfig = process.env,
} = {}) {
  const admins = new Set(adminEmails.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));

  async function sendSendGridEmail({ to, subject, text }) {
    if (!isEmailConfigured(emailConfig)) {
      throw new AuthError("Usługa e-mail nie jest skonfigurowana.", 503);
    }
    const sendgrid = require("@sendgrid/mail");
    sendgrid.setApiKey(emailConfig.SENDGRID_API_KEY.trim());
    const [response] = await sendgrid.send({
      to,
      from: emailConfig.SENDGRID_FROM_EMAIL.trim(),
      subject,
      text,
    });
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

  function requireEmailConfiguration() {
    if (!isEmailConfigured(emailConfig)) {
      throw new AuthError("Usługa e-mail nie jest skonfigurowana.", 503);
    }
  }

  async function sendChallengeEmail(purpose, email, code) {
    const subjects = {
      verify_email: "Potwierdź adres e-mail — Rzeszów Live",
      password_reset: "Kod resetowania hasła — Rzeszów Live",
      delete_account: "Kod usunięcia konta — Rzeszów Live",
    };
    const explanations = {
      verify_email: "Użyj tego kodu, aby potwierdzić adres e-mail i utworzyć konto.",
      password_reset: "Użyj tego kodu, aby zmienić hasło do konta.",
      delete_account: "Użyj tego kodu, aby potwierdzić usunięcie konta.",
    };
    await deliverEmail({
      to: email,
      subject: subjects[purpose],
      text: `${explanations[purpose]}\n\nKod: ${code}\nKod wygaśnie za 10 minut. Jeśli nie prosiłeś(-aś) o tę wiadomość, zignoruj ją.`,
    });
  }

  async function issueEmailChallenge({ purpose, email, userId = null, displayName, passwordHash }) {
    requireEmailConfiguration();
    const tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    let challengeId;
    let code;
    try {
      await tx.request().query("DELETE FROM dbo.EmailChallenge WHERE expires_at < SYSUTCDATETIME();");
      const existing = await tx.request()
        .input("email", sql.NVarChar(320), email)
        .input("purpose", sql.VarChar(20), purpose)
        .input("userId", sql.UniqueIdentifier, userId)
        .query(`
          SELECT TOP (1) last_sent_at
          FROM dbo.EmailChallenge WITH (UPDLOCK, HOLDLOCK)
          WHERE purpose = @purpose AND (
            (user_id IS NULL AND email = @email)
            OR (user_id = @userId AND @userId IS NOT NULL)
          );
        `);
      const lastSentAt = existing.recordset[0]?.last_sent_at;
      if (lastSentAt && Date.now() - new Date(lastSentAt).getTime() < EMAIL_CODE_RESEND_SECONDS * 1000) {
        throw new AuthError("Kod został wysłany przed chwilą. Sprawdź pocztę lub poczekaj minutę, zanim poprosisz o kolejny.", 429);
      }

      challengeId = crypto.randomUUID();
      code = String(crypto.randomInt(100000, 1000000));
      const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_SECONDS * 1000);
      const deleteCondition = userId
        ? "user_id = @userId AND purpose = @purpose"
        : "email = @email AND purpose = @purpose";
      await tx.request()
        .input("challengeId", sql.UniqueIdentifier, challengeId)
        .input("email", sql.NVarChar(320), userId ? null : email)
        .input("purpose", sql.VarChar(20), purpose)
        .input("userId", sql.UniqueIdentifier, userId)
        .input("codeHash", sql.Char(64), codeHash(purpose, email, code, emailConfig.AUTH_CODE_PEPPER))
        .input("expiresAt", sql.DateTime2, expiresAt)
        .query(`
          DELETE FROM dbo.EmailChallenge WHERE ${deleteCondition};
          INSERT INTO dbo.EmailChallenge (challenge_id, email, purpose, user_id, code_hash, expires_at)
          VALUES (@challengeId, @email, @purpose, @userId, @codeHash, @expiresAt);
        `);
      if (purpose === "verify_email") {
        await tx.request()
          .input("challengeId", sql.UniqueIdentifier, challengeId)
          .input("displayName", sql.NVarChar(100), displayName)
          .input("passwordHash", sql.NVarChar(300), passwordHash)
          .query(`
            INSERT INTO dbo.PendingRegistration (challenge_id, display_name, password_hash)
            VALUES (@challengeId, @displayName, @passwordHash);
          `);
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }

    try {
      await sendChallengeEmail(purpose, email, code);
    } catch (error) {
      await pool.request()
        .input("challengeId", sql.UniqueIdentifier, challengeId)
        .query("DELETE FROM dbo.EmailChallenge WHERE challenge_id = @challengeId;");
      if (error instanceof AuthError) throw error;
      console.error("Email challenge delivery failed:", error.message);
      throw new AuthError("Nie udało się wysłać wiadomości. Spróbuj ponownie później.", 503);
    }
  }

  async function getChallengeForUpdate(tx, email, purpose) {
    const result = await tx.request()
      .input("email", sql.NVarChar(320), email)
      .input("purpose", sql.VarChar(20), purpose)
      .query(`
        SELECT c.challenge_id, c.user_id, c.code_hash, c.attempts, c.expires_at
        FROM dbo.EmailChallenge c WITH (UPDLOCK, HOLDLOCK)
        LEFT JOIN dbo.AppUser u ON u.user_id = c.user_id
        WHERE c.purpose = @purpose AND COALESCE(c.email, u.email) = @email;
      `);
    return result.recordset[0] || null;
  }

  async function checkChallenge(tx, challenge, email, purpose, code) {
    if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now()) {
      return new AuthError("Kod jest nieprawidłowy lub wygasł. Poproś o nowy.", 400);
    }
    if (challenge.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      await tx.request()
        .input("challengeId", sql.UniqueIdentifier, challenge.challenge_id)
        .query("DELETE FROM dbo.EmailChallenge WHERE challenge_id = @challengeId;");
      return new AuthError("Zbyt wiele błędnych prób. Poproś o nowy kod.", 429);
    }
    const suppliedHash = typeof code === "string" && /^\d{6}$/.test(code)
      ? codeHash(purpose, email, code, emailConfig.AUTH_CODE_PEPPER)
      : "";
    const correct = /^[a-f0-9]{64}$/.test(suppliedHash)
      && crypto.timingSafeEqual(Buffer.from(challenge.code_hash, "hex"), Buffer.from(suppliedHash, "hex"));
    if (!correct) {
      await tx.request()
        .input("challengeId", sql.UniqueIdentifier, challenge.challenge_id)
        .query("UPDATE dbo.EmailChallenge SET attempts = attempts + 1 WHERE challenge_id = @challengeId;");
      return new AuthError("Kod jest nieprawidłowy lub wygasł. Poproś o nowy.", 400);
    }
    return null;
  }

  async function createSession(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    await pool.request()
      .input("sessionHash", sql.Char(64), tokenHash)
      .input("userId", sql.UniqueIdentifier, userId)
      .input("expiresAt", sql.DateTime2, new Date(Date.now() + SESSION_TTL_SECONDS * 1000))
      .query(`
        DELETE FROM dbo.AuthSession WHERE expires_at < SYSUTCDATETIME();
        INSERT INTO dbo.AuthSession (session_hash, user_id, expires_at)
        VALUES (@sessionHash, @userId, @expiresAt);
      `);
    return { token, userId };
  }

  async function startEmailVerification({ email: inputEmail, displayName, password }) {
    requireEmailConfiguration();
    const email = normalizeEmail(inputEmail);
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!name || name.length > 100) throw new AuthError("Podaj imię i nazwisko (maksymalnie 100 znaków).", 400);
    const existing = await pool.request().input("email", sql.NVarChar(320), email)
      .query("SELECT 1 AS found FROM dbo.AppUser WHERE email = @email;");
    if (existing.recordset.length) throw new AuthError("Konto z tym adresem e-mail już istnieje.", 409);
    const passwordHash = await hashPassword(password);
    await issueEmailChallenge({ purpose: "verify_email", email, displayName: name, passwordHash });
    return { email };
  }

  async function verifyEmail({ email: inputEmail, code }) {
    const email = normalizeEmail(inputEmail);
    requireEmailConfiguration();
    const tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    const userId = crypto.randomUUID();
    let displayName;
    let validationError = null;
    try {
      const challenge = await getChallengeForUpdate(tx, email, "verify_email");
      validationError = await checkChallenge(tx, challenge, email, "verify_email", code);
      if (!validationError) {
        const pendingResult = await tx.request()
          .input("challengeId", sql.UniqueIdentifier, challenge.challenge_id)
          .query("SELECT display_name, password_hash FROM dbo.PendingRegistration WHERE challenge_id = @challengeId;");
        const pending = pendingResult.recordset[0];
        if (!pending) {
          validationError = new AuthError("Kod jest nieprawidłowy lub wygasł. Poproś o nowy.", 400);
        } else {
          displayName = pending.display_name;
          await tx.request()
            .input("challengeId", sql.UniqueIdentifier, challenge.challenge_id)
            .input("userId", sql.UniqueIdentifier, userId)
            .input("email", sql.NVarChar(320), email)
            .input("displayName", sql.NVarChar(100), pending.display_name)
            .input("passwordHash", sql.NVarChar(300), pending.password_hash)
            .query(`
              INSERT INTO dbo.AppUser (user_id, email, display_name, is_admin)
              VALUES (@userId, @email, @displayName, 0);
              INSERT INTO dbo.LocalCredential (user_id, password_hash)
              VALUES (@userId, @passwordHash);
              DELETE FROM dbo.EmailChallenge WHERE challenge_id = @challengeId;
            `);
        }
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      if (error.number === 2601 || error.number === 2627) throw new AuthError("Konto z tym adresem e-mail już istnieje.", 409);
      throw error;
    }
    if (validationError) throw validationError;

    return {
      user: { id: userId, email, displayName, isAdmin: false },
      session: await createSession(userId),
    };
  }

  async function startPasswordReset(inputEmail) {
    requireEmailConfiguration();
    const email = normalizeEmail(inputEmail);
    const result = await pool.request().input("email", sql.NVarChar(320), email)
      .query(`
        SELECT u.user_id
        FROM dbo.AppUser u
        INNER JOIN dbo.LocalCredential c ON c.user_id = u.user_id
        WHERE u.email = @email;
      `);
    const user = result.recordset[0];
    if (!user) return;
    await issueEmailChallenge({ purpose: "password_reset", email, userId: user.user_id });
  }

  async function resetPassword({ email: inputEmail, code, password }) {
    requireEmailConfiguration();
    const email = normalizeEmail(inputEmail);
    const passwordHash = await hashPassword(password);
    const tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    let validationError = null;
    try {
      const challenge = await getChallengeForUpdate(tx, email, "password_reset");
      validationError = await checkChallenge(tx, challenge, email, "password_reset", code);
      if (!validationError) {
        await tx.request()
          .input("userId", sql.UniqueIdentifier, challenge.user_id)
          .input("challengeId", sql.UniqueIdentifier, challenge.challenge_id)
          .input("passwordHash", sql.NVarChar(300), passwordHash)
          .query(`
            UPDATE dbo.LocalCredential
            SET password_hash = @passwordHash, updated_at = SYSUTCDATETIME()
            WHERE user_id = @userId;
            DELETE FROM dbo.EmailChallenge WHERE challenge_id = @challengeId;
            DELETE FROM dbo.AuthSession WHERE user_id = @userId;
          `);
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    if (validationError) throw validationError;
  }

  async function startAccountDeletion(userId) {
    const result = await pool.request().input("userId", sql.UniqueIdentifier, userId)
      .query("SELECT email FROM dbo.AppUser WHERE user_id = @userId;");
    const user = result.recordset[0];
    if (!user) throw new AuthError("Nie znaleziono konta.", 404);
    await issueEmailChallenge({ purpose: "delete_account", email: user.email, userId });
  }

  async function confirmAccountDeletion(userId, code) {
    requireEmailConfiguration();
    const userResult = await pool.request().input("userId", sql.UniqueIdentifier, userId)
      .query("SELECT email FROM dbo.AppUser WHERE user_id = @userId;");
    const user = userResult.recordset[0];
    if (!user) throw new AuthError("Nie znaleziono konta.", 404);
    const tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    let validationError = null;
    try {
      const challenge = await getChallengeForUpdate(tx, user.email, "delete_account");
      if (!challenge || String(challenge.user_id).toLowerCase() !== String(userId).toLowerCase()) {
        validationError = new AuthError("Kod jest nieprawidłowy lub wygasł. Poproś o nowy.", 400);
      } else {
        validationError = await checkChallenge(tx, challenge, user.email, "delete_account", code);
      }
      if (!validationError) {
        await tx.request()
          .input("userId", sql.UniqueIdentifier, userId)
          .input("email", sql.NVarChar(320), user.email)
          .query(`
            DELETE FROM dbo.EmailChallenge WHERE user_id = @userId;
            DELETE FROM dbo.EmailChallenge WHERE email = @email;
            DELETE FROM dbo.AuthSession WHERE user_id = @userId;
            DELETE FROM dbo.ExternalIdentity WHERE user_id = @userId;
            DELETE FROM dbo.LocalCredential WHERE user_id = @userId;
            DELETE FROM dbo.AppUser WHERE user_id = @userId;
          `);
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    if (validationError) throw validationError;
  }

  async function loginWithPassword({ email: inputEmail, password }) {
    const email = normalizeEmail(inputEmail);
    if (typeof password !== "string" || password.length > 256) throw new AuthError("Nieprawidłowy adres e-mail lub hasło.", 401);
    const result = await pool.request()
      .input("email", sql.NVarChar(320), email)
      .query(`
        SELECT u.user_id, u.email, u.display_name, u.is_admin, c.password_hash
        FROM dbo.AppUser u
        INNER JOIN dbo.LocalCredential c ON c.user_id = u.user_id
        WHERE u.email = @email;
      `);
    const row = result.recordset[0];
    if (!await verifyPassword(password, row ? row.password_hash : DUMMY_HASH)) {
      throw new AuthError("Nieprawidłowy adres e-mail lub hasło.", 401);
    }
    if (!row) throw new AuthError("Nieprawidłowy adres e-mail lub hasło.", 401);
    return { user: toUser(row), session: await createSession(row.user_id) };
  }

  async function resolveSession(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const result = await pool.request()
      .input("sessionHash", sql.Char(64), tokenHash)
      .query(`
        SELECT u.user_id, u.email, u.display_name, u.is_admin
        FROM dbo.AuthSession s
        INNER JOIN dbo.AppUser u ON u.user_id = s.user_id
        WHERE s.session_hash = @sessionHash AND s.expires_at > SYSUTCDATETIME();
      `);
    return result.recordset[0] ? toUser(result.recordset[0]) : null;
  }

  async function revokeSession(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    await pool.request().input("sessionHash", sql.Char(64), tokenHash)
      .query("DELETE FROM dbo.AuthSession WHERE session_hash = @sessionHash;");
  }

  async function saveOAuthState(state, codeVerifier, returnTo) {
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");
    await pool.request()
      .input("stateHash", sql.Char(64), stateHash)
      .input("provider", sql.NVarChar(30), "google")
      .input("verifier", sql.NVarChar(128), codeVerifier)
      .input("returnTo", sql.NVarChar(2048), safeReturnTo(returnTo))
      .input("expiresAt", sql.DateTime2, new Date(Date.now() + OAUTH_STATE_TTL_SECONDS * 1000))
      .query(`
        DELETE FROM dbo.OAuthState WHERE expires_at < SYSUTCDATETIME();
        INSERT INTO dbo.OAuthState (state_hash, provider, code_verifier, return_to, expires_at)
        VALUES (@stateHash, @provider, @verifier, @returnTo, @expiresAt);
      `);
  }

  async function consumeOAuthState(state) {
    if (typeof state !== "string" || state.length > 256) return null;
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");
    const result = await pool.request()
      .input("stateHash", sql.Char(64), stateHash)
      .query(`
        DELETE FROM dbo.OAuthState
        OUTPUT deleted.provider, deleted.code_verifier AS codeVerifier, deleted.return_to AS returnTo
        WHERE state_hash = @stateHash AND expires_at > SYSUTCDATETIME();
      `);
    return result.recordset[0] || null;
  }

  async function signInWithGoogle({ subject, email: inputEmail, displayName }) {
    const email = normalizeEmail(inputEmail);
    if (typeof subject !== "string" || !subject || subject.length > 255) {
      throw new AuthError("Google nie zwróciło prawidłowego identyfikatora konta.", 401);
    }

    const existing = await pool.request()
      .input("provider", sql.NVarChar(30), "google")
      .input("subject", sql.NVarChar(255), subject)
      .query(`
        SELECT u.user_id, u.email, u.display_name, u.is_admin
        FROM dbo.ExternalIdentity i
        INNER JOIN dbo.AppUser u ON u.user_id = i.user_id
        WHERE i.provider = @provider AND i.provider_subject = @subject;
      `);
    if (existing.recordset[0]) {
      const user = toUser(existing.recordset[0]);
      return { user, session: await createSession(user.id) };
    }

    const tx = new sql.Transaction(pool);
    await tx.begin();
    let user;
    try {
      const byEmail = await tx.request().input("email", sql.NVarChar(320), email)
        .query("SELECT user_id, email, display_name, is_admin FROM dbo.AppUser WHERE email = @email;");
      if (byEmail.recordset[0]) {
        throw new AuthError("Konto z tym adresem e-mail już istnieje. Zaloguj się metodą użytą przy jego tworzeniu.", 409);
      } else {
        const userId = crypto.randomUUID();
        const name = (typeof displayName === "string" && displayName.trim().slice(0, 100)) || email;
        const isAdmin = admins.has(email);
        await tx.request()
          .input("userId", sql.UniqueIdentifier, userId)
          .input("email", sql.NVarChar(320), email)
          .input("displayName", sql.NVarChar(100), name)
          .input("isAdmin", sql.Bit, isAdmin)
          .query(`
            INSERT INTO dbo.AppUser (user_id, email, display_name, is_admin)
            VALUES (@userId, @email, @displayName, @isAdmin);
          `);
        user = { id: userId, email, displayName: name, isAdmin };
      }
      await tx.request()
        .input("provider", sql.NVarChar(30), "google")
        .input("subject", sql.NVarChar(255), subject)
        .input("userId", sql.UniqueIdentifier, user.id)
        .query(`
          INSERT INTO dbo.ExternalIdentity (provider, provider_subject, user_id)
          VALUES (@provider, @subject, @userId);
        `);
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      if (error.number === 2601 || error.number === 2627) {
        const raced = await pool.request()
          .input("provider", sql.NVarChar(30), "google")
          .input("subject", sql.NVarChar(255), subject)
          .query(`
            SELECT u.user_id, u.email, u.display_name, u.is_admin
            FROM dbo.ExternalIdentity i
            INNER JOIN dbo.AppUser u ON u.user_id = i.user_id
            WHERE i.provider = @provider AND i.provider_subject = @subject;
          `);
        if (raced.recordset[0]) {
          user = toUser(raced.recordset[0]);
        } else {
          throw new AuthError("Konto z tym adresem e-mail już istnieje.", 409);
        }
      } else {
        throw error;
      }
    }
    return { user, session: await createSession(user.id) };
  }

  return {
    startEmailVerification,
    verifyEmail,
    startPasswordReset,
    resetPassword,
    startAccountDeletion,
    confirmAccountDeletion,
    loginWithPassword,
    resolveSession,
    revokeSession,
    saveOAuthState,
    consumeOAuthState,
    signInWithGoogle,
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
