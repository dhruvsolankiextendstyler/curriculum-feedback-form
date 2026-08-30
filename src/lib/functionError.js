/**
 * Turns a supabase-js Edge Function failure into a message someone can act on.
 *
 * `functions.invoke` reports a non-2xx response as an error whose `context` is
 * the raw Response, so the function's own JSON `{ error }` body — the only
 * message written for a human — is not on `error.message` and has to be read
 * out. The status-specific fallbacks matter just as much: a 404 here means the
 * function was never deployed, which is otherwise a mystifying failure.
 */
export async function describeFunctionError(
  error,
  { slug, statusHints = {}, fallback = 'The request failed.' } = {},
) {
  const status = error?.context?.status

  const body = await readJsonBody(error)
  if (typeof body?.error === 'string' && body.error.trim()) return body.error

  if (statusHints[status]) return statusHints[status]

  if (status === 404) {
    return (
      `The "${slug}" Edge Function is not deployed to this Supabase project. ` +
      `Deploy it with: supabase functions deploy ${slug}`
    )
  }
  if (status === 429) {
    return 'Too many attempts from this network. Please wait a minute and try again.'
  }
  if (status === 500 && typeof body?.message === 'string' && body.message.trim()) {
    return body.message
  }

  return error?.message || fallback
}

async function readJsonBody(error) {
  try {
    return await error?.context?.json?.()
  } catch {
    // A platform error page is HTML, and a network failure has no body at all.
    return null
  }
}
