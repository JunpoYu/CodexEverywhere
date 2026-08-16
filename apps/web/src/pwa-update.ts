export type PwaUpdateSafetyState = {
  oneTimeSecretVisible: boolean;
  draftPresent: boolean;
  operationPending: boolean;
};

type UpdateActivation = () => void;

let pendingActivation: UpdateActivation | undefined;
const updateListeners = new Set<(activate: UpdateActivation) => void>();

export function announcePwaUpdate(activate: UpdateActivation): void {
  pendingActivation = activate;
  for (const listener of updateListeners) listener(activate);
}

export function pwaUpdateBlockedReason(
  state: PwaUpdateSafetyState,
): string | undefined {
  if (state.oneTimeSecretVisible)
    return "请先离线保存并关闭当前一次性凭据，再更新页面。";
  if (state.operationPending)
    return "当前操作或消息结果仍待确认，请等待完成后再更新。";
  if (state.draftPresent)
    return "页面中还有未提交内容，请先发送、保存或手动清空。";
  return undefined;
}

export function readPwaUpdateSafetyState(
  root: Document = document,
): PwaUpdateSafetyState {
  const recoveryDialog = root.querySelector<HTMLDialogElement>(
    "#recovery-dialog[open]",
  );
  const recoveryCode = root.querySelector<HTMLInputElement>(
    "#recovery-code-output",
  );
  const adminSecretDialog = root.querySelector<HTMLDialogElement>(
    "#admin-secret-dialog[open]",
  );
  const adminSecret = root.querySelector<HTMLElement>("#admin-secret-value");
  const v4Secret = root.querySelector<HTMLElement>("[data-one-time-secret]");
  const draftFields = root.querySelectorAll<
    HTMLTextAreaElement | HTMLInputElement
  >(
    [
      "textarea",
      'input[type="password"]',
      "#login-recovery-input",
      "#codex-auth-file",
    ].join(","),
  );

  return {
    oneTimeSecretVisible: Boolean(
      (recoveryDialog?.open && recoveryCode?.value) ||
      (adminSecretDialog?.open && adminSecret?.textContent?.trim()) ||
      v4Secret?.textContent?.trim(),
    ),
    draftPresent: [...draftFields].some((field) => {
      if (field.closest("[hidden]")) return false;
      const dialog = field.closest<HTMLDialogElement>("dialog");
      if (dialog && !dialog.open) return false;
      if (field instanceof HTMLInputElement && field.type === "file")
        return Boolean(field.files?.length);
      return Boolean(field.value.trim());
    }),
    operationPending: Boolean(
      root.querySelector(
        '.mutation-outcome-pending, [aria-busy="true"], .timeline-entry.outcome-unknown, .composer-queue-item.confirming',
      ),
    ),
  };
}

export function mountPwaUpdatePrompt(): () => void {
  const listener = (activate: UpdateActivation): void => {
    let prompt = document.getElementById("pwa-update-prompt");
    if (!prompt) {
      prompt = document.createElement("aside");
      prompt.id = "pwa-update-prompt";
      prompt.className = "pwa-update-prompt";
      prompt.setAttribute("role", "region");
      prompt.setAttribute("aria-label", "应用更新");
      prompt.innerHTML = `
        <div><strong>新版本已就绪</strong><span data-update-detail role="status" aria-live="polite">请在安全时刷新以应用更新。</span></div>
        <div><button data-update-later class="ghost" type="button">稍后</button><button data-update-apply class="primary" type="button">安全刷新</button></div>
      `;
      document.body.append(prompt);
    }
    prompt.hidden = false;
    const detail = prompt.querySelector<HTMLElement>("[data-update-detail]")!;
    const apply = prompt.querySelector<HTMLButtonElement>(
      "[data-update-apply]",
    )!;
    const later = prompt.querySelector<HTMLButtonElement>(
      "[data-update-later]",
    )!;
    apply.onclick = () => {
      const blocked = pwaUpdateBlockedReason(readPwaUpdateSafetyState());
      if (blocked) {
        detail.textContent = blocked;
        prompt!.classList.add("blocked");
        return;
      }
      prompt!.classList.remove("blocked");
      apply.disabled = true;
      later.disabled = true;
      detail.textContent = "正在应用更新…";
      activate();
    };
    later.onclick = () => {
      prompt!.hidden = true;
    };
  };
  updateListeners.add(listener);
  if (pendingActivation) listener(pendingActivation);
  return () => updateListeners.delete(listener);
}
