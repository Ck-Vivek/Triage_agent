# AGENTS.md

Project: Terminal-based Triage Agent
Author: Ck Vivek (AIML Student)
Coding partners: GitHub Copilot, Google Gemini (Gemini 1.5 Flash)

Overview
--------
This project was developed by Ck Vivek in partnership with two AI coding assistants: GitHub Copilot and Google Gemini (Gemini 1.5 Flash). The collaboration followed a clear, auditable division of work to ensure safety, reproducibility, and submission compliance.

Roles & Interaction
-------------------
- Human (Ck Vivek):
  - Defined the overall 7-stage architecture and data flows.
  - Specified security and safety requirements (for example, using the Luhn algorithm to detect and block credit-card numbers in Ticket #3).
  - Performed all final validation, logic grounding, and pipeline orchestration to guarantee compliance with hackathon safety rules.
  - Made all final decisions on escalation, product_area, and request_type values.

- GitHub Copilot:
  - Assisted with boilerplate code generation and common patterns (module scaffolding, file I/O, spinner/logging patterns).
  - Helped speed up iterative edits and refactors under tight time constraints.

- Google Gemini (Gemini 1.5 Flash):
  - Assisted as a coding and documentation partner, used for prompt drafting, robust JSON output examples, and template generation.
  - Provided native JSON-mode assistance for crafting schema-constrained LLM outputs and suggested guardrails.

What the AI agents did NOT do
----------------------------
- AI agents did not make final security or escalation decisions.
- AI-generated code and suggestions were reviewed, tested, and adjusted by the human lead prior to being accepted into the project.
- No AI agent was permitted to autonomously release or finalize production logic without human verification.

Why this matters
----------------
This workflow combines human domain knowledge and responsibility with AI-assisted speed. The human lead ensured that every output is:
- Grounded in verified corpus material (no hallucinations accepted)
- Auditable (traceable decisions and justification strings in `output.csv`)
- Safety-first (PII detection, high-risk escalation, Luhn check for financial data)

Outcome
-------
Using this collaborative approach Ck Vivek delivered an enterprise-grade, resilient triage system in under 24 hours. The system is built for high-availability operation and includes an Offline Heuristic Fallback to maintain 100% completion during API outages.

Contact
-------
Author: Ck Vivek — AIML Student
Repository help: GitHub Copilot (IDE assistant) and Google Gemini used as coding partners

