import { describe, expect, it } from "vitest";

import {
  codexProcessEnvironment,
  createProxyNetworkConfig,
  validateCodexNetworkConfig,
} from "./network.js";

describe("Codex network configuration", () => {
  it("applies a user proxy without leaking inherited proxy settings", () => {
    const environment = codexProcessEnvironment(
      createProxyNetworkConfig({
        httpsProxy: "http://user:secret@proxy.example:7890",
        allProxy: "socks5h://proxy.example:7891",
        noProxy: "internal.example,localhost",
        caCertificate: "/home/user/.config/ca.pem",
      }),
      {
        base: { PATH: "/usr/bin", HTTPS_PROXY: "http://old.example" },
        userHome: "/home/user",
      },
    );

    expect(environment.PATH).toBe("/home/user/.local/bin:/usr/bin");
    expect(environment.HTTPS_PROXY).toBe(
      "http://user:secret@proxy.example:7890",
    );
    expect(environment.HTTP_PROXY).toBe(environment.HTTPS_PROXY);
    expect(environment.ALL_PROXY).toBe("socks5h://proxy.example:7891");
    expect(environment.NO_PROXY).toBe(
      "127.0.0.1,localhost,::1,internal.example",
    );
    expect(environment.CODEX_CA_CERTIFICATE).toBe("/home/user/.config/ca.pem");
  });

  it("removes inherited proxy variables in direct mode", () => {
    const environment = codexProcessEnvironment(
      { mode: "direct" },
      { base: { HTTPS_PROXY: "http://old.example", PATH: "/bin" } },
    );
    expect(environment.HTTPS_PROXY).toBeUndefined();
    expect(environment.https_proxy).toBeUndefined();
  });

  it("rejects unsupported proxy protocols and multiline values", () => {
    expect(
      validateCodexNetworkConfig({
        mode: "proxy",
        httpsProxy: "file:///tmp/proxy",
      }),
    ).toBe(false);
    expect(
      validateCodexNetworkConfig({
        mode: "proxy",
        httpsProxy: "http://proxy.example",
        noProxy: "safe\ninjected",
      }),
    ).toBe(false);
  });
});
