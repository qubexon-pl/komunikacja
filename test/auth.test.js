"use strict";

const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");
const {
  AuthError,
  createAuthService,
  hashPassword,
  isEmailConfigured,
  normalizeEmail,
  safeReturnTo,
  sendSmtpEmail,
  verifyPassword,
} = require("../src/auth");

test("local passwords are salted and verified with scrypt", async () => {
  const first = await hashPassword("a sufficiently long password");
  const second = await hashPassword("a sufficiently long password");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("a sufficiently long password", first), true);
  assert.equal(await verifyPassword("not the right password", first), false);
});

test("local passwords must meet the minimum length", async () => {
  await assert.rejects(() => hashPassword("short"), (error) => error instanceof AuthError && error.statusCode === 400);
});

test("email addresses are normalized before account lookup", () => {
  assert.equal(normalizeEmail("  Rider@Example.COM  "), "rider@example.com");
  assert.throws(() => normalizeEmail("not-an-email"), AuthError);
});

test("auth service can start without an email provider and reports it as disabled", () => {
  const auth = createAuthService({});
  assert.equal(typeof auth.startEmailVerification, "function");
  assert.equal(isEmailConfigured({}), false);
  assert.equal(isEmailConfigured({
    SENDGRID_API_KEY: "test-key",
    SENDGRID_FROM_EMAIL: "noreply@example.com",
    AUTH_CODE_PEPPER: "0123456789abcdef0123456789abcdef",
  }), true);
  assert.equal(isEmailConfigured({
    ACS_EMAIL_ENDPOINT: "https://example.communication.azure.com",
    ACS_EMAIL_SENDER: "noreply@example.com",
    AUTH_CODE_PEPPER: "0123456789abcdef0123456789abcdef",
  }), false);
  assert.equal(isEmailConfigured({
    SENDGRID_API_KEY: " ",
    SENDGRID_FROM_EMAIL: "noreply@example.com",
    AUTH_CODE_PEPPER: "0123456789abcdef0123456789abcdef",
  }), false);
});

test("console email delivery is opt-in and never enabled in production", () => {
  const pepper = "0123456789abcdef0123456789abcdef";
  assert.equal(isEmailConfigured({ AUTH_EMAIL_CONSOLE: "true", AUTH_CODE_PEPPER: pepper }), true);
  assert.equal(isEmailConfigured({ AUTH_EMAIL_CONSOLE: "true" }), false);
  assert.equal(isEmailConfigured({ AUTH_CODE_PEPPER: pepper }), false);
  assert.equal(isEmailConfigured({ AUTH_EMAIL_CONSOLE: "true", NODE_ENV: "production", AUTH_CODE_PEPPER: pepper }), false);
});

test("SMTP settings enable email only when complete", () => {
  const smtp = {
    SMTP_HOST: "smtp.example.com",
    SMTP_USER: "rider@example.com",
    SMTP_PASS: "app-password",
    SMTP_FROM: "rider@example.com",
    AUTH_CODE_PEPPER: "0123456789abcdef0123456789abcdef",
  };
  assert.equal(isEmailConfigured(smtp), true);
  assert.equal(isEmailConfigured({ ...smtp, SMTP_PASS: " " }), false);
});

test("SMTP delivery logs in and sends the code", async (t) => {
  const received = [];
  const server = net.createServer((socket) => {
    let inData = false;
    socket.write("220 test\r\n");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
        received.push(line);
        if (inData) {
          if (line === ".") { inData = false; socket.write("250 queued\r\n"); }
        } else if (/^EHLO/i.test(line)) socket.write("250-test\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH/i.test(line)) socket.write("235 ok\r\n");
        else if (/^DATA/i.test(line)) { inData = true; socket.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  await sendSmtpEmail({
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(server.address().port),
    SMTP_USER: "sender@example.com",
    SMTP_PASS: "app-password",
    SMTP_FROM: "sender@example.com",
  }, { to: "rider@example.com", subject: "Kod", text: "Kod: 123456" });

  const log = received.join("\n");
  assert.match(log, /AUTH PLAIN/);
  assert.match(log, /RCPT TO:<rider@example\.com>/);
  assert.match(log, /Kod: 123456/);
});

test("return paths cannot redirect users off-site", () => {
  assert.equal(safeReturnTo("/map?line=3"), "/map?line=3");
  assert.equal(safeReturnTo("//attacker.example"), "/");
  assert.equal(safeReturnTo("https://attacker.example"), "/");
  assert.equal(safeReturnTo("/\\attacker.example"), "/");
});
