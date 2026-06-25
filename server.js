import http from "node:http";
import { createReadStream, readFileSync } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = process.env.DATA_FILE || path.join(DATA_DIR, "db.json");
const SUPABASE_URL = trimTrailingSlash(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_STATE_TABLE = process.env.SUPABASE_STATE_TABLE || "soondaeng_state";
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || "";
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const CRON_SECRET = process.env.CRON_SECRET || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const FREE_PRODUCT_LIMIT = clamp(Number(process.env.FREE_PRODUCT_LIMIT || 100), 1, 1000);
const MIN_USER_PRODUCT_LIMIT = 100;
const MAX_USER_PRODUCT_LIMIT = 1000;
const RANK_SCAN_LIMIT = 50;
const MAX_SNAPSHOT_ROWS = clamp(Number(process.env.MAX_SNAPSHOT_ROWS || 0), 0, 5000000);
const SCHEDULE_TIMEZONE = process.env.SCHEDULE_TIMEZONE || "Asia/Seoul";
const SCHEDULE_TIMES = parseScheduleTimes(process.env.SCHEDULE_TIMES || "08:00");
const SCHEDULE_CATCHUP_MINUTES = clamp(Number(process.env.SCHEDULE_CATCHUP_MINUTES || 720), 0, 1440);
const SCHEDULE_RETRY_AFTER_MINUTES = clamp(Number(process.env.SCHEDULE_RETRY_AFTER_MINUTES || 30), 5, 240);
const REPORT_RECIPIENTS = splitRecipients(process.env.REPORT_RECIPIENTS || "");
const REPORT_FROM = process.env.REPORT_FROM || process.env.EMAIL_FROM || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ADMIN_APP_URL = trimTrailingSlash(process.env.ADMIN_APP_URL || "https://soondaeng-admin.onrender.com");
const SUPABASE_TIMEOUT_MS = clamp(Number(process.env.SUPABASE_TIMEOUT_MS || 15000), 3000, 60000);
const SUPABASE_RETRY_COUNT = clamp(Number(process.env.SUPABASE_RETRY_COUNT || 3), 1, 5);
let scheduledTrackingRunning = false;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

await mkdir(DATA_DIR, { recursive: true });
await ensureDb();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(req, res, requestUrl);
      return;
    }
    await serveStatic(req, res, requestUrl);
  } catch (error) {
    console.error(error);
    sendJson(res, error.statusCode || 500, {
      error: error.code || "SERVER_ERROR",
      message: error.publicMessage || "서버 오류가 발생했습니다."
    });
  }
});

server.listen(PORT, () => {
  console.log(`Soondaeng running at http://localhost:${PORT}`);
});

startScheduleWorker();

function loadEnvFile(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const equalIndex = trimmed.indexOf("=");
      if (equalIndex === -1) return;
      const key = trimmed.slice(0, equalIndex).trim();
      let value = trimmed.slice(equalIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    });
  } catch {
    // .env is optional in hosted environments.
  }
}

async function ensureDb() {
  if (useSupabase()) {
    await ensureSupabaseState();
    return;
  }

  try {
    await access(DB_FILE);
  } catch {
    await writeDb(initialDb());
  }
}

async function readDb() {
  if (useSupabase()) {
    const data = await readSupabaseState();
    return normalizeDb(data);
  }

  await ensureDb();
  const raw = await readFile(DB_FILE, "utf8");
  const db = JSON.parse(raw);
  return normalizeDb(db);
}

async function writeDb(db) {
  const normalized = normalizeDb(db);

  if (useSupabase()) {
    await writeSupabaseState(normalized);
    return;
  }

  await mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${DB_FILE}.${process.pid}.tmp`;
  await writeFile(tempFile, JSON.stringify(normalized, null, 2), "utf8");
  await rename(tempFile, DB_FILE);
}

function normalizeDb(db) {
  db = db || {};
  return {
    users: Array.isArray(db.users) ? db.users : [],
    sessions: db.sessions && typeof db.sessions === "object" ? db.sessions : {},
    products: Array.isArray(db.products) ? db.products : [],
    snapshots: Array.isArray(db.snapshots) ? db.snapshots : [],
    meta: db.meta && typeof db.meta === "object" ? db.meta : {}
  };
}

function initialDb() {
  return { users: [], sessions: {}, products: [], snapshots: [], meta: {} };
}

function useSupabase() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function ensureSupabaseState() {
  const existing = await readSupabaseState({ allowMissing: true });
  if (existing) return;

  const response = await supabaseFetch(`/${SUPABASE_STATE_TABLE}`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: {
      id: "main",
      data: initialDb(),
      updated_at: new Date().toISOString()
    }
  });

  if (!response.ok && response.status !== 409) {
    await throwSupabaseError(response, "Supabase 상태 저장소를 초기화하지 못했습니다.");
  }
}

async function readSupabaseState(options = {}) {
  const response = await supabaseFetch(`/${SUPABASE_STATE_TABLE}?id=eq.main&select=data`, {
    method: "GET"
  });

  if (!response.ok) {
    if (options.allowMissing && response.status === 404) return null;
    await throwSupabaseError(response, "Supabase 상태 저장소를 읽지 못했습니다.");
  }

  const rows = await response.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows[0].data || null;
}

async function writeSupabaseState(db) {
  const response = await supabaseFetch(`/${SUPABASE_STATE_TABLE}?id=eq.main`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: {
      data: db,
      updated_at: new Date().toISOString()
    }
  });

  if (!response.ok) {
    await throwSupabaseError(response, "Supabase 상태 저장소를 저장하지 못했습니다.");
  }
}

async function supabaseFetch(pathname, options = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(options.headers || {})
  };

  const init = { method: options.method || "GET", headers };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const attempts = options.retries || SUPABASE_RETRY_COUNT;
  let lastError = null;
  let lastResponse = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1${pathname}`, {
        ...init,
        signal: controller.signal
      });
      if (!isTransientStatus(response.status) || attempt === attempts) return response;
      lastResponse = response;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    } finally {
      clearTimeout(timeout);
    }
    await sleep(350 * attempt);
  }

  if (lastResponse) return lastResponse;
  const error = new Error(`Supabase request failed: ${lastError?.message || "unknown"}`);
  error.publicMessage = "Supabase 연결이 잠시 불안정합니다. 잠시 뒤 다시 시도해 주세요.";
  throw error;
}

async function throwSupabaseError(response, fallbackMessage) {
  const detail = await response.text().catch(() => "");
  const error = new Error(`${fallbackMessage} (${response.status}) ${detail}`);
  error.publicMessage = `${fallbackMessage} Supabase 테이블과 환경변수를 확인하세요.`;
  throw error;
}

async function handleApi(req, res, requestUrl) {
  const method = req.method || "GET";
  const segments = requestUrl.pathname.split("/").filter(Boolean);

  if (method === "GET" && requestUrl.pathname === "/api/config") {
    const optionalUser = await getOptionalUser(req);
    sendJson(res, 200, {
      hasNaverKeys: Boolean(NAVER_CLIENT_ID && NAVER_CLIENT_SECRET),
      hasSupabase: useSupabase(),
      scanLimit: RANK_SCAN_LIMIT,
      productLimit: optionalUser ? getUserProductLimit(optionalUser) : FREE_PRODUCT_LIMIT,
      scheduleTimes: SCHEDULE_TIMES.map((item) => item.label),
      scheduleTimezone: SCHEDULE_TIMEZONE,
      scheduleCatchupMinutes: SCHEDULE_CATCHUP_MINUTES,
      emailConfigured: Boolean(RESEND_API_KEY && REPORT_FROM)
    });
    return;
  }

  if (requestUrl.pathname.startsWith("/api/admin")) {
    await handleAdminApi(req, res, requestUrl);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/auth/register") {
    const body = await readJson(req);
    await registerUser(req, res, body);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/auth/login") {
    const body = await readJson(req);
    await loginUser(req, res, body);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/auth/logout") {
    await logoutUser(req, res);
    return;
  }

  if ((method === "GET" || method === "POST") && requestUrl.pathname === "/api/cron/track") {
    await runCronTracking(req, res, requestUrl);
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/notices") {
    const optionalUser = await getOptionalUser(req);
    const db = await readDb();
    sendJson(res, 200, buildPublicNotices(db, optionalUser));
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (method === "GET" && requestUrl.pathname === "/api/me") {
    sendJson(res, 200, { user: publicUser(auth.user) });
    return;
  }

  if ((method === "PATCH" || method === "PUT" || method === "POST") && requestUrl.pathname === "/api/me") {
    const body = await readJson(req);
    await updateUserProfile(req, res, auth.user, body);
    return;
  }

  if (method === "POST" && segments[0] === "api" && segments[1] === "notices" && segments[2] && segments[3] === "comments") {
    const body = await readJson(req);
    const db = auth.db;
    const notice = createNoticeComment(db, segments[2], auth.user, body);
    await writeDb(db);
    sendJson(res, 201, { notice });
    return;
  }

  if (((method === "POST" && segments[5] === "delete") || method === "DELETE") && segments[0] === "api" && segments[1] === "notices" && segments[2] && segments[3] === "comments" && segments[4]) {
    const db = auth.db;
    const result = deleteNoticeComment(db, segments[2], segments[4], { user: auth.user });
    await writeDb(db);
    sendJson(res, 200, result);
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/products") {
    const db = await readDb();
    const products = db.products
      .filter((product) => product.userId === auth.user.id)
      .map((product) => publicProduct(product, db, auth.user.id));
    sendJson(res, 200, { products, productLimit: getUserProductLimit(auth.user), restrictions: getUserRestrictions(auth.user) });
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/activity") {
    const db = await readDb();
    sendJson(res, 200, buildUserActivity(db, auth.user.id));
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/report") {
    const db = await readDb();
    sendJson(res, 200, buildRankReport(db, { userId: auth.user.id }));
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/report/export") {
    const db = await readDb();
    const report = buildRankReport(db, { userId: auth.user.id });
    sendWorkbook(res, buildRankReportWorkbook(report), reportFileName(report));
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/report/send") {
    await sendUserReportRoute(req, res, auth.user);
    return;
  }

  if (method === "GET" && requestUrl.pathname === "/api/history") {
    const db = await readDb();
    sendJson(res, 200, buildUserHistory(db, auth.user.id, requestUrl));
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/products") {
    const body = await readJson(req);
    await createProduct(req, res, auth.user, body);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/products/bulk") {
    const body = await readJson(req);
    await bulkCreateProducts(req, res, auth.user, body);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/products/preview") {
    const body = await readJson(req);
    await previewProduct(req, res, auth.user, body);
    return;
  }

  if (method === "POST" && requestUrl.pathname === "/api/track-all") {
    await trackAllProducts(req, res, auth.user);
    return;
  }

  if (segments[0] === "api" && segments[1] === "products" && segments[2]) {
    const productId = segments[2];

    if (method === "DELETE" && segments.length === 3) {
      await deleteProduct(req, res, auth.user, productId);
      return;
    }

    if (method === "POST" && segments[3] === "track") {
      await trackProductRoute(req, res, auth.user, productId);
      return;
    }

    if (method === "POST" && segments[3] === "keywords" && segments[4] && segments[5] === "track") {
      await trackKeywordRoute(req, res, auth.user, productId, segments[4]);
      return;
    }
  }

  sendJson(res, 404, { error: "NOT_FOUND", message: "요청한 API를 찾을 수 없습니다." });
}

async function registerUser(req, res, body) {
  const email = String(body.email || "").trim().toLowerCase();
  const phone = normalizePhone(body.phone);
  const password = String(body.password || "");
  const storeName = String(body.storeName || "").trim();
  const privacyConsent = body.privacyConsent === true || body.privacyConsent === "true" || body.privacyConsent === "on";

  if (!isValidEmail(email)) {
    sendJson(res, 400, { error: "INVALID_EMAIL", message: "이메일 형식이 올바르지 않습니다." });
    return;
  }

  if (!isValidPhone(phone)) {
    sendJson(res, 400, { error: "INVALID_PHONE", message: "전화번호는 010으로 시작하는 숫자 11자리로 입력해 주세요. 예: 01012345678" });
    return;
  }

  if (password.length < 8) {
    sendJson(res, 400, { error: "WEAK_PASSWORD", message: "비밀번호는 8자 이상이어야 합니다." });
    return;
  }

  if (!privacyConsent) {
    sendJson(res, 400, { error: "PRIVACY_CONSENT_REQUIRED", message: "개인정보 수집 및 이용에 동의해 주세요." });
    return;
  }

  const db = await readDb();
  if (db.users.some((user) => user.email === email)) {
    sendJson(res, 409, { error: "EMAIL_EXISTS", message: "이미 가입된 이메일입니다." });
    return;
  }

  if (db.users.some((user) => normalizePhone(user.phone) === phone)) {
    sendJson(res, 409, { error: "PHONE_EXISTS", message: "이미 가입된 전화번호입니다." });
    return;
  }

  const now = Date.now();
  const user = {
    id: uid(),
    email,
    phone,
    storeName,
    passwordHash: hashPassword(password),
    approvalStatus: "pending",
    approvalRequestedAt: now,
    approvedAt: null,
    rejectedAt: null,
    privacyConsentAt: now,
    createdAt: now
  };

  db.users.push(user);
  await writeDb(db);
  sendJson(res, 201, {
    user: publicUser(user),
    approvalPending: true,
    message: "회원가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다."
  });
}

async function loginUser(req, res, body) {
  const phone = normalizePhone(body.phone);
  const password = String(body.password || "");

  if (!isValidPhone(phone)) {
    sendJson(res, 400, { error: "INVALID_PHONE", message: "전화번호는 010으로 시작하는 숫자 11자리로 입력해 주세요. 예: 01012345678" });
    return;
  }

  const db = await readDb();
  const user = db.users.find((item) => normalizePhone(item.phone) === phone);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    sendJson(res, 401, { error: "BAD_LOGIN", message: "전화번호 또는 비밀번호가 맞지 않습니다." });
    return;
  }

  if (!isUserApproved(user)) {
    sendJson(res, 403, {
      error: user.approvalStatus === "rejected" ? "ACCOUNT_REJECTED" : "APPROVAL_PENDING",
      message: user.approvalStatus === "rejected"
        ? "관리자 승인에서 거절된 계정입니다. 관리자에게 문의해 주세요."
        : "관리자 승인 대기 중입니다. 승인 후 로그인할 수 있습니다."
    });
    return;
  }

  if (getUserRestrictions(user).suspended) {
    sendJson(res, 403, { error: "ACCOUNT_SUSPENDED", message: getRestrictionMessage(user, "계정 사용이 일시 제한되었습니다.") });
    return;
  }

  const token = createSession(db, user.id, Date.now());
  await writeDb(db);
  setSessionCookie(req, res, token);
  sendJson(res, 200, { user: publicUser(user) });
}

async function logoutUser(req, res) {
  const token = getSessionToken(req);
  if (token) {
    const db = await readDb();
    delete db.sessions[token];
    await writeDb(db);
  }
  clearSessionCookie(req, res);
  sendJson(res, 200, { ok: true });
}

async function updateUserProfile(req, res, currentUser, body) {
  const email = String(body.email || "").trim().toLowerCase();
  const phone = normalizePhone(body.phone);
  const storeName = String(body.storeName || "").trim().slice(0, 80);
  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");

  if (!isValidEmail(email)) {
    sendJson(res, 400, { error: "INVALID_EMAIL", message: "이메일 형식이 올바르지 않습니다." });
    return;
  }

  if (!isValidPhone(phone)) {
    sendJson(res, 400, { error: "INVALID_PHONE", message: "전화번호는 010으로 시작하는 숫자 11자리로 입력해 주세요. 예: 01012345678" });
    return;
  }

  if (newPassword && newPassword.length < 8) {
    sendJson(res, 400, { error: "WEAK_PASSWORD", message: "새 비밀번호는 8자 이상이어야 합니다." });
    return;
  }

  const db = await readDb();
  const user = db.users.find((item) => item.id === currentUser.id);
  if (!user) {
    sendJson(res, 404, { error: "USER_NOT_FOUND", message: "회원 정보를 찾을 수 없습니다." });
    return;
  }

  if (db.users.some((item) => item.id !== user.id && item.email === email)) {
    sendJson(res, 409, { error: "EMAIL_EXISTS", message: "이미 가입된 이메일입니다." });
    return;
  }

  if (db.users.some((item) => item.id !== user.id && normalizePhone(item.phone) === phone)) {
    sendJson(res, 409, { error: "PHONE_EXISTS", message: "이미 가입된 전화번호입니다." });
    return;
  }

  if (newPassword) {
    if (!currentPassword || !verifyPassword(currentPassword, user.passwordHash)) {
      sendJson(res, 401, { error: "BAD_PASSWORD", message: "현재 비밀번호가 맞지 않습니다." });
      return;
    }
    user.passwordHash = hashPassword(newPassword);
  }

  user.email = email;
  user.phone = phone;
  user.storeName = storeName;
  user.updatedAt = Date.now();
  await writeDb(db);
  sendJson(res, 200, { user: publicUser(user), message: "회원 정보를 저장했습니다." });
}

async function getOptionalUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const db = await readDb();
  const session = db.sessions[token];
  if (!session || session.expiresAt < Date.now()) return null;
  return db.users.find((item) => item.id === session.userId) || null;
}

