import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ClientProvider } from "./hooks";
import { createClient } from "./services";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClientProvider client={createClient()}>
      <App />
    </ClientProvider>
  </StrictMode>,
);
