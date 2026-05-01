/**
 * Rule-based safety gate for Guardian Triage Agent
 * Exports: `runSafetyGate(issue, trace)`
 * - Populates `trace.safetyFlags` (array of strings)
 * - Sets `trace.isJunk` for empty/nonsense input
 * - Escalates (`trace.status = 'escalated'`) when critical flags found
 */

function ensureTrace(trace) {
  if (!trace || typeof trace !== 'object') throw new Error('trace object required')
  if (!Array.isArray(trace.safetyFlags)) trace.safetyFlags = []
}

function addFlag(trace, flag) {
  if (!trace.safetyFlags.includes(flag)) trace.safetyFlags.push(flag)
}

function luhnCheck(digits) {
  const arr = digits.split('').reverse().map((d) => parseInt(d, 10))
  let sum = 0
  for (let i = 0; i < arr.length; i++) {
    let val = arr[i]
    if (i % 2 === 1) {
      val *= 2
      if (val > 9) val -= 9
    }
    sum += val
  }
  return sum % 10 === 0
}

export function runSafetyGate(issue, trace) {
  ensureTrace(trace)
  const text = (issue || '') + ''
  const normalized = text.trim()

  // Junk / empty checks
  if (!normalized) {
    addFlag(trace, 'junk: empty')
    trace.isJunk = true
  }

  if (!trace.isJunk && normalized.length < 10) {
    addFlag(trace, 'junk: too_short')
    trace.isJunk = true
  }

  // keyboard spam patterns
  const spamPatterns = [/qwerty/i, /asdf/i, /jkl;/i, /asdfgh/i, /zxcvbn/i]
  if (!trace.isJunk && spamPatterns.some((r) => r.test(normalized))) {
    addFlag(trace, 'junk: keyboard_spam')
    trace.isJunk = true
  }

  // high non-alpha ratio
  if (!trace.isJunk) {
    const nonAlpha = (normalized.match(/[^a-zA-Z0-9\s]/g) || []).length
    const ratio = nonAlpha / Math.max(1, normalized.length)
    if (ratio > 0.6) {
      addFlag(trace, 'junk: high_nonalpha_ratio')
      trace.isJunk = true
    }
  }

  // Prompt injection phrases (case-insensitive)
  const injectionPhrases = [
    /ignore (the )?previous/i,
    /disregard (the )?instructions/i,
    /you are now/i,
    /forget (the )?previous/i,
    /ignore (these )?instructions/i,
    /override (previous|instructions)/i,
    /do anything now/i,
  ]
  for (const rx of injectionPhrases) {
    if (rx.test(normalized)) {
      addFlag(trace, 'prompt_injection')
      break
    }
  }

  // PII detection
  // emails
  const emailRx = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
  if (emailRx.test(normalized)) addFlag(trace, 'pii: email')

  // phone numbers: sequences of 7-15 digits with separators
  const phoneRx = /(?:\+?\d[\d\s().-]{6,}\d)/
  if (phoneRx.test(normalized)) addFlag(trace, 'pii: phone')

  // credit card numbers: extract digit groups and Luhn-check
  const ccCandidateRx = /\b(?:\d[ -]*){13,19}\b/g
  const ccMatches = normalized.match(ccCandidateRx) || []
  for (const m of ccMatches) {
    const digits = m.replace(/[^0-9]/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
      addFlag(trace, 'pii: credit_card')
      break
    }
  }

  // Malicious patterns: SQL injection, script tags, command exec
  const maliciousPatterns = [
    /<script\b[^>]*>([\s\S]*?)<\/script>/i,
    /;\s*--/, // SQL comment after semicolon
    /\b(drop|delete|insert|update)\b\s+\b(table|into)\b/i,
    /union\s+select/i,
    /\b(or|and)\b\s+1\s*=\s*1/i,
    /xp_cmdshell/i,
    /\bexec\b\s*\(/i,
    /\/\*/, // comment start
  ]
  for (const rx of maliciousPatterns) {
    if (rx.test(normalized)) {
      addFlag(trace, 'malicious: injection_or_script')
      break
    }
  }

  // If any critical flags (prompt_injection, pii, malicious) -> escalate
  const critical = trace.safetyFlags.find((f) => /prompt_injection|pii|malicious/.test(f))
  if (critical) {
    trace.status = 'escalated'
    trace.escalationReason = `safety flag: ${critical}`
  }

  // Ensure isJunk is boolean
  if (typeof trace.isJunk !== 'boolean') trace.isJunk = false

  return trace
}

export default runSafetyGate
