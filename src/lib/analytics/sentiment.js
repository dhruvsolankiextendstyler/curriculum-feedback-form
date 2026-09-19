/**
 * Rule-based sentiment for open-ended answers (FR-40).
 *
 * Rule-based, not a model: PRD §4 fixes the budget at ₹0, so there is no API to
 * call, and a lexicon is auditable — every verdict can be traced to the words
 * that produced it, which is what `words` and `reason` are for.
 *
 * Four corrections on top of raw AFINN:
 *
 *  1. Non-answers ("na", "nil", "-") are their own bucket. Counting them as
 *     neutral inflates neutral with people who wrote nothing at all, and on a
 *     form where most respondents skip the free-text box that becomes the
 *     headline finding.
 *
 *  2. "No complaints" scores -3 and lands in NEGATIVE — the library reads `no`
 *     (-1) and `complaints` (-2) additively and never sees the negation. A
 *     satisfied respondent counted as a complaint is a wrong answer in the
 *     direction that matters most, so those phrases are matched first.
 *
 *  3. Thresholds are asymmetric, on the RAW score. A 37-word complaint about
 *     outdated lab equipment scores -1 with a comparative of -0.027, so any
 *     comparative threshold files the most substantive complaint on the form as
 *     neutral — long text dilutes toward zero. Positive needs +2 because
 *     politeness is not praise: "More lab time please" scores +1 on the word
 *     `please` alone.
 *
 *  4. Three additional signal layers applied AFTER the AFINN pass:
 *     (a) Negation window — "not good" flips +3 to -3; detected by scanning
 *         a 2-word window before every AFINN token in the tokenised text.
 *     (b) Mild-negative phrases — "could be better", "needs improvement",
 *         "should be updated" score neutral or positive in AFINN because
 *         `better`=+2 dominates. A regex catches them and subtracts 2 per match.
 *     (c) Domain overrides — ~10 curriculum-specific words AFINN scores 0
 *         (outdated, repetitive, irrelevant…) but which carry clear signal in
 *         this context. Applied as a score delta, never overwriting AFINN words.
 */

/** Answers that carry no opinion. Compared after lowercasing and trimming. */
const NON_ANSWERS = new Set([
  '', '-', '--', '---', '.', '..', '...', 'na', 'n/a', 'n.a.', 'nil', 'none',
  'no', 'nope', 'nothing', 'not applicable', 'nothing to add', 'no comment',
  'no comments', 'x', 'xx', 'null', 'same', 'ok', 'okay', 'fine', 'good enough',
])

/**
 * Satisfaction expressed as the absence of a problem. Checked before the
 * lexicon, because every one of these scores negative on it.
 */
const NO_PROBLEM = /\b(?:no|nothing)\s+(?:major\s+|significant\s+|real\s+|serious\s+)?(?:complaints?|issues?|problems?|concerns?|objections?|drawbacks?|shortcomings?|difficult(?:y|ies)|wrong)\b/i

/**
 * The same idea the other way round: "nothing to change", "no changes needed".
 *
 * The verb is MANDATORY. Made optional, the whole alternation collapses to the
 * bare word `nothing` followed by a space — and because this is tested before
 * the lexicon, "nothing works in the labs, equipment is terrible" was filed as
 * satisfaction with the matched substring being literally "nothing ". That
 * inverts sentiment in the direction this file says matters most, and it moves
 * FR-41's gate: prefixing one complaint with the word took a 10-answer bag from
 * a 0.300 negative share to 0.200 and switched the `negative_sentiment` insight
 * off entirely.
 */
const NOTHING_TO_CHANGE = /\b(?:nothing|no\s+changes?|no\s+suggestions?)\s+(?:to\s+)?(?:change|improve|add|suggest|report|mention)\b/i

/**
 * The bare noun phrases, matched against the WHOLE answer.
 *
 * Their own alternatives because the mandatory verb above rightly refuses them,
 * and left to the lexicon they read NEGATIVE on the word "no" — the same error,
 * mirrored. As a complete answer they carry only one meaning; inside a longer
 * sentence ("no changes were made to the syllabus for three years") they do not,
 * which is why this is anchored and `NOTHING_TO_CHANGE` is not.
 */