async function handleAdminApi(req, res, requestUrl) {
  if (!hasAdminAuthConfig()) {
    sendJson(res, 503, {
      error: "ADMIN_AUTH_MISSING",
      message: "본사이트 Render 환경변수에 ADMIN_SECRET이 설정되어 있지 않습니다."
    });
    return;
  }

  if (!isValidAdminRequest(req, requestUrl)) {
    sendJson(res, 401, { error: "UNAUTHORIZED", message: "관리자 비밀키가 본사이트 ADMIN_SECRET 값과 일치하지 않습니다." });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/admin/overview") {
    const limit = clamp(Number(requestUrl.searchParams.get("limit") || 1000), 100, 5000);
    const db = await readDb();
    sendJson(res, 200, buildAdminOverview(db, limit));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/admin/backup") {
    const db = await readDb();
    sendJson(res, 200, buildAdminBackup(db));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/admin/reports/latest") {
    const db = await readDb();
    sendJson(res, 200, buildRankReport(db));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/admin/reports/export") {
    const db = await readDb();
    const report = buildRankReport(db);
    sendWorkbook(res, buildRankReportWorkbook(report), reportFileName(report));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/admin/reports/send") {
    const db = await readDb();
    const reportResult = await createAndSendRankReport(db, `admin:${Date.now()}`, "admin");
    await writeDb(db);
    sendJson(res, 200, { ok: true, report: reportResult });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/admin/track-all") {
    const now = getTimeInZone(SCHEDULE_TIMEZONE);
    const slotKey = `admin:${now.date}:${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;
    const result = await runScheduledTracking(slotKey, "admin");
    sendJson(res, 200, { ok: true, source: "admin", ...result });
    return;
  }

  const adminSegments = requestUrl.pathname.split("/").filter(Boolean);

  if (req.method === "POST" && adminSegments[0] === "api" && adminSegments[1] === "admin" && adminSegments[2] === "users" && adminSegments[3]) {
    const action = adminSegments[4] || "";
    if (action === "force-delete" || action === "permanent-delete") {
      const db = await readDb();
      const result = deleteAdminUser(db, adminSegments[3], action === "permanent-delete" ? "permanent" : "force");
      await writeDb(db);
      sendJson(res, 200, result);
      return;
    }
  }

  if ((req.method === "POST" || req.method === "PATCH" || req.method === "PUT") && adminSegments[0] === "api" && adminSegments[1] === "admin" && adminSegments[2] === "users" && adminSegments[3] && adminSegments[4] === "settings") {
    const db = await readDb();
    const body = await readJson(req);
    const result = updateAdminUserSettings(db, adminSegments[3], body);
    await writeDb(db);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/admin/notices") {
    const db = await readDb();
    const body = await readJson(req);
    const notice = createNotice(db, body);
    await writeDb(db);
    sendJson(res, 201, { notice });
    return;
  }

  if ((req.method === "PATCH" || req.method === "PUT") && adminSegments[0] === "api" && adminSegments[1] === "admin" && adminSegments[2] === "notices" && adminSegments[3] && adminSegments.length === 4) {
    const db = await readDb();
    const body = await readJson(req);
    const notice = updateNotice(db, adminSegments[3], body);
    await writeDb(db);
    sendJson(res, 200, { notice });
    return;
  }

  if (((req.method === "POST" && adminSegments[6] === "delete") || req.method === "DELETE") && adminSegments[0] === "api" && adminSegments[1] === "admin" && adminSegments[2] === "notices" && adminSegments[3] && adminSegments[4] === "comments" && adminSegments[5]) {
    const db = await readDb();
    const result = deleteNoticeComment(db, adminSegments[3], adminSegments[5], { admin: true });
    await writeDb(db);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "DELETE" && adminSegments[0] === "api" && adminSegments[1] === "admin" && adminSegments[2] === "notices" && adminSegments[3] && adminSegments.length === 4) {
    const db = await readDb();
    const result = deleteNotice(db, adminSegments[3]);
    await writeDb(db);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "NOT_FOUND", message: "Admin API not found." });
}

function hasAdminAuthConfig() {
  return Boolean(ADMIN_SECRET || (ADMIN_USERNAME && ADMIN_PASSWORD));
}

function isValidAdminRequest(req, requestUrl) {
  const secret = getRequestSecret(req, requestUrl, "admin_secret", "x-admin-secret");
  if (ADMIN_SECRET && isValidSecret(ADMIN_SECRET, secret)) return true;

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return false;
  const username = String(req.headers["x-admin-username"] || requestUrl.searchParams.get("admin_username") || "");
  const password = String(req.headers["x-admin-password"] || requestUrl.searchParams.get("admin_password") || "");
  return isValidSecret(ADMIN_USERNAME, username) && isValidSecret(ADMIN_PASSWORD, password);
}

function deleteAdminUser(db, userId, mode) {
  const user = (db.users || []).find((item) => item.id === userId);
  if (!user) {
    const error = new Error("User not found");
    error.statusCode = 404;
    error.code = "USER_NOT_FOUND";
    error.publicMessage = "회원을 찾을 수 없습니다.";
    throw error;
  }

  const now = Date.now();
  let productCount = 0;
  let snapshotCount = 0;

  Object.keys(db.sessions || {}).forEach((token) => {
    if (db.sessions[token]?.userId === userId) delete db.sessions[token];
  });

  db.users = (db.users || []).filter((item) => item.id !== userId);

  if (mode === "permanent") {
    productCount = (db.products || []).filter((product) => product.userId === userId).length;
    snapshotCount = (db.snapshots || []).filter((snapshot) => snapshot.userId === userId).length;
    db.products = (db.products || []).filter((product) => product.userId !== userId);
    db.snapshots = (db.snapshots || []).filter((snapshot) => snapshot.userId !== userId);
  } else {
    db.products = (db.products || []).map((product) => {
      if (product.userId !== userId) return product;
      productCount += 1;
      return {
        ...product,
        disabled: true,
        disabledAt: now,
        deletedUserId: user.id,
        deletedUserEmail: user.email || "",
        deletedUserPhone: normalizePhone(user.phone),
        deletedUserStoreName: user.storeName || ""
      };
    });

    db.snapshots = (db.snapshots || []).map((snapshot) => {
      if (snapshot.userId !== userId) return snapshot;
      snapshotCount += 1;
      return {
        ...snapshot,
        deletedUserId: user.id,
        deletedUserEmail: user.email || "",
        deletedUserPhone: normalizePhone(user.phone),
        deletedUserStoreName: user.storeName || ""
      };
    });
  }

  db.meta = db.meta || {};
  db.meta.userDeletions = Array.isArray(db.meta.userDeletions) ? db.meta.userDeletions : [];
  db.meta.userDeletions.unshift({
    id: uid(),
    mode,
    userId: user.id,
    email: user.email || "",
    phone: normalizePhone(user.phone),
    storeName: user.storeName || "",
    productCount,
    snapshotCount,
    at: now
  });
  db.meta.userDeletions = db.meta.userDeletions.slice(0, 200);

  return { ok: true, mode, userId, productCount, snapshotCount };
}

function updateAdminUserSettings(db, userId, body) {
  const user = (db.users || []).find((item) => item.id === userId);
  if (!user) {
    const error = new Error("User not found");
    error.statusCode = 404;
    error.code = "USER_NOT_FOUND";
    error.publicMessage = "회원을 찾을 수 없습니다.";
    throw error;
  }

  const productLimit = body.productLimit === undefined || body.productLimit === null || body.productLimit === ""
    ? getUserProductLimit(user)
    : Number(body.productLimit);
  if (!Number.isInteger(productLimit) || productLimit < MIN_USER_PRODUCT_LIMIT || productLimit > MAX_USER_PRODUCT_LIMIT) {
    const error = new Error("Invalid product limit");
    error.statusCode = 400;
    error.code = "INVALID_PRODUCT_LIMIT";
    error.publicMessage = `상품 한도는 ${MIN_USER_PRODUCT_LIMIT}개부터 ${MAX_USER_PRODUCT_LIMIT}개까지 설정할 수 있습니다.`;
    throw error;
  }

  const restrictions = {
    suspended: Boolean(body.suspended),
    productCreateBlocked: Boolean(body.productCreateBlocked),
    manualTrackBlocked: Boolean(body.manualTrackBlocked),
    reason: String(body.reason || "").trim().slice(0, 240),
    updatedAt: Date.now()
  };

  const nextApprovalStatus = ["approved", "pending", "rejected"].includes(String(body.approvalStatus || ""))
    ? String(body.approvalStatus)
    : user.approvalStatus || "approved";

  user.productLimit = productLimit;
  user.restrictions = restrictions;
  if (nextApprovalStatus !== (user.approvalStatus || "approved")) {
    user.approvalStatus = nextApprovalStatus;
    if (nextApprovalStatus === "approved") {
      user.approvedAt = Date.now();
      user.rejectedAt = null;
    } else if (nextApprovalStatus === "rejected") {
      user.rejectedAt = Date.now();
      user.approvedAt = null;
    } else {
      user.approvedAt = null;
      user.rejectedAt = null;
      user.approvalRequestedAt = user.approvalRequestedAt || Date.now();
    }
  }
  user.updatedAt = Date.now();

  if (restrictions.suspended || !isUserApproved(user)) {
    Object.keys(db.sessions || {}).forEach((token) => {
      if (db.sessions[token]?.userId === userId) delete db.sessions[token];
    });
  }

  db.meta = db.meta || {};
  db.meta.userSettingLogs = Array.isArray(db.meta.userSettingLogs) ? db.meta.userSettingLogs : [];
  db.meta.userSettingLogs.unshift({
    id: uid(),
    userId: user.id,
    email: user.email || "",
    phone: normalizePhone(user.phone),
    productLimit,
    approvalStatus: user.approvalStatus || "approved",
    restrictions,
    at: Date.now()
  });
  db.meta.userSettingLogs = db.meta.userSettingLogs.slice(0, 300);

  return {
    ok: true,
    user: publicAdminUser(user, [], 0, 0)
  };
}

function getNotices(db, viewer = null) {
  const notices = Array.isArray(db.meta?.notices) ? db.meta.notices : [];
  return notices
    .filter((notice) => !notice.deletedAt)
    .sort((a, b) => Number(b.createdAt || b.updatedAt || 0) - Number(a.createdAt || a.updatedAt || 0))
    .map((notice) => publicNotice(notice, viewer));
}

function buildPublicNotices(db, viewer = null) {
  const notices = getNotices(db, viewer);
  return {
    latest: notices[0] || null,
    previous: notices.slice(1),
    notices
  };
}

function createNotice(db, body) {
  const title = String(body.title || "").trim().slice(0, 120);
  const bodyText = String(body.body || "").trim().slice(0, 5000);
  if (!title || !bodyText) {
    const error = new Error("Invalid notice");
    error.statusCode = 400;
    error.code = "INVALID_NOTICE";
    error.publicMessage = "공지 제목과 내용을 입력해 주세요.";
    throw error;
  }

  const now = Date.now();
  db.meta = db.meta || {};
  db.meta.notices = Array.isArray(db.meta.notices) ? db.meta.notices : [];
  const notice = {
    id: uid(),
    title,
    body: bodyText,
    createdAt: now,
    updatedAt: now
  };
  db.meta.notices.unshift(notice);
  return publicNotice(notice);
}

function updateNotice(db, noticeId, body) {
  db.meta = db.meta || {};
  db.meta.notices = Array.isArray(db.meta.notices) ? db.meta.notices : [];
  const notice = db.meta.notices.find((item) => item.id === noticeId && !item.deletedAt);
  if (!notice) {
    const error = new Error("Notice not found");
    error.statusCode = 404;
    error.code = "NOTICE_NOT_FOUND";
    error.publicMessage = "공지를 찾을 수 없습니다.";
    throw error;
  }

  const title = String(body.title || "").trim().slice(0, 120);
  const bodyText = String(body.body || "").trim().slice(0, 5000);
  if (!title || !bodyText) {
    const error = new Error("Invalid notice");
    error.statusCode = 400;
    error.code = "INVALID_NOTICE";
    error.publicMessage = "공지 제목과 내용을 입력해 주세요.";
    throw error;
  }

  notice.title = title;
  notice.body = bodyText;
  notice.updatedAt = Date.now();
  return publicNotice(notice);
}

function deleteNotice(db, noticeId) {
  db.meta = db.meta || {};
  db.meta.notices = Array.isArray(db.meta.notices) ? db.meta.notices : [];
  const notice = db.meta.notices.find((item) => item.id === noticeId && !item.deletedAt);
  if (!notice) {
    const error = new Error("Notice not found");
    error.statusCode = 404;
    error.code = "NOTICE_NOT_FOUND";
    error.publicMessage = "공지를 찾을 수 없습니다.";
    throw error;
  }
  notice.deletedAt = Date.now();
  return { ok: true, noticeId };
}

function createNoticeComment(db, noticeId, user, body) {
  db.meta = db.meta || {};
  db.meta.notices = Array.isArray(db.meta.notices) ? db.meta.notices : [];
  const notice = db.meta.notices.find((item) => item.id === noticeId && !item.deletedAt);
  if (!notice) {
    const error = new Error("Notice not found");
    error.statusCode = 404;
    error.code = "NOTICE_NOT_FOUND";
    error.publicMessage = "공지를 찾을 수 없습니다.";
    throw error;
  }

  const bodyText = String(body.body || "").trim().slice(0, 1000);
  if (!bodyText) {
    const error = new Error("Invalid notice comment");
    error.statusCode = 400;
    error.code = "INVALID_NOTICE_COMMENT";
    error.publicMessage = "댓글 내용을 입력해 주세요.";
    throw error;
  }

  notice.comments = Array.isArray(notice.comments) ? notice.comments : [];
  notice.comments.push({
    id: uid(),
    userId: user.id,
    userEmail: user.email || "",
    userPhone: normalizePhone(user.phone),
    storeName: user.storeName || "",
    body: bodyText,
    createdAt: Date.now()
  });
  notice.comments = notice.comments.slice(-200);
  notice.updatedAt = Date.now();
  return publicNotice(notice, user);
}

function deleteNoticeComment(db, noticeId, commentId, options = {}) {
  db.meta = db.meta || {};
  db.meta.notices = Array.isArray(db.meta.notices) ? db.meta.notices : [];
  const notice = db.meta.notices.find((item) => item.id === noticeId && !item.deletedAt);
  if (!notice) {
    const error = new Error("Notice not found");
    error.statusCode = 404;
    error.code = "NOTICE_NOT_FOUND";
    error.publicMessage = "공지를 찾을 수 없습니다.";
    throw error;
  }

  notice.comments = Array.isArray(notice.comments) ? notice.comments : [];
  const comment = notice.comments.find((item) => item.id === commentId && !item.deletedAt);
  if (!comment) {
    const error = new Error("Notice comment not found");
    error.statusCode = 404;
    error.code = "NOTICE_COMMENT_NOT_FOUND";
    error.publicMessage = "댓글을 찾을 수 없습니다.";
    throw error;
  }

  if (!options.admin && comment.userId !== options.user?.id) {
    const error = new Error("Forbidden notice comment delete");
    error.statusCode = 403;
    error.code = "COMMENT_DELETE_FORBIDDEN";
    error.publicMessage = "내가 작성한 댓글만 삭제할 수 있습니다.";
    throw error;
  }

  comment.deletedAt = Date.now();
  comment.deletedBy = options.admin ? "admin" : options.user?.id || "";
  notice.updatedAt = Date.now();
  return { ok: true, noticeId, commentId };
}

function publicNotice(notice, viewer = null) {
  return {
    id: notice.id,
    title: notice.title || "",
    body: notice.body || "",
    createdAt: notice.createdAt || null,
    updatedAt: notice.updatedAt || null,
    comments: (Array.isArray(notice.comments) ? notice.comments : [])
      .filter((comment) => !comment.deletedAt)
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
      .slice(-100)
      .map((comment) => publicNoticeComment(comment, viewer))
  };
}

function publicNoticeComment(comment, viewer = null) {
  const mine = Boolean(viewer?.id && comment.userId === viewer.id);
  return {
    id: comment.id,
    userEmail: maskEmail(comment.userEmail || ""),
    userPhone: maskPhone(comment.userPhone || ""),
    storeName: comment.storeName || "",
    body: comment.body || "",
    createdAt: comment.createdAt || null,
    mine,
    canDelete: mine
  };
}

function maskEmail(value) {
  const email = String(value || "");
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  return `${local.slice(0, 2)}***@${domain}`;
}

function maskPhone(value) {
  const phone = normalizePhone(value);
  if (!phone || phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function getUserProductLimit(user) {
  const value = Number(user?.productLimit || 0);
  if (Number.isInteger(value) && value >= MIN_USER_PRODUCT_LIMIT && value <= MAX_USER_PRODUCT_LIMIT) return value;
  return clamp(Number(FREE_PRODUCT_LIMIT || MIN_USER_PRODUCT_LIMIT), MIN_USER_PRODUCT_LIMIT, MAX_USER_PRODUCT_LIMIT);
}

function getUserRestrictions(user) {
  const restrictions = user?.restrictions && typeof user.restrictions === "object" ? user.restrictions : {};
  return {
    suspended: Boolean(restrictions.suspended || user?.suspended),
    productCreateBlocked: Boolean(restrictions.productCreateBlocked),
    manualTrackBlocked: Boolean(restrictions.manualTrackBlocked),
    reason: String(restrictions.reason || "").trim(),
    updatedAt: restrictions.updatedAt || null
  };
}

function isUserApproved(user) {
  return String(user?.approvalStatus || "approved") === "approved";
}

function getRestrictionMessage(user, fallback) {
  const restrictions = getUserRestrictions(user);
  return restrictions.reason ? `${fallback} 사유: ${restrictions.reason}` : fallback;
}

function publicAdminUser(user, ownedProducts = [], todayApiCalls = 0, totalApiCalls = 0) {
  const ownedKeywords = ownedProducts.reduce((sum, product) => sum + (product.keywords || []).length, 0);
  const ownedLastChecked = ownedProducts.reduce((max, product) => {
    const productLast = (product.keywords || []).reduce((innerMax, keyword) => Math.max(innerMax, Number(keyword.lastChecked || 0)), 0);
    return Math.max(max, productLast);
  }, 0);

  return {
    id: user.id,
    email: user.email,
    phone: normalizePhone(user.phone),
    storeName: user.storeName || "",
    approvalStatus: user.approvalStatus || "approved",
    approvalRequestedAt: user.approvalRequestedAt || user.createdAt || null,
    approvedAt: user.approvedAt || null,
    rejectedAt: user.rejectedAt || null,
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
    productCount: ownedProducts.length,
    productLimit: getUserProductLimit(user),
    keywordCount: ownedKeywords,
    lastCheckedAt: ownedLastChecked || null,
    passwordStatus: user.passwordHash ? "hashed" : "missing",
    restrictions: getUserRestrictions(user),
    todayApiCalls,
    totalApiCalls
  };
}

function buildAdminOverview(db, snapshotLimit) {
  const users = db.users || [];
  const products = db.products || [];
  const snapshots = db.snapshots || [];
  const userMap = new Map(users.map((user) => [user.id, user]));
  const productMap = new Map(products.map((product) => [product.id, product]));
  const productsByUser = new Map();
  let keywordCount = 0;
  let rankedKeywordCount = 0;
  let top10Count = 0;
  let missingCount = 0;
  let errorCount = 0;
  let collectedItemCount = 0;
  let lastCheckedAt = 0;
  const todayKey = getDateKey(Date.now(), SCHEDULE_TIMEZONE);
  const apiCallsByUser = new Map();
  const todayApiCallsByUser = new Map();
  const estimatedCollectionsByUser = new Map();
  const estimatedTodayCollectionsByUser = new Map();

  for (const product of products) {
    if (!productsByUser.has(product.userId)) productsByUser.set(product.userId, []);
    productsByUser.get(product.userId).push(product);

    for (const keyword of product.keywords || []) {
      keywordCount += 1;
      if (isKeywordTarget(product)) collectedItemCount += Number(keyword.resultCount || (product.topItems || []).length || 0);
      if (keyword.rank) rankedKeywordCount += 1;
      if (keyword.rank && keyword.rank <= 10) top10Count += 1;
      if (keyword.status === "missing") missingCount += 1;
      if (keyword.status === "error") errorCount += 1;
      lastCheckedAt = Math.max(lastCheckedAt, Number(keyword.lastChecked || 0));
    }
  }

  for (const snapshot of snapshots) {
    lastCheckedAt = Math.max(lastCheckedAt, Number(snapshot.checkedAt || 0));
    const apiCalls = Number(snapshot.apiCalls || 0);
    if (apiCalls && snapshot.userId) {
      apiCallsByUser.set(snapshot.userId, Number(apiCallsByUser.get(snapshot.userId) || 0) + apiCalls);
      if (getDateKey(snapshot.checkedAt || Date.now(), SCHEDULE_TIMEZONE) === todayKey) {
        todayApiCallsByUser.set(snapshot.userId, Number(todayApiCallsByUser.get(snapshot.userId) || 0) + apiCalls);
      }
    }
    if (!apiCalls && snapshot.userId && snapshot.productId && snapshot.status === "completed") {
      const dayKey = getDateKey(snapshot.checkedAt || Date.now(), SCHEDULE_TIMEZONE);
      const collectionKey = snapshot.collectionId || `${snapshot.productId}:${dayKey}:${snapshot.checkedAt || ""}`;
      const userCollections = estimatedCollectionsByUser.get(snapshot.userId) || new Set();
      userCollections.add(collectionKey);
      estimatedCollectionsByUser.set(snapshot.userId, userCollections);
      if (dayKey === todayKey) {
        const todayCollections = estimatedTodayCollectionsByUser.get(snapshot.userId) || new Set();
        todayCollections.add(collectionKey);
        estimatedTodayCollectionsByUser.set(snapshot.userId, todayCollections);
      }
    }
  }

  for (const [userId, collections] of estimatedCollectionsByUser.entries()) {
    apiCallsByUser.set(userId, Number(apiCallsByUser.get(userId) || 0) + collections.size);
  }
  for (const [userId, collections] of estimatedTodayCollectionsByUser.entries()) {
    todayApiCallsByUser.set(userId, Number(todayApiCallsByUser.get(userId) || 0) + collections.size);
  }

  const apiUsageSummary = getApiUsageSummary(db, snapshots);
  const usageByUser = users.map((user) => ({
    userId: user.id,
    email: user.email || "",
    phone: normalizePhone(user.phone),
    storeName: user.storeName || "",
    productCount: (productsByUser.get(user.id) || []).length,
    todayApiCalls: Number(todayApiCallsByUser.get(user.id) || 0),
    totalApiCalls: Number(apiCallsByUser.get(user.id) || 0)
  })).sort((a, b) => Number(b.todayApiCalls || 0) - Number(a.todayApiCalls || 0) || Number(b.totalApiCalls || 0) - Number(a.totalApiCalls || 0));

  return {
    summary: {
      userCount: users.length,
      productCount: products.length,
      collectedItemCount,
      keywordCount,
      rankedKeywordCount,
      top10Count,
      missingCount,
      errorCount,
      snapshotCount: snapshots.length,
      lastCheckedAt: lastCheckedAt || null,
      storage: useSupabase() ? "supabase" : "local",
      apiUsage: apiUsageSummary,
      usageByUser: usageByUser.slice(0, 20),
      scheduler: {
        lastCompletedSlot: db.meta?.scheduler?.lastCompletedSlot || "",
        lastCompletedAt: db.meta?.scheduler?.lastCompletedAt || null,
        logs: getSchedulerLogs(db)
      },
      notices: getNotices(db)
    },
    notices: getNotices(db),
    users: users.map((user) => {
      const ownedProducts = productsByUser.get(user.id) || [];
      return publicAdminUser(
        user,
        ownedProducts,
        Number(todayApiCallsByUser.get(user.id) || 0),
        Number(apiCallsByUser.get(user.id) || 0)
      );
    }).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)),
    products: products.map((product) => {
      const owner = userMap.get(product.userId);
      const ownerEmail = owner?.email || product.deletedUserEmail || "";
      const ownerPhone = normalizePhone(owner?.phone || product.deletedUserPhone);
      const ownerStoreName = owner?.storeName || product.deletedUserStoreName || "";
      const keywords = product.keywords || [];
      const lastChecked = keywords.reduce((max, keyword) => Math.max(max, Number(keyword.lastChecked || 0)), 0);
      const bestRank = keywords
        .map((keyword) => keyword.rank)
        .filter(Boolean)
        .sort((a, b) => a - b)[0] || null;

      return {
        id: product.id,
        type: product.type || (isKeywordTarget(product) ? "keywordTarget" : "product"),
        term: product.term || keywords[0]?.term || product.name || "",
        userId: product.userId,
        userEmail: ownerEmail,
        userPhone: ownerPhone,
        userStoreName: ownerStoreName,
        ownerDeleted: !owner && Boolean(product.deletedUserId || product.deletedUserEmail),
        disabled: Boolean(product.disabled),
        name: displayProductName(product),
        store: displayProductStore(product),
        productId: product.productId || "",
        url: product.url || "",
        image: product.image || "",
        createdAt: product.createdAt || null,
        keywordCount: keywords.length,
        resultCount: isKeywordTarget(product) ? Number(keywords[0]?.resultCount || (product.topItems || []).length || 0) : 0,
        latestItems: isKeywordTarget(product) ? (product.topItems || []).slice(0, RANK_SCAN_LIMIT) : [],
        bestRank,
        lastCheckedAt: lastChecked || null,
        keywords: keywords.map((keyword) => ({
          id: keyword.id,
          term: keyword.term,
          alertRanks: normalizeRankThresholds(keyword.alertRanks),
          dropThreshold: normalizeDropThreshold(keyword.dropThreshold),
          rank: keyword.rank || null,
          prevRank: keyword.prevRank || null,
          bestRank: keyword.bestRank || null,
          status: keyword.status || "pending",
          history: Array.isArray(keyword.history) ? keyword.history : [],
          lastChecked: keyword.lastChecked || null,
          lastError: keyword.lastError || "",
          matchedBy: keyword.matchedBy || "",
          lastApiCalls: keyword.lastApiCalls || 0
        }))
      };
    }).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)),
    snapshots: [...snapshots]
      .sort((a, b) => Number(b.checkedAt || 0) - Number(a.checkedAt || 0))
      .slice(0, snapshotLimit)
      .map((snapshot) => {
        const product = productMap.get(snapshot.productId);
        const user = userMap.get(snapshot.userId);
        const userEmail = user?.email || snapshot.deletedUserEmail || product?.deletedUserEmail || "";
        const userPhone = normalizePhone(user?.phone || snapshot.deletedUserPhone || product?.deletedUserPhone);
        return {
          id: snapshot.id,
          userId: snapshot.userId,
          userEmail,
          userPhone,
          productId: snapshot.productId,
          productName: product?.name || "",
          productUrl: product?.url || "",
          keywordId: snapshot.keywordId,
          term: snapshot.term || "",
          rank: snapshot.rank || null,
          status: snapshot.status || "pending",
          checkedAt: snapshot.checkedAt || null,
          apiCalls: snapshot.apiCalls || 0,
          error: snapshot.error || ""
        };
      })
  };
}

function buildAdminBackup(db) {
  const overview = buildAdminOverview(db, 5000);
  return {
    exportedAt: Date.now(),
    service: "soondaeng",
    summary: overview.summary,
    users: (db.users || []).map((user) => ({
      id: user.id,
      email: user.email || "",
      phone: normalizePhone(user.phone),
      storeName: user.storeName || "",
      approvalStatus: user.approvalStatus || "approved",
      approvalRequestedAt: user.approvalRequestedAt || user.createdAt || null,
      approvedAt: user.approvedAt || null,
      rejectedAt: user.rejectedAt || null,
      productLimit: getUserProductLimit(user),
      restrictions: getUserRestrictions(user),
      createdAt: user.createdAt || null,
      updatedAt: user.updatedAt || null,
      passwordStatus: user.passwordHash ? "hashed" : "missing"
    })),
    products: db.products || [],
    snapshots: db.snapshots || [],
    notices: getNotices(db),
    apiUsage: getApiUsageSummary(db),
    schedulerLogs: getSchedulerLogs(db),
    userSettingLogs: Array.isArray(db.meta?.userSettingLogs) ? db.meta.userSettingLogs : [],
    userDeletions: Array.isArray(db.meta?.userDeletions) ? db.meta.userDeletions : []
  };
}

function buildUserActivity(db, userId) {
  const snapshots = (db.snapshots || []).filter((snapshot) => snapshot.userId === userId);
  const lastCheckedAt = snapshots.reduce((max, snapshot) => Math.max(max, Number(snapshot.checkedAt || 0)), 0);
  return {
    schedulerLogs: getSchedulerLogs(db),
    lastCheckedAt: lastCheckedAt || null,
    recentSnapshots: snapshots
      .sort((a, b) => Number(b.checkedAt || 0) - Number(a.checkedAt || 0))
      .slice(0, 30)
      .map((snapshot) => ({
        id: snapshot.id,
        productId: snapshot.productId,
        keywordId: snapshot.keywordId,
        term: snapshot.term || "",
        rank: snapshot.rank || null,
        status: snapshot.status || "pending",
        checkedAt: snapshot.checkedAt || null,
        error: snapshot.error || ""
      }))
  };
}

function buildRankReport(db, options = {}) {
  const now = Number(options.now || Date.now());
  const windowDays = Number(options.windowDays || 7);
  const since = now - windowDays * 86400000;
  const users = new Map((db.users || []).map((user) => [user.id, user]));
  const products = (db.products || [])
    .filter((product) => !options.userId || product.userId === options.userId)
    .filter((product) => !product.disabled)
    .filter((product) => isKeywordTarget(product));
  const snapshots = (db.snapshots || [])
    .filter((snapshot) => Number(snapshot.checkedAt || 0) >= since && Number(snapshot.checkedAt || 0) <= now)
    .filter((snapshot) => !options.userId || snapshot.userId === options.userId);
  const snapshotsByTarget = new Map();

  for (const snapshot of snapshots) {
    const key = snapshot.productId || "";
    if (!snapshotsByTarget.has(key)) snapshotsByTarget.set(key, []);
    snapshotsByTarget.get(key).push(snapshot);
  }

  const thresholdDrops = [];
  const rangeDrops = [];
  const newEntries = [];
  const rankChanges = [];
  const rawRows = [];
  const keywordReports = [];

  for (const product of products) {
    const owner = users.get(product.userId);
    const keyword = (product.keywords || [])[0] || {};
    const rows = (snapshotsByTarget.get(product.id) || [])
      .filter((snapshot) => snapshot.status !== "error")
      .sort((a, b) => Number(a.checkedAt || 0) - Number(b.checkedAt || 0) || Number(a.rank || 0) - Number(b.rank || 0));

    const collections = buildKeywordCollections(rows).slice(-windowDays);
    const collectionIds = new Set(collections.map((collection) => collection.collectionId));
    rows
      .filter((record) => collectionIds.has(snapshotCollectionKey(record)))
      .forEach((record) => rawRows.push(keywordRankRawRow(product, keyword, owner, record)));

    const comparison = compareKeywordCollections(product, keyword, owner, collections);
    thresholdDrops.push(...comparison.thresholdDrops);
    rangeDrops.push(...comparison.rangeDrops);
    newEntries.push(...comparison.newEntries);
    rankChanges.push(...comparison.rankChanges);
    keywordReports.push({
      targetId: product.id,
      keyword: product.term || keyword.term || product.name || "",
      configuredRanks: normalizeRankThresholds(product.alertRanks || keyword.alertRanks),
      dropThreshold: normalizeDropThreshold(product.dropThreshold || keyword.dropThreshold),
      collectionCount: collections.length,
      days: collections.map((collection) => ({
        dateKey: collection.dateKey,
        checkedAt: collection.checkedAt,
        count: collection.items.length
      })),
      latestItems: collections.at(-1)?.items || [],
      changes: comparison.rankChanges.slice(0, 100)
    });
  }

  const latestItemCount = keywordReports.reduce((sum, item) => sum + (item.latestItems || []).length, 0);
  const summary = {
    productCount: latestItemCount,
    keywordCount: products.length,
    thresholdDropCount: thresholdDrops.length,
    rangeDropCount: rangeDrops.length,
    newEntryCount: newEntries.length,
    rankChangeCount: rankChanges.length,
    generatedAt: now,
    windowStart: since,
    windowEnd: now
  };

  return {
    title: "순댕이 최근 7일 순위 리포트",
    generatedAt: now,
    windowDays,
    windowStart: since,
    windowEnd: now,
    summary,
    thresholdDrops,
    rangeDrops,
    newEntries,
    rankChanges,
    keywordReports,
    rawRows: rawRows.sort((a, b) => String(a.keyword).localeCompare(String(b.keyword), "ko") || Number(a.checkedAt || 0) - Number(b.checkedAt || 0) || Number(a.rankNumber || 0) - Number(b.rankNumber || 0)),
    email: {
      configured: Boolean(RESEND_API_KEY && REPORT_FROM),
      mode: "members",
      adminCopyRecipients: REPORT_RECIPIENTS
    }
  };
}

function buildKeywordCollections(rows) {
  const byCollection = new Map();
  for (const row of rows || []) {
    const checkedAt = Number(row.checkedAt || 0);
    if (!checkedAt) continue;
    const dateKey = row.dateKey || getDateKey(checkedAt, SCHEDULE_TIMEZONE);
    const collectionId = snapshotCollectionKey(row);
    if (!byCollection.has(collectionId)) {
      byCollection.set(collectionId, {
        collectionId,
        dateKey,
        checkedAt,
        items: []
      });
    }
    const collection = byCollection.get(collectionId);
    collection.checkedAt = Math.max(collection.checkedAt, checkedAt);
    collection.items.push(snapshotToRankItem(row));
  }

  const latestByDay = new Map();
  for (const collection of byCollection.values()) {
    collection.items.sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));
    const current = latestByDay.get(collection.dateKey);
    if (!current || collection.checkedAt > current.checkedAt) latestByDay.set(collection.dateKey, collection);
  }

  return [...latestByDay.values()].sort((a, b) => a.checkedAt - b.checkedAt);
}

function snapshotDateKey(snapshot) {
  const checkedAt = Number(snapshot?.checkedAt || 0);
  return snapshot?.dateKey || (checkedAt ? getDateKey(checkedAt, SCHEDULE_TIMEZONE) : "");
}

function snapshotCollectionKey(snapshot) {
  const checkedAt = Number(snapshot?.checkedAt || 0);
  const dateKey = snapshotDateKey(snapshot);
  return snapshot?.collectionId || `${dateKey}:${checkedAt}`;
}

function snapshotToRankItem(snapshot) {
  return {
    rank: normalizeReportRank(snapshot.rank),
    itemKey: snapshot.itemKey || snapshot.productNaverId || snapshot.productUrl || "",
    productName: snapshot.productName || "",
    productUrl: snapshot.productUrl || "",
    storeName: snapshot.storeName || "",
    image: snapshot.image || "",
    price: snapshot.price || "",
    checkedAt: snapshot.checkedAt || null
  };
}

function compareKeywordCollections(product, keyword, owner, collections) {
  return {
    thresholdDrops: findKeywordThresholdDropEvents(product, keyword, owner, collections),
    rangeDrops: findKeywordRangeDropEvents(product, keyword, owner, collections),
    newEntries: findKeywordNewEntryEvents(product, keyword, owner, collections),
    rankChanges: findKeywordAdjacentRankChanges(product, keyword, owner, collections)
  };
}

function findKeywordAdjacentRankChanges(product, keyword, owner, collections) {
  const rankChanges = [];

  for (let index = 1; index < collections.length; index += 1) {
    const previous = collections[index - 1];
    const current = collections[index];
    const prevMap = rankItemMap(previous.items);
    const currentMap = rankItemMap(current.items);
    const keys = new Set([...prevMap.keys(), ...currentMap.keys()]);

    for (const key of keys) {
      const prev = prevMap.get(key) || null;
      const next = currentMap.get(key) || null;
      const prevRank = prev?.rank || null;
      const nextRank = next?.rank || null;
      const item = next || prev;

      if (prevRank && (nextRank || RANK_SCAN_LIMIT + 1) !== prevRank) {
        const effectiveNext = nextRank || RANK_SCAN_LIMIT + 1;
        const diff = effectiveNext - prevRank;
        rankChanges.push(keywordEventRow(product, keyword, owner, item, {
          type: diff > 0 ? "순위 하락" : "순위 상승",
          fromRank: prevRank,
          toRank: nextRank,
          fromAt: previous.checkedAt,
          toAt: current.checkedAt,
          drop: diff > 0 ? diff : "",
          detail: `${previous.dateKey} ${prevRank}위 -> ${current.dateKey} ${rankLabel(nextRank)}`
        }));
      }
    }
  }

  return rankChanges;
}

function rankItemMap(items) {
  return new Map((items || []).filter((item) => item.itemKey).map((item) => [item.itemKey, item]));
}

function collectKeywordItemRecords(collections) {
  const byItem = new Map();
  for (const collection of collections) {
    for (const item of collection.items || []) {
      if (!item.itemKey) continue;
      if (!byItem.has(item.itemKey)) byItem.set(item.itemKey, []);
      byItem.get(item.itemKey).push({ ...item, checkedAt: collection.checkedAt, dateKey: collection.dateKey });
    }
  }
  return byItem;
}

function bestRankRecord(records) {
  return (records || []).reduce((best, record) => {
    if (!record.rank) return best;
    if (!best || record.rank < best.rank || (record.rank === best.rank && record.checkedAt > best.checkedAt)) return record;
    return best;
  }, null);
}

function currentRankRecord(collection, itemKey) {
  return rankItemMap(collection?.items || []).get(itemKey) || null;
}

function latestCollectionLabel(collection) {
  return collection?.dateKey ? `${collection.dateKey} 오늘` : "오늘";
}

function findKeywordNewEntryEvents(product, keyword, owner, collections) {
  if (collections.length < 2) return [];
  const latest = collections.at(-1);
  const previousKeys = new Set();
  collections.slice(0, -1).forEach((collection) => {
    (collection.items || []).forEach((item) => {
      if (item.itemKey) previousKeys.add(item.itemKey);
    });
  });

  return (latest.items || [])
    .filter((item) => item.itemKey && !previousKeys.has(item.itemKey))
    .map((item) => keywordEventRow(product, keyword, owner, item, {
      type: "50위 밖에서 신규 진입",
      threshold: RANK_SCAN_LIMIT,
      fromRank: null,
      toRank: item.rank,
      fromAt: collections[0]?.checkedAt || null,
      toAt: latest.checkedAt,
      detail: `최근 7일 이전 50위 밖 -> ${latestCollectionLabel(latest)} ${rankLabel(item.rank)}`
    }));
}

function findKeywordThresholdDropEvents(product, keyword, owner, collections) {
  const latest = collections.at(-1);
  if (!latest) return [];

  const byItem = collectKeywordItemRecords(collections);
  const thresholds = normalizeRankThresholds(product.alertRanks || keyword.alertRanks);
  const events = [];

  for (const [itemKey, records] of byItem.entries()) {
    const best = bestRankRecord(records);
    if (!best) continue;
    const current = currentRankRecord(latest, itemKey);
    const item = current || best;

    for (const threshold of thresholds) {
      if (isInsideRank(best.rank, threshold) && !isInsideRank(current?.rank || null, threshold)) {
        events.push(keywordEventRow(product, keyword, owner, item, {
          type: "기준순위 밖 이탈",
          threshold,
          fromRank: best.rank,
          toRank: current?.rank || null,
          fromAt: best.checkedAt,
          toAt: latest.checkedAt,
          detail: `최근 7일 최고 ${formatReportDate(best.checkedAt)} ${best.rank}위 -> ${latestCollectionLabel(latest)} ${rankLabel(current?.rank || null)}`
        }));
      }
    }
  }

  return events;
}

function findKeywordRangeDropEvents(product, keyword, owner, collections) {
  const latest = collections.at(-1);
  if (!latest) return [];

  const threshold = normalizeDropThreshold(product.dropThreshold || keyword.dropThreshold);
  const byItem = collectKeywordItemRecords(collections);

  const events = [];
  for (const [itemKey, records] of byItem.entries()) {
    const best = bestRankRecord(records);
    if (!best) continue;
    const current = currentRankRecord(latest, itemKey);
    const effectiveCurrentRank = current?.rank || RANK_SCAN_LIMIT + 1;
    const drop = effectiveCurrentRank - best.rank;

    if (drop >= threshold) {
      events.push(keywordEventRow(product, keyword, owner, current || best, {
        type: "지정 하락폭 이상",
        threshold,
        fromRank: best.rank,
        toRank: current?.rank || null,
        fromAt: best.checkedAt,
        toAt: latest.checkedAt,
        drop,
        detail: `최근 7일 최고 ${formatReportDate(best.checkedAt)} ${best.rank}위 -> ${latestCollectionLabel(latest)} ${rankLabel(current?.rank || null)}, ${drop}위 하락`
      }));
    }
  }
  return events;
}

function keywordEventRow(product, keyword, owner, item, event) {
  return {
    eventType: event.type || "",
    userEmail: owner?.email || "",
    userPhone: normalizePhone(owner?.phone),
    storeName: item?.storeName || "",
    productName: item?.productName || "",
    productUrl: item?.productUrl || "",
    keyword: product.term || keyword.term || product.name || "",
    configuredRanks: normalizeRankThresholds(product.alertRanks || keyword.alertRanks).join(", "),
    dropThreshold: normalizeDropThreshold(product.dropThreshold || keyword.dropThreshold),
    threshold: event.threshold || "",
    fromRank: rankLabel(event.fromRank),
    toRank: rankLabel(event.toRank),
    drop: event.drop || "",
    fromAt: event.fromAt || null,
    toAt: event.toAt || null,
    detail: event.detail || ""
  };
}

function keywordRankRawRow(product, keyword, owner, record) {
  return {
    userEmail: owner?.email || "",
    userPhone: normalizePhone(owner?.phone),
    storeName: record.storeName || "",
    productName: record.productName || "",
    productUrl: record.productUrl || "",
    keyword: product.term || keyword.term || product.name || record.term || "",
    configuredRanks: normalizeRankThresholds(product.alertRanks || keyword.alertRanks).join(", "),
    dropThreshold: normalizeDropThreshold(product.dropThreshold || keyword.dropThreshold),
    rank: rankLabel(record.rank),
    rankNumber: Number(record.rank || 0),
    checkedAt: record.checkedAt || null,
    dateKey: record.dateKey || getDateKey(record.checkedAt || Date.now(), SCHEDULE_TIMEZONE),
    source: record.source || "",
    status: record.status || "",
    error: record.error || ""
  };
}

function normalizeReportRecords(records, product, keyword, now) {
  const rows = (records || [])
    .map((snapshot) => ({
      checkedAt: Number(snapshot.checkedAt || 0),
      rank: normalizeReportRank(snapshot.rank),
      status: snapshot.status || "pending",
      source: snapshot.source || "",
      error: snapshot.error || ""
    }))
    .filter((record) => record.checkedAt)
    .sort((a, b) => a.checkedAt - b.checkedAt);

  if (keyword.lastChecked && !rows.some((record) => record.checkedAt === keyword.lastChecked)) {
    rows.push({
      checkedAt: Number(keyword.lastChecked || now),
      rank: normalizeReportRank(keyword.rank),
      status: keyword.status || "pending",
      source: "current",
      error: keyword.lastError || ""
    });
    rows.sort((a, b) => a.checkedAt - b.checkedAt);
  }

  if (!rows.length) {
    rows.push({
      checkedAt: Number(product.createdAt || now),
      rank: normalizeReportRank(keyword.rank),
      status: keyword.status || "pending",
      source: "current",
      error: keyword.lastError || ""
    });
  }

  return rows;
}

function findThresholdDropEvents(product, keyword, owner, records) {
  const events = [];
  const thresholds = normalizeRankThresholds(keyword.alertRanks);
  for (const threshold of thresholds) {
    for (let index = 1; index < records.length; index += 1) {
      const prev = records[index - 1];
      const current = records[index];
      if (isInsideRank(prev.rank, threshold) && !isInsideRank(current.rank, threshold)) {
        events.push(reportEventRow(product, keyword, owner, {
          type: "기준순위 밖 이탈",
          threshold,
          fromRank: prev.rank,
          toRank: current.rank,
          fromAt: prev.checkedAt,
          toAt: current.checkedAt,
          detail: `${formatReportDate(prev.checkedAt)} ${rankLabel(prev.rank)} -> ${formatReportDate(current.checkedAt)} ${rankLabel(current.rank)}`
        }));
      }
    }
  }
  return events;
}

function findRangeDropEvent(product, keyword, owner, records) {
  const threshold = normalizeDropThreshold(keyword.dropThreshold);
  let best = null;
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      const fromRank = records[left].rank;
      const toRank = records[right].rank;
      if (!fromRank || !toRank) continue;
      const drop = toRank - fromRank;
      if (drop >= threshold && (!best || drop > best.drop)) {
        best = { fromRank, toRank, drop, fromAt: records[left].checkedAt, toAt: records[right].checkedAt };
      }
    }
  }
  if (!best) return null;
  return reportEventRow(product, keyword, owner, {
    type: "지정 하락폭 이상",
    threshold,
    fromRank: best.fromRank,
    toRank: best.toRank,
    fromAt: best.fromAt,
    toAt: best.toAt,
    drop: best.drop,
    detail: `${formatReportDate(best.fromAt)} ${best.fromRank}위 -> ${formatReportDate(best.toAt)} ${best.toRank}위, ${best.drop}위 하락`
  });
}

function findNewEntryEvents(product, keyword, owner, records) {
  const events = [];
  for (let index = 1; index < records.length; index += 1) {
    const prev = records[index - 1];
    const current = records[index];
    if (!prev.rank && current.rank) {
      events.push(reportEventRow(product, keyword, owner, {
        type: "50위 밖에서 신규 진입",
        threshold: RANK_SCAN_LIMIT,
        fromRank: prev.rank,
        toRank: current.rank,
        fromAt: prev.checkedAt,
        toAt: current.checkedAt,
        detail: `${formatReportDate(prev.checkedAt)} 50위 밖 -> ${formatReportDate(current.checkedAt)} ${current.rank}위`
      }));
    }
  }
  return events;
}

function reportEventRow(product, keyword, owner, event) {
  return {
    eventType: event.type || "",
    userEmail: owner?.email || "",
    userPhone: normalizePhone(owner?.phone),
    storeName: product.store || owner?.storeName || "",
    productName: displayProductName(product),
    productUrl: product.url || "",
    keyword: keyword.term || "",
    configuredRanks: normalizeRankThresholds(keyword.alertRanks).join(", "),
    dropThreshold: normalizeDropThreshold(keyword.dropThreshold),
    threshold: event.threshold || "",
    fromRank: rankLabel(event.fromRank),
    toRank: rankLabel(event.toRank),
    drop: event.drop || "",
    fromAt: event.fromAt || null,
    toAt: event.toAt || null,
    detail: event.detail || ""
  };
}

function reportRawRow(product, keyword, owner, record) {
  return {
    userEmail: owner?.email || "",
    userPhone: normalizePhone(owner?.phone),
    storeName: product.store || owner?.storeName || "",
    productName: displayProductName(product),
    productUrl: product.url || "",
    keyword: keyword.term || "",
    configuredRanks: normalizeRankThresholds(keyword.alertRanks).join(", "),
    dropThreshold: normalizeDropThreshold(keyword.dropThreshold),
    rank: rankLabel(record.rank),
    checkedAt: record.checkedAt || null,
    source: record.source || "",
    status: record.status || "",
    error: record.error || ""
  };
}

function normalizeReportRank(value) {
  const rank = Number(value || 0);
  return Number.isInteger(rank) && rank >= 1 && rank <= RANK_SCAN_LIMIT ? rank : null;
}

function isInsideRank(rank, threshold) {
  return Number.isInteger(rank) && rank >= 1 && rank <= threshold;
}

function rankLabel(rank) {
  return rank ? `${rank}위` : "50위 밖";
}

function formatReportDate(timestamp) {
  if (!timestamp) return "";
  const time = getTimestampInZone(timestamp, SCHEDULE_TIMEZONE);
  return `${time.date} ${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

function reportFileName(report) {
  const date = getDateKey(report.generatedAt || Date.now(), SCHEDULE_TIMEZONE);
  return `soondaeng-rank-report-${date}.xlsx`;
}

async function createAndSendRankReport(db, slotKey, source) {
  const report = buildRankReport(db);
  const email = await sendMemberRankReportEmails(db).catch((error) => ({
    status: "error",
    mode: "members",
    message: error.message || "이메일 발송 중 오류가 발생했습니다."
  }));

  if (REPORT_RECIPIENTS.length) {
    const workbook = buildRankReportWorkbook(report);
    email.adminCopy = await sendRankReportEmail(report, workbook, REPORT_RECIPIENTS, {
      subject: `[순댕이 관리자] ${getDateKey(report.generatedAt, SCHEDULE_TIMEZONE)} 전체 순위 리포트`
    }).catch((error) => ({
      status: "error",
      message: error.message || "관리자 참고 메일 발송 중 오류가 발생했습니다."
    }));
  }

  db.meta = db.meta || {};
  db.meta.reports = Array.isArray(db.meta.reports) ? db.meta.reports : [];
  const stored = {
    id: uid(),
    slotKey,
    source,
    createdAt: Date.now(),
    summary: report.summary,
    email
  };
  db.meta.reports.unshift(stored);
  db.meta.reports = db.meta.reports.slice(0, 90);
  return stored;
}

async function sendUserReportRoute(req, res, user) {
  if (!isValidEmail(user.email || "")) {
    sendJson(res, 400, { error: "INVALID_EMAIL", message: "회원 이메일이 올바르지 않습니다. 내 정보에서 이메일을 수정해 주세요." });
    return;
  }

  const db = await readDb();
  const report = buildRankReport(db, { userId: user.id });
  if (!report.summary.keywordCount) {
    sendJson(res, 400, { error: "NO_KEYWORDS", message: "등록된 키워드가 없어 메일로 보낼 리포트가 없습니다." });
    return;
  }

  const workbook = buildRankReportWorkbook(report);
  const email = await sendRankReportEmail(report, workbook, [user.email], {
    user,
    subject: `[순댕이] ${getDateKey(report.generatedAt, SCHEDULE_TIMEZONE)} 내 키워드 순위 리포트`
  }).catch((error) => ({
    status: "error",
    message: error.publicMessage || error.message || "이메일 발송 중 오류가 발생했습니다."
  }));

  const latestDb = await readDb();
  latestDb.meta = latestDb.meta || {};
  latestDb.meta.userReportEmails = Array.isArray(latestDb.meta.userReportEmails) ? latestDb.meta.userReportEmails : [];
  latestDb.meta.userReportEmails.unshift({
    id: uid(),
    userId: user.id,
    email: user.email,
    createdAt: Date.now(),
    status: email.status,
    message: email.message || "",
    summary: report.summary
  });
  latestDb.meta.userReportEmails = latestDb.meta.userReportEmails.slice(0, 300);
  await writeDb(latestDb);

  sendJson(res, 200, {
    ok: email.status === "sent",
    email,
    summary: report.summary,
    message: email.status === "sent"
      ? `${user.email}로 리포트를 발송했습니다.`
      : email.message || "이메일 발송 설정을 확인해 주세요."
  });
}

async function sendMemberRankReportEmails(db) {
  if (!RESEND_API_KEY || !REPORT_FROM) {
    return {
      status: "skipped",
      mode: "members",
      sentCount: 0,
      skippedCount: 0,
      errorCount: 0,
      message: "RESEND_API_KEY와 REPORT_FROM 환경변수가 있어야 회원별 이메일이 발송됩니다."
    };
  }

  const users = (db.users || [])
    .filter((user) => isUserApproved(user))
    .filter((user) => !getUserRestrictions(user).suspended)
    .filter((user) => isValidEmail(user.email || ""));

  if (!users.length) {
    return {
      status: "skipped",
      mode: "members",
      sentCount: 0,
      skippedCount: 0,
      errorCount: 0,
      message: "발송 대상 회원이 없습니다."
    };
  }

  const results = [];
  for (const user of users) {
    const report = buildRankReport(db, { userId: user.id });
    if (!report.summary.keywordCount) {
      results.push({
        userId: user.id,
        email: user.email,
        status: "skipped",
        message: "등록된 키워드가 없어 건너뜀"
      });
      continue;
    }

    const workbook = buildRankReportWorkbook(report);
    try {
      const email = await sendRankReportEmail(report, workbook, [user.email], {
        user,
        subject: `[순댕이] ${getDateKey(report.generatedAt, SCHEDULE_TIMEZONE)} 내 키워드 순위 리포트`
      });
      results.push({
        userId: user.id,
        email: user.email,
        status: email.status,
        provider: email.provider
      });
    } catch (error) {
      results.push({
        userId: user.id,
        email: user.email,
        status: "error",
        message: error.publicMessage || error.message || "발송 실패"
      });
    }
  }

  const sentCount = results.filter((item) => item.status === "sent").length;
  const errorCount = results.filter((item) => item.status === "error").length;
  const skippedCount = results.filter((item) => item.status === "skipped").length;
  return {
    status: sentCount ? "sent" : errorCount ? "error" : "skipped",
    mode: "members",
    sentCount,
    skippedCount,
    errorCount,
    recipients: results.filter((item) => item.status === "sent").map((item) => item.email),
    message: sentCount
      ? `회원 ${sentCount}명에게 리포트를 발송했습니다.`
      : errorCount
        ? "회원별 이메일 발송이 실패했습니다."
        : "발송할 회원 키워드가 없습니다.",
    results: results.slice(0, 100)
  };
}

async function sendRankReportEmail(report, workbook, recipients, options = {}) {
  const to = Array.isArray(recipients) ? recipients.filter(Boolean) : splitRecipients(recipients);
  if (!RESEND_API_KEY || !REPORT_FROM || !to.length) {
    return {
      status: "skipped",
      message: "RESEND_API_KEY, REPORT_FROM, 받을 이메일이 모두 있어야 이메일이 발송됩니다."
    };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: REPORT_FROM,
      to,
      subject: options.subject || `[순댕이] ${getDateKey(report.generatedAt, SCHEDULE_TIMEZONE)} 순위 리포트`,
      text: [
        options.user?.storeName
          ? `${options.user.storeName} 순댕이 최근 7일 순위 리포트입니다.`
          : "순댕이 최근 7일 순위 리포트입니다.",
        "",
        `추적 키워드: ${report.summary.keywordCount}개`,
        `최신 수집 상품: ${report.summary.productCount}개`,
        `기준순위 밖 이탈: ${report.summary.thresholdDropCount}건`,
        `지정 하락폭 이상: ${report.summary.rangeDropCount}건`,
        `50위 밖 신규 진입: ${report.summary.newEntryCount}건`,
        `순위 변동: ${report.summary.rankChangeCount || 0}건`,
        "",
        "상세 내용은 첨부된 엑셀 파일을 확인해 주세요."
      ].join("\n"),
      attachments: [{
        filename: reportFileName(report),
        content: workbook.toString("base64")
      }]
    })
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Resend email failed (${response.status}) ${text}`);
    error.publicMessage = "이메일 발송 API 응답을 확인해 주세요.";
    throw error;
  }

  return {
    status: "sent",
    recipients: to,
    provider: "resend",
    response: text.slice(0, 500)
  };
}

function buildRankReportWorkbook(report) {
  const sheets = [
    {
      name: "요약",
      rows: [
        ["항목", "값"],
        ["리포트", report.title],
        ["생성시각", formatReportDate(report.generatedAt)],
        ["기간시작", formatReportDate(report.windowStart)],
        ["기간종료", formatReportDate(report.windowEnd)],
        ["추적키워드수", report.summary.keywordCount],
        ["최신수집상품수", report.summary.productCount],
        ["기준순위 밖 이탈", report.summary.thresholdDropCount],
        ["지정 하락폭 이상", report.summary.rangeDropCount],
        ["50위 밖 신규 진입", report.summary.newEntryCount],
        ["순위변동", report.summary.rankChangeCount]
      ]
    },
    {
      name: "기준밖이탈",
      rows: eventRowsForWorkbook(report.thresholdDrops)
    },
    {
      name: "하락폭",
      rows: eventRowsForWorkbook(report.rangeDrops)
    },
    {
      name: "신규진입",
      rows: eventRowsForWorkbook(report.newEntries)
    },
    {
      name: "순위변동",
      rows: eventRowsForWorkbook(report.rankChanges || [])
    },
    {
      name: "원본순위",
      rows: [
        ["회원이메일", "전화번호", "키워드", "조회일", "조회시각", "순위", "스토어", "상품명", "상품URL", "기준순위", "하락폭기준", "출처", "상태", "오류"],
        ...report.rawRows.map((row) => [
          row.userEmail,
          row.userPhone,
          row.keyword,
          row.dateKey,
          formatReportDate(row.checkedAt),
          row.rank,
          row.storeName,
          row.productName,
          row.productUrl,
          row.configuredRanks,
          row.dropThreshold,
          row.source,
          row.status,
          row.error
        ])
      ]
    }
  ];
  return createXlsx(sheets);
}

function eventRowsForWorkbook(rows) {
  return [
    ["유형", "회원이메일", "전화번호", "스토어", "상품명", "상품URL", "키워드", "설정기준순위", "하락폭기준", "판정기준", "이전순위", "현재순위", "하락폭", "이전시각", "현재시각", "상세"],
    ...rows.map((row) => [
      row.eventType,
      row.userEmail,
      row.userPhone,
      row.storeName,
      row.productName,
      row.productUrl,
      row.keyword,
      row.configuredRanks,
      row.dropThreshold,
      row.threshold,
      row.fromRank,
      row.toRank,
      row.drop,
      formatReportDate(row.fromAt),
      formatReportDate(row.toAt),
      row.detail
    ])
  ];
}

function sendWorkbook(res, buffer, filename) {
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": buffer.length,
    "Cache-Control": "no-store"
  });
  res.end(buffer);
}

function createXlsx(sheets) {
  const files = [
    ["[Content_Types].xml", contentTypesXml(sheets.length)],
    ["_rels/.rels", rootRelsXml()],
    ["xl/workbook.xml", workbookXml(sheets)],
    ["xl/_rels/workbook.xml.rels", workbookRelsXml(sheets.length)],
    ["xl/styles.xml", stylesXml()]
  ];
  sheets.forEach((sheet, index) => {
    files.push([`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet.rows || [])]);
  });
  return createZip(files.map(([name, content]) => [name, Buffer.from(content, "utf8")]));
}

