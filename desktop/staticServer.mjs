import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

// The story pages under /story are self-contained prototype HTML: inline scripts, inline styles and Google Fonts.
const STORY_CSP = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'self'; img-src 'self' data: https:; media-src 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com";

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self' http://127.0.0.1:* http://localhost:*; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'none'; img-src 'self' data: https:; media-src 'self' https: blob: http://127.0.0.1:* http://localhost:*; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function resolveAssetPath(rootDirectory, pathname) {
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const resolvedPath = path.resolve(rootDirectory, relativePath);
  const rootPrefix = `${path.resolve(rootDirectory)}${path.sep}`;
  return resolvedPath === path.resolve(rootDirectory) || resolvedPath.startsWith(rootPrefix)
    ? resolvedPath
    : null;
}

function send(response, statusCode, headers, body, headOnly) {
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    ...headers,
    "Content-Length": body.length,
  });
  response.end(headOnly ? undefined : body);
}

export async function startStaticServer({ rootDirectory, host = "127.0.0.1", port = 0 }) {
  const absoluteRoot = path.resolve(rootDirectory);
  const indexPath = path.join(absoluteRoot, "index.html");
  const indexBody = await readFile(indexPath);

  const server = createServer(async (request, response) => {
    const headOnly = request.method === "HEAD";
    if (request.method !== "GET" && !headOnly) {
      send(response, 405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }, Buffer.from("Method Not Allowed"), headOnly);
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`).pathname;
    } catch {
      send(response, 400, { "Content-Type": "text/plain; charset=utf-8" }, Buffer.from("Bad Request"), headOnly);
      return;
    }

    let assetPath;
    try {
      assetPath = resolveAssetPath(absoluteRoot, pathname);
    } catch {
      send(response, 400, { "Content-Type": "text/plain; charset=utf-8" }, Buffer.from("Bad Request"), headOnly);
      return;
    }
    if (!assetPath) {
      send(response, 403, { "Content-Type": "text/plain; charset=utf-8" }, Buffer.from("Forbidden"), headOnly);
      return;
    }

    try {
      const details = await stat(assetPath);
      if (!details.isFile()) throw Object.assign(new Error("not_file"), { code: "ENOENT" });
      const body = await readFile(assetPath);
      const contentType = CONTENT_TYPES.get(path.extname(assetPath).toLowerCase()) ?? "application/octet-stream";
      const story = pathname.startsWith("/story/");
      const cacheControl = story || path.basename(assetPath) === "index.html"
        ? "no-cache"
        : "public, max-age=31536000, immutable";
      send(response, 200, { "Cache-Control": cacheControl, "Content-Type": contentType, ...(story && { "Content-Security-Policy": STORY_CSP }) }, body, headOnly);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        send(response, 500, { "Content-Type": "text/plain; charset=utf-8" }, Buffer.from("Internal Server Error"), headOnly);
        return;
      }
      const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
      if (acceptsHtml) {
        send(response, 200, { "Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8" }, indexBody, headOnly);
      } else {
        send(response, 404, { "Content-Type": "text/plain; charset=utf-8" }, Buffer.from("Not Found"), headOnly);
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Static server did not expose a TCP port.");
  let closed = false;
  return {
    url: `http://${host}:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
