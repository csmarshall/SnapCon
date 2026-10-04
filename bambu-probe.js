#!/usr/bin/env node
// bambu-probe.js — a read-only survey of one Bambu Lab printer, for designing
// a SnapCon connector against evidence instead of documentation.
//
// WHAT THIS IS FOR. SnapCon has no Bambu Lab support yet. Every published
// description of the local protocol is community reverse-engineering, and the
// fields differ between models and firmware versions. Rather than write a
// connector from documents and hope, this asks one real printer what it
// actually says, and writes the answers to bambu-report.json.
//
// SAFETY, in short:
//   - Everything it does by default is READ-ONLY. It connects, listens, and
//     lists directories. It does not move the printer.
//   - The two steps that change anything (writing a test file, and starting a
//     print) are each refused unless you type "yes" at a prompt, and the exact
//     command is printed before it is sent.
//   - The report REDACTS your access code, serial number, IP, MAC, WiFi name
//     and anything credential-shaped, while keeping the SHAPE of the data
//     (types and lengths) so it is still useful. It is meant to be safe to
//     send to someone else.
//   - It never converts or generates a .3mf. If you ask it to test printing,
//     it prints a file you already have.
//
// Node 22 built-ins only. No installation, no dependencies.
//
// Usage:
//   node bambu-probe.js <printer-ip> <access-code> <serial>
//
// Protocol references consulted (none copied): OpenBambuAPI (Doridian),
// joeltelling/print-farm-manager for the control payloads, and the Bambu
// connector proposed in SnapCon PR #9 for the transport-injection shape.
"use strict";

const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { EventEmitter } = require("node:events");

const VERSION = "1.1.0";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , RAW_IP, RAW_ACCESS_CODE, RAW_SERIAL, ...rest] = process.argv;
// Bambu serials are upper-case letters and digits, and MQTT topic names are
// case-sensitive: a serial typed in lower case connects and subscribes without
// complaint and then receives nothing at all. Found on the first real run.
const IP = RAW_IP && RAW_IP.trim();
const ACCESS_CODE = RAW_ACCESS_CODE && RAW_ACCESS_CODE.trim();
const SERIAL = RAW_SERIAL && RAW_SERIAL.trim().toUpperCase();
if (!IP || !ACCESS_CODE || !SERIAL) {
  console.error(`
bambu-probe ${VERSION} — surveys one Bambu Lab printer and writes bambu-report.json

  node bambu-probe.js <printer-ip> <access-code> <serial>

All three are on the printer's own screen:
  Settings -> Network        : IP address and Access Code
  Settings -> Device / About : Serial number

The printer must have LAN Only Mode AND Developer Mode switched on
(Developer Mode only appears after LAN Only Mode is enabled).

Optional, and each one asks before it does anything:
  --write-test      write a tiny text file over FTPS, then delete it
  --print <file>    start a SLICED .gcode.3mf already on your computer, then cancel it
  --ams-map <list>  with --print: which AMS tray feeds each filament in the file,
                    in file order. Trays are numbered 0-3 on the first AMS.
                    e.g. --ams-map 0      one filament, from tray 0
                         --ams-map 0,1    filament 1 from tray 0, filament 2 from tray 1
                    Without it the print uses the EXTERNAL spool.
`);
  process.exit(2);
}

const argAfter = (flag) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : null; };
const OPT = {
  writeTest: rest.includes("--write-test"),
  printFile: argAfter("--print"),
  amsMap: null,
};
// Validated here, before anything touches the printer, so a typo cannot turn
// into a half-run print test. -1 is accepted because the published protocol
// notes use it for "this filament slot is unused".
{
  const raw = argAfter("--ams-map");
  if (rest.includes("--ams-map")) {
    const parts = String(raw || "").split(",").map(s => s.trim());
    const nums = parts.map(Number);
    if (!raw || parts.some(p => !/^-?\d+$/.test(p)) || nums.some(n => n < -1 || n > 15)) {
      console.error(`--ams-map needs a comma-separated list of tray numbers from 0 to 15, e.g. "--ams-map 0" or "--ams-map 0,1" (got: ${raw || "nothing"})`);
      process.exit(2);
    }
    OPT.amsMap = nums;
  }
}

// ---------------------------------------------------------------------------
// Report + redaction
// ---------------------------------------------------------------------------

// The report is meant to be shareable. The access code is a password, and the
// serial appears in MQTT topics and in the TLS certificate's common name, so
// both are replaced everywhere they occur - including inside strings that
// merely contain them.
//
// Values are replaced with a descriptor rather than deleted: "<redacted
// string(20)>" still tells whoever designs the connector that the field is a
// 20-character string, which is the part that matters for writing a parser.
const SECRETS = [
  [ACCESS_CODE, "ACCESS_CODE"],
  [SERIAL, "SERIAL"],
  [IP, "PRINTER_IP"],
].filter(([v]) => v && String(v).length >= 3);

const SENSITIVE_KEY = /(serial|^sn$|_sn$|access.?code|passw|secret|token|auth|credential|^key$|_key$|mac|ssid|wifi|^ip$|_ip$|ipaddr|url|uid|user|owner|account|project_id|task_id|subtask_id|profile_id|job_id|region|cert)/i;
// Keys this probe writes itself whose values are never secret, but whose names
// happen to match the pattern above. 1.0.0 redacted its own serialLength and
// FTP reply codes, throwing away exactly the facts needed to diagnose a run.
const SAFE_KEY = new Set(["serialLength", "serialGiven", "accessCodeGiven", "serialMatchesCert",
  "authorized", "authorizationError", "userCode"]);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Case-insensitive: the printer's serial and the one typed in can differ only
// in case, and 1.0.0's exact match let the real one through.
function redactString(s) {
  let out = String(s);
  for (const [val, label] of SECRETS) {
    if (!val) continue;
    out = out.replace(new RegExp(escapeRe(val), "gi"), `<${label}>`);
  }
  return out;
}

function describe(v) {
  if (v === null) return "<redacted null>";
  if (typeof v === "number") return `<redacted number(${String(v).length} digits)>`;
  if (typeof v === "boolean") return "<redacted boolean>";
  if (Array.isArray(v)) return `<redacted array(${v.length})>`;
  if (typeof v === "object") return `<redacted object(${Object.keys(v).length} keys)>`;
  return `<redacted string(${String(v).length})>`;
}

