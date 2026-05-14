/**
 * Copyright clearance checker for PA document ingestion.
 *
 * FOCUSED ON: Explicit prohibitions against AI processing/treatment.
 *
 * This checker prioritizes detecting explicit prohibitions in documents that
 * forbid being processed, analyzed, or treated by AI systems.
 *
 * Returns one of three statuses:
 *   'blocked'    — explicit AI/TDM opt-out or prohibition detected → HTTP 451
 *   'restricted' — no explicit AI prohibition but reproduction rights held → HTTP 200
 *   'clear'      — public domain / open license / pure factual data → HTTP 200
 *
 * Usage:
 *   const { checkCopyright } = require('./copyright-checker');
 *   const result = checkCopyright(textSnippet, filename);
 *   // result: { status, reason, legal_basis, paraphrase_required, matched_pattern? }
 */

'use strict';

// ─── BLOCKED patterns: EXPLICIT AI PROHIBITIONS ─────────────────────────────
// These patterns detect explicit prohibitions against AI processing/treatment.
// ANY MATCH HERE → BLOCKED immediately (HTTP 451).
// The focus is on detecting when a document explicitly forbids being processed by AI.
const BLOCKED_PATTERNS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // EXPLICIT AI OPT-OUT / PROHIBITION PHRASES (English)
  // ═══════════════════════════════════════════════════════════════════════════
  { pattern: /\bAI\s+opt[-\s]out\b/i,                          label: 'AI opt-out clause' },
  { pattern: /\bTDM\s+opt[-\s]out\b/i,                         label: 'TDM opt-out clause' },
  { pattern: /no\s+AI\s+(?:training|processing|treatment|use|analysis|ingestion)\b/i, label: '"no AI" prohibition clause' },
  { pattern: /(?:prohibits?|forbids?|bans?|disallows?)\s+(?:any\s+)?(?:use\s+(?:of|by)\s+)?(?:artificial\s+intelligence|AI|machine\s+learning|LLM| generative\s+AI)\b/i, label: 'Explicitly prohibits AI use' },
  { pattern: /(?:artificial\s+intelligence|AI|machine\s+learning)\s+(?:is\s+)?(?:prohibited|forbidden|banned|not\s+allowed|not\s+permitted)\b/i, label: 'AI processing explicitly prohibited' },
  { pattern: /(?:may|must|shall)\s+not\s+(?:be\s+)?(?:processed|treated|analyzed|used|trained|ingested|handled)\s+(?:by|with|via|using)\s+(?:artificial\s+intelligence|AI|machine\s+learning|automated\s+systems)\b/i, label: 'Explicitly forbids AI processing/treatment' },
  { pattern: /(?:expressly|explicitly|specifically|strictly)\s+(?:prohibits?|forbids?|bans?|opposes?|objects\s+to)\s+(?:any\s+)?(?:artificial\s+intelligence|AI|machine\s+learning|TDM|text\s+and\s+data\s+mining)\b/i, label: 'Explicit prohibition against AI' },
  { pattern: /do\s+not\s+(?:use|process|analyze|train\s+on)\s+(?:this\s+)?(?:document|content|material|text|data)\s+(?:with|for|in|via)\s+(?:artificial\s+intelligence|AI|machine\s+learning|LLM|generative\s+AI)\b/i, label: 'Explicit instruction: no AI use' },
  { pattern: /(?:this\s+)?(?:document|content|material|text|data)\s+(?:is\s+)?(?:not\s+)?(?:to\s+be|for|available\s+for)\s+(?:processed|treated|analyzed|used|trained)\s+(?:by|with|via)\s+(?:artificial\s+intelligence|AI|machine\s+learning|automated\s+systems)\b/i, label: 'Explicit exclusion from AI processing' },

  // ═══════════════════════════════════════════════════════════════════════════
  // TDM / TEXT & DATA MINING PROHIBITIONS
  // ═══════════════════════════════════════════════════════════════════════════
  { pattern: /(?:text\s+and\s+data\s+mining|TDM)\s+(?:is\s+)?(?:prohibited|forbidden|banned|not\s+permitted|not\s+allowed|excluded|reserved)\b/i, label: 'TDM explicitly prohibited' },
  { pattern: /\bautomated\s+(?:data\s+)?(?:extraction|processing|analysis|collection)\s+(?:is\s+)?(?:prohibited|forbidden|not\s+allowed)\b/i, label: 'Automated processing prohibited' },
  { pattern: /(?:reproduction|usage|utilisation|use)\s+(?:par|by|via|with|pour)\s+(?:artificial\s+intelligence|AI|machine\s+learning|LLM|data\s+mining|TDM)\s+(?:is\s+)?(?:prohibited|interdite?|forbidden|banned)\b/i, label: 'AI/TDM reproduction prohibited' },

  // ═══════════════════════════════════════════════════════════════════════════
  // MACHINE-READABLE OPT-OUT MARKERS
  // ═══════════════════════════════════════════════════════════════════════════
  { pattern: /noai/i,                                            label: 'noai robots/meta tag' },
  { pattern: /tdmrep/i,                                          label: 'TDMRep marker' },
  { pattern: /ai-opt-out/i,                                      label: 'AI opt-out marker' },
  { pattern: /no[-_]?ai[-_]?processing/i,                        label: 'No AI processing marker' },

  // ═══════════════════════════════════════════════════════════════════════════
  // FRENCH - EXPLICIT AI PROHIBITIONS
  // ═══════════════════════════════════════════════════════════════════════════
  { pattern: /s'oppose\s+(?:express[eé]ment|formellement|cat[eé]goriquement)\s+(?:à\s+)?(?:l'utilisation\s+par\s+)?l['']intelligence\s+artificielle/i, label: 'French: Explicitly opposes AI use' },
  { pattern: /interdit\s+(?:formellement|express[eé]ment|cat[eé]goriquement)?\s+(?:l['']usage|l['']utilisation)\s+(?:par|de|via)?\s+(?:l['']intelligence\s+artificielle|IA|machine\s+learning)\b/i, label: 'French: AI use explicitly forbidden' },
  { pattern: /(?:ne\s+doit\s+pas|ne\s+peut\s+pas)\s+(?:[eê]tre)?\s+(?:trait[eé]|utilis[eé]|analys[eé]|trait[eé])\s+(?:par|avec|via)\s+(?:l['']intelligence\s+artificielle|IA|machine\s+learning)\b/i, label: 'French: Explicitly forbids AI treatment' },
  { pattern: /pas\s+d['']intelligence\s+artificielle|pas\s+d['']IA\b/i, label: 'French: No AI allowed' },
  { pattern: /opposition\s+(?:express[eé]ment?|formelle)?\s+(?:aux?\s+)?(?:TDM|data\s+mining|fouille\s+de\s+textes|extraction\s+de\s+donn[eé]es)/i, label: 'French: TDM opt-out' },

  // ═══════════════════════════════════════════════════════════════════════════
  // SPANISH - EXPLICIT AI PROHIBITIONS
  // ═══════════════════════════════════════════════════════════════════════════
  { pattern: /(?:prohibe|proh[ií]be|vetado)\s+(?:expresamente|expl[ií]citamente|formalmente)?\s+(?:el\s+)?(?:uso|utilizaci[oó]n|tratamiento|procesamiento)\s+(?:por|mediante|con|via)\s+(?:inteligencia\s+artificial|IA|machine\s+learning)\b/i, label: 'Spanish: AI use explicitly prohibited' },
  { pattern: /no\s+(?:se\s+)?(?:permite|permite|autoriza|autoriza)\s+(?:el\s+)?(?:uso|tratamiento|procesamiento)\s+(?:por|mediante)\s+(?:inteligencia\s+artificial|IA)\b/i, label: 'Spanish: AI processing not permitted' },
  { pattern: /(?:este\s+)?documento\s+no\s+(?:debe|puede)\s+(?:ser\s+)?(?:tratado|procesado|analizado|utilizado)\s+(?:por|con|mediante)\s+(?:inteligencia\s+artificial|IA)\b/i, label: 'Spanish: Document must not be AI processed' },

  // ═══════════════════════════════════════════════════════════════════════════
  // GERMAN - EXPLICIT AI PROHIBITIONS
  // ═══════════════════════════════════════════════════════════════════════════
  { pattern: /(?:k[iü]nstliche\s+intelligenz|KI|maschinelles\s+lernen)\s+(?:ist\s+)?(?:verboten|untersagt|nicht\s+erlaubt|nicht\s+gestattet)\b/i, label: 'German: AI explicitly forbidden' },
  { pattern: /(?:untersagt|verbietet|verweigert)\s+(?:ausdr[uü]cklich|ausdr[uü]cklich|explizit)?\s+(?:die\s+)?(?:nutzung|verwendung|verarbeitung|analyse)\s+(?:durch|mit|von|mittels)\s+(?:k[iü]nstliche\s+intelligenz|KI)\b/i, label: 'German: Explicitly prohibits AI use' },
  { pattern: /darf\s+nicht\s+(?:durch|mit|von)\s+(?:k[iü]nstliche\s+intelligenz|KI|maschinellem\s+lernen)\s+(?:verarbeitet|genutzt|analysiert|behandelt)\s+werden\b/i, label: 'German: May not be AI processed' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ITALIAN - EXPLICIT AI PROHIBITIONS
  // ═══════════════════════════════════════════════════════════════════════════
  { pattern: /(?:vietato|proibito|sconsigliato)\s+(?:espicitamente|formalmente|specificamente)?\s+(?:l[''])?(?:uso|utilizzo|trattamento|elaborazione)\s+(?:da\s+parte\s+di|tramite|mediante|con)\s+(?:intelligenza\s+artificiale|IA|machine\s+learning)\b/i, label: 'Italian: AI use explicitly prohibited' },
  { pattern: /non\s+(?:deve|pu[oò])\s+(?:essere)?\s+(?:trattato|elaborato|analizzato|usato)\s+(?:da|con|tramite)\s+(?:intelligenza\s+artificiale|IA)\b/i, label: 'Italian: Must not be AI processed' },

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERIC AI-RELATED PROHIBITIONS (cross-language patterns)
  // ═══════════════════════════════════════════════════════════════════════════
  { pattern: /(?:rightsholder|copyright\s+holder|author|publisher)\s+(?:expressly|explicitly|specifically|strictly)?\s+(?:reserves?|withholds?|refuses?|denies?)\s+(?:the\s+right\s+to|permission\s+for)?\s+(?:AI|artificial\s+intelligence|machine\s+learning|TDM)\s+(?:processing|use|treatment|analysis)\b/i, label: 'Rightsholder explicitly denies AI processing' },
  { pattern: /(?:content|document|material|text)\s+(?:is\s+)?(?:excluded\s+from|not\s+available\s+for|reserved\s+from)\s+(?:AI|artificial\s+intelligence|machine\s+learning|automated|computational)\s+(?:processing|analysis|treatment|use|training)\b/i, label: 'Content explicitly excluded from AI processing' },
];

