import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.join(__dirname, "server.js");
const patchedServerPath = path.join(__dirname, "server.runtime.js");
const appPath = path.join(__dirname, "public", "app.js");

let serverCode = readFileSync(serverPath, "utf8");

function replaceServer(needle, replacement, label) {
  if (!serverCode.includes(needle)) {
    throw new Error(`runtime patch failed: missing server block ${label}`);
  }
  serverCode = serverCode.replace(needle, replacement);
}

replaceServer(
  'const SUPABASE_RETRY_COUNT = clamp(Number(process.env.SUPABASE_RETRY_COUNT || 5), 1, 5);\nlet scheduledTrackingRunning = false;',
  'const SUPABASE_RETRY_COUNT = clamp(Number(process.env.SUPABASE_RETRY_COUNT || 5), 1, 5);\nconst SCHEDULE_FAILURE_COOLDOWN_MS = clamp(Number(process.env.SCHEDULE_FAILURE_COOLDOWN_MS || 600000), 60000, 3600000);\nlet scheduledTrackingRunning = false;\nlet nextScheduleCheckAt = 0;',
  "schedule cooldown vars"
);

replaceServer(
  'async function readDb() {\n  if (useSupabase()) {\n    const data = await readSupabaseState();\n    return normalizeDb(data);\n  }\n\n  await ensureDb();\n  const raw = await readFile(DB_FILE, "utf8");\n  const db = JSON.parse(raw);\n  return normalizeDb(db);\n}\n\nasync function writeDb(db) {',
  'async function readDb() {\n  if (useSupabase()) {\n    const data = await readSupabaseState();\n    return normalizeDb(data);\n  }\n\n  await ensureDb();\n  const raw = await readFile(DB_FILE, "utf8");\n  const db = JSON.parse(raw);\n  return normalizeDb(db);\n}\n\nasync function readDbLight() {\n  if (useSupabase()) {\n    const data = await readSupabaseStateLight();\n    return normalizeDb(data);\n  }\n\n  return readDb();\n}\n\nasync function writeDb(db) {',
  "readDbLight"
);

replaceServer(
  'async function ensureSupabaseState() {\n  const existing = await readSupabaseState({ allowMissing: true });\n  if (existing) return;',
  'async function ensureSupabaseState() {\n  const existing = await readSupabaseStateExists();\n  if (existing) return;',
  "ensure exists"
);

replaceServer(
  'async function readSupabaseState(options = {}) {',
  'async function readSupabaseStateExists() {\n  const response = await supabaseFetch(`/${SUPABASE_STATE_TABLE}?id=eq.main&select=id&limit=1`, {\n    method: "GET",\n    retries: 1\n  });\n\n  if (!response.ok) {\n    if (response.status === 404) return false;\n    await throwSupabaseError(response, "Supabase 상태 저장소를 확인하지 못했습니다.");\n  }\n\n  const rows = await response.json();\n  return Array.isArray(rows) && rows.length > 0;\n}\n\nasync function readSupabaseStateLight() {\n  const select = encodeURIComponent("users:data->users,sessions:data->sessions,products:data->products,meta:data->meta");\n  const response = await supabaseFetch(`/${SUPABASE_STATE_TABLE}?id=eq.main&select=${select}`, {\n    method: "GET"\n  });\n\n  if (!response.ok) {\n    await throwSupabaseError(response, "Supabase 상태 저장소를 부분 조회하지 못했습니다.");\n  }\n\n  const rows = await response.json();\n  if (!Array.isArray(rows) || !rows.length) return initialDb();\n  const row = rows[0] || {};\n  return {\n    users: row.users || [],\n    sessions: row.sessions || {},\n    products: row.products || [],\n    snapshots: [],\n    meta: row.meta || {}\n  };\n}\n\nasync function readSupabaseState(options = {}) {',
  "light supabase readers"
);

replaceServer(
  '  if (method === "GET" && requestUrl.pathname === "/api/config") {\n    const optionalUser = await getOptionalUser(req);\n    sendJson(res, 200, {\n      hasNaverKeys: Boolean(NAVER_CLIENT_ID && NAVER_CLIENT_SECRET),\n      hasSupabase: useSupabase(),\n      scanLimit: RANK_SCAN_LIMIT,\n      productLimit: optionalUser ? getUserProductLimit(optionalUser) : FREE_PRODUCT_LIMIT,',
  '  if (method === "GET" && requestUrl.pathname === "/api/config") {\n    sendJson(res, 200, {\n      hasNaverKeys: Boolean(NAVER_CLIENT_ID && NAVER_CLIENT_SECRET),\n      hasSupabase: useSupabase(),\n      scanLimit: RANK_SCAN_LIMIT,\n      productLimit: FREE_PRODUCT_LIMIT,',
  "config without db"
);

