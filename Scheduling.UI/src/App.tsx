import { useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin, { Draggable } from "@fullcalendar/interaction";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import OperatorBoard from "./OperatorBoard";

// ✅ Match API output (PascalCase)
type WorkCenter = { WorkCenterId: number; WorkCenterName: string };

type BucketOp = {
  OperationId: number;
  OperationKey: string;
  WorkOrderHeaderId: number;
  DueDate: string | null;
  Customer: string | null;
  InputMaterial: string | null;
  Size: string | null;
};

type CalendarEvent = {
  id: number | string;
  title: string;
  start: string;
  end: string;
  operationId: number;
  workOrderHeaderId: number;
  customer: string | null;
  inputMaterial: string | null;
  size: string | null;
  status?: number;
  actualStartLocal?: string | null;
  actualEndLocal?: string | null;
};

type OperationDetail = {
  OperationId: number;
  OperationKey: string | null;
  WorkCenterId: number;
  WorkCenterName: string | null;
  WorkOrderHeaderId: number;
  DueDate: string | null;
  Customer: string | null;
  InputMaterial: string | null;
  Size: string | null;
};

const apiBase = import.meta.env.VITE_API_BASE as string;

function toLocalSqlDateTimeString(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function pointInRect(x: number, y: number, rect: DOMRect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function buildShiftBackgroundEvents(rangeStart: Date, rangeEnd: Date) {
  const events: any[] = [];
  const d = new Date(rangeStart);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);

  while (d < rangeEnd) {
    const dayShiftStart = new Date(d);
    dayShiftStart.setHours(5, 0, 0, 0);
    const dayShiftEnd = new Date(d);
    dayShiftEnd.setHours(17, 0, 0, 0);

    events.push({
      start: dayShiftStart.toISOString(),
      end: dayShiftEnd.toISOString(),
      display: "background",
      classNames: ["shift-day"],
    });

    const nightStart = new Date(d);
    nightStart.setHours(17, 0, 0, 0);
    const nextDay = new Date(d);
    nextDay.setDate(nextDay.getDate() + 1);
    const nightEnd = new Date(nextDay);
    nightEnd.setHours(5, 0, 0, 0);

    events.push({
      start: nightStart.toISOString(),
      end: nightEnd.toISOString(),
      display: "background",
      classNames: ["shift-night"],
    });

    d.setDate(d.getDate() + 1);
  }

  return events;
}

function DispatchBoard() {
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [workCenterId, setWorkCenterId] = useState<number | null>(null);
  const [bucketOps, setBucketOps] = useState<BucketOp[]>([]);
  const [status, setStatus] = useState<string>("");

  const [detail, setDetail] = useState<OperationDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const bucketRef = useRef<HTMLDivElement | null>(null);
  const calendarRef = useRef<FullCalendar | null>(null);

  // ✅ This is the drop zone for unscheduling
  const bucketPanelRef = useRef<HTMLDivElement | null>(null);

  const selectedWC = useMemo(
    () => workCenters.find((w) => w.WorkCenterId === workCenterId) ?? null,
    [workCenters, workCenterId]
  );

  async function loadWorkCenters() {
    setStatus("Loading work centers...");
    const res = await fetch(`${apiBase}/api/workcenters`);
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as WorkCenter[];
    setWorkCenters(data);
    if (!workCenterId && data.length) setWorkCenterId(data[0].WorkCenterId);
    setStatus("");
  }

  async function loadBucket(wcId: number) {
    setStatus("Loading bucket...");
    const res = await fetch(`${apiBase}/api/operations?workCenterId=${wcId}&scheduled=false`);
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as BucketOp[];
    setBucketOps(data);
    setStatus("");
  }

  async function openDetail(operationId: number) {
    try {
      setStatus("Loading WO detail...");
      const res = await fetch(`${apiBase}/api/operations/${operationId}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as OperationDetail;
      setDetail(data);
      setDetailOpen(true);
      setStatus("");
    } catch (e) {
      setStatus(`Error loading detail: ${String(e)}`);
    }
  }

  // Poll calendar events (no navigation reset)
  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return;

    let inFlight = false;
    const tick = async () => {
      if (document.hidden) return;
      if (inFlight) return;
      inFlight = true;
      try {
        api.refetchEvents();
      } finally {
        window.setTimeout(() => (inFlight = false), 500);
      }
    };

    const t = window.setInterval(tick, 15000);
    const onVis = () => !document.hidden && api.refetchEvents();
    document.addEventListener("visibilitychange", onVis);

    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Poll bucket occasionally
  useEffect(() => {
    if (!workCenterId) return;
    const t = window.setInterval(() => loadBucket(workCenterId), 30000);
    return () => window.clearInterval(t);
  }, [workCenterId]);

  useEffect(() => {
    loadWorkCenters().catch((e) => setStatus(`Error: ${String(e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!workCenterId) return;
    loadBucket(workCenterId).catch((e) => setStatus(`Error: ${String(e)}`));
  }, [workCenterId]);

  // Clear + refetch calendar events when work center changes
  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    api.removeAllEvents();
    api.refetchEvents();
  }, [workCenterId]);

  // Make bucket draggable
  useEffect(() => {
    if (!bucketRef.current) return;

    const draggable = new Draggable(bucketRef.current, {
      itemSelector: ".fc-draggable",
      eventData: (el) => {
        const opId = Number(el.getAttribute("data-operation-id"));
        const wo = el.getAttribute("data-wo") ?? "";
        const cust = el.getAttribute("data-customer") ?? "";
        return {
          title: `WO ${wo}${cust ? " - " + cust : ""}`,
          extendedProps: { operationId: opId },
          duration: "01:00",
        };
      },
    });

    return () => draggable.destroy();
  }, [bucketOps]);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "Segoe UI, Arial" }}>
      {/* LEFT: Bucket (also our unschedule drop-zone) */}
      <div
        ref={bucketPanelRef}
        style={{ width: 420, borderRight: "1px solid #ddd", padding: 12, overflow: "auto" }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Dispatch Board</h2>

        <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
          API: {apiBase || "(missing VITE_API_BASE)"}
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>Work Center</div>

          <select
            value={workCenterId ?? ""}
            onChange={(e) => setWorkCenterId(Number(e.target.value))}
            style={{
              width: "100%",
              padding: 8,
              color: "#000",
              background: "#fff",
              border: "2px solid #333",
              borderRadius: 6,
            }}
          >
            <option key="placeholder" value="" disabled>
              -- select a work center --
            </option>

            {workCenters.map((wc) => (
              <option key={`wc-${wc.WorkCenterId}`} value={wc.WorkCenterId}>
                {wc.WorkCenterName}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: 12, color: "#666", fontSize: 12 }}>
          Bucket (unscheduled): {bucketOps.length}
        </div>

        <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
          Tip: Drag a scheduled job back onto this left panel to unschedule it.
        </div>

        {status && (
          <div style={{ marginTop: 10, color: "#b00", fontSize: 12, whiteSpace: "pre-wrap" }}>
            {status}
          </div>
        )}

        <div ref={bucketRef} style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          {bucketOps.map((op) => (
            <div
              key={op.OperationId}
              className="fc-draggable"
              data-operation-id={op.OperationId}
              data-wo={op.WorkOrderHeaderId}
              data-customer={op.Customer ?? ""}
              onClick={() => openDetail(op.OperationId)}
              style={{
                border: "1px solid #ccc",
                borderRadius: 8,
                padding: 10,
                background: "#fff",
                cursor: "pointer",
              }}
              title="Click for details • Drag to calendar to schedule"
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontWeight: 700 }}>
                  WO {op.WorkOrderHeaderId}
                  {op.Customer ? ` — ${op.Customer}` : ""}
                </div>
                <div style={{ fontSize: 12, color: "#666" }}>
                  {op.DueDate ? new Date(op.DueDate).toLocaleDateString() : ""}
                </div>
              </div>

              <div style={{ fontSize: 12, marginTop: 6 }}>
                <div style={{ color: "#555" }}>{op.InputMaterial ?? ""}</div>
                <div style={{ color: "#777" }}>{op.Size ?? ""}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT: Calendar */}
      <div style={{ flex: 1, padding: 12, overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>
            {selectedWC ? `Schedule — ${selectedWC.WorkCenterName}` : "Schedule"}
          </h3>

          <div style={{ fontSize: 12, color: "#666" }}>
            24h board • 15-min snap • No overlaps • Shifts: 05:00–17:00 / 17:00–05:00
          </div>
        </div>

        <style>{`
          .shift-day { background: rgba(0,0,0,0.03); pointer-events: none; }
          .shift-night { background: rgba(0,0,0,0.07); pointer-events: none; }

          .fc .evt-running {
            outline: 4px solid rgba(180,83,9,0.85);
            outline-offset: -2px;
            font-weight: 800;
          }
          .fc .evt-done {
            opacity: 0.55;
            text-decoration: line-through;
          }
          .fc .evt-running .fc-event-title::before {
            content: "RUNNING • ";
          }
        `}</style>

        <div style={{ marginTop: 10 }}>
          <FullCalendar
            ref={calendarRef}
            plugins={[timeGridPlugin, interactionPlugin]}
            initialView="timeGridDay"
            headerToolbar={{
              left: "prev,next today",
              center: "title",
              right: "timeGridDay,timeGridWeek",
            }}
            height="auto"
            expandRows={true}
            nowIndicator={true}
            allDaySlot={false}
            slotMinTime="00:00:00"
            slotMaxTime="24:00:00"
            slotDuration="00:15:00"
            snapDuration="00:15:00"
            slotLabelInterval="01:00:00"
            editable={true}
            droppable={true}
            eventResizableFromStart={true}
            slotEventOverlap={false}
            eventOverlap={(stillEvent, movingEvent) => {
              if (stillEvent.display === "background" || movingEvent.display === "background") return true;
              return false;
            }}

            // status styling
            eventClassNames={(arg) => {
              const s = (arg.event.extendedProps.status as number | undefined) ?? 0;
              if (s === 2) return ["evt-done"];
              if (s === 1) return ["evt-running"];
              return ["evt-scheduled"];
            }}
            eventDidMount={(arg) => {
              const s = (arg.event.extendedProps.status as number | undefined) ?? 0;
              const label = s === 2 ? "Done" : s === 1 ? "Running" : "Scheduled";
              arg.el.title = `${arg.event.title}\nStatus: ${label}`;
            }}

            // running jobs cannot move, but can resize (duration)
            eventStartEditable={(arg) => {
              const s = (arg.event.extendedProps.status as number | undefined) ?? 0;
              return s !== 1;
            }}
            eventDurationEditable={() => true}

            // IMPORTANT: do NOT block running jobs here, because eventAllow also affects resize
            eventAllow={() => true}

            // ✅ Unschedule: drag from calendar onto left panel
            eventDragStop={async (info) => {
              try {
                const panel = bucketPanelRef.current;
                if (!panel) return;

                const rect = panel.getBoundingClientRect();
                const x = info.jsEvent.clientX;
                const y = info.jsEvent.clientY;

                if (!pointInRect(x, y, rect)) return;

                const s = (info.event.extendedProps.status as number | undefined) ?? 0;
                if (s === 1) {
                  alert("This job is running. Stop it before unscheduling.");
                  // No revert() on dragStop — just reload from DB
                  calendarRef.current?.getApi().refetchEvents();
                  return;
                }

                const scheduleEventId = Number(info.event.id);
                if (!scheduleEventId || Number.isNaN(scheduleEventId)) {
                  calendarRef.current?.getApi().refetchEvents();
                  return;
                }

                const resp = await fetch(`${apiBase}/api/schedule/${scheduleEventId}`, {
                  method: "DELETE",
                });

                if (!resp.ok) {
                  alert((await resp.text()) || "Unschedule failed.");
                  calendarRef.current?.getApi().refetchEvents();
                  return;
                }

                info.event.remove();
                if (workCenterId) await loadBucket(workCenterId);
                calendarRef.current?.getApi().refetchEvents();
              } catch (e) {
                alert(`Unschedule failed: ${String(e)}`);
                calendarRef.current?.getApi().refetchEvents();
              }
            }}

            eventDrop={async (info) => {
              try {
                const scheduleEventId = Number(info.event.id);
                if (!scheduleEventId || Number.isNaN(scheduleEventId)) {
                  info.revert();
                  return;
                }

                if (!info.event.end) {
                  info.event.setEnd(new Date(info.event.start!.getTime() + 60 * 60 * 1000));
                }

                const resp = await fetch(`${apiBase}/api/schedule/${scheduleEventId}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    operationId: info.event.extendedProps.operationId,
                    plannedStartLocal: toLocalSqlDateTimeString(info.event.start!),
                    plannedEndLocal: toLocalSqlDateTimeString(info.event.end!),
                  }),
                });

                if (!resp.ok) {
                  info.revert();
                  alert(await resp.text());
                  return;
                }

                calendarRef.current?.getApi().refetchEvents();
              } catch (e) {
                info.revert();
                alert(`Move failed: ${String(e)}`);
              }
            }}

            eventResize={async (info) => {
              try {
                const scheduleEventId = Number(info.event.id);
                if (!scheduleEventId || Number.isNaN(scheduleEventId)) {
                  info.revert();
                  return;
                }
                if (!info.event.end) {
                  info.revert();
                  return;
                }

                const resp = await fetch(`${apiBase}/api/schedule/${scheduleEventId}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    operationId: info.event.extendedProps.operationId,
                    plannedStartLocal: toLocalSqlDateTimeString(info.event.start!),
                    plannedEndLocal: toLocalSqlDateTimeString(info.event.end!),
                  }),
                });

                if (!resp.ok) {
                  info.revert();
                  alert(await resp.text());
                  return;
                }

                calendarRef.current?.getApi().refetchEvents();
              } catch (e) {
                info.revert();
                alert(`Resize failed: ${String(e)}`);
              }
            }}

            eventSources={[
              {
                id: "shifts",
                events: (info, success) => success(buildShiftBackgroundEvents(info.start, info.end)),
              },
            ]}
            events={async (info, success, failure) => {
              try {
                if (!workCenterId) return success([]);
                const url =
                  `${apiBase}/api/schedule?workCenterId=${workCenterId}` +
                  `&start=${encodeURIComponent(info.startStr)}` +
                  `&end=${encodeURIComponent(info.endStr)}`;
                const res = await fetch(url);
                if (!res.ok) throw new Error(await res.text());
                const data = (await res.json()) as CalendarEvent[];
                success(data);
              } catch (e) {
                failure(e);
              }
            }}
            eventClick={(clickInfo) => {
              const opId = clickInfo.event.extendedProps.operationId as number | undefined;
              if (opId) openDetail(opId);
            }}
            eventReceive={async (info) => {
              try {
                const operationId = info.event.extendedProps.operationId as number;

                if (!info.event.end) {
                  info.event.setEnd(new Date(info.event.start!.getTime() + 60 * 60 * 1000));
                }

                const resp = await fetch(`${apiBase}/api/schedule`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    operationId,
                    plannedStartLocal: toLocalSqlDateTimeString(info.event.start!),
                    plannedEndLocal: toLocalSqlDateTimeString(info.event.end!),
                  }),
                });

                if (!resp.ok) {
                  info.revert();
                  alert(await resp.text());
                  return;
                }

                // remove temp client event and refetch from DB
                info.event.remove();
                calendarRef.current?.getApi().refetchEvents();
                if (workCenterId) loadBucket(workCenterId);
              } catch (e) {
                info.revert();
                alert(`Schedule create failed: ${String(e)}`);
              }
            }}
          />
        </div>
      </div>

      {/* DETAILS MODAL */}
      {detailOpen && detail && (
        <div
          onClick={() => setDetailOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 9999,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 700,
              maxWidth: "95vw",
              background: "#fff",
              borderRadius: 10,
              padding: 16,
              boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>
                WO {detail.WorkOrderHeaderId}
                {detail.Customer ? ` — ${detail.Customer}` : ""}
              </div>
              <button onClick={() => setDetailOpen(false)} style={{ padding: "6px 10px" }}>
                Close
              </button>
            </div>

            <div
              style={{
                marginTop: 12,
                display: "grid",
                gridTemplateColumns: "160px 1fr",
                rowGap: 8,
                columnGap: 12,
              }}
            >
              <div style={{ color: "#666" }}>Work Center</div>
              <div>{detail.WorkCenterName ?? ""}</div>

              <div style={{ color: "#666" }}>Due Date</div>
              <div>{detail.DueDate ? new Date(detail.DueDate).toLocaleString() : ""}</div>

              <div style={{ color: "#666" }}>Material</div>
              <div>{detail.InputMaterial ?? ""}</div>

              <div style={{ color: "#666" }}>Size</div>
              <div>{detail.Size ?? ""}</div>

              <div style={{ color: "#666" }}>Operation</div>
              <div>
                {detail.OperationId}
                {detail.OperationKey ? ` (${detail.OperationKey})` : ""}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DispatchBoard />} />
        <Route path="/op/wc/:workCenterId" element={<OperatorBoard />} />
      </Routes>
    </BrowserRouter>
  );
}