function contentTypesXml(sheetCount) {
  const sheets = Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets}</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

function workbookXml(sheets) {
  const body = sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name).slice(0, 31)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${body}</sheets></workbook>`;
}

function workbookRelsXml(sheetCount) {
  const sheets = Array.from({ length: sheetCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="맑은 고딕"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`;
}

function worksheetXml(rows) {
  const rowXml = rows.map((row, rowIndex) => {
    const cells = (row || []).map((value, columnIndex) => {
      const ref = `${columnName(columnIndex + 1)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
}

function columnName(index) {
  let name = "";
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuffer = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    writeDosTimeDate(local, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    writeDosTimeDate(central, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function writeDosTimeDate(buffer, offset) {
  const date = new Date();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  buffer.writeUInt16LE(dosTime, offset);
  buffer.writeUInt16LE(dosDate, offset + 2);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitRecipients(value) {
  return String(value || "")
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildUserHistory(db, userId, requestUrl) {
  const productId = requestUrl.searchParams.get("productId") || "";
  const keywordId = requestUrl.searchParams.get("keywordId") || "";
  const product = (db.products || []).find((item) => item.userId === userId && item.id === productId);
  if (!product) return { product: null, keyword: null, snapshots: [], allSnapshots: [] };

  const keyword = (product.keywords || []).find((item) => item.id === keywordId) || null;
  const allSnapshots = (db.snapshots || [])
    .filter((snapshot) => snapshot.userId === userId && snapshot.productId === productId && (!keywordId || snapshot.keywordId === keywordId))
    .sort((a, b) => Number(a.checkedAt || 0) - Number(b.checkedAt || 0))
    .map((snapshot) => ({
      id: snapshot.id,
      term: snapshot.term || "",
      rank: snapshot.rank || null,
      status: snapshot.status || "pending",
      checkedAt: snapshot.checkedAt || null,
      source: snapshot.source || "",
      slotKey: snapshot.slotKey || "",
      graphEligible: isSnapshotGraphEligible(snapshot),
      apiCalls: snapshot.apiCalls || 0,
      error: snapshot.error || ""
    }));
  const snapshots = allSnapshots.filter((snapshot) => snapshot.graphEligible === true);

  return {
    product: {
      id: product.id,
      name: displayProductName(product),
      store: displayProductStore(product),
      productId: product.productId || "",
      url: product.url || "",
      image: product.image || ""
    },
    keyword: keyword ? {
      id: keyword.id,
      term: keyword.term,
      rank: keyword.rank || null,
      status: keyword.status || "pending",
      lastChecked: keyword.lastChecked || null
    } : null,
    snapshots,
    allSnapshots
  };
}

async function runCronTracking(req, res, requestUrl) {
  if (!CRON_SECRET) {
    sendJson(res, 503, {
      error: "CRON_SECRET_MISSING",
      message: "CRON_SECRET environment variable is not configured."
    });
    return;
  }

  if (!isValidCronSecret(getCronSecret(req, requestUrl))) {
    sendJson(res, 401, { error: "UNAUTHORIZED", message: "Invalid cron secret." });
    return;
  }

  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    sendJson(res, 503, {
      error: "NAVER_KEYS_MISSING",
      message: "Naver API keys are not configured."
    });
    return;
  }

  const now = getTimeInZone(SCHEDULE_TIMEZONE);
  const forced = isTruthy(requestUrl.searchParams.get("force"));
  const dueSlot = forced ? getForcedScheduleSlot(now, requestUrl.searchParams.get("time")) : getDueScheduleSlot(now);
  if (!dueSlot) {
    sendJson(res, 200, {
      ok: true,
      skipped: true,
      source: "external-cron",
      reason: forced ? "no_schedule_time" : "no_due_schedule",
      message: forced
        ? "강제 실행할 예약 시간이 설정되어 있지 않습니다."
        : `현재 ${SCHEDULE_TIMEZONE} 기준 실행할 예약 시간이 없습니다.`,
      scheduleTimes: SCHEDULE_TIMES.map((item) => item.label),
      catchupMinutes: SCHEDULE_CATCHUP_MINUTES,
      retryAfterMinutes: SCHEDULE_RETRY_AFTER_MINUTES
    });
    return;
  }

  const claim = await claimScheduledRun(dueSlot.slotKey);
  if (!claim.claimed) {
    sendJson(res, 200, {
      ok: true,
      skipped: true,
      source: "external-cron",
      reason: claim.reason || "already_ran",
      slotKey: dueSlot.slotKey,
      message: claim.reason === "already_completed"
        ? "이미 완료된 예약 작업입니다."
        : "최근에 시작된 예약 작업입니다. 중복 실행을 막았습니다."
    });
    return;
  }

  runScheduledTracking(dueSlot.slotKey, "auto").catch((error) => {
    console.error(`[schedule] external cron failed ${dueSlot.slotKey}`, error);
  });

  sendJson(res, 202, {
    ok: true,
    source: "external-cron",
    forced,
    queued: true,
    slotKey: dueSlot.slotKey,
    message: "예약 수집 작업을 접수했습니다. 수집과 메일 발송은 서버에서 계속 진행됩니다."
  });
}

async function requireAuth(req, res) {
  const token = getSessionToken(req);
  if (!token) {
    sendJson(res, 401, { error: "UNAUTHORIZED", message: "로그인이 필요합니다." });
    return null;
  }

  const db = await readDb();
  const session = db.sessions[token];
  if (!session || session.expiresAt < Date.now()) {
    delete db.sessions[token];
    await writeDb(db);
    clearSessionCookie(req, res);
    sendJson(res, 401, { error: "SESSION_EXPIRED", message: "세션이 만료되었습니다." });
    return null;
  }

  const user = db.users.find((item) => item.id === session.userId);
  if (!user) {
    delete db.sessions[token];
    await writeDb(db);
    clearSessionCookie(req, res);
    sendJson(res, 401, { error: "UNAUTHORIZED", message: "사용자를 찾을 수 없습니다." });
    return null;
  }

  if (getUserRestrictions(user).suspended) {
    delete db.sessions[token];
    await writeDb(db);
    clearSessionCookie(req, res);
    sendJson(res, 403, { error: "ACCOUNT_SUSPENDED", message: getRestrictionMessage(user, "계정 사용이 일시 제한되었습니다.") });
    return null;
  }

  if (!isUserApproved(user)) {
    delete db.sessions[token];
    await writeDb(db);
    clearSessionCookie(req, res);
    sendJson(res, 403, { error: "APPROVAL_PENDING", message: "관리자 승인 후 사용할 수 있습니다." });
    return null;
  }

  return { db, user, token };
}

async function previewProduct(req, res, user, body) {
  if (getUserRestrictions(user).productCreateBlocked) {
    sendJson(res, 403, { error: "PRODUCT_CREATE_BLOCKED", message: getRestrictionMessage(user, "상품 등록이 관리자에 의해 제한되었습니다.") });
    return;
  }

  const db = await readDb();
  const keywordConfigs = parseKeywordConfigs(body);
  const keywords = keywordConfigs.map((item) => item.term);
  const url = String(body.url || "").trim().slice(0, 500);
  const providedProductId = String(body.productId || "").trim().slice(0, 80);
  const inferredProductId = extractProductIdFromUrl(url) || providedProductId;

  if (!url || !keywords.length) {
    sendJson(res, 400, { error: "INVALID_PRODUCT", message: "상품 URL과 추적 키워드는 필수입니다." });
    return;
  }

  const duplicate = findDuplicateProduct(db.products, user.id, url, inferredProductId);
  const previewProduct = {
    id: "preview",
    userId: user.id,
    name: String(body.name || "").trim(),
    store: String(body.store || "").trim(),
    productId: inferredProductId,
    url,
    image: "",
    keywords: []
  };

  let scan = { rank: null, matchedBy: "", item: null, apiCalls: 0 };
  try {
    await enrichProductFromPage(previewProduct);
    scan = await scanNaverKeyword(previewProduct, keywords[0]);
    if (scan.item) applyMatchedItem(previewProduct, scan.item);
  } catch (error) {
    addApiUsage(db, error.apiCalls || 0, Date.now());
    await writeDb(db);
    sendJson(res, 502, {
      error: "PREVIEW_FAILED",
      message: error.publicMessage || "상품 미리보기 중 오류가 발생했습니다."
    });
    return;
  }

  addApiUsage(db, scan.apiCalls || 0, Date.now());
  await writeDb(db);
  sendJson(res, 200, {
    product: {
      name: previewProduct.name || "",
      store: previewProduct.store || "",
      productId: previewProduct.productId || "",
      url,
      image: previewProduct.image || "",
      keyword: keywords[0],
      rank: scan.rank,
      matchedBy: scan.matchedBy || ""
    },
    duplicate: duplicate ? {
      id: duplicate.id,
      name: duplicate.name,
      store: duplicate.store,
      productId: duplicate.productId,
      url: duplicate.url
    } : null
  });
}

async function createProduct(req, res, user, body) {
  if (getUserRestrictions(user).productCreateBlocked) {
    sendJson(res, 403, { error: "PRODUCT_CREATE_BLOCKED", message: getRestrictionMessage(user, "상품 등록이 관리자에 의해 제한되었습니다.") });
    return;
  }

  const db = await readDb();
  const existingCount = db.products.filter((product) => product.userId === user.id).length;
  const productLimit = getUserProductLimit(user);
  if (existingCount >= productLimit) {
    sendJson(res, 403, { error: "PRODUCT_LIMIT", message: `상품 등록 한도는 ${productLimit}개입니다.` });
    return;
  }

  const keywordConfigs = parseKeywordTargetConfigs(body);

  if (!keywordConfigs.length) {
    sendJson(res, 400, { error: "INVALID_KEYWORD", message: "등록할 키워드를 입력해 주세요." });
    return;
  }

  const now = Date.now();
  const duplicate = findDuplicateKeywordTarget(db.products, user.id, keywordConfigs[0].term);
  if (duplicate) {
    sendJson(res, 409, { error: "DUPLICATE_KEYWORD", message: "이미 등록된 키워드입니다.", product: duplicate });
    return;
  }

  const product = createKeywordTarget(user, keywordConfigs[0], now);

  const trackedProduct = await trackProduct(product, trackingContext("registration"));
  db.products.unshift(trackedProduct);
  appendSnapshots(db, user.id, [trackedProduct], trackingContext("registration"));
  await writeDb(db);
  sendJson(res, 201, { product: publicProduct(trackedProduct, db, user.id) });
}

async function deleteProduct(req, res, user, productId) {
  const db = await readDb();
  const before = db.products.length;
  db.products = db.products.filter((product) => !(product.userId === user.id && product.id === productId));
  db.snapshots = db.snapshots.filter((snapshot) => !(snapshot.userId === user.id && snapshot.productId === productId));

  if (db.products.length === before) {
    sendJson(res, 404, { error: "NOT_FOUND", message: "상품을 찾을 수 없습니다." });
    return;
  }

  await writeDb(db);
  sendJson(res, 200, { ok: true });
}

async function bulkCreateProducts(req, res, user, body) {
  if (getUserRestrictions(user).productCreateBlocked) {
    sendJson(res, 403, { error: "PRODUCT_CREATE_BLOCKED", message: getRestrictionMessage(user, "상품 등록이 관리자에 의해 제한되었습니다.") });
    return;
  }

  const rows = parseKeywordTargetConfigs(body);
  if (!rows.length) {
    sendJson(res, 400, { error: "INVALID_BULK", message: "등록할 키워드 목록을 입력해 주세요." });
    return;
  }

  if (rows.length > 30) {
    sendJson(res, 400, { error: "BULK_LIMIT", message: "대량 등록은 한 번에 최대 30개까지 가능합니다." });
    return;
  }

  const db = await readDb();
  const existingCount = db.products.filter((product) => product.userId === user.id).length;
  const productLimit = getUserProductLimit(user);
  const remaining = Math.max(0, productLimit - existingCount);
  if (!remaining) {
    sendJson(res, 403, { error: "PRODUCT_LIMIT", message: `상품 등록 한도는 ${productLimit}개입니다.` });
    return;
  }

  const now = Date.now();
  const created = [];
  const errors = [];

  for (let index = 0; index < rows.length; index += 1) {
    if (created.length >= remaining) {
      errors.push({ row: index + 1, message: "상품 한도를 초과해 건너뛰었습니다." });
      continue;
    }

    const row = rows[index];
    const term = String(row.term || "").trim();

    if (!term) {
      errors.push({ row: index + 1, message: "키워드는 필수입니다." });
      continue;
    }

    if (findDuplicateKeywordTarget([...db.products, ...created], user.id, term)) {
      errors.push({ row: index + 1, message: "이미 등록된 키워드입니다." });
      continue;
    }

    const product = createKeywordTarget(user, row, now - index);

    try {
      created.push(await trackProduct(product, trackingContext("bulk")));
    } catch (error) {
      errors.push({ row: index + 1, message: error.publicMessage || error.message || "순위 조회 중 오류가 발생했습니다." });
    }
  }

  db.products.unshift(...created);
  appendSnapshots(db, user.id, created, trackingContext("bulk"));
  await writeDb(db);
  sendJson(res, 201, {
    products: created.map((product) => publicProduct(product, db, user.id)),
    createdCount: created.length,
    errorCount: errors.length,
    errors
  });
}

async function trackAllProducts(req, res, user) {
  if (getUserRestrictions(user).manualTrackBlocked) {
    sendJson(res, 403, { error: "MANUAL_TRACK_BLOCKED", message: getRestrictionMessage(user, "수동 조회가 관리자에 의해 제한되었습니다.") });
    return;
  }

  const db = await readDb();
  const products = db.products.filter((product) => product.userId === user.id && !product.disabled);
  const context = trackingContext("manual");
  const tracked = await trackProductsBatched(products, context);

  await persistTrackedProducts(user.id, tracked, context);
  const latestDb = await readDb();
  const responseProducts = latestDb.products
    .filter((product) => product.userId === user.id)
    .map((product) => publicProduct(product, latestDb, user.id));
  sendJson(res, 200, { products: responseProducts });
}

async function trackProductRoute(req, res, user, productId) {
  if (getUserRestrictions(user).manualTrackBlocked) {
    sendJson(res, 403, { error: "MANUAL_TRACK_BLOCKED", message: getRestrictionMessage(user, "수동 조회가 관리자에 의해 제한되었습니다.") });
    return;
  }

  const db = await readDb();
  const product = db.products.find((item) => item.userId === user.id && item.id === productId);
  if (!product) {
    sendJson(res, 404, { error: "NOT_FOUND", message: "상품을 찾을 수 없습니다." });
    return;
  }

  const tracked = await trackProduct(product, trackingContext("manual"));
  await persistTrackedProducts(user.id, [tracked], trackingContext("manual"));
  const latestDb = await readDb();
  const latestProduct = latestDb.products.find((item) => item.userId === user.id && item.id === productId) || tracked;
  sendJson(res, 200, { product: publicProduct(latestProduct, latestDb, user.id) });
}

async function trackKeywordRoute(req, res, user, productId, keywordId) {
  if (getUserRestrictions(user).manualTrackBlocked) {
    sendJson(res, 403, { error: "MANUAL_TRACK_BLOCKED", message: getRestrictionMessage(user, "수동 조회가 관리자에 의해 제한되었습니다.") });
    return;
  }

  const db = await readDb();
  const product = db.products.find((item) => item.userId === user.id && item.id === productId);
  if (!product) {
    sendJson(res, 404, { error: "NOT_FOUND", message: "상품을 찾을 수 없습니다." });
    return;
  }

  const keyword = product.keywords.find((item) => item.id === keywordId);
  if (!keyword) {
    sendJson(res, 404, { error: "NOT_FOUND", message: "키워드를 찾을 수 없습니다." });
    return;
  }

  const trackedKeyword = await trackKeyword(product, keyword, trackingContext("manual"));
  product.keywords = product.keywords.map((item) => item.id === keywordId ? trackedKeyword : item);
  await persistTrackedProducts(user.id, [product], trackingContext("manual"));
  const latestDb = await readDb();
  const latestProduct = latestDb.products.find((item) => item.userId === user.id && item.id === productId) || product;
  sendJson(res, 200, { product: publicProduct(latestProduct, latestDb, user.id), keyword: publicKeyword(trackedKeyword) });
}

async function trackProduct(product, context = trackingContext("manual")) {
  if (isKeywordTarget(product)) {
    return trackKeywordTarget(product, context);
  }

  const tracked = structuredClone(product);
  await enrichProductFromPage(tracked);
  const nextKeywords = [];

  for (const keyword of tracked.keywords) {
    nextKeywords.push(await trackKeyword(tracked, keyword, context));
  }

  tracked.keywords = nextKeywords;
  return tracked;
}

async function trackKeywordTarget(product, context = trackingContext("manual")) {
  const tracked = structuredClone(product);
  const keyword = (tracked.keywords || [])[0] || {
    id: uid(),
    term: tracked.term || tracked.name || "",
    alertRanks: normalizeRankThresholds(tracked.alertRanks),
    dropThreshold: normalizeDropThreshold(tracked.dropThreshold)
  };
  const checkedAt = Date.now();
  tracked.type = "keywordTarget";
  tracked.term = String(tracked.term || keyword.term || tracked.name || "").trim();
  tracked.name = tracked.term;
  tracked.url = "";
  tracked.store = "";
  tracked.productId = "";

  try {
    const scan = await scanNaverTopItems(tracked.term);
    const nextKeyword = buildKeywordTargetKeywordFromScan(keyword, scan, context, checkedAt);
    tracked.keywords = [nextKeyword];
    tracked.alertRanks = nextKeyword.alertRanks;
    tracked.dropThreshold = nextKeyword.dropThreshold;
    tracked.topItems = scan.items;
    tracked.updatedAt = checkedAt;
    tracked.lastChecked = checkedAt;
    tracked.lastError = "";
    return tracked;
  } catch (error) {
    const nextKeyword = buildKeywordTargetKeywordFromError(keyword, error, context, checkedAt);
    tracked.keywords = [nextKeyword];
    tracked.alertRanks = nextKeyword.alertRanks;
    tracked.dropThreshold = nextKeyword.dropThreshold;
    tracked.topItems = Array.isArray(tracked.topItems) ? tracked.topItems : [];
    tracked.updatedAt = checkedAt;
    tracked.lastChecked = checkedAt;
    tracked.lastError = nextKeyword.lastError;
    return tracked;
  }
}

function buildKeywordTargetKeywordFromScan(keyword, scan, context, checkedAt = Date.now()) {
  const resultCount = (scan.items || []).length;
  const firstRank = resultCount ? 1 : null;
  const history = [...(keyword.history || []).slice(-29), resultCount];
  const graphHistory = context.graphEligible
    ? [...(keyword.graphHistory || []).slice(-89), resultCount]
    : Array.isArray(keyword.graphHistory) ? keyword.graphHistory : [];

  return {
    ...keyword,
    alertRanks: normalizeRankThresholds(keyword.alertRanks),
    dropThreshold: normalizeDropThreshold(keyword.dropThreshold),
    rank: firstRank,
    prevRank: keyword.rank || null,
    bestRank: firstRank,
    status: resultCount ? "completed" : "missing",
    history,
    graphHistory,
    lastChecked: checkedAt,
    lastError: resultCount ? "" : "네이버 쇼핑 검색 결과가 없습니다.",
    matchedBy: "top50",
    lastApiCalls: scan.apiCalls || 0,
    resultCount
  };
}

function buildKeywordTargetKeywordFromError(keyword, error, context, checkedAt = Date.now()) {
  const message = error.publicMessage || "키워드 순위 수집 중 오류가 발생했습니다.";
  return {
    ...keyword,
    alertRanks: normalizeRankThresholds(keyword.alertRanks),
    dropThreshold: normalizeDropThreshold(keyword.dropThreshold),
    prevRank: keyword.rank || null,
    status: "error",
    history: [...(keyword.history || []).slice(-29), 0],
    graphHistory: context.graphEligible
      ? [...(keyword.graphHistory || []).slice(-89), 0]
      : Array.isArray(keyword.graphHistory) ? keyword.graphHistory : [],
    lastChecked: checkedAt,
    lastError: message,
    matchedBy: "top50",
    lastApiCalls: error.apiCalls || 0,
    resultCount: 0
  };
}

async function trackKeyword(product, keyword, context = trackingContext("manual")) {
  const previousRank = keyword.rank || null;
  const checkedAt = Date.now();

  try {
    const scan = await scanNaverKeyword(product, keyword.term);
    if (scan.item) applyMatchedItem(product, scan.item);
    return buildTrackedKeywordFromScan(product, keyword, scan, context, checkedAt);
  } catch (error) {
    return buildTrackedKeywordFromError(keyword, error, context, checkedAt);
  }
}

function buildTrackedKeywordFromScan(product, keyword, scan, context, checkedAt = Date.now()) {
  const previousRank = keyword.rank || null;
  const rank = scan.rank || null;
  const status = getStatus(rank, previousRank);
  const history = [...(keyword.history || []).slice(-29), rank || RANK_SCAN_LIMIT + 1];
  const graphHistory = context.graphEligible
    ? [...(keyword.graphHistory || []).slice(-89), rank || RANK_SCAN_LIMIT + 1]
    : Array.isArray(keyword.graphHistory) ? keyword.graphHistory : [];

  return {
    ...keyword,
    rank,
    prevRank: previousRank,
    bestRank: rank ? Math.min(keyword.bestRank || rank, rank) : keyword.bestRank || null,
    status,
    history,
    graphHistory,
    lastChecked: checkedAt,
    lastError: rank ? "" : rankMissingReason(product),
    matchedBy: scan.matchedBy || "",
    lastApiCalls: scan.apiCalls || 0
  };
}

function buildTrackedKeywordFromError(keyword, error, context, checkedAt = Date.now()) {
  const previousRank = keyword.rank || null;
  const message = error.publicMessage || "순위 조회 중 오류가 발생했습니다.";
  return {
    ...keyword,
    prevRank: previousRank,
    status: "error",
    history: [...(keyword.history || []).slice(-29), RANK_SCAN_LIMIT + 1],
    graphHistory: context.graphEligible
      ? [...(keyword.graphHistory || []).slice(-89), RANK_SCAN_LIMIT + 1]
      : Array.isArray(keyword.graphHistory) ? keyword.graphHistory : [],
    lastChecked: checkedAt,
    lastError: message,
    matchedBy: keyword.matchedBy || "",
    lastApiCalls: error.apiCalls || 0
  };
}

async function trackProductsBatched(products, context = trackingContext("manual")) {
  const trackedProducts = [];
  for (const product of products || []) {
    trackedProducts.push(await trackProduct(product, context));
  }
  return trackedProducts;
}

async function scanNaverKeywordBatch(term, targets) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    const error = new Error("Missing Naver API keys");
    error.publicMessage = "네이버 API 키가 서버에 설정되지 않았습니다.";
    throw error;
  }

  const remaining = new Set((targets || []).map((_, index) => index));
  const results = new Map();
  let apiCalls = 0;

  for (let start = 1; start <= RANK_SCAN_LIMIT && remaining.size; start += 100) {
    const display = Math.min(100, RANK_SCAN_LIMIT - start + 1);
    const response = await fetchNaverShoppingPage(term, start, display);
    apiCalls += 1;

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Naver API error ${response.status}: ${body}`);
      error.apiCalls = apiCalls;
      error.publicMessage = response.status === 403
        ? "네이버 검색 API 권한을 확인하세요."
        : `네이버 API 오류가 발생했습니다. (${response.status})`;
      throw error;
    }

    const payload = await response.json();
    const items = Array.isArray(payload.items) ? payload.items : [];
    for (let itemIndex = 0; itemIndex < items.length && remaining.size; itemIndex += 1) {
      const item = items[itemIndex];
      for (const targetIndex of Array.from(remaining)) {
        const target = targets[targetIndex];
        const match = matchProduct(item, target.product);
        if (match.ok) {
          results.set(targetIndex, {
            rank: start + itemIndex,
            matchedBy: match.by,
            item: sanitizeNaverItem(item)
          });
          remaining.delete(targetIndex);
        }
      }
    }

    if (items.length < display) break;
  }

  return { results, apiCalls };
}

async function scanNaverTopItems(term) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    const error = new Error("Missing Naver API keys");
    error.publicMessage = "네이버 API 키가 서버에 설정되지 않았습니다.";
    throw error;
  }

  const response = await fetchNaverShoppingPage(term, 1, RANK_SCAN_LIMIT);
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Naver API error ${response.status}: ${body}`);
    error.apiCalls = 1;
    error.publicMessage = response.status === 403
      ? "네이버 검색 API 권한을 확인하세요."
      : `네이버 API 오류가 발생했습니다. (${response.status})`;
    throw error;
  }

  const payload = await response.json();
  const items = (Array.isArray(payload.items) ? payload.items : [])
    .slice(0, RANK_SCAN_LIMIT)
    .map((item, index) => normalizeRankedNaverItem(item, index + 1));

  return { items, apiCalls: 1 };
}

function fetchNaverShoppingPage(term, start, display) {
  const endpoint = new URL("https://openapi.naver.com/v1/search/shop.json");
  endpoint.searchParams.set("query", term);
  endpoint.searchParams.set("display", String(display));
  endpoint.searchParams.set("start", String(start));
  endpoint.searchParams.set("sort", "sim");

  return fetch(endpoint, {
    headers: {
      "X-Naver-Client-Id": NAVER_CLIENT_ID,
      "X-Naver-Client-Secret": NAVER_CLIENT_SECRET
    }
  });
}

function replaceProductKeyword(product, keywordId, nextKeyword) {
  product.keywords = (product.keywords || []).map((keyword) => keyword.id === keywordId ? nextKeyword : keyword);
}

function normalizeKeywordKey(value) {
  return String(value || "").trim().toLowerCase();
}

function allocateApiCalls(totalCalls, targetCount) {
  const count = Math.max(0, Number(targetCount || 0));
  if (!count) return [];
  const total = Math.max(0, Number(totalCalls || 0));
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

async function persistTrackedProducts(userId, trackedProducts, context = trackingContext("manual")) {
  const db = await readDb();
  const trackedMap = new Map(trackedProducts.map((product) => [product.id, product]));

  db.products = db.products.map((product) => {
    if (product.userId === userId && trackedMap.has(product.id)) return trackedMap.get(product.id);
    return product;
  });

  appendSnapshots(db, userId, trackedProducts, context);
  await writeDb(db);
}

async function persistTrackedProductsBulk(trackedProducts, context = trackingContext("manual")) {
  const db = await readDb();
  const trackedMap = new Map((trackedProducts || []).map((product) => [product.id, product]));

  db.products = db.products.map((product) => trackedMap.has(product.id) ? trackedMap.get(product.id) : product);

  appendSnapshotsForProducts(db, trackedProducts, context);
  await writeDb(db);
}

function appendSnapshots(db, userId, trackedProducts, context = trackingContext("manual")) {
  appendSnapshotRows(db, trackedProducts, context, userId);
}

function appendSnapshotsForProducts(db, trackedProducts, context = trackingContext("manual")) {
  appendSnapshotRows(db, trackedProducts, context);
}

function appendSnapshotRows(db, trackedProducts, context = trackingContext("manual"), forcedUserId = "") {
  const now = Date.now();
  let apiCalls = 0;
  (trackedProducts || []).forEach((product) => {
    if (isKeywordTarget(product)) {
      const keyword = (product.keywords || [])[0] || {};
      const checkedAt = keyword.lastChecked || product.lastChecked || now;
      const collectionId = uid();
      apiCalls += Number(keyword.lastApiCalls || 0);
      (product.topItems || []).slice(0, RANK_SCAN_LIMIT).forEach((item, itemIndex) => {
        db.snapshots.push({
          id: uid(),
          collectionId,
          userId: forcedUserId || product.userId,
          productId: product.id,
          keywordId: keyword.id || "",
          term: keyword.term || product.term || product.name || "",
          rank: item.rank || null,
          status: "completed",
          checkedAt,
          dateKey: getDateKey(checkedAt, SCHEDULE_TIMEZONE),
          itemKey: item.itemKey || item.productId || item.link || "",
          productName: item.title || "",
          productUrl: item.link || "",
          storeName: item.mallName || "",
          image: item.image || "",
          price: item.lprice || "",
          productNaverId: item.productId || "",
          apiCalls: itemIndex === 0 ? Number(keyword.lastApiCalls || 0) : 0,
          error: "",
          source: context.source,
          slotKey: context.slotKey || "",
          graphEligible: Boolean(context.graphEligible)
        });
      });
      if (keyword.status === "error") {
        db.snapshots.push({
          id: uid(),
          collectionId,
          userId: forcedUserId || product.userId,
          productId: product.id,
          keywordId: keyword.id || "",
          term: keyword.term || product.term || product.name || "",
          rank: null,
          status: "error",
          checkedAt,
          dateKey: getDateKey(checkedAt, SCHEDULE_TIMEZONE),
          itemKey: "",
          productName: "",
          productUrl: "",
          storeName: "",
          image: "",
          price: "",
          productNaverId: "",
          apiCalls: 0,
          error: keyword.lastError || "수집 오류",
          source: context.source,
          slotKey: context.slotKey || "",
          graphEligible: Boolean(context.graphEligible)
        });
      }
      return;
    }

    product.keywords.forEach((keyword) => {
      apiCalls += Number(keyword.lastApiCalls || 0);
      db.snapshots.push({
        id: uid(),
        userId: forcedUserId || product.userId,
        productId: product.id,
        keywordId: keyword.id,
          term: keyword.term,
          rank: keyword.rank,
          status: keyword.status,
          checkedAt: keyword.lastChecked || now,
          apiCalls: keyword.lastApiCalls || 0,
          error: keyword.lastError || "",
          source: context.source,
          slotKey: context.slotKey || "",
          graphEligible: Boolean(context.graphEligible)
      });
    });
  });

  addApiUsage(db, apiCalls, now);
  pruneOldSnapshots(db, now);

  if (MAX_SNAPSHOT_ROWS > 0 && db.snapshots.length > MAX_SNAPSHOT_ROWS) {
    db.snapshots = db.snapshots.slice(-MAX_SNAPSHOT_ROWS);
  }
}

function pruneOldSnapshots(db, now = Date.now()) {
  const snapshots = (db.snapshots || []).filter((snapshot) => Number(snapshot.checkedAt || 0));
  const dateKeys = [...new Set(snapshots.map(snapshotDateKey).filter(Boolean))].sort();
  const keepDateKeys = new Set(dateKeys.slice(-7));
  db.snapshots = snapshots.filter((snapshot) => keepDateKeys.has(snapshotDateKey(snapshot)));
}

function startScheduleWorker() {
  if (!SCHEDULE_TIMES.length) return;

  const tick = () => {
    checkScheduledTracking().catch((error) => {
      console.error("Scheduled tracking failed", error);
    });
  };

  setTimeout(tick, 1000);
  setInterval(tick, 30 * 1000);
}

async function checkScheduledTracking() {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) return;

  const now = getTimeInZone(SCHEDULE_TIMEZONE);
  const dueSlot = getDueScheduleSlot(now);
  if (!dueSlot) return;

  const claim = await claimScheduledRun(dueSlot.slotKey);
  if (!claim.claimed) return;

  await runScheduledTracking(dueSlot.slotKey, "auto");
}

async function runScheduledTracking(slotKey, source = "auto") {
  if (scheduledTrackingRunning) {
    return { skipped: true, reason: "tracking_already_running", slotKey };
  }
  scheduledTrackingRunning = true;
  console.log(`[schedule] started ${source} ${slotKey}`);

  try {
    const db = await readDb();
    const userMap = new Map((db.users || []).map((user) => [user.id, user]));
    const products = [];
    let productCount = 0;
    let keywordCount = 0;

    for (const product of db.products) {
      if (product.disabled) continue;
      const owner = userMap.get(product.userId);
      if (!owner || !isUserApproved(owner) || getUserRestrictions(owner).suspended) continue;
      productCount += 1;
      keywordCount += (product.keywords || []).length;
      products.push(product);
    }

    const context = trackingContext(source, slotKey);
    const trackedProducts = await trackProductsBatched(products, context);
    const errorCount = trackedProducts.reduce((sum, product) => sum + (product.keywords || []).filter((keyword) => keyword.status === "error").length, 0);
    await persistTrackedProductsBulk(trackedProducts, context);

    const latest = await readDb();
    latest.meta.scheduler = latest.meta.scheduler || {};
    latest.meta.scheduler.lastCompletedSlot = slotKey;
    latest.meta.scheduler.lastCompletedAt = Date.now();
    const reportResult = await createAndSendRankReport(latest, slotKey, source);
    addSchedulerLog(latest, {
      slotKey,
      status: "completed",
      productCount,
      keywordCount,
      errorCount,
      reportId: reportResult.id,
      emailStatus: reportResult.email?.status || ""
    });
    await writeDb(latest);
    console.log(`[schedule] completed ${source} ${slotKey} products=${productCount} keywords=${keywordCount} email=${reportResult.email?.status || ""}`);

    return {
      skipped: false,
      slotKey,
      productCount,
      keywordCount,
      errorCount,
      report: reportResult,
      completedAt: latest.meta.scheduler.lastCompletedAt
    };
  } catch (error) {
    await recordSchedulerFailure(slotKey, error).catch((logError) => {
      console.error(`[schedule] failed to record failure ${slotKey}`, logError);
    });
    throw error;
  } finally {
    scheduledTrackingRunning = false;
  }
}

async function recordSchedulerFailure(slotKey, error) {
  const latest = await readDb();
  addSchedulerLog(latest, {
    slotKey,
    status: "failed",
    productCount: 0,
    keywordCount: 0,
    errorCount: 1,
    error: String(error?.publicMessage || error?.message || error || "unknown").slice(0, 500)
  });
  await writeDb(latest);
}

async function claimScheduledRun(slotKey) {
  const db = await readDb();
  db.meta.scheduler = db.meta.scheduler || {};
  db.meta.scheduler.lastRuns = db.meta.scheduler.lastRuns || {};

  const existingRunAt = Number(db.meta.scheduler.lastRuns[slotKey] || 0);
  const completed = db.meta.scheduler.lastCompletedSlot === slotKey
    || (db.meta.scheduler.logs || []).some((log) => log.slotKey === slotKey && log.status === "completed");

  if (completed) {
    return { claimed: false, reason: "already_completed", db };
  }

  if (existingRunAt && Date.now() - existingRunAt < SCHEDULE_RETRY_AFTER_MINUTES * 60000) {
    return { claimed: false, reason: "recently_started", db };
  }

  db.meta.scheduler.lastRuns[slotKey] = Date.now();
  pruneLastRuns(db.meta.scheduler.lastRuns);
  await writeDb(db);
  return { claimed: true, db };
}

function getCronSecret(req, requestUrl) {
  return getRequestSecret(req, requestUrl, "secret", "x-cron-secret");
}

function trackingContext(source = "manual", slotKey = "") {
  return {
    source,
    slotKey: slotKey || "",
    graphEligible: source === "auto" && isGraphSnapshotSlot(slotKey)
  };
}

function isGraphSnapshotSlot(slotKey) {
  return /(?:^|:)08:00$/.test(String(slotKey || ""));
}

function isSnapshotGraphEligible(snapshot) {
  if (snapshot.graphEligible === true) return true;
  if (Object.prototype.hasOwnProperty.call(snapshot, "graphEligible")) return false;
  if (snapshot.source || snapshot.slotKey) return snapshot.source === "auto" && isGraphSnapshotSlot(snapshot.slotKey);
  const time = getTimestampInZone(snapshot.checkedAt || 0, SCHEDULE_TIMEZONE);
  return time.hour === 15;
}

function getTimestampInZone(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(Number(timestamp || Date.now())));

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour);
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour,
    minute: Number(map.minute)
  };
}

function getRequestSecret(req, requestUrl, queryName, headerName) {
  const querySecret = requestUrl.searchParams.get(queryName);
  if (querySecret) return querySecret;

  const headerSecret = req.headers[headerName];
  if (Array.isArray(headerSecret)) return headerSecret[0] || "";
  if (headerSecret) return headerSecret;

  const authorization = String(req.headers.authorization || "");
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return "";
}

function isValidCronSecret(value) {
  return isValidSecret(CRON_SECRET, value);
}

function isValidSecret(expectedValue, actualValue) {
  if (!expectedValue || !actualValue) return false;
  const expected = Buffer.from(String(expectedValue));
  const actual = Buffer.from(String(actualValue));
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function parseScheduleTimes(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(entry);
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      return { hour, minute, label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
    })
    .filter(Boolean);
}

function getDueScheduleSlot(now) {
  if (!SCHEDULE_TIMES.length) return null;

  const nowMinutes = now.hour * 60 + now.minute;
  const candidates = SCHEDULE_TIMES
    .map((slot) => {
      const slotMinutes = slot.hour * 60 + slot.minute;
      return {
        slot,
        elapsedMinutes: nowMinutes - slotMinutes,
        slotKey: `${now.date}:${slot.label}`
      };
    })
    .filter((item) => item.elapsedMinutes >= 0 && item.elapsedMinutes <= SCHEDULE_CATCHUP_MINUTES)
    .sort((a, b) => a.elapsedMinutes - b.elapsedMinutes);

  return candidates[0] || null;
}

function getForcedScheduleSlot(now, requestedTime = "") {
  if (!SCHEDULE_TIMES.length) return null;
  const requested = parseScheduleTimes(requestedTime)[0]?.label || "";
  const slot = requested
    ? SCHEDULE_TIMES.find((item) => item.label === requested)
    : SCHEDULE_TIMES[0];
  if (!slot) return null;
  return {
    slot,
    elapsedMinutes: null,
    slotKey: `${now.date}:${slot.label}`,
    forced: true
  };
}

function getTimeInZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour);
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour,
    minute: Number(map.minute)
  };
}

function pruneLastRuns(lastRuns) {
  const entries = Object.entries(lastRuns).sort((a, b) => b[1] - a[1]);
  entries.slice(60).forEach(([key]) => delete lastRuns[key]);
}

function addApiUsage(db, calls, timestamp) {
  const count = Number(calls || 0);
  if (!count) return;
  db.meta = db.meta || {};
  db.meta.apiUsage = db.meta.apiUsage || { days: {}, total: 0 };
  db.meta.apiUsage.days = db.meta.apiUsage.days || {};
  const day = getDateKey(timestamp || Date.now(), SCHEDULE_TIMEZONE);
  db.meta.apiUsage.days[day] = Number(db.meta.apiUsage.days[day] || 0) + count;
  db.meta.apiUsage.total = Number(db.meta.apiUsage.total || 0) + count;
  db.meta.apiUsage.updatedAt = timestamp || Date.now();

  const entries = Object.entries(db.meta.apiUsage.days).sort((a, b) => b[0].localeCompare(a[0]));
  db.meta.apiUsage.days = Object.fromEntries(entries.slice(0, 60));
}

function getApiUsageSummary(db, snapshotsForEstimate = []) {
  const usage = db.meta?.apiUsage || { days: {}, total: 0 };
  const estimatedDays = estimateApiUsageFromSnapshots(snapshotsForEstimate);
  const mergedDays = { ...(usage.days || {}) };
  for (const [day, count] of Object.entries(estimatedDays.days)) {
    mergedDays[day] = Math.max(Number(mergedDays[day] || 0), Number(count || 0));
  }
  const estimatedTotal = Object.values(estimatedDays.days).reduce((sum, count) => sum + Number(count || 0), 0);
  const total = Math.max(Number(usage.total || 0), estimatedTotal);
  const today = getDateKey(Date.now(), SCHEDULE_TIMEZONE);
  const yesterday = getDateKey(Date.now() - 86400000, SCHEDULE_TIMEZONE);
  const dayEntries = Object.entries(mergedDays)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, count]) => ({ day, count: Number(count || 0) }));
  return {
    today,
    todayCount: Number(mergedDays[today] || 0),
    yesterdayCount: Number(mergedDays[yesterday] || 0),
    total,
    limit: 25000,
    remainingToday: Math.max(0, 25000 - Number(mergedDays[today] || 0)),
    days: mergedDays,
    recentDays: dayEntries.slice(0, 7),
    updatedAt: usage.updatedAt || null
  };
}

function estimateApiUsageFromSnapshots(snapshots = []) {
  const byDay = new Map();
  for (const snapshot of snapshots || []) {
    if (Number(snapshot.apiCalls || 0) > 0) continue;
    if (snapshot.status !== "completed" || !snapshot.productId || !snapshot.checkedAt) continue;
    const day = getDateKey(snapshot.checkedAt, SCHEDULE_TIMEZONE);
    const collectionKey = snapshot.collectionId || `${snapshot.userId || ""}:${snapshot.productId}:${day}:${snapshot.checkedAt}`;
    if (!byDay.has(day)) byDay.set(day, new Set());
    byDay.get(day).add(collectionKey);
  }
  return {
    days: Object.fromEntries([...byDay.entries()].map(([day, set]) => [day, set.size]))
  };
}

function addSchedulerLog(db, entry) {
  db.meta = db.meta || {};
  db.meta.scheduler = db.meta.scheduler || {};
  db.meta.scheduler.logs = Array.isArray(db.meta.scheduler.logs) ? db.meta.scheduler.logs : [];
  db.meta.scheduler.logs.unshift({
    id: uid(),
    at: Date.now(),
    ...entry
  });
  db.meta.scheduler.logs = db.meta.scheduler.logs.slice(0, 120);
}

function getSchedulerLogs(db) {
  return (db.meta?.scheduler?.logs || []).slice(0, 60);
}

function getDateKey(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(Number(timestamp || Date.now())));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

async function scanNaverKeyword(product, term) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    const error = new Error("Missing Naver API keys");
    error.publicMessage = "네이버 API 키가 서버에 설정되지 않았습니다.";
    throw error;
  }

  let apiCalls = 0;

  for (let start = 1; start <= RANK_SCAN_LIMIT; start += 100) {
    const display = Math.min(100, RANK_SCAN_LIMIT - start + 1);
    const response = await fetchNaverShoppingPage(term, start, display);
    apiCalls += 1;

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Naver API error ${response.status}: ${body}`);
      error.apiCalls = apiCalls;
      error.publicMessage = response.status === 403
        ? "네이버 검색 API 권한을 확인하세요."
        : `네이버 API 오류가 발생했습니다. (${response.status})`;
      throw error;
    }

    const payload = await response.json();
    const items = Array.isArray(payload.items) ? payload.items : [];
    for (let index = 0; index < items.length; index += 1) {
      const match = matchProduct(items[index], product);
      if (match.ok) {
        return {
          rank: start + index,
          matchedBy: match.by,
          item: sanitizeNaverItem(items[index]),
          apiCalls
        };
      }
    }

    if (items.length < display) break;
  }

  return { rank: null, matchedBy: "", apiCalls };
}

