const state = {
  token: localStorage.getItem("license_server_token") || "",
  products: [],
  licenses: [],
  authConfig: {
    passport_enabled: true,
    passport_configured: false
  },
  issueTiming: "duration",
  batchTiming: "duration",
  issueDuration: { amount: 1, unit: "year" },
  batchDuration: { amount: 1, unit: "year" },
  renew: {
    license: null,
    duration: { amount: 1, unit: "year" },
    custom: false,
    newKey: ""
  },
  batchResult: [],
  me: null
};

const UNIT_LABEL = { day: "天", month: "个月", year: "年" };

const UNIT_SHORT = { d: "day", m: "month", y: "year" };
const UNIT_API = { day: "day", month: "month", year: "year", d: "day", m: "month", y: "year" };

const titles = {
  dashboard: ["仪表板", "产品、授权和激活状态概览"],
  products: ["产品", "创建产品、复制公钥和产品 API Key"],
  licenses: ["License", "签发、搜索、吊销和续期授权"],
  customers: ["客户", "维护客户资料和关联授权"],
  logs: ["激活日志", "查看产品激活和验证记录"]
};

function $(selector) {
  return document.querySelector(selector);
}

function $all(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function splitList(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function showMessage(text, isError = false) {
  const box = $("#message");
  box.textContent = text;
  box.classList.toggle("is-error", isError);
  box.classList.remove("hidden");
  setTimeout(() => box.classList.add("hidden"), 3500);
}

function confirmAction(message) {
  return window.confirm(message);
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(path, {
    ...options,
    headers
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function loadAuthConfig() {
  state.authConfig = await api("/api/auth/config");
  $("#passport-login").classList.toggle(
    "hidden",
    !state.authConfig.passport_enabled || !state.authConfig.passport_configured
  );
  if (!state.authConfig.passport_configured) {
    $("#login-error").textContent = "PassPort 尚未配置 appId/appSecret";
  }
}

function setAuthenticated(authenticated) {
  $("#login").classList.toggle("hidden", authenticated);
  $("#workspace").classList.toggle("hidden", !authenticated);
  $(".sidebar").classList.toggle("hidden", !authenticated);
}

function licenseStatus(license) {
  if (license.revoked) return "revoked";
  if (!license.activated_at && license.duration_amount && license.duration_unit) return "pending";
  if (license.expires_at && new Date(license.expires_at).getTime() < Date.now()) return "expired";
  return "active";
}

function statusLabel(status) {
  return {
    active: "活跃",
    pending: "待激活",
    expired: "已过期",
    revoked: "已吊销"
  }[status] || status;
}

function formatDuration(amount, unit) {
  if (!amount || !unit) return "";
  return `${amount} ${UNIT_LABEL[unit] || unit}`;
}

function formatLicenseExpiry(license) {
  if (!license.activated_at && license.duration_amount && license.duration_unit) {
    return `激活后 ${formatDuration(license.duration_amount, license.duration_unit)}`;
  }
  if (license.expires_at) return formatDate(license.expires_at);
  return "—";
}

function table(headers, rows) {
  if (!rows.length) return "<p class=\"muted\">暂无数据</p>";
  return `
    <table>
      <thead><tr>${headers.map((item) => `<th>${item}</th>`).join("")}</tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  `;
}

function recordGrid(rows) {
  if (!rows.length) return "<p class=\"muted\">暂无数据</p>";
  return `<div class="record-grid">${rows.join("")}</div>`;
}

async function loadDashboard() {
  const data = await api("/api/admin/stats");
  const s = data.summary;
  $("#stats-grid").innerHTML = [
    ["产品总数", s.product_count],
    ["License", s.license_count],
    ["活跃数", s.active_count],
    ["待激活", s.pending_count ?? 0],
    ["即将过期", s.expiring_soon_count]
  ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join("");

  $("#expiring-list").innerHTML = table(
    ["ID", "客户", "产品", "到期时间", "操作"],
    data.expiring_soon.map((item) => `
      <tr>
        <td>${item.id}</td>
        <td>${item.company || item.customer_name}<br>${item.customer_email || ""}</td>
        <td>${item.product_name}</td>
        <td>${formatDate(item.expires_at)}</td>
        <td><button type="button" class="secondary" data-renew="${item.id}">续期</button></td>
      </tr>
    `)
  );
}

async function loadProducts() {
  const data = await api("/api/admin/products");
  state.products = data.products;
  const options = state.products.map((product) => `<option value="${product.id}">${product.name}</option>`).join("");
  $("#license-form select[name=product_id]").innerHTML = options;
  const batchSelect = $("#batch-license-form select[name=product_id]");
  if (batchSelect) batchSelect.innerHTML = options;

  $("#products-list").innerHTML = recordGrid(
    state.products.map((product) => `
      <article class="record-card">
        <div class="record-card-header">
          <div>
            <h3>${product.name}</h3>
            <p>${product.slug}</p>
          </div>
          <span class="badge">#${product.id}</span>
        </div>
        <div class="record-meta">
          <div><span>License</span><strong>${product.license_count}</strong></div>
        </div>
        <div class="record-field">
          <span>API Key</span>
          <code>${product.api_key}</code>
        </div>
        <div class="record-field">
          <span>公钥</span>
          <code>${product.public_key}</code>
        </div>
        <div class="actions">
          <button class="secondary" data-copy="${encodeURIComponent(product.public_key)}">复制公钥</button>
          <button class="secondary" data-rotate="${product.id}">轮换密钥</button>
        </div>
      </article>
    `)
  );
}

async function loadLicenses(search = "") {
  const data = await api(`/api/admin/licenses${search ? `?search=${encodeURIComponent(search)}` : ""}`);
  state.licenses = data.licenses;
  $("#licenses-list").innerHTML = recordGrid(
    state.licenses.map((license) => {
      const status = licenseStatus(license);
      return `
        <article class="record-card">
          <div class="record-card-header">
            <div>
              <h3>${license.company || license.customer_name}</h3>
              <p>${license.customer_email || "未填写邮箱"}</p>
            </div>
            <span class="status ${status}">${statusLabel(status)}</span>
          </div>
          <div class="record-meta">
            <div><span>产品</span><strong>${license.product_name}</strong></div>
            <div><span>等级</span><strong>${license.tier}</strong></div>
            <div><span>到期时间</span><strong>${formatLicenseExpiry(license)}</strong></div>
            ${license.activated_at ? `<div><span>激活时间</span><strong>${formatDate(license.activated_at)}</strong></div>` : ""}
          </div>
          <div class="record-field">
            <span>License Key</span>
            <code>${license.license_key}</code>
          </div>
          <div class="actions">
            <button class="secondary" data-copy="${encodeURIComponent(license.license_key)}">复制</button>
            <button class="secondary" data-renew="${license.id}">续期</button>
            <button class="danger" data-revoke="${license.id}">吊销</button>
          </div>
        </article>
      `;
    })
  );
}

async function loadCustomers() {
  const data = await api("/api/admin/customers");
  $("#customers-list").innerHTML = recordGrid(
    data.customers.map((customer) => `
      <article class="record-card">
        <div class="record-card-header">
          <div>
            <h3>${customer.name}</h3>
            <p>${customer.company || "未填写公司"}</p>
          </div>
          <span class="badge">#${customer.id}</span>
        </div>
        <div class="record-meta">
          <div><span>License</span><strong>${customer.license_count}</strong></div>
          <div><span>邮箱</span><strong>${customer.email || "未填写"}</strong></div>
          <div><span>电话</span><strong>${customer.phone || "未填写"}</strong></div>
        </div>
      </article>
    `)
  );
}

async function loadLogs() {
  const data = await api("/api/admin/activation-logs");
  $("#logs-list").innerHTML = table(
    ["时间", "动作", "产品", "客户", "主机", "IP", "详情"],
    data.activation_logs.map((log) => `
      <tr>
        <td>${formatDate(log.created_at)}</td>
        <td>${log.action}</td>
        <td>${log.product_name || ""}</td>
        <td>${log.customer_name || ""}<br>${log.customer_email || ""}</td>
        <td>${log.hostname || ""}</td>
        <td>${log.ip_address || ""}</td>
        <td><code>${JSON.stringify(log.details || {})}</code></td>
      </tr>
    `)
  );
}

async function refreshCurrent(view = document.querySelector(".nav-button.active")?.dataset.view || "dashboard") {
  if (view === "dashboard") await loadDashboard();
  if (view === "products") await loadProducts();
  if (view === "licenses") {
    await loadProducts();
    await loadLicenses($("#license-search").value);
  }
  if (view === "customers") await loadCustomers();
  if (view === "logs") await loadLogs();
}

function switchView(view) {
  $all(".nav-button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $all(".view").forEach((section) => section.classList.add("hidden"));
  $(`#${view}-view`).classList.remove("hidden");
  $("#view-title").textContent = titles[view][0];
  $("#view-subtitle").textContent = titles[view][1];
  refreshCurrent(view).catch((error) => showMessage(error.message, true));
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function addDuration(baseDate, amount, unit) {
  const date = new Date(baseDate);
  const value = Number(amount);
  const normalized = UNIT_API[unit] || unit;
  if (!Number.isFinite(value) || value <= 0) return date;
  if (normalized === "day") date.setDate(date.getDate() + value);
  if (normalized === "month") date.setMonth(date.getMonth() + value);
  if (normalized === "year") date.setFullYear(date.getFullYear() + value);
  return date;
}

function parsePreset(preset) {
  const match = String(preset || "").match(/^(\d+)([dmy])$/);
  if (!match) return null;
  return {
    amount: Number.parseInt(match[1], 10),
    unit: UNIT_SHORT[match[2]]
  };
}

function toLocalInputValue(date) {
  const local = new Date(date);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 16);
}

function setDefaultExpiry() {
  const date = addDuration(new Date(), 1, "year");
  const value = toLocalInputValue(date);
  const single = $("#license-form input[name=expires_at]");
  const batch = $("#batch-license-form input[name=expires_at]");
  if (single) single.value = value;
  if (batch) batch.value = value;
}

function durationPreviewText(duration) {
  return `时长：${formatDuration(duration.amount, duration.unit)}（首次激活后起算）`;
}

function setIssueDuration(duration, target = "single") {
  if (!duration) return;
  if (target === "batch") {
    state.batchDuration = duration;
    const form = $("#batch-license-form");
    if (form) {
      form.querySelector("input[name=duration_amount]").value = String(duration.amount);
      form.querySelector("input[name=duration_unit]").value = duration.unit;
    }
    const preview = $("#batch-duration-preview");
    if (preview) preview.textContent = durationPreviewText(duration);
    return;
  }

  state.issueDuration = duration;
  const form = $("#license-form");
  if (form) {
    form.querySelector("input[name=duration_amount]").value = String(duration.amount);
    form.querySelector("input[name=duration_unit]").value = duration.unit;
  }
  const preview = $("#duration-preview");
  if (preview) preview.textContent = durationPreviewText(duration);
}

function setDurationFromPreset(preset, target = "single") {
  const parsed = parsePreset(preset);
  if (!parsed) return;
  setIssueDuration(parsed, target);
  if (target === "batch") {
    document.querySelectorAll("[data-batch-duration]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.batchDuration === preset);
    });
    return;
  }
  document.querySelectorAll("[data-duration]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.duration === preset);
  });
  $("#custom-duration-btn")?.classList.remove("active");
  $("#custom-duration-input")?.classList.add("hidden");
}

function setTimingMode(mode, target = "single") {
  const isDuration = mode === "duration";
  if (target === "batch") {
    state.batchTiming = mode;
    document.querySelectorAll("[data-batch-timing-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.batchTimingMode === mode);
    });
    $("#batch-duration-fields")?.classList.toggle("hidden", !isDuration);
    $("#batch-absolute-fields")?.classList.toggle("hidden", isDuration);
    const expires = $("#batch-license-form input[name=expires_at]");
    if (expires) expires.required = !isDuration;
    return;
  }

  state.issueTiming = mode;
  document.querySelectorAll("[data-timing-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.timingMode === mode);
  });
  $("#duration-fields")?.classList.toggle("hidden", !isDuration);
  $("#absolute-fields")?.classList.toggle("hidden", isDuration);
  const expires = $("#license-form input[name=expires_at]");
  if (expires) expires.required = !isDuration;
  const hint = $("#timing-mode-hint");
  if (hint) {
    hint.textContent = isDuration
      ? "激活后才开始计算有效期，签发后不会空耗"
      : "签发时即写入固定到期日，与是否激活无关";
  }
}

function setExpiryFromPreset(preset, target = "single") {
  const parsed = parsePreset(preset);
  if (!parsed) return;
  const date = addDuration(new Date(), parsed.amount, parsed.unit);
  const value = toLocalInputValue(date);
  if (target === "batch") {
    $("#batch-license-form input[name=expires_at]").value = value;
    document.querySelectorAll("[data-batch-expiry]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.batchExpiry === preset);
    });
    return;
  }
  $("#license-form input[name=expires_at]").value = value;
  document.querySelectorAll("[data-expiry]").forEach((btn) => btn.classList.toggle("active", btn.dataset.expiry === preset));
  $("#custom-expiry-btn").classList.remove("active");
  $("#custom-expiry-input").classList.add("hidden");
}

function applyCustomDuration() {
  const num = Number.parseInt($("#custom-duration-num").value, 10);
  const unit = UNIT_SHORT[$("#custom-duration-unit").value] || "month";
  if (!Number.isFinite(num) || num < 1) return;
  setIssueDuration({ amount: num, unit }, "single");
  document.querySelectorAll("[data-duration]").forEach((btn) => btn.classList.remove("active"));
  $("#custom-duration-btn").classList.add("active");
}

function setIssueMode(mode) {
  const isBatch = mode === "batch";
  document.querySelectorAll("[data-issue-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.issueMode === mode);
  });
  $("#license-form").classList.toggle("hidden", isBatch);
  $("#batch-license-form").classList.toggle("hidden", !isBatch);
}

function setBatchMode(mode) {
  const isList = mode === "list";
  $("#batch-count-fields").classList.toggle("hidden", isList);
  $("#batch-list-fields").classList.toggle("hidden", !isList);
  const countInput = $("#batch-license-form input[name=count]");
  const customers = $("#batch-license-form textarea[name=customers]");
  if (countInput) countInput.required = !isList;
  if (customers) customers.required = isList;
}

function parseCustomerLines(text) {
  return String(text || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split(",").map((part) => part.trim());
      const customer_name = parts[0];
      if (!customer_name) {
        throw new Error(`第 ${index + 1} 行缺少客户名称`);
      }
      return {
        customer_name,
        customer_email: parts[1] || undefined,
        company: parts[2] || undefined
      };
    });
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function batchKeysText(licenses) {
  return licenses.map((license) => license.license_key).join("\n");
}

function showBatchResult(licenses) {
  state.batchResult = licenses;
  const keysText = batchKeysText(licenses);
  $("#batch-result-summary").textContent = `成功签发 ${licenses.length} 个 License Key（一行一个）`;
  const keysBox = $("#batch-keys-text");
  if (keysBox) {
    keysBox.value = keysText;
    keysBox.rows = Math.min(Math.max(licenses.length + 1, 6), 16);
  }
  $("#batch-result-list").innerHTML = table(
    ["ID", "客户", "到期"],
    licenses.map((license) => `
      <tr>
        <td>${license.id}</td>
        <td>${license.customer_name}${license.customer_email ? `<br><span class="muted">${license.customer_email}</span>` : ""}</td>
        <td>${formatLicenseExpiry(license)}</td>
      </tr>
    `)
  );
  $("#batch-result-modal").classList.remove("hidden");
  // Focus and select for immediate copy (Ctrl/Cmd+C)
  if (keysBox) {
    requestAnimationFrame(() => {
      keysBox.focus();
      keysBox.select();
    });
  }
}

function closeBatchResultModal() {
  $("#batch-result-modal").classList.add("hidden");
}

function selectBatchKeys() {
  const keysBox = $("#batch-keys-text");
  if (!keysBox) return;
  keysBox.focus();
  keysBox.select();
}

function downloadBatchCsv(licenses) {
  const header = [
    "id",
    "customer_name",
    "customer_email",
    "company",
    "tier",
    "duration_amount",
    "duration_unit",
    "expires_at",
    "activated_at",
    "license_key"
  ];
  const rows = licenses.map((license) =>
    [
      license.id,
      license.customer_name,
      license.customer_email || "",
      license.company || "",
      license.tier,
      license.duration_amount || "",
      license.duration_unit || "",
      license.expires_at || "",
      license.activated_at || "",
      license.license_key
    ]
      .map(csvEscape)
      .join(",")
  );
  const content = `\uFEFF${[header.join(","), ...rows].join("\n")}`;
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `licenses-batch-${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function applyCustomExpiry() {
  const num = $("#custom-expiry-num").value;
  const unit = $("#custom-expiry-unit").value;
  if (!num || Number(num) < 1) return;
  setExpiryFromPreset(`${num}${unit}`);
  $("#custom-expiry-btn").classList.add("active");
}

function getRenewDuration() {
  if (state.renew.custom) {
    const amount = Number.parseInt($("#renew-custom-num").value, 10);
    const unit = UNIT_SHORT[$("#renew-custom-unit").value] || "month";
    if (!Number.isFinite(amount) || amount < 1) return null;
    return { amount, unit };
  }
  return state.renew.duration;
}

function renewBaseDate(license) {
  const now = new Date();
  if (!license.expires_at) return now;
  const current = new Date(license.expires_at);
  return current.getTime() > now.getTime() ? current : now;
}

function updateRenewPreview() {
  const license = state.renew.license;
  if (!license) return;
  const duration = getRenewDuration();
  const pending = !license.activated_at && license.duration_amount && license.duration_unit;

  if (pending) {
    $("#renew-base").textContent = `未激活 · 当前 ${formatDuration(license.duration_amount, license.duration_unit)}`;
    if (!duration) {
      $("#renew-preview").textContent = "请输入有效时长";
      return;
    }
    if (duration.unit === license.duration_unit) {
      $("#renew-preview").textContent = `激活后 ${formatDuration(
        license.duration_amount + duration.amount,
        duration.unit
      )}`;
    } else {
      $("#renew-preview").textContent = `激活后 ${formatDuration(duration.amount, duration.unit)}（替换原时长）`;
    }
    return;
  }

  const base = renewBaseDate(license);
  $("#renew-base").textContent = formatDate(base);
  if (!duration) {
    $("#renew-preview").textContent = "请输入有效时长";
    return;
  }
  const preview = addDuration(base, duration.amount, duration.unit);
  $("#renew-preview").textContent = formatDate(preview);
}

function setRenewPreset(preset) {
  const parsed = parsePreset(preset);
  if (!parsed) return;
  state.renew.duration = parsed;
  state.renew.custom = false;
  document.querySelectorAll("[data-renew-preset]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.renewPreset === preset);
  });
  $("#renew-custom-btn").classList.remove("active");
  $("#renew-custom-input").classList.add("hidden");
  updateRenewPreview();
}

function closeRenewModal() {
  $("#renew-modal").classList.add("hidden");
  state.renew.license = null;
  state.renew.newKey = "";
  $("#renew-result").classList.add("hidden");
  $("#renew-new-key").textContent = "";
}

async function openRenewModal(licenseId) {
  let license = state.licenses.find((item) => String(item.id) === String(licenseId));
  if (!license) {
    const data = await api(`/api/admin/licenses/${licenseId}`);
    license = data.license;
  }
  if (!license) {
    showMessage("License 不存在", true);
    return;
  }

  state.renew.license = license;
  state.renew.newKey = "";
  $("#renew-result").classList.add("hidden");
  $("#renew-new-key").textContent = "";
  $("#renew-revoked-hint").classList.toggle("hidden", !license.revoked);
  $("#renew-summary").innerHTML = `
    <div><span>客户</span><strong>${license.company || license.customer_name}</strong></div>
    <div><span>产品</span><strong>${license.product_name || license.product_slug || "—"}</strong></div>
    <div><span>当前到期</span><strong>${formatLicenseExpiry(license)}</strong></div>
    <div><span>状态</span><strong>${statusLabel(licenseStatus(license))}</strong></div>
  `;
  setRenewPreset("1y");
  $("#renew-modal").classList.remove("hidden");
}

async function submitRenew() {
  const license = state.renew.license;
  if (!license) return;
  const duration = getRenewDuration();
  if (!duration) {
    showMessage("请选择有效的续期时长", true);
    return;
  }

  const unitLabel = { day: "天", month: "个月", year: "年" }[duration.unit] || duration.unit;
  if (!confirmAction(`确定将该 License 延长 ${duration.amount}${unitLabel}？`)) return;

  const data = await api(`/api/admin/licenses/${license.id}/renew`, {
    method: "POST",
    body: JSON.stringify({ duration })
  });

  state.renew.license = data.license;
  state.renew.newKey = data.license.license_key;
  $("#renew-new-key").textContent = data.license.license_key;
  $("#renew-result").classList.remove("hidden");
  $("#renew-summary").innerHTML = `
    <div><span>客户</span><strong>${data.license.company || data.license.customer_name}</strong></div>
    <div><span>产品</span><strong>${data.license.product_name || data.license.product_slug || "—"}</strong></div>
    <div><span>当前到期</span><strong>${formatLicenseExpiry(data.license)}</strong></div>
    <div><span>状态</span><strong>${statusLabel(licenseStatus(data.license))}</strong></div>
  `;
  updateRenewPreview();

  await loadLicenses($("#license-search")?.value || "");
  await loadDashboard();
  showMessage("License 已续期，请复制新的 License Key");
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("copy command failed");
    }
  } finally {
    textarea.remove();
  }
}

document.addEventListener("click", async (event) => {
  const issueMode = event.target.closest("[data-issue-mode]");
  if (issueMode) {
    setIssueMode(issueMode.dataset.issueMode);
    return;
  }

  const timingMode = event.target.closest("[data-timing-mode]");
  if (timingMode) {
    event.preventDefault();
    setTimingMode(timingMode.dataset.timingMode, "single");
    return;
  }

  const batchTimingMode = event.target.closest("[data-batch-timing-mode]");
  if (batchTimingMode) {
    event.preventDefault();
    setTimingMode(batchTimingMode.dataset.batchTimingMode, "batch");
    return;
  }

  const durationPreset = event.target.closest("[data-duration]");
  if (durationPreset) {
    event.preventDefault();
    setDurationFromPreset(durationPreset.dataset.duration, "single");
    return;
  }

  const batchDurationPreset = event.target.closest("[data-batch-duration]");
  if (batchDurationPreset) {
    event.preventDefault();
    setDurationFromPreset(batchDurationPreset.dataset.batchDuration, "batch");
    return;
  }

  if (event.target.closest("#custom-duration-btn")) {
    event.preventDefault();
    $("#custom-duration-input")?.classList.toggle("hidden");
    return;
  }

  if (event.target.closest("#custom-duration-apply")) {
    event.preventDefault();
    applyCustomDuration();
    return;
  }

  const preset = event.target.closest("[data-expiry]");
  if (preset) {
    event.preventDefault();
    setExpiryFromPreset(preset.dataset.expiry, "single");
    return;
  }

  const batchPreset = event.target.closest("[data-batch-expiry]");
  if (batchPreset) {
    event.preventDefault();
    setExpiryFromPreset(batchPreset.dataset.batchExpiry, "batch");
    return;
  }

  if (event.target.closest("[data-batch-result-close]")) {
    closeBatchResultModal();
    return;
  }

  if (event.target.closest("#batch-copy-keys")) {
    if (!state.batchResult.length) return;
    try {
      const text = $("#batch-keys-text")?.value || batchKeysText(state.batchResult);
      await copyText(text);
      selectBatchKeys();
      showMessage(`已复制 ${state.batchResult.length} 个 License Key（一行一个）`);
    } catch (error) {
      selectBatchKeys();
      showMessage("复制失败，请按 Ctrl+C / ⌘C 手动复制", true);
    }
    return;
  }

  if (event.target.closest("#batch-select-keys")) {
    selectBatchKeys();
    return;
  }

  if (event.target.closest("#batch-download-csv")) {
    if (!state.batchResult.length) return;
    downloadBatchCsv(state.batchResult);
    showMessage("CSV 已下载");
    return;
  }

  const nav = event.target.closest(".nav-button");
  if (nav) {
    switchView(nav.dataset.view);
    return;
  }

  const copy = event.target.closest("[data-copy]");
  if (copy) {
    if (!confirmAction("确定复制这段密钥内容？")) return;
    try {
      await copyText(decodeURIComponent(copy.dataset.copy));
      showMessage("已复制");
    } catch (error) {
      showMessage("复制失败，请手动复制", true);
    }
    return;
  }

  const rotate = event.target.closest("[data-rotate]");
  if (rotate) {
    if (!confirmAction("确定轮换该产品密钥？旧 License 仍可在线验证。")) return;
    await api(`/api/admin/products/${rotate.dataset.rotate}/rotate-key`, { method: "POST", body: "{}" });
    await loadProducts();
    showMessage("密钥已轮换");
    return;
  }

  const revoke = event.target.closest("[data-revoke]");
  if (revoke) {
    if (!confirmAction("确定吊销该 License？")) return;
    await api(`/api/admin/licenses/${revoke.dataset.revoke}/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason: "Revoked from admin console" })
    });
    await loadLicenses($("#license-search").value);
    showMessage("License 已吊销");
    return;
  }

  const renew = event.target.closest("[data-renew]");
  if (renew) {
    openRenewModal(renew.dataset.renew).catch((error) => showMessage(error.message, true));
    return;
  }

  if (event.target.closest("[data-renew-close]")) {
    closeRenewModal();
    return;
  }

  const renewPreset = event.target.closest("[data-renew-preset]");
  if (renewPreset) {
    setRenewPreset(renewPreset.dataset.renewPreset);
    return;
  }

  if (event.target.closest("#renew-custom-btn")) {
    state.renew.custom = true;
    document.querySelectorAll("[data-renew-preset]").forEach((btn) => btn.classList.remove("active"));
    $("#renew-custom-btn").classList.add("active");
    $("#renew-custom-input").classList.remove("hidden");
    updateRenewPreview();
    return;
  }

  if (event.target.closest("#renew-submit")) {
    submitRenew().catch((error) => showMessage(error.message, true));
    return;
  }

  if (event.target.closest("#renew-copy-key")) {
    if (!state.renew.newKey) return;
    try {
      await copyText(state.renew.newKey);
      showMessage("新 License Key 已复制");
    } catch (error) {
      showMessage("复制失败，请手动复制", true);
    }
  }
});

