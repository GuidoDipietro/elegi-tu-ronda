import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { competition } from "../config.js";

const wcaOrigin = "https://www.worldcubeassociation.org";
const sessionLifetime = 30 * 24 * 60 * 60;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function cookieValue(
  header: string | null,
  name: string,
): string | null {
  const value = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export function authCookie(
  name: string,
  value: string,
  maxAge: number,
): string {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.VERCEL || process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
function config() {
  const clientId = process.env.WCA_CLIENT_ID;
  const clientSecret = process.env.WCA_CLIENT_SECRET;
  const redirectUri = process.env.WCA_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri)
    throw new Error("WCA OAuth is not configured");
  const url = new URL(redirectUri);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      )) ||
    url.pathname !== "/api/planner" ||
    url.search !== "?action=wcaCallback" ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Invalid WCA_REDIRECT_URI");
  return { clientId, clientSecret, redirectUri };
}
export function wcaConfigured(): boolean {
  try {
    config();
    return true;
  } catch {
    return false;
  }
}
export interface WcaProfile {
  id: number;
  name: string;
  wcaId: string | null;
}
export class WcaLoginError extends Error {}
export async function startWcaLogin(pool: Pool): Promise<Response> {
  const { clientId, redirectUri } = config();
  const state = randomBytes(32).toString("hex");
  const browser = randomBytes(32).toString("hex");
  await pool.query(
    "DELETE FROM planner.oauth_states WHERE expires_at <= now()",
  );
  await pool.query(
    "INSERT INTO planner.oauth_states(state_hash,browser_hash) VALUES ($1,$2)",
    [digest(state), digest(browser)],
  );
  const target = new URL(`${wcaOrigin}/oauth/authorize`);
  target.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "public",
    state,
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Cache-Control": "no-store",
      "Set-Cookie": authCookie("ronda_oauth", browser, 600),
    },
  });
}
export async function finishWcaLogin(
  pool: Pool,
  request: Request,
): Promise<WcaProfile> {
  const { clientId, clientSecret, redirectUri } = config();
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const browser = cookieValue(request.headers.get("cookie"), "ronda_oauth");
  if (!state || !/^[a-f0-9]{64}$/.test(state) || !browser)
    throw new WcaLoginError("invalid_state");
  const consumed = await pool.query(
    "DELETE FROM planner.oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at > now() RETURNING state_hash",
    [digest(state), digest(browser)],
  );
  if (!consumed.rowCount) throw new WcaLoginError("invalid_state");
  if (url.searchParams.has("error")) throw new WcaLoginError("denied");
  const code = url.searchParams.get("code");
  if (!code || code.length > 4096) throw new WcaLoginError("invalid_state");
  const response = await fetch(`${wcaOrigin}/oauth/token`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  });
  if (!response.ok) throw new WcaLoginError("unavailable");
  const token = await response.json();
  if (typeof token.access_token !== "string" || !token.access_token)
    throw new WcaLoginError("unavailable");
  const meResponse = await fetch(`${wcaOrigin}/api/v0/me`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!meResponse.ok) throw new WcaLoginError("unavailable");
  const { me } = await meResponse.json();
  if (
    !me ||
    !Number.isSafeInteger(me.id) ||
    me.id <= 0 ||
    typeof me.name !== "string" ||
    (me.wca_id != null && !/^[0-9]{4}[A-Z]{4}[0-9]{2}$/.test(me.wca_id))
  )
    throw new WcaLoginError("unavailable");
  {
    const rosterResponse = await fetch(
      `${wcaOrigin}/api/v0/competitions/${competition.id}/wcif/public`,
      { redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
    if (!rosterResponse.ok) throw new WcaLoginError("unavailable");
    const roster = await rosterResponse.json();
    if (!Array.isArray(roster.persons)) throw new WcaLoginError("unavailable");
    if (
      !roster.persons.some(
        (p: {
          wcaUserId?: number;
          registration?: { status?: string; isCompeting?: boolean };
        }) =>
          p.wcaUserId === me.id &&
          p.registration?.status === "accepted" &&
          p.registration.isCompeting !== false,
      )
    )
      throw new WcaLoginError("not_registered");
  }
  // Access tokens are used only for this identity lookup and never persisted.
  return { id: me.id, name: me.name, wcaId: me.wca_id ?? null };
}
export async function createCompetitorSession(
  pool: Pool,
  competitorId: string,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "DELETE FROM planner.competitor_sessions WHERE expires_at <= now()",
  );
  await pool.query(
    "INSERT INTO planner.competitor_sessions(token_hash,competitor_id,expires_at) VALUES ($1,$2,now() + interval '30 days')",
    [digest(token), competitorId],
  );
  return authCookie("ronda_competitor", token, sessionLifetime);
}
export async function sessionCompetitor(
  pool: Pool,
  header: string | null,
): Promise<string | null> {
  const token = cookieValue(header, "ronda_competitor");
  if (!token) return null;
  const result = await pool.query(
    "SELECT competitor_id FROM planner.competitor_sessions WHERE token_hash=$1 AND expires_at > now()",
    [digest(token)],
  );
  return result.rows[0]?.competitor_id ?? null;
}
export async function logoutCompetitor(
  pool: Pool,
  header: string | null,
): Promise<string> {
  const token = cookieValue(header, "ronda_competitor");
  if (token)
    await pool.query(
      "DELETE FROM planner.competitor_sessions WHERE token_hash=$1",
      [digest(token)],
    );
  return authCookie("ronda_competitor", "", 0);
}
