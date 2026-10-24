import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ClientProvider } from "./hooks";
import { createClient } from "./services";
import "./index.css";
import { BrowserAccessProvider } from "./services/browserAccess";

const client = createClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClientProvider client={client}>
      <BrowserAccessProvider client={client}><App /></BrowserAccessProvider>
    </ClientProvider>
  </StrictMode>,
);
