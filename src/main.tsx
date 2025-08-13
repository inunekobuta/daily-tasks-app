import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css"; // ← 存在必須（TS2307対策）

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
