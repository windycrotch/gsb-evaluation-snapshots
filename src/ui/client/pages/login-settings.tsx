import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Badge } from "../../badge";
import { Button } from "../../button";
import { Card, CardContent, CardHeader, CardTitle } from "../../card";
import { Input } from "../../input";
import { Switch } from "../../switch";
import {
  type FieldErrors,
  type LoginSettingsDraft,
  type LoginSettingsResponse,
  toDraft,
  validateDraft,
} from "../contracts/login-settings";
import { ApiError, createAccountApi } from "../lib/api";
import { formatGameTime } from "../lib/time";
import { useConsoleSlice } from "../lib/use-console-slice";
import styles from "./login-settings.module.css";

type Notice = { text: string; kind: "" | "success" | "error" };
type LoginFormState = {
  data: LoginSettingsResponse | null;
  draft: LoginSettingsDraft | null;
  fields: FieldErrors;
  notice: Notice;
  loading: boolean;
  saving: boolean;
  loadAttempt: number;
};

function Field({
  id,
  name,
  label,
  value,
  onChange,
  error,
  min = 1,
  max = 86400,
  unit = "秒",
  type = "number",
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  min?: number;
  max?: number;
  unit?: string;
  type?: "number" | "time";
}) {
  return (
    <label htmlFor={id}>
      <span>{label}</span>
      <span className={styles.field}>
        <Input
          id={id}
          data-login-setting={name}
          type={type}
          value={value}
          min={type === "number" ? min : undefined}
          max={type === "number" ? max : undefined}
          step={type === "number" ? 1 : undefined}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        {type === "number" && <span>{unit}</span>}
      </span>
      {error && (
        <span id={`${id}-error`} className={styles.error}>
          {error}
        </span>
      )}
    </label>
  );
}

