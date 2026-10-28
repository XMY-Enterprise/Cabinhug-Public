import React from "react";
import { createRoot } from "react-dom/client";

import "@cabinhug/ui/styles";
import "./styles/tokens.css";
import "./styles/base.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
