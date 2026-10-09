use std::{
    collections::{BTreeMap, HashMap},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use reqwest::{redirect::Policy, Client};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use crate::storage::PreviewStore;
use crate::{
    commands::CommandError,
    credentials::{SecretBackend, SystemKeyring},
    providers::{gateway_provider_candidates, GatewayProvider},
};

const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_UPSTREAM_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_ACTIVE_CONNECTIONS: usize = 8;

struct GatewayRouteConfig {
    failover_enabled: bool,
    max_attempts: usize,
    total_timeout: Duration,
    failure_threshold: u32,
    cooldown: Duration,
    half_open_max_requests: u32,
}

fn gateway_route_config(store: &PreviewStore) -> GatewayRouteConfig {
    let settings = store.read_settings().ok();
    let route = settings
        .as_ref()
        .and_then(|value| value.get("routeSettings"))
        .and_then(Value::as_object);
    GatewayRouteConfig {
        failover_enabled: route
            .and_then(|value| value.get("failoverEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        max_attempts: route
            .and_then(|value| value.get("failoverMaxAttempts"))
            .and_then(Value::as_u64)
            .unwrap_or(3)
            .clamp(1, 20) as usize,
        total_timeout: Duration::from_millis(
            route
                .and_then(|value| value.get("failoverTotalTimeoutMs"))
                .and_then(Value::as_u64)
                .unwrap_or(180_000)
                .clamp(1_000, 1_800_000),
        ),
        failure_threshold: route
            .and_then(|value| value.get("failoverFailureThreshold"))
            .and_then(Value::as_u64)
            .unwrap_or(3)
            .clamp(1, 100) as u32,
        cooldown: Duration::from_millis(
            route
                .and_then(|value| value.get("failoverCooldownMs"))
                .and_then(Value::as_u64)
                .unwrap_or(60_000)
                .clamp(1_000, 3_600_000),
        ),
        half_open_max_requests: route
            .and_then(|value| value.get("failoverHalfOpenMaxRequests"))
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 20) as u32,
    }
}

#[derive(Default)]
struct CircuitRegistry {
    states: Mutex<HashMap<String, CircuitState>>,
}

#[derive(Default)]
struct CircuitState {
    consecutive_failures: u32,
    opened_at: Option<Instant>,
    half_open_in_flight: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CircuitPermit {
    Closed,
    HalfOpen,
}

impl CircuitRegistry {
    fn acquire(&self, provider_id: &str, config: &GatewayRouteConfig) -> Option<CircuitPermit> {
        if !config.failover_enabled {
            return Some(CircuitPermit::Closed);
        }
        let mut states = self.states.lock().ok()?;
        let state = states.entry(provider_id.to_string()).or_default();
        let Some(opened_at) = state.opened_at else {
            return Some(CircuitPermit::Closed);
        };
        if opened_at.elapsed() < config.cooldown
            || state.half_open_in_flight >= config.half_open_max_requests
        {
            return None;
        }
        state.half_open_in_flight += 1;
        Some(CircuitPermit::HalfOpen)
    }

    fn available(&self, provider_id: &str, config: &GatewayRouteConfig) -> bool {
        if !config.failover_enabled {
            return true;
        }
        let Ok(states) = self.states.lock() else {
            return false;
        };
        let Some(state) = states.get(provider_id) else {
            return true;
        };
        match state.opened_at {
            None => true,
            Some(opened_at) => {
                opened_at.elapsed() >= config.cooldown
                    && state.half_open_in_flight < config.half_open_max_requests
            }
        }
    }

    fn complete(
        &self,
        provider_id: &str,
        permit: CircuitPermit,
        failed: bool,
        config: &GatewayRouteConfig,
    ) {
        if !config.failover_enabled {
            return;
        }
        let Ok(mut states) = self.states.lock() else {
            return;
        };
        let state = states.entry(provider_id.to_string()).or_default();
        if permit == CircuitPermit::HalfOpen {
            state.half_open_in_flight = state.half_open_in_flight.saturating_sub(1);
        }
        if !failed {
            states.remove(provider_id);
            return;
        }
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        if permit == CircuitPermit::HalfOpen
            || state.consecutive_failures >= config.failure_threshold
        {
            state.opened_at = Some(Instant::now());
        }
    }

    fn release(&self, provider_id: &str, permit: CircuitPermit) {
        if permit != CircuitPermit::HalfOpen {
            return;
        }
        if let Ok(mut states) = self.states.lock() {
            if let Some(state) = states.get_mut(provider_id) {
                state.half_open_in_flight = state.half_open_in_flight.saturating_sub(1);
            }
        }
    }

    fn clear_if_disabled(&self, enabled: bool) {
        if !enabled {
            if let Ok(mut states) = self.states.lock() {
                states.clear();
            }
        }
    }
}

pub struct GatewayState {
    runtime: Mutex<Option<GatewayHandle>>,
}

struct GatewayHandle {
    endpoint: String,
    data_directory: std::path::PathBuf,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Default for GatewayState {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(None),
        }
    }
}

impl GatewayState {
    pub fn start(&self, store: &PreviewStore) -> Result<Value, CommandError> {
        self.start_with_backend(store, SystemKeyring)
    }

    fn start_with_backend<B: SecretBackend + 'static>(
        &self,
        store: &PreviewStore,
        backend: B,
    ) -> Result<Value, CommandError> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| gateway_error("GATEWAY_STATE", "网关状态不可用。"))?;
        if let Some(handle) = runtime.as_ref() {
            return Ok(status_value(
                true,
                &handle.endpoint,
                &PreviewStore::new(handle.data_directory.clone()),
            ));
        }

        let configured_port = configured_listen_port(store);
        let listener = TcpListener::bind(("127.0.0.1", configured_port)).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AddrInUse {
                gateway_error("GATEWAY_PORT_IN_USE", "本地网关监听端口已被占用。")
            } else {
                gateway_error("GATEWAY_BIND_FAILED", "无法绑定本地回环端口。")
            }
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|_| gateway_error("GATEWAY_BIND_FAILED", "无法配置本地监听器。"))?;
        let port = listener
            .local_addr()
            .map_err(|_| gateway_error("GATEWAY_BIND_FAILED", "无法读取本地端口。"))?
            .port();
        let endpoint = format!("http://127.0.0.1:{port}/v1");
        let token = store.local_gateway_api_key()?;
        store.assert_no_pending_migration()?;
        let data_directory = store.preview_data_directory().to_path_buf();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let join = thread::Builder::new()
            .name("cksw-tauri-gateway".into())
            .spawn(move || {
                serve(
                    listener,
                    thread_stop,
                    token,
                    PreviewStore::new(data_directory),
                    backend,
                )
            })
            .map_err(|_| gateway_error("GATEWAY_START_FAILED", "无法启动本地网关线程。"))?;
        *runtime = Some(GatewayHandle {
            endpoint: endpoint.clone(),
            data_directory: store.preview_data_directory().to_path_buf(),
            stop,
            join: Some(join),
        });
        Ok(status_value(true, &endpoint, store))
    }

    pub fn stop(&self, store: &PreviewStore) -> Result<Value, CommandError> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| gateway_error("GATEWAY_STATE", "网关状态不可用。"))?;
        let Some(mut handle) = runtime.take() else {
            return Ok(status_value(false, "未接入本地路由", store));
        };
        let data_directory = handle.data_directory.clone();
        handle.stop.store(true, Ordering::Release);
        if let Some(join) = handle.join.take() {
            join.join()
                .map_err(|_| gateway_error("GATEWAY_STOP_FAILED", "本地网关线程退出失败。"))?;
        }
        Ok(status_value(
            false,
            "未接入本地路由",
            &PreviewStore::new(data_directory),
        ))
    }

    pub fn status(&self, store: &PreviewStore) -> Result<Value, CommandError> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| gateway_error("GATEWAY_STATE", "网关状态不可用。"))?;
        Ok(match runtime.as_ref() {
            Some(handle) => status_value(true, &handle.endpoint, store),
            None => status_value(false, "未接入本地路由", store),
        })
    }
}

fn configured_listen_port(store: &PreviewStore) -> u16 {
    store
        .read_settings()
        .ok()
        .and_then(|settings| settings.get("routeSettings").cloned())
        .and_then(|value| value.get("listenPort").and_then(Value::as_u64))
        .filter(|port| (1024..=65_535).contains(port))
        .map(|port| port as u16)
        .unwrap_or(0)
}

fn serve<B: SecretBackend + 'static>(
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    token: String,
    store: PreviewStore,
    backend: B,
) {
    if listener.set_nonblocking(true).is_err() {
        return;
    }
    let token = Arc::new(token);
    let store = Arc::new(store);
    let backend = Arc::new(backend);
    let circuits = Arc::new(CircuitRegistry::default());
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let mut pending = Vec::new();
                for worker in workers.drain(..) {
                    if worker.is_finished() {
                        let _ = worker.join();
                    } else {
                        pending.push(worker);
                    }
                }
                workers = pending;
                if workers.len() >= MAX_ACTIVE_CONNECTIONS {
                    let mut stream = stream;
                    let _ =
                        write_response(&mut stream, 503, &json!({ "error": "Gateway is busy" }));
                    continue;
                }
                let token = Arc::clone(&token);
                let store = Arc::clone(&store);
                let backend = Arc::clone(&backend);
                let circuits = Arc::clone(&circuits);
                match thread::Builder::new()
                    .name("cksw-gateway-request".into())
                    .spawn(move || {
                        let _ = handle_connection_with_circuits(
                            stream, &token, &store, &*backend, &circuits,
                        );
                    }) {
                    Ok(worker) => workers.push(worker),
                    Err(_) => break,
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(_) => break,
        }
    }
    for worker in workers {
        let _ = worker.join();
    }
}

#[cfg(test)]
fn handle_connection(
    stream: TcpStream,
    token: &str,
    store: &PreviewStore,
    backend: &impl SecretBackend,
) -> std::io::Result<()> {
    let circuits = CircuitRegistry::default();
    handle_connection_with_circuits(stream, token, store, backend, &circuits)
}

fn handle_connection_with_circuits(
    mut stream: TcpStream,
    token: &str,
    store: &PreviewStore,
    backend: &impl SecretBackend,
    circuits: &CircuitRegistry,
) -> std::io::Result<()> {
    // Accepted sockets can inherit O_NONBLOCK on macOS/BSD.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let request = match read_http_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let status = if error.to_string().contains("too large") {
                413
            } else {
                400
            };
            return write_response(
                &mut stream,
                status,
                &json!({ "error": "Invalid HTTP request" }),
            );
        }
    };
    let path = request.path.as_str();
    let is_public_health = matches!(path, "/__health" | "/v1/__health");
    let authorized = request.authorization.as_deref() == Some(token);
    let response = match path {
        "/__health" | "/v1/__health" => (200, json!({ "status": "ok", "preview": true })),
        "/__status" | "/v1/__status" => (200, json!({ "gateway": "running", "current": null })),
        _ if !is_public_health && !authorized => (
            401,
            json!({ "error": "Unauthorized local gateway request" }),
        ),
        _ if request.method != "POST" => (405, json!({ "error": "Only POST is supported." })),
        "/v1/responses" | "/responses" => {
            let request_id = uuid::Uuid::new_v4().to_string();
            let requested_model = requested_model(&request.body);
            let config = gateway_route_config(store);
            let candidates = gateway_provider_candidates(
                store,
                backend,
                &requested_model,
                config.failover_enabled,
            );
            let candidates = match candidates {
                Ok(values) if !values.is_empty() => values,
                Ok(_) | Err(_) => {
                    let started = Instant::now();
                    record_gateway_usage_without_provider(
                        store,
                        &request_id,
                        requested_model,
                        503,
                        started.elapsed(),
                        Some("credential_error"),
                    );
                    return write_response(
                        &mut stream,
                        503,
                        &json!({ "error": "Provider credentials are unavailable" }),
                    );
                }
            };
            circuits.clear_if_disabled(config.failover_enabled);
            let deadline = Instant::now() + config.total_timeout;
            let limit = if config.failover_enabled {
                config.max_attempts.min(candidates.len())
            } else {
                1
            };
            let wants_stream = request_body_wants_stream(&request.body);
            let mut last_response = None;
            let mut attempt_count = 0;
            for (candidate_index, candidate) in candidates.iter().cloned().enumerate() {
                if attempt_count >= limit {
                    break;
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                let Some(permit) = circuits.acquire(&candidate.provider.id, &config) else {
                    continue;
                };
                attempt_count += 1;
                let attempt = attempt_count;
                let started = Instant::now();
                if candidate.invalid_requested_model {
                    let response = ForwardResult {
                        status: 400,
                        body: json!({
                            "error": "Requested model is not available in the selected provider catalog.",
                            "model": requested_model,
                        }),
                        usage: None,
                        error_category: Some("invalid_model".into()),
                        upstream_model: candidate.provider.model.clone(),
                        retryable: false,
                    };
                    circuits.complete(&candidate.provider.id, permit, false, &config);
                    record_gateway_usage(
                        store,
                        &candidate.provider,
                        &request_id,
                        response.upstream_model.clone(),
                        response.status,
                        started.elapsed(),
                        None,
                        response.error_category.as_deref(),
                        attempt,
                        candidate.failover,
                        true,
                    );
                    last_response = Some(response);
                    break;
                }
                let body = request_body_for_candidate(&request.body, &candidate);
                if let Some(category) = candidate.credential_error {
                    let response = ForwardResult {
                        status: 503,
                        body: json!({ "error": "Provider API Key is unavailable", "provider": candidate.provider.name }),
                        usage: None,
                        error_category: Some(category.into()),
                        upstream_model: candidate.provider.model.clone(),
                        retryable: true,
                    };
                    let will_retry = attempt < limit
                        && Instant::now() < deadline
                        && has_available_next_candidate(
                            &candidates,
                            candidate_index,
                            circuits,
                            &config,
                        );
                    circuits.complete(&candidate.provider.id, permit, true, &config);
                    record_gateway_usage(
                        store,
                        &candidate.provider,
                        &request_id,
                        response.upstream_model.clone(),
                        response.status,
                        started.elapsed(),
                        None,
                        response.error_category.as_deref(),
                        attempt,
                        candidate.failover,
                        !will_retry,
                    );
                    last_response = Some(response);
                    if will_retry {
                        continue;
                    }
                    break;
                }
                if wants_stream {
                    let client = stream.try_clone()?;
                    let monitor = stream.try_clone()?;
                    match forward_responses_stream_with_cancellation_timeout(
                        Some(&candidate.provider),
                        &body,
                        client,
                        monitor,
                        remaining.min(UPSTREAM_TIMEOUT),
                    ) {
                        Ok(outcome) => {
                            let will_retry = outcome.retryable
                                && !outcome.streamed
                                && attempt < limit
                                && Instant::now() < deadline;
                            let failed_for_circuit = outcome.retryable
                                || outcome.error_category.as_deref() == Some("stream");
                            circuits.complete(
                                &candidate.provider.id,
                                permit,
                                failed_for_circuit,
                                &config,
                            );
                            let will_retry = will_retry
                                && has_available_next_candidate(
                                    &candidates,
                                    candidate_index,
                                    circuits,
                                    &config,
                                );
                            record_gateway_usage(
                                store,
                                &candidate.provider,
                                &request_id,
                                outcome.upstream_model.clone(),
                                outcome.status,
                                started.elapsed(),
                                outcome.usage.clone(),
                                outcome.error_category.as_deref(),
                                attempt,
                                candidate.failover,
                                !will_retry,
                            );
                            if outcome.streamed {
                                return Ok(());
                            }
                            last_response = Some(ForwardResult {
                                status: outcome.status,
                                body: outcome.body,
                                usage: outcome.usage,
                                error_category: outcome.error_category,
                                upstream_model: outcome.upstream_model,
                                retryable: outcome.retryable,
                            });
                            if will_retry {
                                continue;
                            }
                            break;
                        }
                        Err(ForwardFailure::ClientDisconnected) => {
                            circuits.release(&candidate.provider.id, permit);
                            record_gateway_usage(
                                store,
                                &candidate.provider,
                                &request_id,
                                candidate.provider.model.clone(),
                                499,
                                started.elapsed(),
                                None,
                                Some("client_disconnected"),
                                attempt,
                                candidate.failover,
                                true,
                            );
                            return Ok(());
                        }
                    }
                } else {
                    let monitor = stream.try_clone()?;
                    match forward_responses_with_cancellation_timeout(
                        Some(&candidate.provider),
                        &body,
                        monitor,
                        remaining.min(UPSTREAM_TIMEOUT),
                    ) {
                        Ok(response) => {
                            let will_retry = response_retryable(&response)
                                && attempt < limit
                                && Instant::now() < deadline;
                            circuits.complete(
                                &candidate.provider.id,
                                permit,
                                response.retryable,
                                &config,
                            );
                            let will_retry = will_retry
                                && has_available_next_candidate(
                                    &candidates,
                                    candidate_index,
                                    circuits,
                                    &config,
                                );
                            record_gateway_usage(
                                store,
                                &candidate.provider,
                                &request_id,
                                response.upstream_model.clone(),
                                response.status,
                                started.elapsed(),
                                response.usage.clone(),
                                response.error_category.as_deref(),
                                attempt,
                                candidate.failover,
                                !will_retry,
                            );
                            last_response = Some(response);
                            if will_retry {
                                continue;
                            }
                            break;
                        }
                        Err(ForwardFailure::ClientDisconnected) => {
                            circuits.release(&candidate.provider.id, permit);
                            record_gateway_usage(
                                store,
                                &candidate.provider,
                                &request_id,
                                candidate.provider.model.clone(),
                                499,
                                started.elapsed(),
                                None,
                                Some("client_disconnected"),
                                attempt,
                                candidate.failover,
                                true,
                            );
                            return Ok(());
                        }
                    }
                }
            }
            let response = last_response.unwrap_or_else(|| ForwardResult {
                status: 503,
                body: json!({ "error": "No available failover provider" }),
                usage: None,
                error_category: Some("credential_error".into()),
                upstream_model: requested_model,
                retryable: false,
            });
            (response.status as u16, response.body)
        }
        _ => (
            501,
            json!({ "error": "This Tauri gateway protocol is not migrated yet." }),
        ),
    };
    write_response(&mut stream, response.0, &response.1)
}

