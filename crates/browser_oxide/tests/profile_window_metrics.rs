//! A desktop profile's window has to fit inside the screen it claims to be on.
//!
//! Every desktop preset shipped `outer_height == screen_height`, i.e. a window
//! covering the menu bar or taskbar that `screen_avail_height` says is there.
//! Real windows cannot do that, and the mismatch is one boolean in creepjs's
//! headless score — `innerWidth === screen.width && outerHeight === screen.height`
//! reads as "no browser chrome around this viewport".
//!
//! The numbers themselves belong to the fingerprint; this only checks they agree
//! with each other.

use browser_oxide::stealth::presets;
use browser_oxide::stealth::StealthProfile;

fn desktop_profiles() -> Vec<(&'static str, StealthProfile)> {
    vec![
        ("chrome_148_windows", presets::chrome_148_windows()),
        ("chrome_148_macos", presets::chrome_148_macos()),
        ("chrome_148_linux", presets::chrome_148_linux()),
        ("chrome_148_ru", presets::chrome_148_ru()),
        ("chrome_148_cn", presets::chrome_148_cn()),
        ("chrome_148_de", presets::chrome_148_de()),
        ("chrome_148_jp", presets::chrome_148_jp()),
        ("firefox_135_macos", presets::firefox_135_macos()),
        ("firefox_135_windows", presets::firefox_135_windows()),
        ("firefox_135_linux", presets::firefox_135_linux()),
    ]
}

#[test]
fn the_window_fits_inside_the_available_screen_area() {
    for (name, p) in desktop_profiles() {
        assert!(
            p.screen_avail_height <= p.screen_height,
            "{name}: доступная высота больше экрана"
        );
        assert!(
            p.outer_height <= p.screen_avail_height,
            "{name}: окно {} выше доступной области {} — так не бывает, \
             и это ровно тот признак, по которому считают отсутствие обвязки браузера",
            p.outer_height,
            p.screen_avail_height
        );
        assert!(
            p.outer_width <= p.screen_avail_width,
            "{name}: окно шире доступной области"
        );
    }
}

#[test]
fn the_viewport_is_smaller_than_the_window_that_holds_it() {
    for (name, p) in desktop_profiles() {
        assert!(
            p.inner_height < p.outer_height,
            "{name}: у окна нет обвязки — inner {} против outer {}",
            p.inner_height,
            p.outer_height
        );
        assert!(p.inner_width <= p.outer_width, "{name}: вьюпорт шире окна");
    }
}
