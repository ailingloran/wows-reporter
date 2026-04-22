# CLAUDE.md

## Project summary
This repository is the World of Warships Discord reporting bot.

It handles:
1. daily and weekly reporting
2. Discord message indexing
3. community pulse analysis
4. slash commands
5. dashboard API support
6. SQLite based storage
7. scheduled jobs and operational tooling

## Main goals
Prefer simple, safe, maintainable changes.
Do not rewrite working systems without a clear benefit.
Preserve current CLI flows, PM2 usage, SQLite compatibility, and env based configuration.

## Tech stack
TypeScript
Node.js
discord.js
Express
better-sqlite3
node-cron
Winston

## Rules for changes
1. keep changes small and easy to review
2. do not rename files or move modules unless necessary
3. keep env variables backward compatible unless explicitly asked
4. keep Discord permission assumptions explicit
5. avoid introducing new frameworks without a strong reason
6. prefer extending existing modules over creating parallel systems
7. document new commands, flags, env variables, and API routes

## When working on reports
1. preserve existing output behavior unless the task requests a format change
2. be careful with date handling, scheduling, and timezone assumptions
3. never silently break manual trigger flows
4. keep Discord staff workflows clear and low friction

## When working on storage
1. treat SQLite schema changes carefully
2. prefer additive migrations
3. do not risk corrupting existing data paths
4. keep message indexing performance in mind

## When debugging
Start by checking:
1. entry point and CLI flags
2. env parsing
3. scheduler registration
4. Discord client startup
5. database initialization
6. API startup
7. PM2 runtime assumptions

## Output expectations
When making a change:
1. explain what changed
2. explain why
3. list risks
4. list follow up work if relevant
