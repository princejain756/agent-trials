import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync("test/slug.test.mjs")) {
  console.error("missing test/slug.test.mjs");
  process.exit(1);
}
execFileSync(process.execPath, ["test/slug.test.mjs"], { stdio: "inherit" });
console.log("ok");
