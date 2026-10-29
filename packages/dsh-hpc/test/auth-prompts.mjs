#!/usr/bin/env node
/** Unit test: keyboard-interactive prompt classification for 2FA. */
import { isVerificationPrompt } from "../lib/core/ssh.js";

const cases = [
  ["Verification code:", true],
  ["One-time password:", true],
  ["Enter OTP (6 digits):", true],
  ["Authenticator code: ", true],
  ["Password:", false],
  ["Password for alice:", false],
  ["Passphrase:", false],
  ["请输入动态码:", true],
  ["请输入验证码：", true],
  ["Password or passphrase:", false],
];

let failed = 0;
for (const [prompt, expected] of cases) {
  const actual = isVerificationPrompt(prompt);
  if (actual !== expected) {
    failed += 1;
    console.log(`FAIL  ${JSON.stringify(prompt)} => ${actual}, expected ${expected}`);
  } else {
    console.log(`PASS  ${JSON.stringify(prompt)} => ${actual}`);
  }
}
console.log(`
${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