replaceServer(
  '  if (method === "GET" && requestUrl.pathname === "/api/notices") {\n    const optionalUser = await getOptionalUser(req);\n    const db = await readDb();',
  '  if (method === "GET" && requestUrl.pathname === "/api/notices") {\n    const optionalUser = await getOptionalUser(req);\n    const db = await readDbLight();',
  "notices light"
);

replaceServer(
  '  const db = await readDb();\n  const user = db.users.find((item) => normalizePhone(item.phone) === phone);',
  '  const db = await readDbLight();\n  const user = db.users.find((item) => normalizePhone(item.phone) === phone);',
  "login light"
);

replaceServer(
  '  const token = createSession(db, user.id, Date.now());\n  await writeDb(db);\n  setSessionCookie(req, res, token);',
  '  const token = createSessionToken(user.id, Date.now());\n  setSessionCookie(req, res, token);',
  "login stateless token"
);

replaceServer(
  'async function logoutUser(req, res) {\n  const token = getSessionToken(req);\n  if (token) {\n    const db = await readDb();\n    delete db.sessions[token];\n    await writeDb(db);\n  }\n  clearSessionCookie(req, res);\n  sendJson(res, 200, { ok: true });\n}',
  'async function logoutUser(req, res) {\n  clearSessionCookie(req, res);\n  sendJson(res, 200, { ok: true });\n}',
  "logout no db"
);

replaceServer(
  'async function getOptionalUser(req) {\n  const token = getSessionToken(req);\n  if (!token) return null;\n  const db = await readDb();\n  const session = db.sessions[token];\n  if (!session || session.expiresAt < Date.now()) return null;\n  return db.users.find((item) => item.id === session.userId) || null;\n}',
  'async function getOptionalUser(req) {\n  const sessionAuth = parseSessionAuth(req);\n  if (!sessionAuth) return null;\n  const db = await readDbLight();\n  const userId = sessionAuth.userId || db.sessions?.[sessionAuth.legacyToken]?.userId || "";\n  if (!userId) return null;\n  const legacySession = sessionAuth.legacyToken ? db.sessions?.[sessionAuth.legacyToken] : null;\n  if (legacySession && legacySession.expiresAt < Date.now()) return null;\n  return db.users.find((item) => item.id === userId) || null;\n}',
  "optional user light"
);

replaceServer(
  '  if (req.method === "GET" && requestUrl.pathname === "/api/admin/overview") {\n    const limit = clamp(Number(requestUrl.searchParams.get("limit") || 200), 50, 1000);\n    const db = await readDb();',
  '  if (req.method === "GET" && requestUrl.pathname === "/api/admin/overview") {\n    const limit = clamp(Number(requestUrl.searchParams.get("limit") || 200), 50, 1000);\n    const db = await readDbLight();',
  "admin overview light"
);

replaceServer(
  'async function requireAuth(req, res) {\n  const token = getSessionToken(req);\n  if (!token) {\n    sendJson(res, 401, { error: "UNAUTHORIZED", message: "로그인이 필요합니다." });\n    return null;\n  }\n\n  const db = await readDb();\n  const session = db.sessions[token];\n  if (!session || session.expiresAt < Date.now()) {\n    delete db.sessions[token];\n    await writeDb(db);\n    clearSessionCookie(req, res);\n    sendJson(res, 401, { error: "SESSION_EXPIRED", message: "세션이 만료되었습니다." });\n    return null;\n  }\n\n  const user = db.users.find((item) => item.id === session.userId);\n  if (!user) {\n    delete db.sessions[token];\n    await writeDb(db);\n    clearSessionCookie(req, res);\n    sendJson(res, 401, { error: "UNAUTHORIZED", message: "사용자를 찾을 수 없습니다." });\n    return null;\n  }\n\n  if (getUserRestrictions(user).suspended) {\n    delete db.sessions[token];\n    await writeDb(db);\n    clearSessionCookie(req, res);\n    sendJson(res, 403, { error: "ACCOUNT_SUSPENDED", message: getRestrictionMessage(user, "계정 사용이 일시 제한되었습니다.") });\n    return null;\n  }\n\n  if (!isUserApproved(user)) {\n    delete db.sessions[token];\n    await writeDb(db);\n    clearSessionCookie(req, res);\n    sendJson(res, 403, { error: "APPROVAL_PENDING", message: "관리자 승인 후 사용할 수 있습니다." });\n    return null;\n  }\n\n  return { db, user, token };\n}',
  'async function requireAuth(req, res) {\n  const sessionAuth = parseSessionAuth(req);\n  if (!sessionAuth) {\n    sendJson(res, 401, { error: "UNAUTHORIZED", message: "로그인이 필요합니다." });\n    return null;\n  }\n\n  const db = await readDbLight();\n  let userId = sessionAuth.userId || "";\n  if (!userId && sessionAuth.legacyToken) {\n    const session = db.sessions?.[sessionAuth.legacyToken];\n    if (!session || session.expiresAt < Date.now()) {\n      clearSessionCookie(req, res);\n      sendJson(res, 401, { error: "SESSION_EXPIRED", message: "세션이 만료되었습니다." });\n      return null;\n    }\n    userId = session.userId;\n  }\n\n  if (!userId) {\n    clearSessionCookie(req, res);\n    sendJson(res, 401, { error: "SESSION_EXPIRED", message: "세션이 만료되었습니다." });\n    return null;\n  }\n\n  const user = db.users.find((item) => item.id === userId);\n  if (!user) {\n    clearSessionCookie(req, res);\n    sendJson(res, 401, { error: "UNAUTHORIZED", message: "사용자를 찾을 수 없습니다." });\n    return null;\n  }\n\n  if (getUserRestrictions(user).suspended) {\n    clearSessionCookie(req, res);\n    sendJson(res, 403, { error: "ACCOUNT_SUSPENDED", message: getRestrictionMessage(user, "계정 사용이 일시 제한되었습니다.") });\n    return null;\n  }\n\n  if (!isUserApproved(user)) {\n    clearSessionCookie(req, res);\n    sendJson(res, 403, { error: "APPROVAL_PENDING", message: "관리자 승인 후 사용할 수 있습니다." });\n    return null;\n  }\n\n  return { db, user, token: sessionAuth.token };\n}',
  "requireAuth light"
);

