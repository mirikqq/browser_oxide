//! A desktop window for the BrowserOxide engine.
//!
//! An address bar and the page as the engine paints it — not as a browser would:
//! the picture comes from `Page::screenshot`, drawn from the engine's own layout,
//! so it shows what the engine believes about the page, including where layout is
//! still approximate (see `docs/GUI_PLAN.md`, milestone M1). The page is static:
//! there is no input path from this window into the page yet.
//!
//! The engine is `!Send`, so it lives on the thread `EngineHandle` gives it. The
//! window never calls it directly: a worker thread does the (blocking) navigation
//! and painting and hands finished bitmaps back, so the UI stays responsive
//! while a page loads.

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};

use browser_oxide::host::EngineHandle;
use browser_oxide::paint::Bitmap;
use browser_oxide::stealth::presets::chrome_148_macos;
use eframe::egui;

/// What the address bar can be asked to open.
#[derive(Debug, PartialEq)]
enum Target {
    Url(String),
    File(PathBuf),
}

/// Turn what was typed into something to open.
fn resolve_target(input: &str) -> Result<Target, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("type a URL or a path to an .html file".into());
    }
    if input.starts_with("http://") || input.starts_with("https://") {
        return Ok(Target::Url(input.to_string()));
    }
    if let Some(rest) = input.strip_prefix("file://") {
        // `file:///C:/x.html` carries a leading slash the drive letter does not want.
        let rest = rest
            .strip_prefix('/')
            .filter(|r| r.contains(':'))
            .unwrap_or(rest);
        return Ok(Target::File(PathBuf::from(rest)));
    }
    let path = PathBuf::from(input);
    if path.is_file() {
        return Ok(Target::File(path));
    }
    if !input.contains(char::is_whitespace) && input.contains('.') {
        return Ok(Target::Url(format!("https://{input}")));
    }
    Err(format!("'{input}' is neither a URL nor an existing file"))
}

enum Request {
    Open(String),
    /// Paint the page that is already loaded again.
    Repaint {
        full_page: bool,
    },
}

struct Loaded {
    url: String,
    title: String,
    verdict: String,
    bitmap: Bitmap,
}

enum Event {
    Loading(String),
    Loaded(Box<Loaded>),
    Failed(String),
}

/// Owns the engine thread and does the blocking work for the window.
fn worker(requests: Receiver<Request>, events: Sender<Event>, ctx: egui::Context, full_page: bool) {
    let engine = EngineHandle::spawn();
    let send = |event: Event| {
        let _ = events.send(event);
        ctx.request_repaint();
    };
    let mut full_page = full_page;

    for request in requests {
        let snapshot = match request {
            Request::Open(input) => {
                send(Event::Loading(input.clone()));
                let target = match resolve_target(&input) {
                    Ok(t) => t,
                    Err(e) => {
                        send(Event::Failed(e));
                        continue;
                    }
                };
                let loaded = match target {
                    Target::Url(url) => engine.navigate(&url, chrome_148_macos(), 5),
                    Target::File(path) => match std::fs::read_to_string(&path) {
                        Ok(html) => {
                            let url = format!(
                                "file:///{}",
                                path.canonicalize()
                                    .unwrap_or(path)
                                    .display()
                                    .to_string()
                                    .trim_start_matches(r"\\?\")
                                    .replace('\\', "/")
                            );
                            engine.load_html(&html, &url, chrome_148_macos())
                        }
                        Err(e) => {
                            send(Event::Failed(format!(
                                "cannot read {}: {e}",
                                path.display()
                            )));
                            continue;
                        }
                    },
                };
                match loaded {
                    Ok(snap) => snap,
                    Err(e) => {
                        send(Event::Failed(e.to_string()));
                        continue;
                    }
                }
            }
            Request::Repaint { full_page: f } => {
                full_page = f;
                // Nothing new is fetched; only the picture changes.
                match engine.screenshot(full_page) {
                    Ok(bitmap) => {
                        let url = engine.evaluate("location.href").unwrap_or_default();
                        let title = engine.evaluate("document.title").unwrap_or_default();
                        send(Event::Loaded(Box::new(Loaded {
                            url,
                            title,
                            verdict: String::new(),
                            bitmap,
                        })));
                    }
                    Err(e) => send(Event::Failed(e.to_string())),
                }
                continue;
            }
        };
        match engine.screenshot(full_page) {
            Ok(bitmap) => send(Event::Loaded(Box::new(Loaded {
                url: snapshot.url,
                title: snapshot.title,
                verdict: snapshot.verdict,
                bitmap,
            }))),
            Err(e) => send(Event::Failed(e.to_string())),
        }
    }
}

/// One horizontal slice of the page picture, as tall as a GPU texture may be.
struct Tile {
    texture: egui::TextureHandle,
    size: [usize; 2],
}

struct App {
    requests: Sender<Request>,
    events: Receiver<Event>,
    address: String,
    tiles: Vec<Tile>,
    status: String,
    busy: bool,
    full_page: bool,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>, initial: Option<String>) -> Self {
        let (req_tx, req_rx) = channel();
        let (ev_tx, ev_rx) = channel();
        let ctx = cc.egui_ctx.clone();
        std::thread::Builder::new()
            .name("browser-oxide-shell-worker".into())
            .spawn(move || worker(req_rx, ev_tx, ctx, true))
            .expect("failed to spawn the engine worker");
        let mut app = Self {
            requests: req_tx,
            events: ev_rx,
            address: initial.clone().unwrap_or_default(),
            tiles: Vec::new(),
            status: "Type a URL or a path to an .html file".into(),
            busy: false,
            full_page: true,
        };
        if let Some(target) = initial {
            app.open(target);
        }
        app
    }

    fn open(&mut self, target: String) {
        self.busy = true;
        let _ = self.requests.send(Request::Open(target));
    }

    fn drain_events(&mut self, ctx: &egui::Context) {
        while let Ok(event) = self.events.try_recv() {
            match event {
                Event::Loading(target) => {
                    self.busy = true;
                    self.status = format!("Loading {target} ...");
                }
                Event::Failed(message) => {
                    self.busy = false;
                    self.status = format!("Error: {message}");
                }
                Event::Loaded(loaded) => {
                    self.busy = false;
                    self.address = loaded.url.clone();
                    let (w, h) = (loaded.bitmap.width, loaded.bitmap.height);
                    self.status = format!(
                        "{}  -  {w}x{h}  -  painted by the engine{}",
                        loaded.url,
                        if loaded.verdict.is_empty() {
                            String::new()
                        } else {
                            format!("  -  verdict: {}", loaded.verdict)
                        }
                    );
                    ctx.send_viewport_cmd(egui::ViewportCommand::Title(
                        if loaded.title.is_empty() {
                            "BrowserOxide".into()
                        } else {
                            format!("{} - BrowserOxide", loaded.title)
                        },
                    ));
                    self.tiles = tiles_of(ctx, &loaded.bitmap);
                }
            }
        }
    }
}

