import { chromium } from "playwright";

// The WebSocket endpoint for the existing Playwright server.
// 'playwright-server' is the service name in the docker network.
const wsPath = process.env.WS_PATH;

if (!wsPath) {
  console.error("❌ ERROR: The WS_PATH environment variable is not set.");
  console.error(
    '   Please set it to the WebSocket path used by your Playwright server (e.g., "/" or "/my-path").'
  );
  process.exit(1);
}

// // Ensure the path starts with a slash
// const fullWsPath = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
// const wsEndpoint = `ws://playwright-server:53333${fullWsPath}`;

console.log("Haxball Server starting...");

(async () => {
  try {
    console.log(`Attempting to connect to Playwright server`);

    // Connect to the existing browser server.
    const browser = await chromium.connect(wsPath);

    console.log("✅ Successfully connected to Playwright server.");

    const context = await browser.newContext();
    const page = await context.newPage();

    // Log browser console messages to the Node.js console for debugging
    page.on("console", (msg) => console.log(`[Browser]: ${msg.text()}`));

    console.log("Navigating to Haxball headless URL...");
    await page.goto("https://html5.haxball.com/headless");
    console.log("✅ Navigation complete.");

    // Wait until the HBInit function is loaded on the page
    await page.waitForFunction(() => window.HBInit, null, { timeout: 30000 });
    console.log("✅ HBInit function is now available.");

    // Expose a function from Node.js to the browser, so the browser can send the room link back to us.
    await page.exposeFunction("onRoomLinkSet", (url) => {
      console.log("==================================================");
      console.log(`🎉 Haxball Room URL: ${url}`);
      console.log("==================================================");
    });

    console.log("Initializing Haxball room...");
    // This code block is executed in the browser's context
    await page.evaluate(() => {
      const room = HBInit({
        roomName: "Jules's Awesome Haxball Room",
        maxPlayers: 12,
        public: false,
        noPlayer: true, // Recommended for headless hosts
      });

      room.setDefaultStadium("Classic");
      room.setScoreLimit(5);
      room.setTimeLimit(5);

      // Set the onRoomLink callback to call the function we exposed from Node.js
      room.onRoomLink = (url) => {
        window.onRoomLinkSet(url);
      };

      function updateAdmins() {
        // Get all players
        var players = room.getPlayerList();
        if (players.length == 0) return; // No players left, do nothing.
        if (players.find((player) => player.admin) != null) return; // There's an admin left so do nothing.
        room.setPlayerAdmin(players[0].id, true); // Give admin to the first non admin player in the list
      }

      room.onPlayerJoin = function (player) {
        updateAdmins();
      };

      room.onPlayerLeave = function (player) {
        updateAdmins();
      };
    });
    console.log("✅ Room initialization script sent.");
    console.log(
      "🕒 Waiting for room link... (This may take a moment for the recaptcha to solve)."
    );

    // The script will stay running because the Playwright connection is active.
    // If the connection is lost, the script will exit.
  } catch (error) {
    console.error("❌ An error occurred during Haxball server setup:");
    console.error(error);
    process.exit(1);
  }
})();
