const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, clipboard } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const os = require("os");

const PRELOAD = path.join(__dirname, "preload.js");
const INDEX = path.join(__dirname, "index.html");
const TRAY_ICON = path.join(__dirname, "tray.png");

// POS-Desktop sits next to Advanced-Pos-System-BE and Advanced-Pos-System-FE in the repo, so the
// defaults follow the folder rather than one machine's absolute paths.
const REPO = path.join(__dirname, "..");
const BACKEND_PATH = path.join(REPO, "Advanced-Pos-System-BE");
const FRONTEND_PATH = path.join(REPO, "Advanced-Pos-System-FE");

const DEFAULT_CONFIG = {
  mysql: {
    path: "C:\\xampp\\mysql\\bin",
    command: "mysqld.exe --defaults-file=C:\\xampp\\mysql\\bin\\my.ini --standalone"
  },
  backend: {
    path: BACKEND_PATH,
    // Managed by PM2 (ecosystem.config.js); no terminal command is needed.
    command: "pm2 start ecosystem.config.js"
  },
  admin: {
    path: FRONTEND_PATH,
    command: "npm start"
  }
};

// hidden = background process, no console window, like the XAMPP Start button.
// terminal = its own cmd window so you can watch the logs.
// pm2 = managed by PM2 (started/stopped through the pm2 CLI).
const SERVICES = {
  mysql: { name: "MySQL", mode: "hidden", port: 3306 },
  backend: { name: "POS API", mode: "pm2", port: 8000 },
  admin: { name: "POS Frontend", mode: "terminal", port: 8002 }
};

const RUN_ORDER = ["mysql", "backend", "admin"];

// Processes this launcher started, by service key. A terminal service's
// entry is the cmd.exe that owns its window, so Stop can kill that tree
// directly instead of searching the process table; MySQL's is the cmd /c
// that waits on mysqld, so Start knows the moment mysqld quits.
const started = {};
const startedAlive = (key) => !!(started[key] && started[key].exitCode === null && started[key].signalCode === null);

// Start everything / Fix MySQL / single Start buttons never run at the same time.
let startupLock = false;
let mysqlBusy = false;

// Set once this XAMPP's mysqld was started or seen running by the launcher,
// so a Windows shutdown stops it cleanly.
let ownMysqlVerified = false;

let win = null;
let shuttingDown = false;
let closeAnswer = null;
let tray = null;

// "Leave running" hides the window instead of quitting, so the services keep
// their parent alive and the launcher is one click away in the tray.
function ensureTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.setToolTip(" POS Launcher - services are running");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open launcher", click: showWindow },
    { type: "separator" },
    { label: "Stop everything and quit", click: async () => { await stopEverything(); quitNow(); } },
    { label: "Quit, leave services running", click: quitNow }
  ]));
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
  if (tray) { tray.destroy(); tray = null; }
}

function quitNow() {
  shuttingDown = true;
  if (tray) { tray.destroy(); tray = null; }
  if (win && !win.isDestroyed()) win.destroy();
}

// The page draws the close confirmation, so it matches the rest of the app
// instead of being a grey Windows message box.
function askClose(running) {
  return new Promise((resolve) => {
    closeAnswer = resolve;
    win.webContents.send("launcher:confirm-close", running);
  });
}

function configFile() {
  return path.join(app.getPath("userData"), "launcher-config.json");
}

function readConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(configFile(), "utf8"));
    const merged = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      merged[key] = Object.assign({}, DEFAULT_CONFIG[key], saved[key] || {});
    }
    // A saved folder that no longer exists falls back to the repo folder.
    if (!merged.backend.path || !fs.existsSync(merged.backend.path)) merged.backend.path = BACKEND_PATH;
    if (!merged.admin.path || !fs.existsSync(merged.admin.path)) merged.admin.path = FRONTEND_PATH;
    return merged;
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), "utf8");
}

// IPv4 addresses other devices on the Wi-Fi/LAN can reach this PC on.
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|Loopback/i;

function lanAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal || a.address.startsWith("169.254.")) continue;
      found.push({ name, address: a.address });
    }
  }
  return found;
}

function sendLog(line) {
  console.log(line);
  if (win && !win.isDestroyed()) win.webContents.send("launcher:log", line);
}

// The page shows `message`; `error` paints it red, state "READY" green.
function sendStartupProgress(data) {
  if (win && !win.isDestroyed()) win.webContents.send("launcher:startup-progress", data);
}