fn request_body_wants_stream(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| value.get("stream").cloned())
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn requested_model(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn request_body_for_candidate(
    body: &[u8],
    candidate: &crate::providers::GatewayCandidate,
) -> Vec<u8> {
    let Ok(mut payload) = serde_json::from_slice::<Value>(body) else {
        return body.to_vec();
    };
    if let Some(object) = payload.as_object_mut() {
        object.insert("model".into(), json!(candidate.provider.model.clone()));
        return payload.to_string().into_bytes();
    }
    body.to_vec()
}

fn response_retryable(response: &ForwardResult) -> bool {
    response.retryable
}

fn has_available_next_candidate(
    candidates: &[crate::providers::GatewayCandidate],
    current_index: usize,
    circuits: &CircuitRegistry,
    config: &GatewayRouteConfig,
) -> bool {
    candidates
        .iter()
        .skip(current_index + 1)
        .any(|candidate| circuits.available(&candidate.provider.id, config))
}

fn parse_usage_from_json(value: &Value) -> Option<SseUsage> {
    let usage = value.get("usage").or_else(|| {
        value
            .get("response")
            .and_then(|response| response.get("usage"))
    })?;
    Some(SseUsage {
        input_tokens: usage
            .get("input_tokens")
            .or_else(|| usage.get("prompt_tokens"))?
            .as_u64()?,
        output_tokens: usage
            .get("output_tokens")
            .or_else(|| usage.get("completion_tokens"))?
            .as_u64()?,
        cached_tokens: usage
            .get("input_tokens_details")
            .and_then(|details| details.get("cached_tokens"))
            .and_then(Value::as_u64)
            .or_else(|| usage.get("cached_tokens").and_then(Value::as_u64))
            .unwrap_or(0),
    })
}

#[derive(Debug)]
struct ProtocolConversionError {
    status: u16,
    message: &'static str,
    category: &'static str,
}

fn upstream_endpoint(base_url: &str, api_format: &str) -> Result<url::Url, ()> {
    let mut base = url::Url::parse(base_url).map_err(|_| ())?;
    if !matches!(base.scheme(), "http" | "https")
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(());
    }
    let endpoint = match api_format {
        "chat_completions" => "/chat/completions",
        "anthropic_messages" => "/messages",
        _ => "/responses",
    };
    let path = base.path().trim_end_matches('/');
    let prefix = if path.is_empty() { "/v1" } else { path };
    base.set_path(&format!("{prefix}{endpoint}"));
    Ok(base)
}

fn prepare_protocol_request(
    provider: &GatewayProvider,
    body: &[u8],
    stream: bool,
) -> Result<Vec<u8>, ProtocolConversionError> {
    let mut payload: Value = serde_json::from_slice(body).map_err(|_| ProtocolConversionError {
        status: 400,
        message: "Request body must be a JSON object",
        category: "invalid_request",
    })?;
    if !payload.is_object() {
        return Err(ProtocolConversionError {
            status: 400,
            message: "Request body must be a JSON object",
            category: "invalid_request",
        });
    }
    let requested = payload.get("model").and_then(Value::as_str);
    if requested.is_some_and(|model| model != provider.model) {
        return Err(ProtocolConversionError {
            status: 400,
            message: "Requested model is not the selected upstream model.",
            category: "invalid_model",
        });
    }
    let object = payload.as_object_mut().expect("object checked");
    object.insert("model".into(), json!(provider.model));
    if provider.api_format != "responses"
        && (object.contains_key("previous_response_id") || object.contains_key("conversation"))
    {
        return Err(ProtocolConversionError {
            status: 400,
            message: "This model requires full conversation history in input; upstream response/conversation IDs cannot be converted across protocols.",
            category: "invalid_request",
        });
    }
    if provider.api_format == "responses" {
        object.insert("stream".into(), json!(stream));
        normalize_responses_payload(&mut payload, provider);
        return serde_json::to_vec(&payload).map_err(|_| ProtocolConversionError {
            status: 400,
            message: "Request body could not be encoded",
            category: "invalid_request",
        });
    }
    if payload.get("input").is_some_and(contains_media_input) {
        return Err(ProtocolConversionError {
            status: 400,
            message: "This protocol adapter cannot accept image/file history. Use a compatible model or remove the attachment explicitly.",
            category: "invalid_request",
        });
    }
    let converted = if provider.api_format == "chat_completions" {
        chat_request_from_responses(&payload, stream)?
    } else {
        anthropic_request_from_responses(&payload, stream)?
    };
    serde_json::to_vec(&converted).map_err(|_| ProtocolConversionError {
        status: 400,
        message: "Request body could not be encoded",
        category: "invalid_request",
    })
}

fn contains_media_input(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            matches!(
                object.get("type").and_then(Value::as_str),
                Some("input_image" | "input_file")
            ) || ["image_url", "file_id", "file_data"]
                .iter()
                .any(|key| object.contains_key(*key))
                || object.values().any(contains_media_input)
        }
        Value::Array(items) => items.iter().any(contains_media_input),
        _ => false,
    }
}

fn normalize_responses_payload(payload: &mut Value, provider: &GatewayProvider) {
    remove_codex_namespace(payload);
    let is_openai = url::Url::parse(&provider.base_url)
        .ok()
        .is_some_and(|url| url.host_str() == Some("api.openai.com"));
    if is_openai {
        return;
    }
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    for key in ["max_output_tokens", "max_tokens"] {
        if object
            .get(key)
            .and_then(Value::as_f64)
            .is_some_and(|value| value < 16.0)
        {
            object.insert(key.into(), json!(16));
        }
    }
    let Some(tools) = object.get("tools").and_then(Value::as_array) else {
        return;
    };
    let functions = tools
        .iter()
        .filter(|tool| is_responses_function_tool(tool))
        .cloned()
        .collect::<Vec<_>>();
    if functions.is_empty() {
        object.remove("tools");
        object.remove("tool_choice");
    } else {
        object.insert("tools".into(), json!(functions));
        if object
            .get("tool_choice")
            .is_some_and(|choice| choice.is_object() && !is_responses_function_tool(choice))
        {
            object.remove("tool_choice");
        }
    }
}

fn is_responses_function_tool(tool: &Value) -> bool {
    tool.get("function").is_some_and(Value::is_object)
        || (tool.get("type").and_then(Value::as_str) == Some("function")
            && tool
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.is_empty()))
}

fn remove_codex_namespace(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("namespace");
            for child in object.values_mut() {
                remove_codex_namespace(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                remove_codex_namespace(item);
            }
        }
        _ => {}
    }
}

fn chat_request_from_responses(
    payload: &Value,
    stream: bool,
) -> Result<Value, ProtocolConversionError> {
    let object = payload.as_object().ok_or(ProtocolConversionError {
        status: 400,
        message: "Request body must be a JSON object",
        category: "invalid_request",
    })?;
    let mut messages = Vec::new();
    if let Some(instructions) = object.get("instructions").and_then(Value::as_str) {
        messages.push(json!({"role":"system","content":instructions}));
    }
    let input = object.get("input").ok_or(ProtocolConversionError {
        status: 400,
        message: "Full conversation input is required for Chat Completions.",
        category: "invalid_request",
    })?;
    if let Some(text) = input.as_str() {
        messages.push(json!({"role":"user","content":text}));
    } else if let Some(items) = input.as_array() {
        append_chat_messages(&mut messages, items)?;
    } else {
        return Err(ProtocolConversionError {
            status: 400,
            message: "Full conversation input is required for Chat Completions.",
            category: "invalid_request",
        });
    }
    if messages.is_empty() {
        return Err(ProtocolConversionError {
            status: 400,
            message: "Conversation contains no supported messages.",
            category: "invalid_request",
        });
    }
    let mut converted = json!({
        "model": object.get("model").cloned().unwrap_or(Value::Null),
        "messages": messages,
        "stream": stream,
    });
    if let Some(max) = object
        .get("max_output_tokens")
        .or_else(|| object.get("max_tokens"))
    {
        converted["max_tokens"] = max.clone();
    }
    for key in ["temperature", "top_p"] {
        if let Some(value) = object.get(key) {
            converted[key] = value.clone();
        }
    }
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        let tools = tools
            .iter()
            .filter_map(|tool| {
                let function = tool.get("function").unwrap_or(tool);
                let name = function.get("name")?.as_str()?;
                Some(json!({
                    "type":"function",
                    "function": {
                        "name": name,
                        "description": function.get("description").and_then(Value::as_str).unwrap_or(""),
                        "parameters": function.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object","properties":{}})),
                    }
                }))
            })
            .collect::<Vec<_>>();
        if !tools.is_empty() {
            converted["tools"] = json!(tools);
        }
    }
    if let Some(choice) = object.get("tool_choice") {
        converted["tool_choice"] = choice.clone();
    }
    Ok(converted)
}

fn append_chat_messages(
    messages: &mut Vec<Value>,
    items: &[Value],
) -> Result<(), ProtocolConversionError> {
    let mut outputs = std::collections::HashMap::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some("function_call_output") {
            if let Some(id) = item
                .get("call_id")
                .or_else(|| item.get("tool_call_id"))
                .and_then(Value::as_str)
            {
                outputs.insert(id.to_string(), item);
            }
        }
    }
    for item in items {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type == "function_call_output" {
            continue;
        }
        if item_type == "function_call" {
            let call_id = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("call_unknown");
            let name = item.get("name").and_then(Value::as_str).ok_or(ProtocolConversionError {
                status: 400,
                message: "Tool history is incomplete: each function call requires its name and matching output.",
                category: "invalid_request",
            })?;
            let output = outputs.get(call_id).ok_or(ProtocolConversionError {
                status: 400,
                message: "Tool history is incomplete: each function call requires its name and matching output.",
                category: "invalid_request",
            })?;
            messages.push(json!({
                "role":"assistant", "content":"",
                "tool_calls":[{"id":call_id,"type":"function","function":{"name":name,"arguments":item.get("arguments").and_then(Value::as_str).unwrap_or("")}}]
            }));
            messages.push(json!({
                "role":"tool", "tool_call_id":call_id,
                "content": text_value(output.get("output").or_else(|| output.get("content"))),
            }));
            continue;
        }
        let role = match item.get("role").and_then(Value::as_str).unwrap_or("user") {
            "system" | "developer" => "system",
            "assistant" => "assistant",
            "tool" => "tool",
            _ => "user",
        };
        let text = text_value(item.get("content").or_else(|| item.get("text")));
        if !text.is_empty() {
            messages.push(json!({"role":role,"content":text}));
        }
    }
    Ok(())
}

fn anthropic_request_from_responses(
    payload: &Value,
    stream: bool,
) -> Result<Value, ProtocolConversionError> {
    let object = payload.as_object().ok_or(ProtocolConversionError {
        status: 400,
        message: "Request body must be a JSON object",
        category: "invalid_request",
    })?;
    let input = object.get("input").ok_or(ProtocolConversionError {
        status: 400,
        message: "Full conversation input is required for Anthropic Messages.",
        category: "invalid_request",
    })?;
    let mut system = Vec::new();
    if let Some(instructions) = object.get("instructions").and_then(Value::as_str) {
        system.push(instructions.to_string());
    }
    let messages = if let Some(text) = input.as_str() {
        vec![json!({"role":"user","content":text})]
    } else if let Some(items) = input.as_array() {
        append_anthropic_messages(items, &mut system)?
    } else {
        return Err(ProtocolConversionError {
            status: 400,
            message: "Full conversation input is required for Anthropic Messages.",
            category: "invalid_request",
        });
    };
    let mut converted = json!({
        "model": object.get("model").cloned().unwrap_or(Value::Null),
        "messages": messages,
        "max_tokens": object.get("max_output_tokens").or_else(|| object.get("max_tokens")).cloned().unwrap_or(json!(4096)),
    });
    if !system.is_empty() {
        converted["system"] = json!(system.join("\n\n"));
    }
    if stream {
        converted["stream"] = json!(true);
    }
    for key in ["temperature", "top_p"] {
        if let Some(value) = object.get(key) {
            converted[key] = value.clone();
        }
    }
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        converted["tools"] = json!(tools.iter().filter_map(|tool| {
            let function = tool.get("function").unwrap_or(tool);
            Some(json!({
                "name": function.get("name")?.as_str()?,
                "description": function.get("description").and_then(Value::as_str).unwrap_or(""),
                "input_schema": function.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object","properties":{}})),
            }))
        }).collect::<Vec<_>>());
    }
    Ok(converted)
}

fn append_anthropic_messages(
    items: &[Value],
    system: &mut Vec<String>,
) -> Result<Vec<Value>, ProtocolConversionError> {
    let mut messages = Vec::new();
    let mut pending_tool_uses = Vec::new();
    let mut pending_tool_results = Vec::new();

    let flush_tools =
        |messages: &mut Vec<Value>, tool_uses: &mut Vec<Value>, tool_results: &mut Vec<Value>| {
            if !tool_uses.is_empty() {
                messages.push(json!({"role":"assistant","content":tool_uses.clone()}));
                tool_uses.clear();
            }
            if !tool_results.is_empty() {
                messages.push(json!({"role":"user","content":tool_results.clone()}));
                tool_results.clear();
            }
        };
    let push_message = |messages: &mut Vec<Value>, role: &str, content: Value| {
        if let Some(previous) = messages.last_mut() {
            if previous["role"] == role {
                let next = content.as_array().cloned().unwrap_or_else(|| {
                    vec![json!({"type":"text","text":text_value(Some(&content))})]
                });
                if !previous["content"].is_array() {
                    let previous_text = previous["content"].take();
                    previous["content"] =
                        json!([{"type":"text","text":text_value(Some(&previous_text))}]);
                }
                previous["content"].as_array_mut().unwrap().extend(next);
                return;
            }
        }
        let content = if content.is_array() {
            content
        } else {
            json!([{"type":"text","text":text_value(Some(&content))}])
        };
        messages.push(json!({"role": role, "content": content}));
    };

    for item in items {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
        let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
        if role == "system" || role == "developer" {
            let text = text_value(item.get("content").or_else(|| item.get("text")));
            if !text.is_empty() {
                system.push(text);
            }
            continue;
        }
        if item_type == "function_call" {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .ok_or(ProtocolConversionError {
                    status: 400,
                    message: "Tool history is incomplete.",
                    category: "invalid_request",
                })?;
            pending_tool_uses.push(json!({"type":"tool_use","id":item.get("call_id").or_else(|| item.get("id")).cloned().unwrap_or_else(|| json!("call_unknown")),"name":name,"input":serde_json::from_str::<Value>(item.get("arguments").and_then(Value::as_str).unwrap_or("{}")).unwrap_or_else(|_| json!({}))}));
        } else if item_type == "function_call_output" || role == "tool" {
            pending_tool_results.push(json!({"type":"tool_result","tool_use_id":item.get("call_id").or_else(|| item.get("tool_call_id")).or_else(|| item.get("id")).cloned().unwrap_or_else(|| json!("call_unknown")),"content":text_value(item.get("output").or_else(|| item.get("content")))}));
        } else {
            flush_tools(
                &mut messages,
                &mut pending_tool_uses,
                &mut pending_tool_results,
            );
            let text = text_value(item.get("content").or_else(|| item.get("text")));
            if !text.is_empty() {
                let role = if role == "assistant" {
                    "assistant"
                } else {
                    "user"
                };
                push_message(&mut messages, role, json!(text));
            }
        }
    }
    flush_tools(
        &mut messages,
        &mut pending_tool_uses,
        &mut pending_tool_results,
    );
    if messages.is_empty() {
        return Err(ProtocolConversionError {
            status: 400,
            message: "Conversation contains no supported messages.",
            category: "invalid_request",
        });
    }
    Ok(messages)
}

fn text_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(values)) => values.iter().map(|value| text_value(Some(value))).collect(),
        Some(Value::Object(object)) => text_value(
            object
                .get("text")
                .or_else(|| object.get("content"))
                .or_else(|| object.get("input_text"))
                .or_else(|| object.get("output_text")),
        ),
        _ => String::new(),
    }
}

fn response_from_chat(value: &Value, model: &str) -> Value {
    let message = value["choices"][0]
        .get("message")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut output = Vec::new();
    let text = text_value(message.get("content").or_else(|| message.get("text")));
    if !text.is_empty() {
        output.push(json!({"id":format!("msg_{}",uuid::Uuid::new_v4()),"type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":text,"annotations":[]}]}));
    }
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let function = call.get("function").unwrap_or(call);
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                output.push(json!({"id":format!("fc_{}",uuid::Uuid::new_v4()),"type":"function_call","status":"completed","call_id":call.get("id").and_then(Value::as_str).unwrap_or("call_unknown"),"name":name,"arguments":function.get("arguments").and_then(Value::as_str).unwrap_or("{}")}));
            }
        }
    }
    json!({"id":value.get("id").and_then(Value::as_str).unwrap_or("resp_tauri"),"object":"response","status":"completed","model":model,"output":output,"usage":value.get("usage").cloned().unwrap_or(Value::Null)})
}

fn response_from_anthropic(value: &Value, model: &str) -> Value {
    let mut output = Vec::new();
    for part in value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    output.push(json!({"id":format!("msg_{}",uuid::Uuid::new_v4()),"type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":text,"annotations":[]}]}));
                }
            }
            Some("tool_use") => {
                if let Some(name) = part.get("name").and_then(Value::as_str) {
                    output.push(json!({"id":format!("fc_{}",uuid::Uuid::new_v4()),"type":"function_call","status":"completed","call_id":part.get("id").and_then(Value::as_str).unwrap_or("call_unknown"),"name":name,"arguments":part.get("input").map(Value::to_string).unwrap_or_else(|| "{}".into())}));
                }
            }
            _ => {}
        }
    }
    json!({"id":value.get("id").and_then(Value::as_str).unwrap_or("resp_tauri"),"object":"response","status":"completed","model":model,"output":output,"usage":value.get("usage").cloned().unwrap_or(Value::Null)})
}

fn record_gateway_usage(
    store: &PreviewStore,
    provider: &GatewayProvider,
    request_id: &str,
    model: String,
    status: i64,
    duration: Duration,
    usage: Option<SseUsage>,
    error_category: Option<&str>,
    attempt: usize,
    failover: bool,
    final_attempt: bool,
) {
    let settings = match store.read_settings() {
        Ok(settings) => settings,
        Err(_) => return,
    };
    let config = read_usage_config(&settings);
    if !config
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return;
    }
    let record = crate::usage::UsageRecordInput {
        id: uuid::Uuid::new_v4().to_string(),
        provider: provider.name.clone(),
        model: if model.trim().is_empty() {
            provider.model.clone()
        } else {
            model
        },
        status,
        duration_ms: duration.as_millis().min(i64::MAX as u128) as i64,
        source: provider.api_format.clone(),
        input_tokens: usage
            .as_ref()
            .map(|value| value.input_tokens.min(i64::MAX as u64) as i64),
        output_tokens: usage
            .as_ref()
            .map(|value| value.output_tokens.min(i64::MAX as u64) as i64),
        cached_tokens: usage
            .as_ref()
            .map(|value| value.cached_tokens.min(i64::MAX as u64) as i64),
        request_id: Some(request_id.to_string()),
        attempt: Some(attempt as i64),
        failover: Some(failover),
        final_attempt: Some(final_attempt),
        error_category: error_category.map(str::to_string),
        created_at: chrono::Utc::now().timestamp_millis(),
    };
    let retention = config
        .get("retentionDays")
        .and_then(Value::as_i64)
        .unwrap_or(30)
        .clamp(1, 365);
    let max_records = config
        .get("maxRecords")
        .and_then(Value::as_i64)
        .unwrap_or(10_000)
        .clamp(100, 100_000);
    if let Err(error) = crate::usage::record_usage(
        &store.usage_database_path(),
        record,
        true,
        retention,
        max_records,
    ) {
        eprintln!("Tauri preview usage record failed: {}", error.code());
    }
}

