#!/usr/bin/env node
/** Unit test: keyboard-interactive prompt classification for 2FA. */
import { answerPrompts, formatAuthFailure, isVerificationPrompt, promptText } from "../lib/core/auth.js";

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

// prompt extraction + answer mapping
const promptCases = [
  [{ prompt: "Password:" }, "Password:"],
  ["Verification code: ", "Verification code: "],
];
for (const [raw, expected] of promptCases) {
  const actual = promptText(raw);
  if (actual !== expected) {
    failed += 1;
    console.log(`FAIL  promptText(${JSON.stringify(raw)}) => ${JSON.stringify(actual)}`);
  }
}

const mappings = [
  [["Password:", "Verification code:"], { secret: "pw", code: "123456" }, ["pw", "123456"], true],
  [["Password:"], { secret: "pw" }, ["pw"], false],
  [["Verification code:"], { secret: "pw" }, ["pw"], true],
  [["请输入动态码:", "密码:"], { secret: "pw", code: "654321" }, ["654321", "pw"], true],
];
for (const [prompts, options, expected, expectedCode] of mappings) {
  const result = answerPrompts(prompts, options);
  const ok = JSON.stringify(result.answers) === JSON.stringify(expected) && result.sawCodePrompt === expectedCode;
  if (!ok) {
    failed += 1;
    console.log(`FAIL  answerPrompts(${JSON.stringify(prompts)}) => ${JSON.stringify(result)}`);
  }
}

const failureText = formatAuthFailure({
  serverId: "srv",
  host: "h",
  port: 22,
  message: "All configured authentication methods failed",
  promptsSeen: ["Password:", "Verification code:"],
  codeProvided: false,
  sawCodePrompt: true,
});
if (!failureText.includes("Verification code:") || !failureText.includes("server_connect")) {
  failed += 1;
  console.log("FAIL  formatAuthFailure lost diagnostics/hint");
}

const total = cases.length + promptCases.length + mappings.length + 1;
console.log(`
${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