function redact(value, key = "") {
  if (value === null || value === undefined) return value;
  // Already redacted. The whole report is passed through this a second time as a
  // final safety net, and re-redacting would relabel a number as a 28-character
  // string - throwing away exactly the type information the report exists for.
  if (typeof value === "string" && /^<redacted /.test(value)) return value;
  if (Array.isArray(value)) return value.map(v => redact(v, key));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  if (key && SENSITIVE_KEY.test(key) && !SAFE_KEY.has(key)) return describe(value);
  if (typeof value === "string") return redactString(value);
  return value;
}

const report = {
  probeVersion: VERSION,
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  // Filled in as we go. Every section records what was attempted even when it
  // failed, because "this port refused the connection" is itself a finding.
  input: { ipGiven: true, accessCodeGiven: true, serialGiven: true, serialLength: SERIAL.length },
  reachability: {},
  tls: {},
  mqtt: { attempted: false },
  ftps: { attempted: false },
  camera: {},
  stateChanging: { writeTest: { attempted: false }, printTest: { attempted: false } },
  findings: [],
  errors: [],
};

const note = (msg) => { report.findings.push(msg); console.log("    · " + msg); };
const fail = (where, e) => {
  const entry = { where, error: redactString(e && e.message || String(e)), code: e && e.code };
  report.errors.push(entry);
  console.log(`    ! ${where}: ${entry.error}${e && e.code ? " [" + e.code + "]" : ""}`);
  return entry;
};

// A human explanation for the error codes that actually come up here, so a
// tester can tell "wrong code" from "wrong mode" from "wrong network" without
// knowing anything about the protocols.
function explain(code, port) {
  switch (code) {
    case "ECONNREFUSED":
      return `nothing is listening on port ${port}. On a Bambu printer this normally means LAN Only Mode (and Developer Mode) are not switched on, or this model does not offer that service.`;
    case "ETIMEDOUT":
    case "TIMEOUT":
      return `no answer at all on port ${port}. Usually a firewall, or the printer being on a different network/VLAN from this computer.`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "the printer's address is not reachable from this computer at all - check the IP.";
    case "ECONNRESET":
      return `the printer accepted the connection on port ${port} and then closed it immediately. That is usually a rejected credential or a service that is not really enabled.`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Console helpers
// ---------------------------------------------------------------------------

const line = (s = "") => console.log(s);
const head = (s) => { line(); line("=".repeat(72)); line("  " + s); line("=".repeat(72)); };
const step = (s) => line("\n-- " + s);

const rl = () => readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
  return new Promise(res => {
    const i = rl();
    i.question(question, a => { i.close(); res(String(a || "").trim()); });
  });
}
// Deliberately requires the whole word. A state-changing step on someone
// else's printer should not happen because a key was leaned on.
async function confirm(what, detail) {
  line();
  line("  " + "!".repeat(68));
  line("  ABOUT TO CHANGE SOMETHING ON THE PRINTER");
  line("  " + what);
  if (detail) detail.split("\n").forEach(d => line("      " + d));
  line("  " + "!".repeat(68));
  const a = await ask('  Type "yes" to allow this, anything else to skip: ');
  const ok = a.toLowerCase() === "yes";
  line(ok ? "  -> allowed" : "  -> skipped");
  return ok;
}

// ---------------------------------------------------------------------------
// 1. Reachability
// ---------------------------------------------------------------------------

const PORTS = [
  { port: 8883, what: "MQTT over TLS - status and control" },
  { port: 990, what: "FTPS (implicit TLS) - file transfer" },
  { port: 322, what: "RTSP over TLS - camera on newer models" },
  { port: 6000, what: "LAN Liveview - camera on X1 series" },
  { port: 1990, what: "SSDP discovery reply port" },
  { port: 80, what: "HTTP (not expected to be open)" },
];

function tcpCheck(host, port, ms = 4000) {
  return new Promise(res => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const done = (open, code) => { try { s.destroy(); } catch {} res({ port, open, ms: Date.now() - t0, code }); };
    s.setTimeout(ms);
    s.on("connect", () => done(true, null));
    s.on("timeout", () => done(false, "TIMEOUT"));
    s.on("error", e => done(false, e.code || "ERROR"));
  });
}

async function checkReachability() {
  head("1. Which services is the printer offering?");
  line("  Read-only. This only asks whether each port accepts a connection.");
  for (const { port, what } of PORTS) {
    const r = await tcpCheck(IP, port);
    report.reachability[port] = { open: r.open, ms: r.ms, code: r.code, what };
    line(`  ${String(port).padEnd(6)} ${(r.open ? "OPEN" : "closed").padEnd(8)} ${String(r.ms + "ms").padEnd(8)} ${what}`);
    if (!r.open && (port === 8883 || port === 990)) {
      const why = explain(r.code, port);
      if (why) note(`port ${port} unavailable - ${why}`);
    }
  }
  if (!report.reachability[8883].open) {
    note("MQTT is the printer's main interface. With 8883 closed nothing else here will work, and LAN Only + Developer Mode is the first thing to check on the printer's screen.");
  }
}

// ---------------------------------------------------------------------------
// 2. TLS identity
// ---------------------------------------------------------------------------

// Bambu printers present a self-signed certificate whose common name is the
// serial number. Whether that holds across models decides how a connector can
// verify the printer is the one it thinks it is, so the SHAPE is recorded even
// though the values are redacted.
function tlsInfo(host, port, ms = 8000) {
  return new Promise(res => {
    const s = tls.connect({ host, port, rejectUnauthorized: false, timeout: ms, servername: undefined }, () => {
      let cert = null;
      try { cert = s.getPeerCertificate(false); } catch {}
      const out = {
        handshake: true,
        protocol: s.getProtocol(),
        cipher: (s.getCipher() || {}).name,
        authorized: s.authorized,
        authorizationError: s.authorizationError ? String(s.authorizationError) : null,
        cert: cert ? {
          subjectCN: cert.subject && cert.subject.CN ? describeSubjectCN(cert.subject.CN) : null,
          issuerCN: cert.issuer && cert.issuer.CN ? describeCN(cert.issuer.CN) : null,
          selfSigned: !!(cert.subject && cert.issuer && cert.subject.CN === cert.issuer.CN),
          validFrom: cert.valid_from || null,
          validTo: cert.valid_to || null,
          hasSubjectAltName: !!cert.subjectaltname,
          keyBits: cert.bits || null,
        } : null,
      };
      try { s.destroy(); } catch {}
      res(out);
    });
    s.on("timeout", () => { try { s.destroy(); } catch {} res({ handshake: false, code: "TIMEOUT" }); });
    s.on("error", e => res({ handshake: false, code: e.code || "ERROR", error: redactString(e.message) }));
  });
}
// The printer's own serial, as its certificate states it. Kept only in memory.
let CERT_CN = null;

