// ponytail: no Apple Developer ID on this machine, so electron-builder skips signing entirely.
// Ad-hoc sign the packed bundle so its seal is consistent; recipients still need `xattr -cr` (no notarization).
const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async ({ appOutDir, electronPlatformName, packager }) => {
  if (electronPlatformName !== "darwin") return;
  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
