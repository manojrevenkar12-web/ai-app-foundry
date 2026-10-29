/**
 * Secrets in an app are a leak the moment the bundle is stored or reviewed. Known formats block;
 * long random-looking strings warn, because ids and hashes look the same.
 */
import { block, type Finding, warn } from "./findings.js";

const KNOWN: Array<[string, RegExp]> = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["GitHub token", /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]{60,}/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Azure storage key", /AccountKey=[A-Za-z0-9+/=]{40,}/],
  ["Azure connection string", /(?:Endpoint|DefaultEndpointsProtocol)=[^;\s]+;[^"'`\s]*(?:SharedAccessKey|AccountKey)=/i],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["database URL with password", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:[^@\s]{3,}@/i],
  ["SQL Server connection string", /(?:Password|Pwd)\s*=\s*[^;"'\s]{4,}\s*;/i],
];

const entropy = (s: string) => {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
};

export const scanSecrets = (where: string, text: string): Finding[] => {
  const out: Finding[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const [name, re] of KNOWN) {
      const m = re.exec(line);
      if (m)
        out.push(
          block("secret.known", `${name} in ${where}; secrets belong in the platform's vault, never in an app`, {
            at: where,
            line: i + 1,
            column: m.index + 1,
          }),
        );
    }
    for (const m of line.matchAll(/["'`]([A-Za-z0-9+/_=-]{32,})["'`]/g)) {
      const s = m[1] as string;
      if (/^[a-f0-9]+$/i.test(s) && (s.length === 40 || s.length === 64)) continue; // commit or content hashes
      if (entropy(s) > 4.5)
        out.push(
          warn("secret.entropy", `a long random-looking string in ${where}; if it is a credential, remove it`, {
            at: where,
            line: i + 1,
            column: (m.index ?? 0) + 1,
          }),
        );
    }
  });
  return out;
};