function matchProduct(item, product) {
  const itemProductId = onlyDigits(item.productId);
  const productId = onlyDigits(product.productId) || extractProductIdFromUrl(product.url);
  if (productId && itemProductId && productId === itemProductId) {
    return { ok: true, by: "productId" };
  }

  const productUrlId = extractProductIdFromUrl(product.url);
  if (productUrlId && String(item.link || "").includes(productUrlId)) {
    return { ok: true, by: "url" };
  }

  const mallName = normalizeText(item.mallName);
  const store = normalizeText(product.store);
  const title = normalizeText(stripHtml(item.title));
  const productName = normalizeText(product.name);

  const storeMatches = Boolean(store && mallName && (mallName === store || mallName.includes(store) || store.includes(mallName)));
  if (storeMatches && (!productName || title.includes(productName) || wordOverlap(title, productName) >= 0.55)) {
    return { ok: true, by: "store+title" };
  }

  if (storeMatches && productId && String(item.link || "").includes(productId)) {
    return { ok: true, by: "store+url" };
  }

  return { ok: false, by: "" };
}

function findDuplicateProduct(products, userId, url, productId) {
  const normalizedUrl = String(url || "").trim();
  const normalizedProductId = onlyDigits(productId) || extractProductIdFromUrl(normalizedUrl);
  return (products || []).find((product) => {
    if (product.userId !== userId) return false;
    const existingUrl = String(product.url || "").trim();
    const existingProductId = onlyDigits(product.productId) || extractProductIdFromUrl(existingUrl);
    if (normalizedProductId && existingProductId && normalizedProductId === existingProductId) return true;
    return Boolean(normalizedUrl && existingUrl && normalizedUrl === existingUrl);
  }) || null;
}

