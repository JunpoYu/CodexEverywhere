export type WebLoginMethod = "passkey" | "password" | "recovery";

export function rememberDeviceForLogin(
  method: WebLoginMethod,
  options: { alternativeLoginOpen: boolean; checkboxChecked: boolean },
): boolean {
  if (method === "passkey" && !options.alternativeLoginOpen) return true;
  return options.checkboxChecked;
}
