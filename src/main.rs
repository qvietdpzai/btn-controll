//! BTN Control — a tiny web control panel written in Rust.
//!
//! One binary serves an embedded single-page UI plus a JSON/SSE API that runs
//! the commands listed in `buttons.json`. It never goes through a shell: a
//! button is one program and an argument vector, and only the operator can
//! change that file.
//!
//! Environment:
//!   BTN_ADDR    listen address (default `127.0.0.1:8787`)
//!   BTN_TOKEN   access token (default: random, printed on startup)
//!   BTN_CONFIG  path to buttons.json (default `./buttons.json`)

use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    net::SocketAddr,
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    net::TcpListener,
    process::{Child, Command},
    sync::{broadcast, Mutex},
    time,
};
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};

const DEFAULT_CONFIG: &str = include_str!("../buttons.json");
const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const STYLE_CSS: &str = include_str!("../web/style.css");
const ICON_SVG: &str = include_str!("../web/icon.svg");
const LOG_LIMIT: usize = 300;

type ApiResult<T> = Result<T, (StatusCode, String)>;

#[derive(Clone, Deserialize)]
struct ButtonCfg {
    id: String,
    label: String,
    #[serde(default)]
    description: String,
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    confirm: bool,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

#[derive(Deserialize, Default)]
struct Config {
    #[serde(default)]
    buttons: Vec<ButtonCfg>,
}

#[derive(Default)]
struct Slot {
    running: bool,
    child: Option<Child>,
    last_exit: Option<i32>,
    last_started: Option<u64>,
    last_finished: Option<u64>,
    runs: u64,
    log: VecDeque<String>,
}

struct AppState {
    token: String,
    buttons: Vec<ButtonCfg>,
    slots: Mutex<HashMap<String, Slot>>,
    tx: broadcast::Sender<String>,
    started: u64,
}

#[derive(Serialize, Clone)]
struct ButtonView {
    id: String,
    label: String,
    description: String,
    confirm: bool,
    running: bool,
    last_exit: Option<i32>,
    last_started: Option<u64>,
    last_finished: Option<u64>,
    runs: u64,
    log: Vec<String>,
}

#[derive(Deserialize)]
struct EventQuery {
    token: Option<String>,
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("btn-controll: {err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let (config, source) = load_config();
    let button_count = config.buttons.len();
    let token = std::env::var("BTN_TOKEN")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(generate_token);
    let addr: SocketAddr = std::env::var("BTN_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8787".to_owned())
        .parse()?;

    let (tx, _receiver) = broadcast::channel(512);
    let slots = config
        .buttons
        .iter()
        .map(|button| (button.id.clone(), Slot::default()))
        .collect();

    let state = Arc::new(AppState {
        token: token.clone(),
        buttons: config.buttons,
        slots: Mutex::new(slots),
        tx,
        started: now(),
    });

    let router = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/style.css", get(style_css))
        .route("/icon.svg", get(icon))
        .route("/api/health", get(health))
        .route("/api/buttons", get(list_buttons))
        .route("/api/buttons/:id/run", post(run_button))
        .route("/api/buttons/:id/stop", post(stop_button))
        .route("/api/events", get(events))
        .with_state(state);

    let listener = TcpListener::bind(addr).await?;
    println!("BTN Control v{}", env!("CARGO_PKG_VERSION"));
    println!("  listening : http://{addr}");
    println!("  buttons   : {button_count} ({source})");
    println!("  token     : {token}");
    println!();
    println!("Open http://{addr} and paste the token above. Ctrl+C to stop.");

    axum::serve(listener, router).await?;
    Ok(())
}

fn load_config() -> (Config, String) {
    let explicit = std::env::var("BTN_CONFIG").ok();
    let path = explicit
        .clone()
        .unwrap_or_else(|| "buttons.json".to_owned());

    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Config>(&text) {
            Ok(config) => (config, path),
            Err(err) => {
                eprintln!("btn-controll: {path} is invalid ({err}); using the built-in config");
                (builtin_config(), "built-in".to_owned())
            }
        },
        Err(err) => {
            if explicit.is_some() {
                eprintln!("btn-controll: could not read {path} ({err}); using the built-in config");
            }
            (builtin_config(), "built-in".to_owned())
        }
    }
}

fn builtin_config() -> Config {
    serde_json::from_str(DEFAULT_CONFIG).unwrap_or_else(|err| {
        eprintln!("btn-controll: the built-in config is invalid: {err}");
        Config::default()
    })
}

fn generate_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(40)
        .map(char::from)
        .collect()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    Some(value.strip_prefix("Bearer ").unwrap_or(value).trim())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    bearer(headers).is_some_and(|token| constant_time_eq(token.as_bytes(), state.token.as_bytes()))
}