$("#renew-custom-num")?.addEventListener("input", updateRenewPreview);
$("#renew-custom-unit")?.addEventListener("change", updateRenewPreview);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#renew-modal").classList.contains("hidden")) {
    closeRenewModal();
    return;
  }
  if (!$("#batch-result-modal").classList.contains("hidden")) {
    closeBatchResultModal();
  }
});

document.querySelectorAll("#batch-license-form input[name=batch_mode]").forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) setBatchMode(input.value);
  });
});

$("#passport-login").addEventListener("click", () => {
  window.location.href = "/api/auth/passport/start";
});

$("#logout").addEventListener("click", () => {
  if (!confirmAction("确定退出当前管理员会话？")) return;
  state.token = "";
  localStorage.removeItem("license_server_token");
  setAuthenticated(false);
});

$("#product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!confirmAction("确定创建这个产品？")) return;
  await api("/api/admin/products", {
    method: "POST",
    body: JSON.stringify(formData(event.target))
  });
  event.target.reset();
  await loadProducts();
  showMessage("产品已创建");
});

$("#license-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!confirmAction("确定签发这个 License？")) return;
  const data = formData(event.target);
  data.product_id = Number(data.product_id);
  data.max_users = data.max_users === "" ? 0 : Number(data.max_users);
  data.max_models = data.max_models === "" ? 0 : Number(data.max_models);
  data.features = splitList(data.features);
  data.domains = splitList(data.domains);

  const payload = {
    product_id: data.product_id,
    customer_name: data.customer_name,
    customer_email: data.customer_email || undefined,
    company: data.company || undefined,
    tier: data.tier || "starter",
    max_users: data.max_users,
    max_models: data.max_models,
    features: data.features,
    domains: data.domains,
    notes: data.notes || undefined
  };

  if (state.issueTiming === "duration") {
    payload.duration = {
      amount: Number(data.duration_amount) || state.issueDuration.amount,
      unit: data.duration_unit || state.issueDuration.unit
    };
  } else {
    if (!data.expires_at) {
      showMessage("请填写到期时间", true);
      return;
    }
    payload.expires_at = new Date(data.expires_at).toISOString();
  }

  await api("/api/admin/licenses", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  event.target.reset();
  setDefaultExpiry();
  setTimingMode("duration", "single");
  setDurationFromPreset("1y", "single");
  setExpiryFromPreset("1y", "single");
  await loadLicenses();
  await loadDashboard();
  showMessage("License 已签发");
});

