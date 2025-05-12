import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import { Server } from "socket.io";

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

  // In your server-side socket event handlers

  // Server-side socket event handlers
  const connectedLaptops = new Map();

  socket.on("largeFileTransmissionStart", (metadata) => {
    const { requestId } = metadata;
    const laptop = connectedLaptops.get(socket.id);

    if (laptop) {
      // Initialize transmission state
      laptop.transmissions = laptop.transmissions || {};
      laptop.transmissions[requestId] = {
        ...metadata,
        chunks: new Array(metadata.totalChunks).fill(null),
        receivedChunks: 0,
        startTime: Date.now(),
      };

      debugLog(`Large file transmission started:`, metadata);
    }
  });

  socket.on("largeFileChunk", (chunkData) => {
    const { requestId, chunkIndex, totalChunks, data } = chunkData;
    const laptop = connectedLaptops.get(socket.id);

    if (laptop && laptop.transmissions && laptop.transmissions[requestId]) {
      const transmission = laptop.transmissions[requestId];

      // Check if chunk already received
      if (transmission.chunks[chunkIndex] === null) {
        transmission.chunks[chunkIndex] = data;
        transmission.receivedChunks++;

        // Acknowledge chunk receipt
        socket.emit(`chunkAcknowledged_${requestId}_${chunkIndex}`, {
          requestId,
          chunkIndex,
          receivedAt: Date.now(),
          chunkSize: data.length,
        });

        debugLog(`Received chunk ${chunkIndex + 1}/${totalChunks}`, {
          receivedChunks: transmission.receivedChunks,
        });
      }
    }
  });

  socket.on("largeFileTransmissionEnd", (endMetadata) => {
    const { requestId, sentChunks, totalChunks, failedChunks, duration } =
      endMetadata;
    const laptop = connectedLaptops.get(socket.id);

    if (laptop && laptop.transmissions && laptop.transmissions[requestId]) {
      const transmission = laptop.transmissions[requestId];

      // Check if all chunks received
      const completeChunks = transmission.chunks.filter(
        (chunk) => chunk !== null,
      );

      if (completeChunks.length === totalChunks) {
        const completeData = completeChunks.join("");

        // Respond with successful transmission
        const pendingRequest = laptop.pendingRequests.get(requestId);
        if (pendingRequest) {
          pendingRequest.res.json({
            success: true,
            message: `File received successfully (${completeChunks.length} chunks)`,
            output: {
              base64: completeData,
              originalFilepath: transmission.filepath,
              transmissionTime: duration,
            },
          });
        }
      } else {
        // Partial or failed transmission
        const pendingRequest = laptop.pendingRequests.get(requestId);
        if (pendingRequest) {
          pendingRequest.res.status(500).json({
            success: false,
            message: `Incomplete file transfer. Received ${completeChunks.length}/${totalChunks} chunks`,
            failedChunks,
          });
        }
      }

      // Clean up transmission state
      delete laptop.transmissions[requestId];
      laptop.pendingRequests.delete(requestId);
    }
  });

  socket.on("commandResponseStart", (data) => {
    const { requestId } = data;
    const laptop = connectedLaptops.get(socket.id);

    if (laptop && laptop.pendingRequests.has(requestId)) {
      const pendingRequest = laptop.pendingRequests.get(requestId);
      pendingRequest.chunks = new Array(data.totalChunks).fill(null);
      pendingRequest.receivedChunks = 0;
      pendingRequest.totalChunks = data.totalChunks;
      pendingRequest.filepath = data.filepath;
      pendingRequest.checksum = data.checksum;
      pendingRequest.startTime = Date.now();
    }
  });

  socket.on("commandResponseChunk", (data) => {
    const {
      requestId,
      chunkIndex,
      data: chunkData,
      transmissionMetadata,
    } = data;
    const laptop = connectedLaptops.get(socket.id);

    if (laptop && laptop.pendingRequests.has(requestId)) {
      const pendingRequest = laptop.pendingRequests.get(requestId);

      // Check if chunk already received
      if (pendingRequest.chunks[chunkIndex] === null) {
        pendingRequest.chunks[chunkIndex] = chunkData;
        pendingRequest.receivedChunks++;

        // Acknowledge chunk receipt with timing info
        socket.emit(`chunkAcknowledged_${requestId}_${chunkIndex}`, {
          receivedAt: Date.now(),
          chunkSize: chunkData.length,
          ...transmissionMetadata,
        });

        // Log chunk receipt
        console.log(
          `Received chunk ${chunkIndex + 1}/${pendingRequest.totalChunks}`,
        );
      }
    }
  });

  socket.on("commandResponseEnd", (data) => {
    const { requestId, sentChunks } = data;
    const laptop = connectedLaptops.get(socket.id);

    if (laptop && laptop.pendingRequests.has(requestId)) {
      const pendingRequest = laptop.pendingRequests.get(requestId);

      // Check if all chunks received
      const completeChunks = pendingRequest.chunks.filter(
        (chunk) => chunk !== null,
      );

      if (completeChunks.length === pendingRequest.totalChunks) {
        const completeData = completeChunks.join("");

        pendingRequest.res.json({
          success: true,
          message: `Screenshot received successfully (${completeChunks.length} chunks)`,
          output: {
            base64: completeData,
            originalFilepath: pendingRequest.filepath,
            transmissionTime: Date.now() - pendingRequest.startTime,
          },
        });
      } else {
        pendingRequest.res.status(500).json({
          success: false,
          message: `Incomplete screenshot data. Received ${completeChunks.length}/${pendingRequest.totalChunks} chunks`,
        });
      }

      laptop.pendingRequests.delete(requestId);
    }
  });

  socket.on("commandResponseError", (data) => {
    const { requestId, message, failedChunks } = data;
    const laptop = connectedLaptops.get(socket.id);

    if (laptop && laptop.pendingRequests.has(requestId)) {
      const pendingRequest = laptop.pendingRequests.get(requestId);

      pendingRequest.res.status(500).json({
        success: false,
        message: message || "Error during screenshot transmission",
        failedChunks: failedChunks || [],
      });

      laptop.pendingRequests.delete(requestId);
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
