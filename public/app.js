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
  notices: [],
  noticesOpen: localStorage.getItem("soondaeng_notices_open") !== "false",
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
  productGrid: document.getElementById("productGrid"),
  emptyProducts: document.getElementById("emptyProducts"),
  productCount: document.getElementById("productCount"),
  bulkSlotMeta: document.getElementById("bulkSlotMeta"),
  bulkSlotList: document.getElementById("bulkSlotList"),
  addBulkSlotsButton: document.getElementById("addBulkSlotsButton"),
  compactBulkSlotsButton: document.getElementById("compactBulkSlotsButton"),
  bulkPreviewButton: document.getElementById("bulkPreviewButton"),
  bulkImportButton: document.getElementById("bulkImportButton"),
  bulkResult: document.getElementById("bulkResult"),
  signalList: document.getElementById("signalList"),
  reportMeta: document.getElementById("reportMeta"),
  thresholdReport: document.getElementById("thresholdReport"),
  dropReport: document.getElementById("dropReport"),
  entryReport: document.getElementById("entryReport"),
  rankChangeReport: document.getElementById("rankChangeReport"),
  noticeDock: document.getElementById("noticeDock"),
  noticeDockMeta: document.getElementById("noticeDockMeta"),
  noticeDockList: document.getElementById("noticeDockList"),
  noticeList: document.getElementById("noticeList"),
  closeNoticeDock: document.getElementById("closeNoticeDock"),
  openNoticeDock: document.getElementById("openNoticeDock"),
  profileForm: document.getElementById("profileForm"),
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
  addBulkSlots(5);
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
  el.productForm.addEventListener("submit", createProduct);
  el.addBulkSlotsButton?.addEventListener("click", () => addBulkSlots(5));
  el.compactBulkSlotsButton?.addEventListener("click", compactBulkSlots);
  el.bulkPreviewButton?.addEventListener("click", previewBulkSlots);
  el.bulkImportButton?.addEventListener("click", bulkImportSlots);
  el.bulkSlotList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-bulk-slot]");
    if (!button) return;
    button.closest(".bulk-slot")?.remove();
    if (!el.bulkSlotList.querySelector(".bulk-slot")) addBulkSlots(1);
    renumberBulkSlots();
    renderBulkMeta();
  });
  el.bulkSlotList?.addEventListener("input", renderBulkMeta);
  el.closeNoticeDock?.addEventListener("click", () => {
    state.noticesOpen = false;
    localStorage.setItem("soondaeng_notices_open", "false");
    renderNotices();
  });
  el.openNoticeDock?.addEventListener("click", () => {
    state.noticesOpen = true;
    localStorage.setItem("soondaeng_notices_open", "true");
    renderNotices();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  el.noticeList?.addEventListener("submit", submitNoticeComment);
  el.noticeDockList?.addEventListener("submit", submitNoticeComment);
  el.profileForm?.addEventListener("submit", saveProfile);
  const profilePhoneInput = el.profileForm?.querySelector('[name="phone"]');
  profilePhoneInput?.addEventListener("input", () => {
    profilePhoneInput.value = profilePhoneInput.value.replace(/\D+/g, "").slice(0, 11);
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.view === "notices") {
        state.noticesOpen = true;
        localStorage.setItem("soondaeng_notices_open", "true");
      }
      setView(button.dataset.view);
    });
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
  state.notices = [];
  showAuth();
}

async function loadAll() {
  await Promise.all([loadProducts(), loadReport(), loadNotices()]);
}

async function loadProducts() {
  const result = await api("/api/products");
  state.products = result.products || [];
  if (result.productLimit) state.config.productLimit = result.productLimit;
}

async function loadReport() {
  state.report = await api("/api/report");
}

async function loadNotices() {
  const result = await api("/api/notices");
  state.notices = result.notices || [];
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
  syncProfileForm();
  render();
}

function render() {
  renderConfig();
  renderKpis();
  renderNotices();
  renderProducts();
  renderReport();
  syncProfileForm();
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
  const keywords = state.products || [];
  const latestItemCount = keywords.reduce((sum, product) => sum + Number(product.resultCount || product.latestItems?.length || 0), 0);
  const summary = state.report?.summary || {};
  el.kpiProducts.textContent = keywords.length;
  el.kpiKeywords.textContent = latestItemCount;
  el.kpiThreshold.textContent = summary.thresholdDropCount || 0;
  el.kpiDrop.textContent = summary.rangeDropCount || 0;
  el.kpiEntry.textContent = summary.newEntryCount || 0;
  el.reportMeta.textContent = state.report
    ? `${formatTime(state.report.windowStart)} ~ ${formatTime(state.report.windowEnd)}`
    : "최근 7일 데이터 기준";
}