// The SUBJECT name is the printer's serial on every Bambu seen so far, so it is
// never printed. 1.0.0 printed it whenever it did not match the typed serial -
// which is exactly when it is most likely to be the real one - and its leak
// check, looking only for the typed value, then reported the file as clean.
function describeSubjectCN(cn) {
  const s = String(cn);
  if (!CERT_CN) CERT_CN = s;
  if (s.toUpperCase() === SERIAL) return "<equals the serial number>";
  if (s.length >= 3 && !SECRETS.some(([v]) => String(v).toUpperCase() === s.toUpperCase())) SECRETS.push([s, "CERT_SERIAL"]);
  if (s.toUpperCase().includes(SERIAL)) return "<contains the serial number>";
  return `<does NOT match the serial you entered: string(${s.length})>`;
}
// Issuer names are Bambu's fixed CA labels ("BBL Device CA N7-V2"), which say
// which model family signed the certificate - kept, unless they contain a secret.
function describeCN(cn) {
  const s = String(cn);
  if (SERIAL && s === SERIAL) return "<equals the serial number>";
  if (SERIAL && s.includes(SERIAL)) return "<contains the serial number>";
  return redactString(s).slice(0, 40);
}

async function checkTls() {
  head("2. How does the printer identify itself?");
  line("  Read-only. Opens a TLS connection and looks at the certificate.");
  for (const port of [8883, 990]) {
    if (!report.reachability[port] || !report.reachability[port].open) { line(`  ${port}: skipped (port closed)`); continue; }
    const info = await tlsInfo(IP, port);
    report.tls[port] = info;
    if (info.handshake) {
      line(`  ${port}: ${info.protocol}, ${info.cipher}`);
      if (info.cert) {
        line(`        certificate CN: ${info.cert.subjectCN}`);
        line(`        self-signed: ${info.cert.selfSigned}   valid to: ${info.cert.validTo}`);
        if (info.cert.subjectCN === "<equals the serial number>") {
          note(`port ${port} certificate common name is exactly the serial number - a connector can pin on that`);
        }
        if (!info.cert.hasSubjectAltName) {
          note(`port ${port} certificate has no subjectAltName, so normal hostname verification cannot be used as-is`);
        }
      }
    } else {
      fail(`tls:${port}`, { message: info.error || "handshake failed", code: info.code });
    }
  }
  if (CERT_CN) {
    report.input.serialMatchesCert = CERT_CN.toUpperCase() === SERIAL;
    if (!report.input.serialMatchesCert) {
      note("THE SERIAL YOU ENTERED DOES NOT MATCH the printer's certificate. Status messages are addressed by serial, so please re-check it on the printer's screen. This run will also listen on the certificate's serial so it is not wasted.");
    }
  }
}

// ---------------------------------------------------------------------------
// 3. MQTT — the important one
// ---------------------------------------------------------------------------

// The smallest MQTT 3.1.1 client this survey needs: CONNECT with credentials,
// SUBSCRIBE to one topic, PUBLISH one request, read PUBLISH packets back.
// Written here rather than pulled from npm so the script stays a single file
// with nothing to install.
const MQTT = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };

const CONNACK_REASON = {
  0: "accepted",
  1: "refused - the printer does not accept this MQTT protocol version",
  2: "refused - client identifier rejected",
  3: "refused - service unavailable",
  4: "refused - BAD USERNAME OR PASSWORD. The access code is almost certainly wrong; re-read it from the printer's screen.",
  5: "refused - NOT AUTHORISED. Often means Developer Mode is off, even though LAN Only Mode is on.",
};

function encLen(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
function encStr(s) {
  const b = Buffer.from(String(s), "utf8");
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
}
function packet(type, flags, payload) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encLen(payload.length), payload]);
}

class MiniMqtt extends EventEmitter {
  constructor(socket) {
    super();
    this.sock = socket;
    this.buf = Buffer.alloc(0);
    this.sock.on("data", d => { this.buf = Buffer.concat([this.buf, d]); this._drain(); });
    this.sock.on("error", e => this.emit("error", e));
    this.sock.on("close", () => this.emit("close"));
  }
  _drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      let mult = 1, len = 0, i = 1, byte;
      do {
        if (i >= this.buf.length) return;           // length not fully arrived
        byte = this.buf[i++];
        len += (byte & 127) * mult;
        mult *= 128;
        if (mult > 128 ** 4) { this.emit("error", new Error("malformed MQTT length")); return; }
      } while (byte & 0x80);
      if (this.buf.length < i + len) return;        // body not fully arrived
      const type = this.buf[0] >> 4;
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.subarray(i + len);
      this.emit("packet", type, body);
    }
  }
  connect(username, password, clientId) {
    const flags = 0x02 | 0x80 | 0x40;               // clean session + username + password
    const vh = Buffer.concat([encStr("MQTT"), Buffer.from([4, flags, 0x00, 0x3c])]);
    const pl = Buffer.concat([encStr(clientId), encStr(username), encStr(password)]);
    this.sock.write(packet(MQTT.CONNECT, 0, Buffer.concat([vh, pl])));
  }
  subscribe(topic, id = 1) {
    const pl = Buffer.concat([Buffer.from([id >> 8, id & 0xff]), encStr(topic), Buffer.from([0])]);
    this.sock.write(packet(MQTT.SUBSCRIBE, 2, pl));
  }
  publish(topic, payload) {
    this.sock.write(packet(MQTT.PUBLISH, 0, Buffer.concat([encStr(topic), Buffer.from(payload, "utf8")])));
  }
  ping() { this.sock.write(packet(MQTT.PINGREQ, 0, Buffer.alloc(0))); }
  disconnect() { try { this.sock.write(packet(MQTT.DISCONNECT, 0, Buffer.alloc(0))); this.sock.end(); } catch {} }
}

function parsePublish(body) {
  const tlen = body.readUInt16BE(0);
  const topic = body.subarray(2, 2 + tlen).toString("utf8");
  const payload = body.subarray(2 + tlen).toString("utf8");
  return { topic, payload };
}

// Flattens the status object to "a.b.c" -> type, so two reports from different
// models can be diffed to see exactly which fields each one has. This is the
// part that makes the survey useful across the Bambu range.
function inventory(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + "." + k : k;
    if (v === null) { out[key] = "null"; continue; }
    if (Array.isArray(v)) {
      out[key] = `array(${v.length})`;
      if (v.length && typeof v[0] === "object" && v[0] !== null) inventory(v[0], key + "[]", out);
      continue;
    }
    if (typeof v === "object") { out[key] = "object"; inventory(v, key, out); continue; }
    out[key] = typeof v;
  }
  return out;
}

