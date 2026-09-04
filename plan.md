# Gemini Balance DO Compatibility Plan

## 0. Metadata

- Project name: gemini-balance-do
- Current phase: Compatibility fix
- Current task: Gemini 3.6+ trailing model turn compatibility
- Status: [-] adaptive cooldown implementation in verification
- Last updated: 2026-09-04

## 1. Final Goal

Allow SillyTavern requests using Gemini 3.6 and newer to succeed when the generated Gemini `contents` array ends with a `model` turn.

Success criteria:

- Native Gemini proxy requests are repaired before forwarding.
- OpenAI-compatible requests are repaired after message conversion.
- Older Gemini models and requests ending with `user` remain unchanged.
- TypeScript validation and a production dry-run build pass.

Out of scope:

- Changing authentication, key storage, or load-balancing behavior.
- Changing SillyTavern presets.

## 2. Current Status

- Phase: reliability improvement
- Current task: add lightweight per-key adaptive cooldown
- Blocked: no
- Next task: deploy and verify cooldown-aware key selection
- Known issue: live upstream verification requires the user's deployed secrets and is performed after Cloudflare deployment.

## 3. Architecture

```text
SillyTavern request
  -> Worker native/OpenAI route
  -> Gemini request-body compatibility check
  -> existing API-key load balancer
  -> Google Gemini API
```

## 4. Data Flow

1. Detect a Gemini 3.6+ generate-content request.
2. Inspect the final `contents` role.
3. If it is `model`, append a short `user` continuation instruction.
4. Forward through the existing key-selection path.
5. Leave malformed/non-JSON bodies to Google for normal validation.

## 5. Tech Stack and Environment

- Language: TypeScript
- Runtime: Cloudflare Workers with Durable Objects
- Package manager: pnpm/npm-compatible lockfile
- External service: Google Generative Language API
- Typecheck: `npx tsc --noEmit`
- Build verification: `npx wrangler deploy --dry-run`

## 6. Folder Structure

- `src/handler.ts`: proxy and compatibility logic
- `wrangler.jsonc`: Worker configuration
- `plan.md`: task and verification record

## 7. Milestones

- [x] Add native Gemini compatibility handling
- [x] Add OpenAI-compatible handling
- [x] Run typecheck and dry-run build
- [x] Deploy through the connected Cloudflare Git integration
- [x] Set all adjustable Gemini safety categories to `OFF`.
- [x] Protect API routes with `AUTH_KEY`.
- [x] Protect the management page and `/api/*` routes with `HOME_ACCESS_KEY`.
- [x] Deploy and verify authentication on the live domain.
- [x] Retry up to three distinct keys for transient upstream errors and empty non-streaming candidates.
- [-] Store and honor per-key cooldown state without a background task.

## 8. Task Backlog

- [x] Repair trailing `model` turns only for Gemini 3.6+.
- [x] Verify normal `user`-ending requests remain unchanged by conditional inspection.
- [x] Verify non-generation routes remain unchanged by scoped route matching.
- [x] Record deployment and live native Gemini test result.

## 9. Verification and Harness

- Normal path: Gemini 3.8 request ending with `model` receives a final `user` nudge.
- Unchanged path: Gemini 3.5 and requests ending with `user` are not modified.
- Invalid input: malformed JSON continues upstream without exposing content in logs.
- Security: no request body or API key is logged by the new logic.

Latest verification:

- Date: 2026-09-04
- Commands: `npx tsc --noEmit`; `npx wrangler deploy --dry-run`
- Result: both exited successfully; Worker bundle completed at 126.15 KiB (30.79 KiB gzip).
- Live verification: an unauthenticated Gemini 3.8 native request ending in `model` returned HTTP 200, proving the repair is active. Final SillyTavern UI verification remains for the user.
- 2026-09-04 security update: `npx tsc --noEmit`, Wrangler dry-run, and five authentication helper checks passed.
- Live authentication: the root URL returned the management login page and an unauthenticated `/v1beta/models` request returned HTTP 401.
- 2026-09-04 key failover: TypeScript and Wrangler dry-run checks passed.

