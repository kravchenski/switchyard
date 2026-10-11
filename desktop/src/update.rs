use std::time::Duration;

use serde::Deserialize;

const LATEST_RELEASE: &str = "https://api.github.com/repos/kravchenski/switchyard/releases/latest";
const DEV_VERSION: &str = "0.1.0";

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Release {
    pub tag_name: String,
    pub html_url: String,
}

impl Release {
    pub fn version(&self) -> &str {
        self.tag_name.trim_start_matches('v')
    }
}

pub fn app_version() -> Option<&'static str> {
    let version = option_env!("SWITCHYARD_VERSION").filter(|value| !value.trim().is_empty()).unwrap_or(env!("CARGO_PKG_VERSION"));
    (version != DEV_VERSION).then_some(version)
}

fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim_start_matches('v').split(['.', '-', '+']).take(3).map(|part| part.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    matches!((parse(candidate), parse(current)), (Some(candidate), Some(current)) if candidate > current)
}

pub fn fetch_latest() -> Result<Release, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().into();
    agent
        .get(LATEST_RELEASE)
        .header("user-agent", "switchyard-desktop")
        .header("accept", "application/vnd.github+json")
        .call()
        .map_err(|error| error.to_string())?
        .body_mut()
        .read_json::<Release>()
        .map_err(|error| error.to_string())
}

pub fn available_update(current: &str) -> Option<Release> {
    fetch_latest().ok().filter(|release| is_newer(release.version(), current) && release.html_url.starts_with("https://"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions() {
        assert!(is_newer("2.16.0", "2.15.0"));
        assert!(is_newer("v3.0.0", "2.15.9"));
        assert!(is_newer("2.15.10", "2.15.9"));
        assert!(!is_newer("2.15.0", "2.15.0"));
        assert!(!is_newer("2.14.3", "2.15.0"));
        assert!(!is_newer("nightly", "2.15.0"));
    }

    #[test]
    fn reads_a_github_release() {
        let release: Release = serde_json::from_str(r#"{"tag_name":"v2.16.0","html_url":"https://github.com/kravchenski/switchyard/releases/tag/v2.16.0","name":"v2.16.0"}"#).unwrap();
        assert_eq!(release.version(), "2.16.0");
        assert!(release.html_url.starts_with("https://github.com/"));
    }
}
