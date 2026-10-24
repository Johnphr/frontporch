import { useEffect, useState } from "react";
import Feed from "./pages/Feed";
import AnswerPage from "./pages/AnswerPage";
import Dashboard from "./pages/Dashboard";

type Route = { name: "feed" } | { name: "answer"; id: string } | { name: "dashboard" };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  const answer = path.match(/^\/answer\/([^/]+)/);
  if (answer) return { name: "answer", id: decodeURIComponent(answer[1]) };
  if (path.startsWith("/dashboard")) return { name: "dashboard" };
  return { name: "feed" };
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return (
    <>
      <header className="site-header">
        <a href="#/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            ☕
          </span>
          Front Porch
        </a>
        <nav>
          <a href="#/" className={route.name !== "dashboard" ? "active" : ""}>
            Answers
          </a>
          <a href="#/dashboard" className={route.name === "dashboard" ? "active" : ""}>
            Dashboard
          </a>
        </nav>
      </header>
      {route.name === "feed" && <Feed />}
      {route.name === "answer" && <AnswerPage id={route.id} />}
      {route.name === "dashboard" && <Dashboard />}
    </>
  );
}
