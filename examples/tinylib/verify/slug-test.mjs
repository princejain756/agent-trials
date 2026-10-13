// The task asks the agent to write test/slug.test.mjs with at least 3 cases
// covering spaces, mixed case, and punctuation. This checker verifies the agent
// fulfilled that, and it does not accept the agent's own file as evidence:
// it runs the agent's test, checks the file actually asserts something, then
// independently asserts slugify's behavior against the agent's lib.js.
//
// An earlier version only ran the agent's file and checked its exit code, so a
// file containing nothing but `console.log("ok")` scored a pass while the
// deliverable the task asked for was never written.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { slugify } from "../lib.js";

const TEST_FILE = "test/slug.test.mjs";
if (!existsSync(TEST_FILE)) {
  console.error(`missing ${TEST_FILE}`);
  process.exit(1);
}

// The test must actually assert, not just print. `assert` is the contract the
// prompt names; a file with no assertion cannot fail and so proves nothing.
const source = readFileSync(TEST_FILE, "utf-8");
const assertions = source.match(/\bassert\s*[.(]/g) ?? [];
if (assertions.length < 3) {
  console.error(
    `${TEST_FILE} has ${assertions.length} assertion(s); the task asks for at least 3`,
  );
  process.exit(1);
}

// Run the agent's test so a test that genuinely fails is caught.
execFileSync(process.execPath, [TEST_FILE], { stdio: "inherit" });

// Independent assertions against the agent's lib.js. A broken slugify fails
// here even when the agent's own test file passes.
assert.equal(slugify("Hello World"), "hello-world", "spaces");
assert.equal(slugify("  Mixed CASE  "), "mixed-case", "trim and case");
assert.equal(slugify("a!!!b??c"), "a-b-c", "punctuation");
assert.equal(slugify("already-slug"), "already-slug", "existing separators kept");
assert.equal(slugify(""), "", "empty input");
assert.equal(slugify("--x--"), "x", "leading and trailing separators dropped");

console.log("ok");
