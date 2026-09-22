import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

test("mobile booking, continuation, FTO, returning name, and organizer controls", async ({
  page,
  browser,
  playwright,
}) => {
  test.setTimeout(90_000);
  const api = await playwright.request.newContext({
    baseURL: "http://127.0.0.1:5173",
  });
  expect(
    (
      await api.post("/api/planner", {
        data: { action: "login", password: "browser-test-password" },
      })
    ).ok(),
  ).toBeTruthy();
  for (const slotId of ["slot-a", "slot-b", "slot-c"])
    expect(
      (
        await api.post("/api/planner", {
          data: { action: "capacity", slotId, capacity: 1 },
        })
      ).ok(),
    ).toBeTruthy();
  await api.post("/api/planner", { data: { action: "lock", locked: false } });
  // Clear only test fixture bookings in these Slots, through the authorized API.
  const existing = await (await api.get("/api/planner?action=admin")).json();
  for (const booking of existing.bookings)
    await api.post("/api/planner", {
      data: { ...booking, action: "remove", asAdmin: true },
    });
  await api.post("/api/planner", { data: { action: "limit", maxSlots: 2 } });

  const name = `Álex Browser ${Date.now()}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Nombre y apellido o WCA ID").fill(name);
  await page.getByRole("button", { name: "Elegir mis Slots" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  for (const id of ["slot-a", "slot-b"]) {
    const slot = page.locator(`#${id}`);
    await slot.getByRole("button", { name: "Elegir evento" }).click();
    await slot
      .getByRole("combobox", { name: "Evento", exact: true })
      .selectOption("555bf");
    await expect(slot.getByRole("radio")).toHaveCount(0);
    await slot.getByRole("button", { name: "Guardar lugar" }).click();
    await expect(slot.getByText("5BLD", { exact: true })).toBeVisible();
  }
  await expect(
    page.locator("#slot-a").getByText("También en otro Slot"),
  ).toBeVisible();
  await expect(page.getByText("Podés elegir hasta 0 Slots garantizados más.", { exact: false })).toBeVisible();
  await expect(page.locator("#slot-c").getByRole("button", { name: "Límite de Slots alcanzado" })).toBeDisabled();
  await api.post("/api/planner", { data: { action: "limit", maxSlots: 4 } });
  await page.reload();
  await expect(page.getByText("Podés elegir hasta 2 Slots garantizados más.", { exact: false })).toBeVisible();
  await api.dispose();
  const fto = page.locator("#slot-c");
  await fto.getByRole("button", { name: "Elegir evento" }).click();
  await fto
    .getByRole("combobox", { name: "Evento", exact: true })
    .selectOption("fto");
  await expect(fto.getByRole("radio", { name: "Ronda 2" })).toHaveCount(0);
  await fto.getByRole("button", { name: "Guardar lugar" }).click();
  await expect(fto.getByText("FTO", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.locator("#slot-a").getByText("5BLD", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/competitor-mobile.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Cambiar persona" }).click();
  await page
    .getByLabel("Nombre y apellido o WCA ID")
    .fill("Otra Persona Browser");
  await page.getByRole("button", { name: "Elegir mis Slots" }).click();
  await expect(
    page.locator("#slot-a").getByRole("button", { name: "Completo" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cambiar persona" }).click();
  await page
    .getByLabel("Nombre y apellido o WCA ID")
    .fill(name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase());
  await page.getByRole("button", { name: "Elegir mis Slots" }).click();
  await expect(
    page.locator("#slot-a").getByText("5BLD", { exact: true }),
  ).toBeVisible();

  const adminContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const admin = await adminContext.newPage();
  await admin.goto("/admin");
  await admin.getByLabel("Contraseña").fill("browser-test-password");
  await admin.getByRole("button", { name: "Ingresar", exact: true }).click();
  await expect(
    admin.getByRole("heading", { name: "Todos los horarios" }),
  ).toBeVisible();
  await admin.getByLabel("Máximo de Slots por competidor").fill("6");
  await admin.getByRole("button", { name: "Guardar límite" }).click();
  await expect(admin.getByText("Límite actualizado.")).toBeVisible();
  await admin.getByLabel("Capacidad de Slot A").fill("0");
  await admin
    .locator(".capacity-card")
    .filter({ hasText: "Slot A" })
    .getByRole("button", { name: "Guardar" })
    .click();
  await expect(
    admin.locator(".capacity-card").filter({ hasText: "Slot A" }),
  ).toContainText("Sobreocupado");
  await admin
    .getByRole("rowheader")
    .getByRole("button", { name: new RegExp(name) })
    .click();
  const personal = admin.locator("#admin-slot-a");
  await personal.getByRole("button", { name: "Cambiar", exact: true }).click();
  await personal
    .getByRole("combobox", { name: "Evento", exact: true })
    .selectOption("222");
  await expect(personal.getByRole("radio")).toHaveCount(0);
  await personal.getByRole("button", { name: "Guardar lugar" }).click();
  await expect(personal.getByText("2x2", { exact: true })).toBeVisible();
  await admin.screenshot({
    path: "test-results/admin-desktop.png",
    fullPage: true,
  });
  await admin
    .getByRole("button", { name: "Cerrar reservas", exact: true })
    .click();
  await expect(
    admin.getByRole("button", { name: "Abrir reservas", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .locator("#slot-a")
      .getByRole("button", { name: "Cambiar", exact: true }),
  ).toBeDisabled();
  await personal
    .getByRole("button", { name: "Liberar lugar", exact: true })
    .click();
  await personal
    .getByRole("button", { name: "Sí, liberar", exact: true })
    .click();
  await expect(personal.getByText("2x2", { exact: true })).toHaveCount(0);
  await admin
    .getByRole("button", { name: "Abrir reservas", exact: true })
    .click();
  await admin.getByRole("button", { name: "Salir", exact: true }).click();
  await expect(
    admin.getByRole("heading", { name: "Acceso de organización" }),
  ).toBeVisible();
  await adminContext.close();
});
