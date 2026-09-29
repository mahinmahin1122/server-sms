const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "CHANGE_ME_NOW";

if (ACCESS_TOKEN === "CHANGE_ME_NOW") {
  console.warn("WARNING: Set ACCESS_TOKEN to a long random value before Internet use.");
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({ok: true, service: "sms-cloud"}));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocket.Server({server: httpServer, path: "/ws"});
const phones = new Map();
const pcs = new Set();

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function publicDevices() {
  return [...phones.values()].map(p => ({
    deviceId: p.deviceId,
    model: p.model,
    android: p.android,
    ip: p.ip,
    connected: true
  }));
}

function broadcastDevices() {
  const msg = {type: "devices", devices: publicDevices()};
  for (const pc of pcs) safeSend(pc, msg);
}

function authOk(msg) {
  return msg && msg.type === "auth" && msg.token === ACCESS_TOKEN &&
         (msg.role === "phone" || msg.role === "pc");
}

wss.on("connection", (ws, req) => {
  let role = null;
  let deviceId = null;
  const ip = req.socket.remoteAddress || "";

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { safeSend(ws, {type: "error", message: "Invalid JSON"}); return; }

    if (!role) {
      if (!authOk(msg)) {
        safeSend(ws, {type: "auth_failed", message: "Authentication failed"});
        ws.close(1008, "Authentication failed");
        return;
      }

      role = msg.role;

      if (role === "phone") {
        deviceId = String(msg.deviceId || "").trim();
        if (!deviceId) {
          safeSend(ws, {type: "error", message: "Missing deviceId"});
          ws.close(1008, "Missing deviceId");
          return;
        }

        const old = phones.get(deviceId);
        if (old && old.ws !== ws) {
          try { old.ws.close(4000, "Replaced by a new connection"); } catch {}
        }

        phones.set(deviceId, {
          ws,
          deviceId,
          model: String(msg.model || "Android"),
          android: String(msg.android || ""),
          ip
        });

        safeSend(ws, {type: "auth_ok", role: "phone"});
        broadcastDevices();
        console.log(`PHONE connected ${deviceId} ${ip}`);
      } else {
        pcs.add(ws);
        safeSend(ws, {type: "auth_ok", role: "pc"});
        safeSend(ws, {type: "devices", devices: publicDevices()});
        console.log(`PC connected ${ip}`);
      }
      return;
    }

    if (role === "pc") {
      if (msg.type === "devices") {
        safeSend(ws, {type: "devices", devices: publicDevices()});
        return;
      }

      if (msg.type === "request_sms") {
        const target = phones.get(String(msg.deviceId || ""));
        if (!target) {
          safeSend(ws, {type: "error", message: "Device is not connected"});
          return;
        }
        safeSend(target.ws, {type: "request_sms", requestId: String(msg.requestId || "")});
        return;
      }
    }

    if (role === "phone") {
      if (msg.type === "sms_batch" || msg.type === "sms_end" || msg.type === "sms_new") {
        for (const pc of pcs) {
          safeSend(pc, {...msg, deviceId});
        }
      }
    }
  });

  ws.on("close", () => {
    if (role === "pc") {
      pcs.delete(ws);
      return;
    }

    if (role === "phone" && deviceId) {
      const current = phones.get(deviceId);
      if (current && current.ws === ws) {
        phones.delete(deviceId);
        broadcastDevices();
        console.log(`PHONE disconnected ${deviceId}`);
      }
    }
  });

  ws.on("error", () => {});
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`SMS Cloud server listening on 0.0.0.0:${PORT}`);
  console.log(`WebSocket path: /ws`);
});