// The serial the printer actually answered on. The print test uses it.
let ACTIVE_SERIAL = null;

function mqttSurvey({ listenMs = 20000 } = {}) {
  return new Promise(resolve => {
    const res = { attempted: true, connected: false, reports: 0, topics: [], byTopic: {} };
    const started = Date.now();
    let merged = {}, firstFull = null, sawPushall = false;

    // Listen on the typed serial and, when it differs, on the certificate's as
    // well. Which one carries data is recorded, so a mistyped serial still
    // produces a useful run AND the report shows whether CN == serial here.
    const serials = [SERIAL];
    if (CERT_CN && CERT_CN.toUpperCase() !== SERIAL) serials.push(CERT_CN);
    const labelOf = (s) => (s === SERIAL ? "enteredSerial" : "certificateSerial");
    let subacks = 0;

    const sock = tls.connect({ host: IP, port: 8883, rejectUnauthorized: false, timeout: 10000 });
    const client = new MiniMqtt(sock);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { client.disconnect(); } catch {}
      res.listenedMs = Date.now() - started;
      resolve(res);
    };
    const timer = setTimeout(finish, listenMs + 12000);

    sock.on("timeout", () => { res.error = "TLS timeout"; finish(); });
    client.on("error", e => { res.error = redactString(e.message); res.code = e.code; finish(); });

    sock.on("secureConnect", () => {
      // tls.connect's timeout is an IDLE timeout for the socket's whole life,
      // not a connect timeout. Left in place it cut 1.0.0's 20 s listen short
      // after 10 s of quiet. The connect phase is covered; now switch it off.
      sock.setTimeout(0);
      line("    TLS up, sending MQTT CONNECT as user 'bblp' ...");
      client.connect("bblp", ACCESS_CODE, "snapcon-probe-" + Math.random().toString(16).slice(2, 8));
    });

    client.on("packet", (type, body) => {
      if (type === MQTT.CONNACK) {
        const code = body[1];
        res.connackCode = code;
        res.connackMeaning = CONNACK_REASON[code] || `unknown code ${code}`;
        if (code !== 0) { line("    CONNECT refused: " + res.connackMeaning); finish(); return; }
        res.connected = true;
        serials.forEach((s, i) => {
          line(`    connected. subscribing to device/<${labelOf(s)}>/report ...`);
          client.subscribe(`device/${s}/report`, i + 1);
        });
        return;
      }
      if (type === MQTT.SUBACK) {
        const s = serials[body.readUInt16BE(0) - 1];
        const granted = body[2] !== 0x80;
        if (s) {
          res.byTopic[labelOf(s)] = { subscribed: granted, reports: 0 };
          line(granted ? `    subscribed (${labelOf(s)}). asking for a full status (pushall) ...` : `    SUBSCRIBE (${labelOf(s)}) was refused by the printer`);
          // A Bambu printer pushes changes continuously but only sends the whole
          // picture when asked. Requesting it is the one write on this path, and
          // it changes nothing on the machine - it is a read.
          if (granted) client.publish(`device/${s}/request`, JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }));
        }
        if (++subacks < serials.length) return;
        res.subscribed = Object.values(res.byTopic).some(t => t.subscribed);
        if (!res.subscribed) { finish(); return; }
        setTimeout(finish, listenMs);
        return;
      }
      if (type === MQTT.PUBLISH) {
        const { topic, payload } = parsePublish(body);
        res.reports++;
        const from = serials.find(s => topic === `device/${s}/report`);
        if (from) {
          if (res.byTopic[labelOf(from)]) res.byTopic[labelOf(from)].reports++;
          if (!ACTIVE_SERIAL) ACTIVE_SERIAL = from;
        }
        // 1.0.0 compared the raw topic against already-redacted entries, so
        // every message added a duplicate.
        const shown = redactString(topic);
        if (!res.topics.includes(shown)) res.topics.push(shown);
        let j = null;
        try { j = JSON.parse(payload); } catch { return; }
        const body0 = j.print || j;
        // The biggest single payload is the closest thing to "everything this
        // model reports", which is what the connector has to be written against.
        if (!firstFull || Object.keys(body0).length > Object.keys(firstFull).length) {
          firstFull = body0;
          // A full status is recognised by CONTENT, not size. An arbitrary key
          // count called a complete 38-field X1C report "partial" in testing;
          // these fields only ever appear together in a whole report, whereas a
          // trickled update carries one or two changed values.
          const kk = Object.keys(body0);
          if (["gcode_state","nozzle_temper","bed_temper","print_type"].filter(x=>kk.includes(x)).length >= 3) sawPushall = true;
        }
        merged = { ...merged, ...body0 };
        if (res.reports === 1) line("    first status received");
      }
      if (type === MQTT.PINGRESP) { /* keepalive */ }
    });

    const ka = setInterval(() => { try { client.ping(); } catch {} }, 20000);
    const clean = () => { clearInterval(ka); clearTimeout(timer); };
    const origResolve = resolve;
    resolve = (v) => {
      clean();
      v.sawPushall = sawPushall;
      v.fullStatusKeyCount = firstFull ? Object.keys(firstFull).length : 0;
      v.mergedKeyCount = Object.keys(merged).length;
      v.fieldInventory = firstFull ? inventory(firstFull) : {};
      v.statusSample = firstFull ? redact(firstFull) : null;
      v.mergedSample = Object.keys(merged).length ? redact(merged) : null;
      origResolve(v);
    };
  });
}

