/// Virtual viewport configuration.
#[derive(Debug, Clone, Copy)]
pub struct Viewport {
    pub width: f32,
    pub height: f32,
    pub device_pixel_ratio: f32,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            width: 1920.0,
            height: 1080.0,
            device_pixel_ratio: 1.0,
        }
    }
}

impl Viewport {
    /// A viewport at the default 1x density.
    ///
    /// Prefer [`Viewport::with_dpr`] wherever a stealth profile is in hand:
    /// leaving the ratio at 1 while the profile tells the page it is 2 makes
    /// `devicePixelRatio`, media queries and the render surface disagree with
    /// each other, and the disagreement is visible from script.
    pub fn new(width: f32, height: f32) -> Self {
        Self {
            width,
            height,
            device_pixel_ratio: 1.0,
        }
    }

    /// A viewport whose density comes from the profile the page is shown.
    pub fn with_dpr(width: f32, height: f32, device_pixel_ratio: f32) -> Self {
        Self {
            width,
            height,
            device_pixel_ratio: if device_pixel_ratio > 0.0 {
                device_pixel_ratio
            } else {
                1.0
            },
        }
    }
}
