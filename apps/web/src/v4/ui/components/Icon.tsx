import type { SVGProps } from "react";

export type IconName =
  | "archive"
  | "check"
  | "chevron-down"
  | "close"
  | "connection"
  | "danger"
  | "more"
  | "outline"
  | "queue"
  | "refresh"
  | "send"
  | "settings"
  | "stop"
  | "task"
  | "terminal"
  | "trash"
  | "workspace";

export function Icon(
  input: SVGProps<SVGSVGElement> & { readonly name: IconName },
) {
  const { name, ...props } = input;
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      <path
        d={paths[name]}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

const paths: Record<IconName, string> = {
  archive: "M4 8h16M5 8v11h14V8M3.5 4h17v4h-17zM9.5 12h5",
  check: "m5 12 4.25 4.25L19 6.5",
  "chevron-down": "m7 9 5 5 5-5",
  close: "M6 6l12 12M18 6 6 18",
  connection: "M8.5 15.5a5 5 0 0 1 7 0M5.5 12.5a9 9 0 0 1 13 0M12 19h.01",
  danger: "M12 3 2.8 20h18.4L12 3Zm0 6v5m0 3h.01",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  outline: "M4 6h.01M8 6h12M4 12h.01M8 12h12M4 18h.01M8 18h12",
  queue: "M5 6h14M5 12h14M5 18h9",
  refresh:
    "M20 7v5h-5M4 17v-5h5M6.1 9A7 7 0 0 1 18 6l2 6M18 15a7 7 0 0 1-11.9 3L4 12",
  send: "m4 4 16 8-16 8 3-8-3-8Zm3 8h13",
  settings:
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-3.5a7.5 7.5 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2.1-1.2L14.5 3h-5l-.4 2.6A8 8 0 0 0 7 6.8l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2.1 1.2l.4 2.6h5l.4-2.6a8 8 0 0 0 2.1-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
  stop: "M7 7h10v10H7z",
  task: "M7 3h10l4 4v14H3V3h4Zm2 6h6M8 13h8M8 17h5",
  terminal: "m5 7 4 5-4 5m7 0h7",
  trash: "M4 7h16M9 3h6l1 4H8l1-4Zm-3 4 1 14h10l1-14M10 11v6m4-6v6",
  workspace: "M3 6.5h7l2 2h9V20H3V6.5Zm0 3h18",
};
