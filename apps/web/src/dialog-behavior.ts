const EXPLICIT_CLOSE_DIALOGS = new Set([
  "password-dialog",
  "recovery-dialog",
  "network-settings-dialog",
]);

export function shouldDismissDialogFromBackdrop(dialogId: string): boolean {
  return !EXPLICIT_CLOSE_DIALOGS.has(dialogId);
}

export function shouldPreventDialogCancel(dialogId: string): boolean {
  return EXPLICIT_CLOSE_DIALOGS.has(dialogId);
}
