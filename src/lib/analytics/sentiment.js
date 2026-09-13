/**
 * Rule-based sentiment for open-ended answers (FR-40).
 *
 * Rule-based, not a model: PRD §4 fixes the budget at ₹0, so there is no API to
 * call, and a lexicon is auditable — every verdict can be traced to the words
 * that produced it, which is what `words` and `reason` are for.
 *
 * The analyzer is injected rather than imported so this module stays pure and
 * testable in Node. Pass the `sentiment` package's instance in the browser.
 *
 * Three corrections to the raw library output, each measured against it rather
 * than assumed:
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

export const POSITIVE_AT = 2
export const NEGATIVE_AT = -1

export const LABELS = ['positive', 'neutral', 'negative', 'none']

/**
 * @param {{analyze: (text: string) => {score: number, comparative: number, words: string[]}}} analyzer
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

    // Very short answers cannot support a verdict; two characters of lexicon
    // match is noise.
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
    const score = Number(result?.score ?? 0)
    const words = result?.words ?? []

    if (words.length === 0) {
      return { label: 'neutral', score, comparative: 0, words, reason: 'No sentiment words matched.' }
    }

    const label = score >= POSITIVE_AT ? 'positive' : score <= NEGATIVE_AT ? 'negative' : 'neutral'

    return {
      label,
      score,
      comparative: Number(result?.comparative ?? 0),
      words,
      reason: `Matched ${words.map((w) => `"${w}"`).join(', ')} for a score of ${score}.`,
    }
  }

  /**
   * Classifies a batch and returns counts plus the classified rows.
   *
   * `none` is reported separately and excluded from the percentage base, so the
   * three opinion buckets are percentages of people who actually wrote
   * something.
   */
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
