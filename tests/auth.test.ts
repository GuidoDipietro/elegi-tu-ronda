import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminCookie,
  checkPassword,
  clearAdminCookie,
  isAdmin,
} from "../src/server/auth.ts";

test("admin cookies require a correct password, valid signature and unexpired timestamp", () => {
  const previous = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = "unit-test-password-123456";
  try {
    const now = Date.now();
    assert.equal(checkPassword("wrong"), false);
    assert.equal(checkPassword(null), false);
    assert.equal(checkPassword(process.env.ADMIN_PASSWORD), true);
    const cookie = adminCookie(now);
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.equal(isAdmin(cookie, now), true);
    assert.equal(isAdmin("other=value; " + cookie, now), true);
    assert.equal(isAdmin(cookie, now + 8 * 60 * 60 * 1000), false);
    assert.equal(isAdmin(cookie.replace(/\.[a-f0-9]/, ".x"), now), false);
    assert.equal(isAdmin("ronda_admin=NaN.invalid", now), false);
    assert.equal(isAdmin(clearAdminCookie(), now), false);
    process.env.ADMIN_PASSWORD = "different-long-password";
    assert.equal(isAdmin(cookie, now), false);
    delete process.env.ADMIN_PASSWORD;
    assert.equal(isAdmin(cookie, now), false);
    assert.throws(() => checkPassword("test"), /ADMIN_PASSWORD/);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous;
  }
});