function sendStatus(data) {
  if (win && !win.isDestroyed()) win.webContents.send("launcher:status", data);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connectOnce(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

// Angular's dev server listens on [::1] only, while mysqld takes both stacks -
// probing 127.0.0.1 alone reports a running Angular app as stopped.
function portOpen(port, timeoutMs = 800) {
  // Never open-and-drop TCP connections on MySQL's port: every such probe is an
  // unauthenticated connection MariaDB has to abort, and after enough of them
  // (the launcher polls every few seconds) mysqld would accept "shutdown" but
  // never exit - so every stop became a kill, and every next start began with
  // crash recovery. Ask Windows whether something is listening instead.
  if (port === 3306) return pidsOnPort(3306).then((pids) => pids.length > 0);
  return Promise.all([
    connectOnce("127.0.0.1", port, timeoutMs),
    connectOnce("::1", port, timeoutMs)
  ]).then((results) => results.some(Boolean));
}

async function waitForPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) return true;
    await wait(500);
  }
  return !(await portOpen(port));
}

// Nothing useful comes back from "cmd /c start", so the running process is
// found by what is listening on the port rather than by a remembered pid.
function pidsOnPort(port) {
  return new Promise((resolve) => {
    // No -p filter: on Windows "-p tcp" is IPv4 only, and it would miss an
    // IPv6-only listener like the Angular dev server on [::1].
    execFile("netstat", ["-ano"], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const pids = new Set();
      for (const line of String(stdout).split("\n")) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && Number(m[1]) === port) pids.add(m[2]);
      }
      resolve([...pids]);
    });
  });
}

// pid -> { ppid, name }, so the console a service sits in can be found.
function processTable() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId),$($_.Name)\" }"],
      { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const table = new Map();
        if (!err) {
          for (const line of String(stdout).split("\n")) {
            const [pid, ppid, name] = line.trim().split(",");
            if (pid) table.set(pid, { ppid, name: (name || "").toLowerCase() });
          }
        }
        resolve(table);
      }
    );
  });
}

// Find the cmd.exe that owns the console window of a terminal service that
// the launcher did not start itself (e.g. an "npm start" window from a
// previous launcher run), so the whole service dies with its terminal.
// An npm script stacks cmd.exe and node.exe several levels deep
// (cmd /k -> node (npm) -> cmd (npm.cmd) -> node (ng serve)), and only the
// innermost node holds the port - so walk up through both and remember the
// outermost cmd.exe seen; that one is the window.
function consoleRootOf(pid, table) {
  let target = String(pid);
  let root = target;
  for (let hop = 0; hop < 8; hop++) {
    const entry = table.get(target);
    if (!entry) break;
    const parent = table.get(entry.ppid);
    // An unknown parent means the tree ends here: the "cmd /c start" that
    // opened the window exits immediately and is long gone by now.
    if (!parent) break;
    if (parent.name !== "cmd.exe" && parent.name !== "node.exe") break;
    target = entry.ppid;
    if (parent.name === "cmd.exe") root = target;
  }
  return root;
}

function run(exe, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout }, (err) => resolve(!err));
  });
}

