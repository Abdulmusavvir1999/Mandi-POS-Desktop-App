const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, clipboard } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const os = require("os");

const PRELOAD = path.join(__dirname, "preload.js");
const INDEX = path.join(__dirname, "index.html");
const TRAY_ICON = path.join(__dirname, "tray.png");
const XAMPP_PANEL = path.join(__dirname, "xampp-panel.ps1");

// POS-Desktop sits next to Advanced-Pos-System-BE and Advanced-Pos-System-FE in the repo, so the
// defaults follow the folder rather than one machine's absolute paths.
const REPO = path.join(__dirname, "..");

function resolveBackendPath() {
  return path.join(REPO, "Advanced-Pos-System-BE");
}

function resolveFrontendPath() {
  return path.join(REPO, "Advanced-Pos-System-FE");
}

const DEFAULT_CONFIG = {
  mysql: {
    path: "C:\\xampp\\mysql\\bin",
    command: "mysqld.exe --defaults-file=C:\\xampp\\mysql\\bin\\my.ini --standalone"
  },
  backend: {
    path: resolveBackendPath(),
    command: "npm run dev"
  },
  admin: {
    path: resolveFrontendPath(),
    command: "npm start"
  }
};

const StartupState = {
  IDLE: "IDLE",
  STARTING_SYSTEM: "STARTING_SYSTEM",
  CHECKING_MYSQL: "CHECKING_MYSQL",
  STARTING_MYSQL: "STARTING_MYSQL",
  WAITING_FOR_MYSQL: "WAITING_FOR_MYSQL",
  RECOVERING_MYSQL: "RECOVERING_MYSQL",
  CONNECTING_DATABASE: "CONNECTING_DATABASE",
  CHECKING_API: "CHECKING_API",
  STARTING_API: "STARTING_API",
  WAITING_FOR_API: "WAITING_FOR_API",
  STARTING_FRONTEND: "STARTING_FRONTEND",
  WAITING_FOR_FRONTEND: "WAITING_FOR_FRONTEND",
  READY: "READY",
  ERROR: "ERROR"
};

// Global startup lock to prevent duplicate runs and race conditions
let startupLock = false;
let currentStartupState = StartupState.IDLE;

// hidden = background process, no console window, like the XAMPP Start button.
// terminal = its own cmd window so you can watch the logs.
const SERVICES = {
  mysql: { name: "MySQL", mode: "hidden", port: 3306, waitForPortMs: 30000 },
  backend: { name: "POS API", mode: "terminal", port: 8000, waitAfterMs: 2000 },
  admin: { name: "POS Frontend", mode: "terminal", port: 8002, waitAfterMs: 0 }
};

const RUN_ORDER = ["mysql", "backend", "admin"];

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
    // Strict enforcement: Ensure backend and admin paths always target Advanced POS System
    if (merged.backend && (!merged.backend.path || !fs.existsSync(merged.backend.path) || merged.backend.path.includes("Pos-Backend"))) {
      merged.backend.path = resolveBackendPath();
    }
    if (merged.admin && (!merged.admin.path || !fs.existsSync(merged.admin.path) || merged.admin.path.includes("Pos-Frontend"))) {
      merged.admin.path = resolveFrontendPath();
    }
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

function sendStartupProgress(data) {
  currentStartupState = data.state || currentStartupState;
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

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await wait(700);
  }
  return false;
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

// Find the cmd.exe that owns the console window, so the whole service dies
// with its terminal. Killing anything below it leaves the window sitting
// there, and its title belongs to conhost, not to cmd, so taskkill
// /FI WINDOWTITLE never matches it either.
//
// The walk has to pass through node.exe as well as cmd.exe, because an npm
// script stacks both. "npm run dev" on the API is:
//
//   cmd /k -> node (npm) -> cmd (npm.cmd) -> node (tsx watch) -> node (server)
//
// Only that last node holds port 8000. Stopping at the first non-cmd parent
// would kill it and leave tsx watch alive - which just restarts the server -
// plus the window. So walk up through both, and remember the outermost
// cmd.exe seen; that one is the window. If there is no cmd.exe above at all,
// fall back to the listening pid itself.
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

// mysqld holds the data files, so ask it to shut down before killing it.
async function mysqlShutdown(binPath) {
  const exe = binPath && path.join(binPath, "mysqladmin.exe");
  if (!exe || !fs.existsSync(exe)) return false;
  return run(exe, ["-u", "root", "--protocol=tcp", "-h", "127.0.0.1", "shutdown"], 20000);
}

