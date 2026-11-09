/**
 * Adversarial Prompt Injection Defense Shield
 * Protects autonomous seller agents against prompt injections, jailbreaks,
 * and social-engineering attacks embedded in untrusted buyer dispute messages.
 */

export type AttackCategory =
  | 'DIRECT_OVERRIDE'
  | 'DELIMITER_INJECTION'
  | 'JAILBREAK_PERSONA'
  | 'AUTHORITY_IMPERSONATION'
  | 'ACTION_FORCING';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface GuardAnalysisResult {
  isInjected: boolean;
  riskScore: number; // 0.0 to 1.0
  riskLevel: RiskLevel;
  attackCategories: AttackCategory[];
  matchedPatterns: string[];
  sanitizedMessage: string;
  actionAllowed: boolean;
  explanation: string;
}

interface PatternRule {
  category: AttackCategory;
  pattern: RegExp;
  weight: number;
  description: string;
}

const INJECTION_RULES: PatternRule[] = [
  // 1. Direct instruction overrides
  {
    category: 'DIRECT_OVERRIDE',
    pattern: /(override|bypass|ignore|cancel)\s+(all\s+|any\s+|the\s+)?((previous|prior|above|earlier|safety)\s+)?(instructions|prompts|directions|rules|guidelines)/i,
    weight: 0.9,
    description: 'Directive to override or bypass instructions'
  },
  {
    category: 'DIRECT_OVERRIDE',
    pattern: /(system|admin|developer)\s+(instruction|prompt|directive)s?[:\s]+/i,
    weight: 0.85,
    description: 'System instruction directive prefix'
  },
  {
    category: 'DIRECT_OVERRIDE',
    pattern: /disregard\s+(all\s+)?(earlier|prior|previous)\s+(rules|prompts|guidelines)/i,
    weight: 0.85,
    description: 'Directive to disregard earlier guidelines'
  },
  {
    category: 'DIRECT_OVERRIDE',
    pattern: /(forget|delete|erase)\s+(your\s+)?(system\s+prompt|context|memory)/i,
    weight: 0.8,
    description: 'System prompt erasure directive'
  },
  {
    category: 'DIRECT_OVERRIDE',
    pattern: /system\s+override[:\s]+/i,
    weight: 0.85,
    description: 'System override directive prefix'
  },

  // 2. Delimiter injections
  {
    category: 'DELIMITER_INJECTION',
    pattern: /<\/?(system|prompt|instruction|assistant|developer)[^>]*>/i,
    weight: 0.9,
    description: 'Fake XML/HTML system or role delimiter tag'
  },
  {
    category: 'DELIMITER_INJECTION',
    pattern: /\[(SYSTEM|ADMIN|PROMPT|ROOT|DEVELOPER)\]/i,
    weight: 0.8,
    description: 'Bracketed privileged role indicator'
  },
  {
    category: 'DELIMITER_INJECTION',
    pattern: /---+(BEGIN|START)\s+(SYSTEM|PROMPT|ADMIN|INSTRUCTIONS)---+/i,
    weight: 0.9,
    description: 'Fenced system instruction block delimiter'
  },
  {
    category: 'DELIMITER_INJECTION',
    pattern: /role\s*:\s*["']?(system|assistant|admin)["']?/i,
    weight: 0.85,
    description: 'Raw role header injection'
  },

  // 3. Jailbreak persona & DAN mode
  {
    category: 'JAILBREAK_PERSONA',
    pattern: /\b(DAN\s+mode|jailbroken|unrestricted\s+mode|developer\s+mode\s+enabled)\b/i,
    weight: 0.9,
    description: 'Classic persona jailbreak directive ("DAN mode")'
  },
  {
    category: 'JAILBREAK_PERSONA',
    pattern: /you\s+are\s+no\s+longer\s+(an?\s+)?(ai|agent|assistant)/i,
    weight: 0.75,
    description: 'Persona dissolution directive'
  },

  // 4. Authority impersonation
  {
    category: 'AUTHORITY_IMPERSONATION',
    pattern: /i\s+am\s+(a\s+)?(paypal\s+(admin|staff|investigator|auditor)|compliance\s+officer)/i,
    weight: 0.85,
    description: 'Impersonation of PayPal staff or compliance auditor'
  },
  {
    category: 'AUTHORITY_IMPERSONATION',
    pattern: /(court\s+order|legal\s+mandate|subpoena)\s+compels?\s+immediate\s+refund/i,
    weight: 0.75,
    description: 'Fraudulent legal authority / court mandate claim'
  },

  // 5. Action forcing
  {
    category: 'ACTION_FORCING',
    pattern: /(immediately|instantly|now)\s+(grant|issue|send|wire)\s+(full\s+)?refund\s+without\s+checking/i,
    weight: 0.8,
    description: 'Forced concession directive demanding unverified refund'
  },
  {
    category: 'ACTION_FORCING',
    pattern: /override\s+seller\s+protection\s+and\s+release\s+payout/i,
    weight: 0.85,
    description: 'Direct command to bypass seller protection policies'
  }
];

/**
 * Sanitizes an untrusted message string by neutralizing delimiters and control characters.
 */
export function sanitizeUntrustedMessage(raw: string): string {
  return raw
    .replace(/<\/?(system|prompt|instruction|assistant|developer)[^>]*>/gi, '[REDACTED_DELIMITER]')
    .replace(/\[(SYSTEM|ADMIN|PROMPT|ROOT|DEVELOPER)\]/gi, '[REDACTED_ROLE]')
    .replace(/---+(BEGIN|START)\s+(SYSTEM|PROMPT|ADMIN|INSTRUCTIONS)---+/gi, '[REDACTED_BOUNDARY]')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Strip control chars
    .trim();
}

/**
 * Evaluates an incoming message for adversarial prompt injection.
 */
export function analyzePromptInjection(message: string): GuardAnalysisResult {
  const matchedPatterns: string[] = [];
  const categoriesSet = new Set<AttackCategory>();
  let totalScore = 0;

  for (const rule of INJECTION_RULES) {
    if (rule.pattern.test(message)) {
      matchedPatterns.push(rule.description);
      categoriesSet.add(rule.category);
      totalScore += rule.weight;
    }
  }

  // Normalize risk score to [0.0, 1.0]
  const riskScore = Math.min(1.0, Number(totalScore.toFixed(2)));
  const isInjected = matchedPatterns.length > 0;

  let riskLevel: RiskLevel = 'LOW';
  if (riskScore >= 0.8) {
    riskLevel = 'CRITICAL';
  } else if (riskScore >= 0.5) {
    riskLevel = 'HIGH';
  } else if (riskScore >= 0.25) {
    riskLevel = 'MEDIUM';
  }

  // Automated concessions (refunds / settlement payments) are BLOCKED if risk is HIGH or CRITICAL
  const actionAllowed = riskLevel !== 'CRITICAL' && riskLevel !== 'HIGH';

  let explanation = 'Message passed security scan; no prompt injection directives detected.';
  if (isInjected) {
    explanation = `Adversarial prompt injection detected (${riskLevel} risk, score ${riskScore}). Matches: ${matchedPatterns.join('; ')}. Autonomous concessions blocked.`;
  }

  const sanitizedMessage = sanitizeUntrustedMessage(message);

  return {
    isInjected,
    riskScore,
    riskLevel,
    attackCategories: Array.from(categoriesSet),
    matchedPatterns,
    sanitizedMessage,
    actionAllowed,
    explanation
  };
}
