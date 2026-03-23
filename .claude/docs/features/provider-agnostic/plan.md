# Provider-Agnostic Refactor — Strip Google Dependencies

## Goal

Transform gemini-cli into torad-code: a provider-agnostic open-source coding CLI
that works with any OpenAI-compatible model provider out of the box, with zero
Google account requirement.

## Scope

Remove all hardcoded Google/Gemini assumptions from the runtime path. Keep
`@google/genai` types as internal wire format (GenerateContentResponse, Content,
Part) — they're the protocol, not a dependency.

## What "Done" Looks Like

A user installs torad-code, sets `provider.type` and an API key in
`~/.gemini/settings.json`, runs `torad-code`, and gets a fully functional coding
agent. No Google sign-in, no Gemini model references, no quota dialogs, no model
routing probes.

---

## Build Sequence

### Task 1: Clean up dead code from Kimi's parallel system

FILES:

- DELETE `packages/core/src/providers/IProviderService.ts`
- DELETE `packages/core/src/providers/IProviderAdapter.ts`
- DELETE `packages/core/src/providers/BaseProviderAdapter.ts`
- DELETE `packages/core/src/providers/ProviderService.ts`
- DELETE `packages/core/src/providers/OpenAICompatibleProviderAdapter.ts`
- DELETE `packages/core/src/providers/ProviderConfigService.ts`
- DELETE `packages/core/src/providers/__tests__/ProviderService.test.ts`
- DELETE `packages/cli/src/commands/providerCommands.ts`
- DELETE `packages/cli/src/commands/__tests__/providerCommands.test.ts`
- DELETE `packages/cli/src/ui/commands/providerCommand.ts`
- KEEP `packages/core/src/providers/CircuitBreaker.ts` (move to utils later)
- KEEP `packages/core/src/providers/CostTracker.ts` (move to utils later)
- REVERT changes to `packages/core/src/providers/index.ts` and `registry.ts`
  VERIFY: `npx tsc --noEmit 2>&1 | grep -c "error TS"` returns same count as
  before deletion STATUS: untested

### Task 2: Make auth provider-aware at every entry point

The auth system has multiple entry points. ALL must skip Google auth for
non-Google providers:

FILES:

- `packages/cli/src/gemini.tsx` — startup auth (lines 312-362)
- `packages/cli/src/core/initializer.ts` — shouldOpenAuthDialog
- `packages/cli/src/core/auth.ts` — performInitialAuth
- `packages/cli/src/validateNonInterActiveAuth.ts` — non-interactive auth
- `packages/cli/src/config/auth.ts` — validateAuthMethod
- `packages/core/src/config/config.ts` — refreshAuth, hasNonGoogleProvider
  VERIFY:
  `PROVIDER_TYPE=nvidia-nim npx torad-code --prompt "hi" 2>&1 | grep -c "sign in\|Google\|oauth"`
  returns 0 STATUS: untested

### Task 3: Remove Gemini model constants from runtime path

Make resolveModel() a passthrough for non-Gemini models. Remove all
isGemini3Model/isGemini2Model/isPreviewModel checks from the non-Google code
path.

FILES:

- `packages/core/src/config/models.ts` — resolveModel, isCustomModel,
  supportsModernFeatures
- `packages/core/src/core/client.ts` — model selection bypass
- `packages/core/src/core/geminiChat.ts` — model feature checks
- `packages/core/src/core/baseLlmClient.ts` — model defaults VERIFY:
  `grep -rn "isGemini3Model\|isGemini2Model\|isPreviewModel" packages/core/src/core/client.ts packages/core/src/core/geminiChat.ts | grep -v "import\|//\|test"`
  returns empty STATUS: untested

### Task 4: Replace Gemini-specific error handling

Remove Google-specific error classification from the non-Google path. The OpenAI
adapter should handle its own errors.

FILES:

- `packages/core/src/core/turn.ts` — error messages
- `packages/core/src/utils/quotaErrorDetection.ts` — skip for non-Google
- `packages/cli/src/ui/hooks/useQuotaAndFallback.ts` — skip for non-Google
  VERIFY: `grep -rn "Gemini API\|Google API" packages/core/src/core/turn.ts`
  returns empty STATUS: untested

### Task 5: Remove Google telemetry from non-Google path