const NOTHING_ALONE = /^no\s+(?:changes?|suggestions?|improvements?|recommendations?)(?:\s+needed|\s+required)?$/i

/**
 * "Could be better", "needs improvement", "should be updated" — phrases where
 * AFINN sees a positive word (better=+2) and misses the negative framing.
 * Each match subtracts 2 from the raw AFINN score.
 *
 * Anchored to a modal/auxiliary so "keep it better" doesn't trigger (that is
 * a genuine positive). The `\b` on the right prevents "improved upon" from
 * matching `improved` mid-phrase.
 */
const MILD_NEGATIVE = /\b(?:could|should|would|needs?\s+to|must|has\s+to|have\s+to)\s+(?:be\s+)?(?:better|improv(?:e[d]?|ing)|updat(?:e[d]?|ing)|rework(?:ed)?|revis(?:ed)?|restructur(?:ed)?|more\s+\w+|less\s+\w+)\b/gi

/**
 * Negation words that, when found 1–2 tokens before a sentiment word, should
 * flip that word's contribution.
 *
 * "hardly", "barely", "scarcely" are diminishers that also invert positive
 * signal — "barely helpful" is not helpful.
 */
const NEGATORS = new Set([
  'not', "n't", 'never', 'neither', 'nor',
  'no', 'without', 'lack', 'lacks', 'lacking',
  'wasn', 'isn', 'aren', 'weren', 'doesn', 'didn', 'couldn', 'wouldn', 'shouldn',
  'hardly', 'barely', 'scarcely',
])

/**
 * Domain-specific score overrides for words AFINN does not know or
 * scores wrong in the curriculum-feedback context.
 *
 * Values are DELTAS added to the AFINN total, not replacements.
 * Only applied when the word appears in the answer (case-insensitive whole word).
 */
const DOMAIN_OVERRIDES = {
  // negative — AFINN scores 0
  outdated: -2,
  'out-of-date': -2,
  repetitive: -1,
  redundant: -1,      // AFINN has this at -1 already; double signal is intentional
  irrelevant: -2,     // AFINN has -1; curriculum irrelevance is a stronger signal
  impractical: -2,
  inaccessible: -1,
  disorganised: -2,
  disorganized: -2,
  unstructured: -1,
  // positive — AFINN scores 0
  engaging: 2,        // AFINN: 0
  relevant: 1,        // AFINN: 0
  practical: 1,       // "more practical" is a common positive request/praise
  structured: 1,
  organised: 1,
  organized: 1,
  updated: 1,         // "content is updated" = positive
  'up-to-date': 2,
  informative: 2,     // AFINN: 0
  interactive: 1,     // AFINN: 0
}

export const POSITIVE_AT = 2
export const NEGATIVE_AT = -1

/**
 * @param {{analyze: (text: string) => {score: number, comparative: number, words: string[], tokens: string[]}}} analyzer
 */
