export interface LoginSettings {
  reconnectEnabled: boolean;
  baseDelaySeconds: number;
  jitterSeconds: number;
  maxRetries: number;
  deep: {
    enabled: boolean;
    start: string;
    end: string;
    delaySeconds: number;
  };
}

export interface LoginSettingsResponse {
  settings: LoginSettings;
  revision: number;
  savedAt: string | null;
}

export interface LoginSettingsDraft {
  reconnectEnabled: boolean;
  baseDelaySeconds: string;
  jitterSeconds: string;
  maxRetries: string;
  deep: { enabled: boolean; start: string; end: string; delaySeconds: string };
}

export type FieldErrors = Record<string, string>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function time(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// Treat HTTP payloads as unknown until the contract has been checked.
export function parseLoginSettings(value: unknown): LoginSettingsResponse {
  if (!isRecord(value) || !isRecord(value.settings))
    throw new Error("登录设置响应格式无效");
  const settings = value.settings;
  const deep = settings.deep;
  if (
    typeof settings.reconnectEnabled !== "boolean" ||
    !integer(settings.baseDelaySeconds, 1, 86400) ||
    !integer(settings.jitterSeconds, 0, 86400) ||
    !integer(settings.maxRetries, 1, 1000) ||
    !isRecord(deep) ||
    typeof deep.enabled !== "boolean" ||
    !time(deep.start) ||
    !time(deep.end) ||
    !integer(deep.delaySeconds, 1, 86400) ||
    !integer(value.revision, 0, Number.MAX_SAFE_INTEGER) ||
    !(value.savedAt === null || typeof value.savedAt === "string")
  )
    throw new Error("登录设置响应格式无效");
  return {
    settings: {
      reconnectEnabled: settings.reconnectEnabled,
      baseDelaySeconds: settings.baseDelaySeconds,
      jitterSeconds: settings.jitterSeconds,
      maxRetries: settings.maxRetries,
      deep: {
        enabled: deep.enabled,
        start: deep.start,
        end: deep.end,
        delaySeconds: deep.delaySeconds,
      },
    },
    revision: value.revision,
    savedAt: value.savedAt,
  };
}

export function toDraft(settings: LoginSettings): LoginSettingsDraft {
  return {
    reconnectEnabled: settings.reconnectEnabled,
    baseDelaySeconds: String(settings.baseDelaySeconds),
    jitterSeconds: String(settings.jitterSeconds),
    maxRetries: String(settings.maxRetries),
    deep: {
      ...settings.deep,
      delaySeconds: String(settings.deep.delaySeconds),
    },
  };
}

export function validateDraft(draft: LoginSettingsDraft): {
  settings: LoginSettings;
  fields: FieldErrors;
} {
  const fields: FieldErrors = {};
  function number(key: string, raw: string, minimum: number, maximum: number) {
    const value = Number(raw);
    if (!raw.trim() || !integer(value, minimum, maximum))
      fields[key] = `请输入 ${minimum}–${maximum} 之间的整数`;
    return value;
  }
  if (!time(draft.deep.start)) fields["deep.start"] = "请输入有效时间（HH:mm）";
  if (!time(draft.deep.end)) fields["deep.end"] = "请输入有效时间（HH:mm）";
  const settings: LoginSettings = {
    reconnectEnabled: draft.reconnectEnabled,
    baseDelaySeconds: number(
      "baseDelaySeconds",
      draft.baseDelaySeconds,
      1,
      86400,
    ),
    jitterSeconds: number("jitterSeconds", draft.jitterSeconds, 0, 86400),
    maxRetries: number("maxRetries", draft.maxRetries, 1, 1000),
    deep: {
      ...draft.deep,
      delaySeconds: number(
        "deep.delaySeconds",
        draft.deep.delaySeconds,
        1,
        86400,
      ),
    },
  };
  return { settings, fields };
}
