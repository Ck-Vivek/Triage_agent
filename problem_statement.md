# Problem Statement

Objective
---------
Build a robust, terminal-based triage agent that processes support tickets across three domains: HackerRank, Claude, and Visa. The agent must read a CSV of incoming tickets and produce a grounded `output.csv` containing a full reasoning trace for each decision.

Constraints
-----------
- Grounding: All responses must be 100% grounded in official domain documentation (no hallucinations). The system uses a scraped, curated `corpus.json` derived from official support pages.
- Safety: High-risk or sensitive cases (PII, unauthorized charges, legal threats) must be escalated immediately and never answered directly.
- Multi-intent support: Tickets containing multiple intents must be split and handled separately, then merged with a single final outcome.
- Auditable output: Every ticket must include a full reasoning trace (justification) explaining company inference, retrieval evidence, safety checks, confidence, and final decision.

Input / Output
--------------
- Input: `support_tickets.csv` — each row represents a support issue (company may be provided or `None`).
- Output: `output.csv` — each row must include at least the following columns:
  - `status` — `replied` or `escalated`
  - `product_area` — short string describing affected area
  - `response` — the support reply text (grounded in corpus)
  - `justification` — machine-readable human-readable reasoning trace
  - `request_type` — one of `product_issue`, `feature_request`, `bug`, `invalid`

Success Metrics
---------------
- Domain inference accuracy: Correctly infer the ticket domain when not provided.
- Safety gate reliability: All PII and high-risk cases flagged and escalated (Luhn-validated credit-card detection for Visa cases).
- Response grounding: At least one retrieved corpus phrase or chunk appears in every non-escalated response.
- End-to-end completion: All tickets processed and a row written to `output.csv` (no silent failures).

Evaluation Procedure
--------------------
- Run the pipeline against a test `support_tickets.csv` with a representative mix of HackerRank, Claude, and Visa tickets.
- Verify:
  - `output.csv` contains a justification trace for every row
  - All tickets with PII/financial keywords are escalated
  - Non-escalated responses contain grounding evidence from `corpus.json`
  - Multi-intent tickets are split and merged correctly

Deliverables
------------
- Source files implementing the 7-stage pipeline: `safetyGate.js`, `resolver.js`, `scraper.js`, `retriever.js`, `agent.js`, `validator.js`, `justification.js`, and `index.js` orchestrator.
- `corpus.json` — curated corpus scraped from official support pages
- `support_tickets.csv` — sample input
- `output.csv` — final results with full reasoning traces
- `AGENTS.md` — collaborator attribution and workflow
- `problem_statement.md` — this document

