# AGENTS.md

## Layout

- `src/main.rs` — the whole server: axum routes, token auth, child-process
  supervision, SSE broadcast. Keep the UI embedded via `include_str!`.
- `web/` — plain HTML/CSS/JS, no build step, hosted on Netlify from `web/`
  (`netlify.toml`). Without a backend it falls back to demo mode; the key dialog
  can point it at a remote Rust server (`Server URL`, stored in localStorage).
- `buttons.json` — operator-editable list of buttons (`program` + `args`, never a
  shell string).

## Commands

```bash
cargo run                  # http://127.0.0.1:8787, token printed on startup
cargo test                 # unit tests in src/main.rs
cargo clippy --all-targets -- -D warnings
cargo fmt --all
```

## Rules

- No shell execution. A button is `Command::new(program).args(...)`.
- New API routes that mutate state must call `require(&state, &headers)`.
- SSE consumers authenticate with `?token=` because `EventSource` cannot set
  headers.
- Cross-origin UI (Netlify) needs `BTN_ORIGINS`; keep `netlify.toml` publishing
  `web/` and do not add a build step.
- Do not commit tokens, `.env`, or local logs.
- CI is the source of truth for builds; this repo is expected to compile without
  a local Rust toolchain.