function findDuplicateKeywordTarget(products, userId, term) {
  const key = normalizeKeywordKey(term);
  if (!key) return null;
  return (products || []).find((product) => product.userId === userId && isKeywordTarget(product) && normalizeKeywordKey(product.term || product.name) === key) || null;
}

function isKeywordTarget(product) {
  return product?.type === "keywordTarget" || Boolean(product?.term && !String(product?.url || "").trim());
}

function createKeywordTarget(user, config, createdAt = Date.now()) {
  const term = String(config.term || "").trim().slice(0, 120);
  const alertRanks = normalizeRankThresholds(config.alertRanks);
  const dropThreshold = normalizeDropThreshold(config.dropThreshold);
  const keyword = {
    id: uid(),
    term,
    alertRanks,
    dropThreshold,
    rank: null,
    prevRank: null,
    bestRank: null,
    status: "pending",
    history: [],
    graphHistory: [],
    lastChecked: null,
    lastError: "",
    matchedBy: "top50",
    lastApiCalls: 0,
    resultCount: 0
  };

  return {
    id: uid(),
    type: "keywordTarget",
    userId: user.id,
    term,
    name: term,
    store: "",
    productId: "",
    url: "",
    image: "",
    alertRanks,
    dropThreshold,
    createdAt,
    updatedAt: createdAt,
    topItems: [],
    keywords: [keyword]
  };
}