function renderProducts() {
  const products = state.products || [];
  el.productCount.textContent = `${products.length}개 키워드`;
  renderBulkMeta();
  el.emptyProducts.hidden = products.length > 0;
  el.productGrid.innerHTML = products.map((product) => {
    const keyword = (product.keywords || [])[0] || {};
    const items = (product.latestItems || []).slice(0, 50);
    return `
      <article class="product-card keyword-card">
        <div class="product-head">
          <div class="product-thumb"><svg><use href="#chart"></use></svg></div>
          <div>
            <strong>${esc(product.term || product.name || keyword.term || "키워드")}</strong>
            <span>기준 ${esc((product.alertRanks || keyword.alertRanks || [15]).join(", "))}위 / 하락폭 ${product.dropThreshold || keyword.dropThreshold || 10}위</span>
          </div>
        </div>
        <div class="keyword-meta">
          <span>최근수집 ${formatTime(product.lastCollectionAt || keyword.lastChecked)}</span>
          <span>저장 ${product.collectionCount || 0}행</span>
          <span>최신 ${product.resultCount || items.length || 0}개</span>
        </div>
        <div class="rank-table-wrap">
          <table class="rank-table">
            <thead><tr><th>순위</th><th>상품</th><th>스토어</th></tr></thead>
            <tbody>
              ${items.length ? items.map((item) => `
                <tr>
                  <td>${item.rank || "-"}</td>
                  <td><a href="${esc(item.link || item.productUrl || "#")}" target="_blank" rel="noreferrer">${esc(item.title || item.productName || "-")}</a></td>
                  <td>${esc(item.mallName || item.storeName || "-")}</td>
                </tr>
              `).join("") : `<tr><td colspan="3">아직 수집된 순위가 없습니다.</td></tr>`}
            </tbody>
          </table>
        </div>
        <div class="card-actions">
          <button class="ghost" type="button" data-track-product="${esc(product.id)}"><svg><use href="#refresh"></use></svg><span>조회</span></button>
          <button class="danger" type="button" data-delete-product="${esc(product.id)}"><svg><use href="#trash"></use></svg><span>삭제</span></button>
        </div>
      </article>
    `;
  }).join("");
  el.productGrid.querySelectorAll("[data-track-product]").forEach((button) => {
    button.addEventListener("click", () => trackProduct(button.dataset.trackProduct));
  });
  el.productGrid.querySelectorAll("[data-delete-product]").forEach((button) => {
    button.addEventListener("click", () => deleteProduct(button.dataset.deleteProduct));
  });
}

function renderReport() {
  const report = state.report || { thresholdDrops: [], rangeDrops: [], newEntries: [], rankChanges: [] };
  const signals = [
    ...report.newEntries.map((item) => ({ ...item, tone: "good" })),
    ...report.thresholdDrops.map((item) => ({ ...item, tone: "warn" })),
    ...report.rangeDrops.map((item) => ({ ...item, tone: "bad" }))
  ].slice(0, 20);
  el.signalList.innerHTML = signals.length ? signals.map(renderSignalItem).join("") : emptyBlock("감지된 신호가 없습니다.", "최근 7일 기준으로 조건에 걸린 키워드 결과가 없습니다.");
  el.thresholdReport.innerHTML = report.thresholdDrops.length ? report.thresholdDrops.map(renderReportItem).join("") : emptyLine("기준밖 이탈 없음");
  el.dropReport.innerHTML = report.rangeDrops.length ? report.rangeDrops.map(renderReportItem).join("") : emptyLine("하락폭 감지 없음");
  el.entryReport.innerHTML = report.newEntries.length ? report.newEntries.map(renderReportItem).join("") : emptyLine("신규 진입 없음");
  if (el.rankChangeReport) {
    el.rankChangeReport.innerHTML = report.rankChanges?.length ? report.rankChanges.slice(0, 80).map(renderReportItem).join("") : emptyLine("순위 변동 없음");
  }
}

function renderNotices() {
  const notices = state.notices || [];
  const hasNotices = notices.length > 0;
  if (el.noticeDock) {
    el.noticeDock.hidden = !hasNotices || !state.noticesOpen;
  }
  if (el.noticeDockMeta) {
    el.noticeDockMeta.textContent = hasNotices ? `최근 ${notices.length}개` : "등록된 공지 없음";
  }
  if (el.noticeDockList) {
    el.noticeDockList.innerHTML = hasNotices
      ? notices.slice(0, 2).map((notice) => renderNotice(notice, { compact: true })).join("")
      : emptyBlock("공지사항이 없습니다.", "관리자가 공지를 등록하면 이곳에 표시됩니다.");
  }
  if (el.noticeList) {
    el.noticeList.innerHTML = hasNotices
      ? notices.map((notice) => renderNotice(notice)).join("")
      : emptyBlock("공지사항이 없습니다.", "관리자가 공지를 등록하면 이곳에 표시됩니다.");
  }
}