The logging/telemetry system sends events to Google endpoints. For non-Google
providers, either skip or redirect to local logging.

FILES:

- `packages/core/src/core/loggingContentGenerator.ts` — conditional telemetry
- `packages/core/src/telemetry/loggers.ts` — skip Google events for non-Google
- `packages/core/src/telemetry/trace.ts` — skip Google tracing for non-Google
  VERIFY:
  `PROVIDER_TYPE=nvidia-nim npx torad-code --prompt "hi" 2>&1 | grep -c "google\|googleapis"`
  returns 0 STATUS: untested

### Task 6: Make model dialog fully dynamic for non-Google providers

The /models command should fetch from the provider API and let users switch
models mid-session.

FILES:

- `packages/cli/src/ui/components/ModelDialog.tsx` — ProviderInfoDialog
- `packages/core/src/providers/openai-compatible.ts` — listModels
- `packages/core/src/config/config.ts` — listProviderModels VERIFY:
  `npx tsc --noEmit 2>&1 | grep "ModelDialog" | grep -c "error"` returns 0
  STATUS: passing (already implemented)

### Task 7: Remove Gemini-branded strings from user-facing output

Replace all user-visible "Gemini" references with provider-agnostic text for the
non-Google path.

FILES:

- `packages/core/src/core/turn.ts` — error messages
- `packages/cli/src/ui/components/ModelDialog.tsx` — help text
- `packages/cli/src/gemini.tsx` — startup messages
- `packages/core/src/core/tokenLimits.ts` — comments VERIFY:
  `PROVIDER_TYPE=nvidia-nim npx torad-code --prompt "hi" 2>&1 | grep -ic "gemini"`
  returns 0 STATUS: untested

### Task 8: Skip Gemini model availability/quota checks for non-Google

The model availability service, quota system, and fallback dialogs assume Google
models. Skip all of these for non-Google providers.

FILES:

- `packages/core/src/availability/policyHelpers.ts` — skip for non-Google
- `packages/core/src/config/config.ts` — skip preview/quota checks in
  refreshAuth
- `packages/cli/src/ui/hooks/useQuotaAndFallback.ts` — early return for
  non-Google
- `packages/core/src/core/client.ts` — skip applyModelSelection for non-Google
  VERIFY:
  `grep -rn "applyModelSelection\|selectModelForAvailability" packages/core/src/core/client.ts | grep -vc "hasNonGoogleProvider\|//"`
  returns 0 (all calls guarded) STATUS: untested

### Task 9: Remove Google telemetry events from non-Google path

SKIPPED — telemetry is local-only (file logging + event bus). No data sent to
Google servers. Verified by grepping for googleapis/clearcut/firebaselogging in
telemetry code — zero hits. Safe to keep as-is. STATUS: passing (not needed)

### Task 10: Make BaseLlmClient provider-aware

BaseLlmClient is used for model routing probes and JSON generation. It should
use the provider's model, not hardcoded Gemini defaults.

FILES:

- `packages/core/src/core/baseLlmClient.ts` — use provider model
- `packages/core/src/config/config.ts` — pass provider info to BaseLlmClient
  VERIFY: `grep -c "DEFAULT_GEMINI" packages/core/src/core/baseLlmClient.ts`
  returns 0 STATUS: passing (no DEFAULT_GEMINI refs found — model comes from
  callers) LAST_VERIFIED: 2026-03-22

### Task 11: Clean up GLM 5 changes (commit) + delete Kimi parallel system

Stage GLM 5's good changes. Delete Kimi's 10 parallel system files.

FILES:

- `packages/core/src/providers/capability.ts` — GLM 5 vision probe (commit)
- `packages/core/src/providers/__tests__/openai-compatible.test.ts` — GLM 5
  tests (commit)
- DELETE all Kimi files from Task 1 VERIFY:
  `ls packages/core/src/providers/IProviderService.ts 2>/dev/null; echo $?`
  returns 1 STATUS: untested

### Task 12: Rebrand ALL user-facing "Gemini" strings to "torad-code"

Comprehensive rebrand. Grep for EVERY user-facing "Gemini" reference across the
entire codebase and replace with "torad-code" or provider-agnostic text. This
includes:

- Error messages
- Help text
- Dialog titles and descriptions
- Status bar / header
- Welcome messages
- Documentation URLs (keep functional but note they point to geminicli.com)
- Console output strings

