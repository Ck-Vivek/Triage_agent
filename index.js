import fs from 'fs'
import path from 'path'
import csvParser from 'csv-parser'
import ora from 'ora'
import chalk from 'chalk'
import pLimit from 'p-limit'
import csvWriterPkg from 'csv-writer'

import * as safetyGate from './safetyGate.js'
import * as resolver from './resolver.js'
import { retrieve } from './retriever.js'
import { callAgent } from './agent.js'
import { validate } from './validator.js'
import { buildJustification } from './justification.js'

const { createObjectCsvWriter } = csvWriterPkg

const INPUT_FILE = path.resolve(process.cwd(), 'support_issues.csv')
const OUTPUT_FILE = path.resolve(process.cwd(), 'final.csv')
const CONCURRENCY = 2

const COMPANY_COLORS = {
  HackerRank: chalk.blue,
  Claude: chalk.green,
  Visa: chalk.yellow,
}

function createBaseTrace() {
  return {
    safetyFlags: [],
    isJunk: false,
    company: '',
    companySource: 'provided',
    inferredFrom: '',
    intentCount: 1,
    retrievedChunks: [],
    confidenceScore: 0,
    request_type: '',
    product_area: '',
    status: 'replied',
    escalationReason: null,
    groundingSource: '',
  }
}

function cloneTrace(trace) {
  return {
    ...createBaseTrace(),
    ...trace,
    safetyFlags: Array.isArray(trace?.safetyFlags) ? [...trace.safetyFlags] : [],
    retrievedChunks: Array.isArray(trace?.retrievedChunks)
      ? trace.retrievedChunks.map((chunk) => ({ ...chunk }))
      : [],
  }
}

function getIssueText(row) {
  return String(row?.issue ?? row?.content ?? row?.description ?? '').trim()
}

function colorCompany(company, text) {
  const colorFn = COMPANY_COLORS[company]
  return colorFn ? colorFn(text) : text
}

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = []
    fs.createReadStream(filePath)
      .on('error', reject)
      .pipe(csvParser())
      .on('data', (row) => rows.push(row))
      .on('error', reject)
      .on('end', () => resolve(rows))
  })
}

function mergeIntentResults(results, baseTrace) {
  if (results.length === 1) {
    const only = results[0]
    return {
      trace: only.trace,
      response: only.response,
      justification: only.justification,
    }
  }

  const mergedTrace = cloneTrace(baseTrace)
  const traces = results.map((result) => result.trace)
  const response = results.map((result) => result.response).filter(Boolean).join('\n\n')
  const productAreas = [...new Set(traces.map((trace) => String(trace.product_area || '').trim()).filter(Boolean))]
  const requestTypes = [...new Set(traces.map((trace) => String(trace.request_type || '').trim()).filter(Boolean))]
  const safetyFlags = [...new Set(traces.flatMap((trace) => trace.safetyFlags || []))]
  const retrievedChunks = traces
    .flatMap((trace) => trace.retrievedChunks || [])
    .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))
    .slice(0, 3)

  mergedTrace.intentCount = results.length
  mergedTrace.status = traces.some((trace) => trace.status === 'escalated') ? 'escalated' : 'replied'
  mergedTrace.product_area = productAreas.join(' / ')
  mergedTrace.request_type = requestTypes.join(' / ')
  mergedTrace.confidenceScore = traces.length
    ? Math.min(...traces.map((trace) => Number(trace.confidenceScore) || 0))
    : 0
  mergedTrace.safetyFlags = safetyFlags
  mergedTrace.retrievedChunks = retrievedChunks
  mergedTrace.groundingSource = retrievedChunks[0]?.source || baseTrace.groundingSource || ''
  mergedTrace.escalationReason = traces.map((trace) => trace.escalationReason).filter(Boolean).join(' | ') || null

  const justification = buildJustification(mergedTrace)

  return {
    trace: mergedTrace,
    response,
    justification,
  }
}

