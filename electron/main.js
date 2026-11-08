const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");

let serverProcess = null;
let serverLog = null;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) return resolve();
        retry();
      });
      request.on("error", retry);
      request.setTimeout(2000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error("Server did not start in time"));
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

function serverDirectory() {
  if (app.isPackaged) return path.join(process.resourcesPath, "standalone");
  return path.join(__dirname, "..", ".next", "standalone");
}

async function startServer() {
  const directory = serverDirectory();
  const entry = path.join(directory, "server.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`Server build not found at ${entry}. Run "npm run desktop" first.`);
  }

  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });
  serverLog = fs.openSync(path.join(userData, "server.log"), "a");

  const port = await getFreePort();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    // Use a centrally hosted PostgreSQL database when configured. Otherwise keep
    // the per-device embedded database for standalone/offline operation.
    DATABASE_URL:
      process.env.HISAB_DATABASE_URL?.trim() || `file:${path.join(userData, "pg")}`,
  };

  serverProcess = spawn(process.execPath, [entry], {
    cwd: directory,
    env,
    stdio: ["ignore", serverLog, serverLog],
    windowsHide: true,
  });

  serverProcess.on("exit", () => {
    serverProcess = null;
  });

  await waitForServer(`http://127.0.0.1:${port}/login`, 90000);
  return `http://127.0.0.1:${port}`;
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch {
      // ignore
    }
    serverProcess = null;
  }
  if (serverLog !== null) {
    try {
      fs.closeSync(serverLog);
    } catch {
      // ignore
    }
    serverLog = null;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    let baseUrl;
    try {
      baseUrl = await startServer();
    } catch (error) {
      dialog.showErrorBox(
        "تعذر تشغيل حساب",
        `${error instanceof Error ? error.message : String(error)}\n\n${path.join(app.getPath("userData"), "server.log")}`,
      );
      app.quit();
      return;
    }

    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1024,
      minHeight: 700,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#1e6756",
      icon: path.join(__dirname, "icon.png"),
      title: "حساب",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    window.once("ready-to-show", () => window.show());

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(baseUrl)) return { action: "allow" };
      void shell.openExternal(url);
      return { action: "deny" };
    });

    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(baseUrl)) {
        event.preventDefault();
        void shell.openExternal(url);
      }
    });

    await window.loadURL(`${baseUrl}/`);
  });

  app.on("window-all-closed", () => {
    stopServer();
    app.quit();
  });

  app.on("before-quit", stopServer);
}
