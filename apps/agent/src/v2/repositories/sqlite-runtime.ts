import { createRequire } from "node:module";

import initSqlJs, { type SqlJsStatic } from "sql.js";

const require = createRequire(import.meta.url);
let sqlModule: Promise<SqlJsStatic> | undefined;

export function loadSqliteRuntime(): Promise<SqlJsStatic> {
  sqlModule ??= initSqlJs({
    locateFile: (file) =>
      file.endsWith(".wasm")
        ? require.resolve("sql.js/dist/sql-wasm.wasm")
        : file,
  });
  return sqlModule;
}
