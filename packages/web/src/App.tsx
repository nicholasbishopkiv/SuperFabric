import { useEffect } from "react";
import { useFabric } from "./store";
import { connect } from "./wsClient";

// Placeholder shell: the M0 console lands in Task 13.
export default function App() {
  const connected = useFabric((s) => s.connected);
  const sessions = useFabric((s) => s.sessions);

  useEffect(() => {
    connect();
  }, []);

  return (
    <div style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>SuperFabric — M0 console</h1>
      <p>{connected ? "connected" : "reconnecting…"}</p>
      <p>{sessions.length} session(s)</p>
    </div>
  );
}
