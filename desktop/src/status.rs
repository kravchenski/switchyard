use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub providers: Vec<ProviderStatus>,
    pub accounts: Vec<AccountStatus>,
    pub requests: Vec<RequestLog>,
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    #[serde(default)]
    pub model_stats: Vec<ModelStat>,
    #[serde(default)]
    pub auto_models: Vec<String>,
    #[serde(default)]
    pub unavailable_models: Vec<UnavailableModel>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ModelEntry {
    pub id: String,
    pub provider: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStat {
    pub model: String,
    pub successes: u32,
    pub failures: u32,
    pub latency_ms: Option<u64>,
    pub last_outcome: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct UnavailableModel {
    pub model: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ProviderStatus {
    pub id: String,
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub account_id: String,
    pub provider: String,
    pub status: String,
    pub consecutive_failures: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLog {
    pub created_at: i64,
    pub provider: String,
    pub model: String,
    pub status: String,
    pub latency_ms: Option<i64>,
    pub error: Option<String>,
    #[serde(default)]
    pub decision_id: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub requested_model: String,
    #[serde(default)]
    pub skipped: Vec<SkippedRoute>,
    #[serde(default)]
    pub attempts: Vec<RouteAttempt>,
    pub chosen: Option<ChosenRoute>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct SkippedRoute {
    pub model: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteAttempt {
    pub model: String,
    pub provider: String,
    pub outcome: String,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ChosenRoute {
    pub model: String,
    pub provider: String,
}

pub fn fetch_decision(base_url: &str, api_key: Option<&str>, id: i64) -> Result<Decision, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(3)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut request = agent.get(format!("{base_url}/v1/gateway/decisions/{id}"));
    if let Some(key) = api_key {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    let mut response = request.call().map_err(|error| error.to_string())?;
    if response.status() == 404 {
        return Err("The gateway was restarted since this request, so its routing details are gone.".into());
    }
    if !response.status().is_success() {
        return Err(format!("The gateway answered {}", response.status()));
    }
    response.body_mut().read_json::<Decision>().map_err(|error| error.to_string())
}

pub fn fetch_status(base_url: &str, api_key: Option<&str>) -> Result<GatewayStatus, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(3)))
        .build()
        .into();
    let mut request = agent.get(format!("{base_url}/v1/gateway/status"));
    if let Some(key) = api_key {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    request
        .call()
        .map_err(|error| error.to_string())?
        .body_mut()
        .read_json::<GatewayStatus>()
        .map_err(|error| error.to_string())
}

pub fn setting_from(name: &str, env_value: Option<String>, dotenv: &str) -> Option<String> {
    let prefix = format!("{name}=");
    env_value.filter(|value| !value.is_empty()).or_else(|| {
        dotenv
            .lines()
            .filter_map(|line| line.trim().strip_prefix(prefix.as_str()))
            .map(|value| value.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
            .rfind(|value| !value.is_empty())
    })
}

pub fn refresh_models(base_url: &str, api_key: Option<&str>) -> Result<usize, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(60)))
        .build()
        .into();
    let mut request = agent.post(format!("{base_url}/v1/gateway/refresh"));
    if let Some(key) = api_key {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    #[derive(Deserialize)]
    struct Refreshed {
        models: usize,
    }
    request
        .send_empty()
        .map_err(|error| error.to_string())?
        .body_mut()
        .read_json::<Refreshed>()
        .map(|body| body.models)
        .map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
struct ModelCheckResult {
    ok: bool,
    #[serde(default)]
    hidden: bool,
}

#[derive(Debug, Deserialize)]
struct ModelCheckReport {
    results: Vec<ModelCheckResult>,
    stopped: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: ErrorMessage,
}

#[derive(Debug, Deserialize)]
struct ErrorMessage {
    message: String,
}

pub fn summarize_model_check(body: &str) -> Result<String, String> {
    if let Ok(error) = serde_json::from_str::<ErrorBody>(body) {
        return Err(error.error.message);
    }
    let report: ModelCheckReport = serde_json::from_str(body).map_err(|error| format!("Unexpected check answer: {error}"))?;
    let working = report.results.iter().filter(|result| result.ok).count();
    let hidden = report.results.iter().filter(|result| result.hidden).count();
    let mut summary = format!("Checked {} models: {working} work with this key", report.results.len());
    if hidden > 0 {
        summary.push_str(&format!(", {hidden} not available for it and hidden"));
    }
    summary.push('.');
    if let Some(reason) = report.stopped {
        summary.push_str(&format!(" Stopped early: {reason}"));
    }
    Ok(summary)
}

pub fn check_models(base_url: &str, api_key: Option<&str>, provider: &str) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(900)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut request = agent.post(format!("{base_url}/v1/gateway/providers/{provider}/check"));
    if let Some(key) = api_key {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    let body = request
        .send_empty()
        .map_err(|error| error.to_string())?
        .body_mut()
        .read_to_string()
        .map_err(|error| error.to_string())?;
    summarize_model_check(&body)
}

pub fn api_key_from(env_value: Option<String>, dotenv: &str) -> Option<String> {
    setting_from("GATEWAY_API_KEY", env_value, dotenv)
}


pub fn read_api_key(root: &Path) -> Option<String> {
    let dotenv = std::fs::read_to_string(root.join(".env")).unwrap_or_default();
    api_key_from(std::env::var("GATEWAY_API_KEY").ok(), &dotenv)
}

pub fn relative_time(created_at_ms: i64, now_ms: i64) -> String {
    let seconds = ((now_ms - created_at_ms) / 1000).max(0);
    match seconds {
        0..=59 => format!("{seconds}s ago"),
        60..=3599 => format!("{}m ago", seconds / 60),
        3600..=86_399 => format!("{}h ago", seconds / 3600),
        _ => format!("{}d ago", seconds / 86_400),
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RequestSummary {
    pub total: usize,
    pub success_percent: Option<u32>,
    pub median_latency_ms: Option<i64>,
}

pub fn summarize_requests(requests: &[RequestLog]) -> RequestSummary {
    let succeeded = requests.iter().filter(|request| request.status == "success").count();
    let mut latencies: Vec<i64> = requests.iter().filter(|request| request.status == "success").filter_map(|request| request.latency_ms).collect();
    latencies.sort_unstable();
    RequestSummary {
        total: requests.len(),
        success_percent: (!requests.is_empty()).then(|| (succeeded * 100 / requests.len()) as u32),
        median_latency_ms: latencies.get(latencies.len() / 2).copied(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(status: &str, latency_ms: Option<i64>) -> RequestLog {
        RequestLog { created_at: 0, provider: "qwen-chat".into(), model: "qwen-chat".into(), status: status.into(), latency_ms, error: None, decision_id: None }
    }

    #[test]
    fn reads_a_routing_decision() {
        let json = r#"{"id":7,"at":1,"requestedModel":"auto","mode":"fallback","skipped":[{"model":"glm-chat","reason":"glm-chat is off in auto"}],"attempts":[{"model":"qwen-chat","provider":"qwen-chat","outcome":"timeout","latencyMs":30000,"error":"no response"},{"model":"deepseek-reasoner","provider":"deepseek","outcome":"chosen","latencyMs":5100}],"chosen":{"model":"deepseek-reasoner","provider":"deepseek"}}"#;
        let decision: Decision = serde_json::from_str(json).unwrap();
        assert_eq!(decision.skipped[0].reason, "glm-chat is off in auto");
        assert_eq!(decision.attempts[0].outcome, "timeout");
        assert_eq!(decision.attempts[1].latency_ms, Some(5100));
        assert_eq!(decision.chosen.unwrap().model, "deepseek-reasoner");
        let old: RequestLog = serde_json::from_str(r#"{"createdAt":1,"provider":"p","model":"m","status":"success","latencyMs":null,"error":null}"#).unwrap();
        assert_eq!(old.decision_id, None);
    }

    #[test]
    fn summarizes_requests_for_the_stat_tiles() {
        assert_eq!(summarize_requests(&[]), RequestSummary { total: 0, success_percent: None, median_latency_ms: None });
        let requests = [request("success", Some(900)), request("success", Some(300)), request("error", Some(50)), request("success", Some(1200))];
        assert_eq!(summarize_requests(&requests), RequestSummary { total: 4, success_percent: Some(75), median_latency_ms: Some(900) });
    }

    #[test]
    fn parses_the_gateway_status_payload() {
        let status: GatewayStatus = serde_json::from_str(r#"{
            "providers": [{"id": "qwen", "ownedBy": "qwen-api", "available": false, "reason": "QWEN_TOKEN is not set"}],
            "accounts": [{"accountId": "qwen-1", "provider": "qwen", "status": "cooldown", "consecutiveFailures": 2,
                "cooldownUntil": 1, "quotaResetAt": null, "lastUsedAt": null, "lastSuccessAt": null, "lastErrorAt": null, "lastError": "x"}],
            "requests": [{"createdAt": 1000, "provider": "deepseek", "model": "deepseek-default", "accountId": null,
                "status": "success", "latencyMs": 812, "error": null}]
        }"#).unwrap();
        assert_eq!(status.providers[0].reason.as_deref(), Some("QWEN_TOKEN is not set"));
        assert_eq!(status.accounts[0].consecutive_failures, 2);
        assert_eq!(status.requests[0].latency_ms, Some(812));
    }

    #[test]
    fn prefers_the_environment_api_key_over_dotenv() {
        let dotenv = "ZENMUX_API_KEY=x\nGATEWAY_API_KEY=\"from-file\"\n";
        assert_eq!(api_key_from(Some("from-env".into()), dotenv).as_deref(), Some("from-env"));
        assert_eq!(api_key_from(Some(String::new()), dotenv).as_deref(), Some("from-file"));
        assert_eq!(api_key_from(None, "GATEWAY_API_KEY=\n"), None);
        assert_eq!(setting_from("ACCOUNTS_SECRET", None, "GATEWAY_API_KEY=x\nACCOUNTS_SECRET=\"s\"\n").as_deref(), Some("s"));
        assert_eq!(setting_from("ACCOUNTS_SECRET", None, "ACCOUNTS_SECRET=\n"), None);
    }

    #[test]
    fn summarizes_a_model_check() {
        let body = r#"{"provider":"nvidia","results":[{"model":"a","ok":true},{"model":"b","ok":false,"hidden":true},{"model":"c","ok":false}],"stopped":"rate limited"}"#;
        assert_eq!(summarize_model_check(body).unwrap(), "Checked 3 models: 1 work with this key, 1 not available for it and hidden. Stopped early: rate limited");
        assert_eq!(summarize_model_check(r#"{"error":{"message":"KEY is not set","type":"provider_unavailable"}}"#).unwrap_err(), "KEY is not set");
    }

    #[test]
    fn formats_relative_times() {
        assert_eq!(relative_time(0, 5_000), "5s ago");
        assert_eq!(relative_time(0, 125_000), "2m ago");
        assert_eq!(relative_time(0, 7_200_000), "2h ago");
        assert_eq!(relative_time(0, 172_800_000), "2d ago");
        assert_eq!(relative_time(10_000, 0), "0s ago");
    }
}