fn record_gateway_usage_without_provider(
    store: &PreviewStore,
    request_id: &str,
    model: String,
    status: i64,
    duration: Duration,
    error_category: Option<&str>,
) {
    let settings = match store.read_settings() {
        Ok(value) => value,
        Err(_) => return,
    };
    let config = read_usage_config(&settings);
    if !config
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return;
    }
    let record = crate::usage::UsageRecordInput {
        id: uuid::Uuid::new_v4().to_string(),
        provider: "Unknown provider".into(),
        model: if model.trim().is_empty() {
            "unknown".into()
        } else {
            model
        },
        status,
        duration_ms: duration.as_millis().min(i64::MAX as u128) as i64,
        source: "responses".into(),
        input_tokens: None,
        output_tokens: None,
        cached_tokens: None,
        request_id: Some(request_id.to_string()),
        attempt: Some(1),
        failover: Some(false),
        final_attempt: Some(true),
        error_category: error_category.map(str::to_string),
        created_at: chrono::Utc::now().timestamp_millis(),
    };
    let retention = config
        .get("retentionDays")
        .and_then(Value::as_i64)
        .unwrap_or(30)
        .clamp(1, 365);
    let max_records = config
        .get("maxRecords")
        .and_then(Value::as_i64)
        .unwrap_or(10_000)
        .clamp(100, 100_000);
    if let Err(error) = crate::usage::record_usage(
        &store.usage_database_path(),
        record,
        true,
        retention,
        max_records,
    ) {
        eprintln!("Tauri preview usage record failed: {}", error.code());
    }
}

fn read_usage_config(settings: &serde_json::Map<String, Value>) -> Value {
    settings
        .get("usageSettings")
        .and_then(|stored| match stored {
            Value::String(raw) => serde_json::from_str::<Value>(raw).ok(),
            Value::Object(_) => Some(stored.clone()),
            _ => None,
        })
        .unwrap_or_else(|| json!({"enabled":false,"retentionDays":30,"maxRecords":10000}))
}

#[cfg(test)]
fn forward_responses(provider: Option<&GatewayProvider>, body: &[u8]) -> (u16, Value) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("gateway runtime");
    let result = runtime.block_on(forward_responses_async(provider, body, UPSTREAM_TIMEOUT));
    (result.status as u16, result.body)
}

enum ForwardFailure {
    ClientDisconnected,
}

struct ForwardResult {
    status: i64,
    body: Value,
    usage: Option<SseUsage>,
    error_category: Option<String>,
    upstream_model: String,
    retryable: bool,
}

struct StreamOutcome {
    status: i64,
    body: Value,
    usage: Option<SseUsage>,
    error_category: Option<String>,
    upstream_model: String,
    retryable: bool,
    streamed: bool,
}

#[cfg(test)]
fn forward_responses_stream_with_cancellation(
    provider: Option<&GatewayProvider>,
    body: &[u8],
    stream: TcpStream,
    monitor: TcpStream,
) -> Result<StreamOutcome, ForwardFailure> {
    forward_responses_stream_with_cancellation_timeout(
        provider,
        body,
        stream,
        monitor,
        UPSTREAM_TIMEOUT,
    )
}

fn forward_responses_stream_with_cancellation_timeout(
    provider: Option<&GatewayProvider>,
    body: &[u8],
    stream: TcpStream,
    monitor: TcpStream,
    timeout: Duration,
) -> Result<StreamOutcome, ForwardFailure> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| ForwardFailure::ClientDisconnected)?;
    runtime.block_on(async {
        tokio::select! {
            result = forward_responses_stream(provider, body, stream, timeout) => result,
            _ = wait_for_client_disconnect(monitor) => Err(ForwardFailure::ClientDisconnected),
        }
    })
}

#[cfg(test)]
fn forward_responses_with_cancellation(
    provider: Option<&GatewayProvider>,
    body: &[u8],
    monitor: TcpStream,
) -> Result<ForwardResult, ForwardFailure> {
    forward_responses_with_cancellation_timeout(provider, body, monitor, UPSTREAM_TIMEOUT)
}

fn forward_responses_with_cancellation_timeout(
    provider: Option<&GatewayProvider>,
    body: &[u8],
    monitor: TcpStream,
    timeout: Duration,
) -> Result<ForwardResult, ForwardFailure> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| ForwardFailure::ClientDisconnected)?;
    runtime.block_on(async {
        tokio::select! {
            result = forward_responses_async(provider, body, timeout) => Ok(result),
            _ = wait_for_client_disconnect(monitor) => Err(ForwardFailure::ClientDisconnected),
        }
    })
}

async fn wait_for_client_disconnect(monitor: TcpStream) {
    let monitor = monitor;
    if monitor.set_nonblocking(true).is_err() {
        return;
    }
    let Ok(socket) = tokio::net::TcpStream::from_std(monitor) else {
        return;
    };
    loop {
        tokio::time::sleep(Duration::from_millis(25)).await;
        let mut buffer = [0_u8; 1];
        match socket.try_read(&mut buffer) {
            Ok(_) => return,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(_) => return,
        }
    }
}

async fn forward_responses_async(
    provider: Option<&GatewayProvider>,
    body: &[u8],
    timeout: Duration,
) -> ForwardResult {
    let upstream_model = provider
        .map(|provider| provider.model.clone())
        .unwrap_or_else(|| "unknown".into());
    let result = forward_responses_http(provider, body, timeout).await;
    ForwardResult {
        status: result.0 as i64,
        body: result.1,
        usage: result.2,
        error_category: result.3,
        upstream_model,
        retryable: result.4,
    }
}

async fn forward_responses_http(
    provider: Option<&GatewayProvider>,
    body: &[u8],
    timeout: Duration,
) -> (u16, Value, Option<SseUsage>, Option<String>, bool) {
    let Some(provider) = provider else {
        return (
            503,
            json!({ "error": "No active provider" }),
            None,
            Some("missing_provider".into()),
            true,
        );
    };
    if request_body_wants_stream(body) {
        return (
            501,
            json!({ "error": "Streaming protocol conversion is not available in the non-streaming path." }),
            None,
            Some("unsupported_protocol".into()),
            false,
        );
    }
    let payload = match prepare_protocol_request(provider, body, false) {
        Ok(value) => value,
        Err(error) => {
            return (
                error.status,
                json!({ "error": error.message }),
                None,
                Some(error.category.into()),
                false,
            )
        }
    };
    let endpoint = match upstream_endpoint(&provider.base_url, &provider.api_format) {
        Ok(value) => value,
        Err(_) => {
            return (
                500,
                json!({ "error": "Invalid provider base URL" }),
                None,
                Some("invalid_base_url".into()),
                true,
            )
        }
    };
    let client = match Client::builder()
        .timeout(timeout)
        .redirect(Policy::none())
        .no_proxy()
        .build()
    {
        Ok(value) => value,
        Err(_) => {
            return (
                500,
                json!({ "error": "Upstream client initialization failed" }),
                None,
                Some("network".into()),
                true,
            )
        }
    };
    let response = match client
        .post(endpoint)
        .bearer_auth(&provider.api_key)
        .header("content-type", "application/json")
        .body(payload)
        .send()
        .await
    {
        Ok(value) => value,
        Err(error) => {
            return (
                if error.is_timeout() { 504 } else { 502 },
                json!({ "error": "Upstream request failed" }),
                None,
                Some(
                    if error.is_timeout() {
                        "timeout"
                    } else {
                        "network"
                    }
                    .into(),
                ),
                true,
            )
        }
    };
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
        return (
            502,
            json!({ "error": "Upstream redirects are not allowed" }),
            None,
            Some("upstream_redirect".into()),
            false,
        );
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_UPSTREAM_RESPONSE_BYTES as u64)
    {
        return (
            502,
            json!({ "error": "Upstream response is too large" }),
            None,
            Some("response_too_large".into()),
            false,
        );
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(value) => value,
            Err(_) => {
                return (
                    502,
                    json!({ "error": "Upstream response could not be read" }),
                    None,
                    Some("network".into()),
                    true,
                )
            }
        };
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_UPSTREAM_RESPONSE_BYTES {
            return (
                502,
                json!({ "error": "Upstream response is too large" }),
                None,
                Some("response_too_large".into()),
                false,
            );
        }
    }
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => {
            let usage = parse_usage_from_json(&value);
            let value = match provider.api_format.as_str() {
                "chat_completions" => response_from_chat(&value, &provider.model),
                "anthropic_messages" => response_from_anthropic(&value, &provider.model),
                _ => value,
            };
            (
                status,
                value,
                usage,
                (status >= 500).then(|| "upstream_5xx".into()),
                status >= 500,
            )
        }
        Err(_) => (
            502,
            json!({ "error": "Upstream returned a non-JSON response" }),
            None,
            Some("invalid_response".into()),
            true,
        ),
    }
}

async fn forward_responses_stream(
    provider: Option<&GatewayProvider>,
    body: &[u8],
    stream: TcpStream,
    timeout: Duration,
) -> Result<StreamOutcome, ForwardFailure> {
    let Some(provider) = provider else {
        return Ok(StreamOutcome {
            status: 503,
            body: json!({ "error": "No active provider" }),
            usage: None,
            error_category: Some("missing_provider".into()),
            upstream_model: "unknown".into(),
            retryable: true,
            streamed: false,
        });
    };
    if !request_body_wants_stream(body) {
        return Ok(StreamOutcome {
            status: 400,
            body: json!({ "error": "Streaming request must set stream=true" }),
            usage: None,
            error_category: Some("invalid_request".into()),
            upstream_model: provider.model.clone(),
            retryable: false,
            streamed: false,
        });
    }
    let payload = match prepare_protocol_request(provider, body, true) {
        Ok(payload) => payload,
        Err(error) => {
            return Ok(StreamOutcome {
                status: error.status as i64,
                body: json!({ "error": error.message }),
                usage: None,
                error_category: Some(error.category.into()),
                upstream_model: provider.model.clone(),
                retryable: false,
                streamed: false,
            });
        }
    };
    let endpoint = match upstream_endpoint(&provider.base_url, &provider.api_format) {
        Ok(endpoint) => endpoint,
        Err(_) => {
            return Ok(StreamOutcome {
                status: 500,
                body: json!({ "error": "Invalid provider base URL" }),
                usage: None,
                error_category: Some("invalid_base_url".into()),
                upstream_model: provider.model.clone(),
                retryable: true,
                streamed: false,
            })
        }
    };
    let client = Client::builder()
        .timeout(timeout)
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| ForwardFailure::ClientDisconnected)?;
    let response = client
        .post(endpoint)
        .bearer_auth(&provider.api_key)
        .header("content-type", "application/json")
        .body(payload)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return Ok(StreamOutcome {
                status: if error.is_timeout() { 504 } else { 502 },
                body: json!({ "error": "Upstream request failed" }),
                usage: None,
                error_category: Some(
                    if error.is_timeout() {
                        "timeout"
                    } else {
                        "network"
                    }
                    .into(),
                ),
                upstream_model: provider.model.clone(),
                retryable: true,
                streamed: false,
            })
        }
    };
    let mut stream =
        tokio::net::TcpStream::from_std(stream).map_err(|_| ForwardFailure::ClientDisconnected)?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let data = response.bytes().await.unwrap_or_default();
        let payload = serde_json::from_slice::<Value>(&data)
            .unwrap_or_else(|_| json!({ "error": "Upstream returned a non-JSON response" }));
        return Ok(StreamOutcome {
            status: status as i64,
            body: payload,
            usage: None,
            error_category: (status >= 500).then(|| "upstream_5xx".into()),
            upstream_model: provider.model.clone(),
            retryable: status >= 500,
            streamed: false,
        });
    }
    let headers = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: http://127.0.0.1\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\r\n";
    stream
        .write_all(headers)
        .await
        .map_err(|_| ForwardFailure::ClientDisconnected)?;
    let mut upstream = response.bytes_stream();
    let mut tracker = ProtocolSseTracker::new(&provider.api_format, &provider.model);
    let mut total = 0usize;
    while let Some(chunk) = upstream.next().await {
        let chunk = chunk.map_err(|_| ForwardFailure::ClientDisconnected)?;
        total = total.saturating_add(chunk.len());
        if total > MAX_UPSTREAM_RESPONSE_BYTES {
            return Err(ForwardFailure::ClientDisconnected);
        }
        for output in tracker.process_chunk(&chunk) {
            stream
                .write_all(&output)
                .await
                .map_err(|_| ForwardFailure::ClientDisconnected)?;
            stream
                .flush()
                .await
                .map_err(|_| ForwardFailure::ClientDisconnected)?;
        }
    }
    for output in tracker.finish() {
        stream
            .write_all(&output)
            .await
            .map_err(|_| ForwardFailure::ClientDisconnected)?;
        stream
            .flush()
            .await
            .map_err(|_| ForwardFailure::ClientDisconnected)?;
    }
    Ok(StreamOutcome {
        status: if tracker.failed() { 502 } else { 200 },
        body: json!({}),
        usage: tracker.usage(),
        error_category: tracker.failed().then(|| "stream".into()),
        upstream_model: tracker
            .response_model()
            .unwrap_or_else(|| provider.model.clone()),
        retryable: false,
        streamed: true,
    })
}

#[derive(Clone, Debug, PartialEq)]
struct SseUsage {
    input_tokens: u64,
    output_tokens: u64,
    cached_tokens: u64,
}

enum ProtocolSseTracker {
    Native(NativeSseAdapter),
    Converted(ConvertedSseAdapter),
}

impl ProtocolSseTracker {
    fn new(format: &str, model: &str) -> Self {
        if format == "responses" {
            Self::Native(NativeSseAdapter::new(model))
        } else {
            Self::Converted(ConvertedSseAdapter::new(format, model))
        }
    }

    fn process_chunk(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        match self {
            Self::Native(adapter) => adapter.process_chunk(bytes),
            Self::Converted(adapter) => adapter.process_chunk(bytes),
        }
    }

    fn finish(&mut self) -> Vec<Vec<u8>> {
        match self {
            Self::Native(adapter) => adapter.finish(),
            Self::Converted(adapter) => adapter.finish(),
        }
    }

    fn failed(&self) -> bool {
        match self {
            Self::Native(adapter) => adapter.failed,
            Self::Converted(adapter) => adapter.failed,
        }
    }

    fn usage(&self) -> Option<SseUsage> {
        match self {
            Self::Native(adapter) => adapter.usage(),
            Self::Converted(adapter) => adapter.usage.clone(),
        }
    }

    fn response_model(&self) -> Option<String> {
        match self {
            Self::Native(adapter) => adapter.response_model(),
            Self::Converted(adapter) => Some(adapter.model.clone()),
        }
    }
}

struct ConvertedToolState {
    item_id: String,
    output_index: u64,
    call_id: String,
    name: String,
    arguments: String,
}

struct ConvertedSseAdapter {
    format: String,
    model: String,
    buffer: String,
    response_started: bool,
    text_started: bool,
    text_item_id: String,
    text_output_index: u64,
    text: String,
    next_output_index: u64,
    tools: BTreeMap<u64, ConvertedToolState>,
    terminal: bool,
    failed: bool,
    usage: Option<SseUsage>,
}

impl ConvertedSseAdapter {
    fn new(format: &str, model: &str) -> Self {
        Self {
            format: format.into(),
            model: model.into(),
            buffer: String::new(),
            response_started: false,
            text_started: false,
            text_item_id: format!("msg_{}", uuid::Uuid::new_v4()),
            text_output_index: 0,
            text: String::new(),
            next_output_index: 0,
            tools: BTreeMap::new(),
            terminal: false,
            failed: false,
            usage: None,
        }
    }

    fn process_chunk(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        let mut output = Vec::new();
        while let Some(index) = self.buffer.find("\n\n") {
            let block = self.buffer[..index].to_string();
            self.buffer.drain(..index + 2);
            output.extend(self.process_block(&block));
        }
        output
    }

