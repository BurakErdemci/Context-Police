# Context Police (working name)

> A background auditor for AI coding-agent memory. It watches CLI agent sessions,
> extracts durable findings, and flags memory notes that have silently gone stale.

**Owner:** Burak Emre Erdemci
**Status:** design phase — prototype window ~15 days
**Primary test bed:** this repo itself + GaMachine (329 commits, existing memory files)

---

## 1. The problem

Agent memory is written once and trusted forever. `/compact` only summarises the
*current conversation* — it cannot carry durable project knowledge: architectural
decisions, walls already hit, measurements already taken, lessons already learned.

Worse, memory notes decay silently. Code moves, the note stays, and the agent keeps
treating it as true. Nothing today detects this.

Two functions, one store:
- **Observe** — watch sessions, extract durable findings into a knowledge base.
- **Audit** — continuously verify that store against the code, flag what rotted.

---

## 2. Non-negotiable architectural decisions

These were reasoned through and should not be silently reversed.

### 2.1 Never write into a live session
The auditor reads transcripts and memory files; it never injects into the agent's
context. Two reasons:
- **Independence** — an agent holding a stale note believes that note. Asking it
  "is your memory current?" queries the same delusion that produced the error.
  The arbiter is the code (`git log`, current file state), not the agent.
- **Purity** — `--resume` sessions are the user's working history. Robot Q&A must
  not appear in it.

Findings go to the dashboard. The user approves. Approved fixes are written to the
**memory files on disk** — the agent picks them up on its next read.

**Nuance — bias lives in the question, not the model.** Coding agents reach for
tools rather than assumptions; asked to verify something, they grep, read the file,
check `git log`. So the fix is to *frame the audit as a measurement task*, not a
recall task:

- ✗ "Is this note in your memory still correct?" — asks a model that already
  absorbed the note as true. Answers from the delusion.
- ✓ "These two statements conflict. Read the relevant files and `git log`, then say
  which one holds today." — answer comes from disk, not from context.

And note the consequence: if the answer comes from tools, **the live session is
irrelevant to it.** A clean-context call with tool access produces the same result
without reloading 700k tokens or polluting `--resume` history. That is why §2.1
holds even though agents are good at verifying.

### 2.2 Incremental observation, never full-transcript
Observer context must stay bounded regardless of session length. A 700k-token
session is watched with a ~10–15k observer context.

```
new_state = f(previous_state, latest_turn)
```

The observer reads only the newest turn plus its own accumulated state.

### 2.3 Append-only findings, never re-summarised
Do **not** let the observer re-compress its own accumulated state each turn.
Summary-of-summary loses fidelity every cycle, and the loss is invisible — which
is the exact decay problem, reproduced inside the tool.

Instead: each finding is a discrete record.

```
finding {
  id
  content
  anchors     [file paths, symbols, commit SHAs]
  created_at  [turn / commit]
  status      active | suspect | superseded
  superseded_by
}
```

New turns **append** records or mark existing ones superseded. They never rewrite.

### 2.4 Trigger on change, not on a clock
"Every 2–3 days" is the wrong axis. Decay is caused by code changing, not by time
passing. Trigger on: N commits landed in files a note is anchored to; or a session
untouched while its anchors moved.

---

## 3. Decay signals

No single signal declares a note dead. They produce a **suspicion score**; the
expensive LLM adjudication runs only above threshold.

| Signal | Strength | Notes |
|---|---|---|
| **Contradiction** between two notes | **Strong** | Purely internal, cheap, low false-positive rate. At least one of the two must be wrong. |
| **Anchor drift** — note's file/symbol/SHA moved | **Strong** | File deleted → note is dead. Signature changed → likely wrong. Comment-only change → note is fine. |
| Note age alone | **Weak — do not use standalone** | An old note whose anchors never moved is likely the *most* reliable note in the store. Age only matters as a ratio: old note + heavy churn in its anchors. |

### 3.1 Usage tracking ≠ correctness
No native trace exists for whether an agent actually *used* a note. It can be
approximated from transcripts (overlap between note content and what the turn
touched).

Critical distinction:
- **Unused note** → may still be correct. Dormant, not dead. A rarely-touched
  module's architecture note is gold the day you return to it. **Archive, never
  delete.**
- **Used and wrong** → the real danger. Misleads every single turn.

Prioritisation follows directly: **high usage × high decay risk** goes to the top
of the queue. That ordering is where the expensive audit budget gets spent.

---

## 3.2 Nothing is ever deleted

There is no delete operation. A decayed note is marked `superseded` — the agent
stops reading it, the record stays.

This is the primary answer to the false-positive risk: if the auditor is wrong, the
cost is zero and recovery is one click. It also makes the auditor's own error rate
**measurable** — the ratio of reversed decisions is exactly that number, and it
accumulates for free.

Archive and restore. Never delete.

### Second opinion (for `suspect` findings only)

A separate adjudication call, **not** the live session:

- Clean context, tool access enabled
- Input: the conflicting statements + relevant file paths
- Task framed as measurement (see §2.1 nuance), never as recall
- Same structure as the existing `codex-delegate` review loop / Divan cross-examination

Gate this on data: if the retrospective measurement (§5) shows a low false-positive
rate, the second call is wasted tokens. Add it only if the number justifies it.

---

## 4. Ingestion

Independent tool, not tied to any IDE. One-click session attach (GaMachine's
onboarding philosophy carries over).

| Path | Mechanism | Trade-off |
|---|---|---|
| **Transcript (pull)** | Watch `~/.claude/projects/**.jsonl` | Zero setup, catches already-running sessions, list of active sessions comes free. Format undocumented — may break across CLI versions. |
| **Hook (push)** | Install hooks into CLI settings | Real-time, clean. Only covers sessions started after install. |

**Prototype starts with transcript/pull on Claude Code.** Hooks are v2.

Each CLI has its own transcript format → adapter interface from day one, but only
**one implementation** in the prototype. (Lesson carried over from the engine
adapter discussion: define the seam early, implement one.)

---

## 5. 15-day prototype scope

**In:**
1. Transcript watcher — Claude Code only, session list + turn parsing
2. Incremental observer loop — bounded context, append-only findings
3. Contradiction detection across the findings store
4. Anchor-drift check against `git`
5. Minimal dashboard — what rotted, what was fixed, what needs approval

**Out (explicitly deferred):**
- Hook-based ingestion
- Codex / agy adapters
- Autonomous background scheduling
- Usage-frequency tracking
- Auto-fix without approval

**Day-one task before any code:** run a retrospective decay measurement on
GaMachine's existing memory files. How many notes are still true? How many rotted
silently? Which commit broke them? A low decay rate kills the project cheaply — a
good outcome. A high rate makes every design decision above data-driven instead of
assumed.

---

## 6. Open questions

- **Name.** "Context Police" is a good codename, wrong product name — the job is
  producing a trust score, not punishing. Decide later.
- **Adjudication cost.** How many LLM calls per audit cycle is acceptable? This
  sets the suspicion threshold.
- ~~False positives destroying context~~ — **resolved in §3.2:** no deletion exists,
  only `superseded`. Cost of a wrong flag is zero, and the reversal rate becomes the
  error-rate metric.
- **Where do findings live?** Alongside the project (`.claude/`), or in a central
  store keyed by project path? Affects portability and git noise.

---

## 7. Working style

- Architect directs, AI implements. Architectural calls are made here, not by the
  implementing agent.
- Anchor notes to file paths and commit SHAs so drift is detectable rather than
  silent. (This project is that principle, productised.)
- Prefer cheap validation before building. The retrospective measurement in §5
  exists because of this.