function runOut(exe, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// mysqld holds the data files, so ask it to shut down before killing it.
async function mysqlShutdown(binPath) {
  const exe = binPath && path.join(binPath, "mysqladmin.exe");
  if (!exe || !fs.existsSync(exe)) return false;
  return run(exe, ["-u", "root", "--protocol=tcp", "-h", "127.0.0.1", "shutdown"], 20000);
}

async function stop(key, entry) {
  const svc = SERVICES[key] || { name: key };
  const { name, port } = svc;

  if (!port) return { ok: false, key, message: `${name}: no port configured, stop it by hand.` };

  // The API under PM2 is stopped through PM2 whether or not it is listening
  // yet (it may still be waiting for MySQL) - otherwise PM2 restarts it.
  if (key === "backend" && (await stopBackendViaPm2(entry && entry.path))) {
    const down = await waitForPortClosed(port, 15000);
    sendStatus({ key, name, running: !down });
    return down
      ? { ok: true, key, message: `${name} stopped (PM2 will not restart it until you press Start).` }
      : { ok: false, key, message: `${name}: PM2 stopped it but port ${port} is still open.` };
  }

  if (!(await portOpen(port))) {
    sendStatus({ key, name, running: false });
    return { ok: true, key, message: `${name} was not running.` };
  }

  if (key === "mysql") {
    // Stop = ask mysqld to shut down. That is all - no kill, no XAMPP panel,
    // no repair. The status dot goes grey by itself once the port closes.
    await mysqlShutdown(entry && entry.path);
    const down = await waitForPortClosed(port, MYSQL_BUTTON_WAIT_MS);
    sendStatus({ key, name, running: !down });
    ownMysqlVerified = false;
    return {
      ok: true,
      key,
      message: down ? `${name} stopped.` : `${name} is shutting down - the dot turns grey when it is done.`
    };
  }

  if (startedAlive(key)) {
    // We opened this window: kill its tree straight away, no process search.
    await run("taskkill", ["/PID", String(started[key].pid), "/T", "/F"]);
  } else {
    // Started by something else (or a previous launcher run): find the
    // listener and the cmd window above it.
    const pids = await pidsOnPort(port);
    const table = pids.length ? await processTable() : new Map();
    for (const pid of pids) {
      // /T takes the whole tree, so the service dies with its terminal window.
      await run("taskkill", ["/PID", consoleRootOf(pid, table), "/T", "/F"]);
    }
  }

  const down = await waitForPortClosed(port, MYSQL_BUTTON_WAIT_MS);
  sendStatus({ key, name, running: !down });
  return down
    ? { ok: true, key, message: `${name} stopped.` }
    : { ok: false, key, message: `${name}: port ${port} is still open - stop it from Task Manager.` };
}

/** Last [ERROR] / Aborting line of data\mysql_error.log, for the error banner. */
function lastMysqlError(binPath) {
  try {
    const log = path.join(binPath, "..", "data", "mysql_error.log");
    if (!fs.existsSync(log)) return "";
    const { size } = fs.statSync(log);
    const start = Math.max(0, size - 65536);
    const fd = fs.openSync(log, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const bad = lines.reverse().find((l) => l.includes("[ERROR]") || l.includes("Aborting"));
    return (bad || "").slice(0, 180);
  } catch {
    return "";
  }
}

async function launchRaw(key, entry, checkExisting = true) {
  const svc = SERVICES[key] || { name: key, mode: "terminal" };
  const { name, mode } = svc;
  const cwd = entry && entry.path;
  let command = entry && entry.command;

  if (!cwd || !command) {
    return { ok: false, key, message: `${name}: folder or command is empty.` };
  }
  // Never run mysqld with --console: on MariaDB 10.4/Windows it then writes
  // nothing to data\mysql_error.log, so a crash would leave no record at all.
  if (key === "mysql") command = command.replace(/\s+--console\b/g, "");
  if (!fs.existsSync(cwd)) {
    return { ok: false, key, message: `${name}: folder not found - ${cwd}` };
  }

  // Prevent duplicate process if already listening on port
  if (checkExisting && svc.port && (await portOpen(svc.port))) {
    sendStatus({ key, name, running: true });
    return { ok: true, key, message: `${name} was already running on port ${svc.port}.`, alreadyRunning: true };
  }

  try {
    // "start /wait" keeps this cmd alive as the parent of the window it
    // opened, so its pid is enough to kill the whole tree later. (A plain
    // "cmd /k" would have no console under a detached spawn and exit at once.)
    const args = mode === "hidden"
      ? ["/c", command]
      : ["/c", "start", ` ${name}`, "/wait", "cmd", "/k", command];

    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      const lower = k.toLowerCase();
      if (lower === "path" || lower === "nodefaultcurrentdirectoryinexepath") continue;
      env[k] = v;
    }
    env.PATH = cwd + ";" + (process.env.PATH || "");

    const child = spawn("cmd.exe", args, {
      cwd,
      env,
      detached: true,
      windowsHide: mode === "hidden",
      stdio: "ignore"
    });

    child.on("error", (err) => {
      sendStatus({ key, name, running: false, error: err.message });
    });
    child.unref();
    started[key] = child;

    sendStatus({ key, name, running: true });
    return { ok: true, key, message: `${name} process started.` };
  } catch (err) {
    return { ok: false, key, message: `${name}: ${err.message}` };
  }
}

// ════════════════════════════════════════════════════════════════════════
// POS API as a PM2 service
//
// The API runs under PM2 (its compiled build, dist/server.js): PM2 starts
// it again by itself if it crashes and keeps its logs in
// Advanced-Pos-System-BE/logs. Nothing starts at login - the first start is
// always a click here. Start = "pm2 start", Stop = "pm2 stop" (a stopped app
// is NOT restarted by PM2). The launcher shows PM2's restart counter in red
// so a crash that PM2 papered over is still noticed.
// ════════════════════════════════════════════════════════════════════════
const PM2_APP = "pos-api";

function pm2Cmd() {
  // Installed with "npm i -g pm2"; the full path works even when the
  // launcher's own PATH does not include the global npm folder.
  const global = path.join(process.env.APPDATA || "", "npm", "pm2.cmd");
  return fs.existsSync(global) ? global : "pm2";
}

function pm2(args, cwd, timeout = 60000) {
  return new Promise((resolve) => {
    execFile("cmd.exe", ["/c", pm2Cmd(), ...args], { cwd: cwd || undefined, windowsHide: true, timeout },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || "") + String(stderr || "") }));
  });
}

