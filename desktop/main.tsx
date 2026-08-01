import React from "react";
import { createRoot } from "react-dom/client";
import { DeveloperPulse } from "../app/DeveloperPulse";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DeveloperPulse />
  </React.StrictMode>,
);
