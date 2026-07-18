"use strict";

/* ==========================================================================
   STATE & CONSTANTS
   ========================================================================== */
let inputDisabled = true;
let escTriggeredByShiftAlt = false;
let escTriggeredByCtrlC = false;
let hasBeenGraphical = false;
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
const HDA_URL = url("../osakaOS/osakaOS.iso");

async function getOrCreateDiskBuffer() {
    const existing = await getDiskSourceFromDB();
    const stored = await loadDiskFromDB();

    if (stored instanceof ArrayBuffer && stored.byteLength > 0 && existing === HDA_URL) {
        console.log(`[DISK] Loaded persistent disk (${stored.byteLength} bytes) from IndexedDB.`);
        return stored;
    }

    console.log("[DISK] Seeding persistent disk from", HDA_URL);
    const response = await fetch(HDA_URL);
    if (!response.ok) throw new Error("Failed to fetch disk image: " + response.status);
    const buffer = await response.arrayBuffer();
    await saveDiskToDB(buffer, HDA_URL);
    console.log(`[DISK] Seeded disk (${buffer.byteLength} bytes) into IndexedDB.`);
    return buffer;
}

async function initEmulator() {
    console.log("[EMULATOR] Initializing v86 with networking and audio...");

    let hdaBuffer;
    try {
        hdaBuffer = await getOrCreateDiskBuffer();
    } catch (err) {
        console.error("[DISK] Falling back to URL disk load:", err);
    }

    const hdaConfig = hdaBuffer ? { buffer: hdaBuffer } : { url: HDA_URL };

    emulator = new V86({
        wasm_path: url("./v86/v86.wasm"),
        memory_size: 512 * 1024 * 1024,
        vga_memory_size: 512 * 1024 * 1024,

        screen: {
            container: document.getElementById("screen"),
            use_graphical_text: false
        },

        bios: { url: url("../bios/seabios.bin") },
        vga_bios: { url: url("../bios/vgabios.bin") },

        hda: hdaConfig,
        // hda: { url: url("../osakaOS2.0.iso") },

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

    emulator.bus.register("mouse-enable", () => {
        console.log("enabling da maus lmao");
    });

    // detect reboot
    emulator.add_listener("screen-set-size", function (args) {
        const bpp = args[2];
        if (bpp !== 0) {
            hasBeenGraphical = true;
        } else if (hasBeenGraphical) {
            console.log("reboot detected");
            hasBeenGraphical = false;
            blockInput(2000);
        }
    });

    // Persist the writable disk image to IndexedDB so writes survive refreshes.
    emulator.add_listener("emulator-stopped", persistDisk);
    emulator.add_listener("emulator-started", () => {
        if (!window._diskSaveInterval) {
            window._diskSaveInterval = setInterval(persistDisk, 5000);
        }
    });

    const flushDisk = () => { persistDisk(); };
    window.addEventListener("pagehide", flushDisk);
    window.addEventListener("beforeunload", flushDisk);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") persistDisk();
    });
}


/* ==========================================================================
   INPUT BLOCKING
   ========================================================================== */
function blockInput(durationMs) {
    inputDisabled = true;
    setTimeout(() => { inputDisabled = false; }, durationMs);
}

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

    // Last-resort unload guard: if Ctrl+W slips through preventDefault,
    // prompt the user before the tab actually closes (gives them a chance to abort).
}


function isPointerLocked() {
    return document.pointerLockElement !== null;
}

