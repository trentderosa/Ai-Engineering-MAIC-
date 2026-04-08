---
name: provision-user
description: Create a new MAIC member account in Cognito. User-invoked only. Usage: /provision-user <email>
disable-model-invocation: true
---

Provisioning a new MAIC member in Cognito.

The Cognito User Pool has `selfSignUpEnabled: false`, so members must be created by an admin. There is no in-app UI for this — it must be done via the AWS CLI.

**Usage:** `/provision-user <email>`

The email address to provision is: `$ARGUMENTS`

**Step 1 — Look up the User Pool ID**

The User Pool ID is in the CDK stack outputs. Run:
```bash
aws cloudformation describe-stacks --stack-name MaicChatbotStack --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text
```

**Step 2 — Create the user**

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <USER_POOL_ID> \
  --username "$ARGUMENTS" \
  --user-attributes Name=email,Value="$ARGUMENTS" Name=email_verified,Value=true \
  --temporary-password "TempPass123!" \
  --message-action SUPPRESS
```

Replace `<USER_POOL_ID>` with the value from Step 1.

**Step 3 — Report**

Tell the user:
- The account was created with a temporary password `TempPass123!`
- The user must change it on first login
- They will receive no automated email (SUPPRESS is set) — share credentials manually

If any step fails (e.g., user already exists, User Pool not found), report the error clearly.
