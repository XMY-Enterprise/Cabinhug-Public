// 单机版桌面应用入口。装配全在 lib.rs 的 `run()`。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    standalone_app_lib::run();
}
