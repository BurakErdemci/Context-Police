# Context Police

A background auditor for AI coding-agent memory. It watches agent sessions,
extracts durable findings, and flags memory notes that have silently gone stale.

**Status:** prototype, milestone M4. Not released, no published package.
Working name — the product name is still open.

---

## The problem

Agent memory is written once and trusted forever. Compaction only summarises the
current conversation; it cannot carry durable project knowledge — architectural
decisions, walls already hit, measurements already taken.

Worse, notes decay silently. Code moves, the note stays, and the agent keeps
treating it as true. The note is not wrong in any way the agent can see, because
the agent's evidence for it is the note.

That decay is measurable. On a real 329-commit project with 28 existing memory
notes, **61% had rotted** (17 of 28). That measurement is what started this
project, and killing it cheaply was an acceptable outcome — a low decay rate
would have ended it on day one.

## What it does

Two functions over one store:

- **Observe** — watch transcripts, extract durable findings into a knowledge base.
- **Audit** — verify that store against the code and flag what rotted.

Findings never go back into the live session. They go to a review queue; the
user approves; approved fixes are written to the memory files on disk, where the
agent picks them up on its next read.

## How decay is detected

No single signal declares a note dead. Signals produce a suspicion score, and
the expensive adjudication runs on the ranked queue.

| Signal | Strength |
|---|---|
| Contradiction between two notes | Strong — purely internal, cheap; at least one must be wrong |
| Anchor drift (file/symbol/SHA moved) | Strong — file deleted means the note is dead |
| Note age alone | Weak — never used standalone |

Age is deliberately weak: an old note whose anchors never moved is likely the
*most* reliable note in the store.

The mechanical layer is precise but blind (measured: 6 of 17 rotted notes
caught, 0 of 11 false alarms). Above it sits an **adjudicator** — a clean-context
model call with tool access, framed as a measurement task rather than a recall
task. Asking a model "is your memory still correct?" queries the same delusion
that produced the error; asking it "these two statements conflict, read the
files and `git log`, then say which holds" gets an answer from disk.

Current adjudicator baseline against the golden set: **recall 53/60 (88.3%),
24 false alarms**. The M4 exit gate is recall ≥80%, false alarms <12, and
per-note cost at one tenth of today's.

## Nothing is ever deleted

There is no delete operation. A decayed note is marked `superseded`: the agent
stops reading it, the record stays.

This is the answer to the false-positive risk. If the auditor is wrong, the cost
is zero and recovery is one click — and the auditor's own error rate becomes
measurable, because the ratio of reversed decisions is exactly that number.

## Architecture

Three constraints that shaped everything else:

**Bounded observation.** Observer context stays flat regardless of session
length — a 700k-token session is watched with a ~10–15k observer context.
State advances as `new_state = f(previous_state, latest_turn)`; the observer
reads only the newest turn plus its own accumulated state.

**Append-only findings.** The observer never re-compresses its own state.
Summary-of-summary loses fidelity every cycle and the loss is invisible — which
is the decay problem reproduced inside the tool. New turns append records or
mark existing ones superseded; they never rewrite.

**Change-triggered, not clock-triggered.** Decay is caused by code changing, not
by time passing. Audits trigger on commits landing in files a note is anchored
to, not on a schedule.

```
core/src/
  adapters/     transcript formats + model executors (one adapter, seam defined)
  importer/     memory-note parsing, anchor extraction
  observer/     bounded incremental loop
  signals/      anchor drift, contradiction, coverage, classification
  store/        SQLite schema, findings, verdicts
  audit.ts      scoring and the decision path
  cli.ts        scan / observe / audit
tools/altin-set/  measurement instruments — NOT the product
docs/olcumler/    measurement reports and the golden set
```

`tools/` is not a dependency of `core/`, and `core/` is not a dependency of
`tools/`. The measuring instrument stays outside the thing it measures.

## Running it

Node ≥24. **Zero runtime dependencies** — `node:sqlite`, `node:test`, and native
TypeScript type-stripping. The test suite runs in a bare worktree with no
`node_modules` present.

```bash
cd core
npm test              # 537 tests
npm run test:tools    # 172 tests
npm run typecheck

node --disable-warning=ExperimentalWarning src/cli.ts scan
node --disable-warning=ExperimentalWarning src/cli.ts observe --project <path>
node --disable-warning=ExperimentalWarning src/cli.ts audit   --project <path>
node --disable-warning=ExperimentalWarning src/cli.ts status
```

Two defaults are worth knowing, and both are deliberate:

- **No network unless `--fetch` is passed.** The repository being audited is
  selected from transcript data, and a fetch would run whatever that
  repository's own configuration says to run.
- **A run makes at most 20 paid model calls unless `--yes` is passed.** `audit`
  prints its estimate before spending anything and stops without a single paid
  call if the estimate exceeds the cap. `observe` stops mid-work instead,
  leaving the watermark unadvanced so no data is lost.

`audit` marks suspects **in the store**. It never writes to a memory file.

## Measurement discipline

The project audits memory for silent decay, so its own claims are held to the
same bar. Two rules earned the hard way:

**A check is only proven non-vacuous by breaking it.** A passing check does not
show the check works; a deliberately corrupted input that still passes shows
exactly that it does not. This caught a real one: the golden-set corrector
matched targets by claim id alone, and a negative control (shifting an id to its
neighbour) sailed through while silently relabelling an unrelated claim.

**In any measurement comparing two sources, the matching criterion is itself an
error source.** A disagreement measurement once reported 24 hard conflicts; a
third independent pass found 58% of them were artefacts of the matcher and only
12.5% were real judgment differences. The instrument's error was larger than the
signal.

The most expensive finding to date was a published number being wrong: coverage
was derived from the judge's own output, so a note the judge failed on dropped
out of the denominator — **the instrument breaking raised the score**.

## Scope

Prototype covers Claude Code transcripts only. Hook-based ingestion, other CLI
adapters, autonomous scheduling, and auto-fix without approval are explicitly
deferred. The dashboard is M5.

## License

[MIT](LICENSE) © 2026 Burak Emre Erdemci
