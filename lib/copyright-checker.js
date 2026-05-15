/**
 * Copyright clearance checker for PA document ingestion.
 *
 * SINGLE RULE: Does the document contain an EXPLICIT PROHIBITION against
 * being processed, treated, or analyzed by AI?
 *
 *   YES (explicit prohibition found) → 'blocked'  (HTTP 451)
 *   NO  (no explicit prohibition)    → 'clear'    (HTTP 200)
 *
 * Documents that do not explicitly forbid AI processing are treated as CLEAR.
 * The document content is never reproduced or exposed by any app — only
 * factual rules and plans extracted by the analysis agent are stored.
 *
 * Usage:
 *   const { checkCopyright } = require('./copyright-checker');
 *   const result = checkCopyright(text, filename);
 *   // result: { status, reason, legal_basis, matched_pattern, checked_chars }
 */

'use strict';

// ─── BLOCKED patterns: EXPLICIT AI PROCESSING PROHIBITIONS ──────────────────
//
// Each pattern targets a specific way a document may explicitly state that
// it must not be processed, treated, or ingested by AI systems.
//
// KEY DESIGN: Many documents (e.g. AFNOR) use the structure:
//   "X expressly objects to any [thing] ... by Artificial Intelligence"
// So patterns allow up to ~200 chars between the prohibition verb and the AI noun.
// The `s` flag (dotAll) lets `.` match newlines in extracted PDF text.
//
// ANY MATCH → BLOCKED (HTTP 451). No exceptions.