function LoginSettingsPage({
  accountId,
  active,
}: {
  accountId: string | null;
  active: boolean;
}) {
  const [
    { data, draft, fields, notice, loading, saving, loadAttempt },
    setField,
  ] = useConsoleSlice<LoginFormState>(
    `loginSettings:${accountId ?? "none"}`,
    () => ({
      data: null,
      draft: null,
      fields: {},
      notice: { text: accountId ? "正在载入…" : "请先选择账号", kind: "" },
      loading: false,
      saving: false,
      loadAttempt: 0,
    }),
  );
  const setData = (value: LoginSettingsResponse | null) =>
    setField("data", value);
  const setDraft = (
    value:
      | LoginSettingsDraft
      | null
      | ((previous: LoginSettingsDraft | null) => LoginSettingsDraft | null),
  ) => setField("draft", value);
  const setFields = (value: FieldErrors) => setField("fields", value);
  const setNotice = (value: Notice) => setField("notice", value);
  const setLoading = (value: boolean) => setField("loading", value);
  const setSaving = (value: boolean) => setField("saving", value);
  const setLoadAttempt = (value: (previous: number) => number) =>
    setField("loadAttempt", value);
  const savingLock = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The explicit retry token restarts failed reads while data is still null.
  useEffect(() => {
    if (!accountId || !active || data) return;
    const controller = new AbortController();
    setLoading(true);
    setNotice({ text: "正在载入…", kind: "" });
    void createAccountApi(accountId)
      .load(controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setData(response);
        setDraft(toDraft(response.settings));
        setFields({});
        setNotice({
          text: response.savedAt ? "设置已保存" : "使用默认设置",
          kind: "success",
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setNotice({
            text: error instanceof Error ? error.message : "载入失败，请重试",
            kind: "error",
          });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      setLoading(false);
    };
  }, [accountId, active, data, loadAttempt]);

  const dirty =
    !!data &&
    !!draft &&
    JSON.stringify(draft) !== JSON.stringify(toDraft(data.settings));
  function edit(update: (value: LoginSettingsDraft) => LoginSettingsDraft) {
    setDraft((value) => (value ? update(value) : value));
    setFields({});
    setNotice({ text: "有未保存修改", kind: "" });
  }
  function reset() {
    if (!data || saving || savingLock.current) return;
    setDraft(toDraft(data.settings));
    setFields({});
    setNotice({
      text: data.savedAt ? "设置已保存" : "使用默认设置",
      kind: "success",
    });
  }
  function reload() {
    if (saving || savingLock.current) return;
    setData(null);
    setDraft(null);
    setFields({});
    setLoadAttempt((value) => value + 1);
  }
  async function save() {
    if (!accountId || !data || !draft || saving || savingLock.current) return;
    const result = validateDraft(draft);
    if (Object.keys(result.fields).length) {
      setFields(result.fields);
      setNotice({ text: "请修正标出的设置后再保存", kind: "error" });
      return;
    }
    savingLock.current = true;
    setSaving(true);
    setFields({});
    setNotice({ text: "正在保存…", kind: "" });
    try {
      const response = await createAccountApi(accountId).save(
        result.settings,
        data.revision,
      );
      setData(response);
      setDraft(toDraft(response.settings));
      setNotice({ text: "设置已保存", kind: "success" });
    } catch (error) {
      setFields(error instanceof ApiError ? error.fields : {});
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "保存失败，请载入最新设置后确认",
        kind: "error",
      });
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  }

  return (
    <div
      className={styles.page}
      data-react-page="login-settings"
      data-dirty={dirty}
    >
      <div className={styles.heading}>
        <div>
          <h2 className="text-xl font-semibold">登录设置</h2>
          <p className="dim mt-1">账号被顶号后自动重新连接</p>
        </div>
        <Badge
          id="login-settings-state"
          className={styles.state}
          variant="outline"
          role="status"
          aria-live="polite"
          data-kind={notice.kind}
          title={
            data?.savedAt
              ? `保存于 ${formatGameTime(data.savedAt)}（北京时间）`
              : undefined
          }
        >
          {notice.text}
        </Badge>
      </div>
      {!draft ? (
        <div aria-busy={loading}>
          <p className="dim">
            {accountId
              ? "此页仅管理当前账号的登录恢复策略。"
              : "选择账号后可编辑登录恢复策略。"}
          </p>
          {accountId && (
            <Button
              id="login-settings-reload"
              type="button"
              variant="outline"
              disabled={loading}
              onClick={reload}
            >
              重新载入
            </Button>
          )}
        </div>
      ) : (
        <form
          id="login-settings-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset
            disabled={saving}
            className="m-0 min-w-0 border-0 p-0"
            aria-label="登录恢复设置"
          >
            <Card className={styles.card}>
              <CardHeader>
                <CardTitle>顶号重连延迟时间</CardTitle>
                <p className="dim">
                  账号在执行任务时被顶号，等待一段时间后再重新登录。
                </p>
              </CardHeader>
              <CardContent>
                <div className={styles.toggleRow}>
                  <div>
                    <strong>启用被顶号后自动重连</strong>
                    <span className="dim">
                      仅在检测到“账号在别处登录”时触发。
                    </span>
                  </div>
                  <Switch
                    id="login-reconnect-enabled"
                    type="button"
                    data-login-setting="reconnectEnabled"
                    aria-label="启用被顶号后自动重连"
                    checked={draft.reconnectEnabled}
                    disabled={saving}
                    onCheckedChange={(checked) =>
                      edit((value) => ({ ...value, reconnectEnabled: checked }))
                    }
                  />
                </div>
                <div className={styles.grid}>
                  <Field
                    id="login-reconnect-delay"
                    name="baseDelaySeconds"
                    label="基础重连间隔"
                    value={draft.baseDelaySeconds}
                    error={fields.baseDelaySeconds}
                    onChange={(raw) =>
                      edit((value) => ({ ...value, baseDelaySeconds: raw }))
                    }
                  />
                  <Field
                    id="login-reconnect-jitter"
                    name="jitterSeconds"
                    label="间隔抖动"
                    min={0}
                    value={draft.jitterSeconds}
                    error={fields.jitterSeconds}
                    onChange={(raw) =>
                      edit((value) => ({ ...value, jitterSeconds: raw }))
                    }
                  />
                </div>
                <p className={`dim ${styles.note}`}>
                  实际等待时间会在基础间隔上下随机调整，避免固定时间重复登录。
                </p>
              </CardContent>
            </Card>
            <Card className={styles.card}>
              <CardHeader>
                <CardTitle>深夜空窗期</CardTitle>
                <p className="dim">
                  在指定时间段内使用独立的短延迟，适合凌晨自动恢复连接。
                </p>
              </CardHeader>
              <CardContent>
                <div className={styles.toggleRow}>
                  <div>
                    <strong>启用深夜空窗期</strong>
                    <span className="dim">
                      跨午夜的时间段也可以使用，例如 23:00–06:00。
                    </span>
                  </div>
                  <Switch
                    id="login-deep-enabled"
                    type="button"
                    data-login-setting="deep.enabled"
                    aria-label="启用深夜空窗期"
                    checked={draft.deep.enabled}
                    disabled={saving}
                    onCheckedChange={(enabled) =>
                      edit((value) => ({
                        ...value,
                        deep: { ...value.deep, enabled },
                      }))
                    }
                  />
                </div>
                <div className={`${styles.grid} ${styles.timeGrid}`}>
                  <Field
                    id="login-deep-start"
                    name="deep.start"
                    label="开始时间"
                    type="time"
                    value={draft.deep.start}
                    error={fields["deep.start"]}
                    onChange={(start) =>
                      edit((value) => ({
                        ...value,
                        deep: { ...value.deep, start },
                      }))
                    }
                  />
                  <Field
                    id="login-deep-end"
                    name="deep.end"
                    label="结束时间"
                    type="time"
                    value={draft.deep.end}
                    error={fields["deep.end"]}
                    onChange={(end) =>
                      edit((value) => ({
                        ...value,
                        deep: { ...value.deep, end },
                      }))
                    }
                  />
                  <Field
                    id="login-deep-delay"
                    name="deep.delaySeconds"
                    label="空窗期重连延迟"
                    value={draft.deep.delaySeconds}
                    error={fields["deep.delaySeconds"]}
                    onChange={(delaySeconds) =>
                      edit((value) => ({
                        ...value,
                        deep: { ...value.deep, delaySeconds },
                      }))
                    }
                  />
                </div>
              </CardContent>
            </Card>
            <Card className={styles.card}>
              <CardHeader>
                <CardTitle>重试限制</CardTitle>
                <p className="dim">
                  顶号重连连续失败达到上限后停止本轮重试，并在运行日志中记录原因。
                </p>
              </CardHeader>
              <CardContent>
                <div className={`${styles.grid} ${styles.retryGrid}`}>
                  <Field
                    id="login-reconnect-max-retries"
                    name="maxRetries"
                    label="最大重试次数"
                    max={1000}
                    unit="次"
                    value={draft.maxRetries}
                    error={fields.maxRetries}
                    onChange={(raw) =>
                      edit((value) => ({ ...value, maxRetries: raw }))
                    }
                  />
                </div>
                <p
                  id="login-reconnect-log"
                  className={`dim ${styles.note}`}
                  role="status"
                >
                  {draft.reconnectEnabled
                    ? `达到 ${draft.maxRetries || "—"} 次失败后自动停止重试，并记录错误日志。`
                    : "自动重连当前关闭；开启后达到最大重试次数会自动停止并记录日志。"}
                </p>
              </CardContent>
            </Card>
            <div className={styles.actions}>
              <Button
                id="login-settings-reload"
                type="button"
                variant="outline"
                onClick={reload}
                title="放弃本页修改，重新读取服务器保存的设置"
              >
                载入最新设置
              </Button>
              <Button
                id="login-settings-reset"
                type="button"
                variant="outline"
                onClick={reset}
              >
                恢复已保存设置
              </Button>
              <Button id="login-settings-save" type="submit" disabled={saving}>
                {saving ? "正在保存…" : "保存设置"}
              </Button>
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}

export interface LoginSettingsMount {
  update(accountId: string | null, active: boolean): void;
  unmount(): void;
}

export function mountLoginSettings(
  host: HTMLElement,
  accountId: string | null,
  active: boolean,
): LoginSettingsMount {
  const root = createRoot(host);
  const update = (nextAccount: string | null, nextActive: boolean) => {
    root.render(
      <StrictMode>
        <LoginSettingsPage
          key={nextAccount ?? "no-account"}
          accountId={nextAccount}
          active={nextActive}
        />
      </StrictMode>,
    );
  };
  update(accountId, active);
  return { update, unmount: () => root.unmount() };
}