function runOut(exe, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// The XAMPP Control Panel prints "MySQL shutdown unexpectedly" whenever mysqld
// disappears without its own Stop button having been pressed, however cleanly
// it went. So while the panel is watching MySQL, stop it through that button;
// see xampp-panel.ps1. Answers "state=Stop" when the panel is watching.
async function xamppPanel(mode) {
  if (!fs.existsSync(XAMPP_PANEL)) return "state=none";
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", XAMPP_PANEL];
  if (mode) args.push(mode);
  const out = await runOut("powershell.exe", args, 30000);
  return out === null ? "state=error" : out.trim();
}

// Once MySQL is down the panel has nothing left to do, so close it. It only
// quits when every module is stopped, and its MySQL button takes a timer tick
// to flip back to Start after the port closes - hence the retries on "busy".
async function closeXamppPanel() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = await xamppPanel("-Quit");
    if (result !== "busy") return result;
    await wait(1000);
  }
  return "busy";
}

// XAMPP's Stop kills mysqld by PID rather than shutting it down, so first get
// it to where a kill loses nothing: FLUSH TABLES closes the Aria and MyISAM
// tables, and a zero dirty-page limit makes InnoDB write its buffer pool out.
// Committed transactions are already in the redo log either way.
async function mysqlQuiesce(binPath) {
  const exe = binPath && path.join(binPath, "mysql.exe");
  if (!exe || !fs.existsSync(exe)) return;
  const base = ["-u", "root", "--protocol=tcp", "-h", "127.0.0.1", "-N", "-B", "-e"];
  await runOut(exe, [...base, "SET GLOBAL innodb_max_dirty_pages_pct = 0; FLUSH TABLES;"]);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const out = await runOut(exe, [...base, "SHOW GLOBAL STATUS LIKE 'Innodb_buffer_pool_pages_dirty'"], 5000);
    const dirty = out === null ? NaN : Number(out.trim().split(/\s+/)[1]);
    if (!(dirty > 0)) return;
    await wait(500);
  }
}

async function stop(key, entry) {
  const svc = SERVICES[key] || { name: key };
  const { name, port } = svc;

  if (!port) return { ok: false, key, message: `${name}: no port configured, stop it by hand.` };
  if (!(await portOpen(port))) {
    sendStatus({ key, name, running: false });
    return { ok: true, key, message: `${name} was not running.` };
  }

  if (key === "mysql") {
    const binPath = entry && entry.path;
    // Only while the panel shows MySQL running; with no panel watching,
    // nothing would complain and mysqladmin's clean shutdown is the better stop.
    if ((await xamppPanel()) === "state=Stop") {
      await mysqlQuiesce(binPath);
      if ((await xamppPanel("-Click")) === "clicked" && (await waitForPortClosed(port, 20000))) {
        sendStatus({ key, name, running: false });
        const closed = (await closeXamppPanel()).startsWith("quit");
        return {
          ok: true,
          key,
          message: `${name} stopped through the XAMPP Control Panel${closed ? ", and the panel was closed" : ""}.`
        };
      }
    }
    await mysqlShutdown(binPath);
    if (await waitForPortClosed(port, 20000)) {
      sendStatus({ key, name, running: false });
      const closed = (await closeXamppPanel()).startsWith("quit");
      return { ok: true, key, message: `${name} shut down cleanly${closed ? ", and the XAMPP panel was closed" : ""}.` };
    }
  }

  const pids = await pidsOnPort(port);
  const table = pids.length ? await processTable() : new Map();
  for (const pid of pids) {
    // /T takes the whole tree, so the service dies with its terminal window.
    await run("taskkill", ["/PID", consoleRootOf(pid, table), "/T", "/F"]);
  }
  // Belt and braces for consoles that do expose their title.
  await run("taskkill", ["/F", "/FI", `WINDOWTITLE eq  ${name}*`], 8000);

  const down = await waitForPortClosed(port, 8000);
  sendStatus({ key, name, running: !down });
  return down
    ? { ok: true, key, message: `${name} stopped.` }
    : { ok: false, key, message: `${name}: port ${port} is still open - stop it from Task Manager.` };
}

// A hidden service has no window, and mysqld writes its fatal errors to stderr
// rather than to mysql_error.log - "Failed to initialize multi master
// structures / Aborting" never reaches the log file. So capture the output to
// a file per service and quote it back when a start fails.
function serviceLog(key) {
  return path.join(app.getPath("userData"), `${key}-output.log`);
}