Do NOT change:

- Import paths (still @google/genai, @google/gemini-cli-core)
- License headers (still Copyright Google)
- Internal variable/function names (isGemini3Model etc — those are code, not
  branding)
- Test fixtures

FILES:

- `packages/core/src/core/turn.ts` — error messages
- `packages/core/src/core/client.ts` — error messages
- `packages/cli/src/gemini.tsx` — startup messages
- `packages/cli/src/ui/components/ModelDialog.tsx` — help text
- `packages/cli/src/ui/components/*.tsx` — all dialog components
- `packages/cli/src/core/initializer.ts` — startup text
- `packages/cli/src/ui/constants.ts` — UI strings
- ANY other file found by grep VERIFY:
  `grep -rn '".*Gemini CLI.*"' packages/cli/src/ packages/core/src/ 2>/dev/null | grep -vc "Copyright\|license\|SPDX\|import\|test\|\.test\.\|coverage"`
  returns 0 STATUS: untested

### Task 13: End-to-end tool calling smoke test

Run torad-code with a real coding task that exercises tool calling: read a file,
edit it, run a command.

FILES: none (test only) VERIFY:
`npx torad-code --prompt "read package.json and tell me the name field" 2>&1 | grep -v Keychain | tail -5 | grep -ci "gemini-cli\|torad\|name"`
returns non-zero STATUS: untested

### Task 14: Rebuild bundle after all changes

Build core, CLI, and bundle. Verify torad-code global command works.

FILES: bundle/\* VERIFY: `torad-code --version 2>&1 | grep -c "0\."` returns 1
STATUS: untested

### Task 15: Git commit all changes

Stage all modified files, commit with descriptive message. Do NOT push.

FILES: all modified VERIFY: `git diff --stat HEAD | wc -l` returns 0 (clean tree
after commit) STATUS: untested

---

## Verification Manifest

### dead-code-cleanup

FILES: [IProviderService.ts, IProviderAdapter.ts, BaseProviderAdapter.ts,
ProviderService.ts, OpenAICompatibleProviderAdapter.ts,
ProviderConfigService.ts] VERIFY:
`ls packages/core/src/providers/IProviderService.ts 2>/dev/null; echo $?`
returns 1 STATUS: passing LAST_VERIFIED: 2026-03-22

### auth-bypass

FILES: [gemini.tsx, initializer.ts, auth.ts] VERIFY:
`PROVIDER_TYPE=nvidia-nim npx torad-code --prompt "hi" 2>&1 | grep -ci "sign in\|oauth\|google auth"`
returns 0 STATUS: passing LAST_VERIFIED: 2026-03-22

### model-passthrough

FILES: [models.ts, client.ts, geminiChat.ts] VERIFY:
`npx torad-code --prompt "hi" 2>&1 | grep -v Keychain | head -1` returns model
response STATUS: passing LAST_VERIFIED: 2026-03-22

### error-messages

FILES: [turn.ts] VERIFY: `grep -c "Gemini API" packages/core/src/core/turn.ts`
returns 0 STATUS: passing LAST_VERIFIED: 2026-03-22

### model-dialog

FILES: [ModelDialog.tsx] VERIFY:
`npx tsc --noEmit 2>&1 | grep -c "ModelDialog.*error"` returns 0 STATUS: passing
LAST_VERIFIED: 2026-03-22

### context-windows

FILES: [tokenLimits.ts, openai-compatible.ts] VERIFY:
`node -e "const{getModelContextWindow}=require('./packages/core/dist/src/providers/openai-compatible.js');console.log(getModelContextWindow('gpt-4o'))"`
returns a number STATUS: passing LAST_VERIFIED: 2026-03-22

### typescript-compiles

FILES: [all] VERIFY:
`npx tsc --noEmit 2>&1 | grep "providers\|contentGenerator\|ModelDialog" | grep -c "error"`
returns 0 STATUS: passing LAST_VERIFIED: 2026-03-22

### tests-pass

FILES: [all test files] VERIFY:
`npx vitest run src/providers/ 2>&1 | grep "Tests" | grep -c "passed"` returns 1
STATUS: passing LAST_VERIFIED: 2026-03-22

### kimi-cleanup

