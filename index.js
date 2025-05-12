import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import { Server } from "socket.io";

dotenv.config();
const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
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
); // Middleware to check API key
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

  console.log(type);
  // ✅ Emit only once with requestId
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
  }, 30000); // 10 second timeout

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

  // Handle command responses
  socket.on("commandResponse", (data) => {
    const { requestId, success, message, output } = data;
    const laptop = connectedLaptops.get(socket.id);

    if (laptop && laptop.pendingRequests.has(requestId)) {
      const { res } = laptop.pendingRequests.get(requestId);
      laptop.pendingRequests.delete(requestId);

      res.json({ success, message, output });
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    connectedLaptops.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
