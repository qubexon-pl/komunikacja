"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  AuthError,
  createAuthService,
  hashPassword,
  isEmailConfigured,
  normalizeEmail,
  safeReturnTo,
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

test("return paths cannot redirect users off-site", () => {
  assert.equal(safeReturnTo("/map?line=3"), "/map?line=3");
  assert.equal(safeReturnTo("//attacker.example"), "/");
  assert.equal(safeReturnTo("https://attacker.example"), "/");
  assert.equal(safeReturnTo("/\\attacker.example"), "/");
});
