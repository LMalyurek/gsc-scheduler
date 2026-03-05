using Dapper;
using Microsoft.Data.SqlClient;

var builder = WebApplication.CreateBuilder(args);

// Swagger
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// CORS (so the Vite UI can call the API)
builder.Services.AddCors(opt =>
{
    opt.AddPolicy("ui", p =>
        p.WithOrigins("http://localhost:5173")
         .AllowAnyHeader()
         .AllowAnyMethod());
});

// DB connection
string connStr = builder.Configuration.GetConnectionString("SchedulingDb")
    ?? throw new Exception("Missing connection string: ConnectionStrings:SchedulingDb in appsettings.json");

builder.Services.AddScoped(_ => new SqlConnection(connStr));

var app = builder.Build();

app.UseSwagger();
app.UseSwaggerUI();

app.UseCors("ui");

// ---------- API ENDPOINTS ----------

app.MapGet("/api/workcenters", async (SqlConnection db) =>
{
    var sql = @"
SELECT WorkCenterId, WorkCenterName
FROM sched.WorkCenter
WHERE IsActive = 1
ORDER BY WorkCenterName;";
    var rows = await db.QueryAsync(sql);
    return Results.Ok(rows);
})
.WithName("GetWorkCenters");

app.MapGet("/api/operations", async (int workCenterId, bool scheduled, SqlConnection db) =>
{
    var sql = scheduled
        ? @"
SELECT os.OperationId, os.OperationKey, os.WorkOrderHeaderId, os.DueDate, os.Customer, os.InputMaterial, os.Size
FROM sched.OperationSnapshot os
WHERE os.IsActive = 1 AND os.WorkCenterId = @workCenterId
  AND EXISTS (SELECT 1 FROM sched.ScheduleEvent se WHERE se.OperationId = os.OperationId)
ORDER BY os.DueDate;"
        : @"
SELECT os.OperationId, os.OperationKey, os.WorkOrderHeaderId, os.DueDate, os.Customer, os.InputMaterial, os.Size
FROM sched.OperationSnapshot os
WHERE os.IsActive = 1 AND os.WorkCenterId = @workCenterId
  AND NOT EXISTS (SELECT 1 FROM sched.ScheduleEvent se WHERE se.OperationId = os.OperationId)
ORDER BY os.DueDate;";

    var rows = await db.QueryAsync(sql, new { workCenterId });
    return Results.Ok(rows);
})
.WithName("GetOperations");

app.MapGet("/api/operations/{operationId:int}", async (int operationId, SqlConnection db) =>
{
    var sql = @"
SELECT TOP 1
      os.OperationId
    , os.OperationKey
    , os.WorkCenterId
    , wc.WorkCenterName
    , os.WorkOrderHeaderId
    , os.DueDate
    , os.Customer
    , os.InputMaterial
    , os.Size
    -- add any extra columns you stored in OperationSnapshot, for example:
    -- , os.SalesOrderHeaderId
    -- , os.SalesRep
    -- , os.SalesOrderTarget
    -- , os.SalesOrderReady
FROM sched.OperationSnapshot os
LEFT JOIN sched.WorkCenter wc ON wc.WorkCenterId = os.WorkCenterId
WHERE os.OperationId = @operationId AND os.IsActive = 1;
";

    var row = await db.QuerySingleOrDefaultAsync(sql, new { operationId });
    return row is null ? Results.NotFound() : Results.Ok(row);
})
.WithName("GetOperationDetail");

app.MapGet("/api/schedule", async (int workCenterId, DateTime start, DateTime end, SqlConnection db) =>
{
    var sql = @"
SELECT
      se.ScheduleEventId AS id
    , CONCAT('WO ', os.WorkOrderHeaderId, ' - ', COALESCE(os.Customer,'')) AS title
    , se.PlannedStartLocal AS [start]
    , se.PlannedEndLocal AS [end]
    , os.OperationId AS operationId
    , os.WorkOrderHeaderId AS workOrderHeaderId
    , os.Customer AS customer
    , os.InputMaterial AS inputMaterial
    , os.Size AS size
    , se.Status AS status
    , se.ActualStartLocal AS actualStartLocal
    , se.ActualEndLocal AS actualEndLocal
FROM sched.ScheduleEvent se
JOIN sched.OperationSnapshot os ON os.OperationId = se.OperationId
WHERE os.WorkCenterId = @workCenterId
  AND se.PlannedStartLocal < @end
  AND se.PlannedEndLocal > @start
ORDER BY se.PlannedStartLocal;";

    var rows = await db.QueryAsync(sql, new { workCenterId, start, end });
    return Results.Ok(rows);
})
.WithName("GetSchedule");

