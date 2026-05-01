function ensureTrace(trace) {
  if (!trace || typeof trace !== 'object') {
    throw new Error('trace object is required')
  }
}

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(value) {
  return normalize(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(' ')
    .filter((token) => token.length > 2)
}

function chunkText(chunk) {
  return String(chunk?.content || chunk?.text || '').trim()
}

function chunkKeywords(chunk) {
  const text = chunkText(chunk)
  if (!text) return []

  const words = tokenize(text)
  const phrases = []

  for (let i = 0; i < words.length - 1; i++) {
    phrases.push(`${words[i]} ${words[i + 1]}`)
  }

  return [...new Set([...words, ...phrases])]
}

function hasGroundingOverlap(response, retrievedChunks) {
  const responseText = normalize(response)
  if (!responseText) return false

  const responseTokens = new Set(tokenize(responseText))
  const responsePairs = new Set()
  const responseWords = [...responseTokens]
  for (let i = 0; i < responseWords.length - 1; i++) {
    responsePairs.add(`${responseWords[i]} ${responseWords[i + 1]}`)
  }

  for (const chunk of Array.isArray(retrievedChunks) ? retrievedChunks : []) {
    for (const keyword of chunkKeywords(chunk)) {
      if (keyword.length > 2 && (responseText.includes(keyword) || responseTokens.has(keyword) || responsePairs.has(keyword))) {
        return true
      }
    }
  }

  return false
}

function detectHighRisk(issue) {
  const text = normalize(issue)
  const patterns = [
    { keyword: 'fraud', regex: /\bfraud\b/i },
    { keyword: 'hacked', regex: /\bhacked\b/i },
    { keyword: 'unauthorized', regex: /\bunauthorized\b/i },
    { keyword: 'stolen', regex: /\bstolen\b/i },
    { keyword: 'chargeback', regex: /\bchargeback\b/i },
    { keyword: 'legal', regex: /\blegal\b/i },
    { keyword: 'lawsuit', regex: /\blawsuit\b/i },
  ]

  for (const pattern of patterns) {
    if (pattern.regex.test(text)) return pattern.keyword
  }

  return ''
}

function getDefaultProductArea(trace) {
  const company = String(trace?.company || '').trim()
  if (company) return `${company} Support`
  return 'Support'
}

function getDefaultRequestType(trace) {
  const safetyFlags = Array.isArray(trace?.safetyFlags) ? trace.safetyFlags : []
  const escalationReason = String(trace?.escalationReason || '').toLowerCase()
  
  // Priority 1: If PII or credit_card detected in safetyFlags → product_issue
  if (safetyFlags.some(f => /pii|credit_card/.test(f))) {
    return 'product_issue'
  }
  
  // Priority 2: If escalationReason includes 'not grounded' → invalid
  if (escalationReason.includes('not grounded')) {
    return 'invalid'
  }
  
  // Priority 3: If escalationReason includes 'API failure' → product_issue
  if (escalationReason.includes('api failure')) {
    return 'product_issue'
  }
  
  // Default fallback → product_issue
  return 'product_issue'
}

export function validate(issue, response, trace) {
  ensureTrace(trace)

  if (typeof trace.confidenceScore !== 'number') {
    trace.confidenceScore = Number(trace.confidenceScore) || 0
  }

  let escalateReason = ''

  const highRiskKeyword = detectHighRisk(issue)
  if (highRiskKeyword) {
    escalateReason = `high-risk domain: ${highRiskKeyword}`
  }

  if (!escalateReason && !hasGroundingOverlap(response, trace.retrievedChunks)) {
    escalateReason = 'response not grounded in corpus'
  }

  if (!escalateReason && trace.confidenceScore < 0.6) {
    escalateReason = `low confidence: ${trace.confidenceScore}`
  }

  if (escalateReason) {
    trace.status = 'escalated'
    trace.escalationReason = escalateReason
  }

  // Ensure product_area and request_type are never empty
  if (!trace.product_area || String(trace.product_area).trim() === '') {
    trace.product_area = getDefaultProductArea(trace)
  }

  if (!trace.request_type || String(trace.request_type).trim() === '') {
    trace.request_type = getDefaultRequestType(trace)
  }

  return trace
}

export default { validate }
