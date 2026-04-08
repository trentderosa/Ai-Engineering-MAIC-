---
name: deploy
description: Show a CDK diff then deploy to AWS after confirmation. User-invoked only — never trigger autonomously.
disable-model-invocation: true
---

Deploying the MAIC chatbot stack to AWS.

**Step 1 — Diff**

Run:
```bash
npx cdk diff
```

Show the full diff output to the user. Highlight any:
- IAM policy changes (especially Bedrock resource ARNs)
- DynamoDB or Cognito changes (these have RemovalPolicy.DESTROY — dropping them deletes real data)
- Lambda code changes

**Step 2 — Confirm**

Ask the user: "The diff is shown above. Deploy now? (yes/no)"

Only proceed if the user explicitly confirms with "yes".

**Step 3 — Deploy**

Run:
```bash
npx cdk deploy
```

After deploy completes, print any CDK outputs (API URL, User Pool ID, Client ID). Remind the user to update the hardcoded values at the top of `maic-chat-widget.html` if any of those outputs changed.