app.MapPost("/api/schedule", async (ScheduleUpsertRequest req, SqlConnection db) =>
{
    if (req.PlannedEndLocal <= req.PlannedStartLocal)
        return Results.BadRequest("End must be after start.");

    // Work center for overlap enforcement
    var wcId = await db.QuerySingleOrDefaultAsync<int?>(@"
SELECT WorkCenterId
FROM sched.OperationSnapshot
WHERE OperationId = @OperationId AND IsActive = 1;",
        new { req.OperationId });

    if (wcId is null) return Results.BadRequest("Invalid or inactive OperationId.");

    // Enforce: one schedule event per operation (MVP)
    var alreadyScheduled = await db.QuerySingleAsync<int>(@"
SELECT COUNT(1) FROM sched.ScheduleEvent WHERE OperationId = @OperationId;",
        new { req.OperationId });

    if (alreadyScheduled > 0)
        return Results.Conflict("This operation is already scheduled.");

    // Enforce: no overlaps on the same work center
    var overlap = await db.QuerySingleAsync<int>(@"
SELECT COUNT(1)
FROM sched.ScheduleEvent se
JOIN sched.OperationSnapshot os ON os.OperationId = se.OperationId
WHERE os.WorkCenterId = @WorkCenterId
  AND se.PlannedStartLocal < @EndTime
  AND se.PlannedEndLocal > @StartTime;",
        new { WorkCenterId = wcId.Value, StartTime = req.PlannedStartLocal, EndTime = req.PlannedEndLocal });

    if (overlap > 0)
        return Results.Conflict("Schedule overlap detected for this work center.");

    var scheduleEventId = await db.QuerySingleAsync<int>(@"
INSERT INTO sched.ScheduleEvent (OperationId, PlannedStartLocal, PlannedEndLocal, Locked, ScheduledByAppUserId)
VALUES (@OperationId, @StartTime, @EndTime, 0, NULL);
SELECT CAST(SCOPE_IDENTITY() as int);",
        new { req.OperationId, StartTime = req.PlannedStartLocal, EndTime = req.PlannedEndLocal });

    return Results.Ok(new { scheduleEventId });
});

app.MapPut("/api/schedule/{scheduleEventId:int}", async (int scheduleEventId, ScheduleUpsertRequest req, SqlConnection db) =>
{
    if (req.PlannedEndLocal <= req.PlannedStartLocal)
        return Results.BadRequest("End must be after start.");

		var row = await db.QuerySingleOrDefaultAsync<(
			int OperationId,
			int WorkCenterId,
			bool Locked,
			byte Status,
			DateTime PlannedStartLocal,
			DateTime PlannedEndLocal
		)?>(@"
		SELECT
			  se.OperationId
			, os.WorkCenterId
			, se.Locked
			, se.Status
			, se.PlannedStartLocal
			, se.PlannedEndLocal
		FROM sched.ScheduleEvent se
		JOIN sched.OperationSnapshot os ON os.OperationId = se.OperationId
		WHERE se.ScheduleEventId = @Id;",
			new { Id = scheduleEventId });

    if (row is null) return Results.NotFound();
    if (row.Value.Locked) return Results.Conflict("This schedule event is locked.");
	// If running (Status=1), do not allow moving the start time.
	// Resizing is allowed (end time can change).
	if (row.Value.Status == 1)
	{
		// Compare in seconds to avoid tiny rounding differences
		var currentStart = row.Value.PlannedStartLocal;
		var newStart = req.PlannedStartLocal;

		if (Math.Abs((newStart - currentStart).TotalSeconds) >= 1)
			return Results.Conflict("This job is running. You can adjust duration (end time) but you cannot move its start time.");
	}
	

    var overlap = await db.QuerySingleAsync<int>(@"
SELECT COUNT(1)
FROM sched.ScheduleEvent se
JOIN sched.OperationSnapshot os ON os.OperationId = se.OperationId
WHERE os.WorkCenterId = @WorkCenterId
  AND se.ScheduleEventId <> @Id
  AND se.PlannedStartLocal < @EndTime
  AND se.PlannedEndLocal > @StartTime;",
        new
        {
            WorkCenterId = row.Value.WorkCenterId,
            Id = scheduleEventId,
            StartTime = req.PlannedStartLocal,
            EndTime = req.PlannedEndLocal
        });

    if (overlap > 0)
        return Results.Conflict("Schedule overlap detected for this work center.");

    var updated = await db.ExecuteAsync(@"
UPDATE sched.ScheduleEvent
SET PlannedStartLocal = @StartTime,
    PlannedEndLocal   = @EndTime
WHERE ScheduleEventId = @Id;",
        new { Id = scheduleEventId, StartTime = req.PlannedStartLocal, EndTime = req.PlannedEndLocal });

    return updated == 1 ? Results.NoContent() : Results.NotFound();
});