    fn process_block(&mut self, block: &str) -> Vec<Vec<u8>> {
        let data = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            if data == "[DONE]" {
                self.terminal = true;
            }
            return Vec::new();
        }
        let Ok(payload) = serde_json::from_str::<Value>(&data) else {
            return Vec::new();
        };
        if payload.get("usage").is_some() {
            self.usage = parse_usage_from_json(&payload);
        }
        if payload.get("error").is_some()
            || payload.get("type").and_then(Value::as_str) == Some("error")
        {
            return self.fail("Upstream returned a streaming error");
        }
        if self.format == "chat_completions" {
            self.process_chat(&payload)
        } else {
            self.process_anthropic(&payload)
        }
    }

    fn process_chat(&mut self, payload: &Value) -> Vec<Vec<u8>> {
        let choice = payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|items| items.first());
        let Some(choice) = choice else {
            return Vec::new();
        };
        let delta = choice.get("delta").unwrap_or(&Value::Null);
        let mut output = Vec::new();
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            output.extend(self.text_delta(text));
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                output.extend(self.tool_delta(call));
            }
        }
        if choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .is_some_and(|reason| reason == "length" || reason == "content_filter")
        {
            return self.fail("Upstream stopped before a complete response");
        }
        if choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .is_some_and(|reason| reason == "stop" || reason == "tool_calls")
        {
            self.terminal = true;
        }
        output
    }

    fn process_anthropic(&mut self, payload: &Value) -> Vec<Vec<u8>> {
        let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "content_block_start" => {
                let block = payload.get("content_block").unwrap_or(&Value::Null);
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    self.text_delta(block.get("text").and_then(Value::as_str).unwrap_or(""))
                } else if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0);
                    let state = self.tool_state(
                        index,
                        block.get("id").and_then(Value::as_str),
                        block.get("name").and_then(Value::as_str),
                    );
                    let item_id = state.item_id.clone();
                    let output_index = state.output_index;
                    let call_id = state.call_id.clone();
                    let name = state.name.clone();
                    self.tool_start_values(&item_id, output_index, &call_id, &name)
                } else {
                    Vec::new()
                }
            }
            "content_block_delta" => {
                let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0);
                let delta = payload.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        self.text_delta(delta.get("text").and_then(Value::as_str).unwrap_or(""))
                    }
                    Some("input_json_delta") => self.tool_argument_delta(
                        index,
                        delta
                            .get("partial_json")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    ),
                    _ => Vec::new(),
                }
            }
            "message_delta" => {
                if payload
                    .get("delta")
                    .and_then(|delta| delta.get("stop_reason"))
                    .and_then(Value::as_str)
                    == Some("max_tokens")
                {
                    self.fail("Upstream stopped at the output token limit")
                } else {
                    Vec::new()
                }
            }
            "message_stop" => {
                self.terminal = true;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn emit_start(&mut self) -> Vec<Vec<u8>> {
        if self.response_started {
            return Vec::new();
        }
        self.response_started = true;
        let response = response_base(&None, &self.model, "in_progress");
        vec![
            sse_event_bytes(
                "response.created",
                json!({"type":"response.created","response":response.clone()}),
            ),
            sse_event_bytes(
                "response.in_progress",
                json!({"type":"response.in_progress","response":response}),
            ),
        ]
    }

    fn text_delta(&mut self, text: &str) -> Vec<Vec<u8>> {
        if text.is_empty() {
            return self.emit_start();
        }
        self.text.push_str(text);
        let mut output = self.emit_start();
        if !self.text_started {
            self.text_started = true;
            self.text_output_index = self.next_output_index;
            self.next_output_index += 1;
            output.push(sse_event_bytes("response.output_item.added", json!({"type":"response.output_item.added","output_index":self.text_output_index,"item":{"id":self.text_item_id,"type":"message","status":"in_progress","role":"assistant","content":[]}})));
            output.push(sse_event_bytes("response.content_part.added", json!({"type":"response.content_part.added","item_id":self.text_item_id,"output_index":self.text_output_index,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}})));
        }
        output.push(sse_event_bytes("response.output_text.delta", json!({"type":"response.output_text.delta","item_id":self.text_item_id,"output_index":self.text_output_index,"content_index":0,"delta":text})));
        output
    }

    fn tool_state(
        &mut self,
        index: u64,
        call_id: Option<&str>,
        name: Option<&str>,
    ) -> &mut ConvertedToolState {
        let next = self.next_output_index;
        let state = self.tools.entry(index).or_insert_with(|| {
            self.next_output_index += 1;
            ConvertedToolState {
                item_id: format!("fc_{}", uuid::Uuid::new_v4()),
                output_index: next,
                call_id: call_id.unwrap_or("call_unknown").into(),
                name: name.unwrap_or("").into(),
                arguments: String::new(),
            }
        });
        if let Some(call_id) = call_id {
            state.call_id = call_id.into();
        }
        if let Some(name) = name {
            state.name = name.into();
        }
        state
    }

    fn tool_start_values(
        &mut self,
        item_id: &str,
        output_index: u64,
        call_id: &str,
        name: &str,
    ) -> Vec<Vec<u8>> {
        let mut output = self.emit_start();
        output.push(sse_event_bytes("response.output_item.added", json!({"type":"response.output_item.added","output_index":output_index,"item":{"id":item_id,"type":"function_call","status":"in_progress","call_id":call_id,"name":name,"arguments":""}})));
        output
    }

    fn tool_delta(&mut self, call: &Value) -> Vec<Vec<u8>> {
        let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
        let function = call.get("function").unwrap_or(&Value::Null);
        let call_id = call.get("id").and_then(Value::as_str);
        let name = function.get("name").and_then(Value::as_str);
        let arguments = function
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("");
        let state = self.tool_state(index, call_id, name);
        let snapshot = (
            state.item_id.clone(),
            state.output_index,
            state.call_id.clone(),
            state.name.clone(),
            state.arguments.is_empty(),
        );
        let mut output = if snapshot.4 {
            self.tool_start_values(&snapshot.0, snapshot.1, &snapshot.2, &snapshot.3)
        } else {
            self.emit_start()
        };
        if let Some(state) = self.tools.get_mut(&index) {
            state.arguments.push_str(arguments);
        }
        if !arguments.is_empty() {
            output.push(sse_event_bytes("response.function_call_arguments.delta", json!({"type":"response.function_call_arguments.delta","item_id":snapshot.0,"output_index":snapshot.1,"delta":arguments})));
        }
        output
    }

    fn tool_argument_delta(&mut self, index: u64, arguments: &str) -> Vec<Vec<u8>> {
        let state = self.tool_state(index, None, None);
        let snapshot = (
            state.item_id.clone(),
            state.output_index,
            state.call_id.clone(),
            state.name.clone(),
            state.arguments.is_empty(),
        );
        let mut output = if snapshot.4 {
            self.tool_start_values(&snapshot.0, snapshot.1, &snapshot.2, &snapshot.3)
        } else {
            self.emit_start()
        };
        if let Some(state) = self.tools.get_mut(&index) {
            state.arguments.push_str(arguments);
        }
        if !arguments.is_empty() {
            output.push(sse_event_bytes("response.function_call_arguments.delta", json!({"type":"response.function_call_arguments.delta","item_id":snapshot.0,"output_index":snapshot.1,"delta":arguments})));
        }
        output
    }

    fn fail(&mut self, message: &str) -> Vec<Vec<u8>> {
        self.failed = true;
        self.terminal = true;
        let mut response = response_base(&None, &self.model, "failed");
        response["error"] = json!({"code":"upstream_stream_error","message":message});
        let mut output = self.emit_start();
        output.push(sse_event_bytes(
            "response.failed",
            json!({"type":"response.failed","response":response}),
        ));
        output
    }

    fn finish(&mut self) -> Vec<Vec<u8>> {
        if !self.buffer.is_empty() {
            let block = std::mem::take(&mut self.buffer);
            let mut output = self.process_block(&block);
            output.extend(self.finish_events());
            return output;
        }
        self.finish_events()
    }

    fn finish_events(&mut self) -> Vec<Vec<u8>> {
        if self.failed {
            return Vec::new();
        }
        if !self.terminal {
            return self.fail("Upstream stream ended without a terminal event");
        }
        let mut output = self.emit_start();
        if self.text_started {
            let item = json!({"id":self.text_item_id,"type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":self.text,"annotations":[]}]});
            output.extend([sse_event_bytes("response.output_text.done", json!({"type":"response.output_text.done","item_id":self.text_item_id,"output_index":self.text_output_index,"text":self.text})), sse_event_bytes("response.output_item.done", json!({"type":"response.output_item.done","output_index":self.text_output_index,"item":item}))]);
        }
        let mut items = Vec::new();
        if self.text_started {
            items.push(json!({"id":self.text_item_id,"type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":self.text,"annotations":[]}]}));
        }
        for state in self.tools.values() {
            let arguments = if state.arguments.trim().is_empty() {
                "{}"
            } else {
                &state.arguments
            };
            let item = json!({"id":state.item_id,"type":"function_call","status":"completed","call_id":state.call_id,"name":state.name,"arguments":arguments});
            output.extend([sse_event_bytes("response.function_call_arguments.done", json!({"type":"response.function_call_arguments.done","item_id":state.item_id,"output_index":state.output_index,"arguments":arguments})), sse_event_bytes("response.output_item.done", json!({"type":"response.output_item.done","output_index":state.output_index,"item":item.clone()}))]);
            items.push(item);
        }
        output.push(sse_event_bytes("response.completed", json!({"type":"response.completed","response":json!({"id":format!("resp_{}",uuid::Uuid::new_v4()),"object":"response","status":"completed","model":self.model,"output":items})})));
        output
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SseMode {
    Pending,
    Passthrough,
    RepairText,
}

struct NativeSseAdapter {
    buffer: Vec<u8>,
    model: String,
    response_id: Option<String>,
    terminal: bool,
    mode: SseMode,
    response_started: bool,
    text_started: bool,
    text_item_id: String,
    output_index: u64,
    full_text: String,
    response_model: Option<String>,
    completed_response: Option<Value>,
    other_output: BTreeMap<u64, Value>,
    usage: Option<SseUsage>,
    failed: bool,
}

impl NativeSseAdapter {
    fn new(model: &str) -> Self {
        Self {
            buffer: Vec::new(),
            model: model.to_string(),
            response_id: None,
            terminal: false,
            mode: SseMode::Pending,
            response_started: false,
            text_started: false,
            text_item_id: format!("msg_{}", uuid::Uuid::new_v4()),
            output_index: 0,
            full_text: String::new(),
            response_model: None,
            completed_response: None,
            other_output: BTreeMap::new(),
            usage: None,
            failed: false,
        }
    }

    fn process_chunk(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.buffer.extend_from_slice(bytes);
        let mut output = Vec::new();
        while let Some((index, separator_length)) = find_sse_block_end(&self.buffer) {
            let block = self.buffer[..index].to_vec();
            self.buffer.drain(..index + separator_length);
            output.extend(self.process_block(block, separator_length));
        }
        output
    }

    fn process_block(&mut self, raw_block: Vec<u8>, separator_length: usize) -> Vec<Vec<u8>> {
        let Ok(block) = std::str::from_utf8(&raw_block) else {
            return vec![raw_block];
        };
        if self.mode == SseMode::Passthrough {
            self.observe_native(block);
            return vec![raw_block_with_separator(raw_block, separator_length)];
        }
        let mut event = None;
        let data = block
            .lines()
            .filter_map(|line| {
                let line = line.trim_end_matches('\r');
                if let Some(value) = line.strip_prefix("event:") {
                    event = Some(value.trim().to_string());
                }
                line.strip_prefix("data:").map(str::trim_start)
            })
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            return vec![raw_block_with_separator(raw_block, separator_length)];
        }
        let Ok(payload) = serde_json::from_str::<Value>(&data) else {
            return vec![raw_block_with_separator(raw_block, separator_length)];
        };
        let kind = payload
            .get("type")
            .and_then(Value::as_str)
            .or(event.as_deref())
            .unwrap_or("")
            .to_string();
        if let Some(id) = payload
            .get("response")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
        {
            self.response_id = Some(id.to_string());
        }
        if self.mode == SseMode::Pending {
            if kind == "response.output_text.delta"
                || (kind == "response.completed"
                    && payload
                        .get("response")
                        .and_then(|value| value.get("output_text"))
                        .is_some())
            {
                self.mode = SseMode::RepairText;
            } else {
                self.mode = SseMode::Passthrough;
                self.observe_native_payload(&payload);
                return vec![raw_block_with_separator(raw_block, separator_length)];
            }
        }
        if self.mode == SseMode::RepairText {
            if self.terminal {
                return Vec::new();
            }
            return self.repair_payload(&kind, payload);
        }
        vec![raw_block_with_separator(raw_block, separator_length)]
    }

    fn observe_native(&mut self, block: &str) {
        let data = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        if let Ok(payload) = serde_json::from_str::<Value>(&data) {
            self.observe_native_payload(&payload);
        }
    }

    fn observe_native_payload(&mut self, payload: &Value) {
        if let Some(model) = payload
            .get("response")
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
        {
            self.response_model = Some(model.to_string());
        }
        if let Some(id) = payload
            .get("response")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
        {
            self.response_id = Some(id.to_string());
        }
        if let Some(usage) = parse_sse_usage(payload) {
            self.usage = Some(usage);
        }
        if matches!(
            payload.get("type").and_then(Value::as_str),
            Some("response.completed" | "response.failed" | "response.incomplete" | "error")
        ) {
            self.terminal = true;
            self.failed |= payload["type"] != "response.completed";
        }
    }

    fn repair_payload(&mut self, kind: &str, payload: Value) -> Vec<Vec<u8>> {
        match kind {
            "response.created" | "response.in_progress" => {
                self.observe_native_payload(&payload);
                if self.response_started {
                    return Vec::new();
                }
                self.response_started = true;
                vec![
                    sse_event_bytes(
                        "response.created",
                        json!({"type":"response.created","response":response_base(&self.response_id,&self.model,"in_progress")}),
                    ),
                    sse_event_bytes(
                        "response.in_progress",
                        json!({"type":"response.in_progress","response":response_base(&self.response_id,&self.model,"in_progress")}),
                    ),
                ]
            }
            "response.output_text.delta" => {
                let item_id = payload
                    .get("item_id")
                    .and_then(Value::as_str)
                    .unwrap_or(&self.text_item_id)
                    .to_string();
                if self.text_started && item_id != self.text_item_id {
                    return self.fail_repair(
                        "Multiple text items in a malformed upstream stream are not supported",
                    );
                }
                self.text_item_id = item_id;
                if let Some(index) = payload.get("output_index").and_then(Value::as_u64) {
                    self.output_index = index;
                }
                let delta = payload.get("delta").and_then(Value::as_str).unwrap_or("");
                self.full_text.push_str(delta);
                self.emit_text_delta(delta)
            }
            "response.completed" => {
                self.completed_response = payload.get("response").cloned();
                if let Some(model) = payload
                    .get("response")
                    .and_then(|value| value.get("model"))
                    .and_then(Value::as_str)
                {
                    self.response_model = Some(model.to_string());
                }
                if self.response_id.is_none() {
                    self.response_id = payload
                        .get("response")
                        .and_then(|value| value.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                if self.full_text.is_empty() {
                    self.full_text = payload["response"]
                        .get("output_text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into();
                }
                self.terminal = true;
                self.usage = parse_sse_usage(&payload);
                self.finish_text()
            }
            "response.output_item.done" => {
                if let Some(index) = payload.get("output_index").and_then(Value::as_u64) {
                    if let Some(item) = payload.get("item") {
                        self.other_output.insert(index, item.clone());
                    }
                }
                vec![raw_event_from_payload(kind, &payload)]
            }
            "response.failed" | "response.incomplete" | "error" => {
                self.terminal = true;
                self.failed = true;
                let mut output = self.emit_text_delta("");
                output.push(sse_event_bytes(kind, payload));
                output
            }
            _ => vec![raw_event_from_payload(kind, &payload)],
        }
    }

    fn emit_text_delta(&mut self, delta: &str) -> Vec<Vec<u8>> {
        let mut output = Vec::new();
        if !self.response_started {
            self.response_started = true;
            let created = json!({"type":"response.created","response":response_base(&self.response_id, &self.model, "in_progress")});
            let progress = json!({"type":"response.in_progress","response":response_base(&self.response_id, &self.model, "in_progress")});
            output.extend([
                sse_event_bytes("response.created", created),
                sse_event_bytes("response.in_progress", progress),
            ]);
        }
        if !self.text_started {
            self.text_started = true;
            output.push(sse_event_bytes("response.output_item.added", json!({"type":"response.output_item.added","output_index":self.output_index,"item":{"id":self.text_item_id,"type":"message","status":"in_progress","role":"assistant","content":[]}})));
            output.push(sse_event_bytes("response.content_part.added", json!({"type":"response.content_part.added","item_id":self.text_item_id,"output_index":self.output_index,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}})));
        }
        if !delta.is_empty() {
            output.push(sse_event_bytes("response.output_text.delta", json!({"type":"response.output_text.delta","item_id":self.text_item_id,"output_index":self.output_index,"content_index":0,"delta":delta})));
        }
        output
    }

    fn fail_repair(&mut self, message: &str) -> Vec<Vec<u8>> {
        self.terminal = true;
        self.failed = true;
        let mut response = response_base(&self.response_id, &self.model, "in_progress");
        response["status"] = json!("failed");
        response["error"] = json!({
            "code": "upstream_stream_error",
            "message": message,
        });
        vec![sse_event_bytes(
            "response.failed",
            json!({"type":"response.failed","response":response}),
        )]
    }

    fn finish_text(&mut self) -> Vec<Vec<u8>> {
        let mut output = self.emit_text_delta("");
        self.terminal = true;
        let item = json!({"id":self.text_item_id,"type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":self.full_text,"annotations":[]}]});
        let mut completed_items = self
            .completed_response
            .as_ref()
            .and_then(|response| response.get("output"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (index, other) in &self.other_output {
            let existing_id = other.get("id").and_then(Value::as_str);
            if let Some(existing_id) = existing_id {
                if let Some(existing_index) = completed_items.iter().position(|value| {
                    value
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| id == existing_id)
                }) {
                    completed_items[existing_index] = other.clone();
                    continue;
                }
            }
            let index = *index as usize;
            if index < completed_items.len() && completed_items[index].get("id").is_none() {
                completed_items[index] = other.clone();
            } else {
                while completed_items.len() < index {
                    completed_items.push(Value::Null);
                }
                completed_items.push(other.clone());
            }
        }
        completed_items.retain(|value| !value.is_null());
        if let Some(index) = completed_items.iter().position(|value| {
            value
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id == self.text_item_id)
        }) {
            completed_items[index] = item.clone();
        } else {
            let text_index = self.output_index.min(completed_items.len() as u64) as usize;
            completed_items.insert(text_index, item.clone());
        }
        output.push(sse_event_bytes("response.output_text.done", json!({"type":"response.output_text.done","item_id":self.text_item_id,"output_index":self.output_index,"content_index":0,"text":self.full_text})));
        output.push(sse_event_bytes("response.content_part.done", json!({"type":"response.content_part.done","item_id":self.text_item_id,"output_index":self.output_index,"content_index":0,"part":{"type":"output_text","text":self.full_text,"annotations":[]}})));
        output.push(sse_event_bytes("response.output_item.done", json!({"type":"response.output_item.done","output_index":self.output_index,"item":item})));
        let mut response = self
            .completed_response
            .clone()
            .filter(Value::is_object)
            .unwrap_or_else(|| response_base(&self.response_id, &self.model, "completed"));
        response["id"] = json!(self
            .response_id
            .clone()
            .unwrap_or_else(|| format!("resp_{}", uuid::Uuid::new_v4())));
        response["object"] = json!("response");
        response["model"] = json!(self.model);
        response["status"] = json!("completed");
        response["output"] = json!(completed_items);
        response["output_text"] = json!(self.full_text);
        if let Some(usage) = &self.usage {
            response["usage"] = usage.to_json();
        }
        output.push(sse_event_bytes(
            "response.completed",
            json!({"type":"response.completed","response":response}),
        ));
        output
    }

    fn finish(&mut self) -> Vec<Vec<u8>> {
        let mut output = Vec::new();
        if !self.buffer.is_empty() {
            let block = std::mem::take(&mut self.buffer);
            output.extend(self.process_block(block, 0));
        }
        if !self.terminal {
            if self.mode == SseMode::RepairText {
                self.failed = true;
                let mut response = response_base(&self.response_id, &self.model, "failed");
                response["error"] = json!({"code":"upstream_stream_error","message":"Upstream stream ended without a terminal event"});
                output.push(sse_event_bytes(
                    "response.failed",
                    json!({"type":"response.failed","response":response}),
                ));
            } else {
                let id = self.response_id.clone();
                output.push(sse_event_bytes("response.failed", json!({"type":"response.failed","response":{"id":id.unwrap_or_else(||"resp_tauri".into()),"object":"response","model":self.model,"status":"failed","output":[],"error":{"code":"upstream_stream_error","message":"Upstream stream ended without a terminal event"}}})));
                self.failed = true;
            }
        }
        output
    }

    fn usage(&self) -> Option<SseUsage> {
        self.usage.clone()
    }

    fn response_model(&self) -> Option<String> {
        self.response_model.clone()
    }
}

