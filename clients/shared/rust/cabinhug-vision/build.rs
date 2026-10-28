//! 内置检测器权重是否在本树。
//!
//! `models/indicator-yolo11n.onnx` 以 AGPL-3.0 的 `yolo11n.pt` 为起点训练（THIRD-PARTY.md §4），
//! 可能不在本树。文件在时设 `builtin_model`，`include_bytes!` 照常把它编进二进制；
//! 不在时不设，照样能编译，
//! `Detector::builtin()` 返回错误，两端按"检测失败"处理：照片不带框发送，由服务端定位。

use std::path::Path;

const BUILTIN_MODEL: &str = "models/indicator-yolo11n.onnx";

fn main() {
    println!("cargo::rustc-check-cfg=cfg(builtin_model)");
    // 盯目录而不是文件：文件从无到有时目录的 mtime 会变，盯一个不存在的文件则每次都重跑
    println!("cargo::rerun-if-changed=models");
    if Path::new(BUILTIN_MODEL).exists() {
        println!("cargo::rustc-cfg=builtin_model");
    }
}
