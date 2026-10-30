const Module = require("node:module");
const path = require("node:path");

const runtimeArgument = process.argv[2];
const runtimeDirectory = typeof runtimeArgument === "string" && runtimeArgument
  ? path.resolve(runtimeArgument)
  : null;
const allowedBuiltins = new Set(["node:path", "path", "node:util", "util"]);
const originalLoad = Module._load;

function insideRuntime(filename) {
  if (!runtimeDirectory) return false;
  const relative = path.relative(runtimeDirectory, filename);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function restrictModuleLoading() {
  const restrictedLoad = function restrictedLoad(request, parent, isMain) {
    if (allowedBuiltins.has(request)) return originalLoad.call(this, request, parent, isMain);
    const filename = Module._resolveFilename(request, parent, isMain);
    if (!insideRuntime(filename)) throw new Error("module_not_allowed");
    return originalLoad.call(this, request, parent, isMain);
  };
  Object.defineProperty(Module, "_load", {
    configurable: false,
    enumerable: false,
    value: restrictedLoad,
    writable: false,
  });

  if (typeof process.getBuiltinModule === "function") {
    const originalGetBuiltinModule = process.getBuiltinModule.bind(process);
    Object.defineProperty(process, "getBuiltinModule", {
      configurable: false,
      enumerable: false,
      value(name) {
        if (!allowedBuiltins.has(name)) throw new Error("module_not_allowed");
        return originalGetBuiltinModule(name);
      },
      writable: false,
    });
  }
}

function permissionModelIsRestricted() {
  return Boolean(
    runtimeDirectory
    && process.permission
    && process.permission.has("fs.read", runtimeDirectory)
    && !process.permission.has("fs.write")
    && !process.permission.has("child")
    && !process.permission.has("worker"),
  );
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let result = { a_bogus: "", ok: false };
  try {
    if (!permissionModelIsRestricted()) throw new Error("permission_model_required");
    restrictModuleLoading();
    globalThis.fetch = undefined;
    globalThis.WebSocket = undefined;
    const payload = JSON.parse(input);
    const parameters = new URL(payload.url).searchParams;
    const env = require(path.join(runtimeDirectory, "bdms", "env.js"));
    env.updateUserAgent(payload.userAgent);
    env.navigator.appVersion = payload.userAgent.replace(/^Mozilla\//u, "");
    env.navigator.platform = parameters.get("browser_platform") || env.navigator.platform;
    env.navigator.language = parameters.get("browser_language") || env.navigator.language;
    env.navigator.languages = [env.navigator.language, env.navigator.language.split("-")[0]];
    env.navigator.hardwareConcurrency = Number(parameters.get("cpu_core_num")) || env.navigator.hardwareConcurrency;
    env.navigator.deviceMemory = Number(parameters.get("device_memory")) || env.navigator.deviceMemory;
    env.navigator.connection.downlink = Number(parameters.get("downlink")) || env.navigator.connection.downlink;
    env.navigator.connection.rtt = Number(parameters.get("round_trip_time")) || env.navigator.connection.rtt;
    const screenWidth = Number(parameters.get("screen_width"));
    const screenHeight = Number(parameters.get("screen_height"));
    if (screenWidth > 0 && screenHeight > 0) env.updateScreen(screenWidth, screenHeight);
    const { get_a_bogus: sign } = require(path.join(runtimeDirectory, "bdms", "index.js"));
    const method = payload.method === "POST" ? "POST" : "GET";
    const body = typeof payload.body === "string" && payload.body.length <= 4_096 ? payload.body : "";
    const aBogus = sign(payload.url, payload.uifid, method, body);
    result = { a_bogus: aBogus || "", ok: Boolean(aBogus) };
  } catch {
    // The parent process reports a fixed error and never exposes signer input.
  }
  if (global._process) global.process = global._process;
  process.stdout.write(`__SIGN_RESULT__${JSON.stringify(result)}\n`, () => process.exit(0));
});
