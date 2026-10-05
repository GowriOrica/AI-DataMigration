# AI Migration Cockpit - developer setup

A SAP CAP (Node.js) backend with a SAPUI5 cockpit. This page only explains how to run it on your own machine.

## Before you start
- Node.js 20 or newer and npm.
- Your own AI key (OpenRouter or Gemini). Nobody shares keys; each developer creates their own.

## Run it locally (no cloud account needed)
1. Install, in the project folder and again in the UI folder: `npm ci`, then `cd app/project1`, `npm ci`, `cd ../..`
2. Optional, only for the AI sorting: copy `.env.example` to `.env` and fill in your own AI key. Never commit `.env`. The app starts without a key; only the AI sorting needs one.
3. Start with a local database and mock data: `npm run demo:start` (port 4010; change it with the DEMO_PORT variable).
4. Open the cockpit at `http://localhost:4010/project1/index.html`.

## Tests
`node --test --test-timeout=60000 test/*.test.js`

## Rules for this repository
- Never commit keys, passwords, tokens, service bindings, database files or customer data. `.gitignore` blocks the usual places; check your changes before you push.
- Work on a branch and open a pull request. Do not push to `main` directly.
- Use only synthetic or mock data in tests and examples.