async function checkMqtt() {
  head("3. What does the printer report about itself? (MQTT)");
  line("  Read-only. Connects, listens for status, and asks for one full update.");
  if (!report.reachability[8883] || !report.reachability[8883].open) {
    line("  skipped - port 8883 is not open");
    report.mqtt = { attempted: false, skipped: "port closed" };
    return;
  }
  line("  Listening for 20 seconds ...");
  const r = await mqttSurvey({ listenMs: 20000 });
  report.mqtt = r;

  if (!r.connected) {
    fail("mqtt", { message: r.connackMeaning || r.error || "did not connect", code: r.code });
    if (r.connackCode === 4) note("ACCESS CODE LOOKS WRONG - the printer rejected the password.");
    if (r.connackCode === 5) note("NOT AUTHORISED - check Developer Mode is on, not just LAN Only Mode.");
    return;
  }
  line(`    received ${r.reports} status messages`);
  for (const [label, t] of Object.entries(r.byTopic || {})) line(`      on ${label}: ${t.reports}`);
  const bt = r.byTopic || {};
  if (bt.certificateSerial && bt.certificateSerial.reports > 0 && !(bt.enteredSerial && bt.enteredSerial.reports > 0)) {
    note("status arrived ONLY on the certificate's serial - the serial entered was wrong, and the certificate name is the serial MQTT uses");
  }
  line(`    largest single payload: ${r.fullStatusKeyCount} top-level fields`);
  line(`    merged across all messages: ${r.mergedKeyCount} fields`);
  if (r.sawPushall) note("a complete status report was received on request - a connector can ask for one rather than waiting for changes to trickle in");
  else note("no complete status arrived in the listening window - a connector may have to build state from partial updates alone");
  const inv = r.fieldInventory || {};
  const keys = Object.keys(inv);
  line(`    recorded ${keys.length} field paths for cross-model comparison`);
  for (const probe of ["gcode_state", "mc_percent", "mc_remaining_time", "nozzle_temper", "bed_temper",
                       "ams", "nozzle_diameter", "print_type", "subtask_name", "layer_num", "total_layer_num",
                       "ipcam", "home_flag", "hw_switch_state", "chamber_temper"]) {
    if (keys.some(k => k === probe || k.startsWith(probe + "."))) line(`      present: ${probe}`);
  }
  if (keys.some(k => k.startsWith("ams."))) note("this printer reports an AMS - filament mapping will be relevant");
  if (keys.some(k => k.startsWith("ipcam"))) note("this printer reports camera settings over MQTT (ipcam.*) - that is how a connector can tell whether the camera is usable");
}

// ---------------------------------------------------------------------------
// 4. FTPS
// ---------------------------------------------------------------------------

