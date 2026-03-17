# AGENTS.md

## Stack
Next.js 14.2.21 (App Router), React 18, Tailwind 3.4, Supabase Postgres, Drizzle ORM 0.38

## Key files
- lib/schema.js — Drizzle ORM schema
- lib/prompts.js — LLM prompts (v8)
- app/api/v6/ — API routes

## Conventions
- API routes go in app/api/v6/
- Use Drizzle ORM for all DB operations
- Tailwind for styling
- New tables need Drizzle schema in lib/schema.js

## Do not modify
- lib/prompts.js
- lib/matching.js
- lib/facility-attributes.js
- app/api/v6/assess/route.js
- v3 baseline is frozen