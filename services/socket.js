// Real-time layer (Socket.IO). Authenticates each connection with the same JWT
// the REST API uses, then drops the socket into its organisation room so we can
// broadcast contact-inbox events per tenant (and into a per-user room for
// targeted events). Controllers emit via emitToOrg / emitToUser.
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const User = require("../models/user");

let io = null;

// Mirror the HTTP CORS policy so the websocket accepts the same origins.
function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser clients
  if (/^https?:\/\/(localhost|[a-z0-9-]+\.localhost)(:\d+)?$/.test(origin)) return true;
  if (process.env.CORS_DOMAIN) {
    const escaped = process.env.CORS_DOMAIN.replace(/\./g, "\\.");
    if (new RegExp(`^https://([a-z0-9-]+\\.)?${escaped}$`).test(origin)) return true;
  }
  if (origin === process.env.CLIENT_URL) return true;
  return false;
}

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: (origin, cb) =>
        isAllowedOrigin(origin) ? cb(null, true) : cb(new Error("Not allowed by CORS")),
      credentials: true,
      methods: ["GET", "POST"],
    },
  });

  // Handshake auth: token (and tenant slug) are passed in socket.handshake.auth.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error("No token"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select("name email role organisationId");
      if (!user || !["admin", "superadmin"].includes(user.role)) {
        return next(new Error("Unauthorized"));
      }
      socket.user = user;
      next();
    } catch (err) {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const orgId = socket.user?.organisationId;
    if (orgId) socket.join(`org:${orgId}`);
    socket.join(`user:${socket.user._id}`);
  });

  return io;
}

function getIO() {
  return io;
}

function emitToOrg(orgId, event, payload) {
  if (io && orgId) io.to(`org:${orgId}`).emit(event, payload);
}

function emitToUser(userId, event, payload) {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
}

module.exports = { initSocket, getIO, emitToOrg, emitToUser };
