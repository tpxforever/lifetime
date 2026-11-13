import { useEffect, useState } from "react";

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
      <h1>lifetime</h1>
      <p className="status">
        {error ? "api unreachable" : health ? `api ${health.status}` : "connecting…"}
      </p>
    </main>
  );
}