// ─── CLEAR patterns: EXPLICIT PERMISSION (no AI prohibition) ───────────────
// Documents with explicit open licenses or public domain declarations.
// These are CLEAR for AI processing because they grant explicit permission.
// Match any → CLEAR (unless a BLOCKED pattern already hit).
const CLEAR_PATTERNS = [
  // Public domain / CC0 - explicit permission for any use including AI
  { pattern: /\bCC0\b|\bCC\s+Zero\b/i,                          label: 'CC0 / CC Zero license' },
  { pattern: /\bpublic\s+domain\b/i,                            label: 'Public domain declaration' },
  { pattern: /no\s+rights?\s+reserved\b/i,                      label: '"No rights reserved" declaration' },
  // Creative Commons open licenses (BY only — not SA/NC/ND) - explicit permission
  { pattern: /creative\s+commons\s+attribution\s+(?:(?:international\s+)?license\s+)?(?:CC[-\s]BY)\s*(?:[\d.]+)?\s*(?![-\s](?:SA|NC|ND))/i,
                                                                  label: 'CC BY license - explicit AI permission' },
  { pattern: /\bCC[-\s]BY\s*(?:[\d.]+)?\s*(?![- ](SA|NC|ND)\b)/i,
                                                                  label: 'CC BY license - explicit AI permission' },
  // Open Government License - explicit permission for government docs
  { pattern: /open\s+government\s+licen[cs]e/i,                 label: 'Open Government License' },
  // EU / government official publication indicators - typically public domain
  { pattern: /\bEUR-Lex\b|\bOfficial\s+Journal\s+of\s+the\s+European\s+Union\b/i,
                                                                  label: 'EU Official Journal / EUR-Lex' },
  { pattern: /\blegifrance\.gouv\.fr\b/i,                       label: 'Légifrance (French government)' },
  { pattern: /\beur-lex\.europa\.eu\b/i,                        label: 'EUR-Lex official source' },
];