$("#batch-license-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = formData(event.target);
  const mode = data.batch_mode || "count";
  const count = Number.parseInt(data.count, 10);
  let licenses;

  try {
    if (mode === "list") {
      licenses = parseCustomerLines(data.customers);
      if (!licenses.length) {
        showMessage("请填写客户名单", true);
        return;
      }
    } else {
      if (!Number.isFinite(count) || count < 1) {
        showMessage("请填写有效数量", true);
        return;
      }
      if (count > 100) {
        showMessage("单次最多 100 个", true);
        return;
      }
    }
  } catch (error) {
    showMessage(error.message, true);
    return;
  }

  const total = mode === "list" ? licenses.length : count;
  if (!confirmAction(`确定批量签发 ${total} 个 License？`)) return;

  const defaults = {
    tier: data.tier || "starter",
    max_users: data.max_users === "" ? 0 : Number(data.max_users),
    max_models: data.max_models === "" ? 0 : Number(data.max_models),
    features: splitList(data.features),
    domains: splitList(data.domains),
    notes: data.notes || null
  };

  if (state.batchTiming === "duration") {
    defaults.duration = {
      amount: Number(data.duration_amount) || state.batchDuration.amount,
      unit: data.duration_unit || state.batchDuration.unit
    };
  } else {
    if (!data.expires_at) {
      showMessage("请填写到期时间", true);
      return;
    }
    defaults.expires_at = new Date(data.expires_at).toISOString();
  }

  const payload = {
    product_id: Number(data.product_id),
    name_prefix: data.name_prefix || "批量",
    defaults
  };

  if (mode === "list") {
    payload.licenses = licenses;
  } else {
    payload.count = count;
  }

  const result = await api("/api/admin/licenses/batch", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  event.target.reset();
  setDefaultExpiry();
  setTimingMode("duration", "batch");
  setDurationFromPreset("1y", "batch");
  setExpiryFromPreset("1y", "batch");
  setBatchMode("count");
  const countRadio = $("#batch-license-form input[name=batch_mode][value=count]");
  if (countRadio) countRadio.checked = true;
  $("#batch-license-form input[name=name_prefix]").value = "批量";
  $("#batch-license-form input[name=count]").value = "5";
  $("#batch-license-form input[name=tier]").value = "starter";
  $("#batch-license-form input[name=max_users]").value = "0";
  $("#batch-license-form input[name=max_models]").value = "0";
  if (state.products.length) {
    $("#batch-license-form select[name=product_id]").value = String(state.products[0].id);
  }

  await loadLicenses();
  await loadDashboard();
  showBatchResult(result.licenses || []);
  showMessage(`已批量签发 ${result.count || result.licenses?.length || 0} 个 License`);
});

