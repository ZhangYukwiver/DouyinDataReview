// ponytail: no Apple Developer ID on this machine, so electron-builder skips signing entirely.
// Ad-hoc sign the packed bundle so its seal is consistent; recipients still need `xattr -cr` (no notarization).
const { execFileSync } = require("node:child_process");
const { accessSync } = require("node:fs");
const path = require("node:path");

module.exports = async ({ appOutDir, electronPlatformName, packager }) => {
  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const mac = electronPlatformName === "darwin";
  if (mac || electronPlatformName === "win32") {
    const resources = mac ? path.join(appPath, "Contents", "Resources") : path.join(appOutDir, "resources");
    for (const tool of ["ffmpeg", "ffprobe"])
      accessSync(path.join(resources, "media-tools", mac ? "darwin-arm64" : "win32-x64", mac ? tool : tool + ".exe"));
  }
  if (!mac) return;
  // The signer files are installed read-only (0400) in .local-data; shipped copies must be 0644 or
  // recipients' `xattr -cr` fails with Permission denied on them.
  execFileSync("/bin/chmod", ["-R", "u+w,a+r", path.join(appPath, "Contents", "Resources", "direct-signer")]);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