// ─── RESTRICTED patterns: COPYRIGHT HELD, NO EXPLICIT AI PROHIBITION ───────
// These documents have copyright notices but do NOT explicitly prohibit AI processing.
// They are RESTRICTED (factual extraction only) because they lack explicit AI permission.
// IMPORTANT: No explicit AI prohibition detected → RESTRICTED, not BLOCKED.
const RESTRICTED_PATTERNS = [
  // Standard copyright notices (do not explicitly prohibit AI)
  { pattern: /all\s+rights?\s+reserved\b/i,                     label: '"All Rights Reserved" - no explicit AI prohibition' },
  { pattern: /tous\s+droits?\s+r[eé]serv[eé]s?\b/i,            label: '"Tous droits réservés" (French) - no explicit AI prohibition' },
  { pattern: /todos\s+los\s+derechos\s+reservados\b/i,          label: '"Todos los derechos reservados" (Spanish) - no explicit AI prohibition' },
  { pattern: /alle\s+rechte\s+vorbehalten\b/i,                 label: '"Alle Rechte vorbehalten" (German) - no explicit AI prohibition' },
  { pattern: /tutti\s+i\s+diritti\s+riservati\b/i,             label: '"Tutti i diritti riservati" (Italian) - no explicit AI prohibition' },
  // Copyright symbols and statements (not AI prohibitions)
  { pattern: /©\s*\d{4}/,                                       label: 'Copyright symbol - no explicit AI prohibition' },
  { pattern: /\bCopyright\s+(?:\(c\)\s*)?\d{4}\b/i,            label: 'Copyright statement - no explicit AI prohibition' },
  // Conditional licenses (not explicit AI permission, but not prohibition either)
  { pattern: /\bCC[-\s]BY[-\s](SA|NC|ND)\b/i,                  label: 'Conditional CC license - no explicit AI prohibition' },
  { pattern: /\bAll\s+intellectual\s+property\s+rights?\s+reserved\b/i,
                                                                  label: 'IP rights reserved - no explicit AI prohibition' },
  // Confidentiality (not AI-specific prohibition)
  { pattern: /\bconfidential\b.*\bdo\s+not\s+(?:copy|distribute|reproduce)\b/i,
                                                                  label: 'Confidential - no explicit AI prohibition' },
  { pattern: /\bproprietary\s+(?:and\s+)?confidential\b/i,      label: 'Proprietary - no explicit AI prohibition' },
];

