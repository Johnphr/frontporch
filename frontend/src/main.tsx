import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App";
import "./index.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const root = ReactDOM.createRoot(document.getElementById("root")!);

if (!convexUrl) {
  root.render(
    <main className="page">
      <div className="card empty">
        <h2>Almost there</h2>
        <p>
          Set <code>VITE_CONVEX_URL</code> in <code>frontend/.env.local</code> (run{" "}
          <code>npx convex dev</code> to get it), then restart <code>npm run dev</code>.
        </p>
      </div>
    </main>,
  );
} else {
  const convex = new ConvexReactClient(convexUrl);
  root.render(
    <React.StrictMode>
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    </React.StrictMode>,
  );
}
