export {};
// Test-only external-service fixtures. Production/dev entry points never import this file.
const connection = process.env.TEST_DATABASE_URL;
if (
  !connection ||
  !new URL(connection).pathname.endsWith("_test") ||
  process.env.DATABASE_URL !== connection
)
  throw new Error(
    "Browser fixtures require an explicitly configured disposable _test database",
  );
process.env.WCA_CLIENT_ID = "browser-client";
process.env.WCA_CLIENT_SECRET = "browser-secret";
process.env.WCA_REDIRECT_URI =
  "http://127.0.0.1:5173/api/planner?action=wcaCallback";
const originalFetch = globalThis.fetch;
let accepted = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://www.worldcubeassociation.org")
    return originalFetch(input, init);
  if (url.pathname === "/oauth/token") {
    const body = new URLSearchParams(String(init?.body));
    if (
      body.get("client_id") !== "browser-client" ||
      body.get("client_secret") !== "browser-secret" ||
      body.get("redirect_uri") !== process.env.WCA_REDIRECT_URI
    )
      return Response.json({ error: "invalid_client" }, { status: 400 });
    if (body.get("code") === "unavailable")
      return new Response(null, { status: 503 });
    accepted = body.get("code") === "accepted";
    return Response.json({ access_token: "browser-access-token" });
  }
  if (url.pathname === "/api/v0/me") {
    if (
      new Headers(init?.headers).get("Authorization") !==
      "Bearer browser-access-token"
    )
      return new Response(null, { status: 401 });
    return Response.json({
      me: { id: 990001, name: "Persona OAuth Navegador", wca_id: null },
    });
  }
  if (url.pathname === "/api/v0/competitions/ElegiTuRondaBA2026/wcif/public")
    return Response.json({
      persons: [
        {
          wcaUserId: 990001,
          name: "Persona OAuth Navegador",
          wcaId: null,
          registration: {
            status: accepted ? "accepted" : "pending",
            isCompeting: true,
          },
        },
      ],
    });
  throw new Error(`Unexpected WCA fixture request: ${url.pathname}`);
};
await import("../../scripts/dev.ts");