fn require(state: &AppState, headers: &HeaderMap) -> Result<(), StatusCode> {
    if authorized(state, headers) {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn view_of(button: &ButtonCfg, slot: Option<&Slot>) -> ButtonView {
    ButtonView {
        id: button.id.clone(),
        label: button.label.clone(),
        description: button.description.clone(),
        confirm: button.confirm,
        running: slot.is_some_and(|slot| slot.running),
        last_exit: slot.and_then(|slot| slot.last_exit),
        last_started: slot.and_then(|slot| slot.last_started),
        last_finished: slot.and_then(|slot| slot.last_finished),
        runs: slot.map_or(0, |slot| slot.runs),
        log: slot.map_or_else(Vec::new, |slot| slot.log.iter().cloned().collect()),
    }
}

fn ring_push(log: &mut VecDeque<String>, line: String) {
    if log.len() >= LOG_LIMIT {
        log.pop_front();
    }
    log.push_back(line);
}

fn push_log_locked(state: &AppState, id: &str, slot: &mut Slot, line: String) {
    ring_push(&mut slot.log, line.clone());
    let payload = json!({ "type": "log", "id": id, "line": line, "at": now() });
    let _ = state.tx.send(payload.to_string());
}

async fn push_log(state: &AppState, id: &str, line: String) {
    let mut slots = state.slots.lock().await;
    if let Some(slot) = slots.get_mut(id) {
        push_log_locked(state, id, slot, line);
    }
}

fn broadcast_button(state: &AppState, button: ButtonView) {
    let payload = json!({ "type": "button", "button": button });
    let _ = state.tx.send(payload.to_string());
}

fn spawn_reader<R>(state: Arc<AppState>, id: String, reader: R, tag: &'static str)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => push_log(&state, &id, format!("{tag} {line}")).await,
                Ok(None) => break,
                Err(err) => {
                    push_log(&state, &id, format!("{tag} read error: {err}")).await;
                    break;
                }
            }
        }
    });
}

fn spawn_monitor(state: Arc<AppState>, button: ButtonCfg) {
    tokio::spawn(async move {
        let mut deadline = button
            .timeout_secs
            .map(|secs| time::Instant::now() + Duration::from_secs(secs));

        loop {
            time::sleep(Duration::from_millis(250)).await;
            let mut update = None;

            {
                let mut slots = state.slots.lock().await;
                let Some(slot) = slots.get_mut(&button.id) else {
                    break;
                };

                let status = match slot.child.as_mut() {
                    Some(child) => child.try_wait(),
                    None => break,
                };

                match status {
                    Ok(Some(exit)) => {
                        slot.running = false;
                        slot.child = None;
                        slot.last_exit = exit.code();
                        slot.last_finished = Some(now());
                        let note = match exit.code() {
                            Some(code) => format!("■ exited with code {code}"),
                            None => "■ exited".to_owned(),
                        };
                        push_log_locked(&state, &button.id, slot, note);
                        update = Some(view_of(&button, Some(slot)));
                    }
                    Ok(None) => {
                        if let Some(at) = deadline {
                            if time::Instant::now() >= at {
                                if let Some(child) = slot.child.as_mut() {
                                    let _ = child.start_kill();
                                }
                                deadline = None;
                                push_log_locked(
                                    &state,
                                    &button.id,
                                    slot,
                                    "⏱ timeout reached, process stopped".to_owned(),
                                );
                            }
                        }
                    }
                    Err(err) => {
                        slot.running = false;
                        slot.child = None;
                        slot.last_finished = Some(now());
                        push_log_locked(
                            &state,
                            &button.id,
                            slot,
                            format!("! could not poll process: {err}"),
                        );
                        update = Some(view_of(&button, Some(slot)));
                    }
                }
            }

            if let Some(view) = update {
                broadcast_button(&state, view);
                break;
            }
        }
    });
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn app_js() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        APP_JS,
    )
}

async fn style_css() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        STYLE_CSS,
    )
}

async fn icon() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "image/svg+xml")], ICON_SVG)
}

async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "name": "btn-controll",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": now().saturating_sub(state.started),
        "buttons": state.buttons.len(),
    }))
}

