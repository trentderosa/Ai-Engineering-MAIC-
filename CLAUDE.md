# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AWS CDK v2 project deploying an AI chatbot for MAIC (Madison AI Club at JMU). The chatbot is backed by Amazon Bedrock (Claude 3.5 Haiku) exposed via a REST API. The frontend is a single self-contained HTML widget.

## Build & Deploy Commands

```bash
npm run build          # Compile TypeScript CDK code (tsc)
npm run watch          # Watch mode
npm run test           # Run Jest tests (currently stubs only)
npx cdk synth          # Emit CloudFormation template
npx cdk diff           # Compare deployed stack vs local
npx cdk deploy         # Deploy to AWS
```

First-time setup in a new AWS account/region requires `npx cdk bootstrap` before deploying.

## Important Architecture Notes

- **`lambda/chat.js` is plain JavaScript**, not TypeScript. `npm run build` does not type-check it. Edit it carefully.
- **Compiled CDK files are committed.** `bin/maic-chatbot.js` and `bin/maic-chatbot.d.ts` live in git. Always run `npm run build` before committing CDK changes to keep them in sync.
- **Stack has no `env` set.** It deploys to whatever AWS account/region the CLI is configured for.
- **`RemovalPolicy.DESTROY`** is set on both DynamoDB and Cognito — `cdk destroy` will delete real data.

## AWS Prerequisites

- AWS credentials must be configured (`aws configure` or env vars).
- Bedrock model access for `anthropic.claude-3-5-haiku-20241022-v1:0` must be enabled manually in the AWS Bedrock console (us-east-1) — it is not automatic.

## After Deploying

CDK outputs the API URL, User Pool ID, and Client ID. If they change, update the hardcoded values at the top of `maic-chat-widget.html`:
- `MAIC_API_URL`
- `MAIC_USER_POOL_ID`
- `MAIC_CLIENT_ID`

## Key Constants (lambda/chat.js)

| Constant | Value | Meaning |
|---|---|---|
| `GUEST_DAILY_LIMIT` | 10 | Max messages/day per guest IP |
| `GUEST_MAX_TOKENS` | 300 | Bedrock token limit for guests |
| `MEMBER_MAX_TOKENS` | 2000 | Bedrock token limit for members |
| `MODEL_ID` | `us.anthropic.claude-3-5-haiku-20241022-v1:0` | Cross-region inference profile |

## TypeScript Config

Strict mode is on (`noImplicitAny`, `strictNullChecks`, `noImplicitReturns`). Unused locals/params are allowed. `strictPropertyInitialization` is off. Target is ES2022 with NodeNext modules.

## Tests

`test/maic-chatbot.test.ts` is a stub — all assertions are commented out. `npm run test` passes but verifies nothing. Do not rely on tests to catch regressions.

## Git Conventions

- Branch naming: `feature/<name>`, `fix/<name>`
- PRs target `main`
