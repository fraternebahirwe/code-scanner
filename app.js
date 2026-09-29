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

  var STORAGE_KEY = "code-scanner-history";
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
    torchBtn.disabled = true; torchBtn.classList.remove("on");
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
    // Debounce: ignore the same value repeated within 2.5s.
    if (value === lastValue && now - lastAt < 2500) return;
    lastValue = value; lastAt = now;

    beep();
    if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
    flashHit();
    showResult(value, format || "code");
    addToHistory(value);
  }

  function showResult(value, format) {
    var isUrl = /^(https?:\/\/|www\.)/i.test(value.trim());
    var href = isUrl ? (value.trim().indexOf("http") === 0 ? value.trim() : "https://" + value.trim()) : null;

    resultEl.innerHTML = "";
    var top = document.createElement("div"); top.className = "top";
    var badge = document.createElement("span"); badge.className = "badge";
    badge.textContent = (format || "code").toString();
    var label = document.createElement("span"); label.style.color = "var(--muted)"; label.style.fontSize = "13px";
    label.textContent = "Scanned";
    top.appendChild(badge); top.appendChild(label);

    var val = document.createElement("p"); val.className = "value"; val.textContent = value;

    var actions = document.createElement("div"); actions.className = "actions";
    var copy = document.createElement("button"); copy.className = "chip";
    copy.innerHTML = iconCopy() + "Copy";
    copy.addEventListener("click", function () {
      copyText(value);
      copy.innerHTML = iconCheck() + "Copied";
      copy.classList.add("ok");
      setTimeout(function () { copy.innerHTML = iconCopy() + "Copy"; copy.classList.remove("ok"); }, 1600);
    });
    actions.appendChild(copy);

    if (href) {
      var open = document.createElement("a"); open.className = "chip"; open.href = href;
      open.target = "_blank"; open.rel = "noopener noreferrer";
      open.innerHTML = iconLink() + "Open link";
      actions.appendChild(open);
    }

    resultEl.appendChild(top); resultEl.appendChild(val); resultEl.appendChild(actions);
    resultEl.hidden = false;
  }

  function flashHit() {
    stage.classList.remove("hit");
    // Force reflow so the animation restarts on rapid scans.
    void stage.offsetWidth;
    stage.classList.add("hit");
    setTimeout(function () { stage.classList.remove("hit"); }, 400);
  }

  // ---- Torch & camera switching ----------------------------------------

  function setupTorchButton() {
    var caps = track && track.getCapabilities ? track.getCapabilities() : {};
    if (caps && caps.torch) {
      torchBtn.disabled = false;
      torchBtn.onclick = function () {
        var on = !torchBtn.classList.contains("on");
        track.applyConstraints({ advanced: [{ torch: on }] })
          .then(function () { torchBtn.classList.toggle("on", on); })
          .catch(function () { toast("Flashlight not available"); });
      };
    } else {
      torchBtn.disabled = true;
    }
  }

  async function setupSwitchButton() {
    var devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
    var cams = devices.filter(function (d) { return d.kind === "videoinput"; });
    switchBtn.disabled = cams.length < 2;
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

  function addToHistory(value) {
    history.unshift({ value: value, at: Date.now() });
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
      var row = document.createElement("div"); row.className = "hist-item";
      var dot = document.createElement("span"); dot.className = "dot";
      var val = document.createElement("span"); val.className = "h-val"; val.textContent = item.value; val.title = item.value;
      var time = document.createElement("span"); time.className = "h-time"; time.textContent = timeAgo(item.at);
      var copy = document.createElement("button"); copy.className = "h-copy"; copy.title = "Copy"; copy.innerHTML = iconCopy();
      copy.addEventListener("click", function () { copyText(item.value); toast("Copied"); });
      row.appendChild(dot); row.appendChild(val); row.appendChild(time); row.appendChild(copy);
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
      toggleBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/></svg> Stop scanning';
    } else {
      toggleBtn.classList.remove("stop");
      toggleBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start scanning';
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
})();
