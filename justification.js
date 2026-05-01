function formatScore(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return num.toFixed(2)
}

function companySentence(trace) {
  if (!trace?.company) return ''

  if (trace.companySource === 'provided') {
    return `Company provided as ${trace.company}.`
  }

  if (trace.companySource === 'inferred') {
    const keyword = trace.inferredFrom ? ` via keyword: ${trace.inferredFrom}` : ''
    return `Company inferred as ${trace.company}${keyword}.`
  }

  return `Company: ${trace.company}.`
}

function intentSentence(trace) {
  if (!trace || typeof trace.intentCount !== 'number') return ''
  if (trace.intentCount > 1) {
    return `Ticket was compound with ${trace.intentCount} intents.`
  }
  return `Ticket contained 1 intent.`
}

function safetySentence(trace) {
  const flags = Array.isArray(trace?.safetyFlags) ? trace.safetyFlags.filter(Boolean) : []
  if (flags.length === 0 && trace?.isJunk !== true) {
    return 'Pre-flight gate passed.'
  }
  if (flags.length === 0 && trace?.isJunk === true) {
    return 'Pre-flight gate marked ticket as junk.'
  }
  return `Pre-flight gate triggered flags: ${flags.join(', ')}.`
}

function retrievalSentence(trace) {
  const chunks = Array.isArray(trace?.retrievedChunks) ? trace.retrievedChunks : []
  if (chunks.length === 0) return ''

  const scores = chunks
    .map((chunk) => formatScore(chunk?.score))
    .filter(Boolean)
    .slice(0, 3)

  const scoreText = scores.length > 0 ? ` (${scores.join(', ')})` : ''
  return `Retrieved ${Math.min(3, chunks.length)} chunks${scoreText}.`
}

function groundingSentence(trace) {
  if (!trace?.groundingSource) return ''
  return `Grounded in: ${trace.groundingSource}.`
}

function confidenceSentence(trace) {
  if (typeof trace?.confidenceScore !== 'number') return ''
  const confidence = trace.confidenceScore.toFixed(2)
  const status = trace.status ? ` ${trace.status}` : ''
  const reason = trace.escalationReason ? ` — ${trace.escalationReason}` : ''
  return `Confidence: ${confidence}${status ? ` — ${status.trim()}` : ''}${reason}.`
}

function decisionSentence(trace) {
  if (!trace?.status) return ''
  const reason = trace.escalationReason ? ` because ${trace.escalationReason}` : ''
  return `Final decision: ${trace.status}${reason}.`
}

export function buildJustification(trace) {
  const parts = [
    companySentence(trace),
    intentSentence(trace),
    safetySentence(trace),
    retrievalSentence(trace),
    groundingSentence(trace),
    confidenceSentence(trace),
    decisionSentence(trace),
  ].filter(Boolean)

  return parts.join(' ')
}

export default { buildJustification }
