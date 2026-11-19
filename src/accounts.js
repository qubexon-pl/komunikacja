"use strict";

// Podavo family accounts for podavo.voyage. The account itself lives in the shared database podavo-mdm (schema mdm):
// e-mail, name, optional password, Google / Apple links, sessions and sign-in codes, the same mechanism as Podavo.
// This app keeps a local member row in dbo.AppUser (user_id = the account's AccountGuid, e-mail, name, is_admin),
// refreshed at sign-in, so its own tables keep their foreign keys. Admin rights stay a Voyage decision.
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const sql = require("mssql");

const scrypt = promisify(crypto.scrypt);
const APP = "voyage";
const SESSION_DAYS = 30;
const SESSION_TTL_SECONDS = SESSION_DAYS * 86400;
const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const STATE_MINUTES = 10;
const PASSWORD_MIN = 8;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }; // the same in every Podavo app
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOOGLE_KEYS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

class AuthError extends Error {
  constructor(message, statusCode) { super(message); this.name = "AuthError"; this.statusCode = statusCode; }
}

const normalizeEmail = (value) => {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) throw new AuthError("Podaj prawidłowy adres e-mail.", 400);
  return email;
};
const sha256 = (value) => crypto.createHash("sha256").update(value).digest();
const newToken = () => crypto.randomBytes(32).toString("base64url");
const nameFromEmail = (email) => {
  const local = String(email || "").split("@")[0].replace(/[._-]+/g, " ").trim();
  return (local ? local[0].toUpperCase() + local.slice(1) : "Podróżnik").slice(0, 100);
};
const hashPassword = (password, salt) => scrypt(String(password).normalize("NFKC"), salt, 64, SCRYPT);

// Google's signing keys, kept for an hour (refetched when a token names a key we do not know yet).
const keyCache = { keys: [], at: 0 };
async function googleKey(kid, fetchSource) {
  if (Date.now() - keyCache.at > 3600000 || !keyCache.keys.some((k) => k.kid === kid)) {
    const response = await fetchSource(GOOGLE_KEYS, { signal: AbortSignal.timeout(10000) });
    keyCache.keys = (await response.json()).keys || [];
    keyCache.at = Date.now();
  }
  const jwk = keyCache.keys.find((k) => k.kid === kid);
  if (!jwk) throw new AuthError("Nieznany klucz logowania Google. Spróbuj ponownie.", 401);
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

/** Checks a Google ID token (RS256) from the Android / iOS sign-in against Google's keys and our client ids. */
async function verifyGoogleIdToken(idToken, audiences, fetchSource = fetch) {
  const bad = new AuthError("Niepoprawny token Google.", 401);
  const [h, p, s] = String(idToken || "").split(".");
  if (!h || !p || !s) throw bad;
  let header, claims;
  try { header = JSON.parse(Buffer.from(h, "base64url")); claims = JSON.parse(Buffer.from(p, "base64url")); } catch { throw bad; }
  if (header.alg !== "RS256" || !header.kid) throw bad;
  if (!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), await googleKey(header.kid, fetchSource), Buffer.from(s, "base64url"))) throw bad;
  if (!audiences.includes(claims.aud)) throw new AuthError("Token Google jest dla innej aplikacji.", 401);
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw bad;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new AuthError("Token Google wygasł. Spróbuj ponownie.", 401);
  if (!claims.email || claims.email_verified !== true) throw new AuthError("Użyj konta Google ze zweryfikowanym adresem e-mail.", 401);
  return { subject: String(claims.sub), email: claims.email, displayName: claims.name };
}

function mdmConfig(env = process.env) {
  return {
    server: env.MDM_SQL_SERVER || "sql-podavo-mdm.database.windows.net",
    database: env.MDM_SQL_DATABASE || "podavo-mdm",
    port: 1433, connectionTimeout: 30000, requestTimeout: 30000,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: "azure-active-directory-default", options: env.AZURE_CLIENT_ID ? { clientId: env.AZURE_CLIENT_ID } : {} },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  };
}

/**
 * mdm: pool for podavo-mdm; local: this app's pool (dbo.AppUser); deliver({to, subject, text}) sends e-mail;
 * codePepper: secret for sign-in code hashes; adminEmails: e-mails that are always Voyage admins.
 */
