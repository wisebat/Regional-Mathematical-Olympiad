/* Public API address only. The Discord webhook stays in the server's private .env file. */
window.RMO_CONFIG = Object.freeze({
  // Local previews and VS Code Live Server use the logging server running on port 3000.
  // For separately hosted pages, replace this value with your logging server's HTTPS origin.
  loggingApiBaseUrl: ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)
    ? "http://127.0.0.1:3000"
    : "",
});