export function createClassifier(analyzer) {
  if (!analyzer || typeof analyzer.analyze !== 'function') {
    throw new Error('createClassifier needs an object with an analyze(text) method.')
  }

  /**
   * @returns {{label: 'positive'|'neutral'|'negative'|'none', score: number,
   *            comparative: number, words: string[], reason: string}}
   */
  function classify(text) {
    const raw = typeof text === 'string' ? text : ''
    const trimmed = raw.trim()
    const normalised = trimmed.toLowerCase().replace(/[.!?,;:]+$/, '')

    if (NON_ANSWERS.has(normalised)) {
      return { label: 'none', score: 0, comparative: 0, words: [], reason: 'No answer given.' }
    }

    if (normalised.length < 3) {
      return { label: 'none', score: 0, comparative: 0, words: [], reason: 'Too short to read.' }
    }

    if (
      NO_PROBLEM.test(trimmed) ||
      NOTHING_TO_CHANGE.test(trimmed) ||
      NOTHING_ALONE.test(normalised)
    ) {
      return {
        label: 'positive',
        score: POSITIVE_AT,
        comparative: 0,
        words: [],
        reason: 'Satisfaction stated as the absence of a problem.',
      }
    }

    const result = analyzer.analyze(trimmed)
    let score = Number(result?.score ?? 0)
    const words = result?.words ?? []
    const tokens = (result?.tokens ?? trimmed.toLowerCase().split(/\s+/))
    const reasons = []

    // --- Layer 1: negation window ---
    // For each AFINN token, check if a negator appears in the 2 positions before
    // it in the token stream. If so, flip that token's contribution (score -= 2×contribution).
    let negationDelta = 0
    const negatedWords = []
    for (const word of words) {
      const idx = tokens.indexOf(word.toLowerCase())
      if (idx < 0) continue
      const window = tokens.slice(Math.max(0, idx - 2), idx)
      if (window.some((t) => NEGATORS.has(t.replace(/[^a-z']/g, '')))) {
        // We don't know the individual word score from the result, so approximate:
        // re-analyze the single word and use its score as the contribution.
        const wordScore = Number(analyzer.analyze(word)?.score ?? 0)
        // Flip: subtract 2× the original contribution (net effect = -contribution)
        negationDelta -= 2 * wordScore
        negatedWords.push(word)
      }
    }
    if (negationDelta !== 0) {
      score += negationDelta
      reasons.push(`Negated "${negatedWords.join('", "')}" (Δ${negationDelta > 0 ? '+' : ''}${negationDelta})`)
    }

    // --- Layer 2: mild-negative phrases ---
    const mildMatches = [...trimmed.matchAll(MILD_NEGATIVE)]
    if (mildMatches.length) {
      const delta = -2 * mildMatches.length
      score += delta
      reasons.push(`Found ${mildMatches.length} "could be better" phrase${mildMatches.length > 1 ? 's' : ''} (Δ${delta})`)
    }

    // --- Layer 3: domain overrides ---
    let domainDelta = 0
    const domainMatches = []
    for (const [term, delta] of Object.entries(DOMAIN_OVERRIDES)) {
      // Whole-word match, hyphenated terms allowed
      const pattern = new RegExp(`\\b${term.replace('-', '[-\\s]?')}\\b`, 'i')
      if (pattern.test(trimmed)) {
        domainDelta += delta
        domainMatches.push(`${term}(${delta > 0 ? '+' : ''}${delta})`)
      }
    }
    if (domainDelta !== 0) {
      score += domainDelta
      reasons.push(`Domain terms: ${domainMatches.join(', ')}`)
    }

    const allReasons = words.length
      ? [`AFINN: matched ${words.map((w) => `"${w}"`).join(', ')}`, ...reasons]
      : reasons

    if (words.length === 0 && reasons.length === 0) {
      return { label: 'neutral', score, comparative: 0, words, reason: 'No sentiment words matched.' }
    }

    const label = score >= POSITIVE_AT ? 'positive' : score <= NEGATIVE_AT ? 'negative' : 'neutral'

    return {
      label,
      score,
      comparative: Number(result?.comparative ?? 0),
      words,
      reason: allReasons.join(' · ') || `Score: ${score}`,
    }
  }

  function summarise(answers) {
    const rows = (answers ?? []).map((answer) => ({
      ...answer,
      sentiment: classify(answer?.value_text ?? ''),
    }))

    const counts = { positive: 0, neutral: 0, negative: 0, none: 0 }
    for (const row of rows) counts[row.sentiment.label] += 1

    const opinionated = counts.positive + counts.neutral + counts.negative

    return {
      rows,
      counts,
      total: rows.length,
      opinionated,
      share: {
        positive: opinionated ? counts.positive / opinionated : null,
        neutral: opinionated ? counts.neutral / opinionated : null,
        negative: opinionated ? counts.negative / opinionated : null,
      },
    }
  }

  return { classify, summarise }
}
