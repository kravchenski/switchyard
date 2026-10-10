use gpui_kit::assets::IconName;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use std::sync::atomic::{AtomicBool, Ordering};

use crate::assets::logo_path;
use crate::overview::Activity;

pub const CANVAS: u32 = 0xeef0f3;
pub const SURFACE: u32 = 0xffffff;
pub const BORDER: u32 = 0xe4e6ea;
pub const TEXT: u32 = 0x14161a;
pub const MUTED: u32 = 0x717784;
pub const PRIMARY: u32 = 0x1f7a4d;
pub const PRIMARY_SOFT: u32 = 0xe6f2ec;
pub const GREEN: u32 = 0x16a34a;
pub const AMBER: u32 = 0xd97706;
pub const RED: u32 = 0xdc2626;
pub const GRAY: u32 = 0x9ca3af;

pub const HOVER: u32 = 0xe6e8ec;
pub const WARNING_SOFT: u32 = 0xfdf4e3;
pub const DANGER_SOFT: u32 = 0xfdeeee;
pub const NEUTRAL_SOFT: u32 = 0xf1f2f4;
pub const SWITCH_OFF: u32 = 0xd1d5db;
const SUCCESS_TEXT: u32 = 0x15803d;
const WARNING_TEXT: u32 = 0xb45309;
const DANGER_TEXT: u32 = 0xc81e1e;
const WHITE: u32 = 0xffffff;

static DARK: AtomicBool = AtomicBool::new(false);

pub fn set_dark(dark: bool) {
    DARK.store(dark, Ordering::Relaxed);
}

pub fn is_dark() -> bool {
    DARK.load(Ordering::Relaxed)
}

fn dark_variant(hex: u32) -> u32 {
    match hex {
        SURFACE => 0x171a1f,
        CANVAS => 0x0d0f12,
        BORDER => 0x272b32,
        TEXT => 0xe8eaed,
        MUTED => 0x9aa1ac,
        PRIMARY => 0x34a873,
        PRIMARY_SOFT => 0x132b1f,
        HOVER => 0x1e2228,
        WARNING_SOFT => 0x2b2310,
        DANGER_SOFT => 0x2e1517,
        NEUTRAL_SOFT => 0x1e2228,
        SWITCH_OFF => 0x3b414a,
        SUCCESS_TEXT => 0x4ade80,
        WARNING_TEXT => 0xfbbf24,
        DANGER_TEXT => 0xf87171,
        other => other,
    }
}

pub fn col(hex: u32) -> Rgba {
    rgb(if is_dark() { dark_variant(hex) } else { hex })
}

pub fn activity_color(activity: Activity) -> u32 {
    match activity {
        Activity::Active => GREEN,
        Activity::Degraded => AMBER,
        Activity::Inactive => RED,
        Activity::Unknown | Activity::NotConnected => GRAY,
    }
}

fn activity_tint(activity: Activity) -> (u32, u32) {
    match activity {
        Activity::Active => (PRIMARY_SOFT, SUCCESS_TEXT),
        Activity::Degraded => (WARNING_SOFT, WARNING_TEXT),
        Activity::Inactive => (DANGER_SOFT, DANGER_TEXT),
        Activity::Unknown | Activity::NotConnected => (NEUTRAL_SOFT, MUTED),
    }
}

