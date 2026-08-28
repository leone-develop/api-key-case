export type SecretFinding = {
  file: string;
  line: number;
  kind: string;
  preview: string;
};

type TokenPattern = {
  kind: string;
  regex: RegExp;
};

const TOKEN_PATTERNS: TokenPattern[] = [
  { kind: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "OpenAI-style API key", regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { kind: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { kind: "AWS access key id", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "Stripe live key", regex: /\b(?:sk|pk)_live_[A-Za-z0-9]{16,}\b/g },
  { kind: "Resend API key", regex: /\bre_[A-Za-z0-9_]{16,}\b/g },
  { kind: "Generic secret assignment", regex: /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*)\s*[:=]\s*["']([^"'\s]{12,})["']/g }
];

export function findSecretLikeTokens(file: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);

  for (const pattern of TOKEN_PATTERNS) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      pattern.regex.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(line)) !== null) {
        findings.push({
          file,
          line: index + 1,
          kind: pattern.kind,
          preview: redactFinding()
        });
      }
    }
  }

  return findings;
}

export function maskSecret(value: string): string {
  void value;
  return "***REDACTED***";
}

function redactFinding(): string {
  return "***REDACTED***";
}