function renderNotice(notice, options = {}) {
  const comments = notice.comments || [];
  return `
    <article class="notice-card">
      <div class="notice-title-row">
        <div>
          <strong>${esc(notice.title || "공지")}</strong>
          <span>${formatTime(notice.updatedAt || notice.createdAt)}</span>
        </div>
      </div>
      <p>${esc(notice.body || "").replace(/\n/g, "<br>")}</p>
      ${options.compact ? "" : `
        <div class="notice-comments">
          <strong>댓글 ${comments.length}개</strong>
          ${comments.length ? comments.map(renderNoticeComment).join("") : `<span class="comment-empty">아직 댓글이 없습니다.</span>`}
        </div>
        <form class="notice-comment-form" data-notice-comment-form="${esc(notice.id)}">
          <textarea name="body" maxlength="1000" placeholder="댓글을 입력하세요" required></textarea>
          <button class="ghost" type="submit">댓글 등록</button>
        </form>
      `}
    </article>
  `;
}

function renderNoticeComment(comment) {
  const name = comment.storeName || comment.userEmail || comment.userPhone || "회원";
  return `
    <div class="notice-comment">
      <div><strong>${esc(name)}</strong><span>${formatTime(comment.createdAt)}</span></div>
      <p>${esc(comment.body || "")}</p>
    </div>
  `;
}

