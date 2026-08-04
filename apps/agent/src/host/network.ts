import { delimiter, join } from "node:path";

export type CodexNetworkConfig =
  | { mode: "direct" }
  | {
      mode: "proxy";
      httpsProxy: string;
      httpProxy?: string;
      allProxy?: string;
      noProxy?: string;
      caCertificate?: string;
    };

const PROXY_ENVIRONMENT_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "CODEX_CA_CERTIFICATE",
] as const;

export function validateCodexNetworkConfig(
  value: unknown,
): value is CodexNetworkConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  if (config.mode === "direct") return true;
  return (
    config.mode === "proxy" &&
    isProxyUrl(config.httpsProxy, new Set(["http:", "https:"])) &&
    (config.httpProxy === undefined ||
      isProxyUrl(config.httpProxy, new Set(["http:", "https:"]))) &&
    (config.allProxy === undefined ||
      isProxyUrl(
        config.allProxy,
        new Set(["http:", "https:", "socks5:", "socks5h:"]),
      )) &&
    (config.noProxy === undefined || isSafeSingleLine(config.noProxy)) &&
    (config.caCertificate === undefined ||
      (isSafeSingleLine(config.caCertificate) &&
        config.caCertificate.startsWith("/")))
  );
}

export function codexProcessEnvironment(
  network: CodexNetworkConfig | undefined,
  options: { base?: NodeJS.ProcessEnv; userHome?: string } = {},
): NodeJS.ProcessEnv {
  const environment = { ...(options.base ?? process.env) };
  for (const key of PROXY_ENVIRONMENT_KEYS) delete environment[key];
  const userHome = options.userHome;
  if (userHome) {
    const localBin = join(userHome, ".local", "bin");
    environment.PATH = environment.PATH
      ? `${localBin}${delimiter}${environment.PATH}`
      : localBin;
  }
  if (!network || network.mode === "direct") return environment;
  setBothCases(environment, "HTTPS_PROXY", network.httpsProxy);
  setBothCases(
    environment,
    "HTTP_PROXY",
    network.httpProxy ?? network.httpsProxy,
  );
  if (network.allProxy)
    setBothCases(environment, "ALL_PROXY", network.allProxy);
  const noProxy = mergeNoProxy(network.noProxy);
  setBothCases(environment, "NO_PROXY", noProxy);
  if (network.caCertificate)
    environment.CODEX_CA_CERTIFICATE = network.caCertificate;
  return environment;
}

export function createProxyNetworkConfig(options: {
  httpsProxy: string;
  httpProxy?: string;
  allProxy?: string;
  noProxy?: string;
  caCertificate?: string;
}): CodexNetworkConfig {
  const config: CodexNetworkConfig = { mode: "proxy", ...options };
  if (!validateCodexNetworkConfig(config))
    throw new Error("Invalid Codex proxy configuration");
  return config;
}

function isProxyUrl(value: unknown, protocols: Set<string>): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return protocols.has(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isSafeSingleLine(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    !value.includes("\n") &&
    !value.includes("\r") &&
    !value.includes("\0")
  );
}

function mergeNoProxy(value: string | undefined): string {
  const entries = new Set(
    ["127.0.0.1", "localhost", "::1", ...(value?.split(",") ?? [])]
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  return [...entries].join(",");
}

function setBothCases(
  environment: NodeJS.ProcessEnv,
  key: "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" | "NO_PROXY",
  value: string,
): void {
  environment[key] = value;
  environment[key.toLowerCase()] = value;
}
