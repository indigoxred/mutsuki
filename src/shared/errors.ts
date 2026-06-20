export type HttpStatusClass = "ok" | "auth" | "transient" | "permanent";

export function classifyHttpStatus(status: number): HttpStatusClass {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || status >= 500) return "transient";
  return "permanent";
}