async function submitNoticeComment(event) {
  const form = event.target.closest("[data-notice-comment-form]");
  if (!form) return;
  event.preventDefault();
  const noticeId = form.dataset.noticeCommentForm;
  const bodyInput = form.elements.body;
  const body = bodyInput.value.trim();
  if (!body) {
    toast("댓글 내용을 입력해 주세요.");
    return;
  }

  setBusy(true);
  try {
    await api(`/api/notices/${encodeURIComponent(noticeId)}/comments`, {
      method: "POST",
      body: { body }
    });
    form.reset();
    await loadNotices();
    renderNotices();
    toast("댓글을 등록했습니다.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function syncProfileForm() {
  if (!el.profileForm || !state.user) return;
  el.profileForm.email.value = state.user.email || "";
  el.profileForm.phone.value = state.user.phone || "";
  el.profileForm.storeName.value = state.user.storeName || "";
  el.profileForm.currentPassword.value = "";
  el.profileForm.newPassword.value = "";
}

async function saveProfile(event) {
  event.preventDefault();
  const form = new FormData(el.profileForm);
  const payload = Object.fromEntries(form.entries());
  payload.email = String(payload.email || "").trim().toLowerCase();
  payload.phone = String(payload.phone || "").trim();
  payload.storeName = String(payload.storeName || "").trim();
  payload.currentPassword = String(payload.currentPassword || "");
  payload.newPassword = String(payload.newPassword || "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    toast("이메일 형식이 올바르지 않습니다.");
    return;
  }
  if (!/^010\d{8}$/.test(payload.phone)) {
    toast("전화번호는 010으로 시작하는 숫자 11자리로 입력해 주세요.");
    return;
  }

  setBusy(true);
  try {
    const result = await api("/api/me", { method: "PATCH", body: payload });
    state.user = result.user;
    el.userEmail.textContent = `${state.user?.email || ""} / ${state.user?.phone || ""}`;
    syncProfileForm();
    toast(result.message || "회원 정보를 저장했습니다.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function renderSignalItem(item) {
  return `
    <article class="signal-item ${esc(item.tone || "")}">
      <span>${esc(item.eventType)}</span>
      <strong>${esc(item.keyword)} · ${esc(item.productName || "상품명 없음")}</strong>
      <p>${esc(item.detail)}</p>
    </article>
  `;
}

function renderReportItem(item) {
  return `
    <article class="report-item">
      <strong>${esc(item.keyword)}</strong>
      <span>${esc(item.productName || "상품명 없음")} / ${esc(item.storeName || "-")}</span>
      <p>${esc(item.detail)}</p>
      ${item.productUrl ? `<a href="${esc(item.productUrl)}" target="_blank" rel="noreferrer">상품 보기</a>` : ""}
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
    dashboard: ["대시보드", "등록 키워드의 최근 7일 순위 신호를 확인합니다."],
    products: ["키워드", "매일 1~50위 순위를 저장할 키워드를 관리합니다."],
    report: ["7일 리포트", "키워드별 원본 순위와 변동 내역을 확인합니다."],
    notices: ["공지사항", "관리자 공지와 회원 댓글을 확인합니다."],
    profile: ["내 정보", "회원 정보를 수정합니다."]
  };
  const [title, sub] = titles[state.activeView] || titles.dashboard;
  el.pageTitle.textContent = title;
  el.pageSub.textContent = sub;
}

function openModal() {
  el.productForm.reset();
  el.productModal.hidden = false;
  el.productForm.keyword.focus();
}

function closeModal() {
  el.productModal.hidden = true;
}

async function createProduct(event) {
  event.preventDefault();
  const form = new FormData(el.productForm);
  const keyword = String(form.get("keyword") || "").trim();
  if (!keyword) {
    toast("키워드를 입력해 주세요.");
    return;
  }

  setBusy(true);
  try {
    await api("/api/products", {
      method: "POST",
      body: {
        keyword,
        alertRanks: String(form.get("alertRanks") || "").trim() || "15",
        dropThreshold: String(form.get("dropThreshold") || "").trim() || "10"
      },
      timeoutMs: 120000
    });
    closeModal();
    await loadAll();
    render();
    toast("키워드와 1~50위 순위를 저장했습니다.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function addBulkSlots(count = 1) {
  if (!el.bulkSlotList) return;
  const amount = Math.max(1, Number(count) || 1);
  for (let index = 0; index < amount; index += 1) {
    const slot = document.createElement("article");
    slot.className = "bulk-slot keyword-bulk-slot";
    slot.innerHTML = `
      <div class="bulk-slot-head">
        <strong>슬롯 <span data-bulk-slot-number></span></strong>
        <button class="icon-button danger" type="button" data-remove-bulk-slot aria-label="슬롯 삭제"><svg><use href="#trash"></use></svg></button>
      </div>
      <label class="bulk-keyword-field">
        키워드
        <input name="bulkKeyword" placeholder="예: 여름 샌들">
      </label>
      <label>
        기준 순위
        <input name="bulkAlertRanks" placeholder="15">
      </label>
      <label>
        하락폭
        <input name="bulkDropThreshold" inputmode="numeric" placeholder="10">
      </label>
    `;
    el.bulkSlotList.appendChild(slot);
  }
  renumberBulkSlots();
  renderBulkMeta();
}

function compactBulkSlots() {
  if (!el.bulkSlotList) return;
  el.bulkSlotList.querySelectorAll(".bulk-slot").forEach((slot) => {
    const row = readBulkSlot(slot, 0);
    if (row.empty) slot.remove();
  });
  if (!el.bulkSlotList.querySelector(".bulk-slot")) addBulkSlots(5);
  renumberBulkSlots();
  renderBulkMeta();
  if (el.bulkResult) el.bulkResult.hidden = true;
}

function renumberBulkSlots() {
  el.bulkSlotList?.querySelectorAll(".bulk-slot").forEach((slot, index) => {
    const number = slot.querySelector("[data-bulk-slot-number]");
    if (number) number.textContent = String(index + 1);
  });
}

function renderBulkMeta() {
  if (!el.bulkSlotMeta || !el.bulkSlotList) return;
  const totalSlots = el.bulkSlotList.querySelectorAll(".bulk-slot").length;
  const usedSlots = collectBulkSlots({ includeInvalid: true }).length;
  const productLimit = state.config.productLimit || 100;
  const currentCount = (state.products || []).length;
  el.bulkSlotMeta.textContent = `사용중 ${usedSlots}칸 / 전체 ${totalSlots}칸 · 키워드 ${currentCount}/${productLimit}`;
}

function collectBulkSlots(options = {}) {
  if (!el.bulkSlotList) return [];
  return [...el.bulkSlotList.querySelectorAll(".bulk-slot")]
    .map((slot, index) => readBulkSlot(slot, index + 1))
    .filter((row) => options.includeInvalid ? !row.empty : row.valid);
}

function readBulkSlot(slot, number) {
  const term = slot.querySelector('[name="bulkKeyword"]')?.value.trim() || "";
  const alertRanksRaw = slot.querySelector('[name="bulkAlertRanks"]')?.value.trim() || "";
  const dropThresholdRaw = slot.querySelector('[name="bulkDropThreshold"]')?.value.trim() || "";
  const empty = !term && !alertRanksRaw && !dropThresholdRaw;
  return {
    slot: number,
    term,
    alertRanks: alertRanksRaw || "15",
    dropThreshold: dropThresholdRaw || "10",
    empty,
    valid: Boolean(term),
    message: term ? "등록 가능" : "키워드 필요"
  };
}

function previewBulkSlots() {
  const rows = collectBulkSlots({ includeInvalid: true });
  if (!el.bulkResult) return;
  if (!rows.length) {
    el.bulkResult.hidden = false;
    el.bulkResult.innerHTML = `<strong>미리보기</strong><span>채워진 슬롯이 없습니다.</span>`;
    return;
  }

  const currentCount = (state.products || []).length;
  const productLimit = state.config.productLimit || 100;
  const remaining = Math.max(0, productLimit - currentCount);
  const validRows = rows.filter((row) => row.valid);

  el.bulkResult.hidden = false;
  el.bulkResult.innerHTML = `
    <strong>슬롯 미리보기 · 등록 가능 ${Math.min(validRows.length, remaining)}개 · 확인필요 ${rows.length - validRows.length + Math.max(0, validRows.length - remaining)}개</strong>
    <div class="bulk-preview-meta">
      <span>현재 ${currentCount}개 / 한도 ${productLimit}개</span>
      <span>남은 슬롯 ${remaining}개</span>
    </div>
    <div class="bulk-preview-table-wrap">
      <table class="bulk-preview-table">
        <thead><tr><th>슬롯</th><th>키워드</th><th>기준순위</th><th>하락폭</th><th>상태</th></tr></thead>
        <tbody>
          ${rows.map((row) => {
            const validIndex = validRows.indexOf(row) + 1;
            const overLimit = row.valid && validIndex > remaining;
            const status = overLimit ? "한도 초과 예정" : row.message;
            return `
              <tr class="${row.valid && !overLimit ? "ok" : "warn"}">
                <td>${row.slot}</td>
                <td>${esc(row.term || "-")}</td>
                <td>${esc(row.alertRanks)}</td>
                <td>${esc(row.dropThreshold)}</td>
                <td>${esc(status)}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function bulkImportSlots() {
  const rows = collectBulkSlots({ includeInvalid: true });
  const validRows = rows.filter((row) => row.valid);
  const invalidRows = rows.filter((row) => !row.valid);

  if (!validRows.length) {
    toast("등록 가능한 키워드 슬롯이 없습니다.");
    previewBulkSlots();
    return;
  }

  if (validRows.length > 30) {
    toast("대량 등록은 한 번에 최대 30개까지 가능합니다.");
    return;
  }

  if (invalidRows.length && !confirm(`확인필요 슬롯 ${invalidRows.length}개를 제외하고 등록할까요?`)) {
    return;
  }

  setBusy(true);
  try {
    const result = await api("/api/products/bulk", {
      method: "POST",
      body: {
        rows: validRows.map((row) => ({
          term: row.term,
          alertRanks: row.alertRanks,
          dropThreshold: row.dropThreshold
        }))
      },
      timeoutMs: 180000
    });
    await loadAll();
    render();
    renderBulkResult(result);
    toast(`${result.createdCount || 0}개 키워드를 등록했습니다.`);
  } catch (error) {
    if (el.bulkResult) {
      el.bulkResult.hidden = false;
      el.bulkResult.innerHTML = `<strong>등록 실패</strong><span>${esc(error.message)}</span>`;
    }
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function renderBulkResult(result) {
  if (!el.bulkResult) return;
  const errors = result.errors || [];
  el.bulkResult.hidden = false;
  el.bulkResult.innerHTML = `
    <strong>등록 ${result.createdCount || 0}개 완료 · 확인필요 ${errors.length}개</strong>
    ${errors.length ? `<ul>${errors.slice(0, 10).map((error) => `<li>${error.row}번: ${esc(error.message)}</li>`).join("")}</ul>` : "<span>모든 키워드가 등록되었습니다.</span>"}
  `;
}

async function trackAll() {
  setBusy(true);
  try {
    const result = await api("/api/track-all", { method: "POST", timeoutMs: 180000 });
    state.products = result.products || [];
    await loadReport();
    render();
    toast("전체 키워드 순위를 다시 수집했습니다.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function trackProduct(productId) {
  setBusy(true);
  try {
    await api(`/api/products/${encodeURIComponent(productId)}/track`, { method: "POST", timeoutMs: 120000 });
    await loadAll();
    render();
    toast("키워드 순위를 다시 수집했습니다.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function deleteProduct(productId) {
  if (!confirm("이 키워드를 삭제할까요? 저장된 7일 순위도 함께 삭제됩니다.")) return;
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
