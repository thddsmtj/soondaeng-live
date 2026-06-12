const state = {
  user: null,
  config: {
    hasNaverKeys: false,
    hasSupabase: false,
    productLimit: 100,
    scheduleTimes: ["08:00"],
    scheduleTimezone: "Asia/Seoul"
  },
  products: [],
  report: null,
  authMode: "login",
  activeView: "dashboard",
  busy: false
};

const el = {
  authView: document.getElementById("authView"),
  appView: document.getElementById("appView"),
  authForm: document.getElementById("authForm"),
  authSubmit: document.getElementById("authSubmit"),
  authMessage: document.getElementById("authMessage"),
  emailField: document.getElementById("emailField"),
  storeField: document.getElementById("storeField"),
  privacyConsentField: document.getElementById("privacyConsentField"),
  userEmail: document.getElementById("userEmail"),
  logoutButton: document.getElementById("logoutButton"),
  keyStatus: document.getElementById("keyStatus"),
  storageStatus: document.getElementById("storageStatus"),
  scheduleStatus: document.getElementById("scheduleStatus"),
  trackAllButton: document.getElementById("trackAllButton"),
  exportButton: document.getElementById("exportButton"),
  reportDownloadButton: document.getElementById("reportDownloadButton"),
  openProductModal: document.getElementById("openProductModal"),
  productModal: document.getElementById("productModal"),
  closeModal: document.getElementById("closeModal"),
  cancelModal: document.getElementById("cancelModal"),
  productForm: document.getElementById("productForm"),
  addKeywordRow: document.getElementById("addKeywordRow"),
  keywordRows: document.getElementById("keywordRows"),
  productGrid: document.getElementById("productGrid"),
  emptyProducts: document.getElementById("emptyProducts"),
  productCount: document.getElementById("productCount"),
  signalList: document.getElementById("signalList"),
  reportMeta: document.getElementById("reportMeta"),
  thresholdReport: document.getElementById("thresholdReport"),
  dropReport: document.getElementById("dropReport"),
  entryReport: document.getElementById("entryReport"),
  kpiProducts: document.getElementById("kpiProducts"),
  kpiKeywords: document.getElementById("kpiKeywords"),
  kpiThreshold: document.getElementById("kpiThreshold"),
  kpiDrop: document.getElementById("kpiDrop"),
  kpiEntry: document.getElementById("kpiEntry"),
  pageTitle: document.getElementById("pageTitle"),
  pageSub: document.getElementById("pageSub"),
  toast: document.getElementById("toast")
};

init();

async function init() {
  bindEvents();
  addKeywordRow();
  try {
    state.config = await api("/api/config");
    const me = await api("/api/me");
    state.user = me.user;
    showApp();
    try {
      await loadAll();
      render();
    } catch (error) {
      toast(`로그인 상태는 확인됐지만 데이터 갱신이 늦고 있습니다. 새로고침을 눌러 주세요. ${error.message}`);
    }
  } catch {
    showAuth();
  }
  renderConfig();
}

function bindEvents() {
  document.querySelectorAll("[data-auth-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.authMode = button.dataset.authTab;
      document.querySelectorAll("[data-auth-tab]").forEach((item) => item.classList.toggle("active", item === button));
      syncAuthMode();
    });
  });
  syncAuthMode();

  const phoneInput = el.authForm.querySelector('[name="phone"]');
  phoneInput?.addEventListener("input", () => {
    phoneInput.value = phoneInput.value.replace(/\D+/g, "").slice(0, 11);
  });

  el.authForm.addEventListener("submit", handleAuth);
  el.logoutButton.addEventListener("click", logout);
  el.trackAllButton.addEventListener("click", trackAll);
  el.exportButton.addEventListener("click", downloadReport);
  el.reportDownloadButton.addEventListener("click", downloadReport);
  el.openProductModal.addEventListener("click", openModal);
  document.querySelectorAll("[data-open-product]").forEach((button) => button.addEventListener("click", openModal));
  el.closeModal.addEventListener("click", closeModal);
  el.cancelModal.addEventListener("click", closeModal);
  el.productModal.addEventListener("click", (event) => {
    if (event.target === el.productModal) closeModal();
  });
  el.addKeywordRow.addEventListener("click", addKeywordRow);
  el.keywordRows.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-keyword]");
    if (!button) return;
    button.closest(".keyword-row")?.remove();
    if (!el.keywordRows.querySelector(".keyword-row")) addKeywordRow();
  });
  el.productForm.addEventListener("submit", createProduct);

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
}