// ─── Main check function ─────────────────────────────────────────────────────

/**
 * Check for EXPLICIT AI PROHIBITIONS in document text.
 *
 * PRIORITY ORDER (first match wins):
 *   1. BLOCKED — Explicit AI prohibition detected → HTTP 451
 *   2. CLEAR   — Explicit open license/public domain permission → HTTP 200
 *   3. RESTRICTED — Copyright held but no explicit AI prohibition → HTTP 200
 *
 * The focus is on detecting explicit prohibitions against AI processing/treatment.
 * Documents with explicit AI prohibitions are BLOCKED immediately.
 *
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

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 1: EXPLICIT AI PROHIBITION (BLOCKED)
  // Check for explicit prohibitions against AI processing/treatment.
  // These take absolute priority — any match → immediate BLOCK.
  // ═══════════════════════════════════════════════════════════════════════════
  for (const { pattern, label } of BLOCKED_PATTERNS) {
    if (pattern.test(scan)) {
      return {
        status: 'blocked',
        reason: (
          `Document${filename ? ` "${filename}"` : ''} contains an EXPLICIT PROHIBITION against AI processing: "${label}". `
          + `The document explicitly forbids being treated, processed, or analyzed by artificial intelligence systems. `
          + `AI processing is NOT permitted. The document must be reviewed manually `
          + `and any applicable rules entered without AI assistance.`
        ),
        legal_basis: 'DSM Directive (EU) 2019/790, Art. 4 — opt-out exercised by rightsholder; EU AI Act (EU) 2024/1689, Art. 53(1)(c)',
        paraphrase_required: false,
        matched_pattern: label,
        checked_chars: checkedChars,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 2: EXPLICIT PERMISSION (CLEAR)
  // Documents with explicit open licenses grant permission for AI processing.
  // ═══════════════════════════════════════════════════════════════════════════
  for (const { pattern, label } of CLEAR_PATTERNS) {
    if (pattern.test(scan)) {
      return {
        status: 'clear',
        reason: (
          `Document${filename ? ` "${filename}"` : ''} has EXPLICIT PERMISSION for AI processing: "${label}". `
          + `The license grants permission for AI extraction and analysis. `
          + `Cite the source in all extracted rules/plans.`
        ),
        legal_basis: 'Open license / public domain — explicit contractual permission from rightsholder; CJEU Infopaq C-5/08 (facts unprotected)',
        paraphrase_required: false,
        matched_pattern: label,
        checked_chars: checkedChars,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIORITY 3: COPYRIGHT HELD, NO EXPLICIT AI PROHIBITION (RESTRICTED)
  // Documents with copyright notices but NO explicit AI prohibition.
  // These can be processed with restrictions (factual extraction only).
  // ═══════════════════════════════════════════════════════════════════════════
  for (const { pattern, label } of RESTRICTED_PATTERNS) {
    if (pattern.test(scan)) {
      return {
        status: 'restricted',
        reason: (
          `Document${filename ? ` "${filename}"` : ''} has copyright: "${label}". `
          + `NO EXPLICIT AI PROHIBITION was detected in the document. `
          + `AI processing is permitted under DSM Art. 4 TDM exception (no opt-out found). `
          + `Extract factual information only (prices, rules, thresholds). `
          + `Do NOT reproduce verbatim text. Paraphrase all excerpts.`
        ),
        legal_basis: 'InfoSoc Directive 2001/29/EC, Art. 2 (reproduction rights); DSM Directive Art. 4 TDM exception (NO explicit AI prohibition detected)',
        paraphrase_required: true,
        matched_pattern: label,
        checked_chars: checkedChars,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEFAULT: UNKNOWN STATUS (RESTRICTED)
  // No explicit AI prohibition AND no explicit permission detected.
  // Default to RESTRICTED (assume protected) per copyright guidelines.
  // ═══════════════════════════════════════════════════════════════════════════
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
      `No explicit AI prohibition OR open license declaration found in${filename ? ` "${filename}"` : ' the document'}. `
      + `Treating as copyright-protected by default (InfoSoc Directive). `
      + `NO EXPLICIT AI PROHIBITION detected — processing permitted with restrictions. `
      + `Extract factual information only; do NOT reproduce verbatim text.`
    ),
    legal_basis: 'InfoSoc Directive 2001/29/EC, Art. 2 — "Unknown / no license stated → ASSUME PROTECTED" (NO explicit AI prohibition detected)',
    paraphrase_required: true,
    matched_pattern: null,
    checked_chars: checkedChars,
  };
}

module.exports = { checkCopyright };
