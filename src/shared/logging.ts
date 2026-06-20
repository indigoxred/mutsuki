const TOKEN_PATTERNS: RegExp[] = [
  /(Authorization:\s*Bearer\s+)[^\s&"']+/giu,
  /(?:apiKey|apikey|access_token|refresh_token|code|client_secret)=[^&\s"']+/giu,
];

export function redactSecrets(value: unknown): string {
  let text = typeof value === "string" ? value : JSON.stringify(value);

  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, (match, prefix: string | undefined) =>
      prefix ? `${prefix}[REDACTED]` : "credential=[REDACTED]",
    );
  }

  text = text.replace(/https?:\/\/([^/@\s]+):([^/@\s]+)@/giu, (match) => {
    const protocol = match.startsWith("https") ? "https://" : "http://";
    return `${protocol}[REDACTED]:[REDACTED]@`;
  });

  return text;
}

export class MutsukiLogger {
  constructor(private readonly debugEnabled: boolean) {}

  debug(message: string, context?: unknown): void {
    if (!this.debugEnabled) return;
    console.log(
      context === undefined
        ? redactSecrets(message)
        : `${redactSecrets(message)} ${redactSecrets(context)}`,
    );
  }

  warn(message: string, context?: unknown): void {
    console.warn(
      context === undefined
        ? redactSecrets(message)
        : `${redactSecrets(message)} ${redactSecrets(context)}`,
    );
  }
}
