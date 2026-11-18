import {
  type FieldErrors,
  isRecord,
  type LoginSettings,
  parseLoginSettings,
} from "../contracts/login-settings";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: FieldErrors = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function createAccountApi(
  accountId: string,
  transport: typeof fetch = fetch,
) {
  if (!accountId) throw new Error("请先选择账号");
  const url = `/api/login-settings?account=${encodeURIComponent(accountId)}`;
  async function request(options: RequestInit) {
    // An account is captured when this client is created. Never fall back to
    // the server's active account or retry a write whose result is unknown.
    const response = await transport(url, {
      credentials: "same-origin",
      ...options,
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const fields: FieldErrors = {};
      if (isRecord(payload) && isRecord(payload.fields)) {
        for (const [key, value] of Object.entries(payload.fields)) {
          if (typeof value === "string") fields[key] = value;
        }
      }
      throw new ApiError(
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `控制台返回 HTTP ${response.status}`,
        response.status,
        fields,
      );
    }
    return parseLoginSettings(payload);
  }
  return {
    load: (signal: AbortSignal) => request({ signal }),
    save: (settings: LoginSettings, revision: number) =>
      request({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings, revision }),
      }),
  };
}
