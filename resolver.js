const COMPANY_KEYWORDS = [
  {
    company: 'HackerRank',
    keywords: ['contest', 'assessment', 'hiring', 'candidate', 'recruiter', 'test', 'submission', 'leaderboard'],
  },
  {
    company: 'Claude',
    keywords: ['claude', 'anthropic', 'prompt', 'conversation', 'ai assistant', 'model', 'message'],
  },
  {
    company: 'Visa',
    keywords: ['payment', 'card', 'merchant', 'transaction', '3ds', 'chargeback', 'visa', 'billing', 'refund'],
  },
]

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function ensureTrace(trace) {
  if (!trace || typeof trace !== 'object') {
    throw new Error('trace object is required')
  }
}

export function resolveCompany(row, trace) {
  ensureTrace(trace)

  const providedCompany = normalize(row?.company)
  const issueText = normalize(row?.issue ?? row?.content ?? row?.description)

  if (providedCompany && providedCompany !== 'none') {
    trace.company = row.company
    trace.companySource = 'provided'
    trace.inferredFrom = ''
    return trace.company
  }

  for (const group of COMPANY_KEYWORDS) {
    for (const keyword of group.keywords) {
      if (keyword && issueText.includes(keyword)) {
        trace.company = group.company
        trace.companySource = 'inferred'
        trace.inferredFrom = keyword
        return trace.company
      }
    }
  }

  trace.company = 'Unknown'
  trace.companySource = 'inferred'
  trace.inferredFrom = ''
  return trace.company
}

function cleanIssue(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function splitIntents(issue) {
  const text = cleanIssue(issue)
  if (!text) return []

  const hasMultipleQuestions = (text.match(/\?/g) || []).length > 1
  const hasMarkers = /\b(?:and also|also|another question|additionally)\b/i.test(text)

  if (!hasMultipleQuestions && !hasMarkers) {
    return [text]
  }

  let parts = [text]

  // First split on question marks, then split any remaining compound markers.
  parts = parts.flatMap((segment) => segment.split(/\?+/g))
  parts = parts.flatMap((segment) => segment.split(/\b(?:and also|another question|additionally)\b/gi))
  parts = parts.flatMap((segment) => segment.split(/\balso\b/gi))

  const subIssues = parts.map(cleanIssue).filter((segment) => segment.length > 0)
  return subIssues.length > 0 ? subIssues : [text]
}

export function applyIntentSplit(issue, trace) {
  ensureTrace(trace)
  const subIssues = splitIntents(issue)
  trace.intentCount = subIssues.length || 1
  return subIssues
}

export default {
  resolveCompany,
  splitIntents,
  applyIntentSplit,
}