// Implicit FTPS: the control connection is TLS from the first byte (no AUTH
// TLS). The data connection has to resume the control connection's TLS
// session, which is the part most generic FTP clients get wrong against these
// printers.
class Ftps {
  constructor() { this.sock = null; this.buf = ""; this.waiters = []; this.pending = []; }
  _pump() {
    for (;;) {
      const m = /^(\d{3})(?: |-)([\s\S]*?)\r\n/.exec(this.buf);
      if (!m) return;
      // multi-line reply: keep reading until "NNN " terminator
      if (this.buf[3] === "-") {
        const end = new RegExp("^" + m[1] + " [^\\r\\n]*\\r\\n", "m");
        const rest = this.buf.slice(m[0].length);
        const e = end.exec(rest);
        if (!e) return;
        const whole = this.buf.slice(0, m[0].length + rest.indexOf(e[0]) + e[0].length);
        this.buf = this.buf.slice(whole.length);
        this._deliver(Number(m[1]), whole);
        continue;
      }
      this.buf = this.buf.slice(m[0].length);
      this._deliver(Number(m[1]), m[0]);
    }
  }
  // Replies that arrive before anyone is waiting are QUEUED, not dropped. A
  // transfer-complete line routinely lands while the caller is still awaiting
  // the data connection to close; discarding it desynchronises every reply
  // after it and the session simply hangs.
  _deliver(code, text) {
    const msg = { code, text: text.trim() };
    const w = this.waiters.shift();
    if (w) w(msg); else this.pending.push(msg);
  }
  _expect() {
    if (this.pending.length) return Promise.resolve(this.pending.shift());
    return new Promise(res => this.waiters.push(res));
  }
  // Like _expect, but gives up rather than hanging. On timeout the waiter is
  // withdrawn, so a reply that never came cannot swallow the NEXT command's.
  expectWithin(ms = 15000) {
    if (this.pending.length) return Promise.resolve(this.pending.shift());
    return new Promise(res => {
      const w = (msg) => { clearTimeout(t); res(msg); };
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        res({ code: null, text: `no reply within ${ms} ms` });
      }, ms);
      this.waiters.push(w);
    });
  }
  // A STOR's first reply (150) only means "send it". Success is the second
  // (226), and SIZE confirms the printer holds every byte. 1.0.0 recorded the
  // 150 as the result and discarded the rest.
  async finishUpload(first, name, bytesSent, rec) {
    rec.uploadPrelimCode = first.code;
    const final = first.code >= 100 && first.code < 200 ? await this.expectWithin(60000) : first;
    rec.uploadCode = final.code;
    const sz = await this.cmd(`SIZE ${name}`);
    const m = /^213\s+(\d+)/.exec(sz.text || "");
    rec.sizeReplyCode = sz.code;
    rec.sizeSent = bytesSent;
    rec.sizeOnPrinter = m ? Number(m[1]) : null;
    rec.sizeMatches = rec.sizeOnPrinter === bytesSent;
    line(`      upload reply: ${first.code} then ${final.code}; size on printer ${rec.sizeOnPrinter === null ? "unknown (" + sz.code + ")" : rec.sizeOnPrinter} of ${bytesSent} bytes`);
    return rec.uploadCode === 226 || rec.sizeMatches;
  }
  connect(ms = 10000) {
    return new Promise((res, rej) => {
      this.sock = tls.connect({ host: IP, port: 990, rejectUnauthorized: false, timeout: ms }, () => {});
      this.sock.setEncoding("utf8");
      this.sock.on("data", d => { this.buf += d; this._pump(); });
      this.sock.on("timeout", () => { this.sock.destroy(); rej(new Error("FTPS timeout")); });
      this.sock.on("error", rej);
      this._expect().then(r => (r.code === 220 ? res(r) : rej(new Error("unexpected greeting: " + r.text))));
    });
  }
  // echoAs exists so a password is not printed to a shared terminal. The real
  // command still goes on the wire - masking the wrong one of these two is how
  // you end up telling every tester their access code is wrong.
  cmd(c, echoAs) {
    line("      > " + (echoAs || c));
    const p = this._expect();
    this.sock.write(c + "\r\n");
    return p;
  }
  async pasv() {
    const r = await this.cmd("PASV");
    const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(r.text);
    if (!m) throw new Error("could not parse PASV reply");
    return { host: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`, port: (+m[5] << 8) + +m[6] };
  }
  // Data connections resume the control session; without it these printers
  // commonly drop the transfer.
  dataConnect({ host, port }) {
    return tls.connect({ host, port, rejectUnauthorized: false, session: this.sock.getSession() });
  }
  async list(dir) {
    const target = await this.pasv();
    const d = this.dataConnect(target);
    let out = "";
    d.setEncoding("utf8");
    d.on("data", c => { if (out.length < 60000) out += c; });
    const done = new Promise(r => { d.on("close", r); d.on("error", r); });
    const reply = this.cmd(`LIST ${dir}`);
    await done;
    const r = await reply;
    await this._expect().catch(() => {});     // transfer-complete line, if separate
    return { code: r.code, listing: out };
  }
  quit() { try { this.sock.write("QUIT\r\n"); this.sock.end(); } catch {} }
}

function parseListing(text) {
  return text.split(/\r?\n/).filter(Boolean).map(l => {
    // perms links owner group size  MON DD TIME  name  -- the date is three
    // whitespace-separated fields, so a lazy match swallows part of it into
    // the filename.
    const m = /^([-dl])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/.exec(l);
    if (!m) return { raw: redactString(l.slice(0, 120)) };
    return { type: m[1] === "d" ? "dir" : "file", size: Number(m[2]), name: redactString(m[4]) };
  });
}

async function checkFtps() {
  head("4. What files does the printer expose? (FTPS)");
  line("  Read-only. Logs in and lists two directories. Nothing is written.");
  if (!report.reachability[990] || !report.reachability[990].open) {
    line("  skipped - port 990 is not open");
    report.ftps = { attempted: false, skipped: "port closed" };
    return null;
  }
  const f = new Ftps();
  const res = { attempted: true, loggedIn: false, dirs: {} };
  try {
    await f.connect();
    line("      (connected, TLS from the first byte - implicit FTPS)");
    const u = await f.cmd("USER bblp");
    const p = await f.cmd("PASS " + ACCESS_CODE, "PASS <your access code>");
    res.userCode = u.code;
    res.passCode = p.code;
    if (p.code !== 230) {
      res.error = "login refused (" + p.code + ")";
      fail("ftps:login", { message: res.error });
      if (p.code === 530) note("FTPS LOGIN REFUSED - the access code is wrong, or file access is not enabled on this model.");
      f.quit();
      report.ftps = res;
      return null;
    }
    res.loggedIn = true;
    line("      logged in");
    await f.cmd("PBSZ 0"); await f.cmd("PROT P"); await f.cmd("TYPE I");
    let rootAll = null;
    for (const dir of ["/", "/cache", "/timelapse", "/model"]) {
      try {
        const l = await f.list(dir);
        const entries = parseListing(l.listing);
        if (dir === "/") rootAll = entries;
        res.dirs[dir] = { code: l.code, count: entries.length, entries: entries.slice(0, 40) };
        line(`      ${dir.padEnd(11)} ${entries.length} entries`);
      } catch (e) {
        res.dirs[dir] = { error: redactString(e.message) };
        line(`      ${dir.padEnd(11)} not listable (${e.message})`);
      }
    }
    // Counted over the whole listing: 1.0.0 counted only the 40 it kept.
    if (rootAll) {
      const threemf = rootAll.filter(e => /\.3mf$/i.test(e.name || "")).length;
      const gcode = rootAll.filter(e => /\.gcode$/i.test(e.name || "")).length;
      note(`root contains ${threemf} .3mf and ${gcode} .gcode files - this is where uploads land`);
    }
  } catch (e) {
    res.error = redactString(e.message);
    fail("ftps", e);
  }
  report.ftps = res;
  return f;
}

// ---------------------------------------------------------------------------
// 5. Camera
// ---------------------------------------------------------------------------

async function checkCamera() {
  head("5. Is a camera reachable, and how?");
  line("  Read-only. Opens a connection and reads the first reply. No video is recorded.");
  const cam = {};
  // Newer models: RTSP over TLS on 322.
  if (report.reachability[322] && report.reachability[322].open) {
    cam.rtsp = await new Promise(res => {
      const s = tls.connect({ host: IP, port: 322, rejectUnauthorized: false, timeout: 6000 }, () => {
        s.write(`OPTIONS rtsps://${IP}:322/streaming/live/1 RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: bambu-probe\r\n\r\n`);
      });
      let got = "";
      s.setEncoding("utf8");
      s.on("data", d => { got += d; if (got.includes("\r\n\r\n")) { s.destroy(); res({ ok: true, reply: redactString(got.slice(0, 300)) }); } });
      s.on("timeout", () => { s.destroy(); res({ ok: false, code: "TIMEOUT" }); });
      s.on("error", e => res({ ok: false, code: e.code, error: redactString(e.message) }));
    });
    line(`  RTSP/322: ${cam.rtsp.ok ? "answered" : "no answer (" + (cam.rtsp.code || "?") + ")"}`);
    if (cam.rtsp.ok) note("camera is RTSP over TLS on port 322");
  }
  // X1 series: a TLS socket on 6000 expecting a binary auth frame. We only
  // check that TLS completes - no credential is sent.
  if (report.reachability[6000] && report.reachability[6000].open) {
    cam.liveview = await tlsInfo(IP, 6000, 6000);
    line(`  LiveView/6000: ${cam.liveview.handshake ? "TLS handshake OK" : "no TLS (" + (cam.liveview.code || "?") + ")"}`);
    if (cam.liveview.handshake) note("camera is the X1-style LAN Liveview socket on port 6000");
  }
  if (!cam.rtsp && !cam.liveview) {
    line("  no camera port is open");
    note("no camera port open - either this model has no camera, or LAN Only Liveview is switched off on the printer");
  }
  // MQTT usually says whether the camera is enabled, which is more reliable
  // than a port check.
  const inv = (report.mqtt && report.mqtt.fieldInventory) || {};
  cam.mqttIpcamFields = Object.keys(inv).filter(k => k.startsWith("ipcam"));
  if (cam.mqttIpcamFields.length) line(`  MQTT reports ipcam fields: ${cam.mqttIpcamFields.join(", ")}`);
  report.camera = cam;
}

// ---------------------------------------------------------------------------
// 6. Optional: write a test file
// ---------------------------------------------------------------------------