## 10. Security and Defensive Design

- No secrets are stored in source.
- The compatibility helper does not log prompt contents.
- Existing authentication and Durable Object storage are unchanged.

## 11. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Continuation nudge slightly changes prompt semantics | Model may not reproduce an exact assistant prefill | Preserve the original model turn and ask for a natural continuation without repetition |
| Parsing request bodies adds Worker CPU usage | Small increase per affected request | Parse only Gemini 3.6+ JSON generation requests |
| Retrying may consume additional quota | One user request may make up to three upstream calls | Retry only transient statuses or genuinely empty candidates and cap attempts at three |
| A daily quota error can omit its exact reset time | A key may return too early or remain paused longer than necessary | Prefer `Retry-After`/`RetryInfo`; use a conservative 24-hour fallback only when the response explicitly indicates a daily quota |

## 12. Open Questions

- [ ] Confirm the live SillyTavern preset succeeds after Cloudflare redeploys the commit.
- [x] Verify API and management authentication on the live Worker.

## 13. Changelog

### 2026-09-04

- Type: issue
- Description: Gemini 3.6+ rejects requests whose final content role is `model`.
- Reason: newer Gemini request validation no longer accepts assistant-prefill-shaped input.
- Resolution: add a narrow compatibility repair in both proxy paths.
- Status: deployed and live verified

### 2026-09-04 (deployment verification)

- Type: verification / security finding
- Description: the deployed Gemini 3.8 endpoint repaired a trailing `model` turn and returned HTTP 200.
- Impact: compatibility fix is active; the same no-credential test revealed that this fork does not enforce configured authentication secrets.
- Status: compatibility complete; authentication follow-up pending user approval.

### 2026-09-04 (safety and authentication)

- Type: security change
- Description: apply Gemini `OFF` to all adjustable safety categories, protect API routes with `AUTH_KEY`, and protect the admin UI/API with `HOME_ACCESS_KEY`.
- Reason: minimize adjustable filtering while preventing public use of the stored Gemini keys.
- Impact: clients must send `AUTH_KEY`; the management page now requires a password and uses a secure, HTTP-only, same-site cookie.
- Status: deployed and live verified.

### 2026-09-04 (key failover)

- Type: reliability change
- Description: sample up to three distinct keys and retry 429/500/502/503/504 responses; for non-streaming generation, also retry HTTP 200 responses with no usable candidate content.
- Reason: avoid failing immediately when one key is limited or Gemini returns an empty candidate.
- Impact: transient failures may create up to three upstream calls; normal successful requests still create one.
- Status: locally verified; deployment pending.

### 2026-09-04 (adaptive cooldown)

- Type: reliability change
- Description: add a small cooldown table keyed by API key; select only keys whose cooldown has expired.
- Rules: explicit retry delay is honored; minute quota uses 90 seconds; daily quota and 401/403 use 24 hours; unknown 429 uses 5 minutes; 503 is retried without cooling the key.
- Security: cooldown logs never include API key values.
- Status: implementation in verification.

### 2026-09-04 (Gemini 3.x request and stream compatibility)

- Type: compatibility fix
- Description: normalize confirmed Gemini 3.x request differences in both native and OpenAI-compatible paths by removing unsupported or deprecated sampling fields and using `thinkingLevel` for OpenAI `reasoning_effort`.
- Model handling: preserve supported levels for Gemini 3.1/3.5/3.6; convert unsupported `minimal` to `low` for Gemini 3.7/3.8 Flash and Gemini 3.1 Pro.
- Streaming: tolerate final Gemini SSE candidates that contain `finishReason` without a `content` object.
- Scope: Gemini 2.x behavior, authentication, safety settings, key selection, retry, and cooldown logic are unchanged.
- Verification: `npx tsc --noEmit` and `npx wrangler deploy --dry-run` passed.
- Status: locally verified; deployment pending.
