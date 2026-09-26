<!-- status: historical input — reviewed and dispositioned; the original
feedback is retained verbatim below. Do not treat it as current guidance. -->

# `defined` — Top 20 Improvements

> **Historical record.** This is the original ChatGPT feedback reviewed during
> the scope correction. It has been dispositioned and is kept verbatim for the
> record. The **current** public contract is `defined comply` (the local/agent
> loop) and `defined verify` (the pipeline-only read-only check) — the
> `setup`/`fix` commands referenced throughout below were retired. Product and
> architecture decisions are recorded in the plan of record; see `PLAN.md` and
> the README for what is true today.

## Product / architecture

### 1. Make `defined` the product, not "coding standards"

Position the project as a **portable, drop-in engineering quality gate**.

Core promise:

> Define standards once. Distil them into agent guidance. Enforce them mechanically. Return control only when the repository is green.

`.editorconfig`, lint configs, workflow templates, SonarQube integration, etc. are implementation details of that larger system.

---

### 2. Make "local green = pipeline green" the primary invariant

Treat this as an architectural guarantee, not marketing copy.

The exact same pinned container, tooling, orchestration and rules must run locally and in CI.

The workflow ref and image tag should continue to represent the **same `defined` release SHA**.

---

### 3. Treat standards as the true source of truth

The conceptual flow should be:

```text
standards
   ↓
derived artifacts
   ├── agent guidance
   ├── editor configuration
   ├── tool configuration
   └── quality-gate rules
```

Avoid creating independent sources of truth for the same rule.

---

### 4. Treat agent guidance as a compiled artifact

`AGENTS.md` and future agent-specific guidance should be **derived from standards**, not maintained as a separate specification.

That makes guidance disposable/rebuildable and prevents standards drifting away from what agents are told.

---

### 5. Make the agent completion contract explicit

The agent should not decide that a task is finished.

The completion protocol should effectively be:

```text
implement
→ defined fix
→ defined verify
→ if failing: repair
→ repeat
→ only then return control
```

The gate is the authoritative completion boundary.

---

## Enforcement / repair

### 6. Elevate auto-fix to a first-class capability

`defined` should actively repair mechanically-correctable problems wherever tools support it.

Examples already identified:

- ESLint
- Prettier
- TFLint
- dotnet format
- shfmt
- other formatters/linters with safe fix modes

The philosophy is:

> **If a CPU can fix it deterministically, don't spend LLM tokens fixing it manually.**

---

### 7. Separate failures into "fix", "report", and "review"

Give every check a clear disposition:

```text
FIX
  machine can safely repair it

REPORT
  machine can detect it, but reasoning is required

REVIEW
  human/agent judgement is required
```

This should become part of the gate's internal model rather than an informal convention.

---

### 8. Optimise the gate for zero-token remediation

The gate should do as much work as possible before asking the agent to reason.

Desired flow:

```text
code
 ↓
defined
 ↓
mechanical fixes
 ↓
re-check
 ↓
remaining semantic failures
 ↓
agent reasoning
```

Minimise token use for formatting, imports, mechanical lint fixes, etc.

---

### 9. Never hide missing enforcement dependencies

Keep the current fail-loudly behaviour.

If a pinned tool is required by an applicable ecosystem and isn't available, the gate should fail clearly rather than silently downgrading enforcement.

Absence of an ecosystem may skip.

Absence of a required tool must not.

---

### 10. Keep `verify` deterministic and side-effect-free

`defined verify` should mean:

> **Tell me whether this repository currently conforms.**

All modification should belong to `defined fix`.

That makes CI behaviour predictable and keeps the semantic distinction between checking and repairing clean.

---

## CLI / developer experience

### 11. Make the CLI mental model tiny

Aim for a small vocabulary:

```bash
defined setup
defined fix
defined verify
```

Optionally:

```bash
defined explain
```

The user should not need to know which underlying tools are involved.

---

### 12. Make `defined fix && defined verify` the canonical local workflow

Document this as the normal developer/agent loop.

The ideal experience is:

```bash
defined fix
defined verify
```

and then you're done.

---

### 13. Make failures highly actionable for agents

Gate output should distinguish:

- what failed
- which rule caused it
- whether it was auto-fixed
- what remains
- which file(s) matter
- what command/tool owns the failure
- whether another verification pass is required

The output should be useful both to humans and to an LLM consuming stdout.

Prefer structured, stable failure semantics over prose-only diagnostics.

---

### 14. Give the agent a deliberately small instruction surface

Don't fill `AGENTS.md` with every individual lint rule.

Agent guidance should explain:

- what `defined` is
- that standards are authoritative
- how to run `defined fix`
- how to run `defined verify`
- that the gate must be green before returning control
- how to interpret failures

Let the executable gate carry the detailed rules.

---

## Architecture / maintainability

### 15. Preserve the three-way separation of concerns

Keep these concepts distinct:

```text
standards = WHAT good looks like
defined   = HOW conformity is verified/repaired
pipelines = HOW common delivery actions are executed
```

Don't let the runtime become a miscellaneous dumping ground.

---

### 16. Separate universal rules from ecosystem-specific enforcement

Maintain a clear distinction between:

```text
universal baseline
      +
language/platform profile
      =
effective project standard
```

The universal layer should remain genuinely portable.

Ecosystem-specific rules should live in their appropriate step/profile rather than leaking into the global model.

---

### 17. Preserve "raises-only" adoption

`defined setup` should install the baseline without destroying stricter consumer-project choices.

The contract should remain:

> `defined` provides the floor; projects may tighten it.

Where generated configuration is involved, make drift explicit and detectable.

---

### 18. Protect the release identity invariant

Keep the current principle:

```text
Git SHA
 ├── reusable workflow ref
 └── container image tag
```

Treat that pairing as immutable release identity.

A consumer pinned to one SHA should know exactly which executable toolchain it is getting.

---

## Bigger strategic improvements

### 19. Add an explicit standards → guidance → enforcement model to the documentation

Document the whole architecture visually and repeatedly:

```text
             STANDARDS
                 │
        ┌────────┴────────┐
        ▼                 ▼
 AGENTIC GUIDANCE       GATE
        │                 │
        ▼                 ▼
     AGENTS            FIX/VERIFY
        │                 │
        └────────┬────────┘
                 ▼
               CODE
                 │
                 ▼
                CI
```

This is the conceptual model that makes `defined` different from a conventional lint/configuration repository.

---

### 20. Make "no red X surprises" an explicit product goal

Optimise the entire system around one developer experience:

> **The PR should never be the first place you discover a quality failure.**

That means:

```text
agent edits
    ↓
defined fixes
    ↓
defined verifies
    ↓
local green
    ↓
push
    ↓
same container
    ↓
pipeline green
```

The embarrassing red X should be an exceptional event, not part of the normal development loop.

---

# Core principles to preserve

The agent should treat these as architectural invariants:

1. **Standards are the source of truth.**
2. **Agent guidance is derived from standards.**
3. **The gate is the authority on completion.**
4. **Machines fix what machines can safely fix.**
5. **LLM reasoning is reserved for problems requiring judgement.**
6. **`verify` verifies; `fix` repairs.**
7. **Missing applicable tooling fails loudly.**
8. **Consumer projects may tighten the baseline.**
9. **Local and CI use the same pinned runtime.**
10. **Local green must mean pipeline green.**