async function maybeWriteTest() {
  head("6. OPTIONAL - write a small test file, then delete it");
  line("  This is the first step that changes anything. It writes one tiny text");
  line("  file to the printer's storage and then deletes it again. It does NOT");
  line("  touch any of your existing files and does not print anything.");
  const rec = report.stateChanging.writeTest;
  if (!report.ftps || !report.ftps.loggedIn) { line("  skipped - FTPS did not log in"); rec.skipped = "no ftps"; return; }

  const name = "snapcon-probe-test.txt";
  const ok = await confirm(
    "Write a file over FTPS and then delete it.",
    `file name : ${name}\nsize      : 64 bytes of plain text\nlocation  : the printer's storage root\nafterwards: the same file is deleted`);
  rec.attempted = ok;
  if (!ok) return;

  const f = new Ftps();
  try {
    await f.connect();
    await f.cmd("USER bblp"); await f.cmd("PASS " + ACCESS_CODE, "PASS <your access code>");
    await f.cmd("PBSZ 0"); await f.cmd("PROT P"); await f.cmd("TYPE I");
    const target = await f.pasv();
    const d = f.dataConnect(target);
    const payload = Buffer.from("SnapCon probe test file - safe to delete. " + new Date().toISOString() + "\n");
    const closed = new Promise(r => { d.on("close", r); d.on("error", r); });
    const reply = f.cmd(`STOR ${name}`);
    d.on("secureConnect", () => { d.end(payload); });
    await closed;
    await f.finishUpload(await reply, name, payload.length, rec);
    const r2 = await f.cmd(`DELE ${name}`);
    rec.deleteCode = r2.code;
    rec.cleanedUp = r2.code === 250;
    line(`      delete reply: ${r2.code}${rec.cleanedUp ? " (removed)" : " (NOT removed - please delete it from the printer)"}`);
    if (!rec.cleanedUp) note(`test file "${name}" could not be deleted automatically - remove it from the printer's storage`);
    f.quit();
  } catch (e) {
    rec.error = redactString(e.message);
    fail("writeTest", e);
    try { f.quit(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 7. Optional: start and cancel a print
// ---------------------------------------------------------------------------

async function maybePrintTest() {
  head("7. OPTIONAL - start a .3mf you supply, then cancel it");
  const rec = report.stateChanging.printTest;
  if (!OPT.printFile) {
    line("  not requested. To include it, re-run with:  --print <path-to-your-file.gcode.3mf> [--ams-map 0]");
    line("  (this is the only way to confirm how a print is actually started)");
    rec.skipped = "not requested";
    return;
  }
  const file = path.resolve(OPT.printFile);
  if (!fs.existsSync(file)) { line("  file not found: " + file); rec.skipped = "file missing"; return; }
  if (!/\.3mf$/i.test(file)) {
    line("  that is not a .3mf file.");
    line("  Bambu printers only start .3mf projects - a plain .gcode will not work,");
    line("  and this script will not try to convert one. Export a .3mf from Bambu");
    line("  Studio or Orca Slicer and pass that instead.");
    rec.skipped = "not a .3mf";
    return;
  }
  if (!report.mqtt || !report.mqtt.connected) { line("  skipped - MQTT is not connected"); rec.skipped = "no mqtt"; return; }

  const serial = ACTIVE_SERIAL || SERIAL;
  const useAms = !!OPT.amsMap;
  const amsMapping = OPT.amsMap || [];
  rec.amsMapRequested = OPT.amsMap;
  const base = path.basename(file);
  const bytes = fs.statSync(file).size;
  line("\n  THE PRINTER WILL START MOVING if you allow this.");
  line("  The script sends a cancel about 20 seconds later, but a print that has");
  line("  begun may still heat up, home, and extrude a little before it stops.");
  line("  Only continue if the build plate is CLEAR and you are standing at the machine.");
  if (!useAms) {
    line("\n  No --ams-map given, so the printer will be told to use the EXTERNAL spool.");
    line("  If nothing is loaded there it will most likely stop with a filament error.");
  }
  const ok = await confirm(
    "Upload a .3mf and start printing it, then cancel after ~20 seconds.",
    `file        : ${base}\nsize        : ${bytes} bytes\nuploaded to : the printer's storage root\nfilament    : ${useAms ? "AMS trays " + JSON.stringify(amsMapping) + " (one per filament in the file, in order)" : "the external spool"}\nstarted with: MQTT command "project_file" on device/<SERIAL>/request\ncancelled by: MQTT command "stop" about 20 seconds later`);
  rec.attempted = ok;
  if (!ok) return;

  // Upload
  const f = new Ftps();
  try {
    await f.connect();
    await f.cmd("USER bblp"); await f.cmd("PASS " + ACCESS_CODE, "PASS <your access code>");
    await f.cmd("PBSZ 0"); await f.cmd("PROT P"); await f.cmd("TYPE I");
    const target = await f.pasv();
    const d = f.dataConnect(target);
    const closed = new Promise(r => { d.on("close", r); d.on("error", r); });
    const reply = f.cmd(`STOR ${base}`);
    d.on("secureConnect", () => fs.createReadStream(file).pipe(d));
    await closed;
    const complete = await f.finishUpload(await reply, base, bytes, rec);
    f.quit();
    // Starting a print from a truncated file is the one outcome worth refusing.
    if (!complete) { line("  the upload did not complete, so NOT starting a print"); rec.skipped = "upload incomplete"; return; }
  } catch (e) { rec.uploadError = redactString(e.message); fail("printTest:upload", e); try { f.quit(); } catch {} return; }

  // Start, watch, cancel.
  //
  // Everything the printer says is recorded, not only messages carrying a print
  // state: a refused start comes back as {command:"project_file", result:"fail",
  // reason:...} with no state at all, and 1.0.0 dropped exactly that. Our two
  // commands carry distinct sequence_ids so their replies can be told apart
  // from other clients' - the report topic carries those too.
  const START_SEQ = "20001", STOP_SEQ = "20002";
  const FIELDS = ["command", "result", "reason", "sequence_id", "gcode_state", "mc_percent", "mc_remaining_time",
    "mc_print_stage", "mc_print_sub_stage", "stg_cur", "print_error", "mc_print_error_code", "layer_num",
    "total_layer_num", "print_type", "subtask_name", "gcode_file", "hms"];
  await new Promise(resolve => {
    const t0 = Date.now();
    const events = [];
    let lastKey = null, phase = "before start", startSent = false, stopSent = false, done = false;
    const sock = tls.connect({ host: IP, port: 8883, rejectUnauthorized: false, timeout: 10000 });
    const c = new MiniMqtt(sock);
    const request = `device/${serial}/request`;
    const end = (why) => {
      if (done) return;
      done = true;
      if (why) rec.endedBy = why;
      // If the start went out and the cancel did not, the printer is still
      // printing. Say so loudly - this is the one failure a tester must act on.
      if (startSent && !stopSent) {
        rec.cancelNotSent = true;
        line("\n  !!!! THE CANCEL COULD NOT BE SENT (" + (why || "connection lost") + ").");
        line("  !!!! STOP THE PRINT ON THE PRINTER'S SCREEN NOW.");
        note("the cancel could not be sent - the print had to be stopped on the printer");
      }
      try { c.disconnect(); } catch {}
      rec.observed = events;
      rec.statesSeen = events.filter(e => e.gcode_state).map(e => e.phase + ": " + e.gcode_state)
        .filter((s, i, a) => a.indexOf(s) === i);
      rec.startReply = events.find(e => e.command === "project_file" && (e.result || e.reason)) || null;
      rec.stopReply = events.find(e => e.command === "stop" && (e.result || e.reason)) || null;
      resolve();
    };
    const send = (obj, label) => {
      line(`\n      sending ${label}:`);
      line("      " + redactString(JSON.stringify(obj)).slice(0, 400));
      c.publish(request, JSON.stringify(obj));
    };
    const sendStart = () => {
      const start = {
        print: {
          sequence_id: START_SEQ, command: "project_file",
          param: "Metadata/plate_1.gcode",
          subtask_name: base.replace(/\.gcode\.3mf$|\.3mf$/i, ""),
          url: `ftp:///${base}`,
          bed_type: "auto", timelapse: false, bed_leveling: true,
          flow_cali: false, vibration_cali: true, layer_inspect: false,
          use_ams: useAms, ams_mapping: amsMapping,
          profile_id: "0", project_id: "0", subtask_id: "0", task_id: "0",
        }
      };
      rec.startCommandShape = redact(start);
      phase = "after start";
      rec.startSentAtMs = Date.now() - t0;
      startSent = true;
      send(start, "START");
      setTimeout(() => {
        const stop = { print: { sequence_id: STOP_SEQ, command: "stop", param: "" } };
        rec.stopCommandShape = stop;
        phase = "after stop";
        rec.stopSentAtMs = Date.now() - t0;
        send(stop, "CANCEL");
        stopSent = true;
        setTimeout(() => end("finished"), 15000);
      }, 20000);
    };
    sock.on("secureConnect", () => { sock.setTimeout(0); c.connect("bblp", ACCESS_CODE, "snapcon-probe-print"); });
    sock.on("timeout", () => { rec.mqttError = "TLS timeout"; end("TLS timeout"); });
    c.on("error", e => { rec.mqttError = redactString(e.message); end("error: " + rec.mqttError); });
    c.on("close", () => end("connection closed by the printer"));
    c.on("packet", (type, body) => {
      if (type === MQTT.CONNACK) {
        if (body[1] !== 0) { rec.mqttError = "CONNECT refused: " + (CONNACK_REASON[body[1]] || body[1]); end(rec.mqttError); return; }
        c.subscribe(`device/${serial}/report`);
        return;
      }
      if (type === MQTT.SUBACK) {
        // Ask for a full status first, so the report shows the state the start
        // moved the printer FROM, then start once that has had time to arrive.
        send({ pushing: { sequence_id: "20000", command: "pushall" } }, "PUSHALL (baseline)");
        setTimeout(sendStart, 3000);
        return;
      }
      if (type !== MQTT.PUBLISH) return;
      let j;
      try { j = JSON.parse(parsePublish(body).payload); } catch { return; }
      for (const [section, p] of Object.entries(j || {})) {
        if (!p || typeof p !== "object") continue;
        const snap = {};
        for (const k of FIELDS) if (p[k] !== undefined) snap[k] = p[k];
        // A routine push_status with none of the fields above says nothing new.
        if (!Object.keys(snap).length || (Object.keys(snap).length <= 2 && snap.command === "push_status" && snap.sequence_id !== undefined)) continue;
        const key = section + JSON.stringify({ ...snap, sequence_id: undefined }) + phase;
        if (key === lastKey) continue;          // unchanged since last message
        lastKey = key;
        if (events.length < 300) events.push({ ms: Date.now() - t0, phase, section, ...snap });
        if (snap.result || snap.reason) line(`      reply to ${snap.command || section}: ${snap.result || ""} ${snap.reason ? "- " + redactString(snap.reason) : ""}`);
        if (snap.gcode_state) line(`      state: ${snap.gcode_state}${snap.mc_percent !== undefined ? "  " + snap.mc_percent + "%" : ""}${snap.mc_print_stage !== undefined ? "  stage " + snap.mc_print_stage : ""}`);
      }
    });
    setTimeout(() => end("overall time limit"), 90000);
  });
  if (rec.startReply) note(`the printer answered the START with: ${rec.startReply.result || "?"}${rec.startReply.reason ? " - " + redactString(rec.startReply.reason) : ""}`);
  else note("the printer sent no explicit reply to the START command - only state changes (if any) show what it did");
  note("print test completed - check the printer and remove the uploaded file if you do not want it kept");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
  head(`bambu-probe ${VERSION} - surveying a Bambu Lab printer`);
  line("  Everything up to step 6 is read-only. Steps 6 and 7 ask first.");
  line("  Your access code and serial number are NOT written to the report.");

  try {
    await checkReachability();
    await checkTls();
    await checkMqtt();
    const f = await checkFtps();
    if (f) f.quit();
    await checkCamera();
    if (OPT.writeTest) await maybeWriteTest();
    else { head("6. OPTIONAL - write a test file"); line("  not requested. To include it, re-run with:  --write-test"); report.stateChanging.writeTest.skipped = "not requested"; }
    await maybePrintTest();
  } catch (e) {
    fail("probe", e);
  }

  // Final safety pass: whatever ended up in the report, run the whole thing
  // through redaction once more before it touches the disk.
  const safe = redact(report);
  const out = path.resolve("bambu-report.json");
  fs.writeFileSync(out, JSON.stringify(safe, null, 2));

  head("Done");
  line("  Report written to: " + out);
  line();
  line("  Please send that file back. It does NOT contain your access code,");
  line("  serial number, IP address or WiFi details - those are replaced with");
  line("  placeholders, keeping only the shape of the data.");
  line();
  if (report.errors.length) {
    line(`  ${report.errors.length} problem(s) were recorded - that is still useful information.`);
  }
  const leaked = [];
  const text = JSON.stringify(safe).toLowerCase();
  for (const [val, label] of SECRETS) if (val && text.includes(String(val).toLowerCase())) leaked.push(label);
  if (leaked.length) {
    line();
    line("  !! WARNING: the report may still contain: " + leaked.join(", "));
    line("  !! Please tell us before sending it.");
  } else {
    line("  Verified: none of your credentials appear anywhere in the file.");
  }
  process.exit(0);
})();
