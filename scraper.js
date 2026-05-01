import axios from 'axios'
import * as cheerio from 'cheerio'
import { chromium } from 'playwright'
import { writeFile } from 'fs/promises'
import path from 'path'
import ora from 'ora'
import chalk from 'chalk'

const SITES = [
  { company: 'HackerRank', url: 'https://support.hackerrank.com/' },
  { company: 'Claude', url: 'https://support.claude.com/en/' },
  { company: 'Visa', url: 'https://www.visa.co.in/support.html' },
]

function cleanText(str) {
  return str.replace(/\s+/g, ' ').trim()
}

function stripHtmlTags(html) {
  return html.replace(/<[^>]*>/g, '')
}

async function fetchWithAxios(url) {
  const res = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Guardian-Triage-Agent/1.0 (+https://example.org)' },
  })
  return res.data
}

async function fetchWithPlaywright(url) {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  const content = await page.content()
  await browser.close()
  return content
}

function extractTexts(html) {
  const $ = cheerio.load(html)
  const texts = []
  $('p, li, h2, h3').each((i, el) => {
    const txt = cleanText($(el).text() || '')
    if (txt && txt.length >= 30) texts.push(txt)
  })
  return texts
}

function extractTextsStrict(html) {
  const $ = cheerio.load(html)
  const texts = []
  $('p, li').each((i, el) => {
    const txt = cleanText($(el).text() || '')
    if (txt && txt.length >= 40) texts.push(txt)
  })
  return texts
}

function isMarketingContent(text) {
  const lowerText = text.toLowerCase()
  const marketingPhrases = [
    'industry benchmark',
    'most intelligent',
    'state of the art',
    'introducing',
    'announcing',
  ]
  
  for (const phrase of marketingPhrases) {
    if (lowerText.includes(phrase)) {
      return true
    }
  }
  
  return false
}

function isSupportContent(text) {
  const lowerText = text.toLowerCase()
  const supportWords = [
    'how', 'what', 'why',
    'error', 'issue', 'problem',
    'help', 'support', 'unable', "can't", "cannot",
    'contact', 'account', 'billing', 'refund',
  ]
  
  for (const word of supportWords) {
    if (lowerText.includes(word)) {
      return true
    }
  }
  
  return false
}

function filterSupportContent(texts) {
  return texts.filter(text => {
    // Exclude marketing content
    if (isMarketingContent(text)) {
      return false
    }
    
    // Keep only support-oriented content (for Claude)
    // For other sites, be less strict
    return true
  })
}

// Site-specific scrapers
async function scrapeHackerRank(spinner, verbose) {
  const urls = [
    'https://www.hackerrank.com/work/faq',
    'https://support.hackerrank.com/hc/en-us',
    'https://www.hackerrank.com/faqs',
  ]
  const texts = []

  for (const url of urls) {
    try {
      spinner.text = `Scraping HackerRank: ${url.split('/').pop() || url.split('/')[2]}`
      const html = await fetchWithAxios(url)
      
      if (!html || html.length < 500) {
        if (verbose) console.log(chalk.yellow(`  Content too small (${html?.length || 0} chars), trying next URL...`))
        continue
      }

      const $ = cheerio.load(html)
      const extracted = []
      $('p, li, h2, h3').each((i, el) => {
        const txt = cleanText($(el).text() || '')
        if (txt && txt.length >= 40) {
          extracted.push(txt)
        }
      })

      if (extracted.length > 0) {
        for (const txt of extracted) {
          texts.push({ content: txt, source: 'www.hackerrank.com', url: url })
        }
        if (verbose) console.log(chalk.green(`  ✓ Extracted ${extracted.length} items from ${url}`))
        return texts
      } else {
        if (verbose) console.log(chalk.yellow(`  No valid content extracted, trying next URL...`))
      }
    } catch (err) {
      if (verbose) console.log(chalk.yellow(`  Failed (${err.message}), trying next URL...`))
    }
  }

  if (texts.length === 0) {
    console.log(chalk.red(`⚠ HackerRank: Could not scrape any content from provided URLs`))
  }

  return texts
}

async function scrapeClaude(spinner, verbose) {
  const urls = [
    'https://support.claude.com/',
    'https://support.claude.com/hc/en-us',
    'https://help.claude.ai/',
    'https://www.anthropic.com/research',
    'https://claude.ai/faq',
    'https://www.anthropic.com/claude',
    'https://docs.anthropic.com/en/docs/intro-to-claude',
  ]
  const texts = []
  const seenContent = new Set() // Deduplicate across URLs

  // Try all URLs to maximize coverage
  for (const url of urls) {
    try {
      spinner.text = `Scraping Claude: ${url.split('/').pop() || url.split('/')[2]}`
      const html = await fetchWithAxios(url)
      
      if (!html || html.length < 500) {
        if (verbose) console.log(chalk.yellow(`  Content too small (${html?.length || 0} chars)`))
        continue
      }

      const $ = cheerio.load(html)
      const extracted = []
      $('p, li, h2, h3').each((i, el) => {
        const txt = cleanText($(el).text() || '')
        if (txt && txt.length >= 40) {
          extracted.push(txt)
        }
      })

      // Apply content quality filter to remove marketing content
      const filtered = filterSupportContent(extracted)

      if (filtered.length > 0) {
        let added = 0
        for (const txt of filtered) {
          if (!seenContent.has(txt)) {
            seenContent.add(txt)
            texts.push({ content: txt, source: 'www.anthropic.com', url: url })
            added += 1
          }
        }
        if (verbose && added > 0) {
          console.log(chalk.green(`  ✓ Added ${added} new items from ${url} (${extracted.length} extracted, ${filtered.length} after filtering)`))
        } else if (verbose) {
          console.log(chalk.yellow(`  No new items (duplicates or filtered)`))
        }
      } else {
        if (verbose) console.log(chalk.yellow(`  No valid support content extracted`))
      }
    } catch (err) {
      if (verbose) console.log(chalk.yellow(`  Failed (${err.message})`))
    }
  }

  if (texts.length === 0) {
    console.log(chalk.red(`⚠ Claude: Could not scrape any support content from provided URLs`))
  }

  return texts
}

