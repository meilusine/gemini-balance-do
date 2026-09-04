# Gemini Balance DO Compatibility Plan

## 0. Metadata

- Project name: gemini-balance-do
- Current phase: Compatibility fix
- Current task: Gemini 3.6+ trailing model turn compatibility
- Status: [-] implementation verified; live deployment pending
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

- Phase: deployment
- Current task: push the verified compatibility helper
- Blocked: no
- Next task: verify the automatically deployed Worker from SillyTavern
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
- [ ] Deploy through the connected Cloudflare Git integration

## 8. Task Backlog

- [x] Repair trailing `model` turns only for Gemini 3.6+.
- [x] Verify normal `user`-ending requests remain unchanged by conditional inspection.
- [x] Verify non-generation routes remain unchanged by scoped route matching.
- [ ] Record deployment and live SillyTavern test result.

## 9. Verification and Harness

- Normal path: Gemini 3.8 request ending with `model` receives a final `user` nudge.
- Unchanged path: Gemini 3.5 and requests ending with `user` are not modified.
- Invalid input: malformed JSON continues upstream without exposing content in logs.
- Security: no request body or API key is logged by the new logic.

Latest verification:

- Date: 2026-09-04
- Commands: `npx tsc --noEmit`; `npx wrangler deploy --dry-run`
- Result: both exited successfully; Worker bundle completed at 126.15 KiB (30.79 KiB gzip).
- Live verification: pending Cloudflare deployment and SillyTavern request.

## 10. Security and Defensive Design

- No secrets are stored in source.
- The compatibility helper does not log prompt contents.
- Existing authentication and Durable Object storage are unchanged.

## 11. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Continuation nudge slightly changes prompt semantics | Model may not reproduce an exact assistant prefill | Preserve the original model turn and ask for a natural continuation without repetition |
| Parsing request bodies adds Worker CPU usage | Small increase per affected request | Parse only Gemini 3.6+ JSON generation requests |

## 12. Open Questions

- [ ] Confirm the live SillyTavern preset succeeds after Cloudflare redeploys the commit.

## 13. Changelog

### 2026-09-04

- Type: issue
- Description: Gemini 3.6+ rejects requests whose final content role is `model`.
- Reason: newer Gemini request validation no longer accepts assistant-prefill-shaped input.
- Resolution: add a narrow compatibility repair in both proxy paths.
- Status: locally verified; deployment pending
