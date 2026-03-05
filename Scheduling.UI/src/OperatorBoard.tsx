import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

type WorkCenter = { WorkCenterId: number; WorkCenterName: string };

type OperatorEvent = {
  scheduleEventId: number;
  title: string;
  plannedStartLocal: string;
  plannedEndLocal: string;
  status: number; // 0=Scheduled, 1=InProgress, 2=Done
  actualStartLocal: string | null;
  actualEndLocal: string | null;
  operationId: number;
  workOrderHeaderId: number;
  customer: string | null;
  inputMaterial: string | null;
  size: string | null;
};

const apiBase = import.meta.env.VITE_API_BASE as string;

function toLocalSqlDateTimeString(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function statusLabel(s: number) {
  if (s === 1) return "IN PROGRESS";
  if (s === 2) return "DONE";
  return "SCHEDULED";
}

function statusStyles(s: number): React.CSSProperties {
  if (s === 1) return { border: "2px solid #b45309", background: "#fff7ed" }; // amber-ish
  if (s === 2) return { border: "2px solid #166534", background: "#f0fdf4" }; // green-ish
  return { border: "1px solid #ccc", background: "#fff" };
}

export default function OperatorBoard() {
  const { workCenterId: wcParam } = useParams();
  const workCenterId = Number(wcParam);

  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [events, setEvents] = useState<OperatorEvent[]>([]);
  const [status, setStatus] = useState<string>("");

  const wc = useMemo(
    () => workCenters.find((w) => w.WorkCenterId === workCenterId) ?? null,
    [workCenters, workCenterId]
  );

  function buildRange() {
    // Operator view: show "now -> next 24 hours"
    const start = new Date();
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  async function loadWorkCenters() {
    const res = await fetch(`${apiBase}/api/workcenters`);
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as WorkCenter[];
    setWorkCenters(data);
  }

  async function loadSchedule() {
    if (!Number.isFinite(workCenterId)) return;

    const { start, end } = buildRange();
    const url =
      `${apiBase}/api/operator/schedule?workCenterId=${workCenterId}` +
    `&start=${encodeURIComponent(toLocalSqlDateTimeString(start))}` +
    `&end=${encodeURIComponent(toLocalSqlDateTimeString(end))}`;

    setStatus("Loading schedule...");
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as OperatorEvent[];
    setEvents(data);
    setStatus("");
  }

  async function startJob(scheduleEventId: number) {
    setStatus("Starting job...");
    const res = await fetch(`${apiBase}/api/operator/schedule/${scheduleEventId}/start`, {
      method: "POST",
    });
    if (!res.ok) {
      const msg = await res.text();
      setStatus("");
      alert(msg || "Start failed.");
      return;
    }
    setStatus("");
    await loadSchedule();
  }

  async function stopJob(scheduleEventId: number) {
    setStatus("Stopping job...");
    const res = await fetch(`${apiBase}/api/operator/schedule/${scheduleEventId}/stop`, {
      method: "POST",
    });
    if (!res.ok) {
      const msg = await res.text();
      setStatus("");
      alert(msg || "Stop failed.");
      return;
    }
    setStatus("");
    await loadSchedule();
  }

  useEffect(() => {
    loadWorkCenters().catch((e) => setStatus(`Error: ${String(e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadSchedule().catch((e) => setStatus(`Error: ${String(e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workCenterId]);

  const inProgress = events.find((e) => e.status === 1) ?? null;

  return (
    <div style={{ padding: 16, fontFamily: "Segoe UI, Arial" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div style={{ fontSize: 12, color: "#666" }}>Operator View</div>
          <h2 style={{ margin: "4px 0 0 0" }}>
            {wc ? wc.WorkCenterName : `Work Center ${workCenterId}`}
          </h2>
          <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
            API: {apiBase || "(missing VITE_API_BASE)"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button onClick={() => loadSchedule()} style={{ padding: "8px 12px" }}>
            Refresh
          </button>
          <Link to="/" style={{ fontSize: 12, color: "#0b5" }}>
            Scheduler Board
          </Link>
        </div>
      </div>

      {status && (
        <div style={{ marginTop: 12, color: "#b00", fontSize: 12, whiteSpace: "pre-wrap" }}>
          {status}
        </div>
      )}

      {inProgress && (
        <div
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 10,
            border: "2px solid #b45309",
            background: "#fff7ed",
          }}
        >
          <div style={{ fontWeight: 800 }}>CURRENTLY RUNNING</div>
          <div style={{ marginTop: 6 }}>{inProgress.title}</div>
          <div style={{ marginTop: 6, fontSize: 12, color: "#444" }}>
            Started:{" "}
            {inProgress.actualStartLocal ? new Date(inProgress.actualStartLocal).toLocaleString() : ""}
          </div>
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 12, color: "#666" }}>
        Scheduled tiles (next 24 hours): {events.length}
      </div>

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {events.map((e) => (
          <div
            key={e.scheduleEventId}
            style={{
              ...statusStyles(e.status),
              borderRadius: 10,
              padding: 12,
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <div style={{ fontWeight: 800, whiteSpace: "nowrap" }}>{e.title}</div>
                <div style={{ fontSize: 12, color: "#666" }}>{statusLabel(e.status)}</div>
              </div>

              <div style={{ marginTop: 6, fontSize: 12, color: "#444" }}>
                Planned: {new Date(e.plannedStartLocal).toLocaleString()} →{" "}
                {new Date(e.plannedEndLocal).toLocaleString()}
              </div>

              <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
                {e.inputMaterial ?? ""} {e.size ? ` • ${e.size}` : ""}
              </div>

              <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
                Actual:{" "}
                {e.actualStartLocal ? new Date(e.actualStartLocal).toLocaleTimeString() : "—"} →{" "}
                {e.actualEndLocal ? new Date(e.actualEndLocal).toLocaleTimeString() : "—"}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 160 }}>
              {e.status === 0 && (
                <button
                  onClick={() => startJob(e.scheduleEventId)}
                  style={{ padding: "10px 12px", fontWeight: 800 }}
                >
                  Start
                </button>
              )}

              {e.status === 1 && (
                <button
                  onClick={() => stopJob(e.scheduleEventId)}
                  style={{ padding: "10px 12px", fontWeight: 800 }}
                >
                  Stop
                </button>
              )}

              {e.status === 2 && (
                <div style={{ fontSize: 12, color: "#166534", fontWeight: 800, textAlign: "center" }}>
                  Completed
                </div>
              )}
            </div>
          </div>
        ))}

        {!events.length && !status && (
          <div style={{ marginTop: 12, color: "#666", fontSize: 12 }}>
            No scheduled jobs found for the next 24 hours.
          </div>
        )}
      </div>
    </div>
  );
}