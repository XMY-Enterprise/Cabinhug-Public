// web — 后台 / Demo 入口
//
// §2.3：Web 端不使用 HUD，直接是功能页面——管理后台不需要"车内伙伴"人设。
// 这里不引入 assistant-avatar，也不引入任何语音能力。

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { migrateLegacyConsoleStorage } from "./api/legacy-storage";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// 旧 carlife.console.* 存储键拷到新键名（ACR-051），先于任何读取。
migrateLegacyConsoleStorage();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
