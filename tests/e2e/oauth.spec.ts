import { test, expect } from "@playwright/test";

test("browser OAuth rejects a pending registration, then accepts the same account without a roster import", async ({
  page,
}) => {
  let outcome = "pending";
  await page.route("**/api/planner?action=wcaLogin", async (route) => {
    // Follow the real login-start handler, then simulate only the provider's return.
    // Intercept here because Playwright does not reroute a redirected request.
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const target = new URL(response.headers().location);
    expect(target.origin).toBe("https://www.worldcubeassociation.org");
    expect(target.searchParams.get("scope")).toBe("public");
    expect(target.searchParams.get("client_id")).toBe("browser-client");
    expect(target.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
    const callback = new URL(target.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", target.searchParams.get("state")!);
    callback.searchParams.set("code", outcome);
    await route.fulfill({
      response,
      status: 302,
      headers: { ...response.headers(), location: callback.toString() },
      body: "",
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("link", { name: "Ingresar con mi cuenta de la WCA" })
    .click();
  await expect(page.getByRole("alert")).toContainText("hasta 5 minutos");
  expect(
    (await page.context().cookies()).some((c) => c.name === "ronda_competitor"),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/registration-pending-mobile.png",
    fullPage: true,
  });
  outcome = "accepted";
  await page
    .getByRole("link", { name: "Volver a verificar mi inscripción" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Persona OAuth Navegador" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "ronda_competitor")).toMatchObject({
    httpOnly: true,
    sameSite: "Lax",
  });
  expect(cookies.some((c) => c.name === "ronda_oauth")).toBe(false);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Persona OAuth Navegador" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cerrar sesión", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ingresá con tu cuenta de la WCA" }),
  ).toBeVisible();
  expect(
    (await page.context().cookies()).some((c) => c.name === "ronda_competitor"),
  ).toBe(false);
});

test("browser OAuth cancellation and provider failure explain recovery without creating a session", async ({
  page,
}) => {
  let denied = true;
  await page.route("**/api/planner?action=wcaLogin", async (route) => {
    // Follow the real login-start handler, then simulate only the provider's return.
    // Intercept here because Playwright does not reroute a redirected request.
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const target = new URL(response.headers().location);
    expect(target.origin).toBe("https://www.worldcubeassociation.org");
    const callback = new URL(target.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", target.searchParams.get("state")!);
    callback.searchParams.set(
      denied ? "error" : "code",
      denied ? "access_denied" : "unavailable",
    );
    await route.fulfill({
      response,
      status: 302,
      headers: { ...response.headers(), location: callback.toString() },
      body: "",
    });
  });
  await page.goto("/");
  await page
    .getByRole("link", { name: "Ingresar con mi cuenta de la WCA" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Cancelaste el ingreso con tu cuenta de la WCA",
  );
  denied = false;
  await page
    .getByRole("link", { name: "Ingresar con mi cuenta de la WCA" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "No pudimos iniciar sesión con tu cuenta de la WCA",
  );
  expect(
    (await page.context().cookies()).some((c) => c.name === "ronda_competitor"),
  ).toBe(false);
});