const BLOCKED_PATTERNS = [

  // ═══════════════════════════════════════════════════════════════════════════
  // AFNOR / DSM-STYLE: "expressly objects to ... Artificial Intelligence"
  // Covers: "AFNOR expressly objects to any integration, transmission or
  //          absorption ... by Artificial Intelligence (AI) engines or algorithms"
  // ═══════════════════════════════════════════════════════════════════════════
  {
    pattern: /expressly\s+objects?\s+to\b.{0,250}(?:artificial\s+intelligence|AI\s+engines?|AI\s+algorithms?|AI\s+systems?)/is,
    label: 'AFNOR-style: expressly objects to AI processing',
  },
  {
    pattern: /objects?\s+to\b.{0,250}\bby\s+(?:artificial\s+intelligence|AI\s+engines?|AI\s+algorithms?|AI\s+systems?)/is,
    label: 'Explicitly objects to processing by AI',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ENGLISH: Explicit prohibition verbs + AI keyword (flexible distance)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    // "expressly/explicitly/formally/strictly prohibits/forbids/opposes/rejects...AI"
    pattern: /(?:expressly|explicitly|formally|categorically|strictly)\s+(?:prohibits?|forbids?|bans?|opposes?|rejects?|objects?\s+to|reserves?\s+(?:the\s+right|all\s+rights)).{0,200}(?:\bAI\b|artificial\s+intelligence|machine\s+learning|LLM|generative\s+AI)/is,
    label: 'Expressly prohibits/forbids/opposes AI processing',
  },
  {
    // "AI ... is prohibited/forbidden/banned/not permitted"
    pattern: /(?:\bAI\b|artificial\s+intelligence|machine\s+learning)\b.{0,100}(?:is\s+)?(?:prohibited|forbidden|banned|not\s+(?:allowed|permitted|authorized|authorised))\b/is,
    label: 'AI processing explicitly prohibited',
  },
  {
    // "prohibits/forbids ... AI/artificial intelligence"
    pattern: /(?:prohibits?|forbids?|bans?|disallows?)\s+(?:any\s+)?(?:use\s+(?:of|by)\s+)?(?:\bAI\b|artificial\s+intelligence|machine\s+learning|LLM)\b/i,
    label: 'Explicitly prohibits AI use',
  },
  {
    // "must not / may not / shall not be processed by AI"
    pattern: /(?:must|may|shall|should|can)\s+not\s+(?:be\s+)?(?:processed|treated|analyzed|analysed|used|trained\s+on|ingested|integrated|absorbed)\b.{0,100}(?:\bAI\b|artificial\s+intelligence|machine\s+learning)/is,
    label: 'Must not be processed/treated by AI',
  },
  {
    // "no AI training/processing/treatment/use/analysis"
    pattern: /\bno\s+AI\s+(?:training|processing|treatment|use|analysis|ingestion|integration)\b/i,
    label: 'No AI training/processing clause',
  },
  {
    // "do not use/process/analyze this document with/for AI"
    pattern: /\bdo\s+not\s+(?:use|process|analyz[e|s]|train\s+on)\b.{0,100}(?:\bAI\b|artificial\s+intelligence|machine\s+learning)/is,
    label: 'Instruction: do not use with AI',
  },
  {
    // "integration ... by/with Artificial Intelligence ... prohibited/not permitted"
    pattern: /(?:integration|ingestion|absorption|transmission)\b.{0,150}(?:\bAI\b|artificial\s+intelligence)\b.{0,100}(?:prohibited|forbidden|not\s+(?:permitted|allowed)|expressly)/is,
    label: 'Integration by AI prohibited',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TDM / TEXT & DATA MINING opt-out (DSM Art. 4)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    pattern: /\bAI\s+opt[-\s]?out\b/i,
    label: 'AI opt-out clause',
  },
  {
    pattern: /\bTDM\s+opt[-\s]?out\b/i,
    label: 'TDM opt-out clause',
  },
  {
    pattern: /(?:text\s+and\s+data\s+mining|TDM)\b.{0,80}(?:prohibited|forbidden|not\s+permitted|not\s+allowed|reserved)\b/is,
    label: 'TDM explicitly prohibited',
  },
  {
    pattern: /\bautomated\s+(?:data\s+)?(?:extraction|processing|analysis|collection)\s+(?:is\s+)?(?:prohibited|forbidden|not\s+allowed)\b/i,
    label: 'Automated AI processing prohibited',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MACHINE-READABLE OPT-OUT MARKERS
  // ═══════════════════════════════════════════════════════════════════════════
  { pattern: /\bnoai\b/i,              label: 'noai opt-out marker' },
  { pattern: /\btdmrep\b/i,            label: 'TDMRep marker' },
  { pattern: /\bai-opt-out\b/i,        label: 'AI opt-out marker' },
  { pattern: /\bno-ai-processing\b/i,  label: 'No AI processing marker' },

  // ═══════════════════════════════════════════════════════════════════════════
  // FRENCH: Explicit AI prohibitions
  // ═══════════════════════════════════════════════════════════════════════════
  {
    // "s'oppose expressément ... intelligence artificielle"
    pattern: /s['']oppose\s+(?:express[eé]ment|formellement|cat[eé]goriquement).{0,250}(?:intelligence\s+artificielle|IA\b)/is,
    label: 'French: Explicitly opposes AI (s\'oppose expressément)',
  },
  {
    // "interdit ... l'intelligence artificielle / IA"
    pattern: /\binterdit\b.{0,150}(?:l['']intelligence\s+artificielle|\bIA\b|machine\s+learning)/is,
    label: 'French: AI use forbidden (interdit)',
  },
  {
    // "ne doit pas / ne peut pas être traité par l'IA"
    pattern: /(?:ne\s+doit\s+pas|ne\s+peut\s+pas)\b.{0,150}(?:l['']intelligence\s+artificielle|\bIA\b)/is,
    label: 'French: Must not be AI processed (ne doit pas)',
  },
  {
    pattern: /\bpas\s+d['']intelligence\s+artificielle\b|\bpas\s+d['']IA\b/i,
    label: 'French: No AI allowed',
  },
  {
    pattern: /opposition\s+(?:express[eé]ment?|formelle)?.{0,80}(?:TDM|data\s+mining|fouille\s+de\s+textes|intelligence\s+artificielle)/is,
    label: 'French: TDM / AI opt-out (opposition)',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SPANISH: Explicit AI prohibitions
  // ═══════════════════════════════════════════════════════════════════════════
  {
    pattern: /(?:proh[ií]be|vetado|prohibido)\b.{0,150}(?:inteligencia\s+artificial|\bIA\b|machine\s+learning)/is,
    label: 'Spanish: AI use prohibited (prohíbe/vetado)',
  },
  {
    pattern: /\bno\s+(?:se\s+)?(?:permite|autoriza)\b.{0,100}(?:inteligencia\s+artificial|\bIA\b)/is,
    label: 'Spanish: AI processing not permitted',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // GERMAN: Explicit AI prohibitions
  // ═══════════════════════════════════════════════════════════════════════════
  {
    pattern: /(?:k[uü]nstliche\s+intelligenz|\bKI\b)\b.{0,100}(?:verboten|untersagt|nicht\s+(?:erlaubt|gestattet|zul[äa]ssig))\b/is,
    label: 'German: AI explicitly forbidden (verboten/untersagt)',
  },
  {
    pattern: /\bdarf\s+nicht\b.{0,150}(?:k[uü]nstliche\s+intelligenz|\bKI\b|maschinelles\s+lernen)/is,
    label: 'German: May not be AI processed (darf nicht)',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ITALIAN: Explicit AI prohibitions
  // ═══════════════════════════════════════════════════════════════════════════
  {
    pattern: /(?:vietato|proibito)\b.{0,150}(?:intelligenza\s+artificiale|\bIA\b|machine\s+learning)/is,
    label: 'Italian: AI use prohibited (vietato/proibito)',
  },
  {
    pattern: /\bnon\s+(?:deve|può)\b.{0,100}(?:intelligenza\s+artificiale|\bIA\b)/is,
    label: 'Italian: Must not be AI processed (non deve/può)',
  },
];

// ─── Main check function ─────────────────────────────────────────────────────

/**
 * Checks whether a document contains an EXPLICIT PROHIBITION against
 * AI processing, treatment, or ingestion.
 *
 * Rule:
 *   - Explicit AI prohibition found  → 'blocked'  (do not upload or process)
 *   - No explicit AI prohibition     → 'clear'    (safe to process)
 *
 * The document content is never reproduced or exposed by the application;
 * only factual rules/plans extracted by the analysis agent are stored.
 *
 * @param {string} text       Raw text to scan (first ~4,000 chars recommended)
 * @param {string} [filename] Optional filename for contextual messages
 * @returns {{
 *   status: 'clear' | 'blocked',
 *   reason: string,
 *   legal_basis: string,
 *   paraphrase_required: boolean,
 *   matched_pattern: string | null,
 *   checked_chars: number,
 * }}
 */
function checkCopyright(text, filename) {
  // Scan first 4,000 chars — enough to cover the first page of most documents
  // where AI prohibition notices typically appear.
  const scan = (typeof text === 'string' ? text : '').slice(0, 4000);
  const checkedChars = scan.length;

  // ── Check for explicit AI prohibition ──────────────────────────────────────
  for (const { pattern, label } of BLOCKED_PATTERNS) {
    if (pattern.test(scan)) {
      return {
        status: 'blocked',
        reason:
          `Document${filename ? ` "${filename}"` : ''} contains an explicit prohibition `
          + `against AI processing. Detected: "${label}". `
          + `The document must not be processed, treated, or ingested by AI systems. `
          + `It must be reviewed manually and any applicable rules entered without AI assistance.`,
        legal_basis:
          'DSM Directive (EU) 2019/790, Art. 4 — TDM opt-out exercised by rightsholder; '
          + 'EU AI Act (EU) 2024/1689, Art. 53(1)(c)',
        paraphrase_required: false,
        matched_pattern: label,
        checked_chars: checkedChars,
      };
    }
  }

  // ── No explicit AI prohibition found → CLEAR ───────────────────────────────
  // The document does not forbid AI processing. Since the application never
  // reproduces or exposes raw document content, it is safe to process.
  return {
    status: 'clear',
    reason:
      `Document${filename ? ` "${filename}"` : ''} does not contain an explicit prohibition `
      + `against AI processing. `
      + (checkedChars === 0
        ? 'No text could be extracted — proceeding as clear by default.'
        : `Scanned ${checkedChars} characters; no AI opt-out or prohibition detected.`),
    legal_basis:
      'DSM Directive (EU) 2019/790, Art. 4 — no opt-out exercised; '
      + 'CJEU Infopaq C-5/08 (factual data unprotected)',
    paraphrase_required: false,
    matched_pattern: null,
    checked_chars: checkedChars,
  };
}

module.exports = { checkCopyright };
