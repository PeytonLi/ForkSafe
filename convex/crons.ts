import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval("reconcile", { seconds: 5 }, internal.reconcile.tick, {});

export default crons;