app.MapDelete("/api/schedule/{scheduleEventId:int}", async (int scheduleEventId, SqlConnection db) =>
{
    var locked = await db.QuerySingleOrDefaultAsync<bool?>(@"
SELECT Locked FROM sched.ScheduleEvent WHERE ScheduleEventId = @Id;", new { Id = scheduleEventId });

    if (locked is null) return Results.NotFound();
    if (locked.Value) return Results.Conflict("This schedule event is locked.");

    var deleted = await db.ExecuteAsync(
        "DELETE FROM sched.ScheduleEvent WHERE ScheduleEventId = @Id;",
        new { Id = scheduleEventId });

    return deleted == 1 ? Results.NoContent() : Results.NotFound();
});

// -------- OPERATOR ENDPOINTS --------

// Operator schedule view (includes status + actual start/end)
app.MapGet("/api/operator/schedule", async (int workCenterId, DateTime start, DateTime end, SqlConnection db) =>
{
    var sql = @"
SELECT
      se.ScheduleEventId AS scheduleEventId
    , CONCAT('WO ', os.WorkOrderHeaderId, ' - ', COALESCE(os.Customer,'')) AS title
    , se.PlannedStartLocal AS plannedStartLocal
    , se.PlannedEndLocal   AS plannedEndLocal
    , se.Status            AS status
    , se.ActualStartLocal  AS actualStartLocal
    , se.ActualEndLocal    AS actualEndLocal
    , os.OperationId       AS operationId
    , os.WorkOrderHeaderId AS workOrderHeaderId
    , os.Customer          AS customer
    , os.InputMaterial     AS inputMaterial
    , os.Size              AS size
FROM sched.ScheduleEvent se
JOIN sched.OperationSnapshot os ON os.OperationId = se.OperationId
WHERE os.WorkCenterId = @workCenterId
  AND se.PlannedStartLocal < @end
  AND se.PlannedEndLocal > @start
ORDER BY se.PlannedStartLocal;";

    var rows = await db.QueryAsync(sql, new { workCenterId, start, end });
    return Results.Ok(rows);
})
.WithName("GetOperatorSchedule");

// Start job (enforces one in progress per work center; timestamps from GETDATE())
app.MapPost("/api/operator/schedule/{scheduleEventId:int}/start", async (int scheduleEventId, SqlConnection db) =>
{
    try
    {
        var row = await db.QuerySingleAsync(@"
EXEC sched.usp_OperatorStart @ScheduleEventId;",
            new { ScheduleEventId = scheduleEventId });

        return Results.Ok(row);
    }
    catch (SqlException ex)
    {
        // Our procs RAISERROR with severity 16 -> comes here
        return Results.Conflict(ex.Message);
    }
})
.WithName("OperatorStart");

// Stop job (timestamps from GETDATE())
app.MapPost("/api/operator/schedule/{scheduleEventId:int}/stop", async (int scheduleEventId, SqlConnection db) =>
{
    try
    {
        var row = await db.QuerySingleAsync(@"
EXEC sched.usp_OperatorStop @ScheduleEventId;",
            new { ScheduleEventId = scheduleEventId });

        return Results.Ok(row);
    }
    catch (SqlException ex)
    {
        return Results.Conflict(ex.Message);
    }
})
.WithName("OperatorStop");

// sanity check endpoint (optional)
app.MapGet("/api/ping", () => Results.Ok(new { ok = true, utc = DateTime.UtcNow }))
   .WithName("Ping");

app.Run();

record ScheduleUpsertRequest(int OperationId, DateTime PlannedStartLocal, DateTime PlannedEndLocal);
