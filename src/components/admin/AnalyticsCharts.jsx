import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { axisFor, formatAvg, formatNormalised, spansVersions } from '../../lib/analytics/scales'

const SERIES = ['#818cf8', '#22d3ee', '#fbbf24', '#f472b6', '#a78bfa', '#34d399']

const BAR_ANIM = {
  isAnimationActive: true,
  animationBegin: 150,
  animationDuration: 1200,
  animationEasing: 'ease-out',
}
const PIE_COLORS = ['#818cf8', '#22d3ee', '#fbbf24', '#f472b6', '#a78bfa', '#34d399', '#fb923c', '#2dd4bf']
const SENTIMENT_COLORS = { positive: '#34d399', neutral: '#94a3b8', negative: '#f87171', none: '#475569' }

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
export function BreakdownPie({ data, height = 280, onSelect }) {
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
          onClick={onSelect ? (_, idx) => onSelect(data[idx]) : undefined}
          cursor={onSelect ? 'pointer' : undefined}
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
export function BreakdownBars({ data, height, onSelect }) {
  if (!data?.length) return null
  const h = height ?? Math.max(180, data.length * 32)
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" allowDecimals={false} />
        <YAxis type="category" dataKey="name" width={180} tick={{ fontSize: 12 }} />
        <Tooltip />
        <Bar
          dataKey="value"
          name="Responses"
          fill={SERIES[0]}
          radius={[0, 3, 3, 0]}
          onClick={onSelect ? (entry) => onSelect(entry) : undefined}
          cursor={onSelect ? 'pointer' : undefined}
          {...BAR_ANIM}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Sentiment donut: positive/neutral/negative/none. */
export function SentimentPie({ counts, height = 260, onSelect, selected }) {
  if (!counts) return null
  const data = [
    { name: 'Positive', label: 'positive', value: counts.positive, color: SENTIMENT_COLORS.positive },
    { name: 'Neutral', label: 'neutral', value: counts.neutral, color: SENTIMENT_COLORS.neutral },
    { name: 'Negative', label: 'negative', value: counts.negative, color: SENTIMENT_COLORS.negative },
    { name: 'No answer', label: 'none', value: counts.none, color: SENTIMENT_COLORS.none },
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
          onClick={onSelect ? (_, idx) => onSelect(data[idx].label) : undefined}
          cursor={onSelect ? 'pointer' : undefined}
        >
          {data.map((d, i) => (
            <Cell key={i} fill={d.color} opacity={selected && selected !== d.label ? 0.35 : 1} />
          ))}
        </Pie>
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  )
}

/** Top mentioned terms as a horizontal bar chart. */
export function TopTermsChart({ terms, height, selected, onSelect }) {
  if (!terms?.length) return null
  const data = terms.map((t) => ({ name: t.term, value: t.count }))
  const h = height ?? Math.max(160, data.length * 32)
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}
        onClick={(e) => onSelect?.(e?.activeLabel === selected ? null : e?.activeLabel ?? null)}
        style={onSelect ? { cursor: 'pointer' } : undefined}
      >
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" allowDecimals={false} />
        <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12 }} />
        <Tooltip />
        <Bar dataKey="value" name="Mentions" radius={[0, 3, 3, 0]} {...BAR_ANIM}>
          {data.map((entry) => (
            <Cell key={entry.name} fill={selected && entry.name !== selected ? '#555' : SERIES[1]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** FR-36: average per question. */
export function QuestionAverages({ rows, onSelect }) {
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
          <Bar
            dataKey="value"
            fill={SERIES[0]}
            radius={[0, 3, 3, 0]}
            onClick={onSelect ? (entry) => onSelect(entry.key) : undefined}
            cursor={onSelect ? 'pointer' : undefined}
            {...BAR_ANIM}
          >
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
        <Bar dataKey="n" name="Answers" radius={[3, 3, 0, 0]} {...BAR_ANIM}>
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

/** Grouped horizontal bars comparing the same question across stakeholder types. */
export function StakeholderComparisonChart({ data, stakeholders, height, onSelect, selected }) {
  if (!data?.length) return null
  const h = height ?? Math.max(280, data.length * 42)
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" domain={[0, 1]} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
        <YAxis type="category" dataKey="label" width={200} tick={{ fontSize: 12 }} />
        <Tooltip formatter={(v) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {stakeholders.map((st, i) => (
          <Bar
            key={st.key}
            dataKey={st.key}
            name={st.label}
            fill={SERIES[i % SERIES.length]}
            radius={[0, 3, 3, 0]}
            onClick={onSelect ? (entry) => onSelect(entry) : undefined}
            cursor={onSelect ? 'pointer' : undefined}
            {...BAR_ANIM}
          >
            {data.map((entry, j) => (
              <Cell key={j} opacity={selected && selected !== entry.label ? 0.35 : 1} />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Horizontal bars showing response rates, coloured by threshold. */
export function ParticipationChart({ data, height, onSelect, selected }) {
  if (!data?.length) return null
  const h = height ?? Math.max(180, data.length * 36)
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
        <YAxis type="category" dataKey="name" width={180} tick={{ fontSize: 12 }} />
        <Tooltip
          formatter={(v, _name, props) => [
            `${v.toFixed(1)}%`,
            `${props.payload.responded} of ${props.payload.provisioned}`,
          ]}
        />
        <Bar
          dataKey="rate"
          name="Response rate"
          radius={[0, 3, 3, 0]}
          onClick={onSelect ? (entry) => onSelect(entry) : undefined}
          cursor={onSelect ? 'pointer' : undefined}
          {...BAR_ANIM}
        >
          {data.map((entry, i) => {
            const base = entry.rate >= 50 ? '#34d399' : entry.rate >= 25 ? '#fbbf24' : '#f87171'
            const dimmed = selected && selected !== entry.name
            return <Cell key={i} fill={base} opacity={dimmed ? 0.35 : 1} />
          })}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Colour-coded table: question × department, cell = normalised average. */
export function HeatmapTable({ rows, onSelect, selected }) {
  if (!rows?.length) return <p className="muted">No department-level rating data in this slice.</p>

  const questions = []
  const deptSet = new Map()
  const grid = new Map()

  for (const row of rows) {
    if (!grid.has(row.question_key)) {
      questions.push({ key: row.question_key, text: row.question_text ?? row.question_key })
      grid.set(row.question_key, new Map())
    }
    if (row.department_id && !deptSet.has(row.department_id)) {
      deptSet.set(row.department_id, { id: row.department_id, name: row.department_name, code: row.department_code })
    }
    if (row.department_id) {
      grid.get(row.question_key).set(row.department_id, row)
    }
  }

  const departments = [...deptSet.values()]
  if (departments.length < 2) return <p className="muted">Need at least two departments with rating data for a heatmap.</p>

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Question</th>
            {departments.map((d) => (
              <th key={d.id} title={d.name}>{d.code || shorten(d.name, 12)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {questions.map((q) => {
            const isSelected = selected === q.key
            return (
              <tr
                key={q.key}
                onClick={onSelect ? () => onSelect(isSelected ? null : q.key) : undefined}
                style={onSelect ? { cursor: 'pointer' } : undefined}
                className={isSelected ? 'row-highlight' : undefined}
              >
                <td>{shorten(q.text, 38)}</td>
                {departments.map((d) => {
                  const cell = grid.get(q.key)?.get(d.id)
                  const avg = cell?.normalised_avg
                  return (
                    <td
                      key={d.id}
                      style={avg != null ? { backgroundColor: heatColor(Number(avg)), color: '#fff', textAlign: 'center', fontWeight: 600 } : { textAlign: 'center' }}
                      title={avg != null ? `${(avg * 100).toFixed(1)}% from ${cell.n_scored} scored answers` : 'No data'}
                    >
                      {avg != null ? `${(Number(avg) * 100).toFixed(0)}%` : '—'}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function heatColor(value) {
  const hue = Math.round(value * 140)
  return `hsl(${hue}, 65%, 48%)`
}

/** Sorted table of courses by normalised average. */
export function DepartmentRankingTable({ rows }) {
  if (!rows?.length) return <p className="muted">No department-level rating data in this slice.</p>
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr><th>#</th><th>Department</th><th>Stream</th><th>Avg</th><th>Normalised</th><th>Responses</th><th>Rated</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.department_id}>
              <td>{i + 1}</td>
              <td>{r.department_name}{r.department_code ? ` (${r.department_code})` : ''}</td>
              <td>{r.stream_name || '—'}</td>
              <td>{r.avg_score != null ? Number(r.avg_score).toFixed(2) : '—'}</td>
              <td>{r.normalised_avg != null ? `${(Number(r.normalised_avg) * 100).toFixed(1)}%` : '—'}</td>
              <td>{r.n_responses}</td>
              <td>{r.n_rated}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Table showing per-question delta between current and previous cycle. */
export function CycleDeltaTable({ rows }) {
  if (!rows?.length) return <p className="muted">No previous cycle to compare against.</p>
  const prevLabel = rows[0]?.previous_cycle || 'Previous'
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Question</th><th>Stakeholder</th>
            <th>Current</th><th>{prevLabel}</th><th>Delta</th>
            <th>n (now)</th><th>n (prev)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const d = r.delta != null ? Number(r.delta) : null
            return (
              <tr key={i}>
                <td>{shorten(r.question_text || r.question_key, 40)}</td>
                <td>{r.stakeholder_type}</td>
                <td>{r.current_normalised != null ? `${(Number(r.current_normalised) * 100).toFixed(1)}%` : '—'}</td>
                <td>{r.previous_normalised != null ? `${(Number(r.previous_normalised) * 100).toFixed(1)}%` : '—'}</td>
                <td style={{ color: d == null ? undefined : d > 0 ? '#34d399' : d < 0 ? '#f87171' : undefined, fontWeight: 600 }}>
                  {d == null ? '—' : `${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}%`}
                </td>
                <td>{r.current_n}</td>
                <td>{r.previous_n ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Area chart of submission counts over time. */
export function SubmissionTimelineChart({ rows, height = 300 }) {
  if (!rows?.length) return <p className="muted">No submission timestamps in this slice.</p>
  const byDay = new Map()
  for (const r of rows) {
    const key = r.day
    byDay.set(key, (byDay.get(key) || 0) + Number(r.submissions))
  }
  const data = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => ({ day, count }))

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ left: 8, right: 24 }}>
        <defs>
          <linearGradient id="timelineGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.5} />
            <stop offset="95%" stopColor={SERIES[0]} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.15} />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Area type="monotone" dataKey="count" name="Submissions" stroke={SERIES[0]} strokeWidth={2} fill="url(#timelineGrad)" />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** Stacked bars showing blank/short/substantive per text question. */
export function ResponseQualityChart({ rows, height }) {
  if (!rows?.length) return <p className="muted">No text questions in this slice.</p>
  const data = rows.map((r) => ({
    label: shorten(r.question_text || r.question_key, 36),
    Blank: Number(r.blank_answers),
    Short: Number(r.short_answers),
    Substantive: Number(r.substantive),
    avgLen: Number(r.avg_length),
  }))
  const h = height ?? Math.max(220, data.length * 36)
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" allowDecimals={false} />
        <YAxis type="category" dataKey="label" width={220} tick={{ fontSize: 11 }} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="Blank" stackId="q" fill="#f87171" radius={0} {...BAR_ANIM} />
        <Bar dataKey="Short" stackId="q" fill="#fbbf24" radius={0} {...BAR_ANIM} />
        <Bar dataKey="Substantive" stackId="q" fill="#34d399" radius={[0, 3, 3, 0]} {...BAR_ANIM} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Grouped bars: department avg vs college avg per question. */
export function DepartmentBenchmarkChart({ rows, height }) {
  if (!rows?.length) return <p className="muted">No department benchmark data — select a department first.</p>
  const data = rows.map((r) => ({
    label: shorten(r.question_text || r.question_key, 36),
    Department: r.dept_avg != null ? Number(r.dept_avg) : null,
    College: r.college_avg != null ? Number(r.college_avg) : null,
    delta: r.delta != null ? Number(r.delta) : null,
  }))
  const h = height ?? Math.max(240, data.length * 38)
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" domain={[0, 1]} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
        <YAxis type="category" dataKey="label" width={220} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => v != null ? `${(v * 100).toFixed(1)}%` : '—'} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="Department" fill={SERIES[1]} radius={[0, 3, 3, 0]} {...BAR_ANIM} />
        <Bar dataKey="College" fill={SERIES[4]} radius={[0, 3, 3, 0]} {...BAR_ANIM} />
      </BarChart>
    </ResponsiveContainer>
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
        <Bar dataKey="n" name="Chosen by" fill={SERIES[1]} radius={[0, 3, 3, 0]} {...BAR_ANIM} />
      </BarChart>
    </ResponsiveContainer>
  )
}
