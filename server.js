// server.js
// Thin HTTP surface over modules that already exist. Every route is a
// direct pass-through — this file adds no new decisions, just exposes
// them (Rule 05: understandable by using it, starting with a boring API).
// Chaos-trigger routes and release routes are deliberately NOT here yet —
// those land with chaos.js and releases.js in their own phases.

import express from "express";
import { submitWork, getWork, listWork, backlogSummary } from "./queue.js";
import { listWorkers, getWorker, setChaos } from "./workers.js";
import { returnToService } from "./supervisor.js";
import {
  recentEvents,
  eventsForSubject,
  retentionFloor,
  formatEvent,
} from "./events.js";
import { now, db } from "./db.js";

export function createServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static("public"));

  // ---- Work -----------------------------------------------------------
  app.post("/work", (req, res) => {
    try {
      const { id, type, body } = req.body ?? {};
      const result = submitWork({ id, type, body });
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/work/:id", (req, res) => {
    const item = getWork(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    res.json(item);
  });

  app.post("/admin/clear-db", (req, res) => {
    db.prepare("DELETE FROM work_items").run();
    db.prepare("DELETE FROM events").run();
    res.json({ cleared: true });
  });

  app.get("/work", (req, res) => {
    const { state } = req.query;
    if (!state) {
      return res.status(400).json({ error: "state query param required" });
    }
    res.json(listWork(state));
  });

  app.get("/backlog", (req, res) => {
    res.json(backlogSummary());
  });

  // ---- Workers ----------------------------------------------------------
  app.get("/workers", (req, res) => {
    res.json(listWorkers());
  });

  app.get("/workers/:id", (req, res) => {
    const worker = getWorker(req.params.id);
    if (!worker) return res.status(404).json({ error: "not found" });
    res.json(worker);
  });

  app.post("/workers/:id/return-to-service", (req, res) => {
    try {
      returnToService(req.params.id);
      res.json(getWorker(req.params.id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Events -------------------------------------------------------
  // R-12: this is what a reviewer's 90-second "what happened" reads from.
  app.get("/events", (req, res) => {
    const sinceTs = req.query.since
      ? Number(req.query.since)
      : now() - 60 * 60 * 1000; // default: last hour
    res.json({
      retentionFloor: retentionFloor(),
      events: recentEvents(sinceTs).map(formatEvent),
    });
  });

  app.get("/events/:subjectType/:subjectId", (req, res) => {
    const { subjectType, subjectId } = req.params;
    res.json(eventsForSubject(subjectType, subjectId).map(formatEvent));
  });

  // ---- Chaos (R-15) ---------------------------------------------------
  app.post("/workers/:id/chaos", (req, res) => {
    try {
      const { crashOnStart, crashMidTask, slowFactor } = req.body ?? {};
      setChaos(req.params.id, { crashOnStart, crashMidTask, slowFactor });
      res.json(getWorker(req.params.id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Health -------------------------------------------------------
  app.get("/health", (req, res) => {
    res.json({ ok: true, ts: now() });
  });

  return app;
}
