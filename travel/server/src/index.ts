import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth";
import destinationsRouter from "./routes/destinations";
import tripsRouter from "./routes/trips";
import tripItemsRouter from "./routes/tripItems";
import budgetRouter from "./routes/budget";
import bookingAgentsRouter from "./routes/bookingAgents";
import resourcesRouter from "./routes/resources";
import aiRouter from "./routes/ai";
import preferencesRouter from "./routes/preferences";
import travelersRouter from "./routes/travelers";
import { requireAuth } from "./middleware/auth";

const app = express();
const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: "2mb" })); // pasted itinerary/email text can be long
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);

// Everything below requires a logged-in household member.
app.use("/api/destinations", requireAuth, destinationsRouter);
app.use("/api/trips/:tripId/items", requireAuth, tripItemsRouter);
app.use("/api/trips/:tripId/budget", requireAuth, budgetRouter);
app.use("/api/trips", requireAuth, tripsRouter);
app.use("/api/booking-agents", requireAuth, bookingAgentsRouter);
app.use("/api/resources", requireAuth, resourcesRouter);
app.use("/api/ai", requireAuth, aiRouter);
app.use("/api/preferences", requireAuth, preferencesRouter);
app.use("/api/travelers", requireAuth, travelersRouter);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Travel API listening on port ${PORT}`);
});
