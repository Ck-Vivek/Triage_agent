import dotenv from 'dotenv'
import { GoogleGenerativeAI } from '@google/generative-ai'
import chalk from 'chalk'

dotenv.config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' })

function ensureTrace(trace) {
  if (!trace || typeof trace !== 'object') {
    throw new Error('trace object is required')
  }
}

function formatRetrievedChunks(retrievedChunks) {
  const chunks = Array.isArray(retrievedChunks) ? retrievedChunks : []
  if (chunks.length === 0) return 'No retrieved corpus chunks were provided.'

  return chunks
    .map((chunk, index) => {
      const score = typeof chunk?.score === 'number' ? chunk.score.toFixed(4) : '0.0000'
      const source = String(chunk?.source || '').trim() || 'unknown source'
      const content = String(chunk?.content || '').trim()
      return `Chunk ${index + 1}\nSource: ${source}\nScore: ${score}\nContent: ${content}`
    })
    .join('\n\n')
}

function buildSystemPrompt(retrievedChunks) {
  return [
    'You are a support triage agent for a multi-domain support workflow.',
    'You must answer only using the retrieved corpus chunks below as your knowledge source.',
    'You must not use outside knowledge, prior training assumptions, or unstated facts.',
    'If the chunks do not support a confident answer, escalate instead of guessing.',
    '',
    'Allowed output fields and valid values:',
    '- status: "replied" or "escalated"',
    '- product_area: a short string describing the affected area',
    '- response: a concise support response grounded only in the retrieved chunks',
    '- request_type: "product_issue", "feature_request", "bug", or "invalid"',
    '- confidence: a number between 0 and 1',
    '- reasoning: internal reasoning text for evaluation only; keep it brief and do not expose hidden chain-of-thought in the response to the end user',
    '',
    'Return JSON only and ensure it matches the exact schema requested by the caller.',
    '',
    'Retrieved corpus chunks:',
    formatRetrievedChunks(retrievedChunks),
  ].join('\n')
}

function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) throw new Error('empty Gemini response')

  try {
    return JSON.parse(raw)
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced) {
      return JSON.parse(fenced[1].trim())
    }

    const first = raw.indexOf('{')
    const last = raw.lastIndexOf('}')
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1))
    }

    throw new Error('Gemini response was not valid JSON')
  }
}

function normalizeResult(parsed) {
  const status = parsed.status === 'escalated' ? 'escalated' : 'replied'
  const requestType = ['product_issue', 'feature_request', 'bug', 'invalid'].includes(parsed.request_type)
    ? parsed.request_type
    : 'invalid'
  const confidence = Number.isFinite(Number(parsed.confidence))
    ? Math.min(1, Math.max(0, Number(parsed.confidence)))
    : 0

  return {
    status,
    product_area: String(parsed.product_area || '').trim(),
    response: String(parsed.response || '').trim(),
    request_type: requestType,
    confidence,
    reasoning: String(parsed.reasoning || '').trim(),
  }
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

export async function callAgent(issue, retrievedChunks, trace) {
  ensureTrace(trace)

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required')
  }

  const systemPrompt = buildSystemPrompt(retrievedChunks)
  const prompt = `${systemPrompt}\n\nUser issue: ${String(issue ?? '')}`

  // Exponential backoff retry logic for 429 and 503
  const delays = [1000, 2000, 4000]
  let lastErr = null
  let result = null

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await model.generateContent(prompt)
      break
    } catch (err) {
      lastErr = err
      const statusCode = err?.status || err?.response?.status || null

      // Immediately fail on 400 or 401
      if (statusCode === 400 || statusCode === 401) {
        throw err
      }

      // Retry only on 429 or 503
      if (statusCode === 429 || statusCode === 503) {
        if (attempt < 2) {
          const wait = delays[attempt]
          console.log(chalk.yellow(`Retry attempt ${attempt + 1}: waiting ${wait}ms before retrying`))
          await sleep(wait)
          continue
        }
        // exhausted retries; will fall through to fallback handling
      }

      // For any other error, do not retry here; fall back
      break
    }
  }

  if (result) {
    const text = result.response.text()
    const parsed = normalizeResult(extractJson(text))

    trace.confidenceScore = parsed.confidence
    trace.status = parsed.status
    trace.product_area = parsed.product_area || getDefaultProductArea(trace)
    trace.request_type = parsed.request_type || getDefaultRequestType(trace)
    trace.fallbackUsed = false

    return {
      ...parsed,
      product_area: trace.product_area,
      request_type: trace.request_type,
    }
  }

  // If we reach here, lastErr contains the failure after retries (if any)
  const err = lastErr
  const statusCode = err?.status || err?.response?.status || null
  const message = String(err?.message || '').toLowerCase()

  const retryableOrNetwork = statusCode === 429 || statusCode === 503 || /econnreset|etimedout|enotfound|network|timeout|fetch/i.test(message) || !!err?.code

  if (retryableOrNetwork) {
    // Heuristic fallback mode
    trace.fallbackUsed = true

    const chunks = Array.isArray(retrievedChunks) ? retrievedChunks : []
    const top = chunks[0]

    if (top && typeof top.score === 'number' && top.score > 0.4) {
      const chunkContent = String(top.content || '').trim().slice(0, 200)
      const response = `Based on our support documentation: ${chunkContent}. For further assistance, please contact our support team directly.`
      const scoreFormatted = (Number(top.score) || 0).toFixed(4)
      
      const defaultProductArea = getDefaultProductArea(trace)
      const defaultRequestType = getDefaultRequestType(trace)
      
      const out = {
        status: 'replied',
        product_area: defaultProductArea,
        response,
        request_type: defaultRequestType,
        confidence: Math.min(1, Math.max(0, Number(top.score) || 0.5)),
        reasoning: `Note: Gemini API unavailable — heuristic fallback used with corpus chunk score: ${scoreFormatted}`,
      }

      trace.confidenceScore = out.confidence
      trace.status = out.status
      trace.product_area = out.product_area
      trace.request_type = out.request_type

      return out
    }

    // No good local context — escalate
    trace.fallbackUsed = true
    trace.status = 'escalated'
    trace.escalationReason = 'API failure & no local context found'
    trace.confidenceScore = 0

    const defaultProductArea = getDefaultProductArea(trace)
    const defaultRequestType = getDefaultRequestType(trace)

    return {
      status: 'escalated',
      product_area: defaultProductArea,
      response: '',
      request_type: defaultRequestType,
      confidence: 0,
      reasoning: 'heuristic_fallback: no local context',
    }
  }

  // Unknown error — rethrow
  throw err
}

export default { callAgent }