async function processIntent(issueText, baseTrace, ticketNumber, intentNumber, spinner, loggerPrefix) {
  const trace = cloneTrace(baseTrace)
  trace.intentCount = 1

  spinner.text = `Processing ticket #${ticketNumber}${intentNumber > 1 ? `.${intentNumber}` : ''}`

  await retrieve(issueText, trace.company, trace)

  const safetyLocked = String(baseTrace.escalationReason || '').startsWith('safety flag:')
  const agentResult = await callAgent(issueText, trace.retrievedChunks, trace)

  validate(issueText, agentResult.response, trace)

  if (safetyLocked) {
    trace.status = 'escalated'
    trace.escalationReason = baseTrace.escalationReason
  }

  const justification = buildJustification(trace)

  console.log(`${loggerPrefix} ${colorCompany(trace.company, trace.company || 'Unknown')} ${trace.status}`)

  return {
    trace,
    response: agentResult.response,
    justification,
  }
}

async function processRow(row, ticketNumber, spinner, activeTickets) {
  activeTickets.add(ticketNumber)

  try {
    const issueText = getIssueText(row)
    const baseTrace = createBaseTrace()

    safetyGate.runSafetyGate(issueText, baseTrace)
    resolver.resolveCompany(row, baseTrace)

    const subIssues = resolver.splitIntents(issueText)
    baseTrace.intentCount = subIssues.length || 1

    console.log(
      `${colorCompany(baseTrace.company, baseTrace.company || 'Unknown')} | Ticket #${ticketNumber} | ` +
        `${subIssues.length > 1 ? `${subIssues.length} intents` : 'single intent'}`
    )

    const loggerPrefix = `[Ticket #${ticketNumber}]`
    const results = await Promise.all(
      subIssues.map((subIssue, index) =>
        processIntent(subIssue, baseTrace, ticketNumber, index + 1, spinner, loggerPrefix)
      )
    )

    const merged = mergeIntentResults(results, baseTrace)
    const outputTrace = merged.trace

    return {
      status: outputTrace.status,
      product_area: outputTrace.product_area,
      response: merged.response,
      justification: merged.justification,
      request_type: outputTrace.request_type,
      ticketNumber,
    }
  } finally {
    activeTickets.delete(ticketNumber)
  }
}

function createSpinner() {
  return ora('Loading support issues...').start()
}

function updateSpinner(spinner, activeTickets, latestTicket) {
  if (activeTickets.size === 0) {
    spinner.text = 'Waiting for tickets...'
    return
  }

  const activeList = [...activeTickets].sort((a, b) => a - b).join(', ')
  spinner.text = `Processing ticket #${latestTicket} (active: ${activeList})`
}

async function main() {
  const startedAt = Date.now()

  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Input file not found: ${INPUT_FILE}`)
  }

  const rows = await readCsv(INPUT_FILE)
  const spinner = createSpinner()
  const activeTickets = new Set()
  const limit = pLimit(CONCURRENCY)

  let latestTicket = 0
  const tasks = rows.map((row, index) =>
    limit(async () => {
      const ticketNumber = index + 1
      latestTicket = ticketNumber
      updateSpinner(spinner, activeTickets, latestTicket)
      const result = await processRow(row, ticketNumber, spinner, activeTickets)
      updateSpinner(spinner, activeTickets, latestTicket)
      return result
    })
  )

  const results = await Promise.all(tasks)
  await new Promise((r) => setTimeout(r, 2000))

  spinner.succeed('Processing complete')

  const sorted = results.sort((a, b) => a.ticketNumber - b.ticketNumber)

  const csvWriter = createObjectCsvWriter({
    path: OUTPUT_FILE,
    header: [
      { id: 'status', title: 'status' },
      { id: 'product_area', title: 'product_area' },
      { id: 'response', title: 'response' },
      { id: 'justification', title: 'justification' },
      { id: 'request_type', title: 'request_type' },
    ],
  })

  await csvWriter.writeRecords(
    sorted.map(({ status, product_area, response, justification, request_type }) => ({
      status,
      product_area,
      response,
      justification,
      request_type,
    }))
  )

  const repliedCount = sorted.filter((row) => row.status === 'replied').length
  const escalatedCount = sorted.filter((row) => row.status === 'escalated').length
  const elapsedMs = Date.now() - startedAt

  console.log(chalk.bold(`Total processed: ${sorted.length}`))
  console.log(chalk.green(`Replied: ${repliedCount}`))
  console.log(chalk.yellow(`Escalated: ${escalatedCount}`))
  console.log(chalk.cyan(`Time taken: ${elapsedMs}ms`))
}

main().catch((error) => {
  console.error(chalk.red(error.stack || error.message || String(error)))
  process.exitCode = 1
})
