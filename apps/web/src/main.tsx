import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource-variable/figtree";
import "./styles/tokens.css";
import "./styles/base.css";

import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import Landing from "./landing/Landing.tsx";
import { useLocation } from "./lib/router.tsx";

const Board = lazy(() => import("./board/Board.tsx"));

document.documentElement.classList.add("js");

function App() {
  const { path } = useLocation();
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {path === "/app" ? (
        <Suspense fallback={<div className="board-loading" aria-busy="true" />}>
          <Board />
        </Suspense>
      ) : (
        <Landing />
      )}
      <div className="grain" aria-hidden="true" />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
