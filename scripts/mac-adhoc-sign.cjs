// ponytail: no Apple Developer ID on this machine, so electron-builder skips signing entirely.
// Ad-hoc sign the packed bundle so its seal is consistent; recipients still need `xattr -cr` (no notarization).
const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async ({ appOutDir, electronPlatformName, packager }) => {
  if (electronPlatformName !== "darwin") return;
  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  // The signer files are installed read-only (0400) in .local-data; shipped copies must be 0644 or
  // recipients' `xattr -cr` fails with Permission denied on them.
  execFileSync("/bin/chmod", ["-R", "u+w,a+r", path.join(appPath, "Contents", "Resources", "direct-signer")]);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