$("#customer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!confirmAction("确定创建这个客户？")) return;
  await api("/api/admin/customers", {
    method: "POST",
    body: JSON.stringify(formData(event.target))
  });
  event.target.reset();
  await loadCustomers();
  showMessage("客户已创建");
});

$("#license-search").addEventListener("input", (event) => {
  clearTimeout(window.licenseSearchTimer);
  window.licenseSearchTimer = setTimeout(() => {
    loadLicenses(event.target.value).catch((error) => showMessage(error.message, true));
  }, 250);
});

async function boot() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const passportToken = hash.get("passport_token");
  const passportError = hash.get("passport_error");
  if (passportToken) {
    state.token = passportToken;
    localStorage.setItem("license_server_token", state.token);
    history.replaceState(null, "", window.location.pathname);
  }
  if (passportError) {
    history.replaceState(null, "", window.location.pathname);
  }

  try {
    await loadAuthConfig();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }

  setDefaultExpiry();
  setTimingMode("duration", "single");
  setTimingMode("duration", "batch");
  setDurationFromPreset("1y", "single");
  setDurationFromPreset("1y", "batch");
  $("#license-form input[name=expires_at]")?.addEventListener("change", function () {
    document.querySelectorAll("[data-expiry]").forEach((btn) => btn.classList.remove("active"));
    $("#custom-expiry-btn")?.classList.remove("active");
  });
  $("#custom-expiry-btn")?.addEventListener("click", () => {
    $("#custom-expiry-input")?.classList.toggle("hidden");
  });
  $("#custom-expiry-apply")?.addEventListener("click", applyCustomExpiry);
  $("#custom-expiry-num")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyCustomExpiry();
  });
  $("#custom-duration-num")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyCustomDuration();
  });
  if (!state.token) {
    setAuthenticated(false);
    if (passportError) {
      $("#login-error").textContent = `PassPort 登录失败: ${passportError}`;
    }
    return;
  }

  try {
    const me = await api("/api/auth/me");
    state.me = me.user || null;
    if (state.me) {
      const badge = document.querySelector(".topbar-actions .badge");
      if (badge) badge.textContent = state.me.nickname || state.me.username || "Admin";
    }
    setAuthenticated(true);
    switchView("dashboard");
  } catch (error) {
    state.token = "";
    localStorage.removeItem("license_server_token");
    setAuthenticated(false);
  }
}

boot();
