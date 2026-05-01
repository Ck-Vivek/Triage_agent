import dotenv from 'dotenv'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { readFile } from 'fs/promises'
import path from 'path'

dotenv.config()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' })

let corpusCache = null
let corpusLoadPromise = null

async function loadCorpus() {
  if (corpusCache) return corpusCache
  if (!corpusLoadPromise) {
    corpusLoadPromise = (async () => {
      const corpusPath = path.resolve(process.cwd(), 'corpus.json')
      try {
        const raw = await readFile(corpusPath, 'utf8')
        const parsed = JSON.parse(raw)
        corpusCache = Array.isArray(parsed) ? parsed : []
      } catch {
        corpusCache = []
      }
      return corpusCache
    })()
  }
  return corpusLoadPromise
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(value) {
  const text = normalizeText(value)
  if (!text) return []
  return text.split(' ').filter(Boolean)
}

function tfIdfVectorize(items) {
  const docs = items.map((item) => tokenize(item))
  const vocab = new Map()

  for (const doc of docs) {
    const unique = new Set(doc)
    for (const token of unique) {
      vocab.set(token, (vocab.get(token) || 0) + 1)
    }
  }

  const terms = [...vocab.keys()]
  const vectors = docs.map((doc) => {
    const termCounts = new Map()
    for (const token of doc) termCounts.set(token, (termCounts.get(token) || 0) + 1)
    const length = Math.max(1, doc.length)
    return terms.map((term) => {
      const tf = (termCounts.get(term) || 0) / length
      const df = vocab.get(term) || 1
      const idf = Math.log((1 + docs.length) / (1 + df)) + 1
      return tf * idf
    })
  })

  return { terms, vectors }
}

function cosineSimilarity(a, b) {
  let dot = 0
  let magA = 0
  let magB = 0

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0
    const bv = b[i] || 0
    dot += av * bv
    magA += av * av
    magB += bv * bv
  }

  if (magA === 0 || magB === 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

function chunkSourceTitle(entry) {
  return String(entry?.source || entry?.title || entry?.url || '').trim()
}

async function getBM25Retriever(docs) {
  try {
    const mod = await import('@langchain/community/retrievers/bm25')
    const BM25Retriever = mod.BM25Retriever || mod.default?.BM25Retriever || mod.default
    if (!BM25Retriever?.fromDocuments) return null

    const documents = docs.map((entry) => ({
      pageContent: String(entry.content ?? ''),
      metadata: { ...entry },
    }))
    return await BM25Retriever.fromDocuments(documents)
  } catch {
    return null
  }
}

async function getHNSWLibRanked(query, docs) {
  try {
    const [{ HNSWLib }, { Document }] = await Promise.all([
      import('@langchain/community/vectorstores/hnswlib'),
      import('langchain/document'),
    ])

    const embedText = async (text) => {
      const result = await embeddingModel.embedContent(String(text ?? ''))
      return result.embedding.values
    }

    const embedder = {
      async embedQuery(text) {
        return embedText(text)
      },
      async embedDocuments(texts) {
        const vectors = []
        for (const text of texts) {
          vectors.push(await embedText(text))
        }
        return vectors
      },
    }

    const vectorDocs = docs.map((entry) => new Document({ pageContent: String(entry.content ?? ''), metadata: { ...entry } }))
    const store = await HNSWLib.fromDocuments(vectorDocs, embedder)
    return await store.similaritySearchWithScore(query, Math.min(3, docs.length))
  } catch {
    return null
  }
}

function bm25FallbackScore(queryTokens, docTokens) {
  if (!queryTokens.length || !docTokens.length) return 0
  const docSet = new Set(docTokens)
  let matches = 0
  for (const token of queryTokens) {
    if (docSet.has(token)) matches += 1
  }
  return matches / Math.max(queryTokens.length, docSet.size)
}

export async function retrieve(query, company, trace) {
  if (!trace || typeof trace !== 'object') {
    throw new Error('trace object is required')
  }

  if (!Array.isArray(trace.retrievedChunks)) trace.retrievedChunks = []

  const corpus = await loadCorpus()
  const normalizedCompany = normalizeText(company)
  const companyFiltered = normalizedCompany && normalizedCompany !== 'unknown'
    ? corpus.filter((entry) => normalizeText(entry.company) === normalizedCompany)
    : corpus.slice()

  const queryText = String(query ?? '')
  const queryTokens = tokenize(queryText)

  if (companyFiltered.length === 0) {
    trace.retrievedChunks = []
    trace.groundingSource = ''
    return []
  }

  const bm25Retriever = await getBM25Retriever(companyFiltered)
  let top20 = []

  if (bm25Retriever?.invoke) {
    try {
      const docs = await bm25Retriever.invoke(queryText)
      top20 = (Array.isArray(docs) ? docs : []).slice(0, 20).map((doc) => ({
        company: doc.metadata?.company || company,
        content: String(doc.pageContent ?? ''),
        source: chunkSourceTitle(doc.metadata),
        url: doc.metadata?.url || '',
        bm25Score: 1,
      }))
    } catch {
      top20 = []
    }
  }

  if (top20.length === 0) {
    top20 = companyFiltered
      .map((entry) => ({
        ...entry,
        bm25Score: bm25FallbackScore(queryTokens, tokenize(entry.content)),
      }))
      .sort((a, b) => b.bm25Score - a.bm25Score)
      .slice(0, 20)
  }

  let ranked = []

  const hnswResults = await getHNSWLibRanked(queryText, top20)
  if (Array.isArray(hnswResults) && hnswResults.length > 0) {
    ranked = hnswResults.map(([doc, distance]) => {
      const score = Number.isFinite(distance) ? 1 / (1 + distance) : 0
      return {
        score,
        source: chunkSourceTitle(doc.metadata),
        content: String(doc.pageContent ?? ''),
      }
    })
  } else {
    const { vectors } = tfIdfVectorize([queryText, ...top20.map((item) => item.content)])
    const queryVector = vectors[0] || []
    ranked = top20.map((item, index) => ({
      score: cosineSimilarity(queryVector, vectors[index + 1] || []),
      source: chunkSourceTitle(item),
      content: String(item.content ?? ''),
    }))
  }

  ranked = ranked
    .filter((item) => String(item.content || '').trim().length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  trace.retrievedChunks = ranked
  trace.groundingSource = ranked[0]?.source || ''

  return ranked
}

export default { retrieve }
