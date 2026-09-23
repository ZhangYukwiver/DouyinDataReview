import path from "node:path";

export function isSameOriginUrl(value, appUrl) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

export function isStoryUrl(value, appUrl) {
  if (!isSameOriginUrl(value, appUrl)) return false;
  try {
    const pathname = new URL(value).pathname;
    // Match the static server's decoded Windows paths, including encoded separators.
    const normalizedPath = path.posix.normalize(decodeURIComponent(pathname).replaceAll("\\", "/"));
    return pathname.startsWith("/story/") && normalizedPath.startsWith("/story/");
  } catch {
    return false;
  }
}