function handleKeyDown(e) {
    // Block Ctrl+W / Cmd+W (close tab) as early as possible

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

/* ==========================================================================
   INDEXED DB — large binary state persistence
   ========================================================================== */

const DB_NAME = "osakaOS";
const DB_STORE = "state";
const DB_KEY = "saved-state";
const DISK_STORE = "disks";
const DISK_KEY = "hda";
const DISK_SOURCE_KEY = "hda-source";

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
            if (!db.objectStoreNames.contains(DISK_STORE)) db.createObjectStore(DISK_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(db, store, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbSet(db, store, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const req = tx.objectStore(store).put(value, key);
        req.onsuccess = () => resolve();
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

async function loadDiskFromDB() {
    try {
        const db = await openDB();
        return await idbGet(db, DISK_STORE, DISK_KEY);
    } catch { return null; }
}

async function saveDiskToDB(buffer, source) {
    const db = await openDB();
    await idbSet(db, DISK_STORE, DISK_KEY, buffer);
    if (source !== undefined) await idbSet(db, DISK_STORE, DISK_SOURCE_KEY, source);
}

async function getDiskSourceFromDB() {
    try {
        const db = await openDB();
        return await idbGet(db, DISK_STORE, DISK_SOURCE_KEY);
    } catch { return null; }
}

async function deleteDiskFromDB() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DISK_STORE, "readwrite");
        tx.objectStore(DISK_STORE).delete(DISK_KEY);
        tx.objectStore(DISK_STORE).delete(DISK_SOURCE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function getLiveDiskBuffer() {
    try {
        return emulator?.v86?.cpu?.devices?.ide?.primary?.master?.buffer?.buffer ?? null;
    } catch { return null; }
}

let diskSaveInProgress = false;
async function persistDisk() {
    if (diskSaveInProgress) return;
    const buffer = getLiveDiskBuffer();
    if (!buffer) return;
    diskSaveInProgress = true;
    try {
        await saveDiskToDB(buffer, HDA_URL);
    } catch (err) {
        console.warn("[DISK] Persist failed:", err);
    } finally {
        diskSaveInProgress = false;
    }
}

async function wipeDisk() {
    await deleteDiskFromDB();
    console.log("[DISK] Persistent disk wiped. Hard refresh to re-install fresh.");
}

async function resetEmulator() {
    if (document.pointerLockElement) document.exitPointerLock();

    const confirmed = confirm("This will delete all your data. Are you sure?");

    if (!confirmed) {
        return;
    }

    try {
        if (window._diskSaveInterval) {
            clearInterval(window._diskSaveInterval);
            window._diskSaveInterval = null;
        }
        if (emulator && emulator.is_running()) {
            await new Promise(r => {
                const done = () => { emulator.remove_listener("emulator-stopped", done); r(); };
                emulator.add_listener("emulator-stopped", done);
                emulator.stop();
            });
        }
    } catch (err) {
        console.warn("[RESET] stop failed:", err);
    }

    try {
        await wipeDisk();
        await deleteStateFromDB();
        savedState = null;
    } catch (err) {
        console.error("[RESET] wipe failed:", err);
        alert("failed to wipe disk — check console");
        return;
    }

    location.reload();
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
        toggleControls();
        resumeAudio();
    });

    screenElement.addEventListener("mousedown", async function (e) {
        if (document.pointerLockElement !== screenElement) {
            try {
                if (screenElement.requestPointerLock) {
                    try {
                        const promise = screenElement.requestPointerLock({ unadjustedMovement: true });
                        if (promise) await promise;
                    } catch (err1) {
                        const promise = screenElement.requestPointerLock();
                        if (promise) await promise.catch(() => { });
                    }
                }
                if (navigator.keyboard && navigator.keyboard.lock) {
                    await navigator.keyboard.lock(["Escape", "KeyW", "KeyT", "KeyN", "F4", "F5"]).catch(() => { });
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


    });

    document.addEventListener("mouseup", function (e) {
        emulator?.bus?.send("mouse-click", [
            (e.buttons & 1) !== 0,
            (e.buttons & 4) !== 0,
            (e.buttons & 2) !== 0
        ]);
    });

    document.addEventListener("mousemove", function (e) {
        if (document.pointerLockElement !== screenElement) return;
        console.log(e.movementX, e.movementY);
        let dx = Math.max(-127, Math.min(127, e.movementX));
        let dy = Math.max(-127, Math.min(127, e.movementY));

        if (dx !== 0 || dy !== 0) {
            emulator?.bus?.send("mouse-delta", [dx, -dy]);
        }
    });
}