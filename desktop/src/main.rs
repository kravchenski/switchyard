mod accounts;
mod assets;
mod gateway;
mod overview;
mod settings;
mod status;
mod ui;

use std::time::Duration;

use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{Root, Theme, ThemeMode};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use accounts::{provider_id, AccountProfile, AccountsCli, SavedAccount};
use settings::{AutoSettings, DesktopSettings, ThemeChoice};
use gateway::{check_health, open_in_browser, stop_external, Gateway, GatewayConfig};
use overview::{activity, detail, display_name, kind_label, Activity, ProviderOverview};
use status::{check_models, fetch_decision, fetch_status, now_ms, read_api_key, refresh_models, relative_time, summarize_requests, Decision, GatewayStatus, ProviderStatus, RequestLog};
use ui::*;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const OVERVIEW_EVERY_POLLS: u32 = 10;
const COMPACT_WIDTH: f32 = 1100.;
const COPIED_FOR: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq)]
enum Health {
    Stopped,
    Starting,
    Online,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Page {
    Requests,
    ApiKeys,
    Accounts,
    Settings,
    Provider,
}

impl Page {
    fn title(self) -> &'static str {
        match self {
            Page::Accounts => "Accounts",
            Page::ApiKeys => "API keys",
            Page::Settings => "Settings",
            Page::Requests => "Requests",
            Page::Provider => "Provider",
        }
    }

    fn subtitle(self) -> &'static str {
        match self {
            Page::Accounts => "Browser accounts signed in to the web chats.",
            Page::ApiKeys => "Free API keys for the fallback providers, stored encrypted.",
            Page::Settings => "Appearance and how model=auto picks models.",
            Page::Requests => "Recent requests routed through the gateway.",
            Page::Provider => "Connection, routing and models of this provider.",
        }
    }
}

struct Shell {
    gateway: Gateway,
    health: Health,
    page: Page,
    status: Option<GatewayStatus>,
    status_error: Option<String>,
    overview: Vec<ProviderOverview>,
    accounts: AccountsCli,
    saved: Vec<SavedAccount>,
    profiles: Vec<AccountProfile>,
    profile_name: Entity<InputState>,
    api_key: Entity<InputState>,
    account_id: Entity<InputState>,
    custom_name: Entity<InputState>,
    custom_url: Entity<InputState>,
    custom_key: Entity<InputState>,
    key_provider: Option<String>,
    request_filter: Option<String>,
    selected_provider: Option<String>,
    expanded_chat: Option<String>,
    open_request: Option<(i64, String)>,
    request_decision: Option<Result<Decision, String>>,
    theme: ThemeChoice,
    applied_dark: Option<bool>,
    auto_settings: Option<AutoSettings>,
    busy: bool,
    running: bool,
    compact: bool,
    locked: bool,
    message: Option<(bool, String)>,
    copied: bool,
}