function lastLoggedError(key, cwd) {
  const pick = (text) => {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const bad = lines.reverse().find((l) =>
      l.includes("[ERROR]") || l.includes("Aborting") || l.includes("is not recognized"));
    return bad || "";
  };

  try {
    const file = serviceLog(key);
    if (fs.existsSync(file)) {
      const hit = pick(fs.readFileSync(file, "utf8").slice(-16384));
      if (hit) return hit.slice(0, 180);
    }
  } catch { /* fall through to the error log */ }

  try {
    const log = path.join(cwd, "..", "data", "mysql_error.log");
    if (!fs.existsSync(log)) return "";
    const { size } = fs.statSync(log);
    const start = Math.max(0, size - 65536);
    const fd = fs.openSync(log, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return pick(buf.toString("utf8")).slice(0, 180);
  } catch {
    return "";
  }
}

async function launchRaw(key, entry, checkExisting = true) {
  const svc = SERVICES[key] || { name: key, mode: "terminal" };
  const { name, mode } = svc;
  const cwd = entry && entry.path;
  const command = entry && entry.command;

  if (!cwd || !command) {
    return { ok: false, key, message: `${name}: folder or command is empty.` };
  }
  if (!fs.existsSync(cwd)) {
    return { ok: false, key, message: `${name}: folder not found - ${cwd}` };
  }

  // Prevent duplicate process if already listening on port
  if (checkExisting && svc.port && (await portOpen(svc.port))) {
    sendStatus({ key, name, running: true });
    return { ok: true, key, message: `${name} was already running on port ${svc.port}.`, alreadyRunning: true };
  }

  try {
    const args = mode === "hidden"
      ? ["/c", command]
      : ["/c", "start", ` ${name}`, "cmd", "/k", command];

    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      const lower = k.toLowerCase();
      if (lower === "path" || lower === "nodefaultcurrentdirectoryinexepath") continue;
      env[k] = v;
    }
    env.PATH = cwd + ";" + (process.env.PATH || "");

    let outFd = null;
    if (mode === "hidden") {
      try { outFd = fs.openSync(serviceLog(key), "w"); } catch { outFd = null; }
    }

    const child = spawn("cmd.exe", args, {
      cwd,
      env,
      detached: true,
      windowsHide: mode === "hidden",
      stdio: outFd === null ? "ignore" : ["ignore", outFd, outFd]
    });

    if (outFd !== null) { try { fs.closeSync(outFd); } catch { /* already closed */ } }

    child.on("error", (err) => {
      sendStatus({ key, name, running: false, error: err.message });
    });
    child.unref();

    sendStatus({ key, name, running: true });
    return { ok: true, key, message: `${name} process started.` };
  } catch (err) {
    return { ok: false, key, message: `${name}: ${err.message}` };
  }
}

async function verifyDatabaseConnection(binPath, timeoutMs = 3000) {
  const mysqlAdminExe = binPath && path.join(binPath, "mysqladmin.exe");
  const mysqlExe = binPath && path.join(binPath, "mysql.exe");

  // Attempt 1: Ping via mysqladmin if available
  if (mysqlAdminExe && fs.existsSync(mysqlAdminExe)) {
    const adminPing = await new Promise((resolve) => {
      execFile(
        mysqlAdminExe,
        ["-u", "root", "-h", "127.0.0.1", "--protocol=tcp", "ping"],
        { windowsHide: true, timeout: timeoutMs },
        (err, stdout) => {
          if (!err && String(stdout).toLowerCase().includes("alive")) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: err ? err.message : String(stdout).trim() });
          }
        }
      );
    });

    // mysqladmin is present: its answer is final. No raw-socket fallback - an
    // open-and-drop connection is exactly what MySQL must not be flooded with.
    if (!adminPing.ok) return adminPing;
    if (adminPing.ok) {
      if (mysqlExe && fs.existsSync(mysqlExe)) {
        const queryCheck = await new Promise((resolve) => {
          execFile(
            mysqlExe,
            ["-u", "root", "-h", "127.0.0.1", "--protocol=tcp", "-e", "SELECT 1;"],
            { windowsHide: true, timeout: timeoutMs },
            (err) => resolve(!err)
          );
        });
        return queryCheck ? { ok: true } : { ok: false, error: "MySQL answers, but a test query failed." };
      }
      return { ok: true };
    }
  }

  // Attempt 2: Connect socket and verify greeting packet
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve({ ok: false, error: "Database connection timed out" });
      }
    }, timeoutMs);

    socket.connect(3306, "127.0.0.1", () => {
      // socket connected, waiting for greeting packet
    });

    socket.on("data", (data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      // Packet index 4: 0x0A (10) indicates valid MySQL greeting
      if (data && data.length > 4 && data[4] === 0x0a) {
        resolve({ ok: true });
      } else if (data && data.length > 4 && data[4] === 0xff) {
        const errText = data.slice(7).toString("utf8").replace(/[^\x20-\x7E]/g, "");
        resolve({ ok: false, error: errText || "MySQL rejected handshake" });
      } else {
        resolve({ ok: true });
      }
    });

    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: false, error: err.message });
    });
  });
}