function applyMatchedItem(product, item) {
  if (!item) return;
  const title = stripHtml(item.title);
  const mallName = String(item.mallName || "").trim();
  const productId = String(item.productId || "").trim();

  if (title && shouldAutoFill(product.name)) product.name = title.slice(0, 120);
  if (mallName && shouldAutoFill(product.store)) product.store = mallName.slice(0, 80);
  if (productId && !product.productId) product.productId = productId.slice(0, 80);
  if (item.image) product.image = String(item.image || "").trim().slice(0, 500);
}

async function enrichProductFromPage(product) {
  if (!product || !product.url) return product;
  const needsName = shouldAutoFill(product.name);
  const needsStore = shouldAutoFill(product.store);
  const needsImage = !String(product.image || "").trim();
  if (!needsName && !needsStore && !needsImage) return product;
  applyProductInfoFallback(product);

  let timeout = null;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 6500);
    const response = await fetch(product.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"
      }
    });
    if (!response.ok) return product;

    const html = (await response.text()).slice(0, 900000);
    const meta = extractProductPageMeta(html, product.url);
    if (needsName && meta.name) product.name = meta.name.slice(0, 120);
    if (needsStore && meta.store) product.store = meta.store.slice(0, 80);
    if (needsImage && meta.image) product.image = meta.image.slice(0, 500);
  } catch {
    return product;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  return product;
}

