#!/usr/bin/env node
require("dotenv").config();
const { runProductionAudit } = require("../src/production-audit");

runProductionAudit().then((success) => { process.exitCode = success ? 0 : 1; }).catch((error) => {
  console.error(`AUDIT: unexpected ${error?.name || "Error"}; inspect sanitized server logs.`);
  process.exitCode = 1;
});
