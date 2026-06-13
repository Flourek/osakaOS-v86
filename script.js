"use strict";

/* ==========================================================================
   STATE & CONSTANTS
   ========================================================================== */
let isMouseSynced = false;
let inputDisabled = true;
let escTriggeredByShiftAlt = false;
let escTriggeredByCtrlC = false;
let ignoreNextMouseDelta = false;
let savedState = null;
let emulator;

const url = path => new URL(path, location.href).href;
/* ==========================================================================
   INITIALIZATION
   ========================================================================== */
window.onload = function () {
    setupBlockInput(2000);
    setupKeyboardOverrides();

    initEmulator();
    setupNetworkDiagnostics();
    setupResizeHandling();
    setupMouseHandling();
    setupPointerLockClick();


    autoLoadState();
    document.getElementById("controls-bar").addEventListener("mousedown", e => e.stopPropagation());
    document.getElementById("controls-bar").addEventListener("click", e => e.stopPropagation());

    document.getElementById("textmode").addEventListener("mousedown", e => {
        if (e.target.closest("button")) e.stopPropagation();
    });
    document.getElementById("textmode").addEventListener("click", e => {
        if (e.target.closest("button")) e.stopPropagation();
    });

};


/* ==========================================================================
   EMULATOR SETUP
   ========================================================================== */
function initEmulator() {
    console.log("[EMULATOR] Initializing v86 with networking and audio...");

    emulator = new V86({
        wasm_path: url("./v86/v86.wasm"),
        memory_size: 512 * 1024 * 1024,
        vga_memory_size: 512 * 1024 * 1024,

        screen_container: document.getElementById("screen"),
        bios: { url: url("../bios/seabios.bin") },
        vga_bios: { url: url("../bios/vgabios.bin") },

        hda: { url: url("../osakaOS.iso") },

        // Network relay for external connectivity
        network_relay_url: "wss://relay.widgetry.org/",

        autostart: true,
        disable_mouse: true // We manually send mouse events using the bus
    });

    // Force audio output to mono (both ears hear the same sound)
    forceAudioMono();

    // Log emulator boot and network status
    emulator.add_listener("emulator-started", () => {
        console.log("[NET] Emulator started");
        console.log("[AUDIO] PC speaker output enabled - beeps will play in browser");
        console.log("[NET] Network relay configured - osakaOS should have external connectivity");
        console.log("[NET] Try: ping 8.8.8.8 or ping google.com from osakaOS");

        setTimeout(() => {
            toggleControls();
        }, 2000);
    });

}


/* ==========================================================================
   INPUT BLOCKING
   ========================================================================== */

function setupBlockInput(durationMs) {
    // Release input lock after durationMs
    setTimeout(() => { inputDisabled = false; }, durationMs);

    const blockInput = (e) => {
        if (inputDisabled) {
            e.stopPropagation();
            e.stopImmediatePropagation();
            e.preventDefault();
            return false;
        }
    };

    const eventsToBlock = [
        "keydown", "keyup", "keypress",
        "mousedown", "mouseup", "mousemove",
        "click", "dblclick", "wheel"
    ];

    eventsToBlock.forEach(event => {
        window.addEventListener(event, blockInput, true);
    });
}

function resumeAudio() {
    emulator.speaker_adapter.audio_context.resume();
    forceAudioMono();
}

function forceAudioMono() {
    const mixer = emulator.speaker_adapter?.mixer;
    if (!mixer || !mixer.node_merger) return;
    const ctx = emulator.speaker_adapter.audio_context;
    mixer.node_merger.disconnect();
    const monoNode = ctx.createGain();
    monoNode.channelCountMode = "explicit";
    monoNode.channelCount = 1;
    mixer.node_merger.connect(monoNode);
    monoNode.connect(ctx.destination);
}

/* ==========================================================================
   KEYBOARD HANDLING
   ========================================================================== */
function setupKeyboardOverrides() {
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
}


function isPointerLocked() {
    return document.pointerLockElement !== null;
}

