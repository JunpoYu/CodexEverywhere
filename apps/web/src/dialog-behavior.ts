const EXPLICIT_CLOSE_DIALOGS = new Set(["password-dialog", "recovery-dialog"]);

export function shouldDismissDialogFromBackdrop(dialogId: string): boolean {
  return !EXPLICIT_CLOSE_DIALOGS.has(dialogId);
}