pub fn provider_mark(id: &str, size: f32) -> Div {
    let frame = div()
        .size(px(size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(size * 0.3))
        .border_1()
        .border_color(col(BORDER))
        .bg(rgb(WHITE));
    match logo_path(id) {
        Some(path) => frame.child(img(path).size(px(size * 0.62))),
        None => frame.text_color(col(MUTED)).text_size(px(size * 0.45)).child("?"),
    }
}

pub fn status_dot(activity: Activity) -> Div {
    div().size(px(8.)).flex_none().rounded_full().bg(col(activity_color(activity)))
}

pub fn status_badge(activity: Activity) -> Div {
    labeled_badge(activity, activity.label())
}

pub fn labeled_badge(activity: Activity, label: impl Into<SharedString>) -> Div {
    let (bg, fg) = activity_tint(activity);
    div()
        .flex()
        .flex_none()
        .items_center()
        .px_2()
        .py_0p5()
        .rounded_md()
        .bg(col(bg))
        .text_xs()
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(col(fg))
        .child(label.into())
}

pub fn switch(id: impl Into<SharedString>, on: bool, enabled: bool) -> Stateful<Div> {
    div()
        .id(id.into())
        .w(px(44.))
        .h(px(24.))
        .flex_none()
        .flex()
        .items_center()
        .px(px(3.))
        .rounded_full()
        .bg(col(if on { PRIMARY } else { SWITCH_OFF }))
        .when(on, |this| this.justify_end())
        .when(!enabled, |this| this.opacity(0.5))
        .when(enabled, |this| this.cursor_pointer())
        .child(div().size(px(18.)).rounded_full().bg(rgb(WHITE)).shadow_sm())
}

pub fn card() -> Div {
    div().rounded(px(16.)).border_1().border_color(col(BORDER)).bg(col(SURFACE)).shadow_xs()
}

pub fn section_title(title: impl Into<SharedString>) -> Div {
    div().text_base().font_weight(FontWeight::SEMIBOLD).child(title.into())
}

pub fn table_header(columns: &[(&'static str, f32)]) -> Div {
    div()
        .flex()
        .items_center()
        .h(px(40.))
        .px_5()
        .border_b_1()
        .border_color(col(BORDER))
        .text_size(px(11.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(col(MUTED))
        .children(columns.iter().map(|(title, width)| cell(*width).child(title.to_uppercase())))
}

pub fn table_row() -> Div {
    div()
        .flex()
        .items_center()
        .min_h(px(54.))
        .px_5()
        .border_b_1()
        .border_color(col(BORDER))
        .text_sm()
        .text_color(col(TEXT))
}

pub fn cell(width: f32) -> Div {
    if width > 0. {
        div().w(px(width)).flex_none().pr_3().overflow_hidden()
    } else {
        div().flex_1().min_w_0().pr_3().overflow_hidden()
    }
}

pub fn muted(text: impl Into<SharedString>) -> Div {
    div().text_sm().text_color(col(MUTED)).child(text.into())
}

pub fn icon(name: IconName, color: u32) -> Div {
    div().flex_none().text_color(col(color)).text_size(px(16.)).child(name)
}

pub enum Tone {
    Primary,
    Outline,
    Danger,
}

pub fn button(id: impl Into<ElementId>, label: impl Into<SharedString>, leading: Option<IconName>, tone: Tone, enabled: bool) -> Stateful<Div> {
    let (bg, fg, border) = match tone {
        Tone::Primary => (PRIMARY, WHITE, PRIMARY),
        Tone::Outline => (SURFACE, TEXT, BORDER),
        Tone::Danger => (SURFACE, RED, BORDER),
    };
    let fg = if matches!(tone, Tone::Primary) { rgb(WHITE) } else { col(fg) };
    div()
        .id(id.into())
        .flex()
        .flex_none()
        .items_center()
        .gap_2()
        .h(px(36.))
        .px_4()
        .rounded_full()
        .border_1()
        .border_color(col(border))
        .bg(col(bg))
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .when(matches!(tone, Tone::Primary), |this| this.shadow_sm())
        .when(!enabled, |this| this.opacity(0.45))
        .when(enabled, |this| this.cursor_pointer().hover(|style| style.opacity(0.85)))
        .children(leading.map(|name| div().text_size(px(15.)).child(name)))
        .child(label.into())
}

pub fn chip(id: impl Into<ElementId>, active: bool) -> Stateful<Div> {
    div()
        .id(id.into())
        .flex()
        .flex_none()
        .items_center()
        .gap_2()
        .h(px(34.))
        .px_3p5()
        .rounded_full()
        .border_1()
        .text_sm()
        .cursor_pointer()
        .when(active, |this| this.bg(col(SURFACE)).border_color(col(BORDER)).shadow_xs().font_weight(FontWeight::MEDIUM).text_color(col(TEXT)))
        .when(!active, |this| this.border_color(gpui_kit::transparent_black()).text_color(col(MUTED)).hover(|style| style.bg(col(HOVER))))
}

pub fn stat_tile(label: &'static str, value: impl Into<SharedString>, note: Option<(String, u32)>) -> Div {
    div()
        .flex_1()
        .min_w(px(140.))
        .flex()
        .flex_col()
        .gap_1()
        .px_5()
        .py_4()
        .child(div().text_xs().text_color(col(MUTED)).child(label))
        .child(
            div()
                .flex()
                .items_baseline()
                .gap_2()
                .child(div().text_2xl().font_weight(FontWeight::SEMIBOLD).child(value.into()))
                .children(note.map(|(text, color)| div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(col(color)).child(text))),
        )
}

pub fn nav_item(id: impl Into<ElementId>, name: IconName, label: &'static str, selected: bool) -> Stateful<Div> {
    div()
        .id(id.into())
        .flex()
        .items_center()
        .gap_2p5()
        .h(px(38.))
        .px_3()
        .rounded_xl()
        .text_sm()
        .cursor_pointer()
        .text_color(col(if selected { TEXT } else { MUTED }))
        .when(selected, |this| this.bg(col(SURFACE)).shadow_sm().font_weight(FontWeight::MEDIUM))
        .when(!selected, |this| this.hover(|style| style.bg(col(HOVER))))
        .child(div().text_size(px(16.)).child(name))
        .child(label)
}
