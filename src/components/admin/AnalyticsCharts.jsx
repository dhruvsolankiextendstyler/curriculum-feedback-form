import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { axisFor, formatAvg, formatNormalised, spansVersions } from '../../lib/analytics/scales'

/**
 * Charts for the analytics dashboard (FR-36, FR-38, FR-39).
 *
 * Two rules run through all of them.
 *
 * A null average stays null all the way to the axis. recharts draws a break in
 * the series for null and a floor-scraping dip for 0, and the second reads as
 * "rated terribly" when it actually means "nobody gave this a score".
 *
 * The axis comes from axisFor(), so a chart whose rows span a 4-point and a
 * 5-point scale is drawn normalised with a caption rather than pretending the
 * two are comparable. Making the wrong chart unrepresentable beats trusting the
 * caller not to draw it.
 */

/** Distinct enough in greyscale and for the common colour-vision deficiencies. */
const SERIES = ['#2f6fb0', '#4a9c7d', '#c98a3c', '#a5566f', '#6b6ba8', '#7d8b95']

const shorten = (text, max = 42) =>
  !text ? '' : text.length <= max ? text : `${text.slice(0, max - 1)}…`

/** FR-36: average per question. */
export function QuestionAverages({ rows }) {
  if (!rows?.length) return <p className="muted">No rating answers in this slice.</p>

  const axis = axisFor(rows)

  const data = rows.map((row) => ({
    key: row.question_key,
    label: shorten(row.question_text ?? row.question_key),
    // Explicitly null, never 0 — see the note at the top of this file.
    value: row[axis.key] === null || row[axis.key] === undefined ? null : Number(row[axis.key]),
    row,
  }))

  return (
    <div>
      {axis.caption && <p className="muted small">{axis.caption}</p>}
      <ResponsiveContainer width="100%" height={Math.max(240, data.length * 34)}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" domain={axis.domain} allowDecimals />
          <YAxis type="category" dataKey="label" width={230} tick={{ fontSize: 12 }} />
          <Tooltip content={<AverageTooltip normalised={axis.normalised} />} />
          <Bar dataKey="value" fill={SERIES[0]} radius={[0, 3, 3, 0]}>
            {data.map((entry) => (
              // A version-spanning average is drawn in a different colour so the
              // caveat is visible in the chart, not only in the table (FR-34).
              <Cell
                key={entry.key}
                fill={spansVersions(entry.row) ? SERIES[2] : SERIES[0]}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function AverageTooltip({ active, payload, normalised }) {
  if (!active || !payload?.length) return null
  const { row } = payload[0].payload

  return (
    <div className="card small" style={{ margin: 0, maxWidth: 320 }}>
      <strong>{row.question_text ?? row.question_key}</strong>
      <div>
        {normalised ? formatNormalised(row.normalised_avg) : formatAvg(row)}
        {' · '}
        {row.n_scored} scored of {row.n_answers}
      </div>
      {Number(row.n_not_applicable) > 0 && (
        <div className="muted">
          {row.n_not_applicable} chose a non-scoring option (excluded from the average)
        </div>
      )}
      {spansVersions(row) && (
        <div className="muted">Spans {row.versions_answered} wordings of this question.</div>
      )}
    </div>
  )
}

/**
 * FR-38: how many people chose each option.
 *
 * Counts, not percentages. The denominator here is every answer including the
 * non-scoring ones, which is a different denominator from the average's — and
 * showing both as percentages side by side is what makes bars appear to sum
 * past 100%.
 */
export function DistributionChart({ rows, questionKey }) {
  const forQuestion = (rows ?? []).filter((r) => r.question_key === questionKey)
  if (!forQuestion.length) return <p className="muted">No answers for this question yet.</p>

  const ordered = [...forQuestion].sort((a, b) => a.display_order - b.display_order)
  const data = ordered.map((row) => ({
    label: row.option_label,
    n: Number(row.n),
    scoring: row.option_score !== null && row.option_score !== undefined,
  }))

  return (
    <ResponsiveContainer width="100%" height={230}>
      <BarChart data={data} margin={{ left: 8, right: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 12 }} interval={0} />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="n" name="Answers" radius={[3, 3, 0, 0]}>
          {data.map((entry) => (
            // Non-scoring options are greyed: they are counted here but excluded
            // from every average, and that distinction should be visible.
            <Cell key={entry.label} fill={entry.scoring ? SERIES[0] : SERIES[5]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/**
 * FR-39: one line per question across cycles.
 *
 * Points where the answers span more than one wording are drawn as a hollow
 * marker, so a jump caused by a reworded question is not read as a change in
 * opinion.
 */
export function TrendChart({ rows }) {
  if (!rows?.length) return <p className="muted">No trend data yet — this needs a second cycle.</p>

  const axis = axisFor(rows)
  const cycles = []
  const byQuestion = new Map()

  for (const row of rows) {
    if (!cycles.some((c) => c.id === row.cycle_id)) {
      cycles.push({ id: row.cycle_id, label: row.cycle_label, opensAt: row.opens_at })
    }
    const key = `${row.stakeholder_type}::${row.question_key}`
    if (!byQuestion.has(key)) {
      byQuestion.set(key, { key, label: shorten(row.question_text ?? row.question_key, 34), points: new Map() })
    }
    byQuestion.get(key).points.set(row.cycle_id, row)
  }

  // Ordered by opens_at, not label: the label is text and would sort lexically.
  cycles.sort((a, b) => new Date(a.opensAt) - new Date(b.opensAt))

  const series = [...byQuestion.values()]
  const data = cycles.map((cycle) => {
    const point = { cycle: cycle.label }
    for (const s of series) {
      const row = s.points.get(cycle.id)
      const value = row ? row[axis.key] : null
      point[s.key] = value === null || value === undefined ? null : Number(value)
      point[`${s.key}__versions`] = row?.versions_answered ?? 0
    }
    return point
  })

  return (
    <div>
      {axis.caption && <p className="muted small">{axis.caption}</p>}
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ left: 8, right: 24 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="cycle" />
          <YAxis domain={axis.domain} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={SERIES[i % SERIES.length]}
              strokeWidth={2}
              // Leaves a visible gap rather than joining across a missing cycle.
              connectNulls={false}
              // `key` is destructured out of what recharts passes and applied
              // directly. Spread into JSX it trips React's "props object
              // containing a 'key' prop is being spread" warning — an error in
              // a future major — and the dot does not get the key intended.
              dot={({ key, ...rest }) => (
                <VersionDot
                  key={key}
                  {...rest}
                  colour={SERIES[i % SERIES.length]}
                  seriesKey={s.key}
                />
              )}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <p className="muted small">
        A hollow marker means the answers at that point span more than one wording
        of the question, so the change may be the rewording rather than opinion.
      </p>
    </div>
  )
}

function VersionDot({ cx, cy, payload, colour, seriesKey }) {
  if (cx === null || cy === null || cx === undefined || cy === undefined) return null
  const mixed = (payload?.[`${seriesKey}__versions`] ?? 0) > 1

  return (
    <circle
      cx={cx}
      cy={cy}
      r={mixed ? 5 : 3.5}
      fill={mixed ? 'var(--surface, #fff)' : colour}
      stroke={colour}
      strokeWidth={2}
    />
  )
}

/** FR-38 for single/multi select questions. */
export function ChoiceChart({ rows, questionKey }) {
  const forQuestion = (rows ?? []).filter((r) => r.question_key === questionKey)
  if (!forQuestion.length) return <p className="muted">No choices recorded yet.</p>

  const data = forQuestion
    .map((row) => ({ label: shorten(row.option_label, 28), n: Number(row.n) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 15)

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, data.length * 28)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" allowDecimals={false} />
        <YAxis type="category" dataKey="label" width={190} tick={{ fontSize: 12 }} />
        <Tooltip />
        <Bar dataKey="n" name="Chosen by" fill={SERIES[1]} radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