async function waitForMySQLReady(binPath, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 1;
  while (Date.now() < deadline) {
    const portUp = await portOpen(3306, 600);
    if (portUp) {
      sendStartupProgress({
        state: StartupState.CONNECTING_DATABASE,
        message: "Testing database connection...",
        detail: `Attempt ${attempt}`
      });
      const dbCheck = await verifyDatabaseConnection(binPath, 1500);
      if (dbCheck.ok) {
        sendLog("[STARTUP] MySQL is ready");
        sendLog("[STARTUP] Database connection successful");
        sendStatus({ key: "mysql", name: "MySQL", running: true });
        return { ok: true };
      } else {
        sendLog(`[STARTUP] MySQL port 3306 open, waiting for database to accept connections (attempt ${attempt})...`);
      }
    } else {
      sendLog(`[STARTUP] Waiting for MySQL on 127.0.0.1:3306 (attempt ${attempt})...`);
    }
    attempt++;
    await wait(500);
  }
  return {
    ok: false,
    error: "Unable to start the database.\nMySQL is not responding on 127.0.0.1:3306.\nPlease check that MySQL/XAMPP is installed and configured correctly."
  };
}

function checkApiHealth(port = 8000, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(res.statusCode === 200 && json.status === "UP");
        } catch {
          resolve(res.statusCode === 200);
        }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

async function waitForApiReady(port = 8000, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 1;
  while (Date.now() < deadline) {
    const healthy = await checkApiHealth(port, 1500);
    if (healthy) {
      sendLog("[STARTUP] API is ready");
      sendStatus({ key: "backend", name: "POS API", running: true });
      return { ok: true };
    }
    sendLog(`[STARTUP] Waiting for API health check on :${port}/api/health (attempt ${attempt})...`);
    attempt++;
    await wait(500);
  }
  return {
    ok: false,
    error: `API server did not respond with healthy status within ${Math.round(timeoutMs / 1000)} seconds.`
  };
}

async function launch(key, entry) {
  const result = await launchRaw(key, entry, true);
  if (!result.ok || result.alreadyRunning) return result;

  const svc = SERVICES[key] || {};
  if (svc.waitForPortMs) {
    const up = await waitForPort(svc.port, svc.waitForPortMs || 20000);
    sendStatus({ key, name: svc.name, running: up });
    return up
      ? { ok: true, key, message: `${svc.name} is up on port ${svc.port}.` }
      : {
        ok: false,
        key,
        message: `${svc.name}: started but port ${svc.port} never opened. ${lastLoggedError(key, entry && entry.path) || ""}`
      };
  }

  return result;
}

// ════════════════════════════════════════════════════════════════════════
// MySQL: start, verify and recover - shared by "Start everything" and the
// Fix MySQL button.
//
// Why MySQL kept failing to start (found in mysql_error.log and reproduced):
//  1. MySQL was almost never shut down cleanly. The launcher checked port 3306
//     by opening and dropping raw TCP connections; with enough of those mysqld
//     accepted "shutdown" but never exited, so stopping ended in a kill.
//  2. Every next start then ran crash recovery, and the old Fix MySQL ran
//     aria_chk on the system tables outside the server, which left them
//     flagged "Corrupt" - e.g. "Table '.\mysql\db' is marked as crashed".
//  3. Right after start-up, InnoDB's Windows native async I/O failed
//     ("aio write returned OS error 206") and mysqld died with 0x80000003.
//     my.ini now sets innodb_use_native_aio=0.
// Now: port 3306 is checked with netstat and logins (mysqladmin), never raw
// sockets; MySQL is stopped with mysqladmin and the launcher waits for the
// process to exit; system tables are repaired through the server; and the
// automatic recovery never deletes data, databases or InnoDB redo logs and
// only touches this XAMPP's own mysqld. Resetting the redo logs stays a
// manual, confirmed step.
// ════════════════════════════════════════════════════════════════════════

const MYSQL_START_TIMEOUT_MS = 30000;   // waiting for port 3306 + a working connection
const MYSQL_STABLE_MS = 3000;           // it must stay up this long (the crash came ~1s after "ready")
const MYSQL_MAX_RECOVERIES = 2;         // automatic recovery attempts before giving up

// One recovery at a time, whether it came from startup or from the button.
let mysqlRecoveryLock = false;
// Set once this XAMPP's mysqld is verified running, so a Windows shutdown
// can stop it cleanly (and never another program's MySQL).
let ownMysqlVerified = false;

/** PIDs of mysqld.exe running from this XAMPP's bin folder - nobody else's MySQL. */
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

/** Who holds port 3306: "none", "own" (this XAMPP's mysqld) or "foreign" (another program). */
async function mysqlPortOwner(binPath) {
  const pids = (await pidsOnPort(3306)).map(Number);
  if (!pids.length) return { owner: "none", pids };
  const own = new Set(await ownMysqldPids(binPath));
  return { owner: pids.some((p) => own.has(p)) ? "own" : "foreign", pids };
}