replaceServer(
  'function getSessionToken(req) {\n  const cookies = parseCookies(req.headers.cookie || "");\n  const value = cookies.sr_session;\n  if (!value || !value.includes(".")) return "";\n  const [raw, signature] = value.split(".");\n  if (!raw || !signature || signToken(raw) !== signature) return "";\n  return raw;\n}',
  'function createSessionToken(userId, now) {\n  const payload = Buffer.from(JSON.stringify({\n    userId,\n    createdAt: now,\n    expiresAt: now + 1000 * 60 * 60 * 24 * 30\n  }), "utf8").toString("base64url");\n  const raw = `v2.${payload}`;\n  return `${raw}.${signToken(raw)}`;\n}\n\nfunction parseSessionAuth(req) {\n  const value = getSessionCookie(req);\n  if (!value || !value.includes(".")) return null;\n\n  const parts = value.split(".");\n  if (parts[0] === "v2" && parts.length === 3) {\n    const raw = `${parts[0]}.${parts[1]}`;\n    const signature = parts[2];\n    if (!signature || signToken(raw) !== signature) return null;\n    try {\n      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));\n      if (!payload.userId || Number(payload.expiresAt || 0) < Date.now()) return null;\n      return {\n        token: value,\n        userId: payload.userId,\n        expiresAt: Number(payload.expiresAt || 0),\n        stateless: true\n      };\n    } catch {\n      return null;\n    }\n  }\n\n  const legacyToken = getLegacySessionToken(value);\n  if (!legacyToken) return null;\n  return { token: value, legacyToken, stateless: false };\n}\n\nfunction getSessionCookie(req) {\n  const cookies = parseCookies(req.headers.cookie || "");\n  return cookies.sr_session || "";\n}\n\nfunction getLegacySessionToken(value) {\n  if (!value || !value.includes(".")) return "";\n  const [raw, signature] = value.split(".");\n  if (!raw || !signature || signToken(raw) !== signature) return "";\n  return raw;\n}',
  "session parser"
);

replaceServer(
  '  const tick = () => {\n    checkScheduledTracking().catch((error) => {\n      console.error("Scheduled tracking failed", error);\n    });\n  };',
  '  const tick = () => {\n    if (Date.now() < nextScheduleCheckAt) return;\n    checkScheduledTracking().catch((error) => {\n      nextScheduleCheckAt = Date.now() + SCHEDULE_FAILURE_COOLDOWN_MS;\n      console.error("Scheduled tracking failed", error);\n    });\n  };',
  "schedule failure cooldown"
);

writeFileSync(patchedServerPath, serverCode, "utf8");

let appCode = readFileSync(appPath, "utf8");
function replaceApp(needle, replacement, label) {
  if (!appCode.includes(needle)) return;
  appCode = appCode.replace(needle, replacement);
}

replaceApp(
  'async function loadAll() {\n  await Promise.all([loadProducts(), loadReport(), loadNotices()]);\n}',
  'async function loadAll() {\n  await Promise.all([\n    loadProducts().catch((error) => toast(error.message)),\n    loadNotices().catch(() => {}),\n    loadReport({ timeoutMs: 8000, retries: 0 }).catch(() => {\n      state.report = null;\n    })\n  ]);\n}',
  "loadAll soft fail"
);

replaceApp(
  'async function loadReport() {\n  state.report = await api("/api/report");\n}',
  'async function loadReport(options = {}) {\n  state.report = await api("/api/report", options);\n}',
  "loadReport options"
);

writeFileSync(appPath, appCode, "utf8");

await import(pathToFileURL(patchedServerPath).href);