/** PM2's view of the API: null = PM2 not available; known=false = never started under PM2. */
async function pm2Status(cwd) {
  const r = await pm2(["jlist"], cwd, 25000);
  if (!r.ok) return null;
  try {
    const list = JSON.parse(r.out.slice(r.out.indexOf("[")));
    const app = list.find((a) => a.name === PM2_APP);
    if (!app) return { known: false };
    const e = app.pm2_env || {};
    return {
      known: true,
      online: e.status === "online",
      status: e.status,
      restarts: Number(e.restart_time) || 0,
      pid: app.pid || null,
      since: e.pm_uptime || null
    };
  } catch {
    return null;
  }
}

/**
 * Starts the API under PM2. An API that PM2 already reports online is left
 * alone (it is serving, or waiting for MySQL by itself - the API never gives
 * up on the database in production), so this costs one PM2 call.
 */
async function startBackend(backendCfg) {
  const name = "POS API";
  const cwd = backendCfg && backendCfg.path;
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, key: "backend", message: `${name}: folder not found - ${cwd}` };
  if (!fs.existsSync(path.join(cwd, "ecosystem.config.js"))) {
    return { ok: false, key: "backend", message: `${name}: ecosystem.config.js is missing in ${cwd}.` };
  }

  const st = await pm2Status(cwd);
  if (st === null) {
    return { ok: false, key: "backend", message: `${name}: PM2 is not installed or not answering. Run "npm i -g pm2" once, then press Start again.` };
  }
  if (st.online) {
    sendStatus({ key: "backend", name, running: true });
    return { ok: true, key: "backend", alreadyRunning: true, message: `${name} is running under PM2.` };
  }

  // An API started some other way (e.g. an old "npm run dev" window) holds
  // port 8000: stop it so PM2 owns the port from now on.
  if (await portOpen(8000, 600)) {
    sendLog("[API] Port 8000 is used by an API that PM2 does not manage - stopping it so PM2 can take over.");
    await stop("backend", backendCfg);
    await waitForPortClosed(8000, 15000);
  }

  // First run on this PC: the compiled build does not exist yet.
  if (!fs.existsSync(path.join(cwd, "dist", "server.js"))) {
    sendLog("[API] No build found - running \"npm run build\" (first time only, about a minute)...");
    sendStartupProgress({ message: "Building the API (first time only)..." });
    const built = await new Promise((resolve) => {
      execFile("cmd.exe", ["/c", "npm", "run", "build"], { cwd, windowsHide: true, timeout: 300000 }, (err) => resolve(!err));
    });
    if (!built) return { ok: false, key: "backend", message: `${name}: "npm run build" failed. Open a terminal in ${cwd}, run it, and read the error.` };
  }

  sendLog(st.known ? "[API] Starting under PM2..." : "[API] Registering with PM2 and starting...");
  const r = st.known
    ? await pm2(["restart", PM2_APP, "--update-env"], cwd)
    : await pm2(["start", "ecosystem.config.js"], cwd);
  if (!r.ok) return { ok: false, key: "backend", message: `${name}: PM2 could not start it.\n${r.out.trim().slice(-400)}` };
  // A manual start begins a fresh count: the red note then means "crashed
  // since you started it". Not awaited - nothing depends on it.
  pm2(["reset", PM2_APP], cwd, 20000);
  sendStatus({ key: "backend", name, running: true });
  return { ok: true, key: "backend", message: `${name} started under PM2 (restarts by itself if it crashes).` };
}

