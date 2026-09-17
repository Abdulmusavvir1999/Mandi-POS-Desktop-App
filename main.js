const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");

const PRELOAD = path.join(__dirname, "preload.js");
const INDEX = path.join(__dirname, "index.html");
const TRAY_ICON = path.join(__dirname, "tray.png");

// Pos-Desktop sits next to Pos-Backend and Pos-Frontend in the repo, so the
// defaults follow the folder rather than one machine's absolute paths.
const REPO = path.join(__dirname, "..");

const DEFAULT_CONFIG = {
  mysql: {
    path: "C:\\xampp\\mysql\\bin",
    command: "mysqld.exe --defaults-file=C:\\xampp\\mysql\\bin\\my.ini --standalone"
  },
  backend: {
    path: path.join(REPO, "Pos-Backend"),
    command: "npm run dev"
  },
  admin: {
    path: path.join(REPO, "Pos-Frontend"),
    command: "npm start"
  }
};

// hidden = background process, no console window, like the XAMPP Start button.
// terminal = its own cmd window so you can watch the logs.
const SERVICES = {
  mysql: { name: "MySQL", mode: "hidden", port: 3306, waitForPortMs: 25000 },
  backend: { name: "POS API", mode: "terminal", port: 8000, waitAfterMs: 3000 },
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
  tray.setToolTip("Mandi POS Launcher - services are running");
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
    return merged;
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), "utf8");
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

async function stop(key, entry) {
  const svc = SERVICES[key] || { name: key };
  const { name, port } = svc;

  if (!port) return { ok: false, key, message: `${name}: no port configured, stop it by hand.` };
  if (!(await portOpen(port))) {
    sendStatus({ key, name, running: false });
    return { ok: true, key, message: `${name} was not running.` };
  }

  if (key === "mysql") {
    await mysqlShutdown(entry && entry.path);
    if (await waitForPortClosed(port, 20000)) {
      sendStatus({ key, name, running: false });
      return { ok: true, key, message: `${name} shut down cleanly.` };
    }
  }

  const pids = await pidsOnPort(port);
  const table = pids.length ? await processTable() : new Map();
  for (const pid of pids) {
    // /T takes the whole tree, so the service dies with its terminal window.
    await run("taskkill", ["/PID", consoleRootOf(pid, table), "/T", "/F"]);
  }
  // Belt and braces for consoles that do expose their title.
  await run("taskkill", ["/F", "/FI", `WINDOWTITLE eq Mandi ${name}*`], 8000);

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

async function launch(key, entry) {
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

  // Starting a second mysqld on a live port just errors out, so check first.
  if (svc.port && (await portOpen(svc.port))) {
    sendStatus({ key, name, running: true });
    return { ok: true, key, message: `${name} was already running on port ${svc.port}.` };
  }

  try {
    const args = mode === "hidden"
      ? ["/c", command]
      : ["/c", "start", `Mandi ${name}`, "cmd", "/k", command];

    // cmd.exe looks a bare "mysqld.exe" up on PATH, and it only falls back to
    // the current folder when NoDefaultCurrentDirectoryInExePath is unset -
    // Git Bash and some IDE terminals set it to 1, and the app inherits it, so
    // the command dies with "is not recognized" before it writes any log.
    // Putting the service folder on PATH makes it resolve either way.
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      const lower = k.toLowerCase();
      if (lower === "path" || lower === "nodefaultcurrentdirectoryinexepath") continue;
      env[k] = v;
    }
    env.PATH = cwd + ";" + (process.env.PATH || "");

    // A terminal service shows its own output; a hidden one would lose it.
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

    // The child has its own copy of the handle now.
    if (outFd !== null) { try { fs.closeSync(outFd); } catch { /* already gone */ } }

    child.on("error", (err) => {
      sendStatus({ key, name, running: false, error: err.message });
    });
    child.unref();

    if (svc.waitForPortMs) {
      const up = await waitForPort(svc.port, svc.waitForPortMs || 20000);
      sendStatus({ key, name, running: up });
      return up
        ? { ok: true, key, message: `${name} is up on port ${svc.port}.` }
        : {
            ok: false,
            key,
            message: `${name}: started but port ${svc.port} never opened. ${lastLoggedError(key, cwd) || "Check " + path.join(cwd, "..", "data") + " error logs."}`
          };
    }

    sendStatus({ key, name, running: true });
    return { ok: true, key, message: `${name} terminal started - ${command}` };
  } catch (err) {
    return { ok: false, key, message: `${name}: ${err.message}` };
  }
}

async function stopEverything(cfg) {
  const config = cfg || readConfig();
  const results = [];
  // Reverse of the start order: the apps go down before the database.
  for (const key of [...RUN_ORDER].reverse()) {
    results.push(await stop(key, config[key] || {}));
  }
  return results;
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

  ipcMain.handle("dialog:browse", async (_e, current) => {
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      defaultPath: current && fs.existsSync(current) ? current : undefined
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("service:run", (_e, svc) =>
    launch(svc.key, { path: svc.cwd, command: svc.command })
  );

  ipcMain.handle("service:stop", (_e, svc) => stop(svc.key, { path: svc.cwd }));

  ipcMain.handle("service:stop-all", (_e, cfg) => stopEverything(cfg));

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
    for (const key of RUN_ORDER) {
      const port = SERVICES[key].port;
      state[key] = port ? await portOpen(port, 700) : null;
    }
    return state;
  });

  ipcMain.handle("service:run-all", async (_e, cfg) => {
    const results = [];
    for (const key of RUN_ORDER) {
      const result = await launch(key, (cfg && cfg[key]) || {});
      results.push(result);
      // MySQL is gated on its port, so only the terminal services need a pause.
      const pause = SERVICES[key].waitAfterMs;
      if (result.ok && pause) await wait(pause);
    }
    return results;
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
