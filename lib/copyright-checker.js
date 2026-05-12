/**
 * Copyright clearance checker for PA document ingestion.
 *
 * Implements the three-step decision tree from
 * .cursor/EU Copyright/copyright-classification-guidelines.mdc:
 *
 *   Step 1 — Initial copyright screen (license/public domain / unknown)
 *   Step 2 — TDM opt-out check (DSM Directive Art. 4)
 *   Step 3 — Use-case scope check
 *
 * Returns one of three statuses:
 *   'blocked'    — explicit AI/TDM opt-out detected → HTTP 451
 *   'restricted' — no explicit opt-out but reproduction rights held → HTTP 200
 *   'clear'      — public domain / open license / pure factual data → HTTP 200
 *
 * Usage:
 *   const { checkCopyright } = require('./copyright-checker');
 *   const result = checkCopyright(textSnippet, filename);
 *   // result: { status, reason, legal_basis, paraphrase_required, matched_pattern? }
 */

'use strict';

// ─── BLOCKED patterns (DSM Art. 4 opt-out) ──────────────────────────────────
// Any match here → BLOCKED immediately.
// Sorted most-specific first for clarity; all tested case-insensitively.
const BLOCKED_PATTERNS = [
  // Explicit AI/TDM opt-out phrases (EN)
  { pattern: /\bAI\s+opt[-\s]out\b/i,                          label: 'AI opt-out clause' },
  { pattern: /\bTDM\s+opt[-\s]out\b/i,                         label: 'TDM opt-out clause' },
  { pattern: /no\s+AI\s+training\b/i,                           label: '"no AI training" clause' },
  { pattern: /no\s+AI\s+processing\b/i,                         label: '"no AI processing" clause' },
  { pattern: /no\s+machine\s+learning\b/i,                      label: '"no machine learning" clause' },
  { pattern: /no\s+artificial\s+intelligence\s+use/i,           label: '"no AI use" clause' },
  { pattern: /expressly\s+prohibits?\s+(any\s+)?(?:use\s+(?:of|by)\s+)?(?:artificial\s+intelligence|AI)\b/i,
                                                                  label: 'Expressly prohibits AI use' },
  { pattern: /(?:text\s+and\s+data\s+mining|TDM)\s+(?:is\s+)?(?:prohibited|not\s+permitted|forbidden)\b/i,
                                                                  label: 'TDM prohibited' },
  { pattern: /\bautomated\s+(?:data\s+)?extraction\s+is\s+prohibited\b/i,
                                                                  label: 'Automated extraction prohibited' },
  // Machine-readable opt-out markers
  { pattern: /noai/i,                                            label: 'noai robots/meta tag' },
  { pattern: /tdmrep/i,                                          label: 'TDMRep marker' },
  // French AFNOR / DSM pattern
  { pattern: /s'oppose\s+express[eé]ment\s+(?:à\s+)?(?:l'utilisation\s+par\s+)?l['']intelligence\s+artificielle/i,
                                                                  label: 'French DSM opt-out (s\'oppose expressément)' },
  { pattern: /opposition\s+express[eé]ment?\s+(?:aux?\s+)?(?:TDM|data\s+mining)/i,
                                                                  label: 'French TDM opt-out' },
  // Generic prohibition covering AI context
  { pattern: /(?:reproduction|usage|utilisation)\s+(?:par|by|via|with)\s+(?:artificial\s+intelligence|AI|machine\s+learning|LLM)\s+(?:is\s+)?(?:prohibited|interdite?|forbidden)\b/i,
                                                                  label: 'AI reproduction prohibited' },
];

// ─── CLEAR patterns (no copyright restriction) ───────────────────────────────
// Match any → CLEAR (unless a BLOCKED pattern already hit).
const CLEAR_PATTERNS = [
  // Public domain / CC0
  { pattern: /\bCC0\b|\bCC\s+Zero\b/i,                          label: 'CC0 / CC Zero license' },
  { pattern: /\bpublic\s+domain\b/i,                            label: 'Public domain declaration' },
  { pattern: /no\s+rights?\s+reserved\b/i,                      label: '"No rights reserved" declaration' },
  // Creative Commons open licenses (BY only — not SA/NC/ND)
  { pattern: /creative\s+commons\s+attribution\s+(?:(?:international\s+)?license\s+)?(?:CC[-\s]BY)\s*(?:[\d.]+)?\s*(?![-\s](?:SA|NC|ND))/i,
                                                                  label: 'CC BY license' },
  { pattern: /\bCC[-\s]BY\s*(?:[\d.]+)?\s*(?![- ](SA|NC|ND)\b)/i,
                                                                  label: 'CC BY license' },
  // Open Government License
  { pattern: /open\s+government\s+licen[cs]e/i,                 label: 'Open Government License' },
  // EU / government official publication indicators
  { pattern: /\bEUR-Lex\b|\bOfficial\s+Journal\s+of\s+the\s+European\s+Union\b/i,
                                                                  label: 'EU Official Journal / EUR-Lex' },
  { pattern: /\blegifrance\.gouv\.fr\b/i,                       label: 'Légifrance (French government)' },
  { pattern: /\beur-lex\.europa\.eu\b/i,                        label: 'EUR-Lex official source' },
];

