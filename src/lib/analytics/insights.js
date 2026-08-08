/**
 * Auto-generated insights (FR-41).
 *
 * Rule-based and pure. Every insight names the evidence behind it — the figure,
 * the sample size, the scale — because an unexplained "lowest-rated aspect" is
 * a claim an admin cannot check and should not act on.
 *
 * Two rules govern all of them:
 *
 *  - Nothing is ranked across scales on its raw average. Faculty rate out of 4,
 *    so their 3.0 outranks a student's 3.2 once both are normalised. Comparisons
 *    use normalised_avg; raw averages are only ever shown beside their own
 *    ceiling.
 *
 *  - Nothing is claimed from a handful of answers. A single 1-star response is
 *    not "the lowest-rated aspect", so a question needs MIN_N scored answers
 *    before it can win or lose anything, and what was excluded is reported
 *    rather than silently dropped.
 */
import { MIN_N_FOR_INSIGHT } from './scales.js'

export const MIN_N = MIN_N_FOR_INSIGHT

/** Words too common in curriculum feedback to be worth surfacing. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from',
  'as', 'it', 'its', 'this', 'that', 'these', 'those', 'we', 'i', 'you', 'they',
  'he', 'she', 'them', 'his', 'her', 'our', 'their', 'my', 'me', 'us', 'can',
  'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'do',
  'does', 'did', 'have', 'has', 'had', 'not', 'no', 'so', 'than', 'then',
  'there', 'here', 'what', 'which', 'who', 'when', 'where', 'how', 'why',
  'all', 'any', 'some', 'more', 'most', 'other', 'such', 'only', 'own', 'same',
  'very', 'too', 'also', 'just', 'about', 'into', 'over', 'under', 'up', 'down',
  'out', 'off', 'again', 'further', 'once', 'because', 'while', 'during',
  // domain words that appear in nearly every answer and carry no signal
  'course', 'courses', 'subject', 'subjects', 'curriculum', 'syllabus',
  'student', 'students', 'teacher', 'teachers', 'faculty', 'college',
  'please', 'need', 'needs', 'good', 'better', 'best',
])

const isRankable = (row) =>
  row &&
  Number(row.n_scored ?? 0) >= MIN_N &&
  row.normalised_avg !== null &&
  row.normalised_avg !== undefined

/**
 * @param {object[]} stats rows from analytics_question_stats
 * @param {object} [sentimentSummary] output of createClassifier().summarise
 * @returns {{insights: object[], excluded: {questions: number, reason: string}|null}}
 */
export function buildInsights(stats, sentimentSummary = null) {
  const rows = (stats ?? []).filter(Boolean)
  const rankable = rows.filter(isRankable)
  const insights = []

  const skipped = rows.length - rankable.length
  const excluded = skipped
    ? {
        questions: skipped,
        reason: `${skipped} question${skipped === 1 ? '' : 's'} had fewer than ${MIN_N} scored answers and were left out of the rankings.`,
      }
    : null

  if (rankable.length > 0) {
    const sorted = [...rankable].sort((a, b) => a.normalised_avg - b.normalised_avg)
    const lowest = sorted[0]
    const highest = sorted[sorted.length - 1]

    insights.push({
      kind: 'lowest_rated',
      title: 'Lowest-rated aspect',
      subject: lowest.question_text ?? lowest.question_key,
      stakeholder: lowest.stakeholder_type,
      value: lowest.normalised_avg,
      // Raw average travels with its own ceiling; the two are not comparable
      // across forms and must never be printed side by side without them.
      detail: `${Number(lowest.avg_score).toFixed(2)} out of ${Number(lowest.max_score)} from ${lowest.n_scored} scored answers (${lowest.stakeholder_type}).`,
    })

    if (highest !== lowest) {
      insights.push({
        kind: 'highest_rated',
        title: 'Highest-rated aspect',
        subject: highest.question_text ?? highest.question_key,
        stakeholder: highest.stakeholder_type,
        value: highest.normalised_avg,
        detail: `${Number(highest.avg_score).toFixed(2)} out of ${Number(highest.max_score)} from ${highest.n_scored} scored answers (${highest.stakeholder_type}).`,
      })
    }

    // A question people decline to answer is a finding in itself: it usually
    // means it does not apply to them, which is a curriculum signal.
    const naHeavy = rankable
      .filter((r) => Number(r.n_answers) > 0)
      .map((r) => ({ row: r, share: Number(r.n_not_applicable) / Number(r.n_answers) }))
      .filter((x) => x.share >= 0.25)
      .sort((a, b) => b.share - a.share)[0]

    if (naHeavy) {
      insights.push({
        kind: 'not_applicable',
        title: 'Most often marked not applicable',
        subject: naHeavy.row.question_text ?? naHeavy.row.question_key,
        stakeholder: naHeavy.row.stakeholder_type,
        value: naHeavy.share,
        detail: `${naHeavy.row.n_not_applicable} of ${naHeavy.row.n_answers} respondents chose a non-scoring option, so this question may not apply to them.`,
      })
    }

    // FR-34 surfaced as an insight, not just a badge: an average that mixes
    // wordings is the one an admin should trust least.
    const mixed = rankable
      .filter((r) => Number(r.versions_answered ?? 0) > 1)
      .sort((a, b) => b.versions_answered - a.versions_answered)[0]

    if (mixed) {
      insights.push({
        kind: 'version_spanning',
        title: 'Average spans reworded questions',
        subject: mixed.question_text ?? mixed.question_key,
        stakeholder: mixed.stakeholder_type,
        value: null,
        detail: `Answers were given against ${mixed.versions_answered} different wordings (v${(mixed.version_nos ?? []).join(', v')}), so treat this average with care.`,
      })
    }
  }

  if (sentimentSummary?.opinionated > 0) {
    const { counts, share, opinionated } = sentimentSummary
    if (share.negative !== null && share.negative >= 0.3) {
      insights.push({
        kind: 'negative_sentiment',
        title: 'Negative feedback is common',
        subject: 'Open-ended answers',
        stakeholder: null,
        value: share.negative,
        detail: `${counts.negative} of ${opinionated} written answers read as negative.`,
      })
    }

    const requested = topTerms(sentimentSummary.rows, 1)[0]
    if (requested) {
      insights.push({
        kind: 'most_requested',
        title: 'Most requested addition',
        subject: requested.term,
        stakeholder: null,
        value: requested.count,
        detail: `Mentioned in ${requested.count} written answer${requested.count === 1 ? '' : 's'}.`,
      })
    }
  }

  return { insights, excluded }
}

/**
 * Most frequent meaningful terms across written answers.
 *
 * Counts each term once PER ANSWER, not per occurrence: one respondent writing
 * "labs, labs, labs" should not outweigh three respondents each mentioning it.
 */
export function topTerms(rows, limit = 5) {
  const counts = new Map()

  for (const row of rows ?? []) {
    const text = row?.value_text ?? ''
    if (row?.sentiment?.label === 'none') continue

    const seen = new Set()
    for (const word of String(text).toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
      const term = word.replace(/'s$/, '')
      if (term.length < 4 || STOP_WORDS.has(term) || seen.has(term)) continue
      seen.add(term)
      counts.set(term, (counts.get(term) ?? 0) + 1)
    }
  }

  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .filter((entry) => entry.count > 1)
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, limit)
}
