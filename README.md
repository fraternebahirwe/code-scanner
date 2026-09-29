# Code Scanner

A QR code and barcode scanner that runs entirely on **your own device camera**.
The camera stream is opened with the browser's normal permission prompt,
decoded on your device, and never sent anywhere.

## Start it

Double-click `start.command` (or run `npm start`), then open
http://localhost:4455 if it doesn't open by itself.

The app runs on `localhost` because browsers only allow camera access from a
secure page — opening `index.html` directly as a file will not turn the camera
on.

## Using it

- Press **Start scanning** and allow camera access when the browser asks.
- Point the camera at a QR code or barcode. When one is found you'll hear a
  beep and see the decoded value, with buttons to **Copy** it or **Open** it
  (for links).
- **Switch camera** flips between front and back cameras (when more than one
  exists).
- **Flashlight** turns on the torch (on phones that support it).
- Recent scans are kept in **Scan history**, stored only in this browser.

## What a scan shows

The app doesn't just print the raw text — it works out **what the code is for**
and pulls out the useful parts:

- **Website** — the address and domain, with an **Open link** button.
- **Wi-Fi** — the network name, security type and password (each copyable).
- **Contact** — name, phone, email and company, with a **Call** button.
- **Phone / Email / SMS** — with **Call**, **Send email** or **Send SMS**.
- **Location** — coordinates, with **Open in Maps**.
- **Product barcode** — the number, with a **Look up online** button.
- **Text** — anything else, shown as-is.

Turn on **Open website links automatically** to have a scanned link open on
its own after a short, cancellable countdown. It is **off by default** on
purpose: a QR sticker placed over a real one can point at a fake site, so
opening links should be a deliberate choice.

## Supported codes

QR, Data Matrix, Aztec, PDF417, and 1D barcodes such as EAN-13/8, UPC-A/E,
Code 128, Code 39/93, Codabar and ITF.

On Chrome and Android the built-in `BarcodeDetector` is used. On Safari and
Firefox a bundled copy of [ZXing](https://github.com/zxing-js/library)
(`vendor/zxing.min.js`) is used instead, so no internet connection is needed.

## Animations

The interface is lightly animated for feedback and polish: the header,
camera and controls ease in on load; the scan-frame corners draw in with a
stagger and the guide line sweeps; a successful scan triggers a green ring
burst, a corner pop, a beep and a vibration; the result badge pops and its
buttons cascade in; history rows stagger in; switching cameras flips the
stage; and an idle glow invites the first tap. All of it is disabled
automatically when the system is set to **reduce motion**.

## Privacy

- The camera only turns on while you are scanning, and turns off when you
  press Stop or switch away from the tab.
- No video, image, or scan leaves your computer. History lives in your
  browser's local storage and you can clear it anytime.