/** Stops the API through PM2 so PM2 does not start it again. True when PM2 handled it. */
async function stopBackendViaPm2(cwd) {
  const st = await pm2Status(cwd);
  if (!st || !st.known || st.status === "stopped") return false;
  const r = await pm2(["stop", PM2_APP], cwd, 30000);
  return r.ok;
}

// ════════════════════════════════════════════════════════════════════════
// MySQL
//
// Start = what the XAMPP panel's Start button does: run mysqld with the
// configured command and wait until it answers. Nothing else is touched -
// no repair, no cleanup, no second attempt.
// Stop = ask mysqld to shut down (mysqladmin) and wait for the process to
// exit; it is never killed while it is still writing.
// ════════════════════════════════════════════════════════════════════════

const MYSQL_START_TIMEOUT_MS = 60000;
// The Start button never waits longer than this. If mysqld is still coming up
// after it, the button returns "starting" and the status dot goes green by itself.
const MYSQL_BUTTON_WAIT_MS = 5000;

/** MySQL answers mysqladmin ping on 127.0.0.1:3306 (one process, ~40 ms). */
async function mysqlAlive(binPath, timeoutMs = 3000) {
  const exe = binPath && path.join(binPath, "mysqladmin.exe");
  if (!exe || !fs.existsSync(exe)) return portOpen(3306);
  const out = await runOut(exe, ["-u", "root", "-h", "127.0.0.1", "--protocol=tcp", "ping"], timeoutMs);
  return !!out && out.toLowerCase().includes("alive");
}

/** PIDs of live mysqld.exe processes from this XAMPP's bin folder (dead leftovers have no path and are ignored). */
async function ownMysqldPids(binPath) {
  if (!binPath) return [];
  const out = await runOut("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='mysqld.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)\" }"
  ], 15000);
  if (!out) return [];
  const want = path.resolve(binPath).toLowerCase();
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [pid, exe] = l.split("|"); return { pid: Number(pid), exe: String(exe || "").toLowerCase() }; })
    .filter((p) => p.pid && p.exe && path.dirname(p.exe) === want)
    .map((p) => p.pid);
}

/** Waits for a mysqld that closed its port but is still writing to disk. True when none is left. */
async function waitForOwnMysqldExit(binPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let pids = await ownMysqldPids(binPath);
  while (pids.length && Date.now() < deadline) {
    await wait(1000);
    pids = await ownMysqldPids(binPath);
  }
  return pids.length === 0;
}

/**
 * Start MySQL.
 *  1. Already answering -> done (never restarted).
 *  2. Port 3306 taken by something that is not answering -> say so, touch nothing.
 *  3. Otherwise run mysqld and wait until it answers.
 * With quick = true (the Start button) the wait is capped at MYSQL_BUTTON_WAIT_MS:
 * a mysqld that is still coming up counts as started ({ ok, starting }).
 */
async function startMysql(mysqlCfg, quick = false) {
  const binPath = mysqlCfg.path;

  if (await mysqlAlive(binPath)) {
    sendLog("[MySQL] Already running.");
    ownMysqlVerified = true;
    sendStatus({ key: "mysql", name: "MySQL", running: true });
    return { ok: true };
  }

  if (await portOpen(3306, 600)) {
    return {
      ok: false,
      error: "Port 3306 is in use, but MySQL is not answering on it.\nIf MySQL was just started, try again in a few seconds. Otherwise close the program using port 3306."
    };
  }

  sendLog("[MySQL] Starting...");
  const launched = await launchRaw("mysql", mysqlCfg, false);
  if (!launched.ok) return { ok: false, error: launched.message };

  const deadline = Date.now() + (quick ? MYSQL_BUTTON_WAIT_MS : MYSQL_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (await mysqlAlive(binPath, 1500)) {
      sendLog("[MySQL] Ready.");
      ownMysqlVerified = true;
      sendStatus({ key: "mysql", name: "MySQL", running: true });
      return { ok: true };
    }
    // mysqld exited: it logged why - stop waiting and show it.
    if (!startedAlive("mysql")) break;
    await wait(300);
  }
  if (quick && startedAlive("mysql")) {
    sendLog("[MySQL] Started - still coming up.");
    ownMysqlVerified = true;
    return { ok: true, starting: true };
  }
  const reason = lastMysqlError(binPath);
  return {
    ok: false,
    error: `Unable to start the database.\nMySQL is not responding on 127.0.0.1:3306.\n${reason ? "Log: " + reason + "\n" : ""}Check the XAMPP MySQL log, then press Start again.`
  };
}

