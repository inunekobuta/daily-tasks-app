import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css"; // ← これが存在しないと TS2307 で落ちる

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
