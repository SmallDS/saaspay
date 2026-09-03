import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "@puckeditor/core/puck.css";
import "./styles.css";
import { AdminApp } from "./admin/AdminApp";
import { PublicApp } from "./public/PublicApp";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
const initialPageHeading = root.querySelector("[data-page-heading]")?.textContent ?? "";

createRoot(root).render(
  <StrictMode>
    {location.pathname.startsWith("/admin") ? <AdminApp /> : <PublicApp initialPageHeading={initialPageHeading} />}
  </StrictMode>,
);
