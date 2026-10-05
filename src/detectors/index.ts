import type { Detector } from "../core/types.js";
import { failureLoops } from "./failure-loops.js";
import { outputLifetime } from "./output-lifetime.js";
import { repeatedReads } from "./repeated-reads.js";

export const detectors: Detector[] = [repeatedReads, outputLifetime, failureLoops];
