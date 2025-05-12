import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";

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

// Middleware to check API key
const checkApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
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
  const { laptopId, type } = req.body;

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

  // Emit only once with requestId
  io.to(laptopId).emit("command", { type: type, requestId });
});

// API endpoint to execute command
app.post("/api/control/execute", checkApiKey, (req, res) => {
  const { laptopId, command } = req.body;

  if (!laptopId || !command) {
    return res
      .status(400)
      .json({ success: false, message: "Laptop ID and command are required" });
  }

  const laptop = connectedLaptops.get(laptopId);
  if (!laptop) {
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
  }, 500000);

  // Send command to the specific laptop
  io.to(laptopId).emit("command", { type: "execute", command, requestId });
});

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // Handle laptop registration
  socket.on("register", (data) => {
    const { name, secret } = data;

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

  // Handle command responses with improved large payload handling
  socket.on("commandResponse", (data) => {
    console.log(data);
    const { requestId, success, message, output } = data;
    const laptop = connectedLaptops.get(socket.id);

    if (laptop && laptop.pendingRequests.has(requestId)) {
      const { res } = laptop.pendingRequests.get(requestId);
      laptop.pendingRequests.delete(requestId);

      // Handle screenshot with base64 data
      if (output && typeof output === "object" && output.base64) {
        try {
          res.json({
            success,
            message,
            output: {
              base64: output.base64,
              originalFilepath: output.filepath,
            },
          });
        } catch (error) {
          console.error("Error saving screenshot:", error);
          res.json({
            success: false,
            message: "Error processing screenshot",
            error: error.message,
          });
        }
      } else {
        // Regular response handling
        res.json({ success, message, output });
      }
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
  socket.on("keep-alive", (data) => {
    debugLog("Received keep-alive message for request:", data.requestId);
    // Reset timeout for the request
    const laptop = connectedLaptops.get(socket.id);
    if (laptop && laptop.pendingRequests.has(data.requestId)) {
      const pendingRequest = laptop.pendingRequests.get(data.requestId);
      pendingRequest.timeout = setTimeout(() => {
        // Handle timeout
      }, 10000000);
    }
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
