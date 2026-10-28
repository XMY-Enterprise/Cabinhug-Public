fn main() {
    // 同两个端：tauri_build 不把 frontendDist 声明成重编触发条件，补上这一行，
    // 否则前端改了、vite build 也跑了，release 客户端里还是上一版界面。
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
