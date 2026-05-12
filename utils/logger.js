// utils/logger.js

/**
 * Simple logger utility with timestamps and log levels
 */
const logger = {
  info: (message, data = null) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [INFO] ${message}`);
    if (data) console.log(data);
  },

  error: (message, error = null) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ERROR] ${message}`);
    if (error) {
      if (error instanceof Error) {
        console.error(`${error.message}`); 
        console.error(error.stack);
      } else {
        console.error(error);
      }
    }
  },

  warn: (message, data = null) => {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] [WARN] ${message}`);
    if (data) console.warn(data);
  },

  debug: (message, data = null) => {
    // Only log debug in development
    if (process.env.NODE_ENV !== "production") {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [DEBUG] ${message}`);
      if (data) console.log(data);
    }
  },
};

module.exports = logger;