function handleKeyDown(e) {
    if (!isPointerLocked()) {
        e.stopImmediatePropagation();
        return;
    }

    resumeAudio();

    // 2. Prevent isolated Win (Meta) key from reaching v86
    if ((e.key === "Meta" || e.key === "OS") && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
    }

    // 3. Unbind default physical Escape key unconditionally
    if (e.code === "Escape" || e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
    }

    // 4. Shift+Alt triggers custom Escape injection (Make code: 0x01)
    if (e.shiftKey && e.altKey && (e.key === "Shift" || e.key === "Alt")) {
        e.stopImmediatePropagation();
        e.preventDefault();
        emulator?.keyboard_send_scancodes([0x01]);
        escTriggeredByShiftAlt = true;
        return;
    }

    // 5. Ctrl+C also triggers Escape injection (Make code: 0x01)
    // if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
    //     e.stopImmediatePropagation();
    //     e.preventDefault();
    //     emulator?.keyboard_send_scancodes([0x01]);
    //     escTriggeredByCtrlC = true;
    //     return;
    // }
}

function handleKeyUp(e) {
    if (!isPointerLocked()) return;
    // 1. Block keyup for isolated Win key so v86 doesn't process the release
    if ((e.key === "Meta" || e.key === "OS") && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
    }

    // 2. Block physical Escape keyup
    if (e.code === "Escape" || e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
    }

    // 3. Send Escape (Break code: 0x81) when releasing Shift or Alt (if previously triggered)
    if ((e.key === "Shift" || e.key === "Alt") && escTriggeredByShiftAlt) {
        emulator?.keyboard_send_scancodes([0x81]);
        escTriggeredByShiftAlt = false;
    }

    // 4. Send Escape (Break code: 0x81) when releasing C key (if Ctrl+C was triggered)
    // if ((e.key === 'c' || e.key === 'C') && escTriggeredByCtrlC) {
    //     emulator?.keyboard_send_scancodes([0x81]);
    //     escTriggeredByCtrlC = false;
    // }
}


/* ==========================================================================
   SCREEN RESIZING
   ========================================================================== */
function setupResizeHandling() {
    const forceResize = () => {
        const canvas = document.querySelector("#screen canvas");
        if (!canvas) return;

        canvas.style.width = "100vw";
        canvas.style.height = "100vh";
    };

    // Force application of resize constraints periodically and on event triggers
    setInterval(forceResize, 250);
    window.addEventListener("resize", forceResize);
    new ResizeObserver(forceResize).observe(document.getElementById("screen"));
}


/* ==========================================================================
   MOUSE HANDLING & POINTER LOCK
   ========================================================================== */

/**
 * Setup network diagnostics and logging
 */
function setupNetworkDiagnostics() {
    if (!emulator) return;

    console.log("[NET] Emulator initialized, waiting for network events...");

    // Monitor for network-related events and logs
    const originalLog = emulator.serial0_send;

    // Try to detect if network relay connects
    setTimeout(() => {
        if (emulator && emulator.get_state) {
            try {
                const state = emulator.get_state();
                console.log("[NET] Emulator state:", state);
            } catch (e) {
                // state API might not be available
            }
        }
        console.log("[NET] Network relay status: attempting connection to wss://relay.widgetry.org/");
    }, 2000);

    // Log any driver initialization
    window.addEventListener("message", (e) => {
        if (e.data && e.data.type === "net-event") {
            console.log("[NET] Event:", e.data);
        }
    });
}

/**
 * Searches the v86 object tree for the PS2 Mouse controller to send the activation sequence natively.
 * This fixes the fact that "disable_mouse" prevents true initialization.
 */
function findPS2Controller(obj, depth = 0, cache = new Set()) {
    if (depth > 8 || !obj || typeof obj !== "object") return null;
    if (cache.has(obj)) return null;
    cache.add(obj);

    if (obj.mouse_buffer && typeof obj.mouse_buffer.push === 'function' && obj.mouse_id !== undefined) {
        return obj;
    }

    for (let key in obj) {
        try {
            let res = findPS2Controller(obj[key], depth + 1, cache);
            if (res) return res;
        } catch (e) { }
    }
    return null;
}




/* ==========================================================================
   INDEXED DB — large binary state persistence
   ========================================================================== */

const DB_NAME = "osakaOS";
const DB_STORE = "state";
const DB_KEY = "saved-state";

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function loadStateFromDB() {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, "readonly");
            const req = tx.objectStore(DB_STORE).get(DB_KEY);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch { return null; }
}

async function saveStateToDB(state) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, "readwrite");
        const req = tx.objectStore(DB_STORE).put(state, DB_KEY);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

async function deleteStateFromDB() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, "readwrite");
        const req = tx.objectStore(DB_STORE).delete(DB_KEY);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

/* ==========================================================================
   STATE SAVE / RESTORE
   ========================================================================== */

function saveState() {
    emulator.save_state().then(state => {
        savedState = state;
        saveStateToDB(state);
        updateButtons();
    });
}