function syncAuthMode() {
  const isRegister = state.authMode === "register";
  el.emailField.hidden = !isRegister;
  el.storeField.hidden = !isRegister;
  el.privacyConsentField.hidden = !isRegister;
  const emailInput = el.authForm.querySelector('[name="email"]');
  const privacyInput = el.authForm.querySelector('[name="privacyConsent"]');
  if (emailInput) {
    emailInput.required = isRegister;
    emailInput.disabled = !isRegister;
  }
  if (privacyInput) {
    privacyInput.required = isRegister;
    privacyInput.disabled = !isRegister;
    if (!isRegister) privacyInput.checked = false;
  }
  el.authSubmit.textContent = isRegister ? "승인 신청" : "로그인";
  el.authForm.password.autocomplete = isRegister ? "new-password" : "current-password";
  hideAuthMessage();
}

async function handleAuth(event) {
  event.preventDefault();
  const form = new FormData(el.authForm);
  const payload = Object.fromEntries(form.entries());
  payload.phone = String(payload.phone || "").trim();

  if (!/^010\d{8}$/.test(payload.phone)) {
    toast("전화번호는 010으로 시작하는 숫자 11자리로 입력해 주세요.");
    return;
  }

  if (state.authMode === "register") {
    payload.email = String(payload.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      toast("이메일 형식이 올바르지 않습니다.");
      return;
    }
    if (payload.privacyConsent !== "true") {
      toast("개인정보 수집 및 이용에 동의해 주세요.");
      return;
    }
  } else {
    delete payload.email;
    delete payload.storeName;
    delete payload.privacyConsent;
  }

  setBusy(true);
  try {
    const endpoint = state.authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    const result = await api(endpoint, { method: "POST", body: payload, retries: state.authMode === "login" ? 2 : 0, timeoutMs: 45000 });
    if (result.approvalPending) {
      state.authMode = "login";
      document.querySelectorAll("[data-auth-tab]").forEach((button) => button.classList.toggle("active", button.dataset.authTab === "login"));
      syncAuthMode();
      showAuthMessage(result.message || "승인 신청이 접수되었습니다.");
      return;
    }
    state.user = result.user;
    showApp();
    try {
      await loadAll();
      render();
    } catch (error) {
      toast(`로그인은 됐지만 데이터 갱신이 늦고 있습니다. 새로고침을 눌러 주세요. ${error.message}`);
    }
    toast("로그인했습니다.");
  } catch (error) {
    showAuthMessage(error.message);
  } finally {
    setBusy(false);
  }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  state.user = null;
  state.products = [];
  state.report = null;
  showAuth();
}

async function loadAll() {
  await Promise.all([loadProducts(), loadReport()]);
}

async function loadProducts() {
  const result = await api("/api/products");
  state.products = result.products || [];
  if (result.productLimit) state.config.productLimit = result.productLimit;
}

async function loadReport() {
  state.report = await api("/api/report");
}

function showAuth() {
  el.appView.hidden = true;
  el.authView.hidden = false;
  renderConfig();
}

function showApp() {
  el.authView.hidden = true;
  el.appView.hidden = false;
  el.userEmail.textContent = `${state.user?.email || ""} / ${state.user?.phone || ""}`;
  render();
}

function render() {
  renderConfig();
  renderKpis();
  renderProducts();
  renderReport();
  setView(state.activeView);
}

function renderConfig() {
  el.keyStatus.textContent = state.config.hasNaverKeys ? "네이버 API 연결" : "네이버 API 미설정";
  el.keyStatus.className = `pill ${state.config.hasNaverKeys ? "ok" : "warn"}`;
  el.storageStatus.textContent = state.config.hasSupabase ? "Supabase 저장" : "로컬 저장";
  el.storageStatus.className = `pill ${state.config.hasSupabase ? "ok" : "muted"}`;
  el.scheduleStatus.textContent = (state.config.scheduleTimes || ["08:00"]).join(", ");
}

function renderKpis() {
  const products = state.products || [];
  const keywordCount = products.reduce((sum, product) => sum + (product.keywords || []).length, 0);
  const summary = state.report?.summary || {};
  el.kpiProducts.textContent = products.length;
  el.kpiKeywords.textContent = keywordCount;
  el.kpiThreshold.textContent = summary.thresholdDropCount || 0;
  el.kpiDrop.textContent = summary.rangeDropCount || 0;
  el.kpiEntry.textContent = summary.newEntryCount || 0;
  el.reportMeta.textContent = state.report
    ? `${formatTime(state.report.windowStart)} ~ ${formatTime(state.report.windowEnd)}`
    : "최근 7일 데이터 기준";
}