/** Asks this XAMPP's mysqld to shut down and waits for the process to exit. Used by Fix only. */
async function stopOwnMysqld(binPath) {
  if (await portOpen(3306, 600)) {
    await mysqlShutdown(binPath);
    if (!(await waitForOwnMysqldExit(binPath, 30000))) {
      sendLog("[Fix MySQL] Shut down but the process has not exited yet - asking once more...");
      await mysqlShutdown(binPath);
      await waitForOwnMysqldExit(binPath, 30000);
    }
  }
  // Last resort: a mysqld that crashed half-way or stayed stuck for a minute.
  for (const pid of await ownMysqldPids(binPath)) {
    sendLog(`[Fix MySQL] Hung mysqld (PID ${pid}) did not exit - stopping it by force.`);
    await run("taskkill", ["/PID", String(pid), "/F"], 8000);
  }
  await wait(800);
}

/**
 * Fix MySQL. Runs only when the Fix button is clicked - never on its own.
 *  1. stop mysqld cleanly;
 *  2. remove the crash dump and stale .pid files (never data);
 *  3. start it;
 *  4. repair, through the running server, any system table the last unclean
 *     stop left flagged (REPAIR TABLE keeps the rows).
 * Only if that fails, and only after the person confirms it, the InnoDB redo
 * logs are reset - the old logs are kept renamed, never deleted.
 */
async function fixMysqlService(entry) {
  if (mysqlBusy || startupLock) {
    return { ok: false, key: "mysql", message: "MySQL is already being started or repaired - wait for it to finish." };
  }
  mysqlBusy = true;
  try {
    const cfg = readConfig().mysql || {};
    const binPath = (entry && entry.cwd) || (entry && entry.path) || cfg.path || DEFAULT_CONFIG.mysql.path;
    const command = (entry && entry.command) || cfg.command || DEFAULT_CONFIG.mysql.command;
    const dataDir = path.resolve(binPath, "..", "data");
    const mysqlCfg = { path: binPath, command };

    sendStatus({ key: "mysql", name: "MySQL", running: false });
    sendLog("[Fix MySQL] Stopping MySQL cleanly...");
    await stopOwnMysqld(binPath);

    for (const name of ["mysqld.dmp", ...((fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []).filter((f) => f.endsWith(".pid")))]) {
      try { fs.unlinkSync(path.join(dataDir, name)); sendLog(`[Fix MySQL] removed ${name}`); } catch { /* absent or in use */ }
    }

    let result = await startMysql(mysqlCfg);
    if (result.ok) {
      const repaired = await repairSystemTablesOnline(binPath);
      if (repaired.length) sendLog(`[Fix MySQL] System tables repaired: ${repaired.join(", ")}`);
      sendStatus({ key: "mysql", name: "MySQL", running: true });
      return { ok: true, key: "mysql", message: "MySQL is running. Your data was not changed." };
    }

    if (!(entry && entry.allowLogReset)) {
      return {
        ok: false,
        key: "mysql",
        needsLogReset: true,
        message: `The safe repair did not get MySQL running.\n${result.error}\nAn advanced repair can reset the InnoDB redo logs, but it may lose the most recent transactions.`
      };
    }

    sendLog("[Fix MySQL] Advanced repair confirmed: resetting the InnoDB redo logs (old logs kept).");
    await stopOwnMysqld(binPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const name of ["ib_logfile0", "ib_logfile1"]) {
      const file = path.join(dataDir, name);
      try { if (fs.existsSync(file)) fs.renameSync(file, path.join(dataDir, `${name}.bak-${stamp}`)); } catch { /* keep going */ }
    }
    result = await startMysql(mysqlCfg);
    if (result.ok) {
      sendStatus({ key: "mysql", name: "MySQL", running: true });
      return { ok: true, key: "mysql", message: `MySQL running after resetting the redo logs. The old logs were kept as ib_logfile*.bak-${stamp}.` };
    }
    return { ok: false, key: "mysql", message: `MySQL still does not start.\n${result.error}` };
  } finally {
    mysqlBusy = false;
  }
}

/**
 * With MySQL running: check the `mysql` system tables through the server and
 * repair only those that are not OK (REPAIR TABLE keeps their rows). This is
 * what clears "Table '.\mysql\db' is marked as crashed" after an unclean stop.
 */
