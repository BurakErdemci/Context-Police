# Context Police — desktop shell

A thin Tauri v2 window around the existing local web app. It contains no UI of its
own: `core/` (the `serve` HTTP server and `core/web/`) is untouched and remains the
single source of the interface.

## Run

```sh
source "$HOME/.cargo/env"        # cargo is not on PATH by default
cd desktop/src-tauri
cargo run
```

The first build takes a few minutes; later builds are seconds. `cargo tauri dev` is
not needed — there is no frontend build step, the webview just loads a URL.

## What the shell does

1. **Probe** `http://127.0.0.1:4870/api/version` (3 attempts, 600 ms each).
2. **Attach or spawn**
   - reachable → use that server, spawn nothing;
   - not reachable → spawn `node --experimental-strip-types core/src/cli.ts serve
     --port 4870` from the repo root, then poll `/api/version` for up to 10 s.
3. **Window** — created only after step 2 returns, so the webview never races the
   server boot. Title "Context Police", 1280x860, min 900x640.
4. **Exit** — the child is killed only if *we* spawned it. A server that was
   already running is somebody else's process and is left alone.

### Environment variables

| Variable | Purpose |
|---|---|
| `CONTEXT_POLICE_ROOT` | Override the repo root (see limitations). |
| `CONTEXT_POLICE_PORT` | Override port 4870. Exists so the spawn path can be tested while another server holds the default port. |

### Shutdown paths

`RunEvent::Exit` covers the normal quit paths (closing the window, Cmd+Q). Measured
17 Aug 2026: a **signal** (SIGTERM/SIGINT/SIGHUP) never reaches that lifecycle hook
and the spawned node server survived as an orphan holding the port. A signal handler
now kills the owned child before re-raising, and this path is verified. The
`RunEvent::Exit` path itself is code-only — it was not exercised headlessly.

## V1 limitations

- **Dev-mode paths.** The repo root is derived from the compile-time
  `CARGO_MANIFEST_DIR` (`<repo>/desktop/src-tauri` → `<repo>`). This only holds when
  the binary is run out of the repo. `CONTEXT_POLICE_ROOT` overrides it.
- **No bundling.** `cargo build` / `cargo run` only; no `.app`/`.dmg` is produced. A
  bundled app would need `node` and `core/` shipped or located at runtime, which the
  compile-time path assumption cannot do.
- **`node` must be on PATH** (>= 24, for `--experimental-strip-types`).
- **Placeholder icon**, hand-generated. Design pass pending.
- **Port 4870 is fixed** in the default configuration; there is no port negotiation
  if something unrelated already holds it (the shell would attach to whatever
  answers `/api/version`).