function renderProducts() {
  const products = state.products || [];
  el.productCount.textContent = `${products.length}개 상품`;
  el.emptyProducts.hidden = products.length > 0;
  el.productGrid.innerHTML = products.map((product) => `
    <article class="product-card">
      <div class="product-head">
        <div class="product-thumb">${product.image ? `<img src="${esc(product.image)}" alt="">` : `<svg><use href="#box"></use></svg>`}</div>
        <div>
          <strong>${esc(product.name || "상품 확인중")}</strong>
          <span>${esc(product.store || "스토어 확인중")}</span>
        </div>
      </div>
      <a class="product-url" href="${esc(product.url)}" target="_blank" rel="noreferrer">${esc(product.url || "")}</a>
      <div class="keyword-list">
        ${(product.keywords || []).map((keyword) => `
          <div class="keyword-chip">
            <span>${esc(keyword.term)}</span>
            <strong>${keyword.rank ? `${keyword.rank}위` : "50위 밖"}</strong>
            <small>기준 ${esc((keyword.alertRanks || [10]).join(", "))} / 하락 ${keyword.dropThreshold || 15}</small>
          </div>
        `).join("")}
      </div>
      <div class="card-actions">
        <button class="ghost" type="button" data-track-product="${esc(product.id)}"><svg><use href="#refresh"></use></svg><span>조회</span></button>
        <button class="danger" type="button" data-delete-product="${esc(product.id)}"><svg><use href="#trash"></use></svg><span>삭제</span></button>
      </div>
    </article>
  `).join("");
  el.productGrid.querySelectorAll("[data-track-product]").forEach((button) => {
    button.addEventListener("click", () => trackProduct(button.dataset.trackProduct));
  });
  el.productGrid.querySelectorAll("[data-delete-product]").forEach((button) => {
    button.addEventListener("click", () => deleteProduct(button.dataset.deleteProduct));
  });
}

function renderReport() {
  const report = state.report || { thresholdDrops: [], rangeDrops: [], newEntries: [] };
  const signals = [
    ...report.thresholdDrops.map((item) => ({ ...item, tone: "warn" })),
    ...report.rangeDrops.map((item) => ({ ...item, tone: "bad" })),
    ...report.newEntries.map((item) => ({ ...item, tone: "good" }))
  ].slice(0, 8);
  el.signalList.innerHTML = signals.length ? signals.map(renderSignalItem).join("") : emptyBlock("감지된 신호가 없습니다.", "최근 7일 기준으로 조건에 걸린 상품·키워드가 없습니다.");
  el.thresholdReport.innerHTML = report.thresholdDrops.length ? report.thresholdDrops.map(renderReportItem).join("") : emptyLine("기준밖 이탈 없음");
  el.dropReport.innerHTML = report.rangeDrops.length ? report.rangeDrops.map(renderReportItem).join("") : emptyLine("하락폭 감지 없음");
  el.entryReport.innerHTML = report.newEntries.length ? report.newEntries.map(renderReportItem).join("") : emptyLine("신규 진입 없음");
}

function renderSignalItem(item) {
  return `
    <article class="signal-item ${esc(item.tone || "")}">
      <span>${esc(item.eventType)}</span>
      <strong>${esc(item.keyword)} · ${esc(item.productName)}</strong>
      <p>${esc(item.detail)}</p>
    </article>
  `;
}

function renderReportItem(item) {
  return `
    <article class="report-item">
      <strong>${esc(item.keyword)}</strong>
      <span>${esc(item.productName)}</span>
      <p>${esc(item.detail)}</p>
      <a href="${esc(item.productUrl)}" target="_blank" rel="noreferrer">상품 보기</a>
    </article>
  `;
}

function emptyBlock(title, body) {
  return `<div class="empty"><strong>${esc(title)}</strong><span>${esc(body)}</span></div>`;
}

function emptyLine(text) {
  return `<div class="empty small"><span>${esc(text)}</span></div>`;
}

function setView(view) {
  state.activeView = view || "dashboard";
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("active", section.id === `${state.activeView}View`));
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.activeView));
  const titles = {
    dashboard: ["대시보드", "등록한 상품과 키워드의 최근 7일 순위 신호를 확인합니다."],
    products: ["상품·키워드", "순댕이에서 새로 추적할 상품과 키워드를 관리합니다."],
    report: ["7일 리포트", "엑셀 파일에 들어갈 감지 내역을 미리 확인합니다."]
  };
  const [title, sub] = titles[state.activeView] || titles.dashboard;
  el.pageTitle.textContent = title;
  el.pageSub.textContent = sub;
}

function openModal() {
  el.productForm.reset();
  el.keywordRows.innerHTML = "";
  addKeywordRow();
  el.productModal.hidden = false;
  el.productForm.url.focus();
}

function closeModal() {
  el.productModal.hidden = true;
}

