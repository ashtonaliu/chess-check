// Fair-play guard tests for Lichess (docs/lichess-plan.md Part 2).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canReview,
  canShowRecap,
  classifyLichessStatus,
  gameIdFromPage,
  isAbortedStatus,
  isPlayPage,
  LICHESS_ABORTED_STATUSES,
  LICHESS_FINISHED_STATUSES,
  LICHESS_PENDING_STATUSES,
  nextStatusCheckDelayMs,
  pageSafetyKey,
  RATE_LIMIT_COOLDOWN_MS,
  readStatusOnly,
  STATUS_CHECK_INTERVAL_MS,
} from "../src/extension/lichessGuard";

const HOST = ["lichess", "org"].join(".");
const BASE = `https://${HOST}`;
const HTTP_BASE = `http://${HOST}`;
const OTHER_BASE = "https://example.com";
const LOOKALIKE_BASE = `https://${HOST}.example.com`;

const ADDRESS_CASES = [
  { url: `${BASE}/AbCdEf12`, gameId: "AbCdEf12", play: false, safetyKey: "game:AbCdEf12", reviewUnconfirmed: false, reviewConfirmed: true },
  { url: `${BASE}/AbCdEf12/white`, gameId: "AbCdEf12", play: false, safetyKey: "game:AbCdEf12", reviewUnconfirmed: false, reviewConfirmed: true },
  { url: `${BASE}/AbCdEf12/black`, gameId: "AbCdEf12", play: false, safetyKey: "game:AbCdEf12", reviewUnconfirmed: false, reviewConfirmed: true },
  { url: `${BASE}/AbCdEf123456`, gameId: "AbCdEf12", play: false, safetyKey: "game:AbCdEf12", reviewUnconfirmed: false, reviewConfirmed: true },
  { url: `${BASE}/AbCdEf123456/white`, gameId: "AbCdEf12", play: false, safetyKey: "game:AbCdEf12", reviewUnconfirmed: false, reviewConfirmed: true },
  { url: `${BASE}/AbCdEf123456/black`, gameId: "AbCdEf12", play: false, safetyKey: "game:AbCdEf12", reviewUnconfirmed: false, reviewConfirmed: true },
  { url: `${BASE}/AbCdEf12?theme=blue#14`, gameId: "AbCdEf12", play: false, safetyKey: "game:AbCdEf12", reviewUnconfirmed: false, reviewConfirmed: true },
  { url: `${BASE}/AbCdEf12/`, gameId: "AbCdEf12", play: false, safetyKey: "game:AbCdEf12", reviewUnconfirmed: false, reviewConfirmed: true },
  { url: `${BASE}/`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/setup`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/setup/friend`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/setup/ai`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/tournament/winter26`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/tournament/`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/swiss/abc12345`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/swiss/`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/simul/xyz98765`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/simul/`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/tv`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/tv/blitz`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/analysis`, gameId: null, play: false, safetyKey: "other", reviewUnconfirmed: true, reviewConfirmed: true },
  { url: `${BASE}/analysis/pgn/e4_e5`, gameId: null, play: false, safetyKey: "other", reviewUnconfirmed: true, reviewConfirmed: true },
  { url: `${BASE}/analysis/AbCdEf12`, gameId: null, play: false, safetyKey: "other", reviewUnconfirmed: true, reviewConfirmed: true },
  { url: `${BASE}/study/AbCdEf12`, gameId: null, play: false, safetyKey: "other", reviewUnconfirmed: true, reviewConfirmed: true },
  { url: `${BASE}/study/AbCdEf12/chapter1`, gameId: null, play: false, safetyKey: "other", reviewUnconfirmed: true, reviewConfirmed: true },
  { url: `${BASE}/training`, gameId: null, play: false, safetyKey: "other", reviewUnconfirmed: true, reviewConfirmed: true },
  { url: `${BASE}/training/opening`, gameId: null, play: false, safetyKey: "other", reviewUnconfirmed: true, reviewConfirmed: true },
  { url: `${BASE}/@/player1`, gameId: null, play: false, safetyKey: "other", reviewUnconfirmed: true, reviewConfirmed: true },
  { url: `${BASE}/@/player1/all`, gameId: null, play: false, safetyKey: "other", reviewUnconfirmed: true, reviewConfirmed: true },
  { url: `${BASE}/inbox`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/practice`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/AbCdEf12/analysis`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/AbCdEf1234`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${BASE}/@/`, gameId: null, play: true, safetyKey: "play", reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${HTTP_BASE}/AbCdEf12`, gameId: "AbCdEf12", play: false, safetyKey: null, reviewUnconfirmed: false, reviewConfirmed: true },
  { url: `${OTHER_BASE}/${HOST}/AbCdEf12`, gameId: null, play: false, safetyKey: null, reviewUnconfirmed: false, reviewConfirmed: false },
  { url: `${LOOKALIKE_BASE}/AbCdEf12`, gameId: null, play: false, safetyKey: null, reviewUnconfirmed: false, reviewConfirmed: false },
];

test("Lichess address classification covers game IDs, play pages, ordinary pages, and look-alikes", () => {
  assert.ok(ADDRESS_CASES.length >= 30);
  for (const c of ADDRESS_CASES) {
    assert.equal(gameIdFromPage(c.url), c.gameId, `gameIdFromPage(${c.url})`);
    assert.equal(isPlayPage(new URL(c.url)), c.play, `isPlayPage(${c.url})`);
    assert.equal(pageSafetyKey(c.url), c.safetyKey, `pageSafetyKey(${c.url})`);
    assert.equal(canReview(c.url, false), c.reviewUnconfirmed, `canReview(${c.url}, false)`);
    assert.equal(canReview(c.url, true), c.reviewConfirmed, `canReview(${c.url}, true)`);
  }
  assert.equal(gameIdFromPage(null), null);
  assert.equal(gameIdFromPage(undefined), null);
  assert.equal(gameIdFromPage("not a url"), null);
  assert.equal(pageSafetyKey(undefined), null);
  assert.equal(canReview("not a url", true), false);
});

test("Lichess status mapping covers every status value and reads only status", () => {
  const allStatuses = [
    ...LICHESS_PENDING_STATUSES,
    ...LICHESS_ABORTED_STATUSES,
    ...LICHESS_FINISHED_STATUSES,
  ];
  assert.equal(allStatuses.length, 14);
  for (const status of LICHESS_PENDING_STATUSES) {
    assert.equal(classifyLichessStatus(status), "pending", status);
    assert.equal(isAbortedStatus(status), false, status);
    assert.equal(canShowRecap("AbCdEf12", status), false, status);
  }
  for (const status of LICHESS_ABORTED_STATUSES) {
    assert.equal(classifyLichessStatus(status), "aborted", status);
    assert.equal(isAbortedStatus(status), true, status);
    assert.equal(canShowRecap("AbCdEf12", status), false, status);
  }
  for (const status of LICHESS_FINISHED_STATUSES) {
    assert.equal(classifyLichessStatus(status), "finished", status);
    assert.equal(isAbortedStatus(status), false, status);
    assert.equal(canShowRecap("AbCdEf12", status), true, status);
    assert.equal(canShowRecap(null, status), false, status);
  }
  assert.equal(classifyLichessStatus(undefined), "pending");
  assert.equal(classifyLichessStatus(null), "pending");
  assert.equal(classifyLichessStatus("unexpectedFutureStatus"), "pending");

  let touchedMoves = false;
  const inPlayExport = {
    status: "started",
    get moves() { touchedMoves = true; return "e4 e5"; },
    get clocks() { touchedMoves = true; return [18000, 18000]; },
  };
  assert.equal(readStatusOnly(inPlayExport), "pending");
  assert.equal(touchedMoves, false);
});

test("status check pacing enforces 3-second minimum and 1-minute 429 cooldown", () => {
  assert.equal(STATUS_CHECK_INTERVAL_MS, 3000);
  assert.equal(RATE_LIMIT_COOLDOWN_MS, 60_000);
  assert.equal(nextStatusCheckDelayMs(200, 0), 3000);
  assert.equal(nextStatusCheckDelayMs(200, 1200), 1800);
  assert.equal(nextStatusCheckDelayMs(200, 3500), 0);
  assert.equal(nextStatusCheckDelayMs(429, 5000), 60_000);
});