function restoreState() {
    if (savedState) {
        emulator.restore_state(savedState);
    }
}

function clearSavedState() {
    savedState = null;
    deleteStateFromDB();
    updateButtons();
}

function updateButtons() {
    const has = savedState !== null;
    for (const el of document.querySelectorAll("#restore-state-btn, #clear-state-btn")) {
        el.style.display = has ? "" : "none";
    }
    toggleControls();
}

function saveStateToFile() {
    emulator.save_state().then(state => {
        const now = new Date();
        const pad = n => String(n).padStart(2, "0");
        const filename = `osakaOS-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.bin`;
        const a = document.createElement("a");
        a.download = filename;
        a.href = URL.createObjectURL(new Blob([state]));
        a.click();
        URL.revokeObjectURL(a.href);
    });
}

function restoreStateFromFile(input) {
    if (!input.files.length) return;
    const reader = new FileReader();
    emulator.stop();
    reader.onload = async function (e) {
        await emulator.restore_state(e.target.result);
        emulator.run();
    };
    reader.readAsArrayBuffer(input.files[0]);
    input.value = "";
}

async function autoLoadState() {
    const state = await loadStateFromDB();
    if (state) {
        savedState = state;
    }
    updateButtons();
}

function setupPointerLockClick() {
    document.getElementById("screen").addEventListener("click", async () => {
        try {
            const screen = document.getElementById("screen");
            if (screen.requestPointerLock) {
                const promise = screen.requestPointerLock();
                if (promise) await promise.catch(() => { });
            }
            if (navigator.keyboard && navigator.keyboard.lock) {
                await navigator.keyboard.lock(["Escape"]).catch(() => { });
            }
        } catch (err) {
            console.warn("Pointer lock could not be acquired: ", err);
        }
    });
}



function toggleControls() {
    const vgacontrols = document.querySelector("#controls #controls-bar");
    if (!isPointerLocked()) {
        vgacontrols.classList.remove("hidden");
        const el = document.querySelector("#textmode > div:last-of-type");
        if (el) {
            el.innerHTML = vgacontrols.outerHTML;
            el.innerHTML = vgacontrols.outerHTML;
        }
    } else {
        vgacontrols.classList.add("hidden");
        emulator?.screen_adapter?.text_update_row(24);
    };
}


function setupMouseHandling() {
    const screenElement = document.getElementById("screen");

    document.addEventListener("pointerlockchange", () => {
        if (document.pointerLockElement === screenElement) {
            ignoreNextMouseDelta = true;

            if (!isMouseSynced && emulator) {
                let ps2 = findPS2Controller(emulator);
                if (ps2) {
                    ps2.mouse_buffer.push(0x00);
                    ps2.mouse_buffer.push(0x00);
                    if (typeof ps2.raise_irq === "function") ps2.raise_irq();
                    isMouseSynced = true;
                }
            }
        } else {
            // showControls();
        }
        toggleControls();
    });

    screenElement.addEventListener("mousedown", async function (e) {
        if (document.pointerLockElement !== screenElement) {
            try {
                if (screenElement.requestPointerLock) {
                    const promise = screenElement.requestPointerLock();
                    if (promise) await promise.catch(() => { });
                }
                if (navigator.keyboard && navigator.keyboard.lock) {
                    await navigator.keyboard.lock(["Escape"]).catch(() => { });
                }
            } catch (err) {
                console.warn("Pointer lock error slightly suppressed: ", err);
            }
            return;
        }

        emulator?.bus?.send("mouse-click", [
            (e.buttons & 1) !== 0,
            (e.buttons & 4) !== 0,
            (e.buttons & 2) !== 0
        ]);

        resumeAudio();

    });

    document.addEventListener("mouseup", function (e) {
        if (document.pointerLockElement === screenElement) {
            emulator?.bus?.send("mouse-click", [
                (e.buttons & 1) !== 0,
                (e.buttons & 4) !== 0,
                (e.buttons & 2) !== 0
            ]);
        }
    });

    document.addEventListener("mousemove", function (e) {
        if (document.pointerLockElement !== screenElement) return;

        if (ignoreNextMouseDelta) {
            ignoreNextMouseDelta = false;
            return; // Ignore first movement after pointer lock activation
        }

        let dx = Math.max(-127, Math.min(127, e.movementX));
        let dy = Math.max(-127, Math.min(127, e.movementY));

        if (dx !== 0 || dy !== 0) {
            emulator?.bus?.send("mouse-delta", [dx, -dy]);
        }
    });
}