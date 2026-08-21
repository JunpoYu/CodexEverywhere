import { ModalDialog } from "../../components/ModalDialog.js";

export function RecoveryCodesDialog(input: {
  readonly codes: readonly string[];
  readonly onClose: () => void;
}) {
  if (input.codes.length === 0) return null;
  const text = input.codes.join("\n");
  return (
    <ModalDialog
      className="ce-dialog"
      aria-labelledby="settings-recovery-title"
    >
      <h2 id="settings-recovery-title">请立即保存新的恢复码</h2>
      <p>这些恢复码只显示一次，旧恢复码已经失效。</p>
      <pre data-one-time-secret>{text}</pre>
      <div className="dialog-actions">
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(text)}
        >
          复制
        </button>
        <button className="primary" type="button" onClick={input.onClose}>
          我已保存
        </button>
      </div>
    </ModalDialog>
  );
}
