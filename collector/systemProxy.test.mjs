import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { bypassed, modelFetch, parseMacProxy, parseWindowsProxy } from "./systemProxy.mjs";

const WINDOWS = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7897
    ProxyOverride    REG_SZ    localhost;127.*;192.168.*;*.lan;<local>
`;

const MAC = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
    2 : example.cn
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
}`;

describe("system proxy settings", () => {
  it("reads the Windows proxy only when it is switched on, preferring the https entry", () => {
    expect(parseWindowsProxy(WINDOWS)).toEqual({ url: "http://127.0.0.1:7897", bypass: ["localhost", "127.*", "192.168.*", "*.lan", "<local>"] });
    expect(parseWindowsProxy(WINDOWS.replace("0x1", "0x0"))).toBeNull();
    expect(parseWindowsProxy(WINDOWS.replace("127.0.0.1:7897", "http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080")).url).toBe("http://127.0.0.1:8443");
    expect(parseWindowsProxy(WINDOWS.replace("127.0.0.1:7897", "socks=127.0.0.1:1080"))).toBeNull();
    expect(parseWindowsProxy("")).toBeNull();
  });

  it("reads the macOS https proxy and its exceptions", () => {
    expect(parseMacProxy(MAC)).toEqual({ url: "http://127.0.0.1:7890", bypass: ["127.0.0.1", "*.local", "example.cn"] });
    expect(parseMacProxy(MAC.replace("HTTPSEnable : 1", "HTTPSEnable : 0"))).toBeNull();
  });

  it("keeps local and excepted hosts off the proxy", () => {
    const rules = ["127.*", "*.lan", "<local>", "example.cn", ".corp.com"];
    for (const host of ["localhost", "127.0.0.1", "[::1]", "10.1.2.3", "192.168.1.5", "172.20.0.1", "nas.local", "box.lan", "intranet", "example.cn", "api.example.cn", "a.corp.com"]) {
      expect(bypassed(host, rules), host).toBe(true);
    }
    for (const host of ["api.huiliu.one", "ark.cn-beijing.volces.com", "notexample.cn", "172.32.0.1"]) {
      expect(bypassed(host, rules), host).toBe(false);
    }
  });
});

describe.runIf(typeof http.setGlobalProxyFromEnv === "function")("model requests through the proxy", () => {
  const saved = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
  const servers = [];
  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    for (const server of servers.splice(0)) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  const listen = async (server) => {
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server.address().port;
  };

  it("sends model requests through the proxy without touching the process-wide fetch settings", async () => {
    const model = http.createServer((request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ path: request.url })));
    const modelPort = await listen(model);
    // 代理收到 CONNECT 就把隧道接到本地的假模型服务上，记下要连的地址
    const tunnels = [];
    const proxy = http.createServer((_request, response) => response.writeHead(405).end());
    proxy.on("connect", (request, socket, head) => {
      tunnels.push(request.url);
      const upstream = net.connect(modelPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(socket).pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    await (await fetch(`http://127.0.0.1:${modelPort}/warm`)).text();  // 先让进程默认的 dispatcher 建出来，下面好比较
    const before = globalThis[Symbol.for("undici.globalDispatcher.1")];
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;

    const response = await modelFetch("http://model.test/v1/chat/completions", { method: "POST", body: "{}" });
    expect(await response.json()).toEqual({ path: "/v1/chat/completions" });
    expect(tunnels).toEqual(["model.test:80"]);
    expect(globalThis[Symbol.for("undici.globalDispatcher.1")]).toBe(before);
  });
});