async function repairSystemTablesOnline(binPath) {
  const check = binPath && path.join(binPath, "mysqlcheck.exe");
  if (!check || !fs.existsSync(check)) return [];
  const base = ["-u", "root", "-h", "127.0.0.1", "--protocol=tcp", "--databases", "mysql"];
  const out = await runOut(check, [...base, "--check"], 60000);
  if (out === null) return [];
  const bad = [];
  let table = null;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(mysql\.\w+)\s*(.*)$/);
    if (m) { table = m[1]; if (m[2] && !/\bOK$/.test(m[2].trim()) && /error|corrupt|crashed/i.test(m[2])) bad.push(table); continue; }
    if (table && /^\s*error\s*:/i.test(line) && !bad.includes(table)) bad.push(table);
  }
  if (!bad.length) return [];
  sendLog(`[Fix MySQL] Repairing system tables through the server: ${bad.join(", ")}`);
  await runOut(check, ["-u", "root", "-h", "127.0.0.1", "--protocol=tcp", "--repair", "--tables", "mysql", ...bad.map((t) => t.split(".")[1])], 120000);
  return bad;
}

/**
 * Start everything, all at once: mysqld, the frontend terminal and the API
 * under PM2 are launched together and the call returns as soon as MySQL
 * answers and the other two are launched. The API waits for MySQL by itself,
 * the frontend compiles in its own window; their dots turn green when their
 * ports open.
 */
async function orchestratedStartup(cfg) {
  if (startupLock || mysqlBusy) {
    sendLog("[STARTUP] Startup or Fix MySQL already in progress. Ignoring duplicate start request.");
    return { ok: false, message: "Startup is already in progress. Please wait." };
  }

  startupLock = true;
  const config = cfg || readConfig();
  const fail = (step, errMsg) => {
    sendLog(`[STARTUP][ERROR] ${errMsg}`);
    sendStartupProgress({ message: errMsg, error: true, canRetry: true, step });
    return { ok: false, error: errMsg, step };
  };

  try {
    sendLog("[STARTUP] Start requested");
    sendStartupProgress({ message: "Starting MySQL, the frontend and the API..." });

    const [mysql, admin, backend] = await Promise.all([
      startMysql(config.mysql || DEFAULT_CONFIG.mysql),
      launchRaw("admin", config.admin || DEFAULT_CONFIG.admin, true),
      startBackend(config.backend || DEFAULT_CONFIG.backend)
    ]);

    if (!mysql.ok) return fail("mysql", mysql.error);
    sendLog("[STARTUP] MySQL is ready");
    sendLog(`[STARTUP] ${admin.message}`);
    if (!admin.ok) return fail("admin", admin.message);
    sendLog(`[STARTUP] ${backend.message}`);
    if (!backend.ok) return fail("backend", backend.message);

    const message = "MySQL ready; frontend terminal opened; API running under PM2. Each dot turns green when its service is up.";
    sendLog(`[STARTUP] ${message}`);
    sendStartupProgress({ state: "READY", message });
    return { ok: true, message };
  } catch (err) {
    return fail("startup", `Startup failed: ${err.message}`);
  } finally {
    startupLock = false;
  }
}

async function stopEverything(cfg) {
  startupLock = false;
  const config = cfg || readConfig();
  const results = [];
  // Reverse of the start order: the apps go down before the database.
  for (const key of [...RUN_ORDER].reverse()) {
    results.push(await stop(key, config[key] || {}));
  }
  ownMysqlVerified = false;
  return results;
}

/**
 * Windows is logging off or shutting down while MySQL runs: shut it down
 * cleanly so the next start does not begin with crash recovery (the start of
 * the whole 0x80000003 chain). Synchronous - Windows gives little time.
 */
function shutdownMysqlOnSessionEnd() {
  if (!ownMysqlVerified) return;
  const binPath = (readConfig().mysql || {}).path || DEFAULT_CONFIG.mysql.path;
  const exe = path.join(binPath, "mysqladmin.exe");
  if (!fs.existsSync(exe)) return;
  try {
    require("child_process").execFileSync(exe, ["-u", "root", "--protocol=tcp", "-h", "127.0.0.1", "shutdown"], { windowsHide: true, timeout: 10000 });
  } catch { /* already down, or no time left */ }
}

