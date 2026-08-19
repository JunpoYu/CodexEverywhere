import {
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type SyntheticEvent,
} from "react";

type DialogProps = Omit<ComponentPropsWithoutRef<"dialog">, "open"> & {
  readonly onRequestClose?: () => void;
};

/** Native top-layer dialog with focus containment and explicit close policy. */
export function ModalDialog(input: DialogProps) {
  const { onRequestClose, onCancel, ...props } = input;
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const cancel = (event: SyntheticEvent<HTMLDialogElement, Event>) => {
    onCancel?.(event);
    const blocked = event.isDefaultPrevented();
    event.preventDefault();
    if (!blocked) onRequestClose?.();
  };

  return <dialog {...props} ref={ref} onCancel={cancel} />;
}
