import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { axisFor, formatAvg, formatNormalised, spansVersions } from '../../lib/analytics/scales'

const SERIES = ['#2f6fb0', '#4a9c7d', '#c98a3c', '#a5566f', '#6b6ba8', '#7d8b95']
const PIE_COLORS = ['#2f6fb0', '#4a9c7d', '#c98a3c', '#a5566f', '#6b6ba8', '#7d8b95', '#5b9bd5', '#70ad47']
const SENTIMENT_COLORS = { positive: '#4a9c7d', neutral: '#7d8b95', negative: '#c0504d', none: '#d8dce3' }

const shorten = (text, max = 42) =>
  !text ? '' : text.length <= max ? text : `${text.slice(0, max - 1)}…`

function CustomPieLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }) {
  if (percent < 0.04) return null
  const RADIAN = Math.PI / 180
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5
  const x = cx + radius * Math.cos(-midAngle * RADIAN)
  const y = cy + radius * Math.sin(-midAngle * RADIAN)
  return (
    <text x={x} y={y} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={600}>
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  )
}

/** Donut chart for any name/value array. */
export function BreakdownPie({ data, height = 280 }) {
  if (!data?.length) return null
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={100}
          paddingAngle={2}
          label={CustomPieLabel}
          labelLine={false}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v) => v} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  )
}

/** Horizontal bar chart for breakdown rows. */
export function BreakdownBars({ data, height }) {
  if (!data?.length) return null
  const h = height ?? Math.max(180, data.length * 32)
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" allowDecimals={false} />
        <YAxis type="category" dataKey="name" width={180} tick={{ fontSize: 12 }} />
        <Tooltip />
        <Bar dataKey="value" name="Responses" fill={SERIES[0]} radius={[0, 3, 3, 0]}>
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Sentiment donut: positive/neutral/negative/none. */
export function SentimentPie({ counts, height = 260 }) {
  if (!counts) return null
  const data = [
    { name: 'Positive', value: counts.positive, color: SENTIMENT_COLORS.positive },
    { name: 'Neutral', value: counts.neutral, color: SENTIMENT_COLORS.neutral },
    { name: 'Negative', value: counts.negative, color: SENTIMENT_COLORS.negative },
    { name: 'No answer', value: counts.none, color: SENTIMENT_COLORS.none },
  ].filter((d) => d.value > 0)

  if (!data.length) return null
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={45}
          outerRadius={90}
          paddingAngle={2}
          label={CustomPieLabel}
          labelLine={false}
        >
          {data.map((d, i) => (
            <Cell key={i} fill={d.color} />
          ))}
        </Pie>
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  )
}

/** Top mentioned terms as a horizontal bar chart. */
export function TopTermsChart({ terms, height }) {
  if (!terms?.length) return null
  const data = terms.map((t) => ({ name: t.term, value: t.count }))
  const h = height ?? Math.max(160, data.length * 32)
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" allowDecimals={false} />
        <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12 }} />
        <Tooltip />
        <Bar dataKey="value" name="Mentions" fill={SERIES[1]} radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** FR-36: average per question. */
export function QuestionAverages({ rows }) {
  if (!rows?.length) return <p className="muted">No rating answers in this slice.</p>

  const axis = axisFor(rows)

  const data = rows.map((row) => ({
    key: row.question_key,
    label: shorten(row.question_text ?? row.question_key),
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
            <Cell key={entry.label} fill={entry.scoring ? SERIES[0] : SERIES[5]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

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
              connectNulls={false}
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
