---
name: verify
description: Run a full build + test pass to confirm nothing is broken before committing. Use after any code change.
---

Run the following commands in sequence and report the results:

```bash
npm run build && npm run test
```

- If `npm run build` fails, report the TypeScript compilation errors and stop — do not proceed to tests.
- If build passes but `npm run test` fails, report the failing test output.
- If both pass, confirm everything is clean.

Note: `npm run test` currently runs Jest stubs that always pass. A green test result confirms compilation succeeded and the Jest harness works, but does not validate business logic. Flag this to the user if relevant.
