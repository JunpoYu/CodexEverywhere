export type WebLoginMethod = "passkey" | "password" | "recovery";
export type DevicePersistenceMode = "temporary" | "existing" | "new";

export function rememberDeviceForLogin(
  method: WebLoginMethod,
  options: { alternativeLoginOpen: boolean; checkboxChecked: boolean },
): boolean {
  if (method === "passkey" && !options.alternativeLoginOpen) return true;
  return options.checkboxChecked;
}

export function devicePersistenceMode(
  rememberDevice: boolean,
  existingDeviceName?: string,
): DevicePersistenceMode {
  if (!rememberDevice) return "temporary";
  return existingDeviceName?.trim() ? "existing" : "new";
}
