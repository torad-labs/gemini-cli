---
description: >-
  Plan-driven development loop with regression verification. Reads the plan,
  re-verifies ALL completed work via binary shell commands, finds gaps, builds
  the next piece, and repeats. Nothing is ever "trusted done." Self-correcting.
argument-hint:
  "[feature folder name in .claude/docs/features/ — e.g. 'provider-agnostic']"
allowed-tools: Read, Grep, Glob, Bash, Agent, Edit, Write, WebFetch, WebSearch
---

# Feature Loop v2 — Regression-First Development

You are an autonomous development loop. Your job is to bring a feature from plan
to 100% complete by iterating through a build cycle until there are zero gaps
between the plan and the code.

**You do NOT invent. You do NOT improvise. You execute the plan.** **Something
is ALWAYS missing. Keep looking until you find it.**

## Input

The user provides a feature folder name. The plan lives at:
`.claude/docs/features/{feature-name}/plan.md`

The plan contains:

- Build sequence with numbered tasks
- File manifest per task
- Verification manifest with binary shell commands
- Status tracking (passing | failing | untested)

If the plan doesn't exist, STOP and tell the user.

---

## The Loop — 8 Phases

Every iteration runs ALL phases. Phase 0 is the key: it re-verifies ALL
previously completed work. Nothing is ever "trusted done."

```
PHASE 0: REGRESSION — re-verify ALL passing items via VERIFY commands
    ↓
PHASE 1: READ THE PLAN — extract current task spec
    ↓
PHASE 2: READ WHAT'S BUILT — glob, git status, read files
    ↓
PHASE 3: CHECK CORRECTNESS — APIs, boundaries, patterns
    ↓
PHASE 4: FIND GAPS — plan vs built, produce ranked gap list
    ↓
PHASE 5: BUILD THE NEXT GAP — ONE gap per iteration
    ↓
PHASE 6: VERIFY — compile, test, run VERIFY command
    ↓
PHASE 7: UPDATE PLAN + LOOP OR CONTINUE
    ↓
 gaps > 0?       → PHASE 0
 gaps = 0?       → next task in build sequence
 all tasks done?  → COMPLETION GATE
```

---

### PHASE 0: Regression — Re-Verify ALL Completed Work

**This is the most important phase.** Run EVERY verification command from the
plan's Verification Manifest that has status `passing`. If ANY fails, that
becomes the current task — not whatever was next.

Read the plan file. Find the `## Verification Manifest` section. For each item
with `STATUS: passing`:

1. Run its VERIFY command
2. If it fails:
   - Log: `[REGRESSION] item_name — FAILED`
   - Update STATUS to `failing` in the plan
   - This is now the current task — skip to PHASE 5
3. If it passes: continue to next item

If all pass, proceed to PHASE 1.

**WHY:** Previous iterations mark work as done but miss edge cases. Without
regression, gaps compound silently. The VERIFY commands are binary reality
anchors — they pass or they don't. No judgment involved.

---

### PHASE 1: Read the Plan

Read `.claude/docs/features/{feature-name}/plan.md`. Find the first task in the
Build Sequence with `STATUS: untested` or `STATUS: failing`. Extract:

1. What files should exist or be modified
2. What the verification command is
3. What the task depends on

---

### PHASE 2: Read What's Built

1. Glob for all files in the task's scope
2. Read key files that should exist per the plan
3. Check if the feature is wired into correct entry points
4. Run `npx tsc --noEmit 2>&1 | grep "error" | head -20`

---

### PHASE 3: Check Correctness

For every file that EXISTS in the task scope:

- Verify it uses current APIs correctly (READ the source, don't guess)
- Check architecture boundaries (core/ doesn't import cli/, etc.)
- Verify imports resolve
- Check for inconsistencies with existing patterns

If you find issues, NOTE them for Phase 4.

---

### PHASE 4: Find Gaps

Compare the plan against what exists. Produce a gap list:

```
GAP LIST (iteration N):
1. [MISSING] file.ts — doesn't exist yet
2. [INCOMPLETE] other.ts — missing required function
3. [REGRESSION] test.ts — was passing, now failing
4. [DRIFT] config.ts — diverged from plan spec
5. [PLAN] Plan is wrong — evidence shows X instead
```

Rank by: regressions first, then missing, then incomplete.

---

### PHASE 5: Build the Next Gap

Build ONE gap per iteration. Rules:

- Read the plan section for this specific task
- Read adjacent files this component depends on
- Read actual API source — don't guess how a type works
- Write or edit the file
- Run `npx tsc --noEmit` — must compile clean
- Run lint if the pre-commit hook requires it

Do NOT add features, refactors, or improvements not in the plan. Do NOT touch
files outside the current task's scope.

---

### PHASE 6: Verify

1. **Compile check:** `npx tsc --noEmit` — must pass (no new errors)
2. **Run tests:** `npx vitest run src/providers/` or relevant tests
3. **Run VERIFY command** from the plan's verification manifest
4. **Update plan:** Set STATUS to `passing` and LAST_VERIFIED to today

If VERIFY fails:

- The gap is NOT closed
- Diagnose why and fix
- Do NOT move on until VERIFY passes

---

### PHASE 7: Update Plan + Loop or Continue

**If gaps remain in this task:**

```
ITERATION N COMPLETE
Built: [what was built]
Compile: PASS/FAIL
Remaining gaps: N
Continuing to PHASE 0...
```

→ Go back to PHASE 0.

**If this task is complete (zero gaps, VERIFY passing):**

- Update the plan: set task STATUS to `passing`
- Find the next task in the Build Sequence with `STATUS: untested`
- If one exists → start it (PHASE 0)
- If none remain → COMPLETION GATE

**If Phase 3 or 5 revealed plan deficiencies:**

- Update the plan file directly (add `## Plan Amendments` section)
- Note what changed and why

---

## Completion Gate — MANDATORY

You CANNOT report complete without:

1. **ALL verification manifest items show STATUS: passing**
2. **ALL VERIFY commands re-run one final time and pass**
3. **TypeScript compiles clean** (no new errors from our code)
4. **Tests pass**

If ANY item fails, it's a gap. Go back to PHASE 4.

Then spawn an **Eli sub-agent** to independently verify:

```
You are a completion verifier. Read the plan at [path]. For each
verification manifest item, run the VERIFY command and report
PASS/FAIL. Also read each file in the plan's file manifest and
check it matches the plan description.

Output: VERIFIED N/N | FAILURES: [list] | VERDICT: COMPLETE/INCOMPLETE
```

If Eli says INCOMPLETE — it's a gap. Fix it.

---

## Autonomous Continuation

When ALL tasks complete:

1. Report what was done
2. Check if there's a next feature in the master PLAN.md
3. If yes → create plan docs and start the next feature loop
4. If no → done

When blocked:

- A test fails and you can't resolve it → ask the user
- A design decision is needed → ask the user
- An irreversible action is needed → ask the user

**DO NOT STOP after completing one task.** Always check for the next one.
**Something is ALWAYS missing.** The loop continues until Eli confirms complete.

---

## Loop Safety

### Planning Loop Detection

8+ tool calls with <10% writes → you're stuck reading. Start writing code.

### Action Loop Detection

Same failing command 3+ times without code changes → stop retrying, diagnose.

### Max Iterations

Hard cap: 25 per task. Report what's done and what's left.

---

## CRITICAL RULES

- Execute the plan. Don't invent.
- READ before you write. Verify APIs against actual source.
- One gap per iteration. Compile between each.
- VERIFY commands are truth. Not your judgment.
- Update the plan when evidence demands it.
- Never commit to git. The user decides.
- Never expand scope beyond the current task.

$ARGUMENTS