function addKeywordRow() {
  const row = document.createElement("div");
  row.className = "keyword-row";
  row.innerHTML = `
    <label>
      키워드
      <input name="keywordTerm" required placeholder="예: 여름 샌들">
    </label>
    <label>
      기준 순위
      <input name="alertRanks" placeholder="예: 3,10,20">
    </label>
    <label>
      하락폭
      <input name="dropThreshold" inputmode="numeric" placeholder="15">
    </label>
    <button class="icon-button danger" type="button" data-remove-keyword aria-label="키워드 삭제"><svg><use href="#trash"></use></svg></button>
  `;
  el.keywordRows.appendChild(row);
}

async function createProduct(event) {
  event.preventDefault();
  const form = new FormData(el.productForm);
  const keywordConfigs = [...el.keywordRows.querySelectorAll(".keyword-row")].map((row) => ({
    term: row.querySelector('[name="keywordTerm"]')?.value.trim() || "",
    alertRanks: row.querySelector('[name="alertRanks"]')?.value.trim() || "10",
    dropThreshold: row.querySelector('[name="dropThreshold"]')?.value.trim() || "15"
  })).filter((item) => item.term);

  if (!keywordConfigs.length) {
    toast("키워드를 1개 이상 입력해 주세요.");
    return;
  }

  const payload = {
    url: String(form.get("url") || "").trim(),
    name: String(form.get("name") || "").trim(),
    store: String(form.get("store") || "").trim(),
    keywordConfigs
  };

  setBusy(true);
  try {
    await api("/api/products", { method: "POST", body: payload });
    closeModal();
    await loadAll();
    render();
    toast("상품과 키워드를 저장했습니다.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function trackAll() {
  setBusy(true);
  try {
    const result = await api("/api/track-all", { method: "POST" });
    state.products = result.products || [];
    await loadReport();
    render();
    toast("전체 순위를 다시 확인했습니다.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function trackProduct(productId) {
  setBusy(true);
  try {
    await api(`/api/products/${encodeURIComponent(productId)}/track`, { method: "POST" });
    await loadAll();
    render();
    toast("상품 순위를 다시 확인했습니다.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function deleteProduct(productId) {
  if (!confirm("이 상품을 삭제할까요?")) return;
  setBusy(true);
  try {
    await api(`/api/products/${encodeURIComponent(productId)}`, { method: "DELETE" });
    await loadAll();
    render();
    toast("삭제했습니다.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function downloadReport() {
  window.location.href = "/api/report/export";
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const init = {
    method,
    headers: { Accept: "application/json" }
  };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const retries = Number.isInteger(options.retries) ? options.retries : (method === "GET" ? 2 : 0);
  const timeoutMs = options.timeoutMs || 30000;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(path, init, timeoutMs);
    } catch {
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw new Error("서버 연결이 잠시 불안정합니다. Render 배포 또는 절전 해제 중일 수 있으니 20~30초 뒤 다시 시도해 주세요.");
    }

    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : await response.text().catch(() => "");
    if (response.ok) return body;
    if (isRetryableStatus(response.status) && attempt < retries) {
      await sleep(700 * (attempt + 1));
      continue;
    }
    throw new Error(readableApiError(response, body, "요청 처리 중 오류가 발생했습니다."));
  }

  throw new Error("요청 처리 중 오류가 발생했습니다.");
}

function readableApiError(response, body, fallback) {
  const rawMessage = typeof body === "string" ? body : body?.message || body?.error || "";
  const message = String(rawMessage || "").trim();
  if (response.status === 401) return message || "로그인이 필요합니다. 다시 로그인해 주세요.";
  if (response.status === 403) return message || "권한이 없습니다. 관리자 승인 상태를 확인해 주세요.";
  if (response.status === 404 || /not\s*found/i.test(message)) {
    return "페이지 또는 API 경로를 찾지 못했습니다. 배포가 끝난 뒤 Ctrl+F5로 새로고침해 주세요.";
  }
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return "서버가 잠시 깨어나는 중입니다. Render 무료 서버는 처음 접속 때 늦을 수 있어 20~30초 뒤 다시 눌러 주세요.";
  }
  return message || `${fallback} (${response.status})`;
}

async function fetchWithTimeout(path, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setBusy(value) {
  state.busy = Boolean(value);
  document.querySelectorAll("button, input, select, textarea").forEach((item) => {
    if (item.closest(".auth-tabs")) return;
    item.disabled = state.busy;
  });
}

function showAuthMessage(message) {
  el.authMessage.textContent = message;
  el.authMessage.hidden = false;
}

function hideAuthMessage() {
  el.authMessage.textContent = "";
  el.authMessage.hidden = true;
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.toast.hidden = true;
  }, 5600);
}

function formatTime(timestamp) {
  if (!timestamp) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: state.config.scheduleTimezone || "Asia/Seoul"
  }).format(new Date(timestamp));
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
