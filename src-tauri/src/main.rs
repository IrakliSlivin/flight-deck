// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Run under XWayland on Linux: on native Wayland the Outlook window's title-bar X only worked
    // intermittently, and its invisible warm-up (outlook.rs) needs X11. This overrides an inherited
    // GDK_BACKEND (the Claude desktop app passes GDK_BACKEND=wayland to its terminals);
    // FLIGHT_DECK_WAYLAND=1 opts out.
    #[cfg(target_os = "linux")]
    if std::env::var_os("FLIGHT_DECK_WAYLAND").is_none() {
        // Safe: nothing else is running yet, so no other thread can be reading the environment.
        unsafe { std::env::set_var("GDK_BACKEND", "x11") };
    }
    flight_deck_lib::run()
}
