fn main() {
    // tauri_build 只把 tauri.conf.json 与 capabilities 声明为重编触发条件，不含
    // frontendDist；而 `generate_context!` 在编译期把 ../dist 嵌进二进制。
    // 不声明这一行，前端重新构建后 cargo 不重编，二进制里保留旧界面。
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
