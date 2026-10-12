import assert from "node:assert/strict";
import { divide } from "../lib.js";

assert.equal(divide(6, 3), 2);
assert.throws(() => divide(1, 0), RangeError);
console.log("ok");
