import { useEffect, useState } from "react";
import TimelineLine from "./components/TimelineLine";

type Health = { status: string; app: string; photosFolder: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setError(true));
  }, []);

  return (
    <main className="home">
      <header className="home__header">
        <h1 className="wordmark">lifetime</h1>
      </header>

      <section className="home__stage">
        <TimelineLine />
        <p className="home__empty">
          No rolls yet. Add a folder of photos to your rolls directory to place
          the first point on your timeline.
        </p>
      </section>

      <footer className="home__footer">
        <span className={`status ${error ? "status--down" : health ? "status--up" : ""}`}>
          {error ? "api unreachable" : health ? "api connected" : "connecting"}
        </span>
      </footer>
    </main>
  );
}
