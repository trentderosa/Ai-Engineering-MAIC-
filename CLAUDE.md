# MAIC Chatbot — Claude Context

## Project Overview
AI chatbot for MAIC (Madison AI Club at JMU). A floating chat widget embeddable on any webpage, backed by AWS infrastructure.

## Stack
- **Frontend**: `maic-chat-widget.html` — self-contained vanilla JS widget, JMU purple/gold colors
- **Backend**: `lambda/chat.js` — Node.js 20.x Lambda → AWS Bedrock (Claude Haiku)
- **Auth**: AWS Cognito User Pool (`us-east-1_2eenG9yf1`) — admin-invite only, no self-signup
- **Rate limiting**: DynamoDB (`maic-chat-usage`) — IP-based, resets daily via TTL
- **Infra**: CDK stack in `lib/maic-chatbot-stack.ts`

## Team Responsibilities
- **Anthony (me)** — ✅ conversation memory, ✅ auth fix
- **Matthew** — AWS / data management, merging branches + cdk deploy
- **Connor** — structured data requests, storing speaker/meeting notes
- **Trent** — error handling, API reliability
- **Jared** — active teams display
- **Bryan** — UI layout

## Branches (all pushed to GitHub, pending Matthew merge + cdk deploy)
- `fix/system-prompt` — fixes wrong university name in Lambda system prompt
- `fix/auth-server-side` — server-side Cognito token verification (Anthony)
- `fix/cdk-iam-policy` — fixes malformed Bedrock IAM ARNs in CDK stack
- `feature/conversation-memory` — sliding window chat history (Anthony)
- `feature/session-caps` — guest/member session message limits
- `feature/enhanced-local-kb` — more local answers to reduce API calls

## Key Decisions Made
- **Conversation memory**: sliding window history — guests get last 4 messages, members get last 10
- **Session caps**: guests max 10 messages/session, members max 30
- **Token limits**: guests 300 max tokens/response, members 2000
- **Auth fix**: server-side verification via Cognito `GetUser` API using `AccessToken` sent in `Authorization: Bearer` header — client-sent `isAuthenticated` flag removed entirely
- **`GetUser` approach**: chosen over manual JWT verification — no new npm packages, no CDK changes needed, Cognito handles expiry/revocation automatically
- **Local knowledge base**: answers common questions client-side to reduce Bedrock API calls and cost

## Known Issues / Watch Out For
- ~~Lambda system prompt says "University of Wisconsin-Madison"~~ — ✅ fixed in `fix/system-prompt`
- ~~CDK IAM policy malformed quotes on line 72~~ — ✅ fixed in `fix/cdk-iam-policy`
- Lambda 500 error on some API calls — Matthew needs to check CloudWatch logs to diagnose
- CORS is wide open (`ALL_ORIGINS`) — fine for now
- All Lambda changes require `cdk deploy` to go live — coordinate with Matthew

## File Map
```
maic-chat-widget.html     — entire frontend (HTML + CSS + JS in one file)
lambda/chat.js            — Lambda handler
lib/maic-chatbot-stack.ts — CDK infrastructure
```
