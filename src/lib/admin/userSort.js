export function sortUserRows(rows, sort = 'recent', view = 'current') {
  const sorted = [...rows]
  const name = (row) => row.full_name?.trim() || row.email
  const dateValue = (row) => {
    const value = view === 'removed' ? row.removed_at : row.created_at
    return value ? new Date(value).getTime() : 0
  }
  const textCompare = (left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })

  sorted.sort((a, b) => {
    if (sort === 'oldest') return dateValue(a) - dateValue(b)
    if (sort === 'name_asc') return textCompare(name(a), name(b))
    if (sort === 'name_desc') return textCompare(name(b), name(a))
    if (sort === 'email_asc') return textCompare(a.email, b.email)
    return dateValue(b) - dateValue(a)
  })

  return sorted
}
