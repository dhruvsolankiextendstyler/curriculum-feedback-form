/**
 * Rendering rules for rating scores (FR-36, FR-39).
 *
 * Pure and dependency-free so it can be unit-tested in Node.
 *
 * The whole point of this file is that a raw average is meaningless without its
 * scale. Faculty rate on a 4-point scale and everyone else on a 5-point one, so
 * "3.5" is a middling score from a student and a strong one from a lecturer.
 * Every number the dashboard prints goes through formatAvg, and every axis
 * through axisFor, so the ceiling travels with the figure instead of being left
 * to the reader.
 */

/** Scores below this many scored answers are too thin to draw conclusions from. */
export const MIN_N_FOR_INSIGHT = 3

/**
 * "3.5 / 5" — never a bare number.
 *
 * A null average means nothing scored (every respondent chose a non-scoring
 * option), which is different from a zero and must not render as one.
 */
export function formatAvg(row, digits = 2) {
  const avg = row?.avg_score
  if (avg === null || avg === undefined) return '—'
  const max = row?.max_score
  const value = Number(avg).toFixed(digits)
  return max === null || max === undefined ? value : `${value} / ${Number(max)}`
}

/** "83%" from the 0..1 normalised score, or an em dash. */
export function formatNormalised(value, digits = 0) {
  if (value === null || value === undefined) return '—'
  return `${(Number(value) * 100).toFixed(digits)}%`
}

/**
 * True when a set of rows spans more than one rating scale.
 *
 * The faculty form is the reason this exists: charting its 4-point averages on
 * the same 1–5 axis as everyone else's understates faculty by a fifth of the
 * range, and the bars are simply not comparable.
 */
export function spansMultipleScales(rows) {
  const scales = new Set()
  for (const row of rows ?? []) {
    if (row?.scale_id) scales.add(row.scale_id)
  }
  return scales.size > 1
}

/**
 * The y-axis a chart of these rows may legitimately use.
 *
 * One scale: the raw domain, because [1, 4] and [1, 5] are each honest on their
 * own. More than one: the normalised 0..1 domain, because a mixed raw axis is
 * unrepresentable rather than merely discouraged — making the wrong chart
 * impossible to draw beats asserting that nobody will draw it.
 */
export function axisFor(rows) {
  const list = rows ?? []
  if (spansMultipleScales(list)) {
    return {
      key: 'normalised_avg',
      domain: [0, 1],
      normalised: true,
      caption:
        'Normalised to 0–100% because these responses use different rating ' +
        'scales (faculty rate out of 4, everyone else out of 5).',
    }
  }

  const first = list.find((row) => row?.min_score !== null && row?.min_score !== undefined)
  return {
    key: 'avg_score',
    domain: first ? [Number(first.min_score), Number(first.max_score)] : [0, 5],
    normalised: false,
    caption: null,
  }
}

/**
 * FR-34: does this question's average span reworded variants?
 *
 * Keyed on versions ANSWERED, not versions that exist. A question can be
 * reworded without anyone having answered the old wording, in which case the
 * average spans nothing and the warning would be false.
 */
export function spansVersions(row) {
  return (row?.versions_answered ?? 0) > 1
}

/** Explains the version situation, or null when there is nothing to say. */
export function versionNote(row) {
  const answered = row?.versions_answered ?? 0
  const total = row?.versions_total ?? 0

  if (answered > 1) {
    const list = (row.version_nos ?? []).join(', v')
    return `This average spans ${answered} wordings of the question (v${list}).`
  }
  if (total > 1) {
    return `Reworded since, but every answer was given against one wording (v${(row.version_nos ?? []).join(', ')}).`
  }
  return null
}

/**
 * The invariant that catches a mis-shaped aggregate before it reaches a chart.
 *
 * Every answer either scored or did not, so the two denominators must account
 * for all of them. If this ever fires, a join has fanned out and the numbers
 * downstream are wrong in a way that looks entirely plausible.
 *
 * Lives here rather than beside the query it guards so the check scripts can
 * import it without pulling in the Supabase client.
 */
export function assertDenominators(row) {
  const answers = Number(row?.n_answers ?? 0)
  const scored = Number(row?.n_scored ?? 0)
  const na = Number(row?.n_not_applicable ?? 0)

  if (scored + na !== answers) {
    throw new Error(
      `Analytics denominators disagree for "${row?.question_key}": ` +
        `${scored} scored + ${na} not-applicable != ${answers} answers.`,
    )
  }
  return row
}

/**
 * Re-folds grouped rows to a coarser grain.
 *
 * Averaging the averages is the trap: two courses with 40 answers at 2.0 and 2
 * answers at 5.0 pool to 2.14, but the mean of the means is 3.5. So the sums
 * are carried on every row and the mean is rebuilt from them here.
 *
 * Rows on different scales are pooled on their NORMALISED sums only; a raw
 * average across scales has no meaning and is returned as null.
 */
export function pool(rows) {
  const list = (rows ?? []).filter(Boolean)
  if (list.length === 0) return null

  let scoreSum = 0
  let normalisedSum = 0
  let nScored = 0
  let nAnswers = 0
  let nNotApplicable = 0

  for (const row of list) {
    scoreSum += Number(row.score_sum ?? 0)
    normalisedSum += Number(row.normalised_sum ?? 0)
    nScored += Number(row.n_scored ?? 0)
    nAnswers += Number(row.n_answers ?? 0)
    nNotApplicable += Number(row.n_not_applicable ?? 0)
  }

  const mixed = spansMultipleScales(list)

  return {
    n_answers: nAnswers,
    n_scored: nScored,
    n_not_applicable: nNotApplicable,
    score_sum: scoreSum,
    // Guarded: an all-N/A slice divides by zero, and NaN would render as a chart
    // point at the origin.
    avg_score: mixed || nScored === 0 ? null : scoreSum / nScored,
    normalised_avg: nScored === 0 ? null : normalisedSum / nScored,
    min_score: mixed ? null : list[0].min_score,
    max_score: mixed ? null : list[0].max_score,
    scale_id: mixed ? null : list[0].scale_id,
    mixedScales: mixed,
  }
}
