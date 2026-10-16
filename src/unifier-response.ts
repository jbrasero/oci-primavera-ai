export function restBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/ws\/rest\/service$/i, "").replace(/\/unifier$/i, "");
}

/** Only a successful JSON API response is proof of a working connection. */
export async function readUnifierJson(response: Response): Promise<unknown> {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Unifier redirige fuera del servicio REST (HTTP ${response.status}). Comprueba la URL base REST; una página de login no valida la conexión.`);
  }
  if (!response.ok) {
    throw new Error(`Unifier REST devolvió HTTP ${response.status}${response.status === 401 ? ": autenticación rechazada. Comprueba el token, su esquema y la configuración del servicio REST." : "."}`);
  }
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/html") || /^\s*</.test(text)) {
    throw new Error("Unifier devolvió HTML en lugar de JSON. La respuesta puede ser una página de login; la conexión REST no está validada.");
  }
  let payload: unknown;
  try { payload = JSON.parse(text); }
  catch { throw new Error("Unifier no devolvió una respuesta JSON válida."); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Respuesta REST de Unifier inesperada: se esperaba un objeto JSON.");
  }
  const status = (payload as { status?: unknown }).status;
  if (status !== undefined && Number(status) !== 200) {
    throw new Error(`Unifier informó de un error de aplicación (status ${String(status)}).`);
  }
  return payload;
}
