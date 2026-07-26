const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const sql = fs.readFileSync("migrations/004_complete_missing_schema.sql", "utf8").toLowerCase();

test("004 adds the verified missing room type schema without destructive SQL", () => {
  assert.match(sql, /create table if not exists public\.room_types/);
  assert.match(sql, /create extension if not exists pgcrypto/);
  assert.doesNotMatch(sql, /\bdrop\b|\btruncate\b|\bdelete\s+from\b|\bcreate\s+or\s+replace\b/);
  assert.doesNotMatch(sql, /\bupdate\s+public\.|\balter\s+table\b/);
});

test("004 preserves existing functions and triggers", () => {
  assert.match(sql, /to_regprocedure\('public\.set_updated_at\(\)'\) is null/);
  assert.match(sql, /from pg_catalog\.pg_trigger/);
  assert.match(sql, /tgrelid = 'public\.room_types'::regclass/);
  assert.match(sql, /tgname = 'room_types_set_updated_at'/);
});

test("004 inserts room type seeds without overwriting existing rows", () => {
  assert.match(sql, /values \('standard'\), \('deluxe'\)/);
  assert.match(sql, /on conflict \(name\) do nothing/);
  assert.doesNotMatch(sql, /on conflict[\s\S]*do update/);
});