impl SseUsage {
    fn to_json(&self) -> Value {
        json!({"input_tokens":self.input_tokens,"output_tokens":self.output_tokens,"total_tokens":self.input_tokens+self.output_tokens,"input_tokens_details":{"cached_tokens":self.cached_tokens}})
    }
}

fn parse_sse_usage(payload: &Value) -> Option<SseUsage> {
    let usage = payload
        .get("response")
        .and_then(|response| response.get("usage"))
        .or_else(|| payload.get("usage"))?;
    let input = usage.get("input_tokens")?.as_u64()?;
    let output = usage.get("output_tokens")?.as_u64()?;
    let cached = usage
        .get("input_tokens_details")
        .and_then(|details| details.get("cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some(SseUsage {
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cached,
    })
}

fn response_base(id: &Option<String>, model: &str, status: &str) -> Value {
    json!({"id":id.clone().unwrap_or_else(||format!("resp_{}", uuid::Uuid::new_v4())),"object":"response","model":model,"status":status,"output":[]})
}

fn sse_event_bytes(event: &str, payload: Value) -> Vec<u8> {
    format!("event: {event}\ndata: {payload}\n\n").into_bytes()
}

fn raw_event_from_payload(event: &str, payload: &Value) -> Vec<u8> {
    sse_event_bytes(event, payload.clone())
}

fn raw_block_with_separator(mut block: Vec<u8>, separator_length: usize) -> Vec<u8> {
    block.extend_from_slice(if separator_length == 4 {
        b"\r\n\r\n"
    } else {
        b"\n\n"
    });
    block
}

fn find_sse_block_end(bytes: &[u8]) -> Option<(usize, usize)> {
    for index in 0..bytes.len().saturating_sub(1) {
        if bytes[index] == b'\n' && bytes[index + 1] == b'\n' {
            return Some((index, 2));
        }
        if index + 3 < bytes.len() && bytes[index..index + 4] == *b"\r\n\r\n" {
            return Some((index, 4));
        }
    }
    None
}

fn write_response(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let body = body.to_string();
    let response = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: http://127.0.0.1\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nConnection: close\r\n\r\n{body}",
        reason(status), body.len()
    );
    stream.write_all(response.as_bytes())
}

struct HttpRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    #[allow(dead_code)]
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> std::io::Result<HttpRequest> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let size = stream.read(&mut chunk)?;
        if size == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "empty request",
            ));
        }
        bytes.extend_from_slice(&chunk[..size]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "headers too large",
            ));
        }
    };
    if header_end > MAX_HEADER_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "headers too large",
        ));
    }
    let header_text = String::from_utf8(bytes[..header_end].to_vec())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid headers"))?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    if !matches!(method.as_str(), "GET" | "POST" | "OPTIONS")
        || !path.starts_with('/')
        || parts.next() != Some("HTTP/1.1")
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid request line",
        ));
    }
    let mut authorization = None;
    let mut seen_authorization = false;
    let mut content_length = None;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid header",
            ));
        };
        if name.eq_ignore_ascii_case("authorization") {
            if seen_authorization {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "duplicate authorization",
                ));
            }
            seen_authorization = true;
            authorization = value.trim().strip_prefix("Bearer ").map(str::to_string);
        }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "duplicate length",
                ));
            }
            content_length = Some(value.trim().parse::<usize>().map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid length")
            })?);
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unsupported encoding",
            ));
        }
    }
    if method == "POST" && content_length.is_none() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "missing length",
        ));
    }
    let content_length = content_length.unwrap_or(0);
    if content_length > MAX_REQUEST_BODY_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "body too large",
        ));
    }
    let mut body = bytes[header_end..].to_vec();
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "body too large",
        ));
    }
    while body.len() < content_length {
        let size = stream.read(&mut chunk)?;
        if size == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "truncated body",
            ));
        }
        body.extend_from_slice(&chunk[..size]);
        if body.len() > MAX_REQUEST_BODY_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "body too large",
            ));
        }
    }
    body.truncate(content_length);
    Ok(HttpRequest {
        method,
        path,
        authorization,
        body,
    })
}

fn status_value(running: bool, endpoint: &str, store: &PreviewStore) -> Value {
    let provider = store
        .current_provider_id()
        .ok()
        .flatten()
        .and_then(|id| {
            store.list_providers().ok().and_then(|providers| {
                providers
                    .as_array()
                    .and_then(|items| items.iter().find(|item| item["id"] == id))
                    .map(|provider| {
                        json!({
                            "currentProviderId": id,
                            "currentProviderName": provider["name"].as_str().unwrap_or(""),
                            "currentModel": provider["selectedModel"].as_str().unwrap_or(""),
                        })
                    })
            })
        })
        .unwrap_or_else(|| json!({}));
    let mut result = json!({ "running": running, "mode": "local_gateway", "endpoint": endpoint });
    if let Some(object) = result.as_object_mut() {
        if let Some(provider) = provider.as_object() {
            object.extend(provider.clone());
        }
    }
    result
}

fn reason(status: u16) -> &'static str {
    reqwest::StatusCode::from_u16(status)
        .ok()
        .and_then(|code| code.canonical_reason())
        .unwrap_or("Unknown")
}