/** Stops this XAMPP's mysqld: a clean shutdown first, a kill only if it will not go. */
async function stopOwnMysqld(binPath) {
  const { owner } = await mysqlPortOwner(binPath);
  if (owner === "own") {
    await mysqlShutdown(binPath);
    // The port closes first; mysqld then still flushes to disk. Wait for the
    // process itself to exit - killing it here is what made the next start
    // need crash recovery.
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && (await ownMysqldPids(binPath)).length) await wait(1000);
  }
  // Only a mysqld that crashed half-way or did not exit within a minute.
  for (const pid of await ownMysqldPids(binPath)) {
    sendLog(`[MySQL] Stopping hung mysqld (PID ${pid})...`);
    await run("taskkill", ["/PID", String(pid), "/F"], 8000);
  }
  await wait(800);
}

/**
 * Clean-up on a STOPPED server, before starting it again: only the leftovers
 * of a crash - the crash dump and stale .pid files. Nothing that holds data.
 *
 * Deliberately NOT done any more (the old Fix MySQL did both):
 *  - aria_chk on the system tables: editing Aria files outside the server
 *    leaves them out of step with the server's Aria log, and the server then
 *    marks every one of them "Corrupt / from another system" - verified on
 *    this machine. System tables are repaired through the running server
 *    instead (repairSystemTablesOnline).
 *  - copying tables from xampp/mysql/backup: files from another install have
 *    the same problem.
 */
async function repairMysqlFilesSafely(binPath) {
  const dataDir = path.resolve(binPath, "..", "data");
  const done = [];
  if (!fs.existsSync(dataDir)) return done;
  const dmp = path.join(dataDir, "mysqld.dmp");
  try { if (fs.existsSync(dmp)) { fs.unlinkSync(dmp); done.push("removed mysqld.dmp"); } } catch { /* in use: leave it */ }
  try {
    for (const file of fs.readdirSync(dataDir)) {
      if (file.endsWith(".pid")) { try { fs.unlinkSync(path.join(dataDir, file)); done.push(`removed ${file}`); } catch { } }
    }
  } catch { }
  return done;
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
  sendLog(`[MySQL] Repairing system tables through the server: ${bad.join(", ")}`);
  await runOut(check, ["-u", "root", "-h", "127.0.0.1", "--protocol=tcp", "--repair", "--tables", "mysql", ...bad.map((t) => t.split(".")[1])], 120000);
  return bad;
}

/** Up AND staying up: the 0x80000003 crash came about a second after "ready". */
async function mysqlStaysUp(binPath, ms = MYSQL_STABLE_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await portOpen(3306, 600))) return false;
    await wait(500);
  }
  return (await verifyDatabaseConnection(binPath, 2500)).ok;
}

/** Starts this XAMPP's mysqld (if needed) and waits until it answers and stays up. */
async function startMysqlAndVerify(mysqlCfg) {
  if (!(await portOpen(3306, 600))) {
    const launched = await launchRaw("mysql", mysqlCfg, false);
    if (!launched.ok) return { ok: false, error: launched.message };
  }
  const ready = await waitForMySQLReady(mysqlCfg.path, MYSQL_START_TIMEOUT_MS);
  if (!ready.ok) return { ok: false, error: lastLoggedError("mysql", mysqlCfg.path) || "MySQL did not answer on 127.0.0.1:3306." };
  sendStartupProgress({ state: StartupState.CONNECTING_DATABASE, message: "Verifying database connection...", step: 2, total: 5 });
  if (!(await mysqlStaysUp(mysqlCfg.path))) {
    return { ok: false, crashedAfterStart: true, error: lastLoggedError("mysql", mysqlCfg.path) || "MySQL stopped right after starting." };
  }
  ownMysqlVerified = true;
  return { ok: true };
}

/** After a recovery: repair any system tables the unclean stop left flagged, through the server. */
async function repairSystemTablesAfterRecovery(binPath) {
  const repaired = await repairSystemTablesOnline(binPath);
  if (repaired.length) sendLog(`[MySQL] System tables repaired: ${repaired.join(", ")}`);
}

/**
 * Brings MySQL up for startup: reuse a healthy server, otherwise start it,
 * otherwise run the safe recovery (stop own mysqld -> safe repairs -> start)
 * up to MYSQL_MAX_RECOVERIES times. Progress only - no error is shown while
 * recovery is still trying.
 */