function createWindow() {
  if (!fs.existsSync(PRELOAD)) {
    console.error("[main] preload.js NOT FOUND at", PRELOAD);
  }

  win = new BrowserWindow({
    width: 820,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    console.error("[main] preload failed:", preloadPath, error);
  });

  // Closing the launcher stops what it started, so nothing is left holding
  // port 3306 / 8000 / 8002 after the window is gone.
  win.on("close", async (e) => {
    if (shuttingDown) return;
    e.preventDefault();

    const running = [];
    for (const key of RUN_ORDER) {
      const svc = SERVICES[key];
      if (svc.port && (await portOpen(svc.port))) running.push({ name: svc.name, port: svc.port });
    }

    // Nothing running - just close.
    if (running.length) {
      const answer = await askClose(running);
      if (answer === "cancel") return;          // stay open
      if (answer === "leave") {                 // hide to the tray, services up
        ensureTray();
        win.hide();
        try {
          tray.displayBalloon({
            iconType: "info",
            title: "Still running",
            content: running.map((r) => r.name).join(", ") + " kept running. Click the tray icon to reopen."
          });
        } catch { /* balloons are optional */ }
        return;
      }
    }

    shuttingDown = true;
    if (!win.isDestroyed()) win.webContents.send("launcher:closing");

    // Never hang on exit: if a service will not go down, leave anyway.
    const escape = setTimeout(() => {
      if (win && !win.isDestroyed()) win.destroy();
    }, 40000);

    stopEverything().finally(() => {
      clearTimeout(escape);
      if (tray) { tray.destroy(); tray = null; }
      if (win && !win.isDestroyed()) win.destroy();
    });
  });

  // Windows logoff / shutdown: stop MySQL cleanly instead of letting it be killed.
  win.on("session-end", shutdownMysqlOnSessionEnd);

  win.loadFile(INDEX);
  // Uncomment while debugging the bridge:
  // win.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(() => {
  ipcMain.handle("config:get", () => readConfig());

  ipcMain.handle("config:save", (_e, cfg) => {
    writeConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle("network:addresses", () => lanAddresses());

  ipcMain.handle("clipboard:write", (_e, text) => {
    clipboard.writeText(String(text));
    return true;
  });

  ipcMain.handle("dialog:browse", async (_e, current) => {
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      defaultPath: current && fs.existsSync(current) ? current : undefined
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("service:run", async (_e, svc) => {
    if (startupLock || mysqlBusy) {
      return { ok: false, message: "Startup is already in progress. Please wait." };
    }

    if (svc.key === "mysql") {
      const result = await startMysql({ path: svc.cwd, command: svc.command }, true);
      return result.ok
        ? { ok: true, key: "mysql", message: result.starting ? "MySQL started - the dot turns green as soon as it answers." : "MySQL is running on port 3306." }
        : { ok: false, key: "mysql", message: result.error };
    }

    if (svc.key === "backend") {
      return startBackend({ path: svc.cwd });
    }

    // Terminal services: open the window, run the command, done.
    return launchRaw(svc.key, { path: svc.cwd, command: svc.command }, true);
  });

  ipcMain.handle("service:stop", (_e, svc) => stop(svc.key, { path: svc.cwd }));

  ipcMain.handle("service:stop-all", (_e, cfg) => stopEverything(cfg));

  ipcMain.handle("service:fix-mysql", (_e, svc) => fixMysqlService(svc || {}));

  ipcMain.handle("close:answer", (_e, answer) => {
    if (closeAnswer) {
      const resolve = closeAnswer;
      closeAnswer = null;
      resolve(answer);
    }
    return true;
  });

  // PM2's answer costs a process spawn (~1 s), so it is refreshed less often
  // than the port checks, which take a few milliseconds.
  let pm2Cache = { at: 0, value: undefined };
  ipcMain.handle("service:status", async () => {
    const [mysql, backend, admin] = await Promise.all([
      portOpen(SERVICES.mysql.port, 600),
      portOpen(SERVICES.backend.port, 600),
      portOpen(SERVICES.admin.port, 600)
    ]);
    if (Date.now() - pm2Cache.at > 15000) {
      pm2Cache = { at: Date.now(), value: await pm2Status((readConfig().backend || {}).path) };
    }
    return { mysql, backend, admin, backendPm2: pm2Cache.value };
  });

  ipcMain.handle("service:run-all", (_e, cfg) => orchestratedStartup(cfg));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
