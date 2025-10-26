import { chromium } from "playwright";

// The WebSocket endpoint for the existing Playwright server.
const wsPath = process.env.WS_PATH;

let state = {
    status: 'stopped', // Can be: stopped, starting, running, stopping, error
    status_message: 'Room is stopped.',
    room_url: null,
    browser: null,
    page: null,
};

let onStateUpdate = () => {}; // Placeholder for the callback

export function setStateUpdateCallback(callback) {
    if (typeof callback === 'function') {
        onStateUpdate = callback;
    }
}

function updateState(newState) {
    state = { ...state, ...newState };
    console.log(`[State Update] => ${state.status_message}`);
    onStateUpdate();
}

export function getRoomState() {
    return {
        status: state.status,
        status_message: state.status_message,
        room_url: state.room_url,
    };
}

async function initializeRoom(token = null) {
    if (!state.page) return;

    await state.page.exposeFunction("onRoomLinkSet", (url) => {
        console.log("==================================================");
        console.log(`🎉 Haxball Room URL: ${url}`);
        console.log("==================================================");
        updateState({ room_url: url, status: 'running', status_message: 'Room is running successfully!' });
    });

    updateState({ status_message: 'Initializing Haxball room...' });

    const roomConfig = {
        roomName: "Jules's Awesome Haxball Room",
        maxPlayers: 12,
        public: false,
        noPlayer: true,
        token: token, // Pass the token here
    };

    await state.page.evaluate((config) => {
        const room = window.HBInit(config);
        room.setDefaultStadium("Rounded");
        room.setScoreLimit(0);
        room.setTimeLimit(3);
        room.onRoomLink = (url) => window.onRoomLinkSet(url);

        // Optional: Admin management logic
        function updateAdmins() {
            const players = room.getPlayerList();
            if (players.length > 0 && !players.some(p => p.admin)) {
                room.setPlayerAdmin(players[0].id, true);
            }
        }
        room.onPlayerJoin = updateAdmins;
        room.onPlayerLeave = updateAdmins;
    }, roomConfig);

    updateState({ status_message: 'Room script executed. Waiting for room link...' });
}

export async function start(token) {
    if (!token) {
        throw new Error('A reCAPTCHA token is required to start the room.');
    }
    if (state.status !== 'stopped') {
        throw new Error(`Cannot start room when status is ${state.status}.`);
    }

    if (!wsPath) {
        const errorMsg = "FATAL: The WS_PATH environment variable is not set.";
        updateState({ status: 'error', status_message: errorMsg });
        throw new Error(errorMsg);
    }

    updateState({ status: 'starting', status_message: 'Connecting to Playwright server...' });

    try {
        const browser = await chromium.connect(wsPath, { timeout: 20000 });
        updateState({ browser, status_message: 'Connected to Playwright. Opening new page...' });

        const context = await browser.newContext();
        const page = await context.newPage();
        updateState({ page, status_message: 'Navigating to Haxball headless URL...' });

        page.on('close', () => stop('Page was closed.'));
        page.on("console", (msg) => console.log(`[Browser]: ${msg.text()}`));

        await page.goto("https://html5.haxball.com/headless", { timeout: 30000 });
        updateState({ status_message: 'Waiting for Haxball to load...' });

        await page.waitForFunction(() => window.HBInit, null, { timeout: 30000 });

        await initializeRoom(token);

    } catch (error) {
        console.error("❌ An error occurred during startup:", error);
        await stop(`Error during startup: ${error.message}`);
        throw error; // Re-throw to inform the caller
    }
}

export async function stop(reason = 'Room stopped by admin.') {
    if (state.status === 'stopped') return;

    updateState({ status: 'stopping', status_message: `Stopping room: ${reason}` });

    if (state.page && !state.page.isClosed()) {
        try {
            await state.page.close();
        } catch (e) {
            console.error("Ignoring error while closing page:", e.message);
        }
    }

    // We connected to an existing browser server, so we should not close the browser itself.
    // We just disconnect from it.
    if (state.browser && state.browser.isConnected()) {
        try {
            await state.browser.disconnect();
        } catch (e) {
            console.error("Ignoring error while disconnecting browser:", e.message);
        }
    }

    // Reset state
    updateState({
        status: 'stopped',
        status_message: reason,
        room_url: null,
        browser: null,
        page: null,
    });
}
