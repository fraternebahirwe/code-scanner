/*
 * Code Scanner — a QR / barcode scanner that uses only your own device camera.
 *
 * The camera stream is opened with getUserMedia (the browser asks permission),
 * decoded on-device, and never sent anywhere. Two decoders are used:
 *   1. The native BarcodeDetector API when the browser supports it (fast,
 *      hardware-accelerated on Chrome / Android).
 *   2. A bundled copy of ZXing as a fallback for Safari / Firefox.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var video = $("video");
  var stage = $("stage");
  var reticle = $("reticle");
  var placeholder = $("placeholder");
  var toggleBtn = $("toggleBtn");
  var switchBtn = $("switchBtn");
  var torchBtn = $("torchBtn");
  var resultEl = $("result");
  var noticeEl = $("notice");
  var histList = $("histList");
  var clearBtn = $("clearBtn");
  var toastEl = $("toast");
  var autoStartEl = $("autoStart");
  var autoOpenEl = $("autoOpen");

  var STORAGE_KEY = "code-scanner-history";
  var AUTOSTART_KEY = "code-scanner-autostart";
  var AUTOOPEN_KEY = "code-scanner-autoopen";
  var DEDUPE_MS = 3000; // ignore the same code re-read within this window
  var scanning = false;
  var stream = null;
  var track = null;
  var facingMode = "environment";
  var rafId = null;
  var nativeDetector = null;
  var zxingReader = null;
  var zxingControls = null;
  var lastValue = null;
  var lastAt = 0;
  var history = loadHistory();

  renderHistory();
  initAutoStart();

  // ---- Auto-start setting ----------------------------------------------

  function initAutoStart() {
    var on = false;
    try { on = localStorage.getItem(AUTOSTART_KEY) === "1"; } catch (e) {}
    autoStartEl.checked = on;
    autoStartEl.addEventListener("change", function () {
      try { localStorage.setItem(AUTOSTART_KEY, autoStartEl.checked ? "1" : "0"); } catch (e) {}
      if (autoStartEl.checked && !scanning) start();
    });
    // Kick off the camera on load when the user has opted in.
    if (on) start();

    var openOn = false;
    try { openOn = localStorage.getItem(AUTOOPEN_KEY) === "1"; } catch (e) {}
    autoOpenEl.checked = openOn;
    autoOpenEl.addEventListener("change", function () {
      try { localStorage.setItem(AUTOOPEN_KEY, autoOpenEl.checked ? "1" : "0"); } catch (e) {}
      if (!autoOpenEl.checked) cancelAutoOpen();
    });
  }

  // ---- Camera lifecycle -------------------------------------------------

  async function start() {
    hideNotice();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch (err) {
      return showCameraError(err);
    }

    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* autoplay quirks; ignore */ }
    track = stream.getVideoTracks()[0];

    // Mirror the preview for front-facing cameras only. A phone's back camera
    // reports facingMode "environment" and is left un-mirrored; the front
    // camera reports "user", and built-in laptop webcams usually report
    // nothing at all — both of those read best mirrored, like a mirror.
    var settings = track.getSettings ? track.getSettings() : {};
    var isFront = settings.facingMode !== "environment";
    stage.classList.toggle("mirror", isFront);

    scanning = true;
    placeholder.hidden = true;
    reticle.hidden = false;
    stage.classList.add("live"); // fade & scale the video in
    setToggle(true);
    setupTorchButton();
    setupSwitchButton();

    if ("BarcodeDetector" in window) {
      startNative();
    } else {
      startZxing();
    }
  }

  function stop() {
    scanning = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (zxingControls) { try { zxingControls.stop(); } catch (e) {} zxingControls = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    track = null;
    video.srcObject = null;
    stage.classList.remove("live");
    stage.classList.remove("mirror");
    reticle.hidden = true;
    placeholder.hidden = false;
    setToggle(false);
    torchBtn.disabled = true; setTorchState(false);
    switchBtn.disabled = true;
  }

  // ---- Native BarcodeDetector path -------------------------------------

  function startNative() {
    var formats = ["qr_code", "ean_13", "ean_8", "code_128", "code_39", "code_93",
      "codabar", "itf", "upc_a", "upc_e", "data_matrix", "aztec", "pdf417"];
    try {
      nativeDetector = new window.BarcodeDetector({ formats: formats });
    } catch (e) {
      nativeDetector = new window.BarcodeDetector();
    }
    var tick = async function () {
      if (!scanning) return;
      try {
        var codes = await nativeDetector.detect(video);
        if (codes && codes.length) {
          onDetected(codes[0].rawValue, codes[0].format);
        }
      } catch (e) { /* frame not ready; keep looping */ }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  // ---- ZXing fallback path ---------------------------------------------

  function startZxing() {
    if (!window.ZXing) {
      showNotice("The barcode decoder could not load. Please reconnect and reload the page.");
      return;
    }
    if (!zxingReader) zxingReader = new window.ZXing.BrowserMultiFormatReader();
    zxingReader.decodeFromVideoElement(video, function (res) {
      if (res && scanning) onDetected(res.getText(), res.getBarcodeFormat && formatName(res.getBarcodeFormat()));
    }).then(function (controls) { zxingControls = controls; })
      .catch(function () {
        // Older ZXing API: continuous decode from the current stream.
        zxingReader.decodeFromStream(stream, video, function (res) {
          if (res && scanning) onDetected(res.getText(), "code");
        });
      });
  }

  function formatName(fmt) {
    var map = window.ZXing.BarcodeFormat;
    for (var k in map) { if (map[k] === fmt) return k.toLowerCase().replace(/_/g, " "); }
    return "code";
  }

  // ---- Handling a detected code ----------------------------------------

  function onDetected(value, format) {
    if (!value) return;
    var now = Date.now();
    // Debounce: ignore the same value repeated within the dedupe window.
    if (value === lastValue && now - lastAt < DEDUPE_MS) return;
    lastValue = value; lastAt = now;

    beep();
    if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
    flashHit();
    showResult(value, format || "code");
    addToHistory(value, format || "code");
  }

  // A friendly type label for badges: "URL", "QR Code" or "Barcode".
  function codeType(value, format) {
    if (detectLink(value)) return "URL";
    var f = (format || "").toString().toLowerCase();
    if (f.indexOf("qr") !== -1) return "QR Code";
    if (f === "data_matrix" || f === "aztec" || f === "pdf417") return f.replace("_", " ").toUpperCase();
    return "Barcode";
  }

  function showResult(value, format) {
    cancelAutoOpen();
    var info = parseContent(value, format); // { type, purpose, fields, link, isUrl }

    resultEl.innerHTML = "";

    // Header: what kind of code this is, and its purpose in plain words.
    var top = document.createElement("div"); top.className = "top";
    var badge = document.createElement("span"); badge.className = "badge" + (info.type === "URL" ? " url" : "");
    badge.textContent = info.type;
    var purpose = document.createElement("span"); purpose.className = "purpose";
    purpose.textContent = info.purpose;
    top.appendChild(badge); top.appendChild(purpose);
    resultEl.appendChild(top);

    // Extracted fields (Wi-Fi name/password, contact phone, coordinates, ...).
    if (info.fields && info.fields.length) {
      var dl = document.createElement("div"); dl.className = "fields";
      info.fields.forEach(function (fld) {
        var row = document.createElement("div"); row.className = "field";
        var k = document.createElement("span"); k.className = "f-key"; k.textContent = fld.label;
        var v = document.createElement("span"); v.className = "f-val" + (fld.mono ? " mono" : ""); v.textContent = fld.value;
        row.appendChild(k); row.appendChild(v);
        if (fld.copyable) {
          var fc = document.createElement("button"); fc.className = "f-copy"; fc.type = "button";
          fc.title = "Copy " + fld.label; fc.setAttribute("aria-label", "Copy " + fld.label);
          fc.innerHTML = iconCopy();
          fc.addEventListener("click", function () { copyText(fld.value); toast("Copied " + fld.label.toLowerCase()); });
          row.appendChild(fc);
        }
        dl.appendChild(row);
      });
      resultEl.appendChild(dl);
    }

    // The raw decoded value, always available.
    var val = document.createElement("p"); val.className = "value"; val.textContent = value;
    resultEl.appendChild(val);

    // Actions: the main thing you'd do with this code, plus Copy.
    var actions = document.createElement("div"); actions.className = "actions";
    if (info.link) {
      var open = document.createElement("a"); open.className = "chip primary-chip"; open.href = info.link.href;
      open.target = "_blank"; open.rel = "noopener noreferrer";
      open.innerHTML = iconLink() + info.link.label;
      actions.appendChild(open);
    }
    var copy = document.createElement("button"); copy.className = "chip"; copy.type = "button";
    copy.innerHTML = iconCopy() + "Copy";
    copy.addEventListener("click", function () {
      copyText(value);
      copy.innerHTML = iconCheck() + "Copied";
      copy.classList.add("ok");
      setTimeout(function () { copy.innerHTML = iconCopy() + "Copy"; copy.classList.remove("ok"); }, 1600);
    });
    actions.appendChild(copy);
    resultEl.appendChild(actions);

    resultEl.hidden = false;

    // Optionally open website links on their own, after a cancellable countdown.
    if (info.isUrl && autoOpenEnabled()) scheduleAutoOpen(info.link.href);
  }

  // Interpret a scanned value into a human-readable purpose plus useful fields.
  function parseContent(value, format) {
    var s = (value || "").trim();
    var up = s.toUpperCase();
    var f = function (label, v, mono) { return { label: label, value: v, mono: !!mono, copyable: !!mono }; };

    if (/^WIFI:/i.test(s)) {
      var w = parseWifi(s);
      return { type: "Wi-Fi", purpose: "Wi-Fi network — connect using these details",
        fields: [f("Network", w.S || "—"), f("Security", w.T || "Open"), f("Password", w.P || "(none)", true)] };
    }
    if (/^BEGIN:VCARD/.test(up) || /^MECARD:/i.test(s)) {
      var c = /^MECARD:/i.test(s) ? parseMecard(s) : parseVCard(s);
      var cf = [];
      if (c.name) cf.push(f("Name", c.name));
      if (c.phone) cf.push(f("Phone", c.phone, true));
      if (c.email) cf.push(f("Email", c.email, true));
      if (c.org) cf.push(f("Company", c.org));
      var clink = c.phone ? { href: "tel:" + c.phone.replace(/\s+/g, ""), label: "Call" } : null;
      return { type: "Contact", purpose: "Contact card", fields: cf, link: clink };
    }
    if (/^mailto:/i.test(s)) {
      return { type: "Email", purpose: "Email address", fields: [f("To", decodeURIComponent(s.slice(7).split("?")[0]))],
        link: { href: s, label: "Send email" } };
    }
    if (/^tel:/i.test(s)) {
      return { type: "Phone", purpose: "Phone number", fields: [f("Number", s.slice(4), true)],
        link: { href: s, label: "Call number" } };
    }
    if (/^smsto:/i.test(s) || /^sms:/i.test(s)) {
      var num = s.replace(/^smsto:/i, "").replace(/^sms:/i, "").split(/[:?]/)[0];
      return { type: "SMS", purpose: "Text message", fields: [f("Number", num, true)],
        link: { href: "sms:" + num, label: "Send SMS" } };
    }
    if (/^geo:/i.test(s)) {
      var g = s.slice(4).split(/[;,]/);
      return { type: "Location", purpose: "Map location",
        fields: [f("Latitude", g[0] || "—"), f("Longitude", g[1] || "—")],
        link: { href: "https://www.google.com/maps?q=" + encodeURIComponent((g[0] || "") + "," + (g[1] || "")), label: "Open in Maps" } };
    }
    if (/^BEGIN:VEVENT/.test(up)) {
      var sum = (s.match(/SUMMARY:(.*)/i) || [])[1];
      var when = (s.match(/DTSTART[^:]*:(.*)/i) || [])[1];
      var ef = [];
      if (sum) ef.push(f("Event", sum.trim()));
      if (when) ef.push(f("Starts", when.trim(), true));
      return { type: "Event", purpose: "Calendar event", fields: ef };
    }

    var link = detectLink(s);
    if (link && link.label === "Open link") {
      var host = ""; try { host = new URL(link.href).hostname.replace(/^www\./, ""); } catch (e) {}
      return { type: "URL", purpose: "Website link" + (host ? " — " + host : ""),
        fields: host ? [f("Site", host)] : [], link: link, isUrl: true };
    }
    if (link) { // mailto/tel already handled above; any other scheme
      return { type: "URL", purpose: "Link", link: link, isUrl: true };
    }

    var lf = (format || "").toLowerCase();
    if (/^\d{8,14}$/.test(s) && lf && lf.indexOf("qr") === -1 && lf !== "code" && lf !== "data_matrix" && lf !== "aztec") {
      return { type: "Barcode", purpose: "Product barcode", fields: [f("Code", s, true)],
        link: { href: "https://www.google.com/search?q=" + encodeURIComponent(s), label: "Look up online" } };
    }
    return { type: codeType(value, format), purpose: "Plain text", fields: [] };
  }

  function parseWifi(s) {
    var out = {};
    s.replace(/^WIFI:/i, "").split(";").forEach(function (kv) {
      var i = kv.indexOf(":");
      if (i > 0) out[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1);
    });
    return out;
  }
  function parseVCard(s) {
    var m = function (re) { var x = s.match(re); return x ? x[1].trim() : ""; };
    return { name: m(/(?:^|\n)FN:(.*)/i), phone: m(/(?:^|\n)TEL[^:]*:(.*)/i),
      email: m(/(?:^|\n)EMAIL[^:]*:(.*)/i), org: m(/(?:^|\n)ORG:(.*)/i) };
  }
  function parseMecard(s) {
    var body = s.replace(/^MECARD:/i, ""); var out = {};
    body.split(";").forEach(function (kv) { var i = kv.indexOf(":"); if (i > 0) out[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1); });
    return { name: (out.N || "").replace(/,/g, " ").trim(), phone: out.TEL || "", email: out.EMAIL || "", org: out.ORG || "" };
  }

  // ---- Auto-open (opt-in) ----------------------------------------------

  var autoOpenTimer = null;
  function autoOpenEnabled() {
    try { return localStorage.getItem(AUTOOPEN_KEY) === "1"; } catch (e) { return false; }
  }
  function scheduleAutoOpen(href) {
    cancelAutoOpen();
    var n = 3;
    var bar = document.createElement("div"); bar.className = "autoopen";
    var text = document.createElement("span");
    var cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "link-btn";
    cancel.textContent = "Cancel"; cancel.addEventListener("click", cancelAutoOpen);
    bar.appendChild(text); bar.appendChild(cancel);
    resultEl.appendChild(bar);
    var render = function () { text.textContent = "Opening in " + n + "…"; };
    render();
    autoOpenTimer = setInterval(function () {
      n--;
      if (n <= 0) { cancelAutoOpen(); window.location.assign(href); }
      else render();
    }, 1000);
  }
  function cancelAutoOpen() {
    if (autoOpenTimer) { clearInterval(autoOpenTimer); autoOpenTimer = null; }
    var bar = resultEl.querySelector(".autoopen");
    if (bar) bar.remove();
  }

  // Work out whether a scanned value is something we can open, and how to
  // label the button. Covers full URLs, bare domains (example.com/page),
  // and the common mailto:/tel:/sms: QR schemes.
  function detectLink(raw) {
    var s = (raw || "").trim();
    if (!s) return null;

    if (/^mailto:/i.test(s)) return { href: s, label: "Send email" };
    if (/^tel:/i.test(s)) return { href: s, label: "Call number" };
    if (/^sms:/i.test(s)) return { href: s, label: "Send SMS" };

    // A full URL with a scheme (http, https, ftp, etc.).
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/\s/.test(s)) {
      return { href: s, label: "Open link" };
    }
    // Starts with www., or looks like a bare domain: has no spaces, a dot,
    // and a 2–24 letter top-level part (optionally followed by a path/query).
    var bareDomain = /^(www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}([\/:?#]\S*)?$/i;
    if (!/\s/.test(s) && bareDomain.test(s)) {
      return { href: "https://" + s.replace(/^\/+/, ""), label: "Open link" };
    }
    return null;
  }

  function flashHit() {
    stage.classList.remove("hit");
    document.body.classList.remove("scan-hit");
    // Force reflow so the animations restart on rapid scans.
    void stage.offsetWidth;
    stage.classList.add("hit");
    document.body.classList.add("scan-hit");
    setTimeout(function () { stage.classList.remove("hit"); }, 400);
    setTimeout(function () { document.body.classList.remove("scan-hit"); }, 900);
  }

  // ---- Torch & camera switching ----------------------------------------

  function setupTorchButton() {
    var caps = track && track.getCapabilities ? track.getCapabilities() : {};
    if (caps && caps.torch) {
      torchBtn.disabled = false;
      torchBtn.onclick = function () {
        var on = !torchBtn.classList.contains("on");
        track.applyConstraints({ advanced: [{ torch: on }] })
          .then(function () { setTorchState(on); })
          .catch(function () { toast("Flashlight not available"); });
      };
    } else {
      torchBtn.disabled = true;
      setTorchState(false);
    }
  }

  function setTorchState(on) {
    torchBtn.classList.toggle("on", on);
    torchBtn.setAttribute("aria-pressed", on ? "true" : "false");
    var label = on ? "Turn flashlight off" : "Turn flashlight on";
    torchBtn.title = label;
    torchBtn.setAttribute("aria-label", label);
  }

  async function setupSwitchButton() {
    var devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
    var cams = devices.filter(function (d) { return d.kind === "videoinput"; });
    switchBtn.disabled = cams.length < 2;
    var nextLabel = facingMode === "environment" ? "Switch to front camera" : "Switch to back camera";
    switchBtn.title = nextLabel;
    switchBtn.setAttribute("aria-label", nextLabel);
    switchBtn.onclick = async function () {
      facingMode = facingMode === "environment" ? "user" : "environment";
      var wasScanning = scanning;
      stage.classList.add("flipping");
      setTimeout(function () { stage.classList.remove("flipping"); }, 500);
      stop();
      if (wasScanning) await start();
    };
  }

  // ---- History ----------------------------------------------------------

  function addToHistory(value, format) {
    history.unshift({ value: value, at: Date.now(), format: format || "code" });
    if (history.length > 50) history = history.slice(0, 50);
    saveHistory();
    renderHistory();
  }

  function renderHistory() {
    histList.innerHTML = "";
    clearBtn.hidden = history.length === 0;
    if (history.length === 0) {
      var empty = document.createElement("div");
      empty.className = "hist-empty";
      empty.textContent = "Scanned codes will appear here.";
      histList.appendChild(empty);
      return;
    }
    history.forEach(function (item) {
      var link = detectLink(item.value);
      var type = codeType(item.value, item.format);

      var row = document.createElement("div"); row.className = "hist-item";

      var badge = document.createElement("span");
      badge.className = "h-badge" + (type === "URL" ? " url" : "");
      badge.textContent = type;

      var val = document.createElement("span"); val.className = "h-val"; val.textContent = item.value; val.title = item.value;
      var time = document.createElement("span"); time.className = "h-time"; time.textContent = timeAgo(item.at);

      var actions = document.createElement("div"); actions.className = "h-actions";
      if (link) {
        var open = document.createElement("a"); open.className = "h-icon"; open.href = link.href;
        open.target = "_blank"; open.rel = "noopener noreferrer";
        open.title = link.label; open.setAttribute("aria-label", link.label + ": " + item.value);
        open.innerHTML = iconLink();
        actions.appendChild(open);
      }
      var copy = document.createElement("button"); copy.className = "h-icon"; copy.type = "button";
      copy.title = "Copy"; copy.setAttribute("aria-label", "Copy: " + item.value); copy.innerHTML = iconCopy();
      copy.addEventListener("click", function () { copyText(item.value); toast("Copied"); });
      actions.appendChild(copy);

      row.appendChild(badge); row.appendChild(val); row.appendChild(time); row.appendChild(actions);
      histList.appendChild(row);
    });
  }

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch (e) { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch (e) {}
  }

  clearBtn.addEventListener("click", function () {
    history = []; saveHistory(); renderHistory(); resultEl.hidden = true;
  });

  // ---- Helpers ----------------------------------------------------------

  function setToggle(on) {
    if (on) {
      toggleBtn.classList.add("stop");
      toggleBtn.setAttribute("aria-label", "Stop scanning");
      toggleBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg> Stop scanning';
    } else {
      toggleBtn.classList.remove("stop");
      toggleBtn.setAttribute("aria-label", "Start scanning");
      toggleBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start scanning';
    }
  }

  toggleBtn.addEventListener("click", function () {
    if (scanning) stop(); else start();
  });

  function showCameraError(err) {
    var name = err && err.name;
    var msg;
    if (name === "NotAllowedError" || name === "SecurityError") {
      msg = "<b>Camera blocked.</b> Allow camera access for this page in your browser, then press Start scanning again.";
    } else if (name === "NotFoundError" || name === "OverconstrainedError") {
      msg = "<b>No camera found.</b> Connect a camera and reload the page.";
    } else if (name === "NotReadableError") {
      msg = "<b>Camera busy.</b> Another app is using the camera. Close it and try again.";
    } else {
      msg = "<b>Could not start the camera.</b> " + (err && err.message ? err.message : "");
    }
    showNotice(msg);
    setToggle(false);
  }

  function showNotice(html) { noticeEl.innerHTML = html; noticeEl.hidden = false; }
  function hideNotice() { noticeEl.hidden = true; }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallbackCopy.bind(null, text));
    } else { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea"); ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta);
    ta.select(); try { document.execCommand("copy"); } catch (e) {} document.body.removeChild(ta);
  }

  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 1600);
  }

  var audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.2);
    } catch (e) {}
  }

  function timeAgo(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    var m = Math.floor(s / 60); if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60); if (h < 24) return h + "h ago";
    return new Date(ts).toLocaleDateString();
  }

  function iconCopy() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; }
  function iconCheck() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'; }
  function iconLink() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'; }

  // Stop the camera when the tab is hidden, to save battery and free the light.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && scanning) stop();
  });

  // Optional debug hook (only with ?debug=1 in the URL) for interpreting a
  // value or previewing a result card without a live camera.
  if (/[?&]debug=1/.test(location.search)) {
    window.CodeScanner = { parseContent: parseContent, showResult: showResult, detectLink: detectLink };
  }
})();