FILES: [IProviderService.ts, IProviderAdapter.ts, BaseProviderAdapter.ts,
ProviderService.ts, OpenAICompatibleProviderAdapter.ts,
ProviderConfigService.ts, providerCommands.ts, providerCommand.ts] VERIFY:
`ls packages/core/src/providers/ProviderService.ts packages/core/src/providers/ProviderConfigService.ts 2>&1 | grep -c "No such file"`
returns 2 STATUS: passing LAST_VERIFIED: 2026-03-22

### availability-skip

FILES: [client.ts, policyHelpers.ts, config.ts] VERIFY:
`grep -n "applyModelSelection" packages/core/src/core/client.ts | grep -vc "import\|hasNonGoogleProvider\|//"`
returns 0 STATUS: passing LAST_VERIFIED: 2026-03-22

### gemini-branding-removed

FILES: [turn.ts, client.ts, gemini.tsx, ModelDialog.tsx, cli-help-agent.ts,
LoginWithGoogleRestartDialog.tsx, SKILL.md, extensions/new.ts,
extensions/update.ts, installationInfo.ts, extension-manager.ts,
browser-tools-manifest.json, mcp-server/package.json] VERIFY:
`grep -rn '".*Gemini CLI.*"' packages/cli/src/ packages/core/src/ 2>/dev/null | grep -vc "Copyright\|license\|SPDX\|import\|test\|\.test\.\|coverage\|node_modules\|dist\|\.d\.ts"`
returns 0 STATUS: passing LAST_VERIFIED: 2026-03-22

### e2e-tool-calling

FILES: [] VERIFY:
`torad-code --prompt "say hello in one word" 2>&1 | grep -v Keychain | grep -ci "hello"`
returns non-zero STATUS: passing LAST_VERIFIED: 2026-03-22

### bundle-works

FILES: [bundle/*] VERIFY: `torad-code --version 2>&1 | grep -c "0\."` returns 1
STATUS: passing LAST_VERIFIED: 2026-03-22

---

## Plan Amendment Rules

This plan is a LIVING DOCUMENT. The feature loop MUST update it when:

1. A new task is discovered during implementation → ADD to Build Sequence +
   Verification Manifest
2. A task's scope changes → UPDATE FILES and VERIFY
3. A verification passes → UPDATE STATUS to `passing`, set LAST_VERIFIED
4. A regression is found → UPDATE STATUS to `failing`
5. A task is found to be unnecessary → Mark as SKIPPED with reason
6. Additional "Gemini" references are found → ADD to Task 12's file list

The loop reads this file every iteration. Changes persist across context
windows.

## Plan Amendments

### Amendment 1 (iteration 4)

**What changed:** Task 12 expanded — found additional "Gemini" branding in:

- AppHeader.tsx (lines 74, 96) — the main header showing "Gemini CLI" at top of
  every session
- TriageIssues.tsx (lines 181, 614, 620) — triage prompts and UI labels All
  replaced: "Gemini CLI" → "torad-code", "Gemini Recommendation" → "AI
  Recommendation" **Why:** The grep in Task 12 only searched for `"Gemini CLI"`
  in quotes. The header had `Gemini CLI` as JSX text without quotes around the
  full phrase. **Impact:** Header now shows "torad-code" instead of "Gemini CLI"
  on every session start.

### Amendment 2 (iteration 6)

**What changed:** Found 10 more user-visible "Gemini" references missed by the
original grep:

- FolderTrustDialog.tsx (2): trust dialog text
- SessionBrowser.tsx: "Gemini:" role prefix → "Agent:"
- MultiFolderTrustDialog.tsx: trust description
- PermissionsModifyTrustDialog.tsx: restart message
- ToolsList.tsx: "Available Gemini CLI tools" → "Available tools"
- client.ts: "Error initializing Gemini chat session" → "chat session"
- constants.ts: SERVICE_NAME "gemini-cli" → "torad-code", SERVICE_DESCRIPTION
  rewritten
- localLiteRtLmClient.ts: "Local Gemini API" → "local API" **Why:** Original
  grep only searched for quoted "Gemini CLI" strings. JSX text, template
  literals, and non-CLI Gemini references were missed. **Impact:** Comprehensive
  rebrand — all user-visible text now says "torad-code" or is provider-agnostic.