function applyProductInfoFallback(product) {
  const productId = String(product?.productId || extractProductIdFromUrl(product?.url) || "").trim();
  if (shouldAutoFill(product.name)) {
    product.name = productId ? `상품ID ${productId}` : "상품정보 확인 필요";
  }
  if (shouldAutoFill(product.store)) {
    product.store = "스토어 확인 필요";
  }
}

function extractProductPageMeta(html, sourceUrl) {
  const title = readMetaContent(html, "og:title")
    || readMetaContent(html, "twitter:title")
    || readTagContent(html, "title");
  const image = readMetaContent(html, "og:image")
    || readMetaContent(html, "twitter:image")
    || readMetaContent(html, "image");
  const siteName = readMetaContent(html, "og:site_name")
    || readMetaContent(html, "twitter:site");

  return {
    name: cleanProductPageTitle(title),
    store: cleanStoreName(siteName) || storeNameFromUrl(sourceUrl),
    image: absolutizeUrl(decodeHtmlEntities(image), sourceUrl)
  };
}

function readMetaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i")
  ];
  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match) return decodeHtmlEntities(match[1]);
  }
  return "";
}

function readTagContent(html, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(html || "").match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? decodeHtmlEntities(match[1]) : "";
}

function cleanProductPageTitle(value) {
  return stripHtml(decodeHtmlEntities(value))
    .replace(/\s*[:|-]\s*네이버\s*(쇼핑|스마트스토어).*$/i, "")
    .replace(/\s*[:|-]\s*NAVER\s*(Shopping|SmartStore).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanStoreName(value) {
  const cleaned = stripHtml(decodeHtmlEntities(value))
    .replace(/\s*[:|-]\s*네이버\s*(쇼핑|스마트스토어).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /naver|네이버/i.test(cleaned)) return "";
  return cleaned;
}

function storeNameFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/(^|\.)naver\.com$/i.test(url.hostname)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 1 && ["smartstore.naver.com", "brand.naver.com"].includes(url.hostname.toLowerCase())) {
      return decodeURIComponent(parts[0]).slice(0, 80);
    }
  } catch {
    return "";
  }
  return "";
}

function absolutizeUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function rankMissingReason(product) {
  const limit = RANK_SCAN_LIMIT || 1000;
  const productId = product?.productId || extractProductIdFromUrl(product?.url);
  const target = productId ? `상품ID ${productId}` : "상품 URL";
  return `네이버 쇼핑 검색 API 기준 Top ${limit} 안에서 ${target} 매칭 결과를 찾지 못했습니다. URL이 열려도 검색 API 노출 결과와 다를 수 있습니다.`;
}

function displayProductName(product) {
  const current = String(product?.name || "").trim();
  if (!shouldAutoFill(current)) return current;
  const productId = String(product?.productId || extractProductIdFromUrl(product?.url) || "").trim();
  return productId ? `상품ID ${productId}` : "상품정보 확인 필요";
}

function displayProductStore(product) {
  const current = String(product?.store || "").trim();
  if (!shouldAutoFill(current)) return current;
  return storeNameFromUrl(product?.url) || "스토어 확인 필요";
}

function shouldAutoFill(value) {
  const normalized = String(value || "").trim();
  return !normalized
    || normalized === "상품 확인중"
    || normalized === "스토어 확인중"
    || normalized === "상품정보 확인 필요"
    || normalized === "스토어 확인 필요"
    || /^상품ID\s+\d+$/i.test(normalized);
}

function extractProductIdFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const patterns = [
    /\/products\/(\d+)/i,
    /[?&]productId=(\d+)/i,
    /[?&]nv_mid=(\d+)/i,
    /\/catalog\/(\d+)/i
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }

  return "";
}

function getStatus(rank, previousRank) {
  if (!rank) return "missing";
  if (rank <= 10) return "top";
  if (previousRank && rank - previousRank >= 10) return "drop";
  if (previousRank && previousRank - rank >= 5) return "rise";
  return "stable";
}

function splitKeywords(value) {
  return String(value || "")
    .split(/[,|\n]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .slice(0, 30);
}

function parseKeywordTargetConfigs(body) {
  if (Array.isArray(body.rows)) {
    return body.rows
      .map((row) => ({
        term: String(row?.term || row?.keyword || row?.keywords || "").trim(),
        alertRanks: normalizeRankThresholds(row?.alertRanks || row?.ranks || row?.rankThresholds),
        dropThreshold: normalizeDropThreshold(row?.dropThreshold || row?.drop || row?.fall)
      }))
      .filter((item) => item.term)
      .slice(0, 30);
  }

  if (Array.isArray(body.keywordConfigs)) {
    return body.keywordConfigs
      .map((item) => ({
        term: String(item?.term || item?.keyword || "").trim(),
        alertRanks: normalizeRankThresholds(item?.alertRanks || item?.ranks || item?.rankThresholds),
        dropThreshold: normalizeDropThreshold(item?.dropThreshold || item?.drop || item?.fall)
      }))
      .filter((item) => item.term)
      .slice(0, 30);
  }

  const defaultAlertRanks = normalizeRankThresholds(body.alertRanks || body.ranks || body.rankThresholds);
  const defaultDropThreshold = normalizeDropThreshold(body.dropThreshold || body.drop || body.fall);
  return splitKeywords(body.term || body.keyword || body.keywords).map((term) => ({
    term,
    alertRanks: defaultAlertRanks,
    dropThreshold: defaultDropThreshold
  }));
}

function parseKeywordConfigs(body) {
  if (Array.isArray(body.keywordConfigs)) {
    return body.keywordConfigs
      .map((item) => ({
        term: String(item?.term || item?.keyword || "").trim(),
        alertRanks: normalizeRankThresholds(item?.alertRanks || item?.ranks || item?.rankThresholds),
        dropThreshold: normalizeDropThreshold(item?.dropThreshold || item?.drop || item?.fall)
      }))
      .filter((item) => item.term)
      .slice(0, 30);
  }

  const defaultAlertRanks = normalizeRankThresholds(body.alertRanks || body.ranks || body.rankThresholds);
  const defaultDropThreshold = normalizeDropThreshold(body.dropThreshold || body.drop || body.fall);
  return splitKeywords(body.keywords).map((term) => ({
    term,
    alertRanks: defaultAlertRanks,
    dropThreshold: defaultDropThreshold
  }));
}

function normalizeRankThresholds(value) {
  const parts = Array.isArray(value) ? value : String(value || "").split(/[,|\s]+/);
  const ranks = [...new Set(parts
    .map((item) => Number(item))
    .filter((rank) => Number.isInteger(rank) && rank >= 1 && rank <= RANK_SCAN_LIMIT))]
    .sort((a, b) => a - b)
    .slice(0, 3);
  return ranks.length ? ranks : [15];
}

function normalizeDropThreshold(value) {
  const threshold = Number(value);
  return Number.isInteger(threshold) && threshold >= 1 && threshold <= RANK_SCAN_LIMIT ? threshold : 10;
}

function sanitizeNaverItem(item) {
  return {
    title: stripHtml(item.title),
    mallName: item.mallName || "",
    productId: item.productId || "",
    link: item.link || "",
    image: item.image || ""
  };
}

function normalizeRankedNaverItem(item, rank) {
  const sanitized = sanitizeNaverItem(item || {});
  const link = String(sanitized.link || item?.link || "").trim();
  const productId = String(sanitized.productId || item?.productId || "").trim();
  return {
    rank,
    itemKey: productId ? `pid:${productId}` : `url:${normalizeItemUrl(link) || link}`,
    title: sanitized.title || "",
    mallName: sanitized.mallName || "",
    productId,
    link,
    image: sanitized.image || "",
    lprice: item?.lprice || "",
    hprice: item?.hprice || "",
    maker: item?.maker || "",
    brand: item?.brand || "",
    category1: item?.category1 || "",
    category2: item?.category2 || "",
    category3: item?.category3 || "",
    category4: item?.category4 || ""
  };
}

function normalizeItemUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, "")).trim();
}

function normalizeText(value) {
  return stripHtml(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function onlyDigits(value) {
  return String(value || "").replace(/\D+/g, "");
}

function wordOverlap(a, b) {
  const left = new Set(String(a || "").match(/[\p{L}\p{N}]+/gu) || []);
  const right = new Set(String(b || "").match(/[\p{L}\p{N}]+/gu) || []);
  if (!left.size || !right.size) return 0;
  let hits = 0;
  right.forEach((word) => {
    if (left.has(word)) hits += 1;
  });
  return hits / right.size;
}

async function serveStatic(req, res, requestUrl) {
  const rawPath = decodeURIComponent(requestUrl.pathname);
  if (rawPath === "/healthz") {
    sendJson(res, 200, { ok: true, service: "soondaeng-live" });
    return;
  }

  if (rawPath === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
    res.end();
    return;
  }

  if (rawPath === "/admin" || rawPath.startsWith("/admin/")) {
    res.writeHead(302, { Location: ADMIN_APP_URL, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  const cleanPath = rawPath === "/" ? "/index.html" : rawPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, cleanPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600"
    });
    createReadStream(filePath).pipe(res);
  } catch {
    if (!path.extname(filePath)) {
      const fallback = path.join(PUBLIC_DIR, "index.html");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      createReadStream(fallback).pipe(res);
      return;
    }
    sendText(res, 404, "Not found");
  }
}

function createSession(db, userId, now) {
  const raw = crypto.randomBytes(32).toString("hex");
  const signature = signToken(raw);
  db.sessions[raw] = {
    userId,
    createdAt: now,
    expiresAt: now + 1000 * 60 * 60 * 24 * 30
  };
  return `${raw}.${signature}`;
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const value = cookies.sr_session;
  if (!value || !value.includes(".")) return "";
  const [raw, signature] = value.split(".");
  if (!raw || !signature || signToken(raw) !== signature) return "";
  return raw;
}

function signToken(raw) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(raw).digest("hex");
}

function setSessionCookie(req, res, token) {
  const secure = isHttps(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sr_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
}

function clearSessionCookie(req, res) {
  const secure = isHttps(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `sr_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function isHttps(req) {
  return req.headers["x-forwarded-proto"] === "https" || Boolean(req.socket.encrypted);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(";").forEach((part) => {
    const [key, ...rest] = part.trim().split("=");
    if (!key) return;
    cookies[key] = decodeURIComponent(rest.join("="));
  });
  return cookies;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `pbkdf2$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const [, salt, expected] = String(encoded || "").split("$");
  if (!salt || !expected) return false;
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expected, "hex"));
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    phone: normalizePhone(user.phone),
    storeName: user.storeName || "",
    approvalStatus: user.approvalStatus || "approved",
    approvalRequestedAt: user.approvalRequestedAt || user.createdAt || null,
    approvedAt: user.approvedAt || null,
    rejectedAt: user.rejectedAt || null,
    productLimit: getUserProductLimit(user),
    restrictions: getUserRestrictions(user),
    createdAt: user.createdAt
  };
}

function publicProduct(product, db = null, userId = product.userId) {
  const collectionRecords = db ? buildProductCollectionRecords(db, userId, product) : [];
  if (isKeywordTarget(product)) {
    const keyword = (product.keywords || [])[0] || {};
    return {
      id: product.id,
      type: "keywordTarget",
      userId: product.userId,
      term: product.term || product.name || keyword.term || "",
      name: product.term || product.name || keyword.term || "",
      store: "",
      productId: "",
      url: "",
      image: "",
      alertRanks: normalizeRankThresholds(product.alertRanks || keyword.alertRanks),
      dropThreshold: normalizeDropThreshold(product.dropThreshold || keyword.dropThreshold),
      createdAt: product.createdAt || null,
      updatedAt: product.updatedAt || null,
      collectionRecords,
      collectionCount: collectionRecords.length,
      lastCollectionAt: collectionRecords[0]?.checkedAt || keyword.lastChecked || null,
      latestItems: (product.topItems || []).slice(0, RANK_SCAN_LIMIT),
      resultCount: keyword.resultCount || (product.topItems || []).length || 0,
      keywords: [publicKeyword(keyword)]
    };
  }

  return {
    id: product.id,
    userId: product.userId,
    name: displayProductName(product),
    store: displayProductStore(product),
    productId: product.productId || "",
    url: product.url || "",
    image: product.image || "",
    createdAt: product.createdAt || null,
    updatedAt: product.updatedAt || null,
    collectionRecords,
    collectionCount: db ? countProductCollectionRecords(db, userId, product) : collectionRecords.length,
    lastCollectionAt: collectionRecords[0]?.checkedAt || null,
    keywords: (product.keywords || []).map(publicKeyword)
  };
}

function countProductCollectionRecords(db, userId, product) {
  const snapshotCount = (db.snapshots || []).filter((snapshot) => snapshot.userId === userId && snapshot.productId === product.id).length;
  if (snapshotCount) return snapshotCount;
  return (product.keywords || []).reduce((sum, keyword) => sum + (Array.isArray(keyword.history) ? keyword.history.length : 0), 0);
}

function buildProductCollectionRecords(db, userId, product, limit = 300) {
  const snapshots = (db.snapshots || [])
    .filter((snapshot) => snapshot.userId === userId && snapshot.productId === product.id)
    .sort((a, b) => Number(b.checkedAt || 0) - Number(a.checkedAt || 0))
    .slice(0, limit)
    .map((snapshot) => ({
      id: snapshot.id,
      keywordId: snapshot.keywordId || "",
      term: snapshot.term || "",
      rank: snapshot.rank || null,
      status: snapshot.status || "pending",
      checkedAt: snapshot.checkedAt || null,
      dateKey: snapshot.dateKey || getDateKey(snapshot.checkedAt || Date.now(), SCHEDULE_TIMEZONE),
      itemKey: snapshot.itemKey || "",
      productName: snapshot.productName || "",
      productUrl: snapshot.productUrl || "",
      storeName: snapshot.storeName || "",
      image: snapshot.image || "",
      price: snapshot.price || "",
      source: snapshot.source || "",
      slotKey: snapshot.slotKey || "",
      graphEligible: isSnapshotGraphEligible(snapshot),
      error: snapshot.error || ""
    }));

  if (snapshots.length) return snapshots;

  const legacyRecords = [];
  for (const keyword of product.keywords || []) {
    const history = Array.isArray(keyword.history) ? keyword.history : [];
    history.slice(-limit).reverse().forEach((value, index) => {
      const rank = Number(value || 0);
      legacyRecords.push({
        id: `legacy-${keyword.id}-${index}`,
        keywordId: keyword.id,
        term: keyword.term || "",
        rank: rank && rank <= RANK_SCAN_LIMIT ? rank : null,
        status: rank && rank <= RANK_SCAN_LIMIT ? "completed" : "missing",
        checkedAt: keyword.lastChecked || product.updatedAt || product.createdAt || null,
        source: "legacy",
        slotKey: "",
        graphEligible: false,
        error: ""
      });
    });
  }

  return legacyRecords.slice(0, limit);
}

function publicKeyword(keyword) {
  return {
    id: keyword.id,
    term: keyword.term || "",
    alertRanks: normalizeRankThresholds(keyword.alertRanks),
    dropThreshold: normalizeDropThreshold(keyword.dropThreshold),
    rank: keyword.rank || null,
    prevRank: keyword.prevRank || null,
    bestRank: keyword.bestRank || null,
    status: keyword.status || "pending",
    history: Array.isArray(keyword.history) ? keyword.history : [],
    graphHistory: Array.isArray(keyword.graphHistory) ? keyword.graphHistory : [],
    lastChecked: keyword.lastChecked || null,
    lastError: keyword.lastError || "",
    matchedBy: keyword.matchedBy || "",
    lastApiCalls: keyword.lastApiCalls || 0,
    resultCount: keyword.resultCount || 0
  };
}

function parseBulkProducts(body) {
  if (Array.isArray(body.rows)) return body.rows.map(normalizeBulkRow).filter(Boolean);

  const text = String(body.bulkText || body.text || "").trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];

  const delimiter = lines.some((line) => line.includes("\t")) ? "\t" : ",";
  const first = parseDelimitedLine(lines[0], delimiter).map((cell) => cell.toLowerCase().replace(/\s+/g, ""));
  const hasHeader = first.some((cell) => ["url", "producturl", "상품url", "keywords", "keyword", "키워드", "추적키워드"].includes(cell));
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines.map((line) => {
    const cells = parseDelimitedLine(line, delimiter);
    if (hasHeader) {
      const row = {};
      first.forEach((header, index) => {
        if (["url", "producturl", "상품url"].includes(header)) row.url = cells[index] || "";
        if (["keywords", "keyword", "키워드", "추적키워드"].includes(header)) row.keywords = cells[index] || "";
        if (["name", "상품명"].includes(header)) row.name = cells[index] || "";
        if (["store", "스토어", "스토어명"].includes(header)) row.store = cells[index] || "";
        if (["productid", "상품id", "상품번호"].includes(header)) row.productId = cells[index] || "";
      });
      return normalizeBulkRow(row);
    }

    return normalizeBulkRow({
      url: cells[0] || "",
      keywords: cells[1] || ""
    });
  }).filter(Boolean);
}

function normalizeBulkRow(row) {
  if (!row || typeof row !== "object") return null;
  const normalized = {
    url: String(row.url || row.productUrl || "").trim(),
    keywords: String(row.keywords || row.keyword || "").trim(),
    name: String(row.name || "").trim(),
    store: String(row.store || row.storeName || "").trim(),
    productId: String(row.productId || "").trim(),
    alertRanks: row.alertRanks || row.ranks || row.rankThresholds || "",
    dropThreshold: row.dropThreshold || row.drop || row.fall || ""
  };
  if (Array.isArray(row.keywordConfigs)) {
    normalized.keywordConfigs = row.keywordConfigs;
  }
  return normalized;
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}
function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizePhone(value) {
  return String(value || "").trim();
}

function isValidPhone(value) {
  return /^010\d{8}$/.test(String(value || ""));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Payload too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function isTransientStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uid() {
  return crypto.randomUUID();
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function isTruthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(String(value || "").trim().toLowerCase());
}

