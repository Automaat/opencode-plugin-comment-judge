#!/usr/bin/env node
import { main } from "./claude/main.ts";

process.exitCode = await main(process, process.env);
