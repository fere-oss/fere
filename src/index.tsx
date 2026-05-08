import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/electron/renderer";
import "./index.css";
import App from "./App";

const sentryDsn = process.env.REACT_APP_SENTRY_DSN;
if (sentryDsn && process.env.NODE_ENV === "production") {
  Sentry.init({ dsn: sentryDsn, environment: "production" });
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