impl Shell {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let config = GatewayConfig::from_env();
        let config_root = config.root.clone();
        let accounts = AccountsCli::new(config.root.clone(), config.accounts_program.clone(), config.accounts_args.clone());
        let base_url = config.base_url();
        let api_key = read_api_key(&config.root);
        cx.spawn(async move |this, cx| {
            let mut polls = 0u32;
            loop {
                let url = base_url.clone();
                let key = api_key.clone();
                let (healthy, status) = cx
                    .background_executor()
                    .spawn(async move {
                        let healthy = check_health(&url).is_ok();
                        (healthy, healthy.then(|| fetch_status(&url, key.as_deref())))
                    })
                    .await;
                polls += 1;
                let updated = this.update(cx, |shell, cx| {
                    shell.apply_health(healthy);
                    match status {
                        Some(Ok(status)) => {
                            shell.status = Some(status);
                            shell.status_error = None;
                        }
                        Some(Err(error)) => shell.status_error = Some(error),
                        None => {
                            shell.status = None;
                            shell.status_error = None;
                        }
                    }
                    if polls.is_multiple_of(OVERVIEW_EVERY_POLLS) {
                        shell.refresh(cx);
                    }
                    cx.notify();
                });
                if updated.is_err() {
                    break;
                }
                cx.background_executor().timer(POLL_INTERVAL).await;
            }
        })
        .detach();
        let mut shell = Self {
            gateway: Gateway::new(config),
            health: Health::Stopped,
            page: Page::Requests,
            status: None,
            status_error: None,
            overview: Vec::new(),
            accounts,
            saved: Vec::new(),
            profiles: Vec::new(),
            profile_name: cx.new(|cx| InputState::new(window, cx).placeholder("Account name, e.g. Work")),
            api_key: cx.new(|cx| InputState::new(window, cx).placeholder("Paste the API key").masked(true)),
            account_id: cx.new(|cx| InputState::new(window, cx).placeholder("Account ID")),
            custom_name: cx.new(|cx| InputState::new(window, cx).placeholder("Name, e.g. Home Ollama")),
            custom_url: cx.new(|cx| InputState::new(window, cx).placeholder("Base URL, e.g. http://localhost:11434/v1")),
            custom_key: cx.new(|cx| InputState::new(window, cx).placeholder("API key (optional)").masked(true)),
            key_provider: None,
            request_filter: None,
            selected_provider: None,
            expanded_chat: None,
            open_request: None,
            request_decision: None,
            theme: settings::load(&config_root).theme,
            applied_dark: None,
            auto_settings: None,
            busy: false,
            running: false,
            compact: false,
            locked: false,
            message: None,
            copied: false,
        };
        shell.refresh(cx);
        shell
    }

    fn add_profile(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let label = self.profile_name.read(cx).value().to_string();
        self.profile_name.update(cx, |input, cx| input.set_value("", window, cx));
        self.run_command(cx, move |cli| {
            cli.add_profile(&label).map(|_| format!("Added {}. Stop the API if it runs, then press Connect chats on its card to sign it in.", label.trim()))
        });
    }

    fn key_providers(&self) -> Vec<String> {
        self.overview.iter().filter(|row| row.kind == "api-key").map(|row| row.id.clone()).collect()
    }

    fn selected_key_provider(&self) -> Option<String> {
        let providers = self.key_providers();
        self.key_provider.clone().filter(|id| providers.contains(id)).or_else(|| providers.first().cloned())
    }

    fn registry_locked(&self) -> bool {
        self.locked
    }

    fn apply_health(&mut self, healthy: bool) {
        self.health = match (healthy, self.gateway.is_running()) {
            (true, _) => Health::Online,
            (false, true) => Health::Starting,
            (false, false) => Health::Stopped,
        };
    }

    fn toggle_gateway(&mut self, cx: &mut Context<Self>) {
        if self.gateway.is_running() {
            self.gateway.stop();
            self.health = Health::Stopped;
            return;
        }
        if self.external() {
            let base_url = self.gateway.config.base_url();
            self.busy = true;
            cx.spawn(async move |this, cx| {
                let result = cx.background_executor().spawn(async move { stop_external(&base_url) }).await;
                let _ = this.update(cx, |shell, cx| {
                    shell.busy = false;
                    shell.message = Some(match result {
                        Ok(pid) => {
                            shell.health = Health::Stopped;
                            (true, format!("Stopped the API (process {pid})"))
                        }
                        Err(error) => (false, error),
                    });
                    cx.notify();
                });
            })
            .detach();
            return;
        }
        match self.gateway.start() {
            Ok(()) => {
                self.health = Health::Starting;
                self.message = None;
            }
            Err(error) => self.message = Some((false, format!("Failed to start gateway: {error}"))),
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let cli = self.accounts.clone();
        cx.spawn(async move |this, cx| {
            let (overview, saved, missing, profiles, auto) = cx
                .background_executor()
                .spawn(async move { (cli.overview(), cli.list(), cli.secret_missing(), cli.profiles(), cli.auto_settings()) })
                .await;
            let _ = this.update(cx, |shell, cx| {
                if let Ok(auto) = auto {
                    shell.auto_settings = Some(auto);
                }
                if let Ok(profiles) = profiles {
                    shell.profiles = profiles;
                }
                if let Ok(missing) = missing {
                    shell.locked = missing;
                }
                match overview {
                    Ok(rows) => shell.overview = rows,
                    Err(error) => shell.message = Some((false, error)),
                }
                if let Ok(saved) = saved {
                    shell.saved = saved;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn run_command(&mut self, cx: &mut Context<Self>, command: impl FnOnce(AccountsCli) -> Result<String, String> + Send + 'static) {
        self.run_command_then(cx, command, false, None);
    }

    fn run_key_command(&mut self, cx: &mut Context<Self>, command: impl FnOnce(AccountsCli) -> Result<String, String> + Send + 'static) {
        self.run_command_then(cx, command, true, None);
    }

    fn check_provider_models(&mut self, provider: String, cx: &mut Context<Self>) {
        if self.health != Health::Online {
            self.message = Some((false, "Start the API first, then check the models.".into()));
            return;
        }
        self.run_command_then(cx, |_| Ok(String::new()), false, Some(provider));
    }

    fn run_command_then(&mut self, cx: &mut Context<Self>, command: impl FnOnce(AccountsCli) -> Result<String, String> + Send + 'static, reload_models: bool, check: Option<String>) {
        let cli = self.accounts.clone();
        let base_url = self.gateway.config.base_url();
        let gateway_key = read_api_key(&self.gateway.config.root);
        let online = self.health == Health::Online;
        self.busy = true;
        self.message = None;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let result = command(cli);
                    let result = match (&result, reload_models && online) {
                        (Ok(output), true) => match refresh_models(&base_url, gateway_key.as_deref()) {
                            Ok(count) => Ok(format!("Models reloaded: {count} available.\n{}", output.trim_end())),
                            Err(error) => Ok(format!("Saved, but the models could not be reloaded yet: {error}\n{}", output.trim_end())),
                        },
                        _ => result,
                    };
                    match (result, check.filter(|_| online)) {
                        (Ok(output), Some(provider)) => match check_models(&base_url, gateway_key.as_deref(), &provider) {
                            Ok(summary) => Ok(format!("{}\n{summary}", output.trim_end())),
                            Err(error) => Err(format!("{}\nModel check failed: {error}", output.trim_end())),
                        },
                        (result, _) => result,
                    }
                })
                .await;
            let _ = this.update(cx, |shell, cx| {
                shell.busy = false;
                shell.message = Some(match result {
                    Ok(output) => (true, last_line(&output, "Done")),
                    Err(error) => (false, last_line(&error, "Failed")),
                });
                shell.refresh(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn browser_blocked(&self) -> bool {
        self.busy || self.running || self.external()
    }

    fn external(&self) -> bool {
        self.health == Health::Online && !self.running
    }

    fn add_api_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(provider) = self.selected_key_provider() else { return };
        self.add_api_key_for(provider, window, cx);
    }

    fn add_api_key_for(&mut self, provider: String, window: &mut Window, cx: &mut Context<Self>) {
        let key = self.api_key.read(cx).value().trim().to_string();
        let account = self.account_id.read(cx).value().trim().to_string();
        let key = if account.is_empty() || key.is_empty() { key } else { format!("{account}:{key}") };
        self.api_key.update(cx, |input, cx| input.set_value("", window, cx));
        self.account_id.update(cx, |input, cx| input.set_value("", window, cx));
        let check = provider.clone();
        self.run_command_then(cx, move |cli| cli.add_api_key(&provider, &key), true, Some(check));
    }

    fn copy_url(&mut self, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(self.api_url()));
        self.copied = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(COPIED_FOR).await;
            let _ = this.update(cx, |shell, cx| {
                shell.copied = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn api_url(&self) -> String {
        format!("{}/v1", self.gateway.config.base_url())
    }

    fn name_of(&self, id: &str) -> String {
        self.overview.iter().find(|row| row.id == id).and_then(|row| row.label.clone()).unwrap_or_else(|| display_name(id).to_string())
    }

    fn add_custom_provider(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.custom_name.read(cx).value().trim().to_string();
        let url = self.custom_url.read(cx).value().trim().to_string();
        let key = self.custom_key.read(cx).value().trim().to_string();
        let id = provider_id(&name);
        self.custom_key.update(cx, |input, cx| input.set_value("", window, cx));
        let check = id.clone();
        self.run_command_then(
            cx,
            move |cli| {
                let added = cli.add_custom(&id, &url, &name)?;
                if key.is_empty() { Ok(added) } else { cli.add_api_key(&id, &key) }
            },
            true,
            Some(check),
        );
    }

    fn toggle_request(&mut self, request: &RequestLog, cx: &mut Context<Self>) {
        let key = (request.created_at, request.model.clone());
        if self.open_request.as_ref() == Some(&key) {
            self.open_request = None;
            return;
        }
        self.open_request = Some(key.clone());
        self.request_decision = None;
        let Some(id) = request.decision_id else {
            self.request_decision = Some(Err("This request was logged before routing details were kept.".into()));
            return;
        };
        let base_url = self.gateway.config.base_url();
        let api_key = read_api_key(&self.gateway.config.root);
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { fetch_decision(&base_url, api_key.as_deref(), id) }).await;
            let _ = this.update(cx, |shell, cx| {
                if shell.open_request.as_ref() == Some(&key) {
                    shell.request_decision = Some(result);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn render_decision(&self) -> Div {
        let panel = div().flex().flex_col().gap_2().px_5().py_4().bg(col(CANVAS)).border_b_1().border_color(col(BORDER)).text_sm();
        let decision = match &self.request_decision {
            None => return panel.child(muted("Loading the routing details…").text_xs()),
            Some(Err(error)) => return panel.child(muted(error.clone()).text_xs()),
            Some(Ok(decision)) => decision,
        };
        let attempts = decision.attempts.iter().map(|attempt| {
            let (state, label) = match attempt.outcome.as_str() {
                "chosen" => (Activity::Active, "Answered"),
                "timeout" => (Activity::Degraded, "No answer in time"),
                _ => (Activity::Inactive, "Failed"),
            };
            div()
                .flex()
                .items_start()
                .gap_3()
                .child(div().w(px(150.)).flex_none().flex().child(labeled_badge(state, label)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap_0p5()
                        .child(div().flex().items_center().gap_2().child(provider_mark(&attempt.provider, 18.)).child(attempt.model.clone()))
                        .children(attempt.error.clone().map(|error| div().text_xs().text_color(col(RED)).child(error.chars().take(300).collect::<String>()))),
                )
                .child(div().flex_none().text_xs().text_color(col(MUTED)).child(attempt.latency_ms.map(|ms| format!("{:.1} s", ms as f64 / 1000.)).unwrap_or_default()))
        });
        let skipped = decision.skipped.iter().map(|route| div().text_xs().text_color(col(MUTED)).child(format!("Skipped {}: {}", route.model, route.reason)));
        panel
            .child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(col(MUTED)).child(format!("Asked for {}", decision.requested_model)))
            .children(skipped)
            .children(attempts)
            .children(decision.attempts.is_empty().then(|| muted(decision.error.clone().unwrap_or_else(|| "No model was tried.".into())).text_xs()))
    }

    fn open_link(&mut self, url: &str) {
        self.message = match open_in_browser(url) {
            Ok(()) => Some((true, format!("Opened {url} in your browser. Create a key there and paste it here."))),
            Err(error) => Some((false, error)),
        };
    }

    fn key_page(&self, provider: &str) -> Option<String> {
        self.overview.iter().find(|row| row.id == provider && row.kind == "api-key").and_then(|row| row.url.clone())
    }

    fn live(&self, id: &str) -> Option<&ProviderStatus> {
        self.status.as_ref()?.providers.iter().find(|provider| provider.id == id)
    }
}

fn model_rank(status: &GatewayStatus, model: &str) -> (usize, usize) {
    if let Some(position) = status.auto_models.iter().position(|entry| entry == model) {
        return (0, position);
    }
    if status.unavailable_models.iter().any(|entry| entry.model == model) {
        return (3, 0);
    }
    match status.model_stats.iter().find(|stat| stat.model == model) {
        Some(stat) if stat.last_outcome == "success" => (1, stat.latency_ms.unwrap_or(u64::MAX) as usize),
        Some(_) => (3, 0),
        None => (2, 0),
    }
}

fn agent_option_text(name: &str) -> (String, &'static str) {
    match name {
        "compact" => ("Trim tool output".into(), "Removes colours, progress bars and repeated lines from command output the agent sends back, and shortens very long output while keeping errors and warnings."),
        "tools" => ("Keep only the tools a request needs".into(), "When an agent sends more than 15 tools, the decision model drops the ones this task does not need. Core tools (read, edit, shell, search) and tools already used stay."),
        "rtk" => ("Run shell commands through rtk".into(), "Rewrites the agent's shell commands with the installed rtk (git status -> rtk git status) so their output reaches the model already compact. Needs rtk on this machine."),
        other => (other.to_string(), ""),
    }
}

fn model_label(chat: &str, model: &str) -> String {
    if model == chat {
        return "Default".into();
    }
    model.strip_prefix(&format!("{chat}/")).unwrap_or(model).to_string()
}

fn last_line(text: &str, fallback: &str) -> String {
    text.lines().rev().find(|line| !line.trim().is_empty() && !line.starts_with('$')).unwrap_or(fallback).trim().to_string()
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.running = self.gateway.is_running();
        self.compact = window.viewport_size().width < px(COMPACT_WIDTH);
        let dark = match self.theme {
            ThemeChoice::Light => false,
            ThemeChoice::Dark => true,
            ThemeChoice::System => matches!(window.appearance(), WindowAppearance::Dark | WindowAppearance::VibrantDark),
        };
        if self.applied_dark != Some(dark) {
            self.applied_dark = Some(dark);
            set_dark(dark);
            Theme::change(if dark { ThemeMode::Dark } else { ThemeMode::Light }, Some(window), cx);
        }
        div()
            .size_full()
            .flex()
            .font_family(assets::FONT_FAMILY)
            .bg(col(CANVAS))
            .text_color(col(TEXT))
            .child(self.render_sidebar(cx))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(self.render_header(cx))
                    .child(
                        div()
                            .id("content")
                            .flex_1()
                            .overflow_y_scroll()
                            .px(px(if self.compact { 16. } else { 28. }))
                            .pb(px(28.))
                            .flex()
                            .flex_col()
                            .gap_5()
                            .children(self.render_message())
                            .child(match self.page {
                                Page::Accounts => self.render_accounts(cx, false),
                                Page::ApiKeys => self.render_accounts(cx, true),
                                Page::Settings => self.render_settings(cx),
                                Page::Requests => self.render_requests(cx),
                                Page::Provider => self.render_provider_settings(window, cx),
                            }),
                    ),
            )
    }
}

impl Shell {
    fn health_label(&self) -> (&'static str, u32) {
        match self.health {
            Health::Online if self.external() => ("API is running outside the app", GREEN),
            Health::Online => ("API is running", GREEN),
            Health::Starting => ("API is starting…", AMBER),
            Health::Stopped => ("API is stopped", MUTED),
        }
    }

    fn render_sidebar(&self, cx: &mut Context<Self>) -> Div {
        let (label, color) = self.health_label();
        let nav = |id: &'static str, name: IconName, page: Page, cx: &mut Context<Self>| {
            nav_item(id, name, page.title(), self.page == page).on_click(cx.listener(move |shell, _, _, cx| {
                shell.page = page;
                cx.notify();
            }))
        };
        let address = self.api_url().trim_start_matches("http://").to_string();
        let gateway = div()
            .flex()
            .flex_col()
            .gap_0p5()
            .px_3()
            .pt_3()
            .border_t_1()
            .border_color(col(BORDER))
            .child(div().text_sm().font_weight(FontWeight::MEDIUM).text_color(col(if self.health == Health::Stopped { MUTED } else { TEXT })).child(label))
            .child(
                div()
                    .id("copy-url")
                    .flex()
                    .items_center()
                    .gap_1p5()
                    .text_xs()
                    .cursor_pointer()
                    .text_color(col(if self.copied { color } else { MUTED }))
                    .hover(|style| style.text_color(col(TEXT)))
                    .child(if self.copied { "Copied to clipboard".to_string() } else { address })
                    .child(div().text_size(px(12.)).child(if self.copied { IconName::Check } else { IconName::Copy }))
                    .on_click(cx.listener(|shell, _, _, cx| {
                        shell.copy_url(cx);
                        cx.notify();
                    })),
            );
        div()
            .w(px(if self.compact { 212. } else { 248. }))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .px_3()
            .py_4()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2p5()
                    .px_2()
                    .pb_5()
                    .child(img("logos/switchyard.svg").size(px(30.)).flex_none())
                    .child(div().font_family(assets::MONO_FAMILY).text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).child("switchyard")),
            )
            .child(
                div()
                    .id("sidebar")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap_1()
            .child(nav("nav-requests", IconName::Activity, Page::Requests, cx))
            .child(nav("nav-api-keys", IconName::KeyRound, Page::ApiKeys, cx))
            .child(nav("nav-accounts", IconName::Users, Page::Accounts, cx))
            .child(nav("nav-settings", IconName::Settings, Page::Settings, cx))
            .child(div().mx_3().my_4().h(px(1.)).bg(col(BORDER)))
            .children(self.overview.iter().map(|row| {
                let live = self.live(&row.id);
                let state = activity(row, live);
                let selected = self.page == Page::Provider && self.selected_provider.as_deref() == Some(row.id.as_str());
                let id = row.id.clone();
                div()
                    .id(SharedString::from(format!("side-{}", row.id)))
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap_2p5()
                    .h(px(36.))
                    .px_2p5()
                    .rounded_xl()
                    .cursor_pointer()
                    .text_sm()
                    .text_color(col(TEXT))
                    .when(selected, |this| this.bg(col(SURFACE)).shadow_sm().font_weight(FontWeight::MEDIUM))
                    .when(!selected, |this| this.hover(|style| style.bg(col(HOVER))))
                    .child(provider_mark(&row.id, 22.))
                    .child(div().flex_1().child(self.name_of(&row.id).to_string()))
                    .child(status_dot(state))
                    .on_click(cx.listener(move |shell, _, _, cx| {
                        shell.selected_provider = Some(id.clone());
                        shell.page = Page::Provider;
                        shell.message = None;
                        cx.notify();
                    }))
            })),
            )
            .child(gateway)
    }

    fn render_gateway_toggle(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let enabled = !self.busy && self.health != Health::Starting;
        let (label, name, tone) = match self.health {
            Health::Starting => ("Starting…", IconName::Play, Tone::Outline),
            Health::Online => ("Stop API", IconName::Square, Tone::Danger),
            Health::Stopped if self.running => ("Stop API", IconName::Square, Tone::Danger),
            Health::Stopped => ("Run API", IconName::Play, Tone::Primary),
        };
        button("gateway-toggle", label, Some(name), tone, enabled).when(enabled, |this| {
            this.on_click(cx.listener(|shell, _, _, cx| {
                shell.toggle_gateway(cx);
                cx.notify();
            }))
        })
    }

    fn page_title(&self) -> String {
        match (self.page, self.selected_provider.as_deref()) {
            (Page::Provider, Some(id)) => self.name_of(id).to_string(),
            (page, _) => page.title().to_string(),
        }
    }

    fn render_header(&self, cx: &mut Context<Self>) -> Div {
        div()
            .flex()
            .items_center()
            .justify_between()
            .gap_4()
            .flex_none()
            .px(px(if self.compact { 16. } else { 28. }))
            .pt_6()
            .pb_5()
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().text_2xl().font_weight(FontWeight::SEMIBOLD).child(self.page_title()))
                    .child(muted(self.page.subtitle())),
            )
            .child(self.render_gateway_toggle(cx))
    }

    fn render_message(&self) -> Option<Div> {
        let (ok, text) = self.message.clone().or_else(|| self.status_error.clone().map(|error| (false, format!("Status unavailable: {error}"))))?;
        Some(
            div()
                .flex()
                .items_center()
                .gap_2()
                .px_4()
                .py_2p5()
                .rounded_xl()
                .text_sm()
                .bg(col(if ok { PRIMARY_SOFT } else { DANGER_SOFT }))
                .text_color(col(if ok { PRIMARY } else { RED }))
                .child(div().text_size(px(15.)).child(if ok { IconName::CircleCheck } else { IconName::CircleAlert }))
                .child(text),
        )
    }

    fn render_provider_settings(&self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(row) = self.selected_provider.as_ref().and_then(|id| self.overview.iter().find(|row| &row.id == id)).cloned() else {
            return card().p_6().child(muted("Pick a provider in the sidebar.")).into_any_element();
        };
        let live = self.live(&row.id);
        let state = activity(&row, live);
        let blocked = self.browser_blocked();

        let summary = card()
            .p_5()
            .flex()
            .items_center()
            .gap_3()
            .child(provider_mark(&row.id, 44.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(self.name_of(&row.id).to_string()))
                            .child(status_badge(state)),
                    )
                    .child(muted(format!("{} · {}", kind_label(&row.kind), row.id)).text_xs())
                    .child(muted(if state == Activity::NotConnected {
                        "No API key yet. Get a free key from the provider and paste it below.".to_string()
                    } else {
                        detail(&row, live)
                    })),
            )
            .children(row.custom.then(|| {
                let id = row.id.clone();
                button("provider-remove-custom", "Remove provider", Some(IconName::Trash), Tone::Danger, !self.busy).when(!self.busy, |this| {
                    this.on_click(cx.listener(move |shell, _, _, cx| {
                        let id = id.clone();
                        shell.selected_provider = None;
                        shell.page = Page::ApiKeys;
                        shell.run_key_command(cx, move |cli| cli.remove_custom(&id));
                        cx.notify();
                    }))
                })
            }))
            .children(row.url.clone().filter(|_| row.kind == "api-key" && !row.custom).map(|url| {
                button("provider-get-key", "Get API key", Some(IconName::ExternalLink), if state == Activity::NotConnected { Tone::Primary } else { Tone::Outline }, true)
                    .on_click(cx.listener(move |shell, _, _, cx| {
                        shell.open_link(&url);
                        cx.notify();
                    }))
            }));

        let connection = card().p_5().flex().flex_col().gap_3().child(section_title("Connection"));
        let connection = match (row.kind.as_str(), row.url.clone()) {
            ("web", Some(url)) => {
                let open_url = url.clone();
                connection
                    .child(muted(format!("Messages are sent from your signed-in session on {}.", url.trim_start_matches("https://").trim_end_matches('/'))).text_xs())
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child(button("provider-sign-in", "Sign in in the browser", Some(IconName::LogIn), Tone::Primary, !blocked).when(!blocked, |this| {
                                this.on_click(cx.listener(move |shell, _, _, cx| {
                                    let url = open_url.clone();
                                    shell.run_command(cx, move |cli| cli.open_site(&url));
                                    cx.notify();
                                }))
                            }))
                            .child(button("provider-check", "Check sign-in", Some(IconName::RefreshCw), Tone::Outline, !blocked).when(!blocked, |this| {
                                this.on_click(cx.listener(move |shell, _, _, cx| {
                                    let url = url.clone();
                                    shell.run_command(cx, move |cli| cli.check_site(&url));
                                    cx.notify();
                                }))
                            })),
                    )
            }
            ("api-key", _) => {
                let provider = row.id.clone();
                let keys: Vec<SavedAccount> = self.saved.iter().filter(|account| account.provider == row.id).cloned().collect();
                connection
                    .child(muted("Keys are checked against the provider and stored encrypted. An environment variable overrides saved keys.").text_xs())
                    .children(keys.into_iter().map(|account| {
                        let id = account.id.clone();
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap_3()
                            .py_1()
                            .child(div().flex().items_center().gap_2().child(div().text_size(px(15.)).child(IconName::KeyRound)).child(account.email.clone()).child(muted(account.id.clone()).text_xs()))
                            .child(button(SharedString::from(format!("remove-key-{}", account.id)), "Remove", Some(IconName::Trash), Tone::Danger, !self.busy).when(!self.busy, |this| {
                                this.on_click(cx.listener(move |shell, _, _, cx| {
                                    let id = id.clone();
                                    shell.run_key_command(cx, move |cli| cli.remove(&id));
                                    cx.notify();
                                }))
                            }))
                    }))
                    .when(row.account_label.is_some(), |this| this.child(Input::new(&self.account_id)))
                    .child(Input::new(&self.api_key))
                    .child(div().flex().justify_end().child(button("provider-save-key", if self.busy { "Working…" } else { "Save key" }, Some(IconName::KeyRound), Tone::Primary, !self.busy).when(!self.busy, |this| {
                        this.on_click(cx.listener(move |shell, _, window, cx| {
                            shell.add_api_key_for(provider.clone(), window, cx);
                            cx.notify();
                        }))
                    })))
            }
            _ => connection.child(muted(match row.fix.as_deref() {
                Some(fix) => format!("Connect it from a terminal: {fix}"),
                None => "Connected. Manage its accounts from a terminal.".to_string(),
            })),
        }
        .children((blocked && row.kind == "web").then(|| muted("Browser actions are paused while the API runs, because it uses the same browser profile.").text_xs()));

        let provider = row.id.clone();
        let auto = row.auto;
        let routing = card()
            .p_5()
            .flex()
            .items_center()
            .justify_between()
            .gap_4()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(section_title("Use in auto"))
                    .child(muted("When off, model=auto skips this provider. Requests that name its models still work.").text_xs()),
            )
            .child(switch("provider-auto", auto, !self.busy).when(!self.busy, |this| {
                this.on_click(cx.listener(move |shell, _, _, cx| {
                    let provider = provider.clone();
                    shell.run_command(cx, move |cli| cli.set_auto(&provider, !auto));
                    cx.notify();
                }))
            }));

        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(summary)
            .child(
                div()
                    .flex()
                    .items_start()
                    .when(self.compact, |this| this.flex_col().items_stretch())
                    .gap_4()
                    .child(connection.flex_1().min_w_0())
                    .child(div().flex_1().min_w_0().flex().flex_col().gap_4().child(routing)),
            )
            .child(self.render_provider_models(&row.id, row.auto, row.kind == "api-key", cx))
            .into_any_element()
    }

    fn render_provider_models(&self, provider: &str, provider_auto: bool, checkable: bool, cx: &mut Context<Self>) -> Div {
        let check_id = provider.to_string();
        let heading = div()
            .flex()
            .items_center()
            .justify_between()
            .child(section_title("Models"))
            .when(checkable, |this| {
                this.child(button("provider-check-models", if self.busy { "Working…" } else { "Check models" }, Some(IconName::RefreshCw), Tone::Outline, !self.busy).when(!self.busy, |this| {
                    this.on_click(cx.listener(move |shell, _, _, cx| {
                        shell.check_provider_models(check_id.clone(), cx);
                        cx.notify();
                    }))
                }))
            });
        let Some(status) = &self.status else {
            return card().p_5().flex().flex_col().gap_2().child(heading).child(muted("Run the API to see this provider's models."));
        };
        let mut models: Vec<&str> = status.models.iter().filter(|model| model.provider == provider).map(|model| model.id.as_str()).collect();
        models.sort_by_key(|model| model_rank(status, model));
        let columns: Vec<(&'static str, f32)> = if self.compact {
            vec![("Model", 0.), ("Status", 140.)]
        } else {
            vec![("Model", 0.), ("First answer", 130.), ("In auto", 100.), ("Status", 150.)]
        };
        let rows = models.iter().take(100).map(|model| {
            let stat = status.model_stats.iter().find(|stat| stat.model == *model);
            let hidden = status.unavailable_models.iter().any(|entry| entry.model == *model);
            let (state, label) = if hidden {
                (Activity::Inactive, "Unavailable")
            } else {
                match stat.map(|stat| stat.last_outcome.as_str()) {
                    Some("success") => (Activity::Active, "Working"),
                    Some(_) => (Activity::Degraded, "Failing"),
                    None => (Activity::Unknown, "Not used yet"),
                }
            };
            let in_auto = provider_auto && status.auto_models.iter().any(|entry| entry == model);
            table_row()
                .child(cell(0.).child(model.to_string()))
                .when(!self.compact, |this| {
                    this.child(cell(130.).text_color(col(MUTED)).child(stat.and_then(|stat| stat.latency_ms).map(|ms| format!("{:.1} s", ms as f64 / 1000.)).unwrap_or_else(|| "—".into())))
                        .child(cell(100.).text_color(col(MUTED)).child(if in_auto { "Yes" } else { "—" }))
                })
                .child(cell(if self.compact { 140. } else { 150. }).flex().child(labeled_badge(state, label)))
        });
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(heading.child(muted(format!("{} model{}", models.len(), if models.len() == 1 { "" } else { "s" })).text_xs()))
            .child(
                card()
                    .overflow_hidden()
                    .child(table_header(&columns))
                    .children(rows)
                    .children(models.is_empty().then(|| table_row().child(muted("No models listed for this provider")))),
            )
    }

    fn set_theme(&mut self, theme: ThemeChoice) {
        self.theme = theme;
        if let Err(error) = settings::save(&self.gateway.config.root, &DesktopSettings { theme }) {
            self.message = Some((false, format!("Could not save settings: {error}")));
        }
    }

    fn move_web_chat(&mut self, from: usize, to: usize, cx: &mut Context<Self>) {
        let Some(auto) = self.auto_settings.as_mut() else { return };
        if from >= auto.order.len() || to >= auto.order.len() {
            return;
        }
        auto.order.swap(from, to);
        let order = auto.order.clone();
        self.run_command(cx, move |cli| cli.set_web_order(&order));
    }

    fn choose_web_model(&mut self, chat: String, model: Option<String>, cx: &mut Context<Self>) {
        if let Some(auto) = self.auto_settings.as_mut() {
            auto.models.retain(|(id, _)| *id != chat);
            if let Some(model) = &model {
                auto.models.push((chat.clone(), model.clone()));
            }
        }
        let value = model.unwrap_or_else(|| "fastest".into());
        self.run_command(cx, move |cli| cli.set_web_model(&chat, &value));
    }

    fn render_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let section = |title: &'static str, hint: &'static str| {
            card().p_5().flex().flex_col().gap_3().child(div().flex().flex_col().gap_1().child(section_title(title)).child(muted(hint).text_xs()))
        };
        let themes = [(ThemeChoice::Light, "Light", IconName::Sun), (ThemeChoice::Dark, "Dark", IconName::Moon), (ThemeChoice::System, "System", IconName::Monitor)];
        let theme_row = div().flex().flex_wrap().gap_1().p_1().rounded_full().bg(col(CANVAS)).self_start().children(themes.into_iter().map(|(choice, label, name)| {
            chip(SharedString::from(format!("theme-{label}")), self.theme == choice).child(div().text_size(px(15.)).child(name)).child(label).on_click(cx.listener(move |shell, _, _, cx| {
                shell.set_theme(choice);
                cx.notify();
            }))
        }));
        let auto = self.auto_settings.clone();
        let order = auto.as_ref().map(|auto| auto.order.clone()).unwrap_or_default();
        let last = order.len().saturating_sub(1);
        let order_rows: Vec<Div> = order.iter().enumerate().map(|(index, id)| {
            let arrow = |direction: &'static str, name: IconName, target: Option<usize>, cx: &mut Context<Self>| {
                let enabled = target.is_some() && !self.busy;
                div()
                    .id(SharedString::from(format!("order-{direction}-{id}")))
                    .size(px(30.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .border_1()
                    .border_color(col(BORDER))
                    .text_size(px(14.))
                    .text_color(col(MUTED))
                    .child(name)
                    .when(!enabled, |this| this.opacity(0.35))
                    .when_some(target.filter(|_| enabled), |this, target| {
                        this.cursor_pointer().hover(|style| style.bg(col(HOVER))).on_click(cx.listener(move |shell, _, _, cx| {
                            shell.move_web_chat(index, target, cx);
                            cx.notify();
                        }))
                    })
            };
            let chosen = auto.as_ref().and_then(|auto| auto.models.iter().find(|(chat, _)| chat == id).map(|(_, model)| model.clone()));
            let expanded = self.expanded_chat.as_deref() == Some(id.as_str());
            let toggle_id = id.clone();
            let header = div()
                .flex()
                .items_center()
                .gap_3()
                .child(div().w(px(18.)).text_sm().font_weight(FontWeight::SEMIBOLD).text_color(col(MUTED)).child((index + 1).to_string()))
                .child(provider_mark(id, 26.))
                .child(
                    div()
                        .id(SharedString::from(format!("chat-models-{id}")))
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap_2()
                        .cursor_pointer()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(self.name_of(id)))
                        .child(div().min_w_0().overflow_hidden().text_xs().text_color(col(MUTED)).child(chosen.as_deref().map(|model| model_label(id, model)).unwrap_or_else(|| "Fastest".into())))
                        .child(div().text_size(px(14.)).text_color(col(MUTED)).child(if expanded { IconName::ChevronUp } else { IconName::ChevronDown }))
                        .on_click(cx.listener(move |shell, _, _, cx| {
                            shell.expanded_chat = if shell.expanded_chat.as_deref() == Some(toggle_id.as_str()) { None } else { Some(toggle_id.clone()) };
                            cx.notify();
                        })),
                )
                .child(arrow("up", IconName::ArrowUp, index.checked_sub(1), cx))
                .child(arrow("down", IconName::ArrowDown, (index < last).then_some(index + 1), cx));
            let models: Vec<String> = self.status.as_ref().map(|status| status.models.iter().filter(|model| model.provider == *id).map(|model| model.id.clone()).collect()).unwrap_or_default();
            let choices = expanded.then(|| {
                let options = std::iter::once(None).chain(models.iter().cloned().map(Some)).map(|model| {
                    let active = model == chosen;
                    let label = model.as_deref().map(|model| model_label(id, model)).unwrap_or_else(|| "Fastest".into());
                    let chat = id.clone();
                    let key = model.clone().unwrap_or_else(|| "fastest".into());
                    chip(SharedString::from(format!("pick-{id}-{key}")), active).child(label).when(!self.busy, |this| {
                        this.on_click(cx.listener(move |shell, _, _, cx| {
                            shell.choose_web_model(chat.clone(), model.clone(), cx);
                            cx.notify();
                        }))
                    })
                });
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .pl(px(56.))
                    .child(div().flex().flex_wrap().gap_1().children(options))
                    .children(models.is_empty().then(|| muted("Run the API to list this chat's models.").text_xs()))
            });
            div().flex().flex_col().gap_2().px_3().py_2().rounded_xl().bg(col(CANVAS)).child(header).children(choices)
        }).collect();
        let agent_rows: Vec<Div> = auto.as_ref().map(|auto| auto.agents.clone()).unwrap_or_default().into_iter().map(|(name, on)| {
            let (title, description) = agent_option_text(&name);
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap_4()
                .child(div().flex_1().min_w_0().flex().flex_col().gap_0p5().child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title)).child(muted(description).text_xs()))
                .child(switch(SharedString::from(format!("agent-{name}")), on, !self.busy).when(!self.busy, |this| {
                    this.on_click(cx.listener(move |shell, _, _, cx| {
                        let name = name.clone();
                        shell.run_command(cx, move |cli| cli.set_agent_option(&name, !on));
                        cx.notify();
                    }))
                }))
        }).collect();
        div()
            .flex()
            .flex_col()
            .gap_4()
            .child(section("Theme", "Light, dark, or follow the system appearance.").child(theme_row))
            .child(section("Web chat order", "model=auto tries the web chats from top to bottom, then the API models. Click a chat to pick the model it uses. Applies within about 30 seconds.").child(div().flex().flex_col().gap_2().children(order_rows).children(order.is_empty().then(|| muted("Loading…")))))
            .child(section("Coding agents", "Applied to requests from Claude Code, Codex, pi, OpenCode and other agents that send tools.").children(agent_rows))
            .into_any_element()
    }

    fn render_accounts(&self, cx: &mut Context<Self>, keys_page: bool) -> AnyElement {
        let compact = self.compact;
        let states = self.status.as_ref().map(|status| status.accounts.as_slice()).unwrap_or_default();
        let first_column = if keys_page { "Key" } else { "Account" };
        let columns: Vec<(&'static str, f32)> = if compact {
            vec![(first_column, 0.), ("Status", 150.), ("Action", 120.)]
        } else {
            vec![(first_column, 0.), ("Provider", 140.), ("Status", 150.), ("Failures", 100.), ("Action", 120.)]
        };
        let key_provider_ids = self.key_providers();
        let listed: Vec<&SavedAccount> = self.saved.iter().filter(|account| key_provider_ids.contains(&account.provider) == keys_page).collect();
        let saved_rows = listed.iter().map(|account| {
            let state = states.iter().find(|state| state.account_id == account.id && state.provider == account.provider);
            let (state_activity, state_label) = match state.map(|state| state.status.as_str()) {
                Some("healthy") => (Activity::Active, "Healthy".to_string()),
                Some("cooldown") => (Activity::Degraded, "Cooling down".to_string()),
                Some("quota_exhausted") => (Activity::Degraded, "Quota exhausted".to_string()),
                Some(other) => (Activity::Inactive, other.replace('_', " ")),
                None => (Activity::Unknown, "Saved".to_string()),
            };
            let id = account.id.clone();
            table_row()
                .child(
                    cell(0.)
                        .flex()
                        .items_center()
                        .gap_2p5()
                        .child(provider_mark(&account.provider, 26.))
                        .child(div().flex().flex_col().child(account.email.clone()).child(muted(account.id.clone()).text_xs())),
                )
                .when(!compact, |this| this.child(cell(140.).text_color(col(MUTED)).child(self.name_of(&account.provider).to_string())))
                .child(cell(150.).flex().child(labeled_badge(state_activity, state_label)))
                .when(!compact, |this| {
                    this.child(cell(100.).text_color(col(MUTED)).child(state.map(|state| state.consecutive_failures.to_string()).unwrap_or_else(|| "—".into())))
                })
                .child(cell(120.).child(
                    button(SharedString::from(format!("remove-{}", account.id)), "Remove", Some(IconName::Trash), Tone::Danger, !self.busy).when(!self.busy, |this| {
                        this.on_click(cx.listener(move |shell, _, _, cx| {
                            let id = id.clone();
                            shell.run_key_command(cx, move |cli| cli.remove(&id));
                            cx.notify();
                        }))
                    }),
                ))
        });
        let key_providers = self.key_providers();
        let selected = self.selected_key_provider();
        let provider_pills = key_providers.iter().map(|id| {
            let active = selected.as_deref() == Some(id.as_str());
            let value = id.clone();
            div()
                .id(SharedString::from(format!("key-provider-{id}")))
                .flex()
                .items_center()
                .gap_2()
                .h(px(32.))
                .px_2p5()
                .rounded_full()
                .border_1()
                .border_color(col(if active { PRIMARY } else { BORDER }))
                .bg(col(if active { PRIMARY_SOFT } else { SURFACE }))
                .text_sm()
                .cursor_pointer()
                .child(provider_mark(id, 20.))
                .child(self.name_of(id).to_string())
                .on_click(cx.listener(move |shell, _, _, cx| {
                    shell.key_provider = Some(value.clone());
                    cx.notify();
                }))
        });
        let can_save_key = !self.busy && selected.is_some();
        let blocked = self.browser_blocked();
        let add_card = card()
            .flex_1()
            .min_w_0()
            .p_5()
            .flex()
            .flex_col()
            .gap_3()
            .child(div().flex().items_center().gap_2().child(div().text_size(px(18.)).child(IconName::Users)).child(section_title("Add account")))
            .child(muted("Each account is its own browser profile. Sign it in to Google once, then use “Sign in with Google” on every web chat. Requests rotate between signed-in accounts.").text_xs())
            .child(Input::new(&self.profile_name))
            .child(
                div().flex().justify_end().child(
                    button("add-profile", if self.busy { "Working…" } else { "Add account" }, Some(IconName::Users), Tone::Primary, !self.busy).when(!self.busy, |this| {
                        this.on_click(cx.listener(|shell, _, window, cx| {
                            shell.add_profile(window, cx);
                            cx.notify();
                        }))
                    }),
                ),
            );
        let profile_cards = self.profiles.iter().map(|profile| {
            let signed = profile.chats.iter().filter(|chat| chat.signed_in == Some(true)).count();
            let all = profile.chats.len();
            let connect_id = profile.id.clone();
            let check_id = profile.id.clone();
            let collect_id = profile.id.clone();
            let remove_id = profile.id.clone();
            card()
                .w(px(if compact { 320. } else { 390. }))
                .flex_none()
                .p_5()
                .flex()
                .flex_col()
                .gap_3()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2p5()
                        .child(
                            div()
                                .size(px(34.))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_full()
                                .bg(col(PRIMARY_SOFT))
                                .text_color(col(PRIMARY))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(profile.label.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_default()),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(div().font_weight(FontWeight::SEMIBOLD).child(profile.label.clone()))
                                .child(muted(format!("{signed} of {all} chats signed in")).text_xs()),
                        ),
                )
                .child(div().flex().flex_wrap().gap_2().children(profile.chats.iter().map(|chat| {
                    let state = match chat.signed_in {
                        Some(true) => Activity::Active,
                        Some(false) => Activity::Inactive,
                        None => Activity::Unknown,
                    };
                    div()
                        .flex()
                        .items_center()
                        .gap_1p5()
                        .px_2()
                        .py_1()
                        .rounded_full()
                        .border_1()
                        .border_color(col(BORDER))
                        .text_xs()
                        .child(provider_mark(&chat.id, 18.))
                        .child(self.name_of(&chat.id).trim_end_matches(" Chat").to_string())
                        .child(status_dot(state))
                })))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(button(SharedString::from(format!("connect-{}", profile.id)), "Connect chats", Some(IconName::LogIn), if signed < all { Tone::Primary } else { Tone::Outline }, !blocked).when(!blocked, |this| {
                            this.on_click(cx.listener(move |shell, _, _, cx| {
                                let id = connect_id.clone();
                                shell.message = Some((true, "Sign in to Google and every chat tab in the opened window, then close it.".into()));
                                shell.run_command(cx, move |cli| cli.connect_profile(&id));
                                cx.notify();
                            }))
                        }))
                        .child(button(SharedString::from(format!("check-{}", profile.id)), "Check", Some(IconName::RefreshCw), Tone::Outline, !blocked).when(!blocked, |this| {
                            this.on_click(cx.listener(move |shell, _, _, cx| {
                                let id = check_id.clone();
                                shell.run_command(cx, move |cli| cli.check_profile(&id));
                                cx.notify();
                            }))
                        }))
                        .child(button(SharedString::from(format!("collect-{}", profile.id)), "Auto-collect keys", Some(IconName::KeyRound), Tone::Outline, !blocked).when(!blocked, |this| {
                            this.on_click(cx.listener(move |shell, _, _, cx| {
                                let id = collect_id.clone();
                                shell.message = Some((true, "Signing in to your chats and dashboards, then collecting API keys. This can take several minutes.".into()));
                                shell.run_key_command(cx, move |cli| cli.auto_collect(&id));
                                cx.notify();
                            }))
                        }))
                        .children((profile.id != "default").then(|| {
                            button(SharedString::from(format!("remove-profile-{}", profile.id)), "Remove", Some(IconName::Trash), Tone::Danger, !self.busy).when(!self.busy, |this| {
                                this.on_click(cx.listener(move |shell, _, _, cx| {
                                    let id = remove_id.clone();
                                    shell.run_command(cx, move |cli| cli.remove_profile(&id));
                                    cx.notify();
                                }))
                            })
                        })),
                )
        });
        let key_card = card()
            .flex_1()
            .min_w_0()
            .p_5()
            .flex()
            .flex_col()
            .gap_3()
            .child(div().flex().items_center().gap_2().child(div().text_size(px(18.)).child(IconName::KeyRound)).child(section_title("API keys")))
            .child(muted("Pick a provider. The key is checked and stored encrypted.").text_xs())
            .child(div().flex().flex_wrap().gap_2().children(provider_pills).children(key_providers.is_empty().then(|| muted("Loading providers…"))))
            .child(Input::new(&self.api_key))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_between()
                    .gap_2()
                    .children(selected.clone().and_then(|provider| self.key_page(&provider).map(|url| (provider, url))).map(|(provider, url)| {
                        button("get-key", format!("Get {} key", self.name_of(&provider)), Some(IconName::ExternalLink), Tone::Outline, true).on_click(cx.listener(move |shell, _, _, cx| {
                            shell.open_link(&url);
                            cx.notify();
                        }))
                    }))
                    .child(
                        button("harvest-keys", if self.busy { "Working…" } else { "Get API keys automatically" }, None, Tone::Outline, !self.browser_blocked())
                            .when(!self.browser_blocked(), |this| this.on_click(cx.listener(|shell, _, _, cx| {
                                shell.run_key_command(cx, |cli| cli.harvest());
                                cx.notify();
                            }))),
                    )
                    .child(div().flex_1())
                    .child(
                        button("add-key", if self.busy { "Working…" } else { "Save key" }, Some(IconName::KeyRound), Tone::Primary, can_save_key).when(can_save_key, |this| {
                            this.on_click(cx.listener(|shell, _, window, cx| {
                                shell.add_api_key(window, cx);
                                cx.notify();
                            }))
                        }),
                    ),
            );
        let total = listed.len();
        if !keys_page {
            return div()
                .flex()
                .flex_col()
                .gap_4()
                .child(add_card)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(div().flex().items_center().justify_between().child(section_title("Browser accounts")).child(muted(format!("{} account{}", self.profiles.len(), if self.profiles.len() == 1 { "" } else { "s" })).text_xs()))
                        .child(div().flex().flex_wrap().gap_4().children(profile_cards))
                        .children(blocked.then(|| muted("Connecting and checking open the account's browser profile. Stop the API first, because it uses the same profiles.").text_xs())),
                )
                .children((total > 0).then(|| {
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(section_title("Saved accounts"))
                        .child(card().overflow_hidden().child(table_header(&columns)).children(saved_rows))
                }))
                .into_any_element();
        }
        div()
            .flex()
            .flex_col()
            .gap_4()
            .children(self.registry_locked().then(|| {
                card()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_3()
                    .p_5()
                    .bg(col(WARNING_SOFT))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(section_title("API keys are locked"))
                            .child(muted("Create an encryption secret in the system keyring so API keys can be saved. Restart the API afterwards.").text_xs()),
                    )
                    .child(button("init-secret", "Create secret", Some(IconName::KeyRound), Tone::Primary, !self.busy).when(!self.busy, |this| {
                        this.on_click(cx.listener(|shell, _, _, cx| {
                            shell.run_command(cx, |cli| cli.init_secret());
                            cx.notify();
                        }))
                    }))
            }))
            .child(key_card)
            .child(
                card()
                    .p_5()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(section_title("Custom provider"))
                    .child(muted("Any OpenAI-compatible API: Ollama, LM Studio, vLLM, a company proxy. Use https://, or http:// for localhost. Its models show up as name/model and join auto as a fallback.").text_xs())
                    .child(div().flex().gap_3().when(self.compact, |this| this.flex_col()).child(div().flex_1().child(Input::new(&self.custom_name))).child(div().flex_1().child(Input::new(&self.custom_url))))
                    .child(Input::new(&self.custom_key))
                    .child(div().flex().justify_end().child(button("add-custom", if self.busy { "Working…" } else { "Add provider" }, Some(IconName::Plus), Tone::Primary, !self.busy).when(!self.busy, |this| {
                        this.on_click(cx.listener(|shell, _, window, cx| {
                            shell.add_custom_provider(window, cx);
                            cx.notify();
                        }))
                    }))),
            )
            .child(section_title("Saved keys"))
            .child(
                card()
                    .overflow_hidden()
                    .child(table_header(&columns))
                    .children(saved_rows)
                    .children((total == 0).then(|| table_row().child(muted("No saved keys yet")))),
            )
            .child(muted(format!("Showing {total} saved key{}", if total == 1 { "" } else { "s" })).text_xs())
            .into_any_element()
    }

    fn render_request_stats(&self, status: &GatewayStatus) -> Div {
        let summary = summarize_requests(&status.requests);
        let online = status.providers.iter().filter(|provider| provider.available).count();
        let divider = || div().w(px(1.)).my_4().bg(col(BORDER));
        card()
            .flex()
            .flex_wrap()
            .child(stat_tile("Requests", summary.total.to_string(), None))
            .child(divider())
            .child(stat_tile("Success rate", summary.success_percent.map(|percent| format!("{percent}%")).unwrap_or_else(|| "—".into()), None))
            .child(divider())
            .child(stat_tile("Median first answer", summary.median_latency_ms.map(|ms| format!("{:.1} s", ms as f64 / 1000.)).unwrap_or_else(|| "—".into()), None))
            .child(divider())
            .child(stat_tile("Providers online", format!("{online}"), Some((format!("of {}", status.providers.len()), MUTED))))
    }

    fn render_requests(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(status) = &self.status else {
            return card()
                .p_6()
                .flex()
                .flex_col()
                .items_center()
                .gap_2()
                .child(icon(IconName::Activity, GRAY))
                .child(muted("Start the API to see requests."))
                .into_any_element();
        };
        let compact = self.compact;
        let now = now_ms();
        let mut providers: Vec<(String, usize)> = Vec::new();
        for request in &status.requests {
            match providers.iter_mut().find(|(id, _)| *id == request.provider) {
                Some((_, count)) => *count += 1,
                None => providers.push((request.provider.clone(), 1)),
            }
        }
        let filter = self.request_filter.clone().filter(|id| providers.iter().any(|(provider, _)| provider == id));
        let pill = |id: Option<String>, label: String, count: usize, cx: &mut Context<Self>| {
            let active = filter == id;
            let key = id.clone().unwrap_or_else(|| "all".into());
            chip(SharedString::from(format!("filter-{key}")), active)
                .children(id.as_deref().map(|provider| provider_mark(provider, 20.)))
                .child(label)
                .child(div().text_xs().text_color(col(MUTED)).child(count.to_string()))
                .on_click(cx.listener(move |shell, _, _, cx| {
                    shell.request_filter = id.clone();
                    cx.notify();
                }))
        };
        let pills: Vec<_> = std::iter::once(pill(None, "All".into(), status.requests.len(), cx))
            .chain(providers.iter().map(|(id, count)| pill(Some(id.clone()), self.name_of(id).to_string(), *count, cx)))
            .collect();
        let visible: Vec<_> = status.requests.iter().filter(|request| filter.as_deref().is_none_or(|id| request.provider == id)).take(50).collect();
        let columns: Vec<(&'static str, f32)> = if compact {
            vec![("Time", 90.), ("Model", 0.), ("Status", 120.)]
        } else {
            vec![("Time", 110.), ("Provider", 150.), ("Model", 0.), ("Latency", 100.), ("Status", 130.)]
        };
        let rows = visible.iter().flat_map(|request| {
            let ok = request.status == "success";
            let open = self.open_request.as_ref().is_some_and(|(at, model)| *at == request.created_at && *model == request.model);
            let clicked = (*request).clone();
            let row = table_row()
                .id(SharedString::from(format!("request-{}-{}", request.created_at, request.model)))
                .cursor_pointer()
                .hover(|style| style.bg(col(HOVER)))
                .when(open, |this| this.bg(col(CANVAS)))
                .on_click(cx.listener(move |shell, _, _, cx| {
                    shell.toggle_request(&clicked, cx);
                    cx.notify();
                }))
                .child(cell(if compact { 90. } else { 110. }).text_color(col(MUTED)).child(relative_time(request.created_at, now)))
                .when(!compact, |this| {
                    this.child(cell(150.).flex().items_center().gap_2().child(provider_mark(&request.provider, 20.)).child(self.name_of(&request.provider).to_string()))
                })
                .child(
                    cell(0.)
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .when(compact, |this| this.child(provider_mark(&request.provider, 18.)))
                                .child(request.model.clone()),
                        )
                        .children(request.error.clone().map(|error| div().text_xs().text_color(col(RED)).child(error.chars().take(120).collect::<String>()))),
                )
                .when(!compact, |this| {
                    this.child(cell(100.).text_color(col(MUTED)).child(request.latency_ms.map(|latency| format!("{latency} ms")).unwrap_or_else(|| "—".into())))
                })
                .child(cell(if compact { 120. } else { 130. }).flex().child(labeled_badge(if ok { Activity::Active } else { Activity::Inactive }, if ok { "Success" } else { "Failed" })));
            std::iter::once(row.into_any_element()).chain(open.then(|| self.render_decision().into_any_element()))
        });
        div()
            .flex()
            .flex_col()
            .gap_5()
            .child(self.render_request_stats(status))
            .child(div().flex().flex_wrap().gap_1().children(pills))
            .child(
                card()
                    .overflow_hidden()
                    .child(table_header(&columns))
                    .children(rows)
                    .children(visible.is_empty().then(|| table_row().child(muted("No requests yet")))),
            )
            .child(muted(format!("Showing {} requests", visible.len())).text_xs())
            .into_any_element()
    }
}

fn main() {
    gpui_kit::application().with_assets(assets::AppAssets).run(|cx| {
        gpui_kit::init(cx);
        Theme::change(ThemeMode::Light, None, cx);
        if let Err(error) = cx.text_system().add_fonts(assets::fonts()) {
            eprintln!("Failed to load fonts: {error}");
        }
        Theme::global_mut(cx).font_family = assets::FONT_FAMILY.into();
        let bounds = Bounds::centered(None, size(px(1180.), px(760.)), cx);
        cx.on_window_closed(|cx, _| cx.quit()).detach();
        cx.spawn(async move |cx| {
            let options = WindowOptions {
                titlebar: Some(TitlebarOptions { title: Some("Switchyard".into()), ..Default::default() }),
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            };
            cx.open_window(options, |window, cx| {
                let view = cx.new(|cx| Shell::new(window, cx));
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("failed to open window");
        })
        .detach();
    });
}
