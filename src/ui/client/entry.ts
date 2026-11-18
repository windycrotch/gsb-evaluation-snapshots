import { getConsoleStore } from "./lib/console-store";
import type { LoginSettingsMount } from "./pages/login-settings";

const host = document.getElementById("login-settings-root");
const section = document.getElementById("tab-login-settings");

if (host && section) {
  const store = getConsoleStore();
  let mounted: LoginSettingsMount | undefined;
  let loading = false;
  let disposed = false;
  const active = () =>
    store.getState().view.page === "login-settings" && !document.hidden;
  const account = () => store.getState().currentAccountId;

  async function update() {
    if (disposed) return;
    if (mounted) {
      mounted.update(account(), active());
      return;
    }
    if (!active() || loading) return;
    loading = true;
    try {
      // Keep React, Radix and Day.js off the overview page's initial JS path.
      const { mountLoginSettings } = await import("./pages/login-settings");
      if (!disposed)
        mounted = mountLoginSettings(host as HTMLElement, account(), active());
    } catch {
      if (disposed) return;
      const message = document.createElement("p");
      message.setAttribute("role", "alert");
      message.textContent =
        "登录设置页面加载失败，请重试；更新程序后请刷新网页。";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载页面组件";
      retry.addEventListener("click", () => {
        void update();
      });
      host?.replaceChildren(message, retry);
    } finally {
      loading = false;
    }
  }

  const unsubscribe = store.subscribe((state, previous) => {
    if (
      state.currentAccountId !== previous.currentAccountId ||
      state.view.page !== previous.view.page
    )
      void update();
  });
  document.addEventListener("visibilitychange", update);
  window.addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    disposed = true;
    unsubscribe();
    document.removeEventListener("visibilitychange", update);
    mounted?.unmount();
  });
  void update();
}