fn gateway_error(code: &'static str, message: &'static str) -> CommandError {
    CommandError::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn circuit_config() -> GatewayRouteConfig {
        GatewayRouteConfig {
            failover_enabled: true,
            max_attempts: 3,
            total_timeout: Duration::from_secs(10),
            failure_threshold: 2,
            cooldown: Duration::ZERO,
            half_open_max_requests: 1,
        }
    }

    #[test]
    fn circuit_opens_at_threshold_limits_half_open_and_recovers_on_success() {
        let registry = CircuitRegistry::default();
        let config = circuit_config();

        let first = registry.acquire("provider", &config).unwrap();
        registry.complete("provider", first, true, &config);
        assert_eq!(
            registry.acquire("provider", &config),
            Some(CircuitPermit::Closed)
        );

        let second = registry.acquire("provider", &config).unwrap();
        registry.complete("provider", second, true, &config);
        assert_eq!(
            registry.acquire("provider", &config),
            Some(CircuitPermit::HalfOpen)
        );
        assert_eq!(registry.acquire("provider", &config), None);

        let half_open = CircuitPermit::HalfOpen;
        registry.complete("provider", half_open, false, &config);
        assert_eq!(
            registry.acquire("provider", &config),
            Some(CircuitPermit::Closed)
        );
    }

    #[test]
    fn disabling_failover_clears_open_circuits() {
        let registry = CircuitRegistry::default();
        let config = circuit_config();
        let permit = registry.acquire("provider", &config).unwrap();
        registry.complete("provider", permit, true, &config);
        let permit = registry.acquire("provider", &config).unwrap();
        registry.complete("provider", permit, true, &config);
        assert_eq!(
            registry.acquire("provider", &config),
            Some(CircuitPermit::HalfOpen)
        );

        registry.clear_if_disabled(false);
        assert_eq!(
            registry.acquire("provider", &config),
            Some(CircuitPermit::Closed)
        );
    }

    #[test]
    fn circuit_registry_is_shared_across_requests_and_skips_open_primary() {
        let registry = CircuitRegistry::default();
        let mut config = circuit_config();
        config.failure_threshold = 1;
        config.cooldown = Duration::from_secs(3600);

        let first = registry.acquire("primary", &config).unwrap();
        registry.complete("primary", first, true, &config);
        assert!(!registry.available("primary", &config));
        assert!(registry.available("backup", &config));

        assert_eq!(registry.acquire("primary", &config), None);
        let backup = registry.acquire("backup", &config).unwrap();
        registry.complete("backup", backup, false, &config);
        assert!(registry.available("backup", &config));
    }

    fn get(endpoint: &str, path: &str) -> String {
        let address = endpoint
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut output = String::new();
        stream.read_to_string(&mut output).unwrap();
        output
    }

    #[test]
    fn starts_health_endpoint_and_rejects_upstream_forwarding() {
        let state = GatewayState::default();
        let root = std::env::temp_dir().join(format!("cksw-gateway-{}", uuid::Uuid::new_v4()));
        let store = crate::storage::PreviewStore::new(root.clone());
        let status = state.start(&store).unwrap();
        let endpoint = status["endpoint"].as_str().unwrap();
        assert!(get(endpoint, "/__health").starts_with("HTTP/1.1 200"));
        assert!(get(endpoint, "/v1/responses").starts_with("HTTP/1.1 401"));
        let token = store.local_gateway_api_key().unwrap();
        let address = endpoint
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        write!(stream, "POST /v1/responses HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        let mut output = String::new();
        stream.read_to_string(&mut output).unwrap();
        assert!(output.starts_with("HTTP/1.1 503"));
        state.stop(&store).unwrap();
        assert!(!state.status(&store).unwrap()["running"].as_bool().unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn start_is_idempotent_and_keeps_one_endpoint() {
        let state = GatewayState::default();
        let root =
            std::env::temp_dir().join(format!("cksw-gateway-idempotent-{}", uuid::Uuid::new_v4()));
        let store = crate::storage::PreviewStore::new(root.clone());
        let first = state.start(&store).unwrap();
        let second = state.start(&store).unwrap();
        assert_eq!(first["endpoint"], second["endpoint"]);
        state.stop(&store).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn status_exposes_current_provider_metadata_from_preview_store() {
        use std::{collections::HashMap, sync::Mutex};

        struct MemorySecrets(Mutex<HashMap<String, String>>);
        impl SecretBackend for MemorySecrets {
            fn set(&self, id: &str, value: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().insert(id.into(), value.into());
                Ok(())
            }
            fn get(&self, id: &str) -> Result<Option<String>, CommandError> {
                Ok(self.0.lock().unwrap().get(id).cloned())
            }
            fn delete(&self, id: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().remove(id);
                Ok(())
            }
        }

        let state = GatewayState::default();
        let root = std::env::temp_dir().join(format!(
            "cksw-gateway-status-provider-{}",
            uuid::Uuid::new_v4()
        ));
        let store = crate::storage::PreviewStore::new(root.clone());
        let secrets = MemorySecrets(Mutex::new(HashMap::new()));
        let input: crate::providers::ProviderInput = serde_json::from_value(json!({
            "id": "provider-status",
            "name": "Status Provider",
            "baseURL": "https://example.com/v1",
            "apiFormat": "responses",
            "apiKey": "preview-key",
            "models": [{"customName":"Preview Model","model":"preview-model"}],
            "selectedModel": "Preview Model"
        }))
        .unwrap();
        crate::providers::save_provider(&store, &secrets, input).unwrap();
        crate::providers::set_current_provider(&store, &secrets, "provider-status").unwrap();

        let status = state.status(&store).unwrap();
        assert_eq!(status["currentProviderId"], "provider-status");
        assert_eq!(status["currentProviderName"], "Status Provider");
        assert_eq!(status["currentModel"], "Preview Model");
        assert_eq!(status["running"], false);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_split_body_and_rejects_invalid_lengths() {
        let state = GatewayState::default();
        let root =
            std::env::temp_dir().join(format!("cksw-gateway-parser-{}", uuid::Uuid::new_v4()));
        let store = crate::storage::PreviewStore::new(root.clone());
        let endpoint = state.start(&store).unwrap()["endpoint"]
            .as_str()
            .unwrap()
            .to_string();
        let token = store.local_gateway_api_key().unwrap();
        let address = endpoint
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let send = |header: String, body: Option<&[u8]>| {
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream.write_all(header.as_bytes()).unwrap();
            if let Some(body) = body {
                stream.write_all(body).unwrap();
            }
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };
        let body = br#"{"input":"hello"}"#;
        let split = format!("POST /v1/responses HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n", body.len());
        assert!(send(split, Some(body)).starts_with("HTTP/1.1 503"));
        let duplicate = format!("POST /v1/responses HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n");
        assert!(send(duplicate, None).starts_with("HTTP/1.1 400"));
        let too_large = format!("POST /v1/responses HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n", MAX_REQUEST_BODY_BYTES + 1);
        assert!(send(too_large, None).starts_with("HTTP/1.1 413"));
        let chunked = format!(
            "POST /v1/responses HTTP/1.1\r\nHost: {address}\r\nTransfer-Encoding: chunked\r\n\r\n"
        );
        assert!(send(chunked, None).starts_with("HTTP/1.1 400"));
        state.stop(&store).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn accepted_connection_waits_for_delayed_request_bytes() {
        let state = GatewayState::default();
        let root =
            std::env::temp_dir().join(format!("cksw-gateway-delay-{}", uuid::Uuid::new_v4()));
        let store = PreviewStore::new(root.clone());
        let status = state.start(&store).unwrap();
        let address = status["endpoint"]
            .as_str()
            .unwrap()
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        thread::sleep(Duration::from_millis(80));
        stream.write_all(b"GET /__health HTTP/1.1\r\n").unwrap();
        thread::sleep(Duration::from_millis(80));
        stream.write_all(b"Host: localhost\r\n\r\n").unwrap();
        let mut output = String::new();
        stream.read_to_string(&mut output).unwrap();
        assert!(output.starts_with("HTTP/1.1 200"));
        state.stop(&store).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn forwards_non_streaming_responses_to_a_local_upstream() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = upstream.local_addr().unwrap();
        let join = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let request = read_http_request(&mut stream).unwrap();
            assert!(request.path.ends_with("/v1/responses"));
            assert!(request.authorization.as_deref() == Some("upstream-secret"));
            let payload: Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(payload["model"], "selected-upstream-model");
            write_response(
                &mut stream,
                201,
                &json!({ "id": "response-test", "status": "completed" }),
            )
            .unwrap();
        });
        let provider = GatewayProvider {
            id: "test-provider".into(),
            name: "Test Provider".into(),
            base_url: format!("http://{address}/v1"),
            model: "selected-upstream-model".into(),
            api_key: "upstream-secret".into(),
            api_format: "responses".into(),
        };
        let (status, body) = forward_responses(
            Some(&provider),
            br#"{"model":"selected-upstream-model","input":"hello"}"#,
        );
        assert_eq!(status, 201);
        assert_eq!(body["id"], "response-test");
        join.join().unwrap();
    }

    #[test]
    fn rejects_streaming_and_unmigrated_protocols_without_contacting_upstream() {
        let responses = GatewayProvider {
            id: "test-provider".into(),
            name: "Test Provider".into(),
            base_url: "https://example.com/v1".into(),
            model: "model".into(),
            api_key: "secret".into(),
            api_format: "responses".into(),
        };
        assert_eq!(
            forward_responses(Some(&responses), br#"{"stream":true}"#).0,
            501
        );
        let chat = GatewayProvider {
            api_format: "chat_completions".into(),
            ..responses
        };
        assert_eq!(forward_responses(Some(&chat), br#"{}"#).0, 400);
    }

    #[test]
    fn converts_chat_and_anthropic_non_streaming_responses_to_responses_output() {
        let chat_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let chat_address = chat_listener.local_addr().unwrap();
        let chat_worker = thread::spawn(move || {
            let (mut stream, _) = chat_listener.accept().unwrap();
            let request = read_http_request(&mut stream).unwrap();
            assert!(request.path.ends_with("/v1/chat/completions"));
            let payload: Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(payload["messages"][0]["role"], "user");
            write_response(
                &mut stream,
                200,
                &json!({"id":"chat-1","choices":[{"message":{"content":"hello","tool_calls":[{"id":"call-1","function":{"name":"shell","arguments":"{}"}}]}}],"usage":{"prompt_tokens":2,"completion_tokens":3}}),
            )
            .unwrap();
        });
        let chat = GatewayProvider {
            id: "chat".into(),
            name: "Chat".into(),
            base_url: format!("http://{chat_address}/v1"),
            model: "chat-model".into(),
            api_key: "chat-key".into(),
            api_format: "chat_completions".into(),
        };
        let (status, body) =
            forward_responses(Some(&chat), br#"{"model":"chat-model","input":"hello"}"#);
        assert_eq!(status, 200);
        assert_eq!(body["output"][0]["type"], "message");
        assert_eq!(body["output"][1]["type"], "function_call");
        chat_worker.join().unwrap();

        let anthropic_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let anthropic_address = anthropic_listener.local_addr().unwrap();
        let anthropic_worker = thread::spawn(move || {
            let (mut stream, _) = anthropic_listener.accept().unwrap();
            let request = read_http_request(&mut stream).unwrap();
            assert!(request.path.ends_with("/v1/messages"));
            let payload: Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(payload["messages"][0]["role"], "user");
            write_response(
                &mut stream,
                200,
                &json!({"id":"msg-1","content":[{"type":"text","text":"hello"},{"type":"tool_use","id":"tool-1","name":"read","input":{"path":"README.md"}}],"usage":{"input_tokens":4,"output_tokens":5}}),
            )
            .unwrap();
        });
        let anthropic = GatewayProvider {
            id: "anthropic".into(),
            name: "Anthropic".into(),
            base_url: format!("http://{anthropic_address}/v1"),
            model: "claude-model".into(),
            api_key: "anthropic-key".into(),
            api_format: "anthropic_messages".into(),
        };
        let (status, body) = forward_responses(
            Some(&anthropic),
            br#"{"model":"claude-model","input":"hello"}"#,
        );
        assert_eq!(status, 200);
        assert_eq!(body["output"][0]["type"], "message");
        assert_eq!(body["output"][1]["type"], "function_call");
        anthropic_worker.join().unwrap();
    }

    #[test]
    fn rust_protocol_conversion_matches_shared_blackbox_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../fixtures/protocol-blackbox.json")).unwrap();
        let base = GatewayProvider {
            id: "blackbox".into(),
            name: "Blackbox".into(),
            base_url: "https://example.com/v1".into(),
            model: "upstream-model".into(),
            api_key: "key".into(),
            api_format: "responses".into(),
        };
        for (format, expected_request, expected_response) in [
            ("chat_completions", "chatRequest", "chatResponse"),
            (
                "anthropic_messages",
                "anthropicRequest",
                "anthropicResponse",
            ),
        ] {
            let provider = GatewayProvider {
                api_format: format.into(),
                ..base.clone()
            };
            let request = prepare_protocol_request(
                &provider,
                serde_json::to_string(&fixture["request"])
                    .unwrap()
                    .as_bytes(),
                false,
            )
            .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&request).unwrap(),
                fixture[expected_request]
            );
            let response = if format == "chat_completions" {
                response_from_chat(&fixture[expected_response], "upstream-model")
            } else {
                response_from_anthropic(&fixture[expected_response], "upstream-model")
            };
            let output = response["output"].as_array().unwrap();
            let summary = output
                .iter()
                .map(|item| {
                    let mut value = serde_json::Map::new();
                    value.insert("type".into(), item["type"].clone());
                    let text = item["content"][0]["text"].clone();
                    if !text.is_null() {
                        value.insert("text".into(), text);
                    }
                    let call_id = item["call_id"].clone();
                    if !call_id.is_null() {
                        value.insert("callId".into(), call_id);
                    }
                    let name = item["name"].clone();
                    if !name.is_null() {
                        value.insert("name".into(), name);
                    }
                    Value::Object(value)
                })
                .collect::<Vec<_>>();
            assert_eq!(Value::Array(summary), fixture["expectedOutput"]);
        }
    }

    #[test]
    fn responses_upstream_normalization_matches_shared_blackbox_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../fixtures/protocol-blackbox.json")).unwrap();
        for case in fixture["responsesCompatibility"].as_array().unwrap() {
            let provider = GatewayProvider {
                id: "blackbox".into(),
                name: "Blackbox".into(),
                base_url: case["baseURL"].as_str().unwrap().into(),
                model: "upstream-model".into(),
                api_key: "key".into(),
                api_format: "responses".into(),
            };
            let request = prepare_protocol_request(
                &provider,
                serde_json::to_string(&case["request"]).unwrap().as_bytes(),
                false,
            )
            .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&request).unwrap(),
                case["expected"]
            );
        }
    }

    #[test]
    fn converted_protocols_reject_shared_media_history_instead_of_dropping_it() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../fixtures/protocol-blackbox.json")).unwrap();
        for api_format in ["chat_completions", "anthropic_messages"] {
            let provider = GatewayProvider {
                id: "blackbox".into(),
                name: "Blackbox".into(),
                base_url: "https://example.com/v1".into(),
                model: "upstream-model".into(),
                api_key: "key".into(),
                api_format: api_format.into(),
            };
            let request = serde_json::to_vec(&fixture["unsupportedConvertedInput"]).unwrap();
            let error = prepare_protocol_request(&provider, &request, false).unwrap_err();
            assert_eq!(error.status, 400);
            assert!(error.message.contains("image/file history"));
        }
    }

    #[test]
    fn converts_chat_and_anthropic_streams_to_responses_events() {
        for (format, chunks) in [
            (
                "chat_completions",
                vec![
                    json!({"choices":[{"delta":{"content":"hello"}}]}),
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"shell","arguments":"{}"}}]}}]}),
                    json!({"choices":[{"finish_reason":"tool_calls","delta":{}}]}),
                ],
            ),
            (
                "anthropic_messages",
                vec![
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hello"}}),
                    json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"shell","input":{}}}),
                    json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}),
                    json!({"type":"message_stop"}),
                ],
            ),
        ] {
            let mut adapter = ConvertedSseAdapter::new(format, "model");
            let mut output = Vec::new();
            for chunk in chunks {
                output.extend(adapter.process_chunk(format!("data: {chunk}\n\n").as_bytes()));
            }
            output.extend(adapter.finish());
            let output = String::from_utf8(output.concat()).unwrap();
            assert!(output.contains("response.created"));
            assert!(output.contains("response.output_text.delta"));
            assert!(output.contains("response.function_call_arguments.delta"));
            assert!(output.contains("response.function_call_arguments.done"));
            assert!(output.contains("response.completed"));
            assert!(!adapter.failed);
        }
    }

    #[test]
    fn rejects_opaque_history_for_converted_protocols() {
        let provider = GatewayProvider {
            id: "chat".into(),
            name: "Chat".into(),
            base_url: "https://example.com/v1".into(),
            model: "model".into(),
            api_key: "key".into(),
            api_format: "chat_completions".into(),
        };
        let error = prepare_protocol_request(
            &provider,
            br#"{"model":"model","previous_response_id":"resp-old","input":"continue"}"#,
            false,
        )
        .unwrap_err();
        assert_eq!(error.status, 400);
        assert!(error.message.contains("full conversation history"));
    }

    #[test]
    fn anthropic_parallel_tool_history_is_grouped_into_adjacent_blocks() {
        let provider = GatewayProvider {
            id: "anthropic".into(),
            name: "Anthropic".into(),
            base_url: "https://example.com/v1".into(),
            model: "model".into(),
            api_key: "key".into(),
            api_format: "anthropic_messages".into(),
        };
        let body = prepare_protocol_request(
            &provider,
            br#"{"model":"model","input":[{"role":"user","content":"read files"},{"type":"function_call","call_id":"a","name":"read","arguments":"{}"},{"type":"function_call","call_id":"b","name":"read","arguments":"{}"},{"type":"function_call_output","call_id":"a","output":"one"},{"type":"function_call_output","call_id":"b","output":"two"}]}"#,
            false,
        )
        .unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        let messages = payload["messages"].as_array().unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|message| message["role"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["user", "assistant", "user"]
        );
        assert_eq!(messages[1]["content"].as_array().unwrap().len(), 2);
        assert_eq!(messages[2]["content"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn converted_stream_stop_reasons_fail_without_success_completion() {
        let mut chat = ConvertedSseAdapter::new("chat_completions", "model");
        chat.process_chunk(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n");
        let output = chat.process_chunk(
            b"data: {\"choices\":[{\"finish_reason\":\"length\",\"delta\":{}}]}\n\n",
        );
        assert!(String::from_utf8(output.concat())
            .unwrap()
            .contains("response.failed"));
        assert!(chat.failed);

        let mut anthropic = ConvertedSseAdapter::new("anthropic_messages", "model");
        let output = anthropic.process_chunk(
            b"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\n",
        );
        assert!(String::from_utf8(output.concat())
            .unwrap()
            .contains("response.failed"));
        assert!(anthropic.failed);
    }

    #[test]
    fn does_not_follow_redirects_or_accept_non_json_success() {
        for (status, payload) in [(302, "redirected"), (200, "not-json")] {
            let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let address = upstream.local_addr().unwrap();
            let worker = thread::spawn(move || {
                let (mut stream, _) = upstream.accept().unwrap();
                let request = read_http_request(&mut stream).unwrap();
                assert_eq!(
                    request.authorization.as_deref(),
                    Some("synthetic-upstream-key")
                );
                write!(stream, "HTTP/1.1 {status} Test\r\nLocation: http://127.0.0.1:1/steal\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()).unwrap();
            });
            let provider = GatewayProvider {
                id: "test-provider".into(),
                name: "Test Provider".into(),
                base_url: format!("http://{address}/v1"),
                model: "model-1".into(),
                api_key: "synthetic-upstream-key".into(),
                api_format: "responses".into(),
            };
            let (actual, body) =
                forward_responses(Some(&provider), br#"{"model":"model-1","input":"hello"}"#);
            assert_eq!(actual, 502);
            assert!(body.get("error").is_some());
            worker.join().unwrap();
        }
    }

    #[test]
    fn preserves_upstream_error_status_and_json_body() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = upstream.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let request = read_http_request(&mut stream).unwrap();
            assert_eq!(
                request.authorization.as_deref(),
                Some("synthetic-upstream-key")
            );
            write_response(&mut stream, 429, &json!({"error":"rate limited"})).unwrap();
        });
        let provider = GatewayProvider {
            id: "test-provider".into(),
            name: "Test Provider".into(),
            base_url: format!("http://{address}/v1"),
            model: "model-1".into(),
            api_key: "synthetic-upstream-key".into(),
            api_format: "responses".into(),
        };
        let (status, body) = forward_responses(Some(&provider), br#"{"model":"model-1"}"#);
        assert_eq!(status, 429);
        assert_eq!(reason(status), "Too Many Requests");
        assert_eq!(body["error"], "rate limited");
        worker.join().unwrap();
    }

    #[test]
    fn authenticated_gateway_forwards_to_current_provider_and_rejects_other_models() {
        use std::collections::HashMap;
        struct MemorySecrets(Mutex<HashMap<String, String>>);
        impl SecretBackend for MemorySecrets {
            fn set(&self, id: &str, value: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().insert(id.into(), value.into());
                Ok(())
            }
            fn get(&self, id: &str) -> Result<Option<String>, CommandError> {
                Ok(self.0.lock().unwrap().get(id).cloned())
            }
            fn delete(&self, id: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().remove(id);
                Ok(())
            }
        }
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let join = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let request = read_http_request(&mut stream).unwrap();
            assert_eq!(
                request.authorization.as_deref(),
                Some("synthetic-upstream-key")
            );
            assert_eq!(
                serde_json::from_slice::<Value>(&request.body).unwrap()["model"],
                "model-1"
            );
            write_response(&mut stream, 200, &json!({"id":"resp-1"})).unwrap();
        });
        let root = std::env::temp_dir().join(format!("cksw-forward-{}", uuid::Uuid::new_v4()));
        let store = PreviewStore::new(root.clone());
        let secrets = MemorySecrets(Mutex::new(HashMap::new()));
        let input = serde_json::from_value(json!({
            "id":"one", "name":"Example", "baseURL":format!("http://{upstream_address}/v1"),
            "apiFormat":"responses", "apiKey":"synthetic-upstream-key",
            "models":[{"customName":"Selected", "model":"model-1"}], "selectedModel":"Selected"
        }))
        .unwrap();
        crate::providers::save_provider(&store, &secrets, input).unwrap();
        let token = store.local_gateway_api_key().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let gateway_address = listener.local_addr().unwrap();
        let valid_token = token.clone();
        let work = thread::spawn(move || {
            for _ in 0..3 {
                let (stream, _) = listener.accept().unwrap();
                handle_connection(stream, &token, &store, &secrets).unwrap();
            }
        });
        let send = |authorization: &str, model: &str| {
            let body = json!({"model":model,"input":"hello","stream":false}).to_string();
            let mut stream = TcpStream::connect(gateway_address).unwrap();
            write!(stream, "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {authorization}\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };
        assert!(send("bad-token", "model-1").starts_with("HTTP/1.1 401"));
        assert!(send(&valid_token, "different-model").starts_with("HTTP/1.1 400"));
        let success = send(&valid_token, "model-1");
        assert!(success.starts_with("HTTP/1.1 200"));
        assert!(success.contains("\"id\":\"resp-1\""));
        work.join().unwrap();
        join.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn isolated_gateway_state_runs_request_records_usage_and_survives_reopen() {
        use std::{collections::HashMap, sync::Mutex};
        struct MemorySecrets(Mutex<HashMap<String, String>>);
        impl SecretBackend for MemorySecrets {
            fn set(&self, id: &str, value: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().insert(id.into(), value.into());
                Ok(())
            }
            fn get(&self, id: &str) -> Result<Option<String>, CommandError> {
                Ok(self.0.lock().unwrap().get(id).cloned())
            }
            fn delete(&self, id: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().remove(id);
                Ok(())
            }
        }

        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let upstream_worker = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let request = read_http_request(&mut stream).unwrap();
            assert_eq!(
                request.authorization.as_deref(),
                Some("preview-upstream-key")
            );
            write_response(
                &mut stream,
                200,
                &json!({"id":"isolated-response","usage":{"input_tokens":4,"output_tokens":2}}),
            )
            .unwrap();
        });

        let root = std::env::temp_dir().join(format!(
            "cksw-isolated-gateway-e2e-{}",
            uuid::Uuid::new_v4()
        ));
        let store = PreviewStore::new(root.clone());
        let secrets = MemorySecrets(Mutex::new(HashMap::new()));
        let input = serde_json::from_value(json!({
            "id":"e2e-provider",
            "name":"E2E Provider",
            "baseURL":format!("http://{upstream_address}/v1"),
            "apiFormat":"responses",
            "apiKey":"preview-upstream-key",
            "models":[{"customName":"E2E Model","model":"e2e-model"}],
            "selectedModel":"E2E Model"
        }))
        .unwrap();
        crate::providers::save_provider(&store, &secrets, input).unwrap();
        crate::providers::set_current_provider(&store, &secrets, "e2e-provider").unwrap();
        store
            .update_settings([
                (
                    "usageSettings".into(),
                    json!("{\"enabled\":true,\"retentionDays\":30,\"maxRecords\":1000}"),
                ),
                (
                    "routeSettings".into(),
                    json!({"failoverEnabled":false,"failoverMaxAttempts":1,"failoverTotalTimeoutMs":10000}),
                ),
            ])
            .unwrap();

        let state = GatewayState::default();
        let status = state.start_with_backend(&store, secrets).unwrap();
        assert_eq!(status["currentProviderName"], "E2E Provider");
        let endpoint = status["endpoint"].as_str().unwrap();
        let address = endpoint
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let token = store.local_gateway_api_key().unwrap();
        let body = json!({"model":"e2e-model","input":"hello","stream":false}).to_string();
        let mut client = TcpStream::connect(address).unwrap();
        write!(
            client,
            "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("isolated-response"));
        state.stop(&store).unwrap();
        upstream_worker.join().unwrap();

        let stats = crate::usage::read_stats(
            &store.usage_database_path(),
            crate::commands::UsageStatsInput {
                log_page: 1,
                log_page_size: 10,
            },
        )
        .unwrap();
        assert_eq!(stats["logs"]["total"], 1);
        assert_eq!(stats["summary"]["totalTokens"], 6);
        let reopened = PreviewStore::new(root.clone());
        assert_eq!(
            reopened.current_provider_id().unwrap().as_deref(),
            Some("e2e-provider")
        );
        assert_eq!(
            reopened.list_providers().unwrap()[0]["name"],
            "E2E Provider"
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn mock_tool_events(commands: &[(&str, &str)]) -> String {
        let mut events = format!(
            "event: response.created\ndata: {}\n\n",
            json!({"type":"response.created","response":{"id":"resp-tool-qa","status":"in_progress","output":[]}})
        );
        let mut output = Vec::new();
        for (index, (id, command)) in commands.iter().enumerate() {
            let item_id = format!("fc-{id}");
            let call_id = format!("call-{id}");
            let arguments = json!({"cmd":command,"login":false}).to_string();
            let call = json!({"id":item_id,"type":"function_call","status":"completed",
                "call_id":call_id,"name":"exec_command","arguments":arguments});
            events.push_str(&format!(
                "event: response.output_item.added\ndata: {}\n\n\
                 event: response.function_call_arguments.delta\ndata: {}\n\n\
                 event: response.function_call_arguments.done\ndata: {}\n\n\
                 event: response.output_item.done\ndata: {}\n\n",
                json!({"type":"response.output_item.added","output_index":index,"item":{"id":item_id,"type":"function_call","status":"in_progress","call_id":call_id,"name":"exec_command","arguments":""}}),
                json!({"type":"response.function_call_arguments.delta","item_id":item_id,"output_index":index,"delta":arguments}),
                json!({"type":"response.function_call_arguments.done","item_id":item_id,"output_index":index,"arguments":arguments}),
                json!({"type":"response.output_item.done","output_index":index,"item":call.clone()}),
            ));
            output.push(call);
        }
        events.push_str(&format!(
            "event: response.completed\ndata: {}\n\ndata: [DONE]\n\n",
            json!({"type":"response.completed","response":{"id":"resp-tool-qa","object":"response","status":"completed","model":"upstream-model","output":output,"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}})
        ));
        events
    }

    #[test]
    fn codex_app_server_turn_flows_through_isolated_gateway_when_available() {
        use base64::Engine as _;
        use std::{collections::HashMap, path::Path, process::Command, sync::atomic::AtomicU8};

        let Ok(binary) = std::env::var("CODEX_BINARY") else {
            return;
        };
        if std::env::var_os("CODEX_TURN_SMOKE").is_none() {
            return;
        }

        struct MemorySecrets(Mutex<HashMap<String, String>>);
        impl SecretBackend for MemorySecrets {
            fn set(&self, id: &str, value: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().insert(id.into(), value.into());
                Ok(())
            }
            fn get(&self, id: &str) -> Result<Option<String>, CommandError> {
                Ok(self.0.lock().unwrap().get(id).cloned())
            }
            fn delete(&self, id: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().remove(id);
                Ok(())
            }
        }

        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        upstream.set_nonblocking(true).unwrap();
        let stop_upstream = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop_upstream);
        let phase = Arc::new(AtomicU8::new(0));
        let worker_phase = Arc::clone(&phase);
        let upstream_worker = thread::spawn(move || {
            let mut attempts = 0;
            let mut tool_attempts = 0;
            let mut parallel_attempts = 0;
            let mut multi_turn_attempts = 0;
            let mut image_attempts = 0;
            let mut image_history_attempts = 0;
            let mut multi_image_attempts = 0;
            while !worker_stop.load(Ordering::Relaxed) {
                let (mut stream, _) = match upstream.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(error) => panic!("mock upstream accept failed: {error}"),
                };
                stream.set_nonblocking(false).unwrap();
                let request = read_http_request(&mut stream).unwrap();
                assert_eq!(
                    request.authorization.as_deref(),
                    Some("synthetic-upstream-key")
                );
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                assert_eq!(body["model"], "upstream-model");
                assert_eq!(body["stream"], true);
                attempts += 1;
                let mode = worker_phase.load(Ordering::Relaxed);
                if mode == 2 {
                    tool_attempts += 1;
                    if tool_attempts == 2 {
                        assert!(body["input"]
                            .as_array()
                            .is_some_and(|items| items.iter().any(|item| item["type"]
                                == "function_call_output"
                                && item["call_id"] == "call-cksw-qa"
                                && item["output"]
                                    .as_str()
                                    .is_some_and(|output| output.contains("cksw-turn-qa-")))));
                    }
                }
                if mode == 3 {
                    parallel_attempts += 1;
                    if parallel_attempts == 2 {
                        let input = body["input"].as_array().unwrap();
                        for (call_id, expected) in [
                            ("call-cksw-par-a", "cksw-turn-qa-"),
                            ("call-cksw-par-b", "parallel-ok"),
                        ] {
                            assert!(input.iter().any(|item| {
                                item["type"] == "function_call_output"
                                    && item["call_id"] == call_id
                                    && item["output"]
                                        .as_str()
                                        .is_some_and(|output| output.contains(expected))
                            }));
                        }
                    }
                }
                if mode == 4 {
                    multi_turn_attempts += 1;
                    if multi_turn_attempts == 2 {
                        let history = body["input"].as_array().unwrap();
                        assert!(history
                            .iter()
                            .any(|item| item.to_string().contains("Remember the code ORBIT-42")));
                        assert!(history.iter().any(|item| item["role"] == "assistant"
                            && item.to_string().contains("ORBIT-42")));
                        assert!(history.iter().any(|item| item
                            .to_string()
                            .contains("Recall the code from my previous message")));
                    }
                }
                if matches!(mode, 5 | 6 | 7) {
                    if mode == 5 {
                        image_attempts += 1;
                    } else if mode == 6 {
                        image_history_attempts += 1;
                    } else {
                        multi_image_attempts += 1;
                    }
                    let images: Vec<_> = body["input"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|item| item["role"] == "user")
                        .flat_map(|item| item["content"].as_array().into_iter().flatten())
                        .filter(|part| part["type"] == "input_image")
                        .collect();
                    assert_eq!(images.len(), if mode == 7 { 2 } else { 1 });
                    let decode = |image: &Value| {
                        let image_url = image["image_url"].as_str().unwrap();
                        let encoded = image_url.strip_prefix("data:image/png;base64,").unwrap();
                        base64::engine::general_purpose::STANDARD
                            .decode(encoded)
                            .unwrap()
                    };
                    assert_eq!(
                        decode(images[0]),
                        include_bytes!("../../../web/public/icon.png")
                    );
                    if mode == 7 {
                        let expected = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OIQEAAAgDMDIQnnR0gRg3E/Ornr2kEhAQEBAQEBAQEBAQEBAQSAcedREMl6dDV/oAAAAASUVORK5CYII=").unwrap();
                        assert_eq!(decode(images[1]), expected);
                    }
                    if mode == 6 && image_history_attempts == 2 {
                        let history = body["input"].as_array().unwrap();
                        assert!(history.iter().any(|item| item["role"] == "user"
                            && item.to_string().contains("Inspect these test images.")));
                        assert!(history.iter().any(|item| item["role"] == "assistant"
                            && item.to_string().contains("IMAGE-SEEN")));
                        assert!(history.iter().any(|item| item["role"] == "user"
                            && item
                                .to_string()
                                .contains("Recall the image from my previous message.")));
                    }
                    if mode == 7 && multi_image_attempts == 2 {
                        let history = body["input"].as_array().unwrap();
                        assert!(history.iter().any(|item| item["role"] == "user"
                            && item.to_string().contains("Inspect these test images.")));
                        assert!(history.iter().any(|item| item["role"] == "assistant"
                            && item.to_string().contains("TWO-IMAGES-SEEN")));
                        assert!(history.iter().any(|item| item["role"] == "user"
                            && item
                                .to_string()
                                .contains("Recall both images in their original order.")));
                    }
                }

                let events = if mode == 2 && tool_attempts == 1 {
                    mock_tool_events(&[("cksw-qa", "pwd")])
                } else if mode == 3 && parallel_attempts == 1 {
                    mock_tool_events(&[("cksw-par-a", "pwd"), ("cksw-par-b", "printf parallel-ok")])
                } else if matches!(mode, 0 | 2 | 3 | 4 | 5 | 6 | 7) {
                    let reply = if mode == 4 {
                        if multi_turn_attempts == 1 {
                            "ORBIT-42"
                        } else {
                            "RECALLED ORBIT-42"
                        }
                    } else if mode == 6 {
                        if image_history_attempts == 1 {
                            "IMAGE-SEEN"
                        } else {
                            "IMAGE-RECALLED"
                        }
                    } else if mode == 7 {
                        if multi_image_attempts == 1 {
                            "TWO-IMAGES-SEEN"
                        } else {
                            "TWO-IMAGES-RECALLED"
                        }
                    } else {
                        "OK"
                    };
                    let output = json!({"id":"msg-gateway-qa","type":"message","role":"assistant",
                        "status":"completed","content":[{"type":"output_text","text":reply,"annotations":[]}]});
                    let completed = json!({"id":"resp-gateway-qa","object":"response","status":"completed",
                        "model":"upstream-model","output":[output],
                        "usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}});
                    format!(
                        "event: response.created\ndata: {}\n\n\
                 event: response.output_item.added\ndata: {}\n\n\
                 event: response.content_part.added\ndata: {}\n\n\
                 event: response.output_text.delta\ndata: {}\n\n\
                 event: response.output_text.done\ndata: {}\n\n\
                 event: response.content_part.done\ndata: {}\n\n\
                 event: response.output_item.done\ndata: {}\n\n\
                 event: response.completed\ndata: {}\n\n\
                 data: [DONE]\n\n",
                        json!({"type":"response.created","response":{"id":"resp-gateway-qa","status":"in_progress","output":[]}}),
                        json!({"type":"response.output_item.added","output_index":0,"item":{"id":"msg-gateway-qa","type":"message","role":"assistant","status":"in_progress","content":[]}}),
                        json!({"type":"response.content_part.added","item_id":"msg-gateway-qa","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}),
                        json!({"type":"response.output_text.delta","item_id":"msg-gateway-qa","output_index":0,"content_index":0,"delta":reply}),
                        json!({"type":"response.output_text.done","item_id":"msg-gateway-qa","output_index":0,"content_index":0,"text":reply}),
                        json!({"type":"response.content_part.done","item_id":"msg-gateway-qa","output_index":0,"content_index":0,"part":{"type":"output_text","text":reply,"annotations":[]}}),
                        json!({"type":"response.output_item.done","output_index":0,"item":completed["output"][0]}),
                        json!({"type":"response.completed","response":completed}),
                    )
                } else {
                    format!(
                        "event: response.created\ndata: {}\n\n\
                         event: response.failed\ndata: {}\n\n\
                         data: [DONE]\n\n",
                        json!({"type":"response.created","response":{"id":"resp-failed-qa","status":"in_progress","output":[]}}),
                        json!({"type":"response.failed","response":{"id":"resp-failed-qa","object":"response","status":"failed","output":[],"error":{"code":"synthetic_failure","message":"Synthetic upstream failure"}}}),
                    )
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", events.len()).unwrap();
                stream.write_all(events.as_bytes()).unwrap();
            }
            (
                attempts,
                parallel_attempts,
                multi_turn_attempts,
                image_attempts,
                image_history_attempts,
                multi_image_attempts,
            )
        });

        let root =
            std::env::temp_dir().join(format!("cksw-app-server-gateway-{}", uuid::Uuid::new_v4()));
        let store = PreviewStore::new(root.clone());
        let secrets = MemorySecrets(Mutex::new(HashMap::new()));
        let input = serde_json::from_value(json!({
            "id":"gateway-qa","name":"Gateway QA",
            "baseURL":format!("http://{upstream_address}/v1"),
            "apiFormat":"responses","apiKey":"synthetic-upstream-key",
            "models":[{"customName":"QA Model","model":"upstream-model"}],
            "selectedModel":"QA Model"
        }))
        .unwrap();
        crate::providers::save_provider(&store, &secrets, input).unwrap();
        crate::providers::set_current_provider(&store, &secrets, "gateway-qa").unwrap();
        let codex = crate::codex::CodexState::new(root.clone());
        codex.prepare_sandbox(&store).unwrap();
        let state = GatewayState::default();
        let status = state.start_with_backend(&store, secrets).unwrap();
        let endpoint = status["endpoint"].as_str().unwrap();
        let token = store.local_gateway_api_key().unwrap();
        codex.sync_gateway(&store, endpoint, &token).unwrap();
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/verify-codex-turn.mjs");
        let result = Command::new("node")
            .arg(&script)
            .arg(root.join("model-catalogs/current.json"))
            .arg(endpoint)
            .arg(&token)
            .env("CODEX_BINARY", &binary)
            .output()
            .unwrap();
        phase.store(1, Ordering::Relaxed);
        let failed = Command::new("node")
            .arg(&script)
            .arg(root.join("model-catalogs/current.json"))
            .arg(endpoint)
            .arg(&token)
            .env("CODEX_BINARY", &binary)
            .env("CODEX_TURN_SCENARIO", "failed")
            .output()
            .unwrap();
        phase.store(2, Ordering::Relaxed);
        let tool_call = Command::new("node")
            .arg(&script)
            .arg(root.join("model-catalogs/current.json"))
            .arg(endpoint)
            .arg(&token)
            .env("CODEX_BINARY", &binary)
            .env("CODEX_TURN_SCENARIO", "tool_call")
            .output()
            .unwrap();
        phase.store(3, Ordering::Relaxed);
        let parallel = Command::new("node")
            .arg(&script)
            .arg(root.join("model-catalogs/current.json"))
            .arg(endpoint)
            .arg(&token)
            .env("CODEX_BINARY", &binary)
            .env("CODEX_TURN_SCENARIO", "parallel_tool_calls")
            .output()
            .unwrap();
        phase.store(4, Ordering::Relaxed);
        let multi_turn = Command::new("node")
            .arg(&script)
            .arg(root.join("model-catalogs/current.json"))
            .arg(endpoint)
            .arg(&token)
            .env("CODEX_BINARY", &binary)
            .env("CODEX_TURN_SCENARIO", "multi_turn")
            .output()
            .unwrap();
        phase.store(5, Ordering::Relaxed);
        let image_input = Command::new("node")
            .arg(&script)
            .arg(root.join("model-catalogs/current.json"))
            .arg(endpoint)
            .arg(&token)
            .env("CODEX_BINARY", &binary)
            .env("CODEX_TURN_SCENARIO", "image_input")
            .output()
            .unwrap();
        phase.store(6, Ordering::Relaxed);
        let image_history = Command::new("node")
            .arg(&script)
            .arg(root.join("model-catalogs/current.json"))
            .arg(endpoint)
            .arg(&token)
            .env("CODEX_BINARY", &binary)
            .env("CODEX_TURN_SCENARIO", "image_history")
            .output()
            .unwrap();
        phase.store(7, Ordering::Relaxed);
        let multi_image_history = Command::new("node")
            .arg(&script)
            .arg(root.join("model-catalogs/current.json"))
            .arg(endpoint)
            .arg(&token)
            .env("CODEX_BINARY", &binary)
            .env("CODEX_TURN_SCENARIO", "multi_image_history")
            .output()
            .unwrap();
        state.stop(&store).unwrap();
        codex.restore(&store).unwrap();
        stop_upstream.store(true, Ordering::Relaxed);
        assert!(
            result.status.success(),
            "app-server gateway turn failed: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(
            failed.status.success(),
            "app-server gateway failure turn failed: {} {}",
            String::from_utf8_lossy(&failed.stdout),
            String::from_utf8_lossy(&failed.stderr)
        );
        assert!(
            tool_call.status.success(),
            "app-server gateway tool turn failed: {} {}",
            String::from_utf8_lossy(&tool_call.stdout),
            String::from_utf8_lossy(&tool_call.stderr)
        );
        assert!(
            parallel.status.success(),
            "app-server gateway parallel tools failed: {} {}",
            String::from_utf8_lossy(&parallel.stdout),
            String::from_utf8_lossy(&parallel.stderr)
        );
        assert!(
            multi_turn.status.success(),
            "app-server gateway multi-turn failed: {} {}",
            String::from_utf8_lossy(&multi_turn.stdout),
            String::from_utf8_lossy(&multi_turn.stderr)
        );
        assert!(
            image_input.status.success(),
            "app-server gateway image input failed: {} {}",
            String::from_utf8_lossy(&image_input.stdout),
            String::from_utf8_lossy(&image_input.stderr)
        );
        assert!(
            image_history.status.success(),
            "app-server gateway image history failed: {} {}",
            String::from_utf8_lossy(&image_history.stdout),
            String::from_utf8_lossy(&image_history.stderr)
        );
        assert!(
            multi_image_history.status.success(),
            "app-server gateway multi-image history failed: {} {}",
            String::from_utf8_lossy(&multi_image_history.stdout),
            String::from_utf8_lossy(&multi_image_history.stderr)
        );
        let (
            attempts,
            parallel_attempts,
            multi_turn_attempts,
            image_attempts,
            image_history_attempts,
            multi_image_attempts,
        ) = upstream_worker.join().unwrap();
        assert!(attempts >= 13);
        assert_eq!(parallel_attempts, 2);
        assert_eq!(multi_turn_attempts, 2);
        assert_eq!(image_attempts, 1);
        assert_eq!(image_history_attempts, 2);
        assert_eq!(multi_image_attempts, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authenticated_gateway_fails_over_with_mapped_model_and_records_attempts() {
        use std::collections::HashMap;
        struct MemorySecrets(Mutex<HashMap<String, String>>);
        impl SecretBackend for MemorySecrets {
            fn set(&self, id: &str, value: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().insert(id.into(), value.into());
                Ok(())
            }
            fn get(&self, id: &str) -> Result<Option<String>, CommandError> {
                Ok(self.0.lock().unwrap().get(id).cloned())
            }
            fn delete(&self, id: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().remove(id);
                Ok(())
            }
        }

        let primary_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let primary_address = primary_listener.local_addr().unwrap();
        let primary_worker = thread::spawn(move || {
            let (mut stream, _) = primary_listener.accept().unwrap();
            let request = read_http_request(&mut stream).unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&request.body).unwrap()["model"],
                "primary-model"
            );
            write_response(&mut stream, 503, &json!({ "error": "primary unavailable" })).unwrap();
        });

        let backup_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let backup_address = backup_listener.local_addr().unwrap();
        let backup_worker = thread::spawn(move || {
            let (mut stream, _) = backup_listener.accept().unwrap();
            let request = read_http_request(&mut stream).unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&request.body).unwrap()["model"],
                "backup-model"
            );
            write_response(
                &mut stream,
                200,
                &json!({"id":"backup-response","usage":{"input_tokens":2,"output_tokens":3}}),
            )
            .unwrap();
        });

        let root = std::env::temp_dir().join(format!("cksw-failover-{}", uuid::Uuid::new_v4()));
        let store = PreviewStore::new(root.clone());
        let secrets = MemorySecrets(Mutex::new(HashMap::new()));
        for (id, name, base_url, model, mapping, priority) in [
            (
                "primary",
                "Primary",
                format!("http://{primary_address}/v1"),
                "primary-model",
                json!({}),
                100,
            ),
            (
                "backup",
                "Backup",
                format!("http://{backup_address}/v1"),
                "backup-model",
                json!({"primary-model":"Backup"}),
                10,
            ),
        ] {
            let input = serde_json::from_value(json!({
                "id": id,
                "name": name,
                "baseURL": base_url,
                "apiFormat": "responses",
                "apiKey": format!("{id}-key"),
                "models": if id == "backup" {
                    json!([{"customName":"Backup","model":model}])
                } else {
                    json!([{"customName":"Primary","model":model}])
                },
                "selectedModel": if id == "backup" { "Backup" } else { "Primary" },
                "failover": {"enabled": true, "priority": priority, "modelMappings": mapping}
            }))
            .unwrap();
            crate::providers::save_provider(&store, &secrets, input).unwrap();
        }
        crate::providers::set_current_provider(&store, &secrets, "primary").unwrap();
        store
            .update_settings([
                (
                    "usageSettings".into(),
                    json!("{\"enabled\":true,\"retentionDays\":30,\"maxRecords\":1000}"),
                ),
                (
                    "routeSettings".into(),
                    json!({"failoverEnabled":true,"failoverMaxAttempts":3,"failoverTotalTimeoutMs":10000}),
                ),
            ])
            .unwrap();

        let token = store.local_gateway_api_key().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let gateway_address = listener.local_addr().unwrap();
        let request_store = PreviewStore::new(root.clone());
        let request_token = token.clone();
        let request_backend = secrets;
        let worker = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle_connection(stream, &request_token, &request_store, &request_backend).unwrap();
        });
        let body = json!({"model":"primary-model","input":"hello","stream":false}).to_string();
        let mut client = TcpStream::connect(gateway_address).unwrap();
        write!(
            client,
            "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("backup-response"));
        worker.join().unwrap();
        primary_worker.join().unwrap();
        backup_worker.join().unwrap();

        let stats = crate::usage::read_stats(
            &store.usage_database_path(),
            crate::commands::UsageStatsInput {
                log_page: 1,
                log_page_size: 10,
            },
        )
        .unwrap();
        assert_eq!(stats["logs"]["total"], 2);
        let records = stats["logs"]["records"].as_array().unwrap();
        assert_eq!(records[0]["attempt"], 2);
        assert_eq!(records[0]["finalAttempt"], true);
        assert_eq!(records[1]["attempt"], 1);
        assert_eq!(records[1]["finalAttempt"], false);
        assert_eq!(records[1]["errorCategory"], "upstream_5xx");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn slow_upstream_does_not_block_health_requests() {
        use std::collections::HashMap;
        struct MemorySecrets(Mutex<HashMap<String, String>>);
        impl SecretBackend for MemorySecrets {
            fn set(&self, id: &str, value: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().insert(id.into(), value.into());
                Ok(())
            }
            fn get(&self, id: &str) -> Result<Option<String>, CommandError> {
                Ok(self.0.lock().unwrap().get(id).cloned())
            }
            fn delete(&self, id: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().remove(id);
                Ok(())
            }
        }
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = upstream.local_addr().unwrap();
        let release = Arc::new(std::sync::Barrier::new(2));
        let release_upstream = Arc::clone(&release);
        let upstream_worker = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let _ = read_http_request(&mut stream).unwrap();
            release_upstream.wait();
            write_response(&mut stream, 200, &json!({"id":"slow-done"})).unwrap();
        });
        let root = std::env::temp_dir().join(format!("cksw-concurrency-{}", uuid::Uuid::new_v4()));
        let store = PreviewStore::new(root.clone());
        let secrets = MemorySecrets(Mutex::new(HashMap::new()));
        let input = serde_json::from_value(json!({
            "id":"one", "name":"Example", "baseURL":format!("http://{address}/v1"),
            "apiFormat":"responses", "apiKey":"slow-key",
            "models":[{"customName":"Selected", "model":"model-1"}], "selectedModel":"Selected"
        }))
        .unwrap();
        crate::providers::save_provider(&store, &secrets, input).unwrap();
        let token = store.local_gateway_api_key().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let gateway_address = listener.local_addr().unwrap();
        let worker_store = PreviewStore::new(root.clone());
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker_token = token.clone();
        let gateway_worker = thread::spawn(move || {
            serve(listener, worker_stop, worker_token, worker_store, secrets)
        });
        thread::sleep(Duration::from_millis(20));
        let body = br#"{"model":"model-1","input":"slow"}"#;
        let mut slow = TcpStream::connect(gateway_address).unwrap();
        write!(slow, "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n", body.len()).unwrap();
        slow.write_all(body).unwrap();
        thread::sleep(Duration::from_millis(80));
        let mut health = TcpStream::connect(gateway_address).unwrap();
        health
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write!(health, "GET /__health HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let mut output = String::new();
        health.read_to_string(&mut output).unwrap();
        assert!(output.starts_with("HTTP/1.1 200"));
        release.wait();
        let mut slow_output = String::new();
        slow.read_to_string(&mut slow_output).unwrap();
        assert!(slow_output.contains("slow-done"));
        upstream_worker.join().unwrap();
        stop.store(true, Ordering::Release);
        gateway_worker.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_connections_when_active_request_limit_is_reached() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let root = std::env::temp_dir().join(format!("cksw-busy-{}", uuid::Uuid::new_v4()));
        let store = PreviewStore::new(root.clone());
        let token = store.local_gateway_api_key().unwrap();
        let worker = thread::spawn(move || {
            serve(listener, worker_stop, token, store, SystemKeyring);
        });
        let mut sockets = Vec::new();
        for _ in 0..MAX_ACTIVE_CONNECTIONS {
            let mut socket = TcpStream::connect(address).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            socket
                .write_all(b"GET /__health HTTP/1.1\r\nHost: localhost\r\n")
                .unwrap();
            sockets.push(socket);
        }
        thread::sleep(Duration::from_millis(80));
        let mut rejected = TcpStream::connect(address).unwrap();
        rejected
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        rejected
            .write_all(b"GET /__health HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut output = String::new();
        let rejected_result = rejected.read_to_string(&mut output);
        assert!(rejected_result.is_err() || output.starts_with("HTTP/1.1 503"));
        stop.store(true, Ordering::Release);
        for socket in sockets {
            drop(socket);
        }
        worker.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authenticated_gateway_records_usage_without_storing_request_content() {
        use std::collections::HashMap;
        struct MemorySecrets(Mutex<HashMap<String, String>>);
        impl SecretBackend for MemorySecrets {
            fn set(&self, id: &str, value: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().insert(id.into(), value.into());
                Ok(())
            }
            fn get(&self, id: &str) -> Result<Option<String>, CommandError> {
                Ok(self.0.lock().unwrap().get(id).cloned())
            }
            fn delete(&self, id: &str) -> Result<(), CommandError> {
                self.0.lock().unwrap().remove(id);
                Ok(())
            }
        }
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = upstream.local_addr().unwrap();
        let upstream_worker = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let _request = read_http_request(&mut stream).unwrap();
            write_response(&mut stream, 200, &json!({"id":"usage-response","usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":2}}})).unwrap();
        });
        let root =
            std::env::temp_dir().join(format!("cksw-usage-gateway-{}", uuid::Uuid::new_v4()));
        let store = PreviewStore::new(root.clone());
        let secrets = MemorySecrets(Mutex::new(HashMap::new()));
        let input = serde_json::from_value(json!({
            "id":"one", "name":"Usage Provider", "baseURL":format!("http://{address}/v1"),
            "apiFormat":"responses", "apiKey":"synthetic-key",
            "models":[{"customName":"Selected", "model":"model-usage"}], "selectedModel":"Selected"
        }))
        .unwrap();
        crate::providers::save_provider(&store, &secrets, input).unwrap();
        store
            .update_settings([(
                "usageSettings".into(),
                json!("{\"enabled\":true,\"retentionDays\":30,\"maxRecords\":1000}"),
            )])
            .unwrap();
        let token = store.local_gateway_api_key().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let client_address = listener.local_addr().unwrap();
        let request_store = PreviewStore::new(root.clone());
        let worker = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle_connection(stream, &token, &request_store, &secrets).unwrap();
        });
        let body = json!({"model":"model-usage","input":"never-store-this-secret","stream":false})
            .to_string();
        let mut client = TcpStream::connect(client_address).unwrap();
        write!(client, "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n{body}", store.local_gateway_api_key().unwrap(), body.len()).unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        worker.join().unwrap();
        upstream_worker.join().unwrap();
        let stats = crate::usage::read_stats(
            &store.usage_database_path(),
            crate::commands::UsageStatsInput {
                log_page: 1,
                log_page_size: 10,
            },
        )
        .unwrap();
        assert_eq!(stats["summary"]["totalRequests"], 1);
        assert_eq!(stats["summary"]["inputTokens"], 10);
        assert_eq!(stats["summary"]["outputTokens"], 4);
        assert_eq!(stats["summary"]["cachedTokens"], 2);
        let database_bytes = fs::read(store.usage_database_path()).unwrap();
        assert!(!database_bytes
            .windows(b"never-store-this-secret".len())
            .any(|window| window == b"never-store-this-secret"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disabled_gateway_usage_does_not_create_sqlite() {
        let root =
            std::env::temp_dir().join(format!("cksw-usage-disabled-{}", uuid::Uuid::new_v4()));
        let store = PreviewStore::new(root.clone());
        store.ensure_preview_directory().unwrap();
        let provider = GatewayProvider {
            id: "id".into(),
            name: "provider".into(),
            base_url: "https://example.com/v1".into(),
            model: "model".into(),
            api_key: "secret".into(),
            api_format: "responses".into(),
        };
        record_gateway_usage(
            &store,
            &provider,
            "request",
            "model".into(),
            200,
            Duration::from_millis(10),
            None,
            None,
            1,
            false,
            true,
        );
        assert!(!store.usage_database_path().exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sse_usage_and_response_model_are_written_to_sqlite() {
        let root = std::env::temp_dir().join(format!("cksw-sse-usage-{}", uuid::Uuid::new_v4()));
        let store = PreviewStore::new(root.clone());
        store.ensure_preview_directory().unwrap();
        store
            .update_settings([(
                "usageSettings".into(),
                json!("{\"enabled\":true,\"retentionDays\":30,\"maxRecords\":1000}"),
            )])
            .unwrap();
        let provider = GatewayProvider {
            id: "id".into(),
            name: "SSE provider".into(),
            base_url: "https://example.test/v1".into(),
            model: "selected-model".into(),
            api_key: "synthetic-key".into(),
            api_format: "responses".into(),
        };
        let mut adapter = NativeSseAdapter::new("selected-model");
        let events = br#"event: response.completed
data: {"type":"response.completed","response":{"id":"resp-sse","model":"upstream-model","status":"completed","usage":{"input_tokens":13,"output_tokens":5,"input_tokens_details":{"cached_tokens":4}}}}

"#;
        for chunk in events.chunks(7) {
            adapter.process_chunk(chunk);
        }
        adapter.finish();
        record_gateway_usage(
            &store,
            &provider,
            "request-sse",
            adapter.response_model().unwrap(),
            200,
            Duration::from_millis(42),
            adapter.usage(),
            None,
            1,
            false,
            true,
        );
        let stats = crate::usage::read_stats(
            &store.usage_database_path(),
            crate::commands::UsageStatsInput {
                log_page: 1,
                log_page_size: 5,
            },
        )
        .unwrap();
        assert_eq!(stats["summary"]["inputTokens"], 13);
        assert_eq!(stats["summary"]["outputTokens"], 5);
        assert_eq!(stats["summary"]["cachedTokens"], 4);
        assert_eq!(stats["logs"]["records"][0]["model"], "upstream-model");
        assert_eq!(stats["logs"]["records"][0]["requestId"], "request-sse");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn client_disconnect_cancels_an_inflight_upstream_request() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = upstream.local_addr().unwrap();
        let upstream_seen = Arc::new(std::sync::Barrier::new(2));
        let upstream_seen_worker = Arc::clone(&upstream_seen);
        let upstream_worker = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let _ = read_http_request(&mut stream).unwrap();
            upstream_seen_worker.wait();
            let mut buffer = [0_u8; 1];
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let _ = stream.read(&mut buffer);
        });

        let client_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let client_address = client_listener.local_addr().unwrap();
        let client_worker = thread::spawn(move || {
            let (server_side, _) = client_listener.accept().unwrap();
            server_side
        });
        let client = TcpStream::connect(client_address).unwrap();
        let monitor = client.try_clone().unwrap();
        let server_side = client_worker.join().unwrap();
        let provider = GatewayProvider {
            id: "test-provider".into(),
            name: "Test Provider".into(),
            base_url: format!("http://{address}/v1"),
            model: "model-1".into(),
            api_key: "synthetic-upstream-key".into(),
            api_format: "responses".into(),
        };
        let forward = thread::spawn(move || {
            forward_responses_with_cancellation(
                Some(&provider),
                br#"{"model":"model-1","input":"slow"}"#,
                monitor,
            )
        });
        upstream_seen.wait();
        drop(client);
        drop(server_side);
        let result = forward.join().unwrap();
        assert!(matches!(result, Err(ForwardFailure::ClientDisconnected)));
        upstream_worker.join().unwrap();
    }

    #[test]
    fn forwards_native_responses_sse_chunks_with_event_stream_headers() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = upstream.local_addr().unwrap();
        let upstream_worker = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let request = read_http_request(&mut stream).unwrap();
            assert_eq!(request.authorization.as_deref(), Some("sse-key"));
            let first = b"event: response.created\ndata: {\"type\":\"response.created\"}\n\n";
            let second = b"event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n";
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", first.len() + second.len()).unwrap();
            stream.write_all(first).unwrap();
            thread::sleep(Duration::from_millis(30));
            stream.write_all(second).unwrap();
        });
        let client_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let client_address = client_listener.local_addr().unwrap();
        let client_worker = thread::spawn(move || client_listener.accept().unwrap().0);
        let client = TcpStream::connect(client_address).unwrap();
        let server_side = client_worker.join().unwrap();
        let monitor = server_side.try_clone().unwrap();
        let provider = GatewayProvider {
            id: "test-provider".into(),
            name: "Test Provider".into(),
            base_url: format!("http://{address}/v1"),
            model: "model-1".into(),
            api_key: "sse-key".into(),
            api_format: "responses".into(),
        };
        let worker = thread::spawn(move || {
            forward_responses_stream_with_cancellation(
                Some(&provider),
                br#"{"model":"model-1","stream":true}"#,
                server_side,
                monitor,
            )
        });
        let mut output = String::new();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut client_reader = client.try_clone().unwrap();
        client_reader.read_to_string(&mut output).unwrap();
        assert!(output.starts_with("HTTP/1.1 200 OK"));
        assert!(output.contains("Content-Type: text/event-stream"));
        assert!(output.contains("response.created"));
        assert!(output.contains("response.completed"));
        assert!(matches!(worker.join().unwrap(), Ok(outcome) if outcome.status == 200));
        upstream_worker.join().unwrap();
    }

    #[test]
    fn truncated_native_sse_emits_response_failed_not_completed() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = upstream.local_addr().unwrap();
        let upstream_worker = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            let _ = read_http_request(&mut stream).unwrap();
            let event = b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-original\"}}\n\n";
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", event.len()).unwrap();
            stream.write_all(event).unwrap();
        });
        let client_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address_client = client_listener.local_addr().unwrap();
        let client_worker = thread::spawn(move || client_listener.accept().unwrap().0);
        let client = TcpStream::connect(address_client).unwrap();
        let server_side = client_worker.join().unwrap();
        let monitor = server_side.try_clone().unwrap();
        let provider = GatewayProvider {
            id: "test-provider".into(),
            name: "Test Provider".into(),
            base_url: format!("http://{address}/v1"),
            model: "model-1".into(),
            api_key: "sse-key".into(),
            api_format: "responses".into(),
        };
        let worker = thread::spawn(move || {
            forward_responses_stream_with_cancellation(
                Some(&provider),
                br#"{"model":"model-1","stream":true}"#,
                server_side,
                monitor,
            )
        });
        let mut output = String::new();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = client.try_clone().unwrap();
        reader.read_to_string(&mut output).unwrap();
        assert!(output.contains("response.created"));
        assert!(output.contains("response.failed"));
        assert!(!output.contains("response.completed"));
        assert!(output.contains("resp-original"));
        assert!(matches!(worker.join().unwrap(), Ok(outcome) if outcome.status == 502));
        upstream_worker.join().unwrap();
    }

    #[test]
    fn rust_tracker_matches_shared_native_sse_terminal_fixture_across_byte_boundaries() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../fixtures/responses-native-sse.json")).unwrap();
        let mut valid = NativeSseAdapter::new("gpt-5");
        let input = fixture["valid"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<String>();
        let mut valid_output = Vec::new();
        for byte in input.as_bytes() {
            valid_output.extend(valid.process_chunk(std::slice::from_ref(byte)));
        }
        valid_output.extend(valid.finish());
        assert_eq!(valid_output.concat(), input.as_bytes());
        assert_eq!(
            valid.usage(),
            Some(SseUsage {
                input_tokens: 12,
                output_tokens: 3,
                cached_tokens: 0
            })
        );

        let mut terminal_error = NativeSseAdapter::new("gpt-5");
        let mut error_output = Vec::new();
        for block in fixture["terminalError"].as_array().unwrap() {
            error_output.extend(terminal_error.process_chunk(block.as_str().unwrap().as_bytes()));
        }
        error_output.extend(terminal_error.finish());
        let error_output = String::from_utf8(error_output.concat()).unwrap();
        assert!(error_output.contains("response.failed"));
        assert!(!error_output.contains("response.completed"));

        let mut truncated = NativeSseAdapter::new("gpt-5");
        let mut truncated_output = Vec::new();
        for block in fixture["nonTerminal"].as_array().unwrap() {
            truncated_output.extend(truncated.process_chunk(block.as_str().unwrap().as_bytes()));
        }
        truncated_output.extend(truncated.finish());
        let truncated_output = String::from_utf8(truncated_output.concat()).unwrap();
        assert!(truncated_output.contains("response.failed"));
        assert!(!truncated_output.contains("response.completed"));
        assert!(truncated_output.contains("resp-fixture-3"));

        for event in ["response.failed", "response.incomplete", "error"] {
            let mut adapter = NativeSseAdapter::new("gpt-5");
            let block = format!("event: {event}\ndata: {{\"type\":\"{event}\",\"response\":{{\"id\":\"resp-terminal\"}}}}\n\n");
            let output = adapter.process_chunk(block.as_bytes());
            assert!(!output.is_empty(), "{event}");
        }

        let mut repair = NativeSseAdapter::new("gpt-5");
        let repair_input = fixture["repairText"].as_array().unwrap();
        let mut repair_output = Vec::new();
        for block in repair_input {
            for byte in block.as_str().unwrap().as_bytes() {
                repair_output.extend(repair.process_chunk(std::slice::from_ref(byte)));
            }
        }
        repair_output.extend(repair.finish());
        let output = String::from_utf8(repair_output.concat()).unwrap();
        let event_names = output
            .lines()
            .filter_map(|line| line.strip_prefix("event: "))
            .collect::<Vec<_>>();
        assert_eq!(
            event_names,
            [
                "response.created",
                "response.in_progress",
                "response.output_item.added",
                "response.content_part.added",
                "response.output_text.delta",
                "response.output_text.delta",
                "response.output_text.done",
                "response.content_part.done",
                "response.output_item.done",
                "response.completed"
            ]
        );
        assert!(output.contains("Hello world"));
        assert_eq!(
            repair.usage(),
            Some(SseUsage {
                input_tokens: 7,
                output_tokens: 2,
                cached_tokens: 3
            })
        );

        let mut completed_only = NativeSseAdapter::new("gpt-5");
        let mut output = Vec::new();
        for byte in fixture["repairText"][2].as_str().unwrap().as_bytes() {
            output.extend(completed_only.process_chunk(std::slice::from_ref(byte)));
        }
        output.extend(completed_only.finish());
        let output = String::from_utf8(output.concat()).unwrap();
        assert!(output.contains("response.output_item.added"));
        assert!(output.contains("response.output_text.done"));
        assert!(output.contains("\"input_tokens\":7"));

        let mut tool_repair = NativeSseAdapter::new("gpt-5");
        let mut tool_output = Vec::new();
        for block in fixture["repairToolCalls"].as_array().unwrap() {
            tool_output.extend(tool_repair.process_chunk(block.as_str().unwrap().as_bytes()));
        }
        tool_output.extend(tool_repair.finish());
        let tool_output = String::from_utf8(tool_output.concat()).unwrap();
        assert!(tool_output.contains("response.function_call_arguments.delta"));
        let completed = tool_output
            .split("\n\n")
            .filter_map(|block| block.lines().find_map(|line| line.strip_prefix("data: ")))
            .filter_map(|data| serde_json::from_str::<Value>(data).ok())
            .find(|payload| payload["type"] == "response.completed")
            .unwrap();
        let output_items = completed["response"]["output"].as_array().unwrap();
        assert_eq!(output_items.len(), 3);
        assert_eq!(output_items[0]["type"], "message");
        assert_eq!(output_items[1]["id"], "fc-1");
        assert_eq!(output_items[2]["id"], "fc-2");
        assert_eq!(
            output_items
                .iter()
                .filter(|item| item["type"] == "function_call")
                .count(),
            2
        );

        let mut malformed = NativeSseAdapter::new("gpt-5");
        malformed.process_chunk(
            b"data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg-a\",\"delta\":\"A\"}\n\n",
        );
        let failed = malformed.process_chunk(
            b"data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg-b\",\"delta\":\"B\"}\n\n",
        );
        let failed = String::from_utf8(failed.concat()).unwrap();
        assert!(failed.contains("response.failed"));
        assert!(malformed.failed);
    }

    #[test]
    fn repaired_text_stream_preserves_completed_function_calls_without_duplicates() {
        let mut adapter = NativeSseAdapter::new("gpt-5");
        let events = [
            json!({
                "type": "response.output_text.delta",
                "item_id": "msg-1",
                "output_index": 0,
                "delta": "Checking"
            }),
            json!({
                "type": "response.output_item.done",
                "output_index": 1,
                "item": {
                    "id": "fc-1",
                    "type": "function_call",
                    "status": "completed",
                    "call_id": "call-1",
                    "name": "shell",
                    "arguments": "{}"
                }
            }),
            json!({
                "type": "response.completed",
                "response": {
                    "id": "resp-tool",
                    "output": [{
                        "id": "fc-1",
                        "type": "function_call",
                        "status": "completed",
                        "call_id": "call-1",
                        "name": "shell",
                        "arguments": "{}"
                    }]
                }
            }),
        ];
        let mut output = Vec::new();
        for event in events {
            let block = format!("data: {event}\n\n");
            output.extend(adapter.process_chunk(block.as_bytes()));
        }
        let output = String::from_utf8(output.concat()).unwrap();
        let completed = output
            .split("\n\n")
            .filter_map(|block| block.lines().find_map(|line| line.strip_prefix("data: ")))
            .filter_map(|data| serde_json::from_str::<Value>(data).ok())
            .find(|payload| payload["type"] == "response.completed")
            .unwrap();
        let items = completed["response"]["output"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["type"], "message");
        assert_eq!(items[1]["id"], "fc-1");
        assert_eq!(items.iter().filter(|item| item["id"] == "fc-1").count(), 1);
    }
}