/// Upload `bitmap` as textures no taller than the GPU allows.
fn tiles_of(ctx: &egui::Context, bitmap: &Bitmap) -> Vec<Tile> {
    let max_side = ctx.input(|i| i.max_texture_side).max(1);
    let (w, h) = (bitmap.width as usize, bitmap.height as usize);
    let row_bytes = w * 4;
    let mut tiles = Vec::new();
    let mut top = 0;
    while top < h {
        let rows = max_side.min(h - top);
        let slice = &bitmap.rgba[top * row_bytes..(top + rows) * row_bytes];
        let image = egui::ColorImage::from_rgba_unmultiplied([w, rows], slice);
        tiles.push(Tile {
            texture: ctx.load_texture(format!("page-{top}"), image, egui::TextureOptions::LINEAR),
            size: [w, rows],
        });
        top += rows;
    }
    tiles
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.drain_events(&ctx);

        egui::Panel::top("toolbar").show(ui, |ui| {
            ui.horizontal(|ui| {
                let reload = ui.add_enabled(!self.busy, egui::Button::new("Reload"));
                let edit = ui.add(
                    egui::TextEdit::singleline(&mut self.address)
                        .hint_text("https://example.com  or  C:\\path\\page.html")
                        .desired_width((ui.available_width() - 200.0).max(80.0)),
                );
                let go = ui.add_enabled(!self.busy, egui::Button::new("Go"));
                let entered = edit.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                if (go.clicked() || entered || reload.clicked()) && !self.busy {
                    let target = self.address.clone();
                    self.open(target);
                }
                if ui.checkbox(&mut self.full_page, "Full page").changed() {
                    let _ = self.requests.send(Request::Repaint {
                        full_page: self.full_page,
                    });
                }
            });
        });
        egui::Panel::bottom("status").show(ui, |ui| {
            ui.horizontal(|ui| {
                if self.busy {
                    ui.spinner();
                }
                ui.label(&self.status);
            });
        });
        egui::CentralPanel::default().show(ui, |ui| {
            egui::ScrollArea::both().auto_shrink(false).show(ui, |ui| {
                ui.spacing_mut().item_spacing = egui::Vec2::ZERO;
                // One texel per physical pixel, so the engine's output is not resampled.
                let scale = 1.0 / ctx.pixels_per_point();
                for tile in &self.tiles {
                    let size = egui::vec2(tile.size[0] as f32 * scale, tile.size[1] as f32 * scale);
                    ui.image((tile.texture.id(), size));
                }
            });
        });
    }
}

fn main() -> eframe::Result {
    let initial = std::env::args().nth(1);
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("BrowserOxide")
            .with_inner_size([1200.0, 800.0]),
        ..Default::default()
    };
    eframe::run_native(
        "BrowserOxide",
        options,
        Box::new(|cc| Ok(Box::new(App::new(cc, initial)))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_urls_pass_through() {
        assert_eq!(
            resolve_target("  https://example.com/a?b=1 "),
            Ok(Target::Url("https://example.com/a?b=1".into()))
        );
    }

    #[test]
    fn a_bare_host_gets_https() {
        assert_eq!(
            resolve_target("example.com"),
            Ok(Target::Url("https://example.com".into()))
        );
    }

    #[test]
    fn free_text_is_rejected() {
        assert!(resolve_target("what is a browser").is_err());
        assert!(resolve_target("   ").is_err());
    }

    #[test]
    fn an_existing_file_is_opened_as_a_file() {
        let path = std::env::temp_dir().join("browser_oxide_shell_resolve_test.html");
        std::fs::write(&path, "<p>x</p>").unwrap();
        let typed = path.display().to_string();
        assert_eq!(resolve_target(&typed), Ok(Target::File(path.clone())));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn file_urls_lose_the_leading_slash_before_a_drive() {
        assert_eq!(
            resolve_target("file:///C:/site/index.html"),
            Ok(Target::File(PathBuf::from("C:/site/index.html")))
        );
        assert_eq!(
            resolve_target("file:///home/u/index.html"),
            Ok(Target::File(PathBuf::from("/home/u/index.html")))
        );
    }
}
