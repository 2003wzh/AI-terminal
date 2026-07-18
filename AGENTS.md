# AI Terminal Security Rules

These rules have the highest priority for all changes in this repository.

## Highest Priorities

1. Protect user privacy.
2. Protect API keys and tokens.
3. Redact all logs and user-facing errors.
4. Preserve existing behavior unless a security boundary requires a fail-closed change.
5. Finish security hardening before adding features.

## Prohibited

- Never persist API keys, access tokens, refresh tokens, or conversation history as plaintext.
- Never include complete credentials in logs, exceptions, crash reports, diagnostics, URLs, or process command lines.
- Never send chat content, local paths, filenames, or file contents to an endpoint until the user has confirmed the exact endpoint.
- Never print or store complete request bodies for debugging.
- Never read local files, enumerate directories, search files, modify files, open paths, or execute commands without one-time user approval.
- Never weaken an existing security check to make a test or integration pass.

## Required Defaults

- Windows secrets and private local history must be encrypted with current-user DPAPI and written atomically.
- Existing plaintext data must be migrated in place on first successful read; migration must fail closed if encryption is unavailable.
- Sensitive text must pass through the shared redaction layer before entering logs, crash reports, error dialogs, tool results, model context, or local history.
- Remote model endpoints must use HTTPS, except loopback development endpoints, and require an in-memory user confirmation before the first request in each app session.
- The absolute workspace path must remain local. Model tools use workspace-relative paths.
- Loading, cancellation, actionable errors, and local history are security and reliability requirements, not optional polish.

## Current Work Order

1. API key and token secure storage.
2. Log, crash report, error, prompt, and tool-output redaction.
3. Explicit endpoint and local-tool consent.
4. Loading and stop-generation reliability.
5. Encrypted local conversation history.
6. Regression tests and only then new features.