async function ensureMysqlReady(mysqlCfg) {
  const binPath = mysqlCfg.path;
  sendStartupProgress({ state: StartupState.CHECKING_MYSQL, message: "Checking MySQL connection...", step: 1, total: 5 });

  const port = await mysqlPortOwner(binPath);
  if (port.owner === "foreign") {
    // Another program owns 3306. Use it if it is a working MySQL; never stop it.
    const conn = await verifyDatabaseConnection(binPath, 2500);
    if (conn.ok) {
      sendLog(`[STARTUP] Port 3306 is held by another MySQL (PID ${port.pids.join(", ")}); using it as it is.`);
      return { ok: true };
    }
    return {
      ok: false,
      fatal: true,
      error: `Port 3306 is in use by another program (PID ${port.pids.join(", ")}) that is not answering as MySQL.\nClose that program (or change its port) and press Retry.`
    };
  }

  if (port.owner === "own") {
    const conn = await verifyDatabaseConnection(binPath, 2500);
    if (conn.ok && (await mysqlStaysUp(binPath, 1500))) {
      sendLog("[STARTUP] MySQL is already running and verified - reusing it.");
      ownMysqlVerified = true;
      sendStatus({ key: "mysql", name: "MySQL", running: true });
      return { ok: true };
    }
    sendLog("[STARTUP] MySQL is running but not answering - it will be restarted.");
  } else {
    sendLog("[STARTUP] Starting MySQL...");
    sendStartupProgress({ state: StartupState.STARTING_MYSQL, message: "Starting database...", step: 1, total: 5 });
    const first = await startMysqlAndVerify(mysqlCfg);
    if (first.ok) return first;
    sendLog(`[STARTUP] MySQL did not start cleanly: ${first.error}`);
  }

  // Safe automatic recovery - the same steps as Fix MySQL, minus anything risky.
  mysqlRecoveryLock = true;
  try {
    let last = "";
    for (let attempt = 1; attempt <= MYSQL_MAX_RECOVERIES; attempt++) {
      sendStartupProgress({
        state: StartupState.RECOVERING_MYSQL,
        message: `Recovering database startup... (attempt ${attempt} of ${MYSQL_MAX_RECOVERIES})`,
        step: 1,
        total: 5
      });
      sendLog(`[RECOVERY] Attempt ${attempt}: stopping MySQL cleanly and repairing safely...`);
      await stopOwnMysqld(binPath);
      const repaired = await repairMysqlFilesSafely(binPath);
      if (repaired.length) sendLog(`[RECOVERY] ${repaired.join(", ")}`);
      const res = await startMysqlAndVerify(mysqlCfg);
      if (res.ok) {
        sendLog(`[RECOVERY] MySQL recovered on attempt ${attempt}.`);
        await repairSystemTablesAfterRecovery(binPath);
        return res;
      }
      last = res.error;
      sendLog(`[RECOVERY] Attempt ${attempt} failed: ${last}`);
      await wait(1500 * attempt);
    }
    return {
      ok: false,
      error: `Unable to start the database.\nMySQL is not responding on 127.0.0.1:3306 after ${MYSQL_MAX_RECOVERIES} automatic recovery attempts.\n${last ? "Log: " + last + "\n" : ""}Your data was not changed. Press Retry, or Fix MySQL for the advanced repair.`
    };
  } finally {
    mysqlRecoveryLock = false;
  }
}

/**
 * Start order: MySQL (verified, recovered if needed) -> frontend (starts
 * compiling straight away) -> API (health check includes the database) ->
 * frontend answering -> ready. A failed step stops here with Retry; nothing
 * carries on in a half-started state.
 */
