export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(query = "", body?: unknown): Promise<T> {
  const response = await fetch(`/api/planner${query}`, {
    cache: "no-store",
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("El servidor no respondió. Intentá de nuevo.");
  }
  if (!response.ok)
    throw new ApiError(
      result.error || "No se pudo completar la solicitud.",
      response.status,
    );
  return result;
}
export function storedPerson(): string {
  try {
    return localStorage.getItem("ronda-person") || "";
  } catch {
    return "";
  }
}
export function storePerson(id: string): void {
  try {
    if (id) localStorage.setItem("ronda-person", id);
    else localStorage.removeItem("ronda-person");
  } catch {
    /* Name entry still works without browser storage. */
  }
}
