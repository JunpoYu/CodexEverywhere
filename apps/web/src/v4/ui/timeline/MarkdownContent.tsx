import { useEffect, useRef } from "react";

import "katex/dist/katex.min.css";

export default function MarkdownContent(input: { readonly text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    void import("../../../code-renderer.js").then(
      ({ renderMessageContent }) => {
        if (current && ref.current !== null)
          renderMessageContent(ref.current, input.text);
      },
    );
    return () => {
      current = false;
    };
  }, [input.text]);
  return <div className="markdown-content" ref={ref} />;
}
