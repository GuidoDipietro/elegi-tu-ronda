import { createHash, createHmac, timingSafeEqual } from "node:crypto";
const cookieName = "ronda_admin";
const lifetime = 8 * 60 * 60;
function secret(): string {
  const value = process.env.ADMIN_PASSWORD;
  if (!value || value.length < 12)
    throw new Error("Set ADMIN_PASSWORD to at least 12 characters");
  return value;
}
function signature(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex");
}
export function checkPassword(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return timingSafeEqual(
    createHash("sha256").update(value).digest(),
    createHash("sha256").update(secret()).digest(),
  );
}
export function adminCookie(now = Date.now()): string {
  const expires = String(Math.floor(now / 1000) + lifetime);
  return `${cookieName}=${expires}.${signature(expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetime}${process.env.VERCEL || process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export function clearAdminCookie(): string {
  return `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.VERCEL || process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export function isAdmin(cookie: string | null, now = Date.now()): boolean {
  const token = cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!token || !/^\d+\.[a-f0-9]{64}$/.test(token)) return false;
  const [expires, signed] = token.split(".");
  if (
    Number(expires) <= Math.floor(now / 1000) ||
    Number(expires) > Math.floor(now / 1000) + lifetime
  )
    return false;
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12)
    return false;
  return timingSafeEqual(
    Buffer.from(signed, "hex"),
    Buffer.from(signature(expires), "hex"),
  );
}
