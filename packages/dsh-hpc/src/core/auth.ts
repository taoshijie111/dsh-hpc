/**
 * Keyboard-interactive authentication helpers.
 *
 * Kept free of ssh2 and Cordis so the decision logic (which prompt gets which
 * secret, how an auth failure is explained) can be unit-tested without a live
 * SSH server. `core/ssh.ts` wires these into the real connection attempts.
 */

/** Extract the human-readable text from an ssh2 keyboard-interactive prompt. */
export function promptText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  return String((raw as { prompt?: string } | undefined)?.prompt ?? "");
}

/**
 * True when a prompt asks for a one-time verification code (2FA), as opposed to
 * a password or passphrase prompt.
 */
export function isVerificationPrompt(prompt: string): boolean {
  const codeSignal =
    /(verification|one[- ]?time|otp|authenticator|passcode|dynamic|token|code|验证码|动态码|动态|令牌)/i.test(prompt);
  // "One-time password" is a code prompt; a plain password/passphrase prompt is not.
  const passwordSignal = /password|passphrase|密码/i.test(prompt) && !/one[- ]?time/i.test(prompt);
  return codeSignal && !passwordSignal;
}

export type PromptAnswerOptions = {
  /** Stored password or key passphrase for password-like prompts. */
  secret?: string;
  /** One-time verification code supplied by the caller. */
  code?: string;
  /** Called for every prompt text, in order (used for diagnostics). */
  recordPrompt?: (prompt: string) => void;
};

/** Build one answer per prompt: verification prompts get the code, others the secret. */
export function answerPrompts(
  rawPrompts: readonly unknown[],
  options: PromptAnswerOptions,
): { answers: string[]; sawCodePrompt: boolean } {
  let sawCodePrompt = false;
  const answers = rawPrompts.map((rawPrompt) => {
    const prompt = promptText(rawPrompt);
    options.recordPrompt?.(prompt);
    if (isVerificationPrompt(prompt)) {
      sawCodePrompt = true;
      return options.code ?? options.secret ?? "";
    }
    return options.secret ?? "";
  });
  return { answers, sawCodePrompt };
}

export type AuthFailureContext = {
  serverId: string;
  host: string;
  port: number;
  message: string;
  promptsSeen: readonly string[];
  codeProvided: boolean;
  sawCodePrompt: boolean;
};

/** Render an authentication failure with the evidence needed to fix it. */
export function formatAuthFailure(context: AuthFailureContext): string {
  const prompts =
    context.promptsSeen.length > 0
      ? ` Keyboard-interactive prompts seen: ${JSON.stringify(context.promptsSeen)}.`
      : " No keyboard-interactive prompt was offered by the server.";
  const hint = context.codeProvided
    ? context.sawCodePrompt
      ? " The code was supplied but the server still rejected authentication (code may have expired or the password is wrong)."
      : " The code was supplied but no verification-code prompt appeared; the server may expect the code appended to the password."
    : ` If this server requires a one-time code, ask the user for the current 6-digit code, then call server_connect(server: "${context.serverId}", otp: "<code>").`;
  return `Connection to "${context.serverId}" (${context.host}:${context.port}) failed: ${context.message}.${prompts}${hint}`;
}