function createAccounts({ mdm, local, deliver, codePepper = process.env.AUTH_CODE_PEPPER || "", adminEmails = process.env.ADMIN_EMAILS || "",
  devCodes = false, googleAudiences = [], fetchSource = fetch } = {}) {
  const admins = new Set(String(adminEmails).split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
  const m = async () => (typeof mdm === "function" ? mdm() : mdm);
  const pwFails = new Map(); // e-mail → failed password times (this instance): 10 in 15 min lock passwords for 15 min
  const codeHash = (email, code) => crypto.createHmac("sha256", codePepper || "podavo").update(`${APP}:${email}:${code}`).digest();

  // ---- local member row ----
  async function localUser(account) {
    const guid = String(account.AccountGuid).toLowerCase();
    const email = account.Email || `${guid}@konto.podavo`;
    const name = (account.Name || nameFromEmail(email)).slice(0, 100);
    const r = await local.request()
      .input("id", sql.UniqueIdentifier, guid).input("email", sql.NVarChar(320), email).input("name", sql.NVarChar(100), name)
      .input("admin", sql.Bit, admins.has(email) ? 1 : 0)
      .query(`SET NOCOUNT ON;
        UPDATE dbo.AppUser SET email = @email, display_name = @name, is_admin = CASE WHEN @admin = 1 THEN 1 ELSE is_admin END
          WHERE user_id = @id AND (email <> @email OR display_name <> @name OR (@admin = 1 AND is_admin = 0));
        IF NOT EXISTS (SELECT 1 FROM dbo.AppUser WHERE user_id = @id)
          INSERT INTO dbo.AppUser (user_id, email, display_name, is_admin) VALUES (@id, @email, @name, @admin);
        SELECT user_id, email, display_name, is_admin FROM dbo.AppUser WHERE user_id = @id;`);
    const row = r.recordset[0];
    return { id: String(row.user_id).toLowerCase(), email: row.email, displayName: row.display_name, isAdmin: Boolean(row.is_admin), accountId: account.AccountId };
  }

  // ---- accounts ----
  const ACCOUNT_COLUMNS = "a.AccountId, a.AccountGuid, a.Email, a.Name";
  async function accountByEmail(tx, email) {
    const r = await new sql.Request(tx).input("e", sql.NVarChar(254), email).query(`SELECT ${ACCOUNT_COLUMNS} FROM mdm.Account a WHERE a.Email = @e`);
    return r.recordset[0] || null;
  }
  async function accountByEmailOrNew(tx, email, name) {
    const found = await accountByEmail(tx, email);
    if (found) return found;
    const guid = crypto.randomUUID();
    await new sql.Request(tx).input("id", sql.VarChar(40), guid).input("g", sql.UniqueIdentifier, guid).input("e", sql.NVarChar(254), email)
      .input("n", sql.NVarChar(120), (name || nameFromEmail(email)).slice(0, 120))
      .query("INSERT INTO mdm.Account (AccountId, AccountGuid, Email, Name) VALUES (@id, @g, @e, @n)");
    return { AccountId: guid, AccountGuid: guid, Email: email, Name: (name || nameFromEmail(email)).slice(0, 120) };
  }
  async function inTransaction(work) {
    const tx = new sql.Transaction(await m());
    await tx.begin();
    try { const result = await work(tx); await tx.commit(); return result; } catch (error) { await tx.rollback().catch(() => {}); throw error; }
  }

  // ---- sessions ----
  async function createSession(account) {
    const token = newToken();
    await (await m()).request().input("h", sql.Binary(32), sha256(token)).input("id", sql.VarChar(40), account.AccountId).input("app", sql.VarChar(16), APP)
      .input("days", sql.Int, SESSION_DAYS)
      .query(`INSERT INTO mdm.Session (TokenHash, AccountId, AppCode, ExpiresAt) VALUES (@h, @id, @app, DATEADD(day, @days, SYSUTCDATETIME()));
              UPDATE mdm.AccountApp SET LastSignInAt = SYSUTCDATETIME() WHERE AccountId = @id AND AppCode = @app;
              IF @@ROWCOUNT = 0 INSERT INTO mdm.AccountApp (AccountId, AppCode) VALUES (@id, @app);`);
    return { user: await localUser(account), session: { token, expiresIn: SESSION_TTL_SECONDS } };
  }
  async function resolveSession(token) {
    if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
    const r = await (await m()).request().input("h", sql.Binary(32), sha256(token)).input("app", sql.VarChar(16), APP)
      .query(`SELECT ${ACCOUNT_COLUMNS} FROM mdm.Session s JOIN mdm.Account a ON a.AccountId = s.AccountId
              WHERE s.TokenHash = @h AND s.AppCode = @app AND s.ExpiresAt > SYSUTCDATETIME()`);
    return r.recordset[0] ? localUser(r.recordset[0]) : null;
  }
  async function revokeSession(token) {
    if (typeof token !== "string" || !token) return;
    await (await m()).request().input("h", sql.Binary(32), sha256(token)).query("DELETE FROM mdm.Session WHERE TokenHash = @h");
  }

  // ---- e-mail code (the main way in) ----
  async function startEmailLogin(input) {
    const email = normalizeEmail(input?.email ?? input);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const r = await (await m()).request().input("e", sql.NVarChar(254), email).input("app", sql.VarChar(16), APP).input("h", sql.Binary(32), codeHash(email, code))
      .input("min", sql.Int, CODE_MINUTES).input("wait", sql.Int, RESEND_SECONDS)
      .query(`SET NOCOUNT ON;
        DECLARE @since int = (SELECT DATEDIFF(second, CreatedAt, SYSUTCDATETIME()) FROM mdm.EmailLoginCode WHERE Email = @e AND AppCode = @app);
        IF @since IS NOT NULL AND @since < @wait BEGIN SELECT @wait - @since AS wait; RETURN; END
        MERGE mdm.EmailLoginCode AS t USING (SELECT @e AS Email, @app AS AppCode) AS s ON t.Email = s.Email AND t.AppCode = s.AppCode
          WHEN MATCHED THEN UPDATE SET CodeHash = @h, CreatedAt = SYSUTCDATETIME(), ExpiresAt = DATEADD(minute, @min, SYSUTCDATETIME()), Attempts = 0
          WHEN NOT MATCHED THEN INSERT (Email, AppCode, CodeHash, ExpiresAt) VALUES (@e, @app, @h, DATEADD(minute, @min, SYSUTCDATETIME()));
        SELECT 0 AS wait;`);
    const wait = r.recordset[0]?.wait || 0;
    if (wait > 0) return { email, resendIn: wait };
    await deliver({ to: email, subject: "Kod logowania — podavo.voyage",
      text: `Twój kod logowania do podavo.voyage: ${code}\n\nKod jest ważny ${CODE_MINUTES} minut. To samo konto działa we wszystkich aplikacjach Podavo.\nJeśli to nie Ty, zignoruj tę wiadomość.` });
    return { email, resendIn: RESEND_SECONDS, ...(devCodes ? { devCode: code } : {}) };
  }
  // Checks and uses up a code; false when wrong (the attempt is counted) or expired.
  async function useCode(tx, email, code) {
    if (!/^\d{6}$/.test(String(code || "").trim())) return false;
    const r = await new sql.Request(tx).input("e", sql.NVarChar(254), email).input("app", sql.VarChar(16), APP)
      .query("SELECT CodeHash, Attempts, CASE WHEN ExpiresAt > SYSUTCDATETIME() THEN 1 ELSE 0 END AS live FROM mdm.EmailLoginCode WITH (UPDLOCK) WHERE Email = @e AND AppCode = @app");
    const row = r.recordset[0];
    if (!row || !row.live || row.Attempts >= CODE_ATTEMPTS) return false;
    if (!crypto.timingSafeEqual(Buffer.from(row.CodeHash), codeHash(email, String(code).trim()))) {
      await new sql.Request(tx).input("e", sql.NVarChar(254), email).input("app", sql.VarChar(16), APP).query("UPDATE mdm.EmailLoginCode SET Attempts = Attempts + 1 WHERE Email = @e AND AppCode = @app");
      return false;
    }
    await new sql.Request(tx).input("e", sql.NVarChar(254), email).input("app", sql.VarChar(16), APP).query("DELETE FROM mdm.EmailLoginCode WHERE Email = @e AND AppCode = @app");
    return true;
  }
  async function verifyEmailLogin({ email: input, code } = {}) {
    const email = normalizeEmail(input);
    const account = await inTransaction(async (tx) => ((await useCode(tx, email, code)) ? accountByEmailOrNew(tx, email) : null));
    if (!account) throw new AuthError("Kod jest nieprawidłowy lub wygasł. Poproś o nowy.", 400);
    return createSession(account);
  }

  // ---- optional password ----
  async function loginWithPassword({ email: input, password } = {}) {
    const email = normalizeEmail(input);
    const recent = (pwFails.get(email) || []).filter((t) => Date.now() - t < 15 * 60000);
    if (recent.length >= 10) throw new AuthError("Zbyt wiele prób hasła. Zaloguj się kodem z e-maila albo spróbuj za 15 minut.", 429);
    const r = await (await m()).request().input("e", sql.NVarChar(254), email)
      .query(`SELECT ${ACCOUNT_COLUMNS}, c.PasswordHash, c.PasswordSalt FROM mdm.Account a JOIN mdm.Credential c ON c.AccountId = a.AccountId WHERE a.Email = @e`);
    const row = r.recordset[0];
    const key = await hashPassword(String(password || ""), row ? Buffer.from(row.PasswordSalt) : crypto.randomBytes(16));
    if (!row || !crypto.timingSafeEqual(key, Buffer.from(row.PasswordHash))) {
      pwFails.set(email, [...recent, Date.now()]);
      throw new AuthError("Nieprawidłowy e-mail lub hasło.", 401);
    }
    pwFails.delete(email);
    return createSession(row);
  }
  async function credential(accountId) {
    const r = await (await m()).request().input("id", sql.VarChar(40), accountId).query("SELECT PasswordHash, PasswordSalt, UpdatedAt FROM mdm.Credential WHERE AccountId = @id");
    return r.recordset[0] || null;
  }
  async function passwordStatus(user) {
    const c = await credential(user.accountId);
    return { hasPassword: Boolean(c), updatedAt: c ? c.UpdatedAt : null, minLength: PASSWORD_MIN };
  }
  async function checkCurrent(user, current) {
    const c = await credential(user.accountId);
    if (!c) return null;
    const key = await hashPassword(String(current || ""), Buffer.from(c.PasswordSalt));
    if (!crypto.timingSafeEqual(key, Buffer.from(c.PasswordHash))) throw new AuthError("Obecne hasło jest nieprawidłowe.", 400);
    return c;
  }
  // Setting or changing the password signs the account out everywhere else (all Podavo apps), except this session.
  async function setPassword(user, password, current, keepToken) {
    const value = String(password || "");
    if (value.length < PASSWORD_MIN || value.length > 128) throw new AuthError(`Hasło musi mieć od ${PASSWORD_MIN} do 128 znaków.`, 400);
    if (value.toLowerCase() === String(user.email).toLowerCase()) throw new AuthError("Hasło nie może być adresem e-mail.", 400);
    await checkCurrent(user, current);
    const salt = crypto.randomBytes(16), key = await hashPassword(value, salt);
    await (await m()).request().input("id", sql.VarChar(40), user.accountId).input("h", sql.VarBinary(64), key).input("s", sql.VarBinary(16), salt)
      .input("keep", sql.Binary(32), keepToken ? sha256(keepToken) : Buffer.alloc(32))
      .query(`UPDATE mdm.Credential SET PasswordHash = @h, PasswordSalt = @s, UpdatedAt = SYSUTCDATETIME() WHERE AccountId = @id;
              IF @@ROWCOUNT = 0 INSERT INTO mdm.Credential (AccountId, PasswordHash, PasswordSalt) VALUES (@id, @h, @s);
              DELETE FROM mdm.Session WHERE AccountId = @id AND TokenHash <> @keep;`);
    return { hasPassword: true };
  }
  async function removePassword(user, current) {
    if (!(await checkCurrent(user, current))) return { hasPassword: false };
    await (await m()).request().input("id", sql.VarChar(40), user.accountId).query("DELETE FROM mdm.Credential WHERE AccountId = @id");
    return { hasPassword: false };
  }

  // ---- Google ----
  async function saveOAuthState(state, codeVerifier, returnTo) {
    await (await m()).request().input("h", sql.Binary(32), sha256(state)).input("app", sql.VarChar(16), APP).input("v", sql.VarChar(128), codeVerifier)
      .input("r", sql.NVarChar(500), String(returnTo || "/").slice(0, 500)).input("min", sql.Int, STATE_MINUTES)
      .query(`DELETE FROM mdm.OAuthState WHERE ExpiresAt < SYSUTCDATETIME();
              INSERT INTO mdm.OAuthState (StateHash, AppCode, ProviderCode, CodeVerifier, ReturnTo, ExpiresAt) VALUES (@h, @app, 'google', @v, @r, DATEADD(minute, @min, SYSUTCDATETIME()));`);
  }
  async function consumeOAuthState(state) {
    if (typeof state !== "string" || !state) return null;
    const r = await (await m()).request().input("h", sql.Binary(32), sha256(state)).input("app", sql.VarChar(16), APP)
      .query("DELETE FROM mdm.OAuthState OUTPUT deleted.CodeVerifier, deleted.ReturnTo, deleted.ExpiresAt WHERE StateHash = @h AND AppCode = @app");
    const row = r.recordset[0];
    return row && new Date(row.ExpiresAt) > new Date() ? { codeVerifier: row.CodeVerifier, returnTo: row.ReturnTo } : null;
  }
  // Linked before, or matched by the verified e-mail (then linked), or a new account — as in Podavo.
  async function signInWithGoogle({ subject, email: input, displayName }) {
    const email = normalizeEmail(input);
    const account = await inTransaction(async (tx) => {
      const linked = await new sql.Request(tx).input("sub", sql.VarChar(255), String(subject))
        .query(`SELECT ${ACCOUNT_COLUMNS} FROM mdm.ExternalLogin x JOIN mdm.Account a ON a.AccountId = x.AccountId WHERE x.ProviderCode = 'google' AND x.ProviderUserId = @sub`);
      if (linked.recordset[0]) return linked.recordset[0];
      const found = await accountByEmailOrNew(tx, email, displayName);
      await new sql.Request(tx).input("sub", sql.VarChar(255), String(subject)).input("id", sql.VarChar(40), found.AccountId)
        .query(`IF NOT EXISTS (SELECT 1 FROM mdm.ExternalLogin WHERE AccountId = @id AND ProviderCode = 'google')
                  INSERT INTO mdm.ExternalLogin (ProviderCode, ProviderUserId, AccountId) VALUES ('google', @sub, @id);`);
      return found;
    });
    return createSession(account);
  }
  async function signInWithGoogleToken(idToken) {
    if (!googleAudiences.length) throw new AuthError("Logowanie przez Google nie jest skonfigurowane.", 503);
    return signInWithGoogle(await verifyGoogleIdToken(idToken, googleAudiences, fetchSource));
  }

  // ---- leaving podavo.voyage ----
  // Deleting the Voyage account removes this app's data and its sessions; the Podavo account itself stays for the
  // other apps, unless Voyage was the only app it used.
  async function startAccountDeletion(user) {
    return startEmailLogin(user.email);
  }
  async function confirmAccountDeletion(user, code, deleteLocal) {
    const ok = await inTransaction((tx) => useCode(tx, String(user.email).toLowerCase(), code));
    if (!ok) throw new AuthError("Kod jest nieprawidłowy lub wygasł. Poproś o nowy.", 400);
    await deleteLocal(user.id);
    await (await m()).request().input("id", sql.VarChar(40), user.accountId).input("app", sql.VarChar(16), APP)
      .query(`DELETE FROM mdm.Session WHERE AccountId = @id AND AppCode = @app;
              DELETE FROM mdm.AccountApp WHERE AccountId = @id AND AppCode = @app;
              IF NOT EXISTS (SELECT 1 FROM mdm.AccountApp WHERE AccountId = @id) DELETE FROM mdm.Account WHERE AccountId = @id;`);
  }

  return { createSession, resolveSession, revokeSession, startEmailLogin, verifyEmailLogin, loginWithPassword, passwordStatus, setPassword, removePassword,
    saveOAuthState, consumeOAuthState, signInWithGoogle, signInWithGoogleToken, startAccountDeletion, confirmAccountDeletion };
}

module.exports = { APP, AuthError, PASSWORD_MIN, SESSION_TTL_SECONDS, createAccounts, mdmConfig, normalizeEmail, verifyGoogleIdToken };
