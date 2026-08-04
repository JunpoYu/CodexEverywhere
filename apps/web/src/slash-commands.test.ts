import { describe, expect, it } from "vitest";

import {
  parseSlashCommand,
  SLASH_COMMANDS,
  slashCommandCompletion,
  slashCommandQuery,
  slashCommandSuggestions,
} from "./slash-commands.js";

describe("Codex slash commands", () => {
  it("keeps the complete Codex 0.144.1 release command set", () => {
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "model",
      "ide",
      "permissions",
      "keymap",
      "vim",
      "setup-default-sandbox",
      "sandbox-add-read-dir",
      "experimental",
      "approve",
      "memories",
      "skills",
      "import",
      "hooks",
      "review",
      "rename",
      "new",
      "archive",
      "delete",
      "resume",
      "fork",
      "app",
      "init",
      "compact",
      "plan",
      "goal",
      "agent",
      "side",
      "btw",
      "copy",
      "raw",
      "diff",
      "mention",
      "status",
      "usage",
      "debug-config",
      "title",
      "statusline",
      "theme",
      "pets",
      "mcp",
      "apps",
      "plugins",
      "logout",
      "quit",
      "exit",
      "feedback",
      "ps",
      "stop",
      "clear",
      "personality",
      "subagents",
    ]);
  });

  it("suggests commands only for a single-line leading slash", () => {
    expect(slashCommandQuery("/")).toBe("");
    expect(slashCommandSuggestions("/re").map((item) => item.name)).toEqual([
      "review",
      "rename",
      "resume",
      "sandbox-add-read-dir",
    ]);
    expect(slashCommandSuggestions("hello /re")).toEqual([]);
    expect(slashCommandSuggestions("/review\nmore")).toEqual([]);
    expect(slashCommandSuggestions("/rename new name")).toEqual([]);
  });

  it("recognizes aliases without changing their canonical action", () => {
    expect(parseSlashCommand("/pet cat")).toMatchObject({
      invokedName: "pet",
      args: "cat",
      command: { name: "pets" },
    });
    expect(parseSlashCommand("/clean")).toMatchObject({
      invokedName: "clean",
      command: { name: "stop" },
    });
  });

  it("does not accept unknown or embedded commands", () => {
    expect(parseSlashCommand("/unknown")).toBeNull();
    expect(parseSlashCommand("please /status")).toBeNull();
    expect(parseSlashCommand("/status\nextra")).toBeNull();
  });

  it("leaves the caret ready for commands that accept arguments", () => {
    const rename = SLASH_COMMANDS.find((item) => item.name === "rename")!;
    const status = SLASH_COMMANDS.find((item) => item.name === "status")!;
    expect(slashCommandCompletion(rename)).toBe("/rename ");
    expect(slashCommandCompletion(status)).toBe("/status");
  });
});
