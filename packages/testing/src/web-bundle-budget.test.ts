import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const checker = resolve(
  import.meta.dirname,
  "../../../scripts/check-web-bundle-budget.mjs",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Web bundle budget checker", () => {
  it("counts initial assets and accepts the expected lazy boundaries", async () => {
    const directory = await createBundleFixture();

    const { stdout } = await execFileAsync(process.execPath, [
      checker,
      "--",
      "--dist",
      directory,
      "--json",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      version: 1,
      initialJsFiles: ["assets/bootstrap.js", "assets/entry.js"],
      initialCssFiles: ["assets/base.css"],
    });
  });

  it("fails when the initial JavaScript exceeds its gzip budget", async () => {
    const directory = await createBundleFixture();

    await expect(
      execFileAsync(process.execPath, [
        checker,
        "--dist",
        directory,
        "--js-kib",
        "0",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Initial user-route JS"),
    });
  });

  it("fails when Markdown becomes a static initial import", async () => {
    const directory = await createBundleFixture({ markdownIsInitial: true });

    await expect(
      execFileAsync(process.execPath, [checker, "--dist", directory]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("remaining lazy"),
    });
  });

  it("rejects manifest assets outside the Web dist directory", async () => {
    const directory = await createBundleFixture({ entryFile: "../outside.js" });

    await expect(
      execFileAsync(process.execPath, [checker, "--dist", directory]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("escapes the Web dist directory"),
    });
  });
});

async function createBundleFixture(
  options: {
    readonly entryFile?: string;
    readonly markdownIsInitial?: boolean;
  } = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ce-web-budget-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "assets"));
  await Promise.all([
    writeFile(join(directory, "assets/entry.js"), "import('./bootstrap.js')"),
    writeFile(join(directory, "assets/bootstrap.js"), "export const app = 1"),
    writeFile(join(directory, "assets/base.css"), ":root{color:#123}"),
    writeFile(
      join(directory, "assets/markdown.js"),
      "export const markdown = 1",
    ),
    writeFile(
      join(directory, "assets/markdown.css"),
      ".markdown{display:block}",
    ),
    writeFile(join(directory, "assets/code.js"), "export const code = 1"),
  ]);
  const bootstrapImports = options.markdownIsInitial
    ? ["index.html", "src/v4/ui/timeline/MarkdownContent.tsx"]
    : ["index.html"];
  await writeFile(
    join(directory, "asset-manifest.json"),
    JSON.stringify({
      "index.html": {
        file: options.entryFile ?? "assets/entry.js",
        isEntry: true,
        dynamicImports: ["_bootstrap.js"],
      },
      "_bootstrap.js": {
        file: "assets/bootstrap.js",
        name: "bootstrap",
        isDynamicEntry: true,
        imports: bootstrapImports,
        dynamicImports: ["src/v4/ui/timeline/MarkdownContent.tsx"],
        css: ["assets/base.css"],
      },
      "src/v4/ui/timeline/MarkdownContent.tsx": {
        file: "assets/markdown.js",
        src: "src/v4/ui/timeline/MarkdownContent.tsx",
        isDynamicEntry: true,
        dynamicImports: ["src/code-renderer.ts"],
        css: ["assets/markdown.css"],
      },
      "src/code-renderer.ts": {
        file: "assets/code.js",
        src: "src/code-renderer.ts",
        isDynamicEntry: true,
      },
    }),
  );
  return directory;
}