async function scrapeVisa(spinner, verbose) {
  const url = 'https://www.visa.co.in/support.html'
  const texts = []

  try {
    spinner.text = 'Fetching Visa support page...'
    let html = null
    let usedPlaywright = false

    // Try axios first
    try {
      html = await fetchWithAxios(url)
    } catch (err) {
      if (verbose) console.log(chalk.yellow(`Visa axios failed: ${err.message}, trying Playwright...`))
      html = await fetchWithPlaywright(url)
      usedPlaywright = true
    }

    if (html) {
      const extracted = extractTexts(html)
      for (const txt of extracted) {
        texts.push({ content: txt, source: 'www.visa.co.in', url: url })
      }
    }

    if (verbose) console.log(chalk.green(`Visa: extracted ${texts.length} entries${usedPlaywright ? ' (via Playwright)' : ''}`))
    return texts
  } catch (err) {
    if (verbose) console.log(chalk.red(`Visa scraping failed: ${err.message}`))
    return []
  }
}

export default async function scrapeSites({ out = 'corpus.json', verbose = true } = {}) {
  const outPath = path.join(process.cwd(), out)
  const seen = new Set()
  const results = []
  const siteCounts = { HackerRank: 0, Claude: 0, Visa: 0 }

  // Scrape HackerRank using Zendesk API
  const spinner = ora({ text: 'Scraping HackerRank', spinner: 'dots' }).start()
  try {
    const hrTexts = await scrapeHackerRank(spinner, verbose)
    for (const item of hrTexts) {
      const key = item.content
      if (!seen.has(key)) {
        seen.add(key)
        results.push({ company: 'HackerRank', content: item.content, source: item.source, url: item.url })
        siteCounts.HackerRank += 1
      }
    }
    spinner.succeed(`HackerRank: ${siteCounts.HackerRank} entries`)
  } catch (err) {
    spinner.fail(`HackerRank failed: ${err.message}`)
    if (verbose) console.log(chalk.red(err.message))
  }

  // Scrape Claude using multiple strategies
  const spinner2 = ora({ text: 'Scraping Claude', spinner: 'dots' }).start()
  try {
    const claudeTexts = await scrapeClaude(spinner2, verbose)
    for (const item of claudeTexts) {
      const key = item.content
      if (!seen.has(key)) {
        seen.add(key)
        results.push({ company: 'Claude', content: item.content, source: item.source, url: item.url })
        siteCounts.Claude += 1
      }
    }
    spinner2.succeed(`Claude: ${siteCounts.Claude} entries`)
  } catch (err) {
    spinner2.fail(`Claude failed: ${err.message}`)
    if (verbose) console.log(chalk.red(err.message))
  }

  // Scrape Visa using existing logic
  const spinner3 = ora({ text: 'Scraping Visa', spinner: 'dots' }).start()
  try {
    const visaTexts = await scrapeVisa(spinner3, verbose)
    for (const item of visaTexts) {
      const key = item.content
      if (!seen.has(key)) {
        seen.add(key)
        results.push({ company: 'Visa', content: item.content, source: item.source, url: item.url })
        siteCounts.Visa += 1
      }
    }
    spinner3.succeed(`Visa: ${siteCounts.Visa} entries`)
  } catch (err) {
    spinner3.fail(`Visa failed: ${err.message}`)
    if (verbose) console.log(chalk.red(err.message))
  }

  // Write results
  try {
    await writeFile(outPath, JSON.stringify(results, null, 2), 'utf8')
    const absolutePath = path.resolve(outPath)
    
    console.log('\n' + chalk.bold('Scraping Summary:'))
    console.log(chalk.cyan(`HackerRank: ${siteCounts.HackerRank} entries`))
    console.log(chalk.cyan(`Claude: ${siteCounts.Claude} entries`))
    console.log(chalk.cyan(`Visa: ${siteCounts.Visa} entries`))
    console.log(chalk.blue(`Total: ${results.length} entries`))
    console.log(chalk.blue(`✓ Saved to: ${absolutePath}\n`))
  } catch (err) {
    throw new Error(`Failed to write corpus file to ${outPath}: ${err.message}`)
  }

  return results
}

// If run directly, execute and write corpus.json
if (process.argv[1] && process.argv[1].endsWith('scraper.js')) {
  scrapeSites().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