// ─── RESTRICTED patterns (reproduction rights held, no opt-out) ─────────────
// Match any → RESTRICTED (factual extraction only, no verbatim).
const RESTRICTED_PATTERNS = [
  { pattern: /all\s+rights?\s+reserved\b/i,                     label: '"All Rights Reserved"' },
  { pattern: /tous\s+droits?\s+r[eé]serv[eé]s?\b/i,            label: '"Tous droits réservés" (French)' },
  { pattern: /todos\s+los\s+derechos\s+reservados\b/i,          label: '"Todos los derechos reservados" (Spanish)' },
  { pattern: /©\s*\d{4}/,                                       label: 'Copyright symbol with year' },
  { pattern: /\bCopyright\s+(?:\(c\)\s*)?\d{4}\b/i,            label: 'Copyright statement' },
  { pattern: /\bCC[-\s]BY[-\s](SA|NC|ND)\b/i,                  label: 'Conditional CC license (SA/NC/ND)' },
  { pattern: /\bAll\s+intellectual\s+property\s+rights?\s+reserved\b/i,
                                                                  label: 'Intellectual property rights reserved' },
  { pattern: /\bconfidential\b.*\bdo\s+not\s+(?:copy|distribute|reproduce)\b/i,
                                                                  label: 'Confidential / no reproduction' },
  { pattern: /\bproprietary\s+(?:and\s+)?confidential\b/i,      label: 'Proprietary and confidential' },
];

// ─── Main check function ─────────────────────────────────────────────────────

/**
 * @param {string} text   — raw text to scan (caller should pass first ~3,000 chars)
 * @param {string} [filename] — optional filename for contextual hints
 * @returns {{
 *   status: 'clear' | 'restricted' | 'blocked',
 *   reason: string,
 *   legal_basis: string,
 *   paraphrase_required: boolean,
 *   matched_pattern: string | null,
 *   checked_chars: number,
 * }}
 */
function checkCopyright(text, filename) {
  const scan = (typeof text === 'string' ? text : '').slice(0, 3000);
  const checkedChars = scan.length;

  // Step 2 — TDM opt-out check (highest priority, immediate block)
  for (const { pattern, label } of BLOCKED_PATTERNS) {
    if (pattern.test(scan)) {
      return {
        status: 'blocked',
        reason: (
          `Document${filename ? ` "${filename}"` : ''} contains an explicit AI/TDM opt-out clause `
          + `under DSM Directive (EU) 2019/790 Art. 4. Detected: "${label}". `
          + `AI processing is not permitted. The document must be reviewed manually `
          + `and any applicable rules entered without AI assistance.`
        ),
        legal_basis: 'DSM Directive (EU) 2019/790, Art. 4 — opt-out exercised by rightsholder; EU AI Act (EU) 2024/1689, Art. 53(1)(c)',
        paraphrase_required: false,
        matched_pattern: label,
        checked_chars: checkedChars,
      };
    }
  }

  // Step 1 — Open license / public domain (CLEAR)
  for (const { pattern, label } of CLEAR_PATTERNS) {
    if (pattern.test(scan)) {
      return {
        status: 'clear',
        reason: (
          `Document${filename ? ` "${filename}"` : ''} has a permissive license: "${label}". `
          + `AI extraction is permitted. Cite the source in all extracted rules/plans.`
        ),
        legal_basis: 'Open license / public domain — contractual permission from rightsholder; CJEU Infopaq C-5/08 (facts unprotected)',
        paraphrase_required: false,
        matched_pattern: label,
        checked_chars: checkedChars,
      };
    }
  }

  // Step 1 / Step 2 — "All Rights Reserved" or © with no explicit opt-out (RESTRICTED)
  for (const { pattern, label } of RESTRICTED_PATTERNS) {
    if (pattern.test(scan)) {
      return {
        status: 'restricted',
        reason: (
          `Document${filename ? ` "${filename}"` : ''} bears reproduction rights: "${label}". `
          + `No explicit AI/TDM opt-out was detected, so DSM Art. 4 TDM exception may apply. `
          + `Extract factual information only (prices, rules, thresholds). `
          + `Do NOT reproduce verbatim text. Paraphrase all excerpts.`
        ),
        legal_basis: 'InfoSoc Directive 2001/29/EC, Art. 2 (reproduction rights); DSM Directive Art. 4 TDM exception (no opt-out detected)',
        paraphrase_required: true,
        matched_pattern: label,
        checked_chars: checkedChars,
      };
    }
  }

  // No license signal found — default to RESTRICTED (assume protected)
  // per guideline: "Unknown / no license stated → ASSUME PROTECTED"
  if (checkedChars === 0) {
    return {
      status: 'restricted',
      reason: 'No text could be extracted from the document. Treating as restricted by default (unknown copyright status).',
      legal_basis: 'InfoSoc Directive 2001/29/EC, Art. 2 — default assumption: protected',
      paraphrase_required: true,
      matched_pattern: null,
      checked_chars: checkedChars,
    };
  }

  return {
    status: 'restricted',
    reason: (
      `No explicit license or opt-out declaration found in${filename ? ` "${filename}"` : ' the document'}. `
      + `Treating as copyright-protected by default (InfoSoc Directive). `
      + `Extract factual information only; do NOT reproduce verbatim text.`
    ),
    legal_basis: 'InfoSoc Directive 2001/29/EC, Art. 2 — "Unknown / no license stated → ASSUME PROTECTED"',
    paraphrase_required: true,
    matched_pattern: null,
    checked_chars: checkedChars,
  };
}

module.exports = { checkCopyright };