async fn list_buttons(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<ButtonView>>, StatusCode> {
    require(&state, &headers)?;
    let slots = state.slots.lock().await;
    Ok(Json(
        state
            .buttons
            .iter()
            .map(|button| view_of(button, slots.get(&button.id)))
            .collect(),
    ))
}

async fn run_button(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<ButtonView>> {
    require(&state, &headers).map_err(|status| (status, "missing or invalid token".to_owned()))?;

    let button = state
        .buttons
        .iter()
        .find(|button| button.id == id)
        .cloned()
        .ok_or((StatusCode::NOT_FOUND, format!("unknown button: {id}")))?;

    {
        let slots = state.slots.lock().await;
        if slots.get(&button.id).is_some_and(|slot| slot.running) {
            return Err((
                StatusCode::CONFLICT,
                format!("{} is already running", button.label),
            ));
        }
    }

    let mut command = Command::new(&button.program);
    command
        .args(&button.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("BTN_BUTTON_ID", &button.id);

    if let Some(cwd) = &button.cwd {
        command.current_dir(cwd);
    }

    let mut child = command.spawn().map_err(|err| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not start {}: {err}", button.program),
        )
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let snapshot = {
        let mut slots = state.slots.lock().await;
        let slot = slots.entry(button.id.clone()).or_default();
        slot.running = true;
        slot.child = Some(child);
        slot.runs += 1;
        slot.last_started = Some(now());
        slot.last_exit = None;
        slot.last_finished = None;
        slot.log.clear();
        push_log_locked(
            &state,
            &button.id,
            slot,
            format!("▶ {} {}", button.program, button.args.join(" ")),
        );
        view_of(&button, Some(slot))
    };

    if let Some(stdout) = stdout {
        spawn_reader(state.clone(), button.id.clone(), stdout, "[out]");
    }
    if let Some(stderr) = stderr {
        spawn_reader(state.clone(), button.id.clone(), stderr, "[err]");
    }
    spawn_monitor(state.clone(), button);
    broadcast_button(&state, snapshot.clone());

    Ok(Json(snapshot))
}

async fn stop_button(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<serde_json::Value>> {
    require(&state, &headers).map_err(|status| (status, "missing or invalid token".to_owned()))?;

    let mut slots = state.slots.lock().await;
    let slot = slots
        .get_mut(&id)
        .ok_or((StatusCode::NOT_FOUND, format!("unknown button: {id}")))?;

    let child = slot
        .child
        .as_mut()
        .ok_or((StatusCode::CONFLICT, format!("{id} is not running")))?;

    child.start_kill().map_err(|err| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not stop {id}: {err}"),
        )
    })?;
    push_log_locked(&state, &id, slot, "⏹ stop requested".to_owned());

    Ok(Json(json!({ "ok": true, "id": id })))
}

async fn events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let supplied = query.token.or_else(|| bearer(&headers).map(str::to_string));
    let ok = supplied
        .as_deref()
        .is_some_and(|token| constant_time_eq(token.as_bytes(), state.token.as_bytes()));
    if !ok {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let stream = BroadcastStream::new(state.tx.subscribe()).filter_map(|item| match item {
        Ok(data) => Some(Ok::<Event, Infallible>(
            Event::default().event("update").data(data),
        )),
        Err(_) => None,
    });

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn tokens_compare_correctly() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secret "));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn builtin_config_is_usable() {
        let config = builtin_config();
        assert!(!config.buttons.is_empty());
        for button in &config.buttons {
            assert!(!button.id.trim().is_empty());
            assert!(!button.label.trim().is_empty());
            assert!(!button.program.trim().is_empty());
        }
    }

    #[test]
    fn button_ids_are_unique() {
        let config = builtin_config();
        let ids: HashSet<&str> = config.buttons.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids.len(), config.buttons.len());
    }

    #[test]
    fn generated_tokens_are_long_enough() {
        let token = generate_token();
        assert_eq!(token.len(), 40);
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn log_buffer_is_capped() {
        let mut log = VecDeque::new();
        for index in 0..(LOG_LIMIT + 25) {
            ring_push(&mut log, format!("line {index}"));
        }
        assert_eq!(log.len(), LOG_LIMIT);
        assert_eq!(log.front().map(String::as_str), Some("line 25"));
        let expected_last = format!("line {}", LOG_LIMIT + 24);
        assert_eq!(log.back().map(String::as_str), Some(expected_last.as_str()));
    }
}
