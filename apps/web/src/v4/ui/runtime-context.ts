import { createContext, useContext } from "react";

import type { AdminWebRuntime } from "../admin-runtime.js";
import type { UserWebRuntime } from "../runtime.js";

export const RuntimeContext = createContext<UserWebRuntime | undefined>(
  undefined,
);
export const AdminRuntimeContext = createContext<AdminWebRuntime | undefined>(
  undefined,
);

export function useRuntime(): UserWebRuntime {
  const runtime = useContext(RuntimeContext);
  if (runtime === undefined) throw new Error("User Web runtime is unavailable");
  return runtime;
}

export function useAdminRuntime(): AdminWebRuntime {
  const runtime = useContext(AdminRuntimeContext);
  if (runtime === undefined) {
    throw new Error("Administrator Web runtime is unavailable");
  }
  return runtime;
}