async function orchestratedStartup(cfg) {
  if (startupLock || mysqlRecoveryLock) {
    sendLog("[STARTUP] Startup or MySQL recovery already in progress. Ignoring duplicate start request.");
    return { ok: false, message: "Startup is already in progress. Please wait." };
  }

  startupLock = true;
  const config = cfg || readConfig();
  const fail = (step, errMsg) => {
    sendLog(`[STARTUP][ERROR] ${errMsg}`);
    sendStartupProgress({ state: StartupState.ERROR, message: errMsg, error: true, canRetry: true, step });
    return { ok: false, error: errMsg, step };
  };

  try {
    sendLog("[STARTUP] Start requested");
    sendStartupProgress({ state: StartupState.STARTING_SYSTEM, message: "Starting system...", step: 1, total: 5 });

    // ── 1. MySQL ───────────────────────────────────────────────────────────
    const mysqlCfg = config.mysql || DEFAULT_CONFIG.mysql;
    const mysql = await ensureMysqlReady(mysqlCfg);
    if (!mysql.ok) return fail("mysql", mysql.error);
    sendStatus({ key: "mysql", name: "MySQL", running: true });
    sendLog("[STARTUP] Database connected successfully");
    sendStartupProgress({ state: StartupState.CONNECTING_DATABASE, message: "Database connected successfully.", step: 2, total: 5 });

    // ── 2. Open both terminals at once: frontend and API ───────────────────
    // The API is only started now that MySQL is verified. Neither waits for
    // the other - the frontend builds in its own window meanwhile.
    const adminCfg = config.admin || DEFAULT_CONFIG.admin;
    const backendCfg = config.backend || DEFAULT_CONFIG.backend;
    sendStartupProgress({ state: StartupState.STARTING_API, message: "Opening the frontend and API terminals...", step: 3, total: 5 });

    let frontendUp = await portOpen(8002, 800);
    if (frontendUp) {
      sendLog("[STARTUP] POS Frontend is already running on port 8002");
      sendStatus({ key: "admin", name: "POS Frontend", running: true });
    } else {
      sendLog("[STARTUP] Starting POS Frontend...");
      const launchFe = await launchRaw("admin", adminCfg, false);
      if (!launchFe.ok) return fail("admin", `The frontend could not start.
${launchFe.message}`);
    }

    let apiUp = await checkApiHealth(8000, 1500);
    if (apiUp) {
      sendLog("[STARTUP] API is already running and connected to the database");
      sendStatus({ key: "backend", name: "POS API", running: true });
    } else {
      // Something on 8000 that is not a healthy API: stop it so there is one API only.
      if ((await pidsOnPort(8000)).length > 0) {
        sendLog("[STARTUP] Cleaning up existing non-responsive listener on port 8000...");
        await stop("backend", backendCfg);
        await wait(600);
      }
      sendLog("[STARTUP] Starting POS API...");
      const launchApi = await launchRaw("backend", backendCfg, false);
      if (!launchApi.ok) return fail("backend", `Database is ready, but the API server could not start.
${launchApi.message}`);

      // ── 3. Wait for the API only (seconds). Its health check includes the database.
      sendStartupProgress({ state: StartupState.WAITING_FOR_API, message: "Waiting for the API and its database connection...", step: 4, total: 5 });
      const waitApi = await waitForApiReady(8000, 45000);
      if (!waitApi.ok) {
        const lastErr = lastLoggedError("backend", backendCfg.path);
        return fail("backend", `Database is ready, but the API server could not start.
${lastErr ? "Error: " + lastErr : waitApi.error}`);
      }
    }

    // ── 4. Done. The frontend is not waited for: its status dot turns green
    // by itself when the build finishes (the page polls every few seconds).
    frontendUp = frontendUp || (await portOpen(8002, 800));
    const message = frontendUp
      ? "System Ready"
      : "Database and API ready. The frontend is building in its window - it turns green when ready.";
    sendLog(`[STARTUP] ${message}`);
    sendStartupProgress({ state: StartupState.READY, message, step: 5, total: 5 });
    return {
      ok: true,
      message,
      results: [
        { key: "mysql", ok: true, message: "MySQL is ready" },
        { key: "backend", ok: true, message: "POS API is healthy and connected to the database" },
        { key: "admin", ok: true, message: frontendUp ? "POS Frontend is running" : "POS Frontend is building" }
      ]
    };
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
 * Fix MySQL button. Runs the same safe recovery as startup. Only when that
 * does not help, and only when the person confirmed it (allowLogReset), does
 * it reset the InnoDB redo logs - which can lose the latest transactions, so
 * the old logs are kept (renamed with a timestamp), never deleted.
 */
async function fixMysqlService(entry) {
  if (mysqlRecoveryLock || startupLock) {
    return { ok: false, key: "mysql", message: "MySQL startup or recovery is already running - wait for it to finish." };
  }
  mysqlRecoveryLock = true;
  try {
    const cfg = readConfig().mysql || {};
    const binPath = (entry && entry.cwd) || (entry && entry.path) || cfg.path || "C:\\xampp\\mysql\\bin";
    const command = (entry && entry.command) || cfg.command || "mysqld.exe --defaults-file=C:\\xampp\\mysql\\bin\\my.ini --standalone";
    const dataDir = path.resolve(binPath, "..", "data");
    const mysqlCfg = { path: binPath, command };

    const port = await mysqlPortOwner(binPath);
    if (port.owner === "foreign") {
      return { ok: false, key: "mysql", message: `Port 3306 is used by another program (PID ${port.pids.join(", ")}). Fix MySQL will not stop it - close it first.` };
    }

    sendStatus({ key: "mysql", name: "MySQL", running: false });
    sendLog("[Auto-Fix] Stopping MySQL cleanly and running the safe repairs...");
    await stopOwnMysqld(binPath);
    const repaired = await repairMysqlFilesSafely(binPath);
    if (repaired.length) sendLog(`[Auto-Fix] ${repaired.join(", ")}`);

    let result = await startMysqlAndVerify(mysqlCfg);
    if (result.ok) {
      await repairSystemTablesAfterRecovery(binPath);
      sendStatus({ key: "mysql", name: "MySQL", running: true });
      return { ok: true, key: "mysql", message: "MySQL repaired and running. Your data was not changed." };
    }

    if (!(entry && entry.allowLogReset)) {
      return {
        ok: false,
        key: "mysql",
        needsLogReset: true,
        message: `The safe repair did not get MySQL running.\n${result.error}\nAn advanced repair can reset the InnoDB redo logs, but it may lose the most recent transactions.`
      };
    }

    // Advanced repair - explicitly confirmed. The old logs are kept, renamed.
    sendLog("[Auto-Fix] Advanced repair confirmed: resetting the InnoDB redo logs (old logs kept).");
    await stopOwnMysqld(binPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const name of ["ib_logfile0", "ib_logfile1"]) {
      const file = path.join(dataDir, name);
      try { if (fs.existsSync(file)) fs.renameSync(file, path.join(dataDir, `${name}.bak-${stamp}`)); } catch { }
    }
    result = await startMysqlAndVerify(mysqlCfg);
    if (result.ok) {
      sendStatus({ key: "mysql", name: "MySQL", running: true });
      return { ok: true, key: "mysql", message: `MySQL running after resetting the redo logs. The old logs were kept as ib_logfile*.bak-${stamp}.` };
    }
    return { ok: false, key: "mysql", message: `MySQL still does not start.\n${result.error}` };
  } finally {
    mysqlRecoveryLock = false;
  }
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
    if (startupLock) {
      return { ok: false, message: "Startup is already in progress. Please wait." };
    }

    const key = svc.key;
    const config = readConfig();

    if (key === "backend") {
      // If user starts backend individually, make sure MySQL is ready first!
      const mysqlPortOpen = await portOpen(3306, 800);
      const mysqlCfg = config.mysql || DEFAULT_CONFIG.mysql;
      let mysqlReady = false;
      if (mysqlPortOpen) {
        const testConn = await verifyDatabaseConnection(mysqlCfg.path, 2000);
        mysqlReady = testConn.ok;
      }

      if (!mysqlReady) {
        sendLog("[STARTUP] POS API requires MySQL. Starting MySQL first...");
        sendStartupProgress({
          state: StartupState.STARTING_MYSQL,
          message: "Starting database for API...",
          step: 1,
          total: 3
        });
        await launchRaw("mysql", mysqlCfg, false);
        const waitMysql = await waitForMySQLReady(mysqlCfg.path, 30000);
        if (!waitMysql.ok) {
          return { ok: false, message: waitMysql.error };
        }
      }

      if (await checkApiHealth(8000, 1000)) {
        sendStatus({ key: "backend", name: "POS API", running: true });
        return { ok: true, key: "backend", message: "POS API is already running and healthy." };
      }

      sendLog("[STARTUP] Starting API...");
      sendStartupProgress({
        state: StartupState.STARTING_API,
        message: "Starting server...",
        step: 2,
        total: 3
      });
      const result = await launchRaw("backend", { path: svc.cwd, command: svc.command }, false);
      if (!result.ok && !result.alreadyRunning) return result;
      const waitApi = await waitForApiReady(8000, 30000);
      if (!waitApi.ok) return { ok: false, message: waitApi.error };
      sendStartupProgress({
        state: StartupState.READY,
        message: "API Server Ready",
        step: 3,
        total: 3
      });
      return { ok: true, key: "backend", message: "POS API is ready on port 8000." };
    }

    if (key === "mysql") {
      const mysqlCfg = { path: svc.cwd, command: svc.command };
      if (await portOpen(3306, 800)) {
        const testConn = await verifyDatabaseConnection(mysqlCfg.path, 2000);
        if (testConn.ok) {
          sendStatus({ key: "mysql", name: "MySQL", running: true });
          return { ok: true, key: "mysql", message: "MySQL was already running and ready on port 3306." };
        }
      }
      const result = await launchRaw("mysql", mysqlCfg, false);
      if (!result.ok && !result.alreadyRunning) return result;
      const waitMysql = await waitForMySQLReady(mysqlCfg.path, 30000);
      if (!waitMysql.ok) return { ok: false, message: waitMysql.error };
      return { ok: true, key: "mysql", message: "MySQL is up and accepting connections on port 3306." };
    }

    return launch(key, { path: svc.cwd, command: svc.command });
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

  ipcMain.handle("service:status", async () => {
    const state = {};
    const mysqlUp = await portOpen(SERVICES.mysql.port, 600);
    state.mysql = mysqlUp;
    const apiHealthy = await checkApiHealth(SERVICES.backend.port, 800);
    state.backend = apiHealthy;
    const adminUp = await portOpen(SERVICES.admin.port, 600);
    state.admin = adminUp;
    return state;
  });

  ipcMain.handle("service:run-all", async (_e, cfg) => {
    return orchestratedStartup(cfg);
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
