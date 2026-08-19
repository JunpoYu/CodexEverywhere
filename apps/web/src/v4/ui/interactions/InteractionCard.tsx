import { useState, type FormEvent } from "react";
import {
  type InteractionResponse,
  type JsonValue,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import { approvalPresentation } from "../../../session-controls.js";
import { durableMutation } from "../../gateway/durable-mutation.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { useRuntime } from "../runtime-context.js";

type Interaction = OutputOf<"interaction/list">["interactions"][number];

export function InteractionCard(input: { readonly interaction: Interaction }) {
  const runtime = useRuntime();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [mcpContent, setMcpContent] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const presentation = approvalPresentation(
    input.interaction.requestMethod,
    input.interaction.payload,
  );

  const respond = async (response: InteractionResponse) => {
    setBusy(true);
    setError(undefined);
    try {
      await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "interaction/respond",
        payload: {
          version: 1,
          threadId: input.interaction.threadId,
          interactionId: input.interaction.id,
          response,
        },
        onOutcomeUnknown: () =>
          setError("连接中断，正在确认本次响应是否已被 Codex 接收。"),
      });
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  if (input.interaction.kind === "user-question") {
    const questions = readQuestions(input.interaction.payload.questions);
    const submit = (event: FormEvent) => {
      event.preventDefault();
      void respond({
        version: 1,
        kind: "user-input",
        answers: Object.fromEntries(
          questions.map((question) => [
            question.id,
            [answers[question.id] ?? ""],
          ]),
        ),
      });
    };
    return (
      <form
        aria-busy={busy}
        className="interaction-card interaction-form"
        onSubmit={submit}
      >
        <div>
          <strong>Codex 需要你的输入</strong>
          {questions.map((question) => (
            <label key={question.id}>
              <span>{question.header}</span>
              <small>{question.question}</small>
              {question.options === undefined ? (
                <input
                  required
                  type={question.secret ? "password" : "text"}
                  value={answers[question.id] ?? ""}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: event.target.value,
                    }))
                  }
                />
              ) : (
                <select
                  required
                  value={answers[question.id] ?? ""}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: event.target.value,
                    }))
                  }
                >
                  <option value="">请选择…</option>
                  {question.options.map((option) => (
                    <option key={option.label} value={option.label}>
                      {option.label} — {option.description}
                    </option>
                  ))}
                </select>
              )}
            </label>
          ))}
          {error === undefined ? null : (
            <StatusMessage tone="error">{error}</StatusMessage>
          )}
        </div>
        <button className="primary" disabled={busy} type="submit">
          {busy ? "正在提交…" : "提交回答"}
        </button>
      </form>
    );
  }

  if (input.interaction.kind === "mcp-elicitation") {
    const url = safeHttpUrl(input.interaction.payload.url);
    const accept = () => {
      let content: JsonValue | undefined;
      try {
        if (mcpContent.trim().length > 0) {
          content = JSON.parse(mcpContent) as JsonValue;
        }
      } catch {
        setError("请输入有效的 JSON 对象");
        return;
      }
      void respond({
        version: 1,
        kind: "mcp-elicitation",
        action: "accept",
        ...(content === undefined ? {} : { content }),
      });
    };
    return (
      <div aria-busy={busy} className="interaction-card interaction-form">
        <div>
          <strong>{presentation.title}</strong>
          <p>{presentation.summary}</p>
          {url === undefined ? (
            <label>
              <span>返回给 MCP 的结构化内容</span>
              <textarea
                rows={3}
                spellCheck={false}
                value={mcpContent}
                onChange={(event) => setMcpContent(event.target.value)}
              />
            </label>
          ) : (
            <a href={url} rel="noreferrer" target="_blank">
              打开 MCP 授权页面
            </a>
          )}
          {error === undefined ? null : (
            <StatusMessage tone="error">{error}</StatusMessage>
          )}
        </div>
        <div>
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void respond({
                version: 1,
                kind: "mcp-elicitation",
                action: "decline",
              })
            }
          >
            {busy ? "处理中…" : "拒绝"}
          </button>
          <button
            className="primary"
            disabled={busy}
            type="button"
            onClick={accept}
          >
            {busy ? "处理中…" : "允许"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div aria-busy={busy} className="interaction-card">
      <div>
        <strong>{presentation.title}</strong>
        <p>{presentation.summary}</p>
        {presentation.code === undefined ? null : (
          <code>{presentation.code}</code>
        )}
        {presentation.meta.map((line) => (
          <small key={line}>{line}</small>
        ))}
        {error === undefined ? null : (
          <StatusMessage tone="error">{error}</StatusMessage>
        )}
      </div>
      <div>
        <button
          disabled={busy}
          type="button"
          onClick={() =>
            void respond({
              version: 1,
              kind: "approval",
              decision: "decline",
            })
          }
        >
          {busy ? "处理中…" : "拒绝"}
        </button>
        <button
          className="primary"
          disabled={busy}
          type="button"
          onClick={() =>
            void respond({
              version: 1,
              kind: "approval",
              decision: "accept",
            })
          }
        >
          {busy ? "处理中…" : "允许"}
        </button>
      </div>
    </div>
  );
}

function readQuestions(value: JsonValue | undefined): Array<{
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly secret: boolean;
  readonly options?: readonly {
    readonly label: string;
    readonly description: string;
  }[];
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      return [];
    const question = entry as Record<string, JsonValue>;
    if (
      typeof question.id !== "string" ||
      typeof question.header !== "string" ||
      typeof question.question !== "string"
    ) {
      return [];
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((candidate) => {
          if (
            typeof candidate !== "object" ||
            candidate === null ||
            Array.isArray(candidate)
          ) {
            return [];
          }
          const option = candidate as Record<string, JsonValue>;
          return typeof option.label === "string" &&
            typeof option.description === "string"
            ? [{ label: option.label, description: option.description }]
            : [];
        })
      : undefined;
    return [
      {
        id: question.id,
        header: question.header,
        question: question.question,
        secret: question.isSecret === true,
        ...(options === undefined ? {} : { options }),
      },
    ];
  });
}

function safeHttpUrl(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "提交失败";
}
