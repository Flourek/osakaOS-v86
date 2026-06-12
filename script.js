"use strict";

/* ==========================================================================
   STATE & CONSTANTS
   ========================================================================== */
let isMouseSynced = false;
let inputDisabled = true;
let escTriggeredByShiftAlt = false;
let escTriggeredByCtrlC = false;
let ignoreNextMouseDelta = false;
let emulator;

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
};


/* ==========================================================================
   EMULATOR SETUP
   ========================================================================== */
function initEmulator() {
    console.log("[EMULATOR] Initializing v86 with networking and audio...");

    emulator = new V86({
        wasm_path: "./v86/v86.wasm",
        memory_size: 512 * 1024 * 1024,
        vga_memory_size: 512 * 1024 * 1024,

        screen_container: document.getElementById("screen"),
        bios: { url: "../bios/seabios.bin" },
        vga_bios: { url: "../bios/vgabios.bin" },

        hda: { url: "../osakaOS.iso" },

        // Network relay for external connectivity
        network_relay_url: "wss://relay.widgetry.org/",

        autostart: true,
        disable_mouse: true // We manually send mouse events using the bus
    });

    // Log emulator boot and network status
    emulator.add_listener("emulator-started", () => {
        console.log("[NET] Emulator started");
        console.log("[AUDIO] PC speaker output enabled - beeps will play in browser");
        console.log("[NET] Network relay configured - osakaOS should have external connectivity");
        console.log("[NET] Try: ping 8.8.8.8 or ping google.com from osakaOS");
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
    emulator.speaker_adapter.audio_context.resume()
}

/* ==========================================================================
   KEYBOARD HANDLING
   ========================================================================== */
function setupKeyboardOverrides() {
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
}

function handleKeyDown(e) {
    resumeAudio();
    // 1. Prevent v86 from stealing important browser shortcuts
    if (e.key === "F11" || e.key === "F12" || e.key === "F5" ||
        (e.ctrlKey && (e.key === 'r' || e.key === 'R'))) {
        e.stopImmediatePropagation();
        return;
    }

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
   FILE OPERATIONS (Upload/Download)
   ========================================================================== */

/**
 * Export the entire ISO filesystem as a downloadable blob
 */
async function downloadISO() {
    try {
        if (!emulator || !emulator.get_disks) {
            console.error("Emulator not ready");
            return;
        }

        const disks = emulator.get_disks();
        if (!disks || disks.length === 0) {
            console.error("No disks found");
            return;
        }

        // Get the first disk (hda)
        const disk = disks[0];
        if (!disk) {
            console.error("HDA disk not found");
            return;
        }

        // Request the entire disk buffer
        disk.get_as_blob(function (blob) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `osakaOS_${new Date().toISOString().slice(0, 10)}.iso`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log("ISO downloaded successfully");
        });
    } catch (err) {
        console.error("Download failed:", err);
    }
}

/**
 * Upload and restore an ISO filesystem
 */
async function uploadISO(file) {
    try {
        if (!file || !file.type.includes("octet-stream") && !file.name.includes(".iso")) {
            console.error("Invalid file type. Please select an .iso file");
            return;
        }

        console.log("Uploading ISO file:", file.name);

        // Read file as ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();

        // Restart emulator with new ISO
        if (emulator) {
            emulator.stop();
        }

        // Create a blob URL for the uploaded file
        const blob = new Blob([arrayBuffer], { type: "application/octet-stream" });
        const isoUrl = URL.createObjectURL(blob);

        // Reinitialize emulator with the uploaded ISO
        emulator = new V86({
            wasm_path: "./v86/v86.wasm",
            memory_size: 512 * 1024 * 1024,
            vga_memory_size: 512 * 1024 * 1024,

            screen_container: document.getElementById("screen"),

            bios: { url: "../bios/seabios.bin" },
            vga_bios: { url: "../bios/vgabios.bin" },

            hda: { url: isoUrl },

            network_relay_url: "wss://relay.widgetry.org/",

            autostart: true,
            disable_mouse: true
        });

        // Re-setup event handlers
        setupMouseHandling();
        setupPointerLockClick();

        console.log("ISO uploaded and emulator restarted");
    } catch (err) {
        console.error("Upload failed:", err);
    }
}

/**
 * Trigger file upload dialog
 */
function triggerFileUpload() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".iso";
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) uploadISO(file);
    };
    input.click();
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
        }
